/**
 * 网络被动观察工具（browser_network_capture）
 *
 * 定位：页面自己发请求、工具只旁观的**被动收割通道**——签名/风控接口无法直调
 * （不重放、不伪造签名）、或需要把接口响应批量收进 dataRef 时的唯一正文来源。
 *
 * 设计要点（勿轻易改动）：
 * 1. 被动性：只监听 chrome.debugger 的 Network.* 事件，绝不发送/重放/修改请求；
 * 2. 会话复用：经 textCommand → cdpSession.attach 复用既有调试会话，捕获期间用
 *    keepalive touch 延长闲置 TTL——不新增 attach、不递增 epoch、不触发调试提示条
 *    导致的视口变化，因此 noVisionRecapture 豁免成立（见 metadata 注释）；
 * 3. 正文抓取排队制：loadingFinished 入队，MAX_CONCURRENT_BODIES 并发出队，
 *    超预算/超限在出队时标记——绝不因瞬时并发丢正文（旧版并发≥4 即丢，已废除）；
 * 4. 预算与诚实：100 请求 / 单正文 1M 字符 / 合计 4M 字符 / durationSec 窗口，
 *    超限、缓冲逐出、非文本都逐条标记原因并汇总进 stats，read 永不宣称全量；
 * 5. 描述层单一事实源：预算数字与参数语义写在 openaiSchema.description，
 *    data-harvester / SOP 文档 / learn-prompts 引用同一组常量，改动需同步。
 */
import { BaseBrowserTool } from '../base/browser-tool';
import type { ToolMetadata } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { cdpSession } from './cdp-session';
import {
  textCommand,
  textTab,
  exclusiveText,
} from './text-runtime';
import { saveDataRefJson } from '@/utils/data-ref-store';
import type { DataRefMeta } from '@/utils/data-ref-store';
import { LIMITS, TOOL_NAMES } from '@/common/constants';

// ──── 预算常量（与 description / 提示词文档同步；请求上限取自 LIMITS 单一事实源） ────
const MAX_REQUESTS = LIMITS.MAX_NETWORK_REQUESTS;
const MAX_BODY_CHARS = 1_000_000;
const MAX_TOTAL_CHARS = 4_000_000;
const MAX_CONCURRENT_BODIES = 4;
const DEFAULT_DURATION_SEC = 55;
const MIN_DURATION_SEC = 10;
const MAX_DURATION_SEC = 300;
/** 捕获期间保持调试会话存活的节奏（须显著小于 cdpSession.SESSION_TTL_MS=60s） */
const KEEPALIVE_MS = 20_000;
const PREVIEW_CHARS = 1000;
const POST_DATA_CHARS = 2000;
const MAX_HEADERS = 40;
const HEADER_VALUE_CHARS = 1000;
const MAX_CAPTURES = 8;
const REDIRECT_LIMIT = 5;
/** CDP Network.ResourceType 全集——types 过滤的合法值 */
const RESOURCE_TYPES = [
  'Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack',
  'XHR', 'Fetch', 'Preflight', 'Ping', 'CSPViolationReport', 'Prefetch',
  'EventSource', 'WebSocket', 'Manifest', 'SignedExchange', 'Other',
] as const;
/** 凭据类请求/响应头：名称保留、值一律脱敏（模型不需要凭据值，只需要知道有） */
const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|csrf-token)$/i;

interface RedirectHop {
  url: string;
  status?: number;
  location?: string;
}

interface CaptureEntry {
  requestId: string;
  url: string;
  method: string;
  type?: string;
  frameId?: string;
  /** 请求体（截断到 POST_DATA_CHARS）——翻页参数/签名载荷分析用 */
  postData?: string;
  /** 请求头（includeHeaders=true 时记录，凭据值已脱敏） */
  requestHeaders?: Record<string, string>;
  /** 重定向链（同 requestId 的中间跳，最多 REDIRECT_LIMIT 条） */
  redirects?: RedirectHop[];
  status?: number;
  statusText?: string;
  mimeType?: string;
  protocol?: string;
  cached?: boolean;
  /** 响应头（includeHeaders=true 时记录，set-cookie 已脱敏） */
  responseHeaders?: Record<string, string>;
  error?: string;
  /** 正文缺失的**具体原因**（超限/逐出/非文本/会话脱离……），有值即表示无 dataRef */
  bodyUnavailable?: string;
  dataRef?: DataRefMeta;
  preview?: string;
  bodyChars?: number;
  /** 内部：loadingFinished 已处理（read 输出时剔除） */
  captureStarted?: boolean;
}

interface Capture {
  id: string;
  tabId: number;
  epoch: number;
  started: number;
  durationMs: number;
  active: boolean;
  includeHeaders: boolean;
  filter: {
    includes?: string;
    excludes?: string;
    types?: Set<string>;
  };
  entries: Map<string, CaptureEntry>;
  /** 等待正文抓取的 requestId FIFO（排队制，不因并发丢弃） */
  queue: string[];
  /** 进行中的正文抓取 */
  pending: Set<Promise<void>>;
  bytes: number;
  dropped: number;
  timer: ReturnType<typeof setTimeout>;
  keepalive: ReturnType<typeof setInterval>;
  stopPromise?: Promise<void>;
  warning?: string;
}

const captures = new Map<string, Capture>();
let listening = false;

/** 凭据头脱敏 + 截断；名称保留（模型靠头名识别签名/分页机制） */
function sanitizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_HEADERS) break;
    const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    out[name] = SENSITIVE_HEADER.test(name)
      ? '[已脱敏]'
      : text.length > HEADER_VALUE_CHARS
        ? `${text.slice(0, HEADER_VALUE_CHARS)}…`
        : text;
    count++;
  }
  return count > 0 ? out : undefined;
}

/** base64 → UTF-8 严格解码；非 UTF-8 文本抛错交由调用方标记（绝不返回乱码） */
function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * 出队并启动正文抓取，直到队列空或达到并发上限。
 * 每次有抓取结束都会再次调用，形成持续泵送。
 */
function pump(c: Capture): void {
  while (c.queue.length > 0 && c.pending.size < MAX_CONCURRENT_BODIES) {
    const requestId = c.queue.shift()!;
    const entry = c.entries.get(requestId);
    if (!entry) continue;
    if (c.bytes >= MAX_TOTAL_CHARS) {
      entry.bodyUnavailable = '合计容量已达上限';
      continue;
    }
    const work = fetchBody(c, entry);
    c.pending.add(work);
    const done = () => {
      c.pending.delete(work);
      pump(c);
    };
    void work.then(done, done);
  }
}

/** 抓取单条正文：预算复检 → getResponseBody → 解码 → dataRef 落盘 */
async function fetchBody(c: Capture, entry: CaptureEntry): Promise<void> {
  try {
    // 出发前确认会话仍在且 epoch 未变——绝不为一次读取重新 attach（见文件头不变量）
    if (
      !cdpSession.hasSession(c.tabId) ||
      cdpSession.getEpoch(c.tabId) !== c.epoch
    ) {
      entry.bodyUnavailable = '调试会话已脱离，正文未取回';
      return;
    }
    const result = await textCommand(c.tabId, 'Network.getResponseBody', {
      requestId: entry.requestId,
    });
    if (cdpSession.getEpoch(c.tabId) !== c.epoch) {
      entry.bodyUnavailable = '调试会话已切换，正文未取回';
      return;
    }
    let body: string;
    if (result.base64Encoded) {
      try {
        body = decodeBase64Utf8(String(result.body ?? ''));
      } catch {
        entry.bodyUnavailable = 'base64 正文不是 UTF-8 文本，未解码';
        return;
      }
    } else {
      body = String(result.body ?? '');
    }
    if (
      body.length > MAX_BODY_CHARS ||
      c.bytes + body.length > MAX_TOTAL_CHARS
    ) {
      entry.bodyUnavailable = '响应正文超过上限';
      return;
    }
    c.bytes += body.length;
    let value: unknown = body;
    try {
      value = JSON.parse(body);
    } catch {
      /* CSV/text remains text, never guessed as table rows. */
    }
    const saved = await saveDataRefJson(
      JSON.stringify(value),
      `网络响应 ${entry.url.slice(0, 100)}`,
    );
    if (saved.ok)
      Object.assign(entry, {
        dataRef: saved.meta,
        preview: body.slice(0, PREVIEW_CHARS),
        bodyChars: body.length,
      });
    else entry.bodyUnavailable = saved.reason;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    entry.bodyUnavailable = /No data found|No resource/i.test(message)
      ? '响应缓冲已逐出（读取不及时或页面流量大）'
      : `正文获取失败：${message.slice(0, 200)}`;
  }
}

/** 有界排空队列（stop 时调用）：让已入队的正文尽量落地，超时后交由标记兜底 */
async function drainQueue(c: Capture): Promise<void> {
  const deadline = Date.now() + 7_000;
  pump(c);
  while (
    (c.queue.length > 0 || c.pending.size > 0) &&
    Date.now() < deadline
  ) {
    if (c.pending.size > 0) {
      await Promise.race([
        Promise.allSettled([...c.pending]),
        new Promise((r) => setTimeout(r, 200)),
      ]);
    }
    pump(c);
    if (c.pending.size === 0 && c.queue.length === 0) break;
    // pump 本应至少启动一条；仍为 0 说明队列项已全部消化（条目被删/超预算标记）
    if (c.pending.size === 0) break;
  }
  for (const requestId of c.queue) {
    const entry = c.entries.get(requestId);
    if (entry && !entry.dataRef && !entry.bodyUnavailable)
      entry.bodyUnavailable = '捕获已停止，正文未获取';
  }
  c.queue.length = 0;
}

/**
 * 停止捕获（幂等）：清定时器/keepalive → 排空正文队列 → 关闭 Network 域。
 * timer 自动停止与手动 stop 共用同一 promise，绝不重复 disable。
 */
function stop(c: Capture): Promise<void> {
  if (c.stopPromise) return c.stopPromise;
  c.stopPromise = (async () => {
    const wasActive = c.active;
    c.active = false;
    clearTimeout(c.timer);
    clearInterval(c.keepalive);
    if (wasActive) await drainQueue(c).catch(() => undefined);
    if (
      wasActive &&
      cdpSession.hasSession(c.tabId) &&
      cdpSession.getEpoch(c.tabId) === c.epoch
    )
      await textCommand(c.tabId, 'Network.disable').catch(() => undefined);
  })();
  return c.stopPromise;
}

/** 标记会话脱离导致的捕获终止（onDetach / keepalive 检测共用） */
function abandon(c: Capture, warning: string): void {
  c.active = false;
  c.warning = warning;
  clearTimeout(c.timer);
  clearInterval(c.keepalive);
  for (const requestId of c.queue) {
    const entry = c.entries.get(requestId);
    if (entry && !entry.dataRef && !entry.bodyUnavailable)
      entry.bodyUnavailable = '调试会话已脱离，正文未获取';
  }
  c.queue.length = 0;
}

function listen(): void {
  if (listening) return;
  chrome.debugger.onEvent.addListener((source, method, raw) => {
    if (typeof source.tabId !== 'number') return;
    const c = [...captures.values()].find(
      (c) => c.tabId === source.tabId && c.active,
    );
    if (!c || source.sessionId || cdpSession.getEpoch(c.tabId) !== c.epoch)
      return;
    const p = raw as any;
    if (method === 'Network.requestWillBeSent') {
      const url = String(p.request?.url || '');
      const type = String(p.type || 'Other');
      const existing = c.entries.get(p.requestId);
      if (existing && p.redirectResponse) {
        // 同 requestId 的重定向：追加链路并跟踪最终 URL，不重建条目
        existing.redirects ??= [];
        if (existing.redirects.length < REDIRECT_LIMIT)
          existing.redirects.push({
            url: existing.url,
            status: p.redirectResponse.status,
            ...(typeof p.redirectResponse.headers?.location === 'string'
              ? { location: p.redirectResponse.headers.location }
              : {}),
          });
        existing.url = url;
        if (p.request?.method) existing.method = String(p.request.method);
        return;
      }
      if (existing) return;
      if (c.filter.includes && !url.includes(c.filter.includes)) return;
      if (c.filter.excludes && url.includes(c.filter.excludes)) return;
      if (c.filter.types && !c.filter.types.has(type)) return;
      if (c.entries.size >= MAX_REQUESTS) {
        c.dropped++;
        return;
      }
      const entry: CaptureEntry = {
        requestId: p.requestId,
        url,
        method: String(p.request?.method || ''),
        type,
      };
      if (typeof p.frameId === 'string') entry.frameId = p.frameId;
      if (typeof p.request?.postData === 'string' && p.request.postData)
        entry.postData =
          p.request.postData.length > POST_DATA_CHARS
            ? `${p.request.postData.slice(0, POST_DATA_CHARS)}…`
            : p.request.postData;
      if (c.includeHeaders) {
        const headers = sanitizeHeaders(p.request?.headers);
        if (headers) entry.requestHeaders = headers;
      }
      c.entries.set(p.requestId, entry);
      return;
    }
    const entry = c.entries.get(p.requestId);
    if (!entry) return;
    if (method === 'Network.responseReceived') {
      if (typeof p.response?.status === 'number')
        entry.status = p.response.status;
      if (typeof p.response?.statusText === 'string')
        entry.statusText = p.response.statusText;
      if (typeof p.response?.mimeType === 'string')
        entry.mimeType = p.response.mimeType;
      if (typeof p.response?.protocol === 'string' && p.response.protocol)
        entry.protocol = p.response.protocol;
      if (p.response?.fromDiskCache) entry.cached = true;
      if (c.includeHeaders) {
        const headers = sanitizeHeaders(p.response?.headers);
        if (headers) entry.responseHeaders = headers;
      }
    }
    if (method === 'Network.loadingFailed')
      entry.error = String(p.errorText || 'loadingFailed');
    if (method === 'Network.loadingFinished' && !entry.captureStarted) {
      entry.captureStarted = true;
      if (
        c.bytes >= MAX_TOTAL_CHARS ||
        Number(p.encodedDataLength) > 1_000_000
      ) {
        entry.bodyUnavailable = '响应正文超过上限';
        return;
      }
      if (!/json|text|csv|javascript|xml/i.test(entry.mimeType || '')) {
        entry.bodyUnavailable = '非文本响应，未自动解码';
        return;
      }
      c.queue.push(p.requestId);
      pump(c);
    }
  });
  chrome.debugger.onDetach.addListener((source) => {
    for (const c of captures.values())
      if (c.tabId === source.tabId && c.active)
        abandon(c, '调试会话已脱离，捕获停止');
  });
  listening = true;
}

/** read/stop 共用的预算对账视图——模型据此判断缺口，不靠猜 */
function captureStats(c: Capture) {
  let bodiesSaved = 0;
  let bodiesUnavailable = 0;
  for (const entry of c.entries.values()) {
    if (entry.dataRef) bodiesSaved++;
    else if (entry.bodyUnavailable) bodiesUnavailable++;
  }
  const elapsedMs = Date.now() - c.started;
  return {
    total: c.entries.size,
    active: c.active,
    dropped: c.dropped,
    bodiesSaved,
    bodiesUnavailable,
    bodiesInFlight: c.pending.size + c.queue.length,
    bytesUsed: c.bytes,
    budget: {
      maxRequests: MAX_REQUESTS,
      maxBodyChars: MAX_BODY_CHARS,
      maxTotalChars: MAX_TOTAL_CHARS,
      maxConcurrentBodies: MAX_CONCURRENT_BODIES,
      durationSec: Math.round(c.durationMs / 1000),
      elapsedMs,
      ...(c.active
        ? { remainingMs: Math.max(0, c.durationMs - elapsedMs) }
        : {}),
    },
  };
}

/** 每个 action 允许的顶层参数（未知参数显式拒绝并回显允许清单，便于模型自纠） */
const ALLOWED_PARAMS: Record<string, string[]> = {
  start: ['action', 'urlIncludes', 'urlExcludes', 'types', 'includeHeaders', 'durationSec'],
  read: ['action', 'captureId', 'offset', 'limit', 'onlyMissing', 'urlIncludes'],
  stop: ['action', 'captureId'],
};

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string')
    throw new Error(`${name} 必须是字符串`);
  return value;
}

function optionalSubstring(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const text = requireString(value, name);
  return text === '' ? undefined : text;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean')
    throw new Error(`${name} 必须是布尔值`);
  return value;
}

export class NetworkObserverTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.NETWORK_CAPTURE_START;
  metadata: ToolMetadata = {
    name: this.name,
    description:
      '被动观察当前标签页的新网络请求与文本响应（start/read/stop），完整正文自动入 dataRef——只看不发，不重放请求',
    category: 'browser',
    version: '7.0.0',
    // 被动观察：复用 cdpSession 既有调试会话（epoch 不变，GUI 截图身份不被
    // 替换），也不改变页面像素——视觉循环无需重拍。
    // 不变量（勿轻易改动）：本工具经 textCommand → cdpSession.attach 复用会话；
    // 捕获期间仅用 keepalive touch 延长闲置 TTL（不新增 attach、不递增 epoch、
    // 不触发调试提示条导致的视口变化）——「豁免重拍」不会作废截图凭据。
    // fetchBody 出发前校验 hasSession+epoch，绝不为读正文重新 attach。
    noVisionRecapture: true,
  };
  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description:
        '被动观察当前标签页在 start 之后新发出的网络请求与文本响应：只看不发——不发送、不重放、不修改任何请求，数据全部来自页面自己发起的流量。' +
        '用途：①签名/风控接口无法直调时收割响应正文（页面自己发请求，你只收数据，无需伪造签名）；' +
        '②摸清页面背后的接口、参数与翻页规律（postData/重定向链/类型分布可见）；' +
        '③把接口响应批量收进 dataRef，经 data_ref_tool(action="project", ref=该ID, path=信封内列表路径——投影产物为持久结果文件) → merge/dedupe(files=[...]) → xlsx_tool(create_from_data, dataFiles=[...]) 直接导出，批量数据不进对话。' +
        '工作流：start（可选 urlIncludes/urlExcludes 子串过滤、types=["XHR","Fetch"] 排除图片脚本噪音、includeHeaders 记录请求/响应头且凭据值自动脱敏、durationSec 捕获窗口）→ 用页面操作触发请求（翻页/滚动/点击，browser_interact/browser_navigation）→ ' +
        'read 分页读取（每页 ≤20 条，正文预览 + dataRef；onlyMissing=true 只看尚未取得正文的条目做对账；read 也可传 urlIncludes 做读取侧过滤）→ stop 结束；停止后仍可 read 已捕获结果。单轮没抓全就再开一轮循环补齐。' +
        '覆盖边界（不可视为全量）：只捕获 start 之后、当前顶层标签页的请求；跨进程 iframe、Service Worker、WebSocket/SSE 流与二进制协议不保证覆盖；' +
        `单轮 ${MAX_REQUESTS} 条请求、单正文 ${Math.floor(MAX_BODY_CHARS / 1_000_000)}M 字符、合计 ${Math.floor(MAX_TOTAL_CHARS / 1_000_000)}M 字符、默认 ${DEFAULT_DURATION_SEC} 秒（durationSec ${MIN_DURATION_SEC}–${MAX_DURATION_SEC}，正文抓取并发 ${MAX_CONCURRENT_BODIES} 超出排队不丢弃）；` +
        '超限、缓冲逐出、非文本正文都会在条目上标记原因，read 的 stats 给出预算对账。空结果不表示页面无数据。' +
        '分工：已知接口直调用 browser_network_request；页面内取数用 js_run；本工具专用于「页面自己发、你被动收」的场景。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'read', 'stop'],
            description: 'start 开启捕获；read 分页读取已捕获记录；stop 结束（停止后仍可 read）',
          },
          captureId: {
            type: 'string',
            description: 'read/stop 必须传 start 返回值',
          },
          urlIncludes: {
            type: 'string',
            description: '可选子串过滤：start=只捕获 URL 含此子串的请求；read=只返回含此子串的条目',
          },
          urlExcludes: {
            type: 'string',
            description: 'start 可选：排除 URL 含此子串的请求（与 urlIncludes 叠加）',
          },
          types: {
            type: 'array',
            items: { type: 'string' },
            description: `start 可选：只捕获指定资源类型，如 ["XHR","Fetch"] 排除图片/脚本噪音（合法值：${RESOURCE_TYPES.join('/')}，未知值报错并回显清单）`,
          },
          includeHeaders: {
            type: 'boolean',
            description: 'start 可选：记录请求/响应头（cookie、authorization 等凭据值自动脱敏），默认不记录',
          },
          durationSec: {
            type: 'number',
            description: `start 可选：捕获窗口秒数，默认 ${DEFAULT_DURATION_SEC}，范围 ${MIN_DURATION_SEC}–${MAX_DURATION_SEC}（期间自动保持调试会话，到时自动 stop）`,
          },
          offset: { type: 'number', description: 'read 从0开始的记录偏移' },
          limit: { type: 'number', description: 'read 最多20条，默认10' },
          onlyMissing: {
            type: 'boolean',
            description: 'read 可选：只返回尚未取得正文的条目（补抓对账用），默认 false',
          },
        },
        required: ['action'],
      },
    },
  };
  async execute(p: {
    action: 'start' | 'read' | 'stop';
    captureId?: string;
    urlIncludes?: string;
    urlExcludes?: string;
    types?: string[];
    includeHeaders?: boolean;
    durationSec?: number;
    offset?: number;
    limit?: number;
    onlyMissing?: boolean;
  }) {
    this.ensureBackgroundContext();
    try {
      return await exclusiveText(async () => {
        if (
          !p ||
          typeof p !== 'object' ||
          Array.isArray(p) ||
          !['start', 'read', 'stop'].includes(p.action)
        )
          throw new Error('action 无效');
        const allowed = ALLOWED_PARAMS[p.action];
        const unknown = Object.keys(p).filter((k) => !allowed.includes(k));
        if (unknown.length)
          throw new Error(
            `${p.action} 不接受参数 ${unknown.join('、')}；允许：${allowed.join('、')}`,
          );

        if (p.action === 'start') {
          const filter: Capture['filter'] = {};
          filter.includes = optionalSubstring(p.urlIncludes, 'urlIncludes');
          filter.excludes = optionalSubstring(p.urlExcludes, 'urlExcludes');
          if (p.types !== undefined) {
            if (
              !Array.isArray(p.types) ||
              p.types.length === 0 ||
              !p.types.every((t) => typeof t === 'string')
            )
              throw new Error('types 必须是非空字符串数组');
            const set = new Set<string>();
            for (const t of p.types) {
              const canonical = RESOURCE_TYPES.find(
                (r) => r.toLowerCase() === t.toLowerCase(),
              );
              if (!canonical)
                throw new Error(
                  `types 含未知资源类型 "${t}"；合法值：${RESOURCE_TYPES.join('、')}`,
                );
              set.add(canonical);
            }
            filter.types = set;
          }
          const includeHeaders = optionalBoolean(
            p.includeHeaders,
            'includeHeaders',
          );
          let durationSec = DEFAULT_DURATION_SEC;
          if (p.durationSec !== undefined) {
            if (
              typeof p.durationSec !== 'number' ||
              !Number.isSafeInteger(p.durationSec) ||
              p.durationSec < MIN_DURATION_SEC ||
              p.durationSec > MAX_DURATION_SEC
            )
              throw new Error(
                `durationSec 须为 ${MIN_DURATION_SEC}–${MAX_DURATION_SEC} 的整数秒`,
              );
            durationSec = p.durationSec;
          }
          const tab = await textTab();
          if (
            [...captures.values()].some((c) => c.tabId === tab.id && c.active)
          )
            throw new Error('当前标签页已有捕获，请先 read/stop');
          listen();
          await textCommand(tab.id, 'Network.enable', {
            maxTotalBufferSize: 8_000_000,
            maxResourceBufferSize: 1_000_000,
          });
          const id = crypto.randomUUID();
          const durationMs = durationSec * 1000;
          const c: Capture = {
            id,
            tabId: tab.id,
            epoch: cdpSession.getEpoch(tab.id),
            started: Date.now(),
            durationMs,
            active: true,
            includeHeaders: includeHeaders === true,
            filter,
            entries: new Map(),
            queue: [],
            pending: new Set(),
            bytes: 0,
            dropped: 0,
            timer: setTimeout(() => {
              void stop(c);
            }, durationMs),
            // 保活：窗口可长于会话 60s 闲置 TTL，touch 只刷新定时器不新增 attach
            keepalive: setInterval(() => {
              if (!c.active) {
                clearInterval(c.keepalive);
                return;
              }
              if (
                !cdpSession.hasSession(c.tabId) ||
                cdpSession.getEpoch(c.tabId) !== c.epoch
              ) {
                abandon(c, '调试会话已脱离，捕获停止');
                return;
              }
              cdpSession.touch(c.tabId);
            }, KEEPALIVE_MS),
          };
          captures.set(id, c);
          while (captures.size > MAX_CAPTURES) {
            const oldest = captures.values().next().value!;
            await stop(oldest);
            captures.delete(oldest.id);
          }
          return this.createSuccessResponse({
            captureId: id,
            tabId: tab.id,
            active: true,
            durationSec,
            filters: {
              ...(filter.includes ? { urlIncludes: filter.includes } : {}),
              ...(filter.excludes ? { urlExcludes: filter.excludes } : {}),
              ...(filter.types ? { types: [...filter.types] } : {}),
              ...(c.includeHeaders ? { includeHeaders: true } : {}),
            },
            hint: '现在触发页面操作（翻页/滚动/点击），随后用同一 captureId read；只观察 start 之后的新请求。',
          });
        }
        if (typeof p.captureId !== 'string' || !captures.has(p.captureId))
          throw new Error('captureId 不存在或已淘汰');
        const c = captures.get(p.captureId)!;
        if (p.action === 'stop') {
          await stop(c);
          return this.createSuccessResponse({
            captureId: c.id,
            active: false,
            totalRequests: c.entries.size,
            pending: c.pending.size + c.queue.length,
            dropped: c.dropped,
            stats: captureStats(c),
            hint: '可继续 read 已捕获结果；未获取的正文不会自动补齐——需要时再开一轮 start。',
          });
        }
        const offset = p.offset ?? 0,
          limit = p.limit ?? 10;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 20
        )
          throw new Error('offset 为非负整数，limit 为1..20');
        const onlyMissing = optionalBoolean(p.onlyMissing, 'onlyMissing');
        const readFilter = optionalSubstring(p.urlIncludes, 'urlIncludes');
        let entries = [...c.entries.values()];
        if (onlyMissing) entries = entries.filter((e) => !e.dataRef);
        if (readFilter) entries = entries.filter((e) => e.url.includes(readFilter));
        const page = entries
          .slice(offset, offset + limit)
          .map(({ captureStarted: _internal, ...entry }) => entry);
        const nextOffset =
          offset + page.length < entries.length ? offset + page.length : null;
        return this.createSuccessResponse({
          captureId: c.id,
          tabId: c.tabId,
          active: c.active,
          entries: page,
          totalRequests: c.entries.size,
          matchedRequests: entries.length,
          pending: c.pending.size + c.queue.length,
          dropped: c.dropped,
          nextOffset,
          ...(c.warning ? { warning: c.warning } : {}),
          stats: captureStats(c),
          coverage:
            '仅捕获 start 之后本标签页的请求；正文可能因上限/缓冲逐出/非文本而缺失（见条目 bodyUnavailable 与 stats）；无数据不表示页面无数据',
        });
      });
    } catch (error) {
      return this.createErrorResponse('网络观察失败', error);
    }
  }
}

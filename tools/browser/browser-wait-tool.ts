import { BaseBrowserTool } from '../base/browser-tool';
import type { ToolMetadata, ToolExecutionContext } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { browserChrome } from '../browser/browser-scope';
import { executeScriptBounded } from '../common/frame-read';
import { abortableDelay } from '@/utils/shared/abort';

/**
 * 条件等待（browser_wait）
 *
 * 为什么需要独立原语：浏览器自动化的闭环是「操作 → 等待条件 → 读回执」。
 * 没有条件等待时，模型只能写 `await sleep(1500)` **猜**时长——猜早了读到旧状态
 * （把「还没跳转」误判成「操作失败」），猜晚了白白浪费往返。
 *
 * 本工具把「等什么」表达出来，由工具负责轮询、收敛与超时诊断：
 * - url_contains / url_matches：等地址变化（提交后跳到成功页的典型信号）
 * - text_present / text_absent：等文案出现/消失（成功提示、错误提示）
 * - element_visible / element_hidden：等某控件出现/消失
 * - network_idle：等网络安静（提交请求结束）
 * - page_ready：等文档就绪（document.readyState 连续命中）
 *
 * 设计约束：
 * - **有界**：所有等待都有上限，超时返回结构化诊断（不是笼统报错）；
 * - **可中断**：支持 context.signal，用户停止或会话中断立即收敛；
 * - **不写页面**：纯观察，不改变任何页面状态；
 * - **组合条件**：可同时给多个条件，全部满足才算命中（and 语义）。
 */

export const BROWSER_WAIT_TOOL_ID = 'browser_wait';

/** 等待条件类型 */
export const WAIT_CONDITION_TYPES = [
  'url_contains',
  'url_matches',
  'text_present',
  'text_absent',
  'element_visible',
  'element_hidden',
  'network_idle',
  'page_ready',
] as const;
export type WaitConditionType = (typeof WAIT_CONDITION_TYPES)[number];

/** 单个等待条件 */
export interface WaitCondition {
  type: WaitConditionType;
  /** text_present/text_absent：目标文案；element_visible/element_hidden：CSS 选择器 */
  value?: string;
}

export interface BrowserWaitParams {
  /** 等待条件（可多个，全部满足才算命中） */
  conditions: WaitCondition[];
  /** 超时上限（毫秒，默认 30000，上限 100000） */
  timeoutMs?: number;
  /** 轮询间隔（毫秒，默认 300） */
  intervalMs?: number;
  /** 目标标签页（省略=当前活动页） */
  tabId?: number | string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 100_000;
const DEFAULT_INTERVAL_MS = 300;
const MIN_INTERVAL_MS = 50;
const MAX_INTERVAL_MS = 5_000;
/** network_idle 的静默判定窗口（毫秒）：这段时间内没有新请求即视为安静 */
const NETWORK_IDLE_WINDOW_MS = 800;

export class BrowserWaitTool extends BaseBrowserTool {
  name = BROWSER_WAIT_TOOL_ID;
  metadata: ToolMetadata = {
    name: this.name,
    description:
      '按条件等待页面达到目标状态（地址/文案/控件/网络/就绪），超时返回结构化诊断',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'wait', 'condition', 'automation'],
    // 纯观察：不写页面，不改变任何状态
    noVisionRecapture: true,
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description:
        '<browser-wait>\n' +
        '  <capability>按**条件**等待页面达成目标状态，而不是盲等固定秒数。用于「操作 → 等待 → 读回执」闭环：提交后等地址跳转、等成功提示出现、等加载遮罩消失、等网络请求结束。</capability>\n' +
        '  <conditions>可组合多个条件，**全部满足**才算命中。\n' +
        '    <condition type="url_contains">地址包含指定子串（value 用子串，无需正则）。</condition>\n' +
        '    <condition type="url_matches">地址匹配正则（value 用正则）。</condition>\n' +
        '    <condition type="text_present">页面出现指定文案（value 用文案）。</condition>\n' +
        '    <condition type="text_absent">页面不再包含指定文案（value 用文案）。</condition>\n' +
        '    <condition type="element_visible">CSS 选择器命中且可见（value 用选择器）。</condition>\n' +
        '    <condition type="element_hidden">CSS 选择器不再命中或不可见（value 用选择器）。</condition>\n' +
        '    <condition type="network_idle">网络静默，无需 value。</condition>\n' +
        '    <condition type="page_ready">文档就绪，无需 value。</condition>\n' +
        '  </conditions>\n' +
        '  <result>satisfied 表示是否全部命中；conditions 逐条给出每个条件的达成情况与依据；elapsedMs 是实际耗时。超时不报错，而是返回 satisfied=false 与逐条诊断，便于判断「慢」还是「根本没发生」。</result>\n' +
        '  <usage>本工具只观察不操作；等待期间的页面变化请在命中后重新观察。等待结束不代表业务成功，仍需读取回执确认。</usage>\n' +
        '</browser-wait>',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['conditions'],
        properties: {
          conditions: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            description:
              '等待条件列表（全部满足才算命中）。' +
              'url_contains：地址包含指定子串（值无需正则）；' +
              'url_matches：地址匹配正则；' +
              'text_present：页面出现指定文案；' +
              'text_absent：页面不再包含指定文案；' +
              'element_visible：CSS 选择器命中且可见；' +
              'element_hidden：CSS 选择器不再命中或不可见；' +
              'network_idle：网络请求静默（无需 value）；' +
              'page_ready：文档就绪（无需 value）。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: [...WAIT_CONDITION_TYPES] },
                value: {
                  type: 'string',
                  maxLength: 2000,
                  description:
                    '条件参数：text_* 用目标文案；element_* 用 CSS 选择器；url_contains 用子串；url_matches 用正则。' +
                    'network_idle / page_ready 不需要 value。',
                },
              },
              required: ['type'],
            },
          },
          timeoutMs: {
            type: 'integer',
            minimum: 100,
            maximum: MAX_TIMEOUT_MS,
            description: `等待上限（毫秒，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}）。`,
          },
          intervalMs: {
            type: 'integer',
            minimum: MIN_INTERVAL_MS,
            maximum: MAX_INTERVAL_MS,
            description: `轮询间隔（毫秒，默认 ${DEFAULT_INTERVAL_MS}）。间隔过小会空转刷 API。`,
          },
          tabId: {
            type: 'integer',
            minimum: 0,
            description: '目标标签页 ID（可选；省略=当前活动标签页）。',
          },
        },
      },
    },
  };

  async execute(raw: unknown, context?: ToolExecutionContext) {
    try {
      const params = raw as BrowserWaitParams | undefined;
      if (!params || typeof params !== 'object' || Array.isArray(params))
        return this.createErrorResponse('参数必须是对象 { conditions, timeoutMs?, intervalMs?, tabId? }');
      const allowed = ['conditions', 'timeoutMs', 'intervalMs', 'tabId'];
      const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
      if (unknown.length)
        return this.createErrorResponse(
          `不接受参数：${unknown.join('、')}。允许：${allowed.join('/')}`,
        );
      const conditions = this.normalizeConditions(params.conditions);
      if (!conditions.ok) return this.createErrorResponse(conditions.error);
      const timeoutMs = this.clamp(
        params.timeoutMs,
        DEFAULT_TIMEOUT_MS,
        100,
        MAX_TIMEOUT_MS,
        'timeoutMs',
      );
      const intervalMs = this.clamp(
        params.intervalMs,
        DEFAULT_INTERVAL_MS,
        MIN_INTERVAL_MS,
        MAX_INTERVAL_MS,
        'intervalMs',
      );
      const tabId = await this.resolveTab(params.tabId);
      if (typeof tabId !== 'number')
        return this.createErrorResponse(String(tabId));

      const started = Date.now();
      const deadline = started + timeoutMs;
      const perCondition = new Map<string, { met: boolean; detail?: string }>();
      for (const condition of conditions.value)
        perCondition.set(this.conditionKey(condition), { met: false });

      let lastUrl = '';
      let lastResourceCount = -1;
      let lastResourceChange = started;
      /**
       * 轮询次数硬上限（防卡死）。
       *
       * 即使时钟被冻结或 intervalMs 异常小，也不能让等待变成死循环：
       * 上限按最坏间隔估算，到达即按超时收敛。
       */
      const maxIterations = Math.max(
        1,
        Math.ceil(timeoutMs / Math.max(1, Math.min(intervalMs, 1000))),
      ) + 8;
      let iterations = 0;

      while (Date.now() < deadline) {
        if (++iterations > maxIterations) break;
        if (context?.signal?.aborted) {
          return this.createErrorResponse(
            'WAIT_CANCELLED：等待已被取消；已等待 ' +
              `${Date.now() - started}ms。请重新观察页面现状。`,
          );
        }
        const now = Date.now();
        let tab: chrome.tabs.Tab | undefined;
        try {
          tab = await browserChrome(context).tabs.get(tabId);
        } catch {
          return this.createErrorResponse(
            'TAB_CLOSED：标签页在等待期间被关闭，无法继续等待。请重新选择标签页。',
          );
        }
        if (!tab) {
          return this.createErrorResponse(
            'TAB_CLOSED：标签页在等待期间消失，无法继续等待。',
          );
        }
        const url = tab.url || '';
        if (url !== lastUrl) {
          lastUrl = url;
          // 地址变了 ⇒ 发生过导航/路由切换，网络必然活跃过，重置静默计时
          lastResourceChange = now;
          lastResourceCount = -1;
        }

        /**
         * 资源计数：页面自身加载过的资源条目数。
         *
         * 用它做 network_idle 的判据，而不是「地址变没变」——XHR/fetch 不改地址，
         * 只看 URL 会把「正在提交表单」误判成「网络已静默」。
         */
        const resourceCount = await this.readResourceCount(tabId, context);
        if (resourceCount >= 0) {
          if (resourceCount !== lastResourceCount) {
            lastResourceCount = resourceCount;
            lastResourceChange = now;
          }
        }
        const idleMs = now - lastResourceChange;

        // 每轮只做**一次**页面探测注入（批量评估全部页面类条件），
        // 避免 8 个条件 × 300ms 轮询变成每秒几十次注入。
        const outcomes = await this.evaluateConditions(
          conditions.value,
          tabId,
          url,
          idleMs,
          context,
        );
        for (const { key, met, detail } of outcomes) {
          const state = perCondition.get(key)!;
          state.met = met;
          state.detail = detail;
        }

        if ([...perCondition.values()].every((state) => state.met)) {
          return this.createSuccessResponse(
            {
              satisfied: true,
              elapsedMs: Date.now() - started,
              url,
              conditions: [...perCondition.entries()].map(([key, state]) => ({
                condition: key,
                met: state.met,
                detail: state.detail,
              })),
            },
            `等待条件已全部满足（耗时 ${Date.now() - started}ms）。请重新观察页面读取结果。`,
          );
        }
        // 轮询间隔：用可中断的延时。防卡死有两道闸——
        // 上面的 iterations 上限（时钟冻结时也会收敛）与本行的延时（时钟正常时推进）。
        await abortableDelay(intervalMs, context?.signal);
      }

      // 超时：返回逐条件达成情况，便于模型判断「慢」还是「没发生」
      return this.createSuccessResponse(
        {
          satisfied: false,
          elapsedMs: Date.now() - started,
          timeoutMs,
          url: lastUrl,
          conditions: [...perCondition.entries()].map(([key, state]) => ({
            condition: key,
            met: state.met,
            detail: state.detail,
          })),
        },
        `等待超时（${Date.now() - started}ms / 上限 ${timeoutMs}ms）。` +
          '未满足的条件已逐条列出：请先观察页面现状确认业务是否真的未发生，' +
          '不要据此直接重放写操作（提交类动作重放可能造成重复投递）。',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.createErrorResponse(message);
    }
  }

  /**
   * 批量求值一轮：宿主侧条件（地址/网络/就绪）直接计算，
   * 页面类条件（文案/元素）合并为**一次**注入探测。
   *
   * 合并的理由：页面类条件最多 8 个，逐条注入会让轮询退化成每秒几十次
   * executeScript——批量一次既省往返，也让一轮内的判定来自同一时刻的页面快照
   * （逐条注入时前后两条可能跨越一次渲染，产生自相矛盾的结论）。
   */
  private async evaluateConditions(
    conditions: WaitCondition[],
    tabId: number,
    url: string,
    idleMs: number,
    context?: ToolExecutionContext,
  ): Promise<Array<{ key: string; met: boolean; detail?: string }>> {
    const out: Array<{ key: string; met: boolean; detail?: string }> = [];
    const probe: WaitCondition[] = [];
    for (const condition of conditions) {
      const key = this.conditionKey(condition);
      switch (condition.type) {
        case 'url_contains': {
          const value = condition.value || '';
          out.push({
            key,
            met: !!value && url.includes(value),
            detail: `地址当前为 ${url || '(空)'}`,
          });
          break;
        }
        case 'url_matches': {
          const value = condition.value || '';
          try {
            const pattern = new RegExp(value);
            out.push({ key, met: pattern.test(url), detail: `地址当前为 ${url || '(空)'}` });
          } catch {
            out.push({ key, met: false, detail: `url_matches 的正则非法：${value}` });
          }
          break;
        }
        case 'network_idle':
          out.push({
            key,
            met: idleMs >= NETWORK_IDLE_WINDOW_MS,
            detail: `网络已静默 ${idleMs}ms（阈值 ${NETWORK_IDLE_WINDOW_MS}ms）`,
          });
          break;
        case 'page_ready': {
          // 文档就绪用真实信号判定，而不是恒真——恒真会让「等就绪」这个条件
          // 变成一句空话，模型以为等过了，其实什么都没等。
          const ready = await this.readReadyState(tabId, context);
          out.push({
            key,
            met: ready.ready,
            detail: `文档状态=${ready.state}${ready.detail ? '（' + ready.detail + '）' : ''}`,
          });
          break;
        }
        case 'text_present':
        case 'text_absent':
        case 'element_visible':
        case 'element_hidden':
          probe.push(condition);
          break;
        default:
          out.push({ key, met: false, detail: '未知条件类型' });
      }
    }
    if (probe.length) out.push(...(await this.probePageBatch(tabId, probe, context)));
    return out;
  }

  /**
   * 读取页面资源条目数（network_idle 的判据）。
   *
   * 用 performance 资源时序条目的数量：任何新的图片/脚本/XHR 都会让
   * 计数增长。只看地址变化是不够的——XHR/fetch 不改地址。
   * 跨全部 frame 求和：iframe 内的请求同样是「网络活跃」。
   *
   * 读不到时返回 -1（表示「无信号」），调用方据此保持原判定，不误判为静默。
   */
  private async readResourceCount(
    tabId: number,
    context?: ToolExecutionContext,
  ): Promise<number> {
    try {
      const results = await executeScriptBounded({
        target: { tabId, allFrames: true },
        world: 'ISOLATED',
        func: resourceCountPayload,
        args: [],
      }, 2000, undefined, context);
      const counts = (results || [])
        .map((row) => row.result)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
      return counts.length ? counts.reduce((a, b) => a + b, 0) : -1;
    } catch {
      return -1;
    }
  }

  /** 读取文档就绪状态（page_ready 的判据）。 */
  private async readReadyState(
    tabId: number,
    context?: ToolExecutionContext,
  ): Promise<{ ready: boolean; state: string; detail?: string }> {
    try {
      const results = await executeScriptBounded({
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        func: readyStatePayload,
        args: [],
      }, 2000, undefined, context);
      const value = results?.[0]?.result as
        | { ready?: boolean; state?: string; detail?: string }
        | undefined;
      if (!value || typeof value.state !== 'string')
        return { ready: false, state: 'unknown', detail: '探测不可用' };
      return {
        ready: value.ready === true,
        state: value.state,
        detail: value.detail,
      };
    } catch {
      return { ready: false, state: 'unknown', detail: '探测不可用' };
    }
  }

  /**
   * 页面类条件的批量探测（每轮一次注入，跨全部可注入 frame）。
   *
   * 只读：取可见文本与选择器命中情况，不改变页面。失败（注入被拒等）时不抛错，
   * 只把失败原因写进 detail——等待工具必须能「一直等下去」而不因单次探测失败中断。
   */
  private async probePageBatch(
    tabId: number,
    conditions: WaitCondition[],
    context?: ToolExecutionContext,
  ): Promise<Array<{ key: string; met: boolean; detail?: string }>> {
    const spec = conditions.map((c) => ({ type: c.type, value: c.value || '' }));
    type ProbeRow = { ok: boolean; matched: boolean; text?: string };
    let perFrame: ProbeRow[][] = [];
    let probeError: string | undefined;
    try {
      const results = await executeScriptBounded({
        target: { tabId, allFrames: true },
        world: 'ISOLATED',
        func: waitProbePayload,
        args: [spec],
      }, 3000, undefined, context);
      perFrame = (results || [])
        .map((row) => row.result)
        .filter((r): r is ProbeRow[] => Array.isArray(r) && r.every((x) => x && typeof x.ok === 'boolean'))
        .map((r) => r as ProbeRow[]);
    } catch (error) {
      probeError = String((error as Error)?.message || error).slice(0, 120);
    }
    return conditions.map((condition, index) => {
      const key = this.conditionKey(condition);
      const selector = condition.value || '';
      if (!perFrame.length)
        return {
          key,
          met: false,
          detail: probeError
            ? `探测失败：${probeError}`
            : '页面探测未返回结果（页面可能受限或正在跳转）',
        };
      const rows = perFrame.map((frame) => frame[index]).filter((r): r is ProbeRow => !!r && typeof r.ok === 'boolean');
      const matched = rows.some((row) => row.matched);
      switch (condition.type) {
        case 'text_present':
          return {
            key,
            met: matched,
            detail: matched ? `已出现「${selector}」` : `尚未出现「${selector}」`,
          };
        case 'text_absent':
          return {
            key,
            met: !matched,
            detail: matched ? `仍存在「${selector}」` : `已不存在「${selector}」`,
          };
        case 'element_visible':
          return {
            key,
            met: matched,
            detail: matched
              ? `选择器已命中可见元素（${rows.length} 个 frame 参与探测）`
              : '选择器未命中可见元素',
          };
        case 'element_hidden':
          return {
            key,
            met: !matched,
            detail: matched ? '选择器仍命中元素' : '选择器已不命中元素',
          };
        default:
          return { key, met: false, detail: '未知条件类型' };
      }
    });
  }

  private normalizeConditions(
    raw: unknown,
  ): { ok: true; value: WaitCondition[] } | { ok: false; error: string } {
    if (!Array.isArray(raw) || raw.length === 0)
      return { ok: false, error: 'conditions 必须是非空数组' };
    if (raw.length > 8)
      return { ok: false, error: `conditions 最多 8 条（收到 ${raw.length} 条）` };
    const value: WaitCondition[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        return { ok: false, error: 'conditions 的每一项必须是 { type, value? } 对象' };
      const type = (item as WaitCondition).type;
      if (!WAIT_CONDITION_TYPES.includes(type as WaitConditionType))
        return {
          ok: false,
          error: `condition.type 必须是 ${WAIT_CONDITION_TYPES.join(' / ')} 之一（收到 ${JSON.stringify(type)}）`,
        };
      const rawValue = (item as WaitCondition).value;
      if (rawValue !== undefined && typeof rawValue !== 'string')
        return { ok: false, error: 'condition.value 必须是字符串' };
      const needsValue: WaitConditionType[] = [
        'url_contains',
        'url_matches',
        'text_present',
        'text_absent',
        'element_visible',
        'element_hidden',
      ];
      if (needsValue.includes(type as WaitConditionType) && !rawValue?.trim())
        return { ok: false, error: `condition.type="${type}" 必须提供非空 value` };
      // 无参条件（network_idle / page_ready）不接受 value：多余参数会让模型
      // 以为自己设了阈值，实际被忽略——比直接报错更危险。
      if (
        !needsValue.includes(type as WaitConditionType) &&
        rawValue !== undefined
      )
        return {
          ok: false,
          error: `condition.type="${type}" 不接受 value（该条件无需参数）`,
        };
      if (rawValue && rawValue.length > 2000)
        return { ok: false, error: 'condition.value 最多 2000 字符' };
      value.push({ type: type as WaitConditionType, ...(rawValue ? { value: rawValue } : {}) });
    }
    return { ok: true, value };
  }

  private conditionKey(condition: WaitCondition): string {
    return condition.value ? `${condition.type}:${condition.value}` : condition.type;
  }

  private clamp(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    name: string,
  ): number {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value))
      return fallback;
    return Math.min(Math.max(Math.round(value), min), max);
  }

  private async resolveTab(
    tabId: number | string | undefined,
  ): Promise<number | string> {
    if (tabId === undefined || tabId === null) {
      const [active] = await browserChrome().tabs.query({
        active: true,
        currentWindow: true,
      });
      if (typeof active?.id !== 'number')
        return 'NO_ACTIVE_TAB：没有可用的活动标签页';
      return active.id;
    }
    const numeric = typeof tabId === 'string' ? Number(tabId) : tabId;
    if (!Number.isSafeInteger(numeric) || (numeric as number) < 0)
      return 'INVALID_ARGUMENT：tabId 必须是非负整数';
    try {
      await browserChrome().tabs.get(numeric as number);
    } catch {
      return `TAB_NOT_FOUND：标签页 ${numeric} 不存在`;
    }
    return numeric as number;
  }
}

/**
 * 资源条目计数荷载（network_idle 判据）。
 *
 * 只读：读取 performance 资源时序条目的数量，不触发任何请求。
 * 读不到（受限页/时序不可用）时返回 -1，调用方据此保持原判定。
 */
function resourceCountPayload(): number {
  try {
    const entries = performance.getEntriesByType('resource');
    return typeof entries?.length === 'number' ? entries.length : -1;
  } catch {
    return -1;
  }
}

/**
 * 文档就绪状态荷载（page_ready 判据）。
 *
 * 只读：读取 document.readyState 与是否有可见正文。
 */
function readyStatePayload(): {
  ready: boolean;
  state: string;
  detail?: string;
} {
  try {
    const state = document.readyState || 'unknown';
    // complete 只说明资源加载完，不等于内容已渲染；正文为空时不算就绪。
    let hasContent = true;
    try {
      hasContent = !!(document.body && (document.body.innerText || '').trim().length > 0);
    } catch {
      hasContent = true;
    }
    return {
      ready: state === 'complete' && hasContent,
      state,
      detail: hasContent ? undefined : '正文为空（仍在渲染）',
    };
  } catch {
    return { ready: false, state: 'unknown', detail: '探测异常' };
  }
}

/**
 * 页面探测荷载（在每个可注入 frame 内执行，只读）。
 *
 * 输入是一组条件（与调用方顺序一致），输出是同长度的结果数组——
 * 一次注入评估全部条件，保证同一轮的判定来自同一时刻的页面快照。
 *
 * ⚠️ 注入约束：必须完全自包含。
 */
function waitProbePayload(
  spec: Array<{ type: string; value: string }>,
): Array<{ ok: boolean; matched: boolean; text?: string }> {
  return (spec || []).map((condition) => {
    try {
      const type = condition?.type || '';
      const value = condition?.value || '';
      if (type === 'text_present' || type === 'text_absent') {
        const needle = value.trim();
        const body = document.body?.innerText || '';
        const matched = !!needle && body.includes(needle);
        return { ok: true, matched, text: body.slice(0, 200) };
      }
      if (type === 'element_visible' || type === 'element_hidden') {
        const selector = value.trim();
        let matched = false;
        try {
          // 任意一个匹配可见即算命中：querySelector 只看首个匹配，
          // 首个隐藏而其余可见时会把「元素已出现」误判成「还没出现」。
          const found = document.querySelectorAll(selector);
          const limit = Math.min(found.length, 50);
          for (let i = 0; i < limit; i++) {
            const node = found[i];
            const style = window.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            if (
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              style.visibility !== 'collapse' &&
              rect.width >= 1 &&
              rect.height >= 1
            ) {
              matched = true;
              break;
            }
          }
        } catch {
          matched = false;
        }
        return { ok: true, matched };
      }
      return { ok: true, matched: false };
    } catch {
      return { ok: false, matched: false };
    }
  });
}

export const browserWaitTool = new BrowserWaitTool();

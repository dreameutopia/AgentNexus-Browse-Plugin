import { BaseBrowserTool } from '../base/browser-tool';
import type { ToolMetadata } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { cdpSession } from './cdp-session';
import {
  textCommand,
  textTab,
  boundedText,
  exclusiveText,
} from './text-runtime';
import { saveDataRefJson } from '@/utils/data-ref-store';

interface Capture {
  id: string;
  tabId: number;
  epoch: number;
  started: number;
  active: boolean;
  filter: string;
  entries: Map<string, any>;
  pending: Set<Promise<void>>;
  bytes: number;
  dropped: number;
  timer: ReturnType<typeof setTimeout>;
  warning?: string;
}
const captures = new Map<string, Capture>();
let listening = false;
async function stop(c: Capture) {
  const wasActive = c.active;
  c.active = false;
  clearTimeout(c.timer);
  if (
    wasActive &&
    cdpSession.hasSession(c.tabId) &&
    cdpSession.getEpoch(c.tabId) === c.epoch
  )
    await textCommand(c.tabId, 'Network.disable').catch(() => undefined);
}
function listen() {
  if (listening) return;
  chrome.debugger.onEvent.addListener((source, method, raw) => {
    if (typeof source.tabId !== 'number') return;
    const c = [...captures.values()].find(
      (c) => c.tabId === source.tabId && c.active
    );
    if (!c || source.sessionId || cdpSession.getEpoch(c.tabId) !== c.epoch)
      return;
    const p = raw as any;
    if (method === 'Network.requestWillBeSent') {
      if (c.filter && !String(p.request?.url || '').includes(c.filter)) return;
      if (c.entries.size >= 100) {
        c.dropped++;
        return;
      }
      c.entries.set(p.requestId, {
        requestId: p.requestId,
        url: p.request.url,
        method: p.request.method,
        type: p.type,
        frameId: p.frameId,
      });
    }
    const entry = c.entries.get(p.requestId);
    if (!entry) return;
    if (method === 'Network.responseReceived')
      Object.assign(entry, {
        status: p.response.status,
        mimeType: p.response.mimeType,
      });
    if (method === 'Network.loadingFailed')
      entry.error = String(p.errorText || 'loadingFailed');
    if (method === 'Network.loadingFinished' && !entry.captureStarted) {
      entry.captureStarted = true;
      if (
        c.pending.size >= 4 ||
        c.bytes >= 4_000_000 ||
        Number(p.encodedDataLength) > 1_000_000
      ) {
        entry.bodyUnavailable = '容量或并发上限';
        return;
      }
      const work = (async () => {
        try {
          if (!/json|text|csv|javascript|xml/i.test(entry.mimeType || '')) {
            entry.bodyUnavailable = '非文本响应，未自动解码';
            return;
          }
          const result = await textCommand(c.tabId, 'Network.getResponseBody', {
            requestId: p.requestId,
          });
          if (!c.active || cdpSession.getEpoch(c.tabId) !== c.epoch) return;
          if (result.base64Encoded) {
            entry.bodyUnavailable = 'base64 响应未自动解码';
            return;
          }
          const body = String(result.body ?? '');
          if (body.length > 1_000_000 || c.bytes + body.length > 4_000_000) {
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
            `网络响应 ${entry.url.slice(0, 100)}`
          );
          if (saved.ok)
            Object.assign(entry, {
              dataRef: saved.meta,
              preview: body.slice(0, 1000),
              bodyChars: body.length,
            });
          else entry.bodyUnavailable = saved.reason;
        } catch (error) {
          entry.bodyUnavailable =
            error instanceof Error ? error.message : String(error);
        }
      })();
      c.pending.add(work);
      void work.finally(() => c.pending.delete(work));
    }
  });
  chrome.debugger.onDetach.addListener((source) => {
    for (const c of captures.values())
      if (c.tabId === source.tabId && c.active) {
        c.active = false;
        c.warning = '调试会话已脱离，捕获停止';
        clearTimeout(c.timer);
      }
  });
  listening = true;
}
export class NetworkObserverTool extends BaseBrowserTool {
  name = 'browser_network_capture';
  metadata: ToolMetadata = {
    name: this.name,
    description:
      '实际观察网络请求与文本响应，统一启动/读取/停止；完整正文进入 dataRef',
    category: 'browser',
    version: '6.0.0',
  };
  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description:
        '被动网络观察，不重放请求。start 后触发页面加载/滚动再 read；stop 结束。仅捕获当前顶层调试 target 的新请求，跨进程 frame/历史响应/二进制同步协议不保证覆盖。最多100请求、每正文1M字符、合计4M字符、55秒；超过会标记缺失，不能视为全量数据。完整文本/JSON 正文写 dataRef，默认只回预览。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['start', 'read', 'stop'] },
          captureId: {
            type: 'string',
            description: 'read/stop 必须传 start 返回值',
          },
          urlIncludes: {
            type: 'string',
            description: 'start 可选 URL 子串过滤',
          },
          offset: { type: 'number', description: 'read 从0开始的记录偏移' },
          limit: { type: 'number', description: 'read 最多20条，默认10' },
        },
        required: ['action'],
      },
    },
  };
  async execute(p: {
    action: 'start' | 'read' | 'stop';
    captureId?: string;
    urlIncludes?: string;
    offset?: number;
    limit?: number;
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
        if (
          Object.keys(p).some(
            (k) =>
              ![
                'action',
                'captureId',
                'urlIncludes',
                'offset',
                'limit',
              ].includes(k)
          )
        )
          throw new Error('存在未知参数，请按 Schema 调用');
        if (p.action === 'start') {
          if (
            p.captureId !== undefined ||
            p.offset !== undefined ||
            p.limit !== undefined
          )
            throw new Error('start 不接受 captureId/offset/limit');
          if (p.urlIncludes !== undefined && typeof p.urlIncludes !== 'string')
            throw new Error('urlIncludes 必须是字符串');
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
          const c: Capture = {
            id,
            tabId: tab.id,
            epoch: cdpSession.getEpoch(tab.id),
            started: Date.now(),
            active: true,
            filter: p.urlIncludes || '',
            entries: new Map(),
            pending: new Set(),
            bytes: 0,
            dropped: 0,
            timer: setTimeout(() => {
              void stop(c);
            }, 55_000),
          };
          captures.set(id, c);
          while (captures.size > 8) {
            const oldest = captures.values().next().value!;
            await stop(oldest);
            captures.delete(oldest.id);
          }
          return this.createSuccessResponse({
            captureId: id,
            tabId: tab.id,
            active: true,
            hint: '现在触发页面操作，随后用同一 captureId read；只观察后续请求。',
          });
        }
        if (typeof p.captureId !== 'string' || !captures.has(p.captureId))
          throw new Error('captureId 不存在或已淘汰');
        if (p.urlIncludes !== undefined)
          throw new Error('过滤条件只在 start 设置');
        const c = captures.get(p.captureId)!;
        if (p.action === 'stop') {
          if (p.offset !== undefined || p.limit !== undefined)
            throw new Error('stop 不接受分页参数');
          // Let bodies already in progress settle before disabling the domain.
          await boundedText(
            Promise.allSettled([...c.pending]),
            '等待响应正文',
            8000
          ).catch(() => undefined);
          await stop(c);
          return this.createSuccessResponse({
            captureId: c.id,
            active: false,
            totalRequests: c.entries.size,
            pending: c.pending.size,
            dropped: c.dropped,
            hint: '可继续 read 已捕获结果；未捕获的数据不会补齐。',
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
        const entries = [...c.entries.values()]
          .slice(offset, offset + limit)
          .map(({ captureStarted, ...entry }) => entry);
        return this.createSuccessResponse({
          captureId: c.id,
          tabId: c.tabId,
          active: c.active,
          entries,
          totalRequests: c.entries.size,
          pending: c.pending.size,
          dropped: c.dropped,
          nextOffset:
            offset + entries.length < c.entries.size
              ? offset + entries.length
              : null,
          warning: c.warning,
          coverage:
            '仅捕获开始后的匹配请求，正文可能仍在加载或不可用；无数据不表示页面无数据',
        });
      });
    } catch (error) {
      return this.createErrorResponse('网络观察失败', error);
    }
  }
}

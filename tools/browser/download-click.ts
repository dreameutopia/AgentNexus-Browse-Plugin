import type { OpenAITool } from '@/common/openai-types';
import type { ToolResult } from '@/common/tool-handler';
import { requireWorkspaceChatId } from '@/utils/python-workspace/artifact-contract';
import { BaseBrowserTool } from '../base/browser-tool';
import { BrowserWaitError, withDeadline } from '../common/frame-read';
import { CONFIRM_GUIDANCE, CONFIRM_PARAMETER_DESCRIPTION } from '../confirmation-policy';
import type { ToolExecutionContext, ToolMetadata } from '../registry';
import { browserChrome } from './browser-scope';
import { canRetryDownloadImport, downloadImportStatus, trackDownloadImport, type DownloadImportResult } from './download-import';
import { browserInteractTool } from './interact';
import { textCommand } from './text-runtime';

type DownloadClickArgs =
  | { action: 'click'; elementId: string; frameId: number; tabId?: number | string; description: string; confirm?: boolean }
  | { action: 'status'; downloadId: string; waitSeconds?: number; retryImport?: boolean };

const START_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_SECONDS = 10;
const MAX_WAIT_SECONDS = 180;
const TASK_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
let activeCapture: symbol | undefined;

type DownloadPhase = 'validate' | 'arm' | 'click' | 'associate' | 'status';
type ClickOutcome = 'not_dispatched' | 'dispatched' | 'unknown';

class DownloadClickError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function findDownload(urls: Set<string>, startedAt: number, incognito: boolean, signal?: AbortSignal) {
  const since = new Date(startedAt - 1).toISOString();
  const queries = [...urls].flatMap(url => [{ url, startedAfter: since }, { finalUrl: url, startedAfter: since }]);
  const items = (await withDeadline(
    () => Promise.all(queries.map(query => chrome.downloads.search(query))),
    3000, '查询浏览器下载队列', signal,
  )).flat();
  const candidates = new Map(items
    .filter(item => !item.byExtensionId && item.incognito === incognito)
    .map(item => [item.id, item]));
  if (candidates.size > 1) {
    throw new DownloadClickError('AMBIGUOUS_DOWNLOAD', '检测到并发下载，无法确定归属。请查看浏览器下载列表。');
  }
  return candidates.values().next().value;
}

export class BrowserDownloadClickTool extends BaseBrowserTool {
  name = 'browser_download_click';
  metadata: ToolMetadata = {
    name: this.name,
    category: 'browser',
    description: '点击网页下载按钮，跟踪浏览器下载并把小于 100 MB 的已完成原件导入当前会话',
    version: '2.0.0',
    permissions: ['downloads', 'debugger', 'webNavigation'],
    requiresConfirm: true,
    requiresConfirmActions: ['click'],
  };
  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description:
        '点击网页下载或导出按钮。用原生工具调用，提交一个完整 JSON 对象。同一标签页只传 action="click"、elementId、frameId、简短 description；跨标签页才传 tabId。引用来自 browser_observe 或 browser_dom_explore。' +
        '一次点击返回异步下载任务。拿到 UUID downloadId 后只用 action="status" 和该 UUID 续查，浏览器的数字 browserDownloadId 供下载管理器使用。waitSeconds 默认 10、最大 180、0 为立即查询。' +
        '只有 workspaceStatus=imported 且返回 file.path 才可继续读取工作区文件。仅在修复可重试的导入错误后，用同一 UUID 传 retryImport=true 重试读原件；禁止为检查进度或导入失败再次点击。' +
        '小于 100 MB 的文件导入 outputs/。自动保存需关闭浏览器逐文件询问，读取本机原件需开启扩展的文件网址访问。站点自己的保存窗口可能不生成下载条目。' +
        CONFIRM_GUIDANCE,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['click', 'status'] },
          elementId: { type: 'string', description: 'click 必填，browser_observe 返回的 DOM ElementId' },
          frameId: { type: 'integer', minimum: 0, description: 'click 必填，DOM 引用所在 FrameId' },
          tabId: { type: 'integer', minimum: 0, description: 'click 仅跨标签页时提供。同一标签页省略' },
          description: { type: 'string', description: 'click 必填，说明下载目标和用途' },
          confirm: { type: 'boolean', description: CONFIRM_PARAMETER_DESCRIPTION },
          downloadId: { type: 'string', description: 'status 必填，本工具返回的插件下载任务 UUID' },
          waitSeconds: { type: 'integer', minimum: 0, maximum: MAX_WAIT_SECONDS, description: 'status 可选，默认 10 秒，0 为立即查询' },
          retryImport: { type: 'boolean', description: 'status 可选。排除读取或工作区写入故障后，重新导入同一任务的本机原件一次' },
        },
        required: ['action'],
      },
    },
  };

  async execute(input: DownloadClickArgs, context?: ToolExecutionContext): Promise<ToolResult> {
    this.ensureBackgroundContext();
    let phase: DownloadPhase = 'validate';
    try {
      const chatId = requireWorkspaceChatId(context?.chatId);
      const signal = context?.signal;
      signal?.throwIfAborted();
      if (!chrome.downloads?.search || !chrome.storage?.local) {
        throw new DownloadClickError('DOWNLOAD_API_UNAVAILABLE', '当前浏览器环境不支持下载跟踪。');
      }
      if (input?.action === 'status') {
        if (typeof input.downloadId !== 'string' || !TASK_ID.test(input.downloadId)) {
          throw new DownloadClickError('INVALID_DOWNLOAD_ID', '请传入工具返回的插件 downloadId（UUID）。');
        }
        const waitSeconds = input.waitSeconds === undefined ? DEFAULT_WAIT_SECONDS : input.waitSeconds;
        if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_WAIT_SECONDS) {
          throw new DownloadClickError('INVALID_WAIT_SECONDS', 'waitSeconds 必须是 0 到 180 的整数。');
        }
        phase = 'status';
        if (input.retryImport !== undefined && typeof input.retryImport !== 'boolean') {
          throw new DownloadClickError('INVALID_RETRY_IMPORT', 'retryImport 必须是布尔值。');
        }
        return await this.waitForStatus(input.downloadId.toLowerCase(), chatId, waitSeconds, input.retryImport === true, signal);
      }
      if (input?.action !== 'click') throw new DownloadClickError('INVALID_ACTION', 'action 必须是 click 或 status。');
      if (activeCapture) throw new DownloadClickError('DOWNLOAD_CAPTURE_BUSY', '另一项下载正在匹配，请等待其返回下载 ID。');
      phase = 'arm';
      return await this.clickDownload(input, chatId, context);
    } catch (error) {
      return this.failure(error, phase, context?.signal?.aborted, input?.action === 'click' ? 'not_dispatched' : undefined,
        phase === 'status' && input?.action === 'status' ? input.downloadId : undefined);
    }
  }

  private failure(
    error: unknown, phase: DownloadPhase, aborted = false, clickOutcome?: ClickOutcome,
    downloadId?: string, browserDownloadId?: number,
  ): ToolResult {
    const code = aborted ? 'DOWNLOAD_WAIT_ABORTED' : error instanceof DownloadClickError ? error.code :
      ({ validate: 'DOWNLOAD_PRECONDITION_FAILED', arm: 'DOWNLOAD_OBSERVER_FAILED', click: 'DOWNLOAD_CLICK_FAILED',
        associate: 'DOWNLOAD_ASSOCIATION_FAILED', status: 'DOWNLOAD_STATUS_FAILED' })[phase];
    const detail = aborted ? '等待已取消。' : error instanceof Error ? error.message : String(error);
    const recovery = browserDownloadId !== undefined ? ` 请在浏览器下载列表检查条目 ${browserDownloadId}。` :
      downloadId && code !== 'DOWNLOAD_JOB_NOT_FOUND' ? ` 请用原下载 ID ${downloadId} 查询。` :
      clickOutcome && clickOutcome !== 'not_dispatched' ? ' 请先核对浏览器下载列表和页面状态，避免重复点击。' : '';
    return {
      ...this.createErrorResponse(`${code}：${detail}${recovery}`),
      data: { code, phase, clickOutcome, downloadId, browserDownloadId },
    };
  }

  private async clickDownload(
    input: Extract<DownloadClickArgs, { action: 'click' }>,
    chatId: string,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const lifetime = new AbortController();
    const externalSignal = context?.signal;
    const signal = lifetime.signal;
    const scopedContext = { ...context, signal };
    const token = Symbol();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let timedOut = false;
    let tabId: number | undefined;
    let incognito = false;
    let startedAt = 0;
    let captureDeadline = 0;
    let lastEvidenceAt = 0;
    let matched: chrome.downloads.DownloadItem;
    let phase: DownloadPhase = 'arm';
    let clickOutcome: ClickOutcome = 'not_dispatched';
    let detachReason: string | undefined;
    const downloads = new Map<string, string>();
    const popupUrls = new Set<string>();
    const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: unknown) => {
      if (closed || source.tabId !== tabId || !startedAt || performance.now() >= captureDeadline || method !== 'Page.downloadWillBegin') return;
      const event = params as { url?: string; guid?: string } | undefined;
      if (event?.url && event.guid && !downloads.has(event.guid)) {
        downloads.set(event.guid, event.url);
        lastEvidenceAt = Date.now();
      }
    };
    const onPopup = (event: chrome.webNavigation.WebNavigationSourceCallbackDetails) => {
      if (closed || !startedAt || performance.now() >= captureDeadline || event.sourceTabId !== tabId || event.sourceFrameId !== input.frameId) return;
      if (/^(https?:|blob:|data:)/.test(event.url) && !popupUrls.has(event.url)) {
        popupUrls.add(event.url);
        lastEvidenceAt = Date.now();
      }
    };
    const onDetach = (source: chrome.debugger.Debuggee, reason: string) => {
      if (!closed && startedAt && source.tabId === tabId) detachReason = reason;
    };
    const api = browserChrome(scopedContext);
    const events = api.debugger?.onEvent;
    const detachEvents = api.debugger?.onDetach;
    const popupEvents = api.webNavigation?.onCreatedNavigationTarget;
    if (!events) throw new DownloadClickError('DOWNLOAD_OBSERVER_UNAVAILABLE', '当前浏览器不能监听标签页下载事件。');

    const cancel = () => lifetime.abort(externalSignal?.reason);
    const expire = () => {
      timedOut = true;
      lifetime.abort();
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', cleanup);
      externalSignal?.removeEventListener('abort', cancel);
      if (activeCapture === token) activeCapture = undefined;
      events.removeListener(onEvent);
      detachEvents?.removeListener(onDetach);
      popupEvents?.removeListener(onPopup);
    };
    activeCapture = token;
    signal.addEventListener('abort', cleanup, { once: true });
    externalSignal?.addEventListener('abort', cancel, { once: true });
    if (externalSignal?.aborted) cancel();
    try {
      signal.throwIfAborted();
      const click = await withDeadline(() => browserInteractTool.execute({
        action: 'click', trusted: true, elementId: input.elementId, frameId: input.frameId,
        tabId: input.tabId, description: input.description, confirm: input.confirm,
      }, scopedContext, async tab => {
        try {
          await textCommand(tab.id, 'Page.enable', {}, 5000, scopedContext);
        } catch {
          throw new Error('DOWNLOAD_OBSERVER_FAILED：无法启用标签页下载观察。请检查页面是否可调试。');
        }
        signal.throwIfAborted();
        tabId = tab.id;
        incognito = tab.incognito;
        events.addListener(onEvent);
        detachEvents?.addListener(onDetach);
        popupEvents?.addListener(onPopup);
        startedAt = Date.now();
        captureDeadline = performance.now() + START_TIMEOUT_MS;
        phase = 'click';
        clickOutcome = 'unknown';
        timer = setTimeout(expire, START_TIMEOUT_MS);
      }), 60_000, '派发下载点击', signal);
      clickOutcome = click.success ? 'dispatched' : click.data?.outcome === 'not_dispatched' ? 'not_dispatched' : 'unknown';
      if (!click.success && (!startedAt || click.data?.outcome === 'not_dispatched')) {
        if (!startedAt) clickOutcome = 'not_dispatched';
        const cause = click.data?.cause?.errorCode;
        throw new DownloadClickError(cause && cause !== 'TEXT_INTERACTION_FAILED' ? cause :
          phase === 'arm' ? 'DOWNLOAD_PRECONDITION_FAILED' : 'DOWNLOAD_CLICK_FAILED',
        click.error ?? click.message ?? '点击前检查失败。');
      }

      phase = 'associate';
      while (true) {
        if (performance.now() >= captureDeadline) expire();
        signal.throwIfAborted();
        if (downloads.size > 1) throw new DownloadClickError('AMBIGUOUS_DOWNLOAD', '一次点击产生多个下载。');
        const urls = new Set([...downloads.values(), ...popupUrls]);
        if (urls.size > 5) throw new DownloadClickError('AMBIGUOUS_DOWNLOAD', '点击打开多个下载来源。');
        if (urls.size && Date.now() - lastEvidenceAt >= 250) {
          const evidenceAt = lastEvidenceAt;
          const item = await findDownload(urls, startedAt, incognito, signal);
          if (performance.now() >= captureDeadline) expire();
          signal.throwIfAborted();
          if (item && evidenceAt === lastEvidenceAt && downloads.size <= 1) {
            matched = item;
            break;
          }
        }
        await delay(250, signal);
      }
    } catch (error) {
      if (timedOut && !externalSignal?.aborted) {
        error = downloads.size ? new DownloadClickError('DOWNLOAD_RECORD_NOT_MATCHED', '30 秒内收到页面下载事件，但未匹配到下载条目。') :
          detachReason ? new DownloadClickError('DOWNLOAD_OBSERVER_DETACHED', '下载观察已断开（' + detachReason + '）。') :
          new DownloadClickError('DOWNLOAD_NOT_OBSERVED', '30 秒内未确认浏览器下载，捕获窗口已关闭。');
      }
      return this.failure(error, phase, externalSignal?.aborted, clickOutcome);
    } finally {
      cleanup();
      // A timed-out preflight cannot arm a listener after this call has returned.
      lifetime.abort();
    }

    try {
      return this.formatResult(await trackDownloadImport(matched, chatId));
    } catch {
      return this.failure(new DownloadClickError('DOWNLOAD_TRACKING_SAVE_FAILED', '已识别浏览器下载，但无法保存会话跟踪记录。'),
        'associate', false, clickOutcome, undefined, matched.id);
    }
  }

  private async waitForStatus(id: string, chatId: string, waitSeconds: number, retryImport: boolean, signal?: AbortSignal): Promise<ToolResult> {
    const deadline = performance.now() + waitSeconds * 1000;
    let last: DownloadImportResult | undefined;
    while (true) {
      const remaining = deadline - performance.now();
      if (last && remaining <= 0) return this.formatResult(last, true);
      try {
        const retryOnce = retryImport;
        retryImport = false;
        last = await withDeadline(() => downloadImportStatus(id, chatId, retryOnce),
          waitSeconds === 0 ? 4000 : Math.max(1, remaining), '等待下载状态', signal);
      } catch (error) {
        if (error instanceof BrowserWaitError && error.code === 'INJECTION_TIMEOUT' && !signal?.aborted) {
          if (last) return this.formatResult(last, true);
          throw new DownloadClickError('DOWNLOAD_STATUS_TIMEOUT', '等待时间内未能读取下载进度。');
        }
        throw error;
      }
      if (!last) throw new DownloadClickError('DOWNLOAD_JOB_NOT_FOUND', '当前会话没有这条跟踪任务。');
      if (waitSeconds === 0 || last.paused || last.workspaceStatus !== 'waiting') return this.formatResult(last);
      await delay(Math.max(0, Math.min(500, deadline - performance.now())), signal);
    }
  }

  private formatResult(result: DownloadImportResult, waitTimedOut = false): ToolResult {
    const { downloadState, workspaceStatus } = result;
    if (workspaceStatus === 'imported') {
      return this.createSuccessResponse({ ...result, code: 'DOWNLOAD_IMPORTED', waitTimedOut, files: [result.file] }, '已下载并导入当前会话');
    }
    let code: string;
    let message: string;
    if (downloadState === 'interrupted') {
      code = 'DOWNLOAD_INTERRUPTED';
      message = result.downloadError === 'USER_CANCELED' ? '浏览器报告下载已取消。' :
        `浏览器报告下载已中断${result.downloadError ? `（${result.downloadError}）` : ''}，请查看下载列表。`;
    } else if (downloadState === 'missing') {
      code = 'DOWNLOAD_RECORD_MISSING';
      message = '浏览器下载条目已无法查询。';
    } else if (downloadState === 'in_progress') {
      code = result.paused ? 'DOWNLOAD_PAUSED' : 'DOWNLOAD_IN_PROGRESS';
      message = result.paused ? '浏览器报告下载已暂停，可在下载列表恢复。' :
        '下载条目已建立，但尚未完成。请用同一 downloadId 查询。如果浏览器显示保存或安全确认窗口，需要用户处理。';
    } else if (workspaceStatus === 'waiting') {
      code = 'WORKSPACE_IMPORT_PENDING';
      message = '浏览器下载已完成，工作区导入正在等待处理。';
    } else if (workspaceStatus === 'permission_required') {
      code = 'LOCAL_FILE_PERMISSION_REQUIRED';
      message = '浏览器下载已完成。自动导入需要在扩展详情页开启「允许访问文件网址」，也可手动上传原件。';
    } else if (workspaceStatus === 'too_large') {
      code = 'WORKSPACE_FILE_TOO_LARGE';
      message = '浏览器下载已完成。文件达到 100 MB，仅保留在浏览器下载列表。';
    } else if (workspaceStatus === 'failed') {
      code = result.workspaceCode;
      message = '浏览器下载已完成。' + result.workspaceError;
    } else {
      code = workspaceStatus === 'unavailable' ? result.workspaceCode ?? 'LOCAL_FILE_UNAVAILABLE' : 'LOCAL_FILE_UNAVAILABLE';
      message = code === 'LOCAL_FILE_MISSING' ? '浏览器报告本机原件已不存在。' :
        code === 'LOCAL_PATH_MISSING' ? '下载已完成，但浏览器未提供可导入的本机路径。' : '本机原件不可用，请检查浏览器下载列表。';
    }
    const importRetryAvailable = canRetryDownloadImport(result);
    return this.createSuccessResponse({ ...result, code, waitTimedOut, importRetryAvailable }, waitTimedOut ? '等待已到期。' + message : message);
  }
}

export const browserDownloadClickTool = new BrowserDownloadClickTool();

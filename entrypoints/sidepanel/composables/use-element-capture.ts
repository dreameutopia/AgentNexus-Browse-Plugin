/**
 * 侧边栏元素捕获管理器
 *
 * 负责：
 *   - 启动 / 结束当前标签页的元素捕获模式（广播到所有 frame）；
 *   - 接收内容脚本上报的捕获结果（补写 frameId、截图入库、去重、上限控制）；
 *   - 维护「待发送」的元素列表，供输入区 chip、发送链路与会话切换使用。
 *
 * 稳定性：
 *   - 标签页切换 / 刷新 / 关闭、侧边栏卸载都会主动退出捕获，避免页面残留遮罩；
 *   - 所有消息都校验来源标签页与载荷形状，非法载荷丢弃并给出可读提示。
 */

import { computed, onBeforeUnmount, ref } from 'vue';
import { imageStore } from '../core/images/image-store';
import { showAlert } from './use-app-dialog';
import {
  CAPTURED_ELEMENT_LIMIT,
  CAPTURED_ELEMENT_NOTE_MAX_CHARS,
  type CapturedElement,
  type CapturedElementKind,
} from '@/utils/element-capture/types';
import {
  ELEMENT_CAPTURE_MESSAGE,
  type ElementCaptureCancelledMessage,
  type ElementCaptureFailedMessage,
  type ElementCaptureReadyMessage,
  type ElementCaptureResultMessage,
} from '@/utils/element-capture/protocol';

const ELEMENT_KINDS: ReadonlySet<string> = new Set<CapturedElementKind>([
  'text-input',
  'textarea',
  'password',
  'number',
  'email',
  'search',
  'tel',
  'url',
  'date',
  'time',
  'datetime',
  'color',
  'range',
  'file',
  'checkbox',
  'radio',
  'select',
  'button',
  'link',
  'image',
  'video',
  'audio',
  'table',
  'list',
  'form',
  'iframe',
  'canvas',
  'svg',
  'code',
  'heading',
  'paragraph',
  'container',
  'switch',
  'label',
  'other',
]);

/** 元素校验结果（侧边栏据此渲染右上角提示气泡） */
export interface CapturedElementVerifyResult {
  ok: boolean;
  reason?: 'not-found' | 'inject-failed' | 'no-response';
  detail?: string;
}

const READY_TIMEOUT_MS = 2000;
/** 补注入捕获器后的二次等待：注入 + 脚本执行需要额外时间 */
const READY_RETRY_TIMEOUT_MS = 2500;
/** 刚收到的 READY 在此时长内可复用，避免「超时后 READY 才到」的竞态误判 */
const READY_FRESH_MS = 1500;
/** 校验命中后页面内的框选闪烁时长 */
const VERIFY_HIGHLIGHT_MS = 3000;
/** 校验消息的应答超时（超时按「无接收方」处理，补注入后重试一次） */
const VERIFY_RESPONSE_TIMEOUT_MS = 2500;
/**
 * 捕获器内容脚本产物路径（WXT 以入口文件名输出）。
 * 页面早于扩展加载 / 更新时，标签页内没有捕获器，需按此路径补注入。
 */
const PICKER_CONTENT_SCRIPT = 'content-scripts/element-picker.js';
const SELECTOR_MAX_CHARS = 2000;

function createElementId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // 回退
  }
  return `el-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isSupportedTabUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^(https?|file):/i.test(url);
}

function normalizeNote(note: string): string {
  return note.replace(/\r\n/g, '\n').slice(0, CAPTURED_ELEMENT_NOTE_MAX_CHARS);
}

export function useElementCapture() {
  const elements = ref<CapturedElement[]>([]);
  const isCapturing = ref(false);
  const captureTabId = ref<number | null>(null);
  const lastError = ref('');

  const count = computed(() => elements.value.length);
  const isFull = computed(() => elements.value.length >= CAPTURED_ELEMENT_LIMIT);

  let readyResolver: ((ok: boolean) => void) | null = null;
  let readyTimer: number | null = null;
  /** 最近一次收到 READY 的时刻（0 = 本次启动尚未收到） */
  let readySeenAt = 0;
  /** 本次启动中某个 frame 上报的捕获器错误（仅用于失败提示，不阻断其它 frame） */
  let lastFrameError = '';
  let limitNoticeShown = false;
  let disposed = false;

  function settleReady(ok: boolean): void {
    if (readyTimer !== null) {
      window.clearTimeout(readyTimer);
      readyTimer = null;
    }
    const resolver = readyResolver;
    readyResolver = null;
    resolver?.(ok);
  }

  function waitForReady(timeoutMs: number): Promise<boolean> {
    // READY 可能在上一次等待超时之后才到达：新鲜窗口内直接视为就绪，
    // 避免「重发 START → 捕获器已在运行 → 不再应答」造成的假失败。
    if (readySeenAt > 0 && Date.now() - readySeenAt <= READY_FRESH_MS) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      readyResolver = resolve;
      readyTimer = window.setTimeout(() => {
        readyTimer = null;
        readyResolver = null;
        resolve(false);
      }, timeoutMs);
    });
  }

  /**
   * 补注入捕获器内容脚本（所有 frame）。
   *
   * 适用场景：页面在扩展安装 / 更新 / 重载之前就已打开，标签页内只有旧内容脚本
   * （甚至没有捕获器）；浏览器不会为已存在的标签页重新注入内容脚本，此时
   * START 无人应答。主动注入当前版本的捕获器入口即可恢复，无需用户刷新。
   */
  async function injectPicker(tabId: number): Promise<{ ok: boolean; message: string }> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: [PICKER_CONTENT_SCRIPT],
      });
      return { ok: true, message: '' };
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : String(error || '');
      console.warn('[ElementCapture] 补注入捕获器失败:', message);
      return { ok: false, message };
    }
  }

  function sendToTab(tabId: number, message: unknown): void {
    try {
      const result = chrome.tabs.sendMessage(tabId, message as Record<string, unknown>);
      // 无接收方时 Promise 会 reject；这里吞掉并交由调用方用 READY 超时判定
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // 标签页已关闭 / 权限不足：忽略
    }
  }

  function stop(options: { silent?: boolean } = {}): void {
    const tabId = captureTabId.value;
    const wasCapturing = isCapturing.value;
    isCapturing.value = false;
    captureTabId.value = null;
    settleReady(false);
    readySeenAt = 0;
    limitNoticeShown = false;

    if (tabId !== null) {
      sendToTab(tabId, { type: ELEMENT_CAPTURE_MESSAGE.STOP });
    }

    if (wasCapturing && !options.silent) {
      // 由外部原因（切换标签 / 页面刷新）中止时给出轻提示
      lastError.value = '元素捕获已结束';
    }
  }

  async function start(): Promise<void> {
    if (isCapturing.value) {
      stop();
      return;
    }
    lastError.value = '';

    let tab: chrome.tabs.Tab | undefined;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      tab = undefined;
    }

    if (!tab?.id) {
      await showAlert('无法获取当前标签页，请打开一个网页后重试。', '元素捕获');
      return;
    }
    if (!isSupportedTabUrl(tab.url)) {
      await showAlert(
        '当前页面不支持元素捕获。请切换到普通网页（http/https）后重试。',
        '元素捕获',
      );
      return;
    }

    isCapturing.value = true;
    captureTabId.value = tab.id;
    limitNoticeShown = false;
    readySeenAt = 0;
    lastFrameError = '';

    // 第一轮：广播 START 并等待任一 frame 应答 READY
    const firstReady = waitForReady(READY_TIMEOUT_MS);
    sendToTab(tab.id, { type: ELEMENT_CAPTURE_MESSAGE.START });
    let ok = await firstReady;

    // 第二轮：无应答说明标签页内没有当前版本的捕获器（页面早于扩展加载 /
    // 更新，或内容脚本尚未就绪）。补注入捕获器入口后重发 START 再等一次。
    let injectionError = '';
    if (!ok && isCapturing.value) {
      const injected = await injectPicker(tab.id);
      if (injected.ok) {
        const retryReady = waitForReady(READY_RETRY_TIMEOUT_MS);
        sendToTab(tab.id, { type: ELEMENT_CAPTURE_MESSAGE.START });
        ok = await retryReady;
      } else {
        injectionError = injected.message;
      }
    }

    if (!ok && isCapturing.value) {
      isCapturing.value = false;
      captureTabId.value = null;
      const reason = lastFrameError || injectionError;
      const detail = reason ? `（${reason}）` : '';
      await showAlert(
        injectionError
          ? `当前页面不允许扩展注入脚本${detail}。请确认扩展拥有该站点的访问权限后重试。`
          : lastFrameError && !injectionError
            ? `页面捕获器启动失败${detail}。请刷新当前网页后重试。`
            : '页面中没有可用的捕获器。请刷新当前网页后重试；若仍失败，请确认扩展拥有该站点的访问权限。',
        '元素捕获失败',
      );
    }
  }

  function buildDedupeKey(frameId: number, css: string, shadowHosts?: string[]): string {
    return `${frameId}|${(shadowHosts || []).join('>')}|${css}`;
  }

  /**
   * 单次高亮请求：命中返回 ok，选择器不唯一 / 元素消失返回 not-found，
   * 无接收方 / 超时 / 通道异常返回 unreachable（调用方据此补注入重试）。
   */
  async function requestHighlight(
    tabId: number,
    element: CapturedElement,
  ): Promise<{ state: 'ok' } | { state: 'not-found' | 'unreachable'; message: string }> {
    const frameId =
      Number.isSafeInteger(element.frameId) && element.frameId >= 0 ? element.frameId : 0;
    let timer: number | null = null;
    try {
      const response = await Promise.race([
        chrome.tabs.sendMessage(
          tabId,
          {
            type: ELEMENT_CAPTURE_MESSAGE.HIGHLIGHT,
            css: element.selector,
            shadowHosts: element.shadowHosts ?? [],
            durationMs: VERIFY_HIGHLIGHT_MS,
          },
          { frameId },
        ),
        new Promise<null>((resolve) => {
          timer = window.setTimeout(() => resolve(null), VERIFY_RESPONSE_TIMEOUT_MS);
        }),
      ]);

      if (!response || typeof response !== 'object') {
        return { state: 'unreachable', message: '页面未响应校验请求' };
      }
      const result = response as { ok?: unknown; message?: unknown };
      if (result.ok === true) return { state: 'ok' };
      return {
        state: 'not-found',
        message: typeof result.message === 'string' ? result.message : '',
      };
    } catch (error) {
      return {
        state: 'unreachable',
        message: error instanceof Error ? error.message : '',
      };
    } finally {
      if (timer !== null) window.clearTimeout(timer);
    }
  }

  /**
   * 校验一个已捕获元素：在指定标签页的对应 frame 内重新定位并高亮闪烁。
   * 无接收方时补注入捕获器后重试一次（覆盖扩展更新前已打开的页面）。
   */
  async function verify(element: CapturedElement, tabId: number): Promise<CapturedElementVerifyResult> {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return { ok: false, reason: 'not-found' };
    const css = typeof element.selector === 'string' ? element.selector.trim() : '';
    if (!css) return { ok: false, reason: 'not-found' };

    const first = await requestHighlight(tabId, element);
    if (first.state === 'ok') return { ok: true };
    if (first.state === 'not-found') {
      return { ok: false, reason: 'not-found', detail: first.message };
    }

    const injected = await injectPicker(tabId);
    if (!injected.ok) {
      return { ok: false, reason: 'inject-failed', detail: injected.message };
    }

    const second = await requestHighlight(tabId, element);
    if (second.state === 'ok') return { ok: true };
    return {
      ok: false,
      reason: second.state === 'not-found' ? 'not-found' : 'no-response',
      detail: second.message,
    };
  }

  async function handleResult(
    message: ElementCaptureResultMessage,
    sender: chrome.runtime.MessageSender,
  ): Promise<void> {
    const tabId = sender.tab?.id;
    if (tabId === undefined || tabId !== captureTabId.value) return;

    const css = typeof message.selector?.css === 'string' ? message.selector.css.trim() : '';
    if (!css || css.length > SELECTOR_MAX_CHARS) {
      lastError.value = '捕获结果缺少有效选择器，已忽略';
      return;
    }

    const descriptor = message.descriptor;
    if (!descriptor || typeof descriptor !== 'object') {
      lastError.value = '捕获结果缺少元素描述，已忽略';
      return;
    }

    const frameId = typeof sender.frameId === 'number' && sender.frameId >= 0 ? sender.frameId : 0;
    const shadowHosts = Array.isArray(message.selector.shadowHosts)
      ? message.selector.shadowHosts.filter((item): item is string => typeof item === 'string')
      : [];

    const dedupeKey = buildDedupeKey(frameId, css, shadowHosts);
    const duplicated = elements.value.some(
      (item) => buildDedupeKey(item.frameId, item.selector, item.shadowHosts) === dedupeKey,
    );
    if (duplicated) {
      lastError.value = '该元素已捕获，已自动跳过';
      return;
    }

    if (elements.value.length >= CAPTURED_ELEMENT_LIMIT) {
      if (!limitNoticeShown) {
        limitNoticeShown = true;
        await showAlert(
          `最多只能选择 ${CAPTURED_ELEMENT_LIMIT} 个元素。请先发送或移除部分元素后再继续捕获。`,
          '已达选择上限',
        );
      }
      return;
    }

    let screenshotRef: string | undefined;
    if (typeof message.screenshotDataUrl === 'string' && message.screenshotDataUrl.startsWith('data:')) {
      try {
        const ref = await imageStore.putFromDataUrl(message.screenshotDataUrl);
        if (ref) screenshotRef = ref;
      } catch {
        // 截图入库失败不阻断元素捕获
      }
    }

    if (disposed) return;

    // 截图入库是异步的：入库期间可能有另一帧并发写入相同元素，这里二次去重
    const duplicatedAfterAwait = elements.value.some(
      (item) => buildDedupeKey(item.frameId, item.selector, item.shadowHosts) === dedupeKey,
    );
    if (duplicatedAfterAwait) return;
    if (elements.value.length >= CAPTURED_ELEMENT_LIMIT) return;

    const kind: CapturedElementKind = ELEMENT_KINDS.has(descriptor.kind)
      ? descriptor.kind
      : 'other';

    elements.value = [
      ...elements.value,
      {
        id: createElementId(),
        selector: css,
        xpath: typeof message.selector.xpath === 'string' ? message.selector.xpath : undefined,
        shadowHosts: shadowHosts.length ? shadowHosts : undefined,
        frameId,
        kind,
        tagName: typeof descriptor.tagName === 'string' ? descriptor.tagName.slice(0, 64) : 'element',
        description:
          typeof descriptor.description === 'string'
            ? descriptor.description.slice(0, 500)
            : css.slice(0, 500),
        note: undefined,
        screenshotRef,
        pageUrl: typeof message.pageUrl === 'string' ? message.pageUrl : sender.tab?.url,
        pageTitle: typeof message.pageTitle === 'string' ? message.pageTitle : sender.tab?.title,
        capturedAt: Date.now(),
      },
    ];

    lastError.value = '';
  }

  function onMessage(message: unknown, sender: chrome.runtime.MessageSender): undefined {
    if (!message || typeof message !== 'object') return undefined;
    const type = (message as { type?: string }).type;

    if (type === ELEMENT_CAPTURE_MESSAGE.READY) {
      const ready = message as ElementCaptureReadyMessage;
      if (sender.tab?.id === captureTabId.value && isCapturing.value) {
        readySeenAt = Date.now();
        lastError.value = '';
        settleReady(true);
      }
      void ready;
      return undefined;
    }

    if (type === ELEMENT_CAPTURE_MESSAGE.RESULT) {
      void handleResult(message as ElementCaptureResultMessage, sender);
      return undefined;
    }

    if (type === ELEMENT_CAPTURE_MESSAGE.CANCELLED) {
      const cancelled = message as ElementCaptureCancelledMessage;
      if (sender.tab?.id === captureTabId.value) {
        isCapturing.value = false;
        captureTabId.value = null;
        settleReady(false);
        lastError.value =
          cancelled.reason === 'page-unload' ? '页面已刷新，元素捕获结束' : '';
      }
      return undefined;
    }

    if (type === ELEMENT_CAPTURE_MESSAGE.FAILED) {
      const failed = message as ElementCaptureFailedMessage;
      if (sender.tab?.id === captureTabId.value) {
        lastFrameError = failed.message || '元素捕获失败';
        lastError.value = lastFrameError;
      }
      return undefined;
    }

    return undefined;
  }

  function onTabActivated(activeInfo: chrome.tabs.TabActiveInfo): void {
    if (!isCapturing.value) return;
    if (captureTabId.value !== null && activeInfo.tabId !== captureTabId.value) {
      stop({ silent: true });
      lastError.value = '已切换标签页，元素捕获结束';
    }
  }

  function onTabUpdated(
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
  ): void {
    if (!isCapturing.value || captureTabId.value !== tabId) return;
    if (changeInfo.status === 'loading') {
      stop({ silent: true });
      lastError.value = '页面正在刷新，元素捕获结束';
    }
  }

  function onTabRemoved(tabId: number): void {
    if (!isCapturing.value || captureTabId.value !== tabId) return;
    stop({ silent: true });
    lastError.value = '标签页已关闭，元素捕获结束';
  }

  function onPageHide(): void {
    stop({ silent: true });
  }

  function remove(id: string): void {
    elements.value = elements.value.filter((item) => item.id !== id);
  }

  function updateNote(id: string, note: string): void {
    const normalized = normalizeNote(note);
    elements.value = elements.value.map((item) =>
      item.id === id ? { ...item, note: normalized || undefined } : item,
    );
  }

  function clear(): void {
    elements.value = [];
    lastError.value = '';
    limitNoticeShown = false;
  }

  function restore(items: readonly CapturedElement[]): void {
    const seen = new Set<string>();
    const next: CapturedElement[] = [];
    for (const item of items) {
      if (next.length >= CAPTURED_ELEMENT_LIMIT) break;
      if (!item || typeof item.selector !== 'string' || !item.selector) continue;
      const key = buildDedupeKey(item.frameId, item.selector, item.shadowHosts);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({ ...item });
    }
    elements.value = next;
  }

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.tabs.onActivated.addListener(onTabActivated);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  window.addEventListener('pagehide', onPageHide);

  onBeforeUnmount(() => {
    disposed = true;
    stop({ silent: true });
    chrome.runtime.onMessage.removeListener(onMessage);
    chrome.tabs.onActivated.removeListener(onTabActivated);
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.tabs.onRemoved.removeListener(onTabRemoved);
    window.removeEventListener('pagehide', onPageHide);
  });

  return {
    elements,
    isCapturing,
    count,
    isFull,
    lastError,
    maxElements: CAPTURED_ELEMENT_LIMIT,
    start,
    stop,
    verify,
    clear,
    remove,
    updateNote,
    restore,
  };
}

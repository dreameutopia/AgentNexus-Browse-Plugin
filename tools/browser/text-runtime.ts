import { exclusiveGui } from '../vision/gui-driver';
import { cdpSession } from './cdp-session';
import { isRestrictedUrl } from '@/common/constants';
import { injectionErrorText } from '../common/script-injection';

/** Preserve useful diagnostics even when a dependency throws null or a plain object. */
export function readableTextError(error: unknown): string {
  return injectionErrorText(error);
}

/** Text tools never capture images or accept guessed coordinates. */
export async function textTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof tab?.id !== 'number' || isRestrictedUrl(tab.url))
    throw new Error('TARGET_UNAVAILABLE：请选择可访问的网页');
  return tab as chrome.tabs.Tab & { id: number; url: string };
}
export async function boundedText<T>(
  promise: Promise<T>,
  label: string,
  ms = 8000
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`TIMEOUT：${label}；结果可能不确定，先观察现状`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function textCommand<T = any>(
  tabId: number,
  method: string,
  params: object = {},
  timeoutMs = 8000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  if (method.startsWith('Input.')) {
    if (!cdpSession.hasSession(tabId))
      throw new Error('STALE_SESSION：重新观察并确认焦点后操作');
  } else await boundedText(cdpSession.attach(tabId), '附加调试会话', timeoutMs);
  if (performance.now() >= deadline) throw new Error(`TIMEOUT：${method} 调用预算已用尽`);
  return boundedText(
    chrome.debugger.sendCommand({ tabId }, method, params),
    method,
    Math.max(1, deadline - performance.now()),
  ) as Promise<T>;
}
/** Shared input queue prevents text and coordinate gestures from interleaving across chats. */
export function exclusiveText<T>(work: () => Promise<T>, queueTimeoutMs = 8000, signal?: AbortSignal): Promise<T> {
  if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs <= 0 || queueTimeoutMs > 2_147_483_647) return Promise.reject(new Error('INVALID_ARGUMENT：队列等待时间必须是有限正数'));
  if (signal?.aborted) return Promise.reject(new Error('ABORTED：排队前已取消，本次任务未执行'));
  // Bound queue acquisition only. Never release an active gesture's lock on timeout.
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const cleanup = () => { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); };
  const timeout = new Promise<never>((_, reject) => {
    abort = () => { expired = true; reject(new Error('ABORTED：排队任务已取消，本次任务未执行')); };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      expired = true;
      reject(new Error('QUEUE_TIMEOUT：等待浏览器操作队列超过上限；本次任务未开始执行'));
    }, queueTimeoutMs);
  });
  const queued = exclusiveGui(() => {
    cleanup();
    if (expired) throw new Error('QUEUE_TIMEOUT：已取消的排队任务不会延迟执行');
    return work();
  });
  return Promise.race([queued, timeout]).finally(cleanup);
}

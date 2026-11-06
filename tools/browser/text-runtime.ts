import { exclusiveGui } from '../vision/gui-driver';
import { cdpSession } from './cdp-session';
import { isRestrictedUrl } from '@/common/constants';

/** Preserve useful diagnostics even when a dependency throws null or a plain object. */
export function readableTextError(error: unknown): string {
  try {
    if (error && typeof error === 'object' && 'message' in error) return String(error.message).slice(0, 2000);
    return String(error).slice(0, 2000);
  } catch { return 'Unserializable error value'; }
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
  params: object = {}
): Promise<T> {
  if (method.startsWith('Input.')) {
    if (!cdpSession.hasSession(tabId))
      throw new Error('STALE_SESSION：重新观察并确认焦点后操作');
  } else await boundedText(cdpSession.attach(tabId), '附加调试会话');
  return boundedText(
    chrome.debugger.sendCommand({ tabId }, method, params),
    method
  ) as Promise<T>;
}
/** Shared input queue prevents text and coordinate gestures from interleaving across chats. */
export function exclusiveText<T>(work: () => Promise<T>): Promise<T> {
  return exclusiveGui(work);
}

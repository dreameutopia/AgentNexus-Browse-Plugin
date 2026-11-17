import { assertScopeWindow, type BrowserScope } from '@/tools/browser/browser-scope';
import { BrowserScopeError } from '@/tools/browser/scope-errors';

export function closedBrowserWindowError(windowId: number): BrowserScopeError {
  return new BrowserScopeError('BOUND_WINDOW_CLOSED', 'watchOperationWindow',
    '操作窗口已关闭，本轮任务已停止；不会转到其他窗口继续执行。请检查操作窗口设置后重新发送。', { windowId });
}

export function isClosedBrowserWindowError(error: unknown): boolean {
  return error instanceof BrowserScopeError ? error.code === 'BOUND_WINDOW_CLOSED'
    : error instanceof Error && /^BOUND_WINDOW_CLOSED[：:]/.test(error.message);
}

/** Subscribe before checking existence, so closure during startup is not missed. */
export function watchOperationWindow(scope: BrowserScope | undefined, closed: (error: BrowserScopeError) => void) {
  let disposed = false;
  let notified = false;
  const notify = (error: BrowserScopeError) => {
    if (disposed || notified) return;
    notified = true;
    closed(error);
  };
  const removed = (windowId: number) => { if (windowId === scope?.windowId) notify(closedBrowserWindowError(windowId)); };
  if (scope) chrome.windows.onRemoved.addListener(removed);
  const ready = scope ? assertScopeWindow({ browserScope: scope }).catch(error => {
    if (isClosedBrowserWindowError(error)) notify(closedBrowserWindowError(scope.windowId));
    else throw error;
  }) : Promise.resolve();
  // The caller awaits ready; observe rejection also while its preparation is pending.
  void ready.catch(() => undefined);
  return {
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (scope) chrome.windows.onRemoved.removeListener(removed);
    },
  };
}

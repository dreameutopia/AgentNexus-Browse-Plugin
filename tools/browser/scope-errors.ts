import type { ToolExecutionContext } from '../registry';

export type BrowserScopeErrorCode =
  | 'INVALID_BROWSER_SCOPE' | 'INVALID_BROWSER_ARGUMENT'
  | 'BOUND_WINDOW_CLOSED' | 'WINDOW_OUTSIDE_BOUND_SCOPE' | 'TAB_OUTSIDE_BOUND_WINDOW'
  | 'BROWSER_SCOPE_API_FAILED' | 'BROWSER_SCOPE_TIMEOUT' | 'BROWSER_SCOPE_ABORTED'
  | 'BROWSER_SCOPE_CONTEXT_CLOSED' | 'BROWSER_SCOPE_CLEANUP_FAILED'
  | 'BROWSER_BINDING_BUSY' | 'BROWSER_BINDING_CHANGED'
  | 'BOUND_WINDOW_OPERATION_DENIED' | 'BOUND_DEBUG_TARGET_DENIED' | 'BOUND_DEBUG_COMMAND_DENIED';

/** Diagnostics must themselves tolerate non-Error, circular and hostile values. */
export function browserErrorText(value: unknown): string {
  try {
    if (value instanceof Error && typeof value.message === 'string' && value.message) return value.message;
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object') {
      const message = (value as { message?: unknown }).message;
      if (typeof message === 'string' && message) return message;
      const json = JSON.stringify(value);
      if (json && json !== '{}') return json.slice(0, 1000);
    }
    return String(value);
  } catch { return '无法序列化的浏览器异常'; }
}

export class BrowserScopeError extends Error {
  readonly code: BrowserScopeErrorCode;
  readonly operation: string;
  readonly outcomeUncertain: boolean;
  readonly windowId?: number;
  readonly tabId?: number;

  constructor(code: BrowserScopeErrorCode, operation: string, message: string, options: {
    cause?: unknown; outcomeUncertain?: boolean; windowId?: number; tabId?: number;
  } = {}) {
    super(`${code}：${message} [operation=${operation}${options.windowId === undefined ? '' : `, windowId=${options.windowId}`}${options.tabId === undefined ? '' : `, tabId=${options.tabId}`}]`, { cause: options.cause });
    this.name = 'BrowserScopeError';
    this.code = code;
    this.operation = operation;
    this.outcomeUncertain = options.outcomeUncertain === true;
    this.windowId = options.windowId;
    this.tabId = options.tabId;
  }
}

/** The work starts only after cancellation is checked; late native responses are observed. */
export async function browserOperation<T>(operation: string, context: ToolExecutionContext | undefined,
  work: () => T | PromiseLike<T>, options: {
    timeoutMs?: number; tabId?: number; mutating?: boolean; cleanup?: boolean;
  } = {}): Promise<T> {
  const signal = options.cleanup ? undefined : context?.signal;
  const details = { windowId: context?.browserScope?.windowId, tabId: options.tabId };
  let dispatched = false;
  const aborted = () => new BrowserScopeError('BROWSER_SCOPE_ABORTED', operation,
    dispatched && options.mutating ? '操作中途取消，结果可能已生效；请先观察现状，勿直接重试。' : '操作已取消，未继续执行。',
    { ...details, cause: signal?.reason, outcomeUncertain: dispatched && options.mutating });
  if (signal?.aborted) throw aborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        error === undefined ? resolve(value as T) : reject(error);
      };
      onAbort = () => finish(aborted());
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { finish(aborted()); return; }
      timer = setTimeout(() => finish(new BrowserScopeError('BROWSER_SCOPE_TIMEOUT', operation,
        options.mutating ? '浏览器响应超时，操作结果未确认；请先观察现状，勿直接重试。' : '浏览器读取超时，请核对窗口状态后重试。',
        { ...details, outcomeUncertain: options.mutating })), options.timeoutMs ?? 5000);
      try {
        dispatched = true;
        Promise.resolve(work()).then(value => finish(undefined, value), error => finish(error ?? new Error('浏览器拒绝了操作，但没有提供原因')));
      } catch (error) { finish(error ?? new Error('浏览器操作同步失败，但没有提供原因')); }
    });
  } catch (error) {
    if (error instanceof BrowserScopeError) throw error;
    throw new BrowserScopeError('BROWSER_SCOPE_API_FAILED', operation, browserErrorText(error),
      { ...details, cause: error, outcomeUncertain: dispatched && options.mutating });
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

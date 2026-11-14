/** Stop waiting immediately, while still observing late rejection of the underlying operation. */
export function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Operation cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}

export async function withTimeBudget<T>(ms: number, operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  parent?.throwIfAborted();
  if (!Number.isFinite(ms) || ms > 2_147_483_647) throw new RangeError('Invalid operation time budget');
  if (ms <= 0) throw new DOMException('Operation exceeded its time budget', 'TimeoutError');
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', cancel, { once: true });
  const timeout = new DOMException('Operation exceeded its time budget', 'TimeoutError');
  const timer = setTimeout(() => controller.abort(timeout), Math.max(0, ms));
  try { return await abortable(operation(controller.signal), controller.signal); }
  finally { clearTimeout(timer); parent?.removeEventListener('abort', cancel); }
}

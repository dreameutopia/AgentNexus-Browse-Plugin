/** Cross-context locks in browsers; keyed, cancellation-aware queues in other runtimes. */
const tails = new Map<string, Promise<unknown>>();

export async function withNamedLock<T>(
  name: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const run = () => { signal?.throwIfAborted(); return operation(); };
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(name, { ...(signal ? { signal } : {}) }, run);
  }
  const pending = (tails.get(name) ?? Promise.resolve()).catch(() => undefined).then(run);
  tails.set(name, pending);
  const cleanup = () => { if (tails.get(name) === pending) tails.delete(name); };
  void pending.then(cleanup, cleanup);
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Operation cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

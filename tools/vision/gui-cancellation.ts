/** Background-only cancellation registry; IDs travel outside public tool parameters. */
const active = new Map<string, AbortController>();
const early = new Map<string, number>();
export function cancelGuiRequest(id: unknown): void {
  if (typeof id !== 'string' || !id || id.length > 128) return;
  const controller = active.get(id);
  if (controller) controller.abort();
  else {
    early.set(id, Date.now());
    if (early.size > 128) early.delete(early.keys().next().value!);
  }
}
export async function withGuiCancellation<T>(id: string | undefined, work: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!id) return work(signal);
  if (active.has(id)) throw new Error('Duplicate GUI request ID');
  const controller = new AbortController(); active.set(id, controller);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const cancelledAt = early.get(id); early.delete(id);
  if (signal?.aborted || cancelledAt !== undefined && Date.now() - cancelledAt < 60000) controller.abort();
  try { return await work(controller.signal); }
  finally { active.delete(id); signal?.removeEventListener('abort', cancel); }
}

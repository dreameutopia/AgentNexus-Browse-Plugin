/** Shared by the tool and engine timeout policy; seconds are never unbounded. */
export const GENERIC_WAIT_TOOL_ID = 'generic_wait';
export const MAX_WAIT_SECONDS = 10 * 60;
export function normalizeWaitSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('waitSeconds 必须是大于等于 0 的有限数字（秒）');
  return Math.min(value, MAX_WAIT_SECONDS);
}
export function waitExecutionTimeout(args: unknown, defaultTimeoutMs: number): number {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return defaultTimeoutMs;
  try { return Math.max(defaultTimeoutMs, normalizeWaitSeconds((args as { waitSeconds?: unknown }).waitSeconds) * 1000 + 5000); }
  catch { return defaultTimeoutMs; }
}

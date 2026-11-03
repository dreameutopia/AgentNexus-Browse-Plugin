import type { ToolResult } from '@/common/tool-handler';

export type GuiErrorCode = 'INVALID_ARGUMENT' | 'UNSUPPORTED_CONTEXT' | 'TARGET_UNAVAILABLE' |
  'STALE_SCREENSHOT' | 'TARGET_CHANGED' | 'GEOMETRY_CHANGED' | 'INVALID_SCREENSHOT' | 'FOCUS_CHANGED' |
  'TIMEOUT' | 'CANCELLED' | 'TRANSPORT_ERROR' | 'ANNOTATION_ERROR' | 'CLEANUP_FAILED' | 'INTERNAL_ERROR';

export class GuiError extends Error {
  constructor(public readonly code: GuiErrorCode, message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly recovery = 'Capture a fresh screenshot, inspect the current state, and decide whether to continue.') {
    super(message); this.name = 'GuiError';
  }
}

/** A failed dispatch can have side effects. Never label an interaction safe to retry. */
export function guiFailure(error: unknown, context: Record<string, unknown> = {}): ToolResult {
  const known = error instanceof GuiError;
  const code = known ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic = { code, message, ...context, details: known ? error.details : {},
    recovery: known ? error.recovery : 'Inspect the latest screenshot before continuing.', retryAutomatically: false };
  return { success: false, isError: true, error: `[${code}] ${message}`, data: { diagnostic },
    content: [{ type: 'text', text: JSON.stringify(diagnostic) }] };
}

/** Bound waiting without allowing a timed-out command to be followed by more input. */
export async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GuiError('TIMEOUT', `${label} timed out after ${timeoutMs}ms`,
        { operation: label, outcomeUncertain: true })), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Run cleanup on success/failure without unreachable post-finally checks or masked root causes. */
export async function withGuiCleanup<T>(work: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try { outcome = { ok: true, value: await work() }; }
  catch (error) { outcome = { ok: false, error }; }
  try { await cleanup(); }
  catch (error) {
    const failure = error instanceof GuiError ? error : new GuiError('CLEANUP_FAILED', String(error));
    const primary = !outcome.ok ? outcome.error : undefined;
    throw new GuiError('CLEANUP_FAILED', failure.message, { ...failure.details,
      primaryFailure: primary instanceof Error ? { message: primary.message, ...(primary instanceof GuiError ? { code: primary.code, details: primary.details } : {}) } : primary,
      outcomeUncertain: true }, failure.recovery);
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

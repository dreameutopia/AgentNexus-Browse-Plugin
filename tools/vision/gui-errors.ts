import type { ToolResult } from '@/common/tool-handler';

export type GuiErrorCode = 'INVALID_ARGUMENT' | 'UNSUPPORTED_CONTEXT' | 'TARGET_UNAVAILABLE' |
  'STALE_SCREENSHOT' | 'TARGET_CHANGED' | 'GEOMETRY_CHANGED' | 'INVALID_SCREENSHOT' | 'FOCUS_CHANGED' |
  'TIMEOUT' | 'CANCELLED' | 'TRANSPORT_ERROR' | 'ANNOTATION_ERROR' | 'CLEANUP_FAILED' | 'INTERNAL_ERROR';

export const DEFAULT_GUI_RECOVERY =
  'Capture a fresh screenshot, inspect the current state, and decide whether to continue.';

/** 参数类失败的统一修复提示——多数 INVALID_ARGUMENT 都在"少字段/多字段/值域不对"之间。 */
export const DEFAULT_ARGUMENT_HINT =
  'Fix the rejected field and call the tool again with only the fields listed for that action.';

export class GuiError extends Error {
  constructor(public readonly code: GuiErrorCode, message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly recovery = DEFAULT_GUI_RECOVERY,
    /** 一句话修复指引：告诉调用方下一次调用应该怎么改。 */
    public readonly hint?: string) {
    super(message); this.name = 'GuiError';
  }
}

/** 把可读的诊断细节压进消息本身——模型常常只看得到 error 字符串，
 *  关键信息（允许字段、失败位置）必须在这一行里出现，否则模型无法自我纠正。 */
function summarizeDetails(details: Record<string, unknown>): string {
  const parts: string[] = [];
  const list = (value: unknown): string | undefined =>
    Array.isArray(value) && value.length
      ? value.filter(v => typeof v === 'string' || typeof v === 'number').join(', ')
      : undefined;
  const allowed = list(details.allowedFields);
  if (allowed) parts.push(`allowed fields: ${allowed}`);
  const fields = list(details.fields);
  if (fields) parts.push(`rejected fields: ${fields}`);
  if (typeof details.argIndex === 'number') parts.push(`arg index: ${details.argIndex}`);
  if (typeof details.argPath === 'string') parts.push(`at ${details.argPath}`);
  if (typeof details.operation === 'string') parts.push(`operation: ${details.operation}`);
  if (typeof details.reason === 'string') parts.push(`reason: ${details.reason}`);
  return parts.length ? ` (${parts.join('; ')})` : '';
}

/** A failed dispatch can have side effects. Never label an interaction safe to retry. */
export function guiFailure(error: unknown, context: Record<string, unknown> = {}): ToolResult {
  const known = error instanceof GuiError;
  const code = known ? error.code : 'INTERNAL_ERROR';
  const base = error instanceof Error ? error.message : String(error);
  const details = known ? error.details : {};
  const hint = known
    ? error.hint
    : 'The tool failed in an unexpected way; capture a fresh screenshot before retrying.';
  const recovery = known ? error.recovery : 'Inspect the latest screenshot before continuing.';
  // 摘要并入消息：只看得到 error 字符串时，诊断信息依然完整。
  const message = `${base}${summarizeDetails(details)}${hint ? ` Fix: ${hint}` : ''}`;
  const diagnostic = { code, message, ...context, details,
    hint, recovery, retryAutomatically: false, retryable: false };
  return { success: false, isError: true, error: `[${code}] ${message}`, data: { diagnostic },
    content: [{ type: 'text', text: JSON.stringify(diagnostic) }],
    // 诊断只在 data 里一份（content 是它的 JSON 副本）——正题在 data
    primary: 'data' };
}

/** Bound waiting without allowing a timed-out command to be followed by more input. */
export async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GuiError('TIMEOUT', `${label} timed out after ${timeoutMs}ms`,
        { operation: label, outcomeUncertain: true },
        DEFAULT_GUI_RECOVERY,
        'Wait for the page to settle, then capture a fresh screenshot and retry once.')), timeoutMs);
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
      outcomeUncertain: true }, failure.recovery, failure.hint);
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

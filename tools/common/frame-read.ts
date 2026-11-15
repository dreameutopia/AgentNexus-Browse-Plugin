/** Read-only frame collection. Never replay actions or arbitrary page scripts here.
 * Discovery uses both APIs: webNavigation can omit initial about:blank documents.
 * Payloads run separately so a stalled renderer cannot withhold other results.
 */
import {
  classifyInjectionError,
  injectionErrorText,
  normalizeInjectionArgs,
} from "./script-injection";

export interface FrameIssue {
  frameId?: number;
  documentId?: string;
  url?: string;
  stage: "discovery" | "read" | "validation" | "focus";
  code: string;
  message: string;
  /** Coverage/element failures retain usable data from the enclosing frame. */
  scope?: 'frame' | 'coverage' | 'element';
  elementIds?: string[];
}
export interface FrameReadReport {
  operation: string;
  status: "complete" | "partial" | "failed";
  /** Complete only within discovered documents, not unrendered/closed shadow content. */
  discoveryComplete: boolean;
  elapsedMs: number;
  successfulFrameIds: number[];
  issues: FrameIssue[];
  documents?: Array<{ frameId: number; documentId?: string }>;
}
export type FrameResults<T> = chrome.scripting.InjectionResult<T>[] & {
  frameDiagnostics: FrameReadReport;
};
/** Persisted reports are untrusted JSON; a matching body hash alone is not schema validation. */
export function isFrameReadReport(value: unknown): value is FrameReadReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as FrameReadReport;
  return typeof r.operation === 'string' && ['complete', 'partial', 'failed'].includes(r.status) &&
    typeof r.discoveryComplete === 'boolean' && Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0 &&
    Array.isArray(r.successfulFrameIds) && r.successfulFrameIds.every(id => Number.isSafeInteger(id) && id >= 0) &&
    Array.isArray(r.issues) && r.issues.every(i => i && typeof i === 'object' && typeof i.code === 'string' && typeof i.message === 'string' &&
      ['discovery', 'read', 'validation', 'focus'].includes(i.stage) &&
      (i.frameId === undefined || (Number.isSafeInteger(i.frameId) && i.frameId >= 0)) &&
      (i.documentId === undefined || typeof i.documentId === 'string') &&
      (i.url === undefined || typeof i.url === 'string') &&
      (i.elementIds === undefined || (Array.isArray(i.elementIds) && i.elementIds.every(id => typeof id === 'string'))) &&
      (i.scope === undefined || ['frame', 'coverage', 'element'].includes(i.scope))) &&
    (r.documents === undefined || (Array.isArray(r.documents) && r.documents.every(d => d &&
      Number.isSafeInteger(d.frameId) && d.frameId >= 0 &&
      (d.documentId === undefined || typeof d.documentId === 'string'))));
}
type Request<T> = {
  target: chrome.scripting.InjectionTarget;
  func?: (...args: any[]) => T | Promise<T>;
  files?: string[];
  injectImmediately?: boolean;
  args?: any[];
  world?: chrome.scripting.ExecutionWorld | "ISOLATED" | "MAIN";
};
type FrameTarget = { frameId?: number; documentId?: string; url?: string };

export class BrowserWaitError extends Error {
  constructor(readonly code: 'INJECTION_TIMEOUT' | 'ABORTED' | 'INVALID_ARGUMENT', message: string) {
    super(`${code}: ${message}`);
    this.name = 'BrowserWaitError';
  }
}

function positiveNumber(value: number, name: string, integer = false): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647 || (integer && !Number.isSafeInteger(value))) {
    throw new BrowserWaitError('INVALID_ARGUMENT', `${name} must be a finite positive ${integer ? 'integer' : 'number'} within the timer range`);
  }
  return value;
}

function validateRequest<T>(request: Request<T>, readOnly = false): void {
  if (!request || !request.target || !Number.isSafeInteger(request.target.tabId) || request.target.tabId < 0) {
    throw new BrowserWaitError('INVALID_ARGUMENT', 'A non-negative integer tabId is required');
  }
  const { frameIds, documentIds, allFrames } = request.target;
  if (allFrames !== undefined && typeof allFrames !== 'boolean') throw new BrowserWaitError('INVALID_ARGUMENT', 'allFrames must be a boolean');
  if (request.world !== undefined && request.world !== 'MAIN' && request.world !== 'ISOLATED') throw new BrowserWaitError('INVALID_ARGUMENT', 'Unsupported execution world');
  if ((allFrames && (frameIds !== undefined || documentIds !== undefined)) || (frameIds !== undefined && documentIds !== undefined)) {
    throw new BrowserWaitError('INVALID_ARGUMENT', 'allFrames, frameIds and documentIds are mutually exclusive');
  }
  if (frameIds !== undefined && (!Array.isArray(frameIds) || !frameIds.length || frameIds.some(id => !Number.isSafeInteger(id) || id < 0))) {
    throw new BrowserWaitError('INVALID_ARGUMENT', 'frameIds must be a non-empty array of non-negative integers');
  }
  if (documentIds !== undefined && (!Array.isArray(documentIds) || !documentIds.length || documentIds.some(id => typeof id !== 'string' || !id.trim()))) {
    throw new BrowserWaitError('INVALID_ARGUMENT', 'documentIds must be a non-empty array of document identities');
  }
  const hasFunction = typeof request.func === 'function';
  const hasFiles = Array.isArray(request.files) && request.files.length > 0 && request.files.every(file => typeof file === 'string' && !!file);
  if (hasFunction === hasFiles || (readOnly && !hasFunction) || (request.files !== undefined && request.func !== undefined) || (request.files !== undefined && request.args !== undefined)) {
    throw new BrowserWaitError('INVALID_ARGUMENT', readOnly ? 'Frame reads require a function and do not accept files' : 'Specify exactly one of func or files; args require func');
  }
  if (request.args !== undefined && !Array.isArray(request.args)) throw new BrowserWaitError('INVALID_ARGUMENT', 'args must be an array');
}
export class PageReadError extends Error {
  constructor(public readonly frameDiagnostics: FrameReadReport) {
    super(
      frameDiagnostics.issues
        .map(
          (i) =>
            `${i.code}${i.frameId !== undefined ? ` frame=${i.frameId}` : ""}: ${i.message}`,
        )
        .join("; ") || "NO_RESULT: No frame returned data",
    );
    this.name = "PageReadError";
  }
}

/** Only bounds the wait; Chrome cannot cancel an already dispatched injection. */
export async function withDeadline<T>(
  work: () => Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  positiveNumber(ms, 'timeoutMs');
  const deadline = performance.now() + ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw new BrowserWaitError('ABORTED', `${label}; not dispatched`);
        if (performance.now() >= deadline) throw new BrowserWaitError('INJECTION_TIMEOUT', `${label}; budget expired before dispatch`);
        return work();
      }),
      new Promise<never>((_, reject) => {
        abort = () => reject(new BrowserWaitError('ABORTED', `${label}; waiting cancelled; dispatched code may still run`));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        timer = setTimeout(
          () =>
            reject(
              new BrowserWaitError('INJECTION_TIMEOUT',
                `${label}; wait exceeded ${Math.ceil(ms)}ms; dispatched code may still run`,
              ),
            ),
          Math.max(1, ms),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

/** One dispatch, bounded including scheduling. No discovery, fallback or retry.
 * Also usable for actions: a timeout must never be interpreted as not dispatched.
 */
export function executeScriptBounded<T = unknown>(
  request: Request<T>,
  timeoutMs = 8000,
  signal?: AbortSignal,
): Promise<chrome.scripting.InjectionResult<Awaited<T>>[]> {
  validateRequest(request);
  positiveNumber(timeoutMs, 'timeoutMs');
  const args = normalizeInjectionArgs(request.args ?? []);
  return withDeadline(
    () =>
      chrome.scripting.executeScript({
        ...request,
        ...(request.args !== undefined ? { args } : {}),
        injectImmediately: request.injectImmediately ?? true,
      } as any),
    timeoutMs,
    "executeScript",
    signal,
  ) as Promise<chrome.scripting.InjectionResult<Awaited<T>>[]>;
}

function issue(
  error: unknown,
  stage: FrameIssue["stage"],
  frame?: FrameTarget,
): FrameIssue {
  const raw = injectionErrorText(error);
  let classifiedCode = 'INJECTION_FAILED';
  try { classifiedCode = error instanceof BrowserWaitError ? error.code : classifyInjectionError(error).code; }
  catch { /* Unknown/proxy exceptions still produce a readable bounded record. */ }
  const code = /ABORTED/.test(raw) ? 'ABORTED' : /INVALID_ARGUMENT/.test(raw) ? 'INVALID_ARGUMENT' : /INJECTION_TIMEOUT/.test(raw)
    ? "INJECTION_TIMEOUT"
    : /INVALID_RESULT/.test(raw) ? 'INVALID_RESULT' : /NO_RESULT/.test(raw)
      ? "NO_RESULT"
      : /PAYLOAD_EXCEPTION/.test(raw)
        ? "PAYLOAD_EXCEPTION"
        : /FRAME_CHANGED|No frame with id|No document with id|frame.*removed|navigat|context.*destroy/i.test(
              raw,
            )
          ? "FRAME_CHANGED"
          : classifiedCode;
  return { ...frame, stage, code, message: raw.slice(0, 500) };
}

function safeUrl(url?: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "data:"
      ? "data:"
      : u.origin === "null"
        ? u.protocol + u.pathname.slice(0, 120)
        : u.origin + u.pathname;
  } catch {
    return url.split(/[?#]/)[0].slice(0, 200);
  }
}

export function addFrameIssue(
  report: FrameReadReport,
  detail: FrameIssue,
): void {
  report.issues.push(detail);
  if (detail.frameId !== undefined && (detail.scope ?? 'frame') === 'frame') {
    report.successfulFrameIds = report.successfulFrameIds.filter(
      (id) => id !== detail.frameId,
    );
  }
  report.status = report.successfulFrameIds.length ? "partial" : "failed";
  // Log metadata only, never page text, input values, or URL query strings.
  try { console.warn("[frame-read]", {
    operation: report.operation,
    ...detail,
    url: safeUrl(detail.url),
    message: detail.message.replace(/https?:\/\/[^\s"'<>]+/g, value => safeUrl(value) ?? ''),
  }); } catch { /* Diagnostics must not turn a partial success into failure. */ }
}

export async function readPageFrames<T>(
  request: Request<T>,
  options: {
    stage?: FrameIssue["stage"];
    operation?: string;
    timeoutMs?: number;
    frameTimeoutMs?: number;
    discoveryTimeoutMs?: number;
    maxFrames?: number;
    concurrency?: number;
    signal?: AbortSignal;
    /** Stop dispatching more frames once retained content reaches this budget.
     * Already-dispatched reads may finish; concurrency bounds the overshoot. */
    maxResultChars?: number;
    measureResult?: (value: Awaited<T>) => number;
  } = {},
): Promise<FrameResults<Awaited<T>>> {
  const started = performance.now();
  const deadline = started + (options.timeoutMs ?? 12000);
  const report: FrameReadReport = {
    operation: options.operation ?? request?.func?.name ?? "page-read",
    status: "complete",
    discoveryComplete: true,
    elapsedMs: 0,
    successfulFrameIds: [],
    issues: [],
  };
  const results = [] as unknown as FrameResults<Awaited<T>>;
  results.frameDiagnostics = report;
  let args: unknown[];
  try {
    validateRequest(request, true);
    positiveNumber(options.timeoutMs ?? 12000, 'timeoutMs');
    positiveNumber(options.frameTimeoutMs ?? 3500, 'frameTimeoutMs');
    positiveNumber(options.discoveryTimeoutMs ?? 1200, 'discoveryTimeoutMs');
    positiveNumber(options.maxFrames ?? 128, 'maxFrames', true);
    positiveNumber(options.concurrency ?? 4, 'concurrency', true);
    if (options.maxResultChars !== undefined) {
      positiveNumber(options.maxResultChars, 'maxResultChars', true);
      if (typeof options.measureResult !== 'function') throw new BrowserWaitError('INVALID_ARGUMENT', 'maxResultChars requires measureResult');
    }
    args = normalizeInjectionArgs(request.args ?? []);
  } catch (error) {
    addFrameIssue(report, issue(error, options.stage ?? 'read'));
    report.elapsedMs = Math.round(performance.now() - started);
    throw new PageReadError(report);
  }
  if (options.signal?.aborted) {
    addFrameIssue(report, {
      stage: options.stage ?? "read",
      code: "ABORTED",
      message: "Collection cancelled before dispatch",
    });
    throw new PageReadError(report);
  }
  const frames = new Map<number, FrameTarget & { frameId: number }>();
  const tabId = request.target.tabId;
  if (request.target.allFrames) {
    const budget = Math.min(
      options.discoveryTimeoutMs ?? 1200,
      Math.max(1, deadline - performance.now()),
    );
    const discovery = await Promise.allSettled([
      withDeadline(
        () => chrome.webNavigation.getAllFrames({ tabId }),
        budget,
        "frame enumeration",
        options.signal,
      ),
      withDeadline(
        () =>
          chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: "ISOLATED",
            injectImmediately: true,
            func: () => ({ url: document.URL }),
            args: [],
          }),
        budget,
        "frame discovery",
        options.signal,
      ),
    ]);
    const navigation = discovery[0];
    if (navigation.status === "fulfilled" && Array.isArray(navigation.value)) {
      for (const f of navigation.value) {
        if (!f || !Number.isSafeInteger(f.frameId) || f.frameId < 0) {
          report.discoveryComplete = false;
          addFrameIssue(report, { stage: 'discovery', code: 'INVALID_RESULT', message: 'Navigation enumeration returned a malformed frame', scope: 'coverage' });
          continue;
        }
        frames.set(f.frameId, {
          frameId: f.frameId,
          documentId: f.documentId,
          url: safeUrl(f.url),
        });
      }
    }
    const probe = discovery[1];
    if (probe.status === "fulfilled" && Array.isArray(probe.value)) {
      for (const f of probe.value) {
        if (!f || !Number.isSafeInteger(f.frameId) || f.frameId < 0) {
          report.discoveryComplete = false;
          addFrameIssue(report, { stage: 'discovery', code: 'INVALID_RESULT', message: 'Injection discovery returned a malformed frame', scope: 'coverage' });
          continue;
        }
        const probeError = (f as { error?: unknown }).error;
        if (probeError !== undefined || f.result === undefined) {
          report.discoveryComplete = false;
          addFrameIssue(report, { ...issue(probeError ?? 'NO_RESULT: discovery returned no value', 'discovery', { frameId: f.frameId, documentId: f.documentId }), scope: 'coverage' });
        }
        frames.set(f.frameId, {
          frameId: f.frameId,
          documentId: f.documentId,
          url: safeUrl(f.result?.url) ?? frames.get(f.frameId)?.url,
        });
      }
    }
    for (const [index, result] of discovery.entries()) {
      if (
        result.status === "rejected" ||
        (result.status === "fulfilled" && (!Array.isArray(result.value) || !result.value.length))
      ) {
        report.discoveryComplete = false;
        addFrameIssue(
          report,
          issue(
            result.status === "rejected"
              ? result.reason
              : `NO_RESULT: ${index === 0 ? 'navigation enumeration' : 'injection discovery'} returned no documents`,
            "discovery",
          ),
        );
      }
    }
    // Always attempt the main document even when discovery is unavailable.
    if (!frames.has(0)) frames.set(0, { frameId: 0 });
  } else {
    for (const frameId of request.target.documentIds ? [] : request.target.frameIds ?? [0])
      frames.set(frameId, { frameId });
  }
  const targets: FrameTarget[] = request.target.documentIds
    ? [...new Set(request.target.documentIds)].map(documentId => ({ documentId }))
    : [...frames.values()].sort((a, b) => a.frameId - b.frameId);
  const maxFrames = options.maxFrames ?? 128;
  for (const frame of targets.slice(maxFrames))
    addFrameIssue(report, {
      ...frame,
      stage: options.stage ?? "read",
      code: "FRAME_LIMIT",
      message: `Frame limit ${maxFrames} reached; document not dispatched`,
    });
  const work = targets.slice(0, maxFrames);
  let next = 0;
  let retainedChars = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency ?? 4, work.length) },
      async () => {
        while (next < work.length) {
          const frame = work[next++];
          if (options.signal?.aborted || performance.now() >= deadline || retainedChars >= (options.maxResultChars ?? Infinity)) {
            addFrameIssue(report, {
              ...frame,
              stage: options.stage ?? "read",
              code: options.signal?.aborted
                ? "ABORTED"
                : retainedChars >= (options.maxResultChars ?? Infinity) ? 'RESULT_BUDGET_EXCEEDED' : "READ_BUDGET_EXCEEDED",
              message: "Document not dispatched; cancellation, time, or retained-content budget ended",
            });
            continue;
          }
          try {
            // Pin a discovered document so a frame navigation cannot silently substitute content.
            const rows = await executeScriptBounded(
              {
                ...request,
                args,
                target: {
                  tabId,
                  ...(frame.documentId
                    ? { documentIds: [frame.documentId] }
                    : { frameIds: [frame.frameId!] }),
                },
                injectImmediately: true,
              },
              Math.max(1, Math.min(options.frameTimeoutMs ?? 3500, deadline - performance.now())),
              options.signal,
            );
            if (!Array.isArray(rows)) throw new Error('INVALID_RESULT: injection did not return a frame array');
            const matching = rows.filter((r) => r && (frame.frameId !== undefined ? r.frameId === frame.frameId : r.documentId === frame.documentId));
            if (matching.length > 1) throw new Error('INVALID_RESULT: multiple result rows for one requested document');
            const row = matching[0];
            const error = (row as { error?: unknown } | undefined)?.error;
            if (error !== undefined)
              throw new Error(`PAYLOAD_EXCEPTION: ${injectionErrorText(error)}`);
            if (!row || row.result === undefined)
              throw new Error("NO_RESULT: document returned no value");
            if (!Number.isSafeInteger(row.frameId) || row.frameId < 0) throw new Error('INVALID_RESULT: result has no valid frame identity');
            if (
              frame.documentId &&
              row.documentId &&
              frame.documentId !== row.documentId
            )
              throw new Error("FRAME_CHANGED: document identity changed");
            if (options.signal?.aborted) throw new BrowserWaitError('ABORTED', 'Collection cancelled before result acceptance; dispatched code may still run');
            if (options.measureResult) {
              const chars = options.measureResult(row.result);
              if (!Number.isFinite(chars) || chars < 0) throw new Error('INVALID_RESULT: measureResult returned an invalid content size');
              retainedChars += chars;
            }
            results.push(row);
            report.successfulFrameIds.push(row.frameId);
          } catch (error) {
            addFrameIssue(report, issue(error, options.stage ?? "read", frame));
          }
        }
      },
    ),
  );
  results.sort((a, b) => a.frameId - b.frameId);
  report.successfulFrameIds.sort((a, b) => a - b);
  report.documents = results.map(row => ({ frameId: row.frameId, ...(row.documentId ? { documentId: row.documentId } : {}) }));
  report.elapsedMs = Math.round(performance.now() - started);
  report.status = !results.length
    ? "failed"
    : report.issues.length
      ? "partial"
      : "complete";
  if (!results.length) throw new PageReadError(report);
  return results;
}

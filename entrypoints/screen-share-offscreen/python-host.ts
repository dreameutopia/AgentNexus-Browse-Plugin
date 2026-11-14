import { PY_ERR_TIMEOUT, PY_ERR_WORKSPACE, PY_ERR_WORKSPACE_RUNTIME } from '@/utils/pyodide/pyodide-runtime';
import { PYTHON_RUN_MAX_TIMEOUT_MS } from '@/utils/pyodide/pyodide-config';
import {
  isMicropipPackage, isPythonHostResult, PYTHON_HOST_CANCEL, PYTHON_HOST_RESET, PYTHON_HOST_RUN,
  PYTHON_HOST_ENV_STATUS,
  type PythonHostPolicyResult, type PythonHostResult, type PythonHostRun, type PythonWorkerResult, type PythonWorkerRun,
} from '@/utils/pyodide/python-host-protocol';
import { chatDatabase } from '../sidepanel/core/context/chat-database';
import { workspaceOutputPaths, type WorkspaceSnapshot } from '@/utils/python-workspace/paths';
import { saveWorkspace, withWorkspaceLock } from '@/utils/python-workspace/store';
import PythonWorker from './python-worker?worker';
import { parsePythonScriptRequest } from '@/utils/pyodide/python-script-request';
import { withPyodideEnvLock } from '@/utils/pyodide/pyodide-env';
import { errorDetails } from '@/utils/shared/error-details';

const MAX_JOBS = 16;
const WORKER_IDLE_MS = 60_000;
const CANCELLED = '[PY_EXEC_CANCELLED] Python execution was cancelled';
let worker: Worker | undefined;
let workerChatId: string | undefined;
let workerEnvironmentId: string | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();
const jobs = new Map<string, { controller: AbortController; environmentId: string }>();
// Cancellation can arrive before the run message on a separate runtime channel.
const cancelled = new Map<string, number>();
const ENV_CHANGED = '[PY_ENV_NOT_READY] Python environment changed. Start a new run after installation.';

/**
 * 环境活性校验：宿主（offscreen）没有 storage 访问权，经后台应答确认
 * environmentId 仍是当前环境且状态就绪，并顺带取回复用清单（网络已放开，
 * 所有运行统一恢复）。授权语义不存在——技能授权只在 skill_tool 复制环节。
 */
async function assertCurrentPolicy(request: PythonHostRun, signal: AbortSignal): Promise<PythonHostPolicyResult> {
  let result: PythonHostPolicyResult | undefined;
  try {
    result = await chrome.runtime.sendMessage({
      type: PYTHON_HOST_ENV_STATUS,
      environmentId: request.state.environmentId,
    });
  } catch {
    throw new Error('[PY_CONTEXT_NOT_SUPPORTED] Could not verify the Python environment');
  }
  signal.throwIfAborted();
  if (result?.allowed !== true) throw new Error(ENV_CHANGED);
  return result;
}

function releaseWorker(): void {
  worker?.terminate();
  worker = undefined;
  workerChatId = undefined;
  workerEnvironmentId = undefined;
  clearTimeout(idleTimer);
}

function errorText(error: unknown): string {
  return errorDetails(error, 8000);
}

/**
 * 运行请求的具名校验：任何一条不满足都以 [PY_INVALID_REQUEST] + 具体原因
 * 应答（替代过去不可诊断的整块拒绝，契约偏斜时一眼定位到字段）。
 */
function invalidRequestReason(message: unknown): string | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return 'request must be an object';
  const request = message as Partial<PythonHostRun> & Record<string, unknown>;
  if (typeof request.id !== 'string' || !request.id || request.id.length > 128) {
    return 'id must be a nonempty string of at most 128 characters';
  }
  if (jobs.has(request.id)) return 'duplicate request id';
  if (typeof request.chatId !== 'string' || !request.chatId || request.chatId.length > 255) {
    return 'chatId must be a nonempty string of at most 255 characters (all runs are workspace-bound)';
  }
  if (Object.keys(request).some(key => !['type', 'id', 'chatId', 'script', 'scriptDependencyApproved', 'timeoutMs', 'state'].includes(key))) return 'request contains unknown fields';
  if (request.scriptDependencyApproved !== undefined && request.scriptDependencyApproved !== true) return 'scriptDependencyApproved must be true when present';
  if (!request.script || typeof request.script !== 'object' || Array.isArray(request.script)) {
    return 'script is required';
  }
  const state = request.state as PythonHostRun['state'] | undefined;
  if (state?.status !== 'ready') return 'state.status must be "ready"';
  if (!Array.isArray(state.packages)) return 'state.packages must be an array';
  if (typeof state.environmentId !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(state.environmentId)) {
    return 'state.environmentId is missing or malformed';
  }
  if (!state.packages.every(pkg => typeof pkg?.name === 'string' && pkg.name.length <= 128)) {
    return 'state.packages entries are malformed';
  }
  const timeoutMs = request.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 1_000 ||
      timeoutMs > PYTHON_RUN_MAX_TIMEOUT_MS) {
    return `timeoutMs must be a finite number between 1000 and ${PYTHON_RUN_MAX_TIMEOUT_MS}`;
  }
  return undefined;
}

function dispatch(input: PythonWorkerRun, signal: AbortSignal): Promise<PythonWorkerResult> {
  signal.throwIfAborted();
  clearTimeout(idleTimer);
  // 温复用：同一会话 + 同一环境共享 Worker（解释器级状态跨运行残留与历史
  // 内联行为一致；工作区 MEMFS 每次运行独立挂载不受影响）。仅在会话/环境
  // 切换或运行时被判定损坏时回收。
  if (worker && (workerChatId !== input.chatId || workerEnvironmentId !== input.state.environmentId)) {
    releaseWorker();
  }
  const target = worker ??= new PythonWorker();
  workerChatId = input.chatId;
  workerEnvironmentId = input.state.environmentId;

  return new Promise<PythonWorkerResult>((resolve, reject) => {
    const channel = new MessageChannel();
    const cleanup = (terminate: boolean) => {
      signal.removeEventListener('abort', abort);
      target.onerror = null;
      target.onmessageerror = null;
      channel.port1.close();
      if (terminate) releaseWorker();
      else idleTimer = setTimeout(releaseWorker, WORKER_IDLE_MS);
    };
    const fail = (error: unknown) => {
      cleanup(true);
      reject(error);
    };
    const abort = () => fail(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    channel.port1.onmessage = (event: MessageEvent<PythonWorkerResult>) => {
      const result = event.data;
      if (!isPythonHostResult(result)) {
        fail(new Error('Python worker returned an invalid response'));
        return;
      }
      // 工作区运行时损坏（挂载/清理失败）必须整机回收，防脏状态污染后续运行
      cleanup('error' in result && result.error.startsWith(`[${PY_ERR_WORKSPACE_RUNTIME}]`));
      resolve(result);
    };
    target.onerror = event => {
      event.preventDefault();
      fail(new Error(event.message || 'Python worker crashed'));
    };
    channel.port1.onmessageerror = target.onmessageerror = () => fail(new Error('Could not decode Python worker data'));
    try { target.postMessage(input, [channel.port2]); }
    catch (error) {
      channel.port2.close();
      fail(error);
    }
  });
}

async function run(request: PythonHostRun, signal: AbortSignal): Promise<PythonHostResult> {
  const { script, chatId, timeoutMs, state } = request;
  const input: PythonWorkerRun = { script, chatId, timeoutMs, state };
  const runAuthorized = async (snapshot?: WorkspaceSnapshot) => {
    const policy = await assertCurrentPolicy(request, signal);
    // 策略应答跨消息边界：清单逐条形态校验后再入 worker（畸形条目静默丢弃，
    // 绝不让坏数据进入恢复流程）
    const manifest = Array.isArray(policy.micropipManifest)
      ? policy.micropipManifest.filter(isMicropipPackage)
      : [];
    return dispatch({ ...input, snapshot, micropipManifest: manifest.length ? manifest : undefined }, signal);
  };
  try {
    return await withWorkspaceLock(chatId, async () => {
      const snapshot = await chatDatabase.readWorkspace(chatId, signal);
      const result = await runAuthorized(snapshot);
      if ('error' in result) {
        await assertCurrentPolicy(request, signal);
        return { error: result.error };
      }
      if (result.outcome.ok && !script.preflight) {
        const entries = result.entries;
        if (!Array.isArray(entries)) throw new Error('Python did not return a workspace snapshot');
        await withPyodideEnvLock(async () => {
          await assertCurrentPolicy(request, signal);
          await saveWorkspace(chatId, snapshot?.revision, entries, signal);
        }, signal);
        result.outcome.workspaceOutputs = workspaceOutputPaths(entries);
      } else {
        await assertCurrentPolicy(request, signal);
      }
      return { outcome: result.outcome };
    }, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    const message = errorText(error);
    return { error: /^\[PY_[A-Z_]+\]/.test(message) ? message : `[${PY_ERR_WORKSPACE}] ${message}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  if (message?.type === PYTHON_HOST_RESET) {
    if (typeof message.environmentId !== 'string') return false;
    for (const job of jobs.values()) {
      if (job.environmentId === message.environmentId) job.controller.abort(new Error(ENV_CHANGED));
    }
    if (workerEnvironmentId === message.environmentId) releaseWorker();
    respond(true);
    return false;
  }
  if (typeof message?.id !== 'string' || !message.id || message.id.length > 128) return false;
  if (message.type === PYTHON_HOST_CANCEL) {
    const job = jobs.get(message.id);
    if (job) job.controller.abort(new Error(CANCELLED));
    else {
      for (const [id, expires] of cancelled) if (expires <= Date.now()) cancelled.delete(id);
      if (cancelled.size >= 128) cancelled.delete(cancelled.keys().next().value!);
      cancelled.set(message.id, Date.now() + 60_000);
    }
    respond(true);
    return false;
  }
  if (message.type !== PYTHON_HOST_RUN) return false;
  const cancellationExpires = cancelled.get(message.id);
  cancelled.delete(message.id);
  if (cancellationExpires && cancellationExpires > Date.now()) { respond({ error: CANCELLED }); return false; }
  const reason = invalidRequestReason(message);
  if (reason) {
    respond({ error: `[PY_INVALID_REQUEST] ${reason}` });
    return false;
  }
  const request: PythonHostRun = { ...message };
  try {
    request.script = parsePythonScriptRequest(request.script);
  } catch (error) {
    respond({ error: '[PY_INVALID_SCRIPT] ' + errorText(error) });
    return false;
  }
  if (request.script.dependencyMode === 'pypi' && !request.script.preflight && request.scriptDependencyApproved !== true) {
    respond({ error: '[PY_DEPENDENCY_APPROVAL_REQUIRED] Public PyPI installation requires chat approval' });
    return false;
  }
  if (jobs.size >= MAX_JOBS) {
    respond({ error: '[PY_HOST_BUSY] Too many Python requests are pending. Retry after the current runs finish.' });
    return false;
  }
  const controller = new AbortController();
  jobs.set(request.id, { controller, environmentId: request.state.environmentId });
  let started = false;
  let replied = false;
  const reply = (result: PythonHostResult) => {
    if (replied) return;
    replied = true;
    try { respond(result); } catch { /* The calling context was closed. */ }
  };
  const timer = setTimeout(() => controller.abort(new Error(
    `[${PY_ERR_TIMEOUT}] Python request exceeded ${request.timeoutMs / 1000} seconds including queue and file operations`,
  )), request.timeoutMs);
  const signal = controller.signal;
  const abortPending = () => { if (!started) reply({ error: errorText(signal.reason) }); };
  signal.addEventListener('abort', abortPending, { once: true });
  queue = queue.then(async () => {
    started = true;
    try {
      signal.throwIfAborted();
      reply(await run(request, signal));
    } catch (error) {
      reply({ error: errorText(error) });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abortPending);
      jobs.delete(request.id);
    }
  });
  return true;
});

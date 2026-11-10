import { PY_ERR_TIMEOUT, PY_ERR_WORKSPACE, PY_ERR_WORKSPACE_RUNTIME } from '@/utils/pyodide/pyodide-runtime';
import { PYODIDE_MAX_CODE_LENGTH, PYTHON_RUN_MAX_TIMEOUT_MS } from '@/utils/pyodide/pyodide-config';
import {
  isPythonHostResult, PYTHON_HOST_CANCEL, PYTHON_HOST_RESET, PYTHON_HOST_RUN,
  PYTHON_HOST_SKILL_REVOKED, PYTHON_HOST_SKILL_STATUS,
  type PythonHostResult, type PythonHostRun, type PythonWorkerResult, type PythonWorkerRun,
} from '@/utils/pyodide/python-host-protocol';
import { chatDatabase } from '../sidepanel/core/context/chat-database';
import { workspaceOutputPaths } from '@/utils/python-workspace/paths';
import { saveWorkspace, withWorkspaceLock } from '@/utils/python-workspace/store';
import PythonWorker from './python-worker?worker';
import { parsePythonScriptRequest } from '@/utils/pyodide/python-script-request';
import { readMicropipManifest } from '@/utils/pyodide/pyodide-micropip';

const MAX_JOBS = 16;
const WORKER_IDLE_MS = 60_000;
const CANCELLED = '[PY_EXEC_CANCELLED] Python execution was cancelled';
let worker: Worker | undefined;
let workerChatId: string | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();
const jobs = new Map<string, AbortController>();
const scriptJobs = new Set<AbortController>();
const SCRIPT_DISABLED = '[PY_SKILL_SCRIPTS_DISABLED] Skill script support is disabled or the Python runtime is unavailable';
async function isSkillScriptSupportEnabled(): Promise<boolean> {
  try {
    return await chrome.runtime.sendMessage({ type: PYTHON_HOST_SKILL_STATUS }) === true;
  } catch {
    return false;
  }
}
/** 环境删除请求到达但仍有任务在途：全部收尾后立即回收 Worker（不等 60s 空闲） */
let resetPending = false;

function releaseWorker(): void {
  worker?.terminate();
  worker = undefined;
  workerChatId = undefined;
  resetPending = false;
  clearTimeout(idleTimer);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 8000);
}

function dispatch(input: PythonWorkerRun, signal: AbortSignal): Promise<PythonWorkerResult> {
  signal.throwIfAborted();
  clearTimeout(idleTimer);
  if (worker && (workerChatId !== input.chatId || input.script)) releaseWorker();
  const target = worker ??= new PythonWorker();
  workerChatId = input.chatId;

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
      cleanup(!!input.script || ('error' in result && result.error.startsWith(`[${PY_ERR_WORKSPACE_RUNTIME}]`)));
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
  const { code, script, chatId, timeoutMs, state } = request;
  // 读取 micropip 复用清单传给 worker（worker 无 chrome 访问权）。
  // 脚本模式不传：脚本有独立依赖通道（requirements/wheels/pypi 授权），且其 fetch 受限。
  // 读取永不抛错（失败回退空清单 = 本次不恢复，不阻断执行）。
  const micropipManifest = script ? undefined : await readMicropipManifest();
  const input: PythonWorkerRun = { code, script, chatId, timeoutMs, state, micropipManifest };
  if (chatId === undefined) {
    const result = await dispatch(input, signal);
    return 'error' in result ? { error: result.error } : { outcome: result.outcome };
  }
  try {
    return await withWorkspaceLock(chatId, async () => {
      if (script && !await isSkillScriptSupportEnabled()) return { error: SCRIPT_DISABLED };
      const snapshot = await chatDatabase.readWorkspace(chatId, signal);
      const result = await dispatch({ ...input, snapshot }, signal);
      if ('error' in result) return { error: result.error };
      if (result.outcome.ok && !script?.preflight) {
        if (script && !await isSkillScriptSupportEnabled()) return { error: SCRIPT_DISABLED };
        if (!Array.isArray(result.entries)) throw new Error('Python did not return a workspace snapshot');
        await saveWorkspace(chatId, snapshot?.revision, result.entries, signal);
        result.outcome.workspaceOutputs = workspaceOutputPaths(result.entries);
      }
      return { outcome: result.outcome };
    }, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return { error: `[${PY_ERR_WORKSPACE}] ${errorText(error)}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  // The management hub is an extension page and can itself be open in a tab.
  if (sender.tab && (message?.type !== PYTHON_HOST_RESET ||
      !sender.url?.startsWith(chrome.runtime.getURL('')))) return false;
  if (message?.type === PYTHON_HOST_SKILL_REVOKED) {
    for (const job of scriptJobs) job.abort(new Error(SCRIPT_DISABLED));
    respond(true);
    return false;
  }
  // 环境删除广播：立即回收空闲 Worker；有任务在途则等全部收尾后回收
  // （不打断在途执行——环境状态已回落 idle，新请求会在下方校验处被拒）
  if (message?.type === PYTHON_HOST_RESET) {
    if (jobs.size > 0) resetPending = true;
    else releaseWorker();
    respond(true);
    return false;
  }
  if (typeof message?.id !== 'string' || !message.id || message.id.length > 128) return false;
  if (message.type === PYTHON_HOST_CANCEL) {
    jobs.get(message.id)?.abort(new Error(CANCELLED));
    respond(true);
    return false;
  }
  if (message.type !== PYTHON_HOST_RUN) return false;
  const request: PythonHostRun = { ...message };
  if (jobs.has(request.id) || typeof request.code !== 'string' ||
      (request.script === undefined ? !request.code.trim() : !!request.code || !request.chatId) ||
      request.code.length > PYODIDE_MAX_CODE_LENGTH ||
      (request.chatId !== undefined && (typeof request.chatId !== 'string' || !request.chatId || request.chatId.length > 255)) ||
      request.state?.status !== 'ready' || !Array.isArray(request.state.packages) ||
      !request.state.packages.every(pkg => typeof pkg?.name === 'string' && pkg.name.length <= 128) ||
      !Number.isFinite(request.timeoutMs) || request.timeoutMs < 1_000 || request.timeoutMs > PYTHON_RUN_MAX_TIMEOUT_MS) {
    respond({ error: 'Invalid Python execution request' });
    return false;
  }
  if (request.script !== undefined) {
    try {
      request.script = parsePythonScriptRequest(request.script);
    } catch (error) {
      respond({ error: '[PY_INVALID_SCRIPT] ' + errorText(error) });
      return false;
    }
  }
  if (jobs.size >= MAX_JOBS) {
    respond({ error: '[PY_HOST_BUSY] Too many Python requests are pending. Retry after the current runs finish.' });
    return false;
  }
  const controller = new AbortController();
  jobs.set(request.id, controller);
  if (request.script) scriptJobs.add(controller);
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
      scriptJobs.delete(controller);
      // 环境删除在途：最后一个任务收尾后立即回收，不让旧包残留进入重装后的运行
      if (resetPending && jobs.size === 0) releaseWorker();
    }
  });
  return true;
});

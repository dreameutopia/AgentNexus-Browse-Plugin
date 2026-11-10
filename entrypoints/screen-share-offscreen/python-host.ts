import { PY_ERR_TIMEOUT, PY_ERR_WORKSPACE, PY_ERR_WORKSPACE_RUNTIME } from '@/utils/pyodide/pyodide-runtime';
import { PYODIDE_MAX_CODE_LENGTH, PYTHON_RUN_MAX_TIMEOUT_MS } from '@/utils/pyodide/pyodide-config';
import {
  isPythonHostResult, PYTHON_HOST_CANCEL, PYTHON_HOST_RUN,
  type PythonHostResult, type PythonHostRun, type PythonWorkerResult, type PythonWorkerRun,
} from '@/utils/pyodide/python-host-protocol';
import { chatDatabase } from '../sidepanel/core/context/chat-database';
import { workspaceOutputPaths } from '@/utils/python-workspace/paths';
import { saveWorkspace, withWorkspaceLock } from '@/utils/python-workspace/store';
import PythonWorker from './python-worker?worker';

const MAX_JOBS = 16;
const WORKER_IDLE_MS = 60_000;
const CANCELLED = '[PY_EXEC_CANCELLED] Python execution was cancelled';
let worker: Worker | undefined;
let workerChatId: string | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();
const jobs = new Map<string, AbortController>();

function releaseWorker(): void {
  worker?.terminate();
  worker = undefined;
  workerChatId = undefined;
  clearTimeout(idleTimer);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 8000);
}

function dispatch(input: PythonWorkerRun, signal: AbortSignal): Promise<PythonWorkerResult> {
  signal.throwIfAborted();
  clearTimeout(idleTimer);
  if (worker && workerChatId !== input.chatId) releaseWorker();
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
  const { code, chatId, timeoutMs, state } = request;
  const input: PythonWorkerRun = { code, chatId, timeoutMs, state };
  if (chatId === undefined) {
    const result = await dispatch(input, signal);
    return 'error' in result ? { error: result.error } : { outcome: result.outcome };
  }
  try {
    return await withWorkspaceLock(chatId, async () => {
      const snapshot = await chatDatabase.readWorkspace(chatId, signal);
      const result = await dispatch({ ...input, snapshot }, signal);
      if ('error' in result) return { error: result.error };
      if (result.outcome.ok) {
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
  if (sender.id !== chrome.runtime.id || sender.tab ||
      typeof message?.id !== 'string' || !message.id || message.id.length > 128) return false;
  if (message.type === PYTHON_HOST_CANCEL) {
    jobs.get(message.id)?.abort(new Error(CANCELLED));
    respond(true);
    return false;
  }
  if (message.type !== PYTHON_HOST_RUN) return false;
  const request = message as PythonHostRun;
  if (jobs.has(request.id) || typeof request.code !== 'string' || !request.code.trim() ||
      request.code.length > PYODIDE_MAX_CODE_LENGTH ||
      (request.chatId !== undefined && (typeof request.chatId !== 'string' || !request.chatId || request.chatId.length > 255)) ||
      request.state?.status !== 'ready' || !Array.isArray(request.state.packages) ||
      !request.state.packages.every(pkg => typeof pkg?.name === 'string' && pkg.name.length <= 128) ||
      !Number.isFinite(request.timeoutMs) || request.timeoutMs < 1_000 || request.timeoutMs > PYTHON_RUN_MAX_TIMEOUT_MS) {
    respond({ error: 'Invalid Python execution request' });
    return false;
  }
  if (jobs.size >= MAX_JOBS) {
    respond({ error: '[PY_HOST_BUSY] Too many Python requests are pending. Retry after the current runs finish.' });
    return false;
  }
  const controller = new AbortController();
  jobs.set(request.id, controller);
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

/**
 * Pyodide 环境状态（chrome.storage.local · 跨上下文单一事实源）
 *
 * 状态机：idle（未下载）→ downloading（下载/安装中）→ ready（已核验可用）
 *                            ↘ error（任一环节失败，可重试）
 *
 * 订阅：sidepanel 设置页与 hub 智能体编辑页都经 watchPyodideEnv 感知
 * 状态变化（chrome.storage.onChanged 自动跨上下文广播），据此决定
 * 「python_run 工具组」在智能体编辑页是否可选。
 */

import { PYODIDE_ENV_STORAGE_KEY, PYODIDE_VERSION } from './pyodide-config';

export type PyodideEnvStatus = 'idle' | 'downloading' | 'ready' | 'error';

/** 已安装包记录（与运行时 loadedPackages 同步） */
export interface PyodideInstalledPackage {
  name: string;
  version: string;
  installedAt: number;
}

export interface PyodideEnvState {
  status: PyodideEnvStatus;
  environmentId: string;
  /** 就绪时的 pyodide 版本（与打包的 npm 版本一致） */
  version: string;
  /** 就绪时的 CPython 版本（核验时从解释器读取，如 "3.14.0"） */
  pythonVersion: string;
  /** 最近一次核验通过时间（epoch ms） */
  verifiedAt: number;
  packages: PyodideInstalledPackage[];
  /** status==='error' 时的可读原因 */
  lastError: string;
  updatedAt: number;
}

export const DEFAULT_PYODIDE_ENV_STATE: PyodideEnvState = {
  status: 'idle',
  environmentId: 'legacy',
  version: PYODIDE_VERSION,
  pythonVersion: '',
  verifiedAt: 0,
  packages: [],
  lastError: '',
  updatedAt: 0,
};

/** 读取状态（存储缺失/形态异常时回退默认值，永不抛错） */
export async function getPyodideEnvState(): Promise<PyodideEnvState> {
  try {
    return await readState();
  } catch {
    return { ...DEFAULT_PYODIDE_ENV_STATE };
  }
}

async function readState(): Promise<PyodideEnvState> {
  const container = await chrome.storage.local.get(PYODIDE_ENV_STORAGE_KEY);
  return normalizeState(container?.[PYODIDE_ENV_STORAGE_KEY]);
}

function normalizeState(raw: unknown): PyodideEnvState {
  const state = raw && typeof raw === 'object' ? raw as Partial<PyodideEnvState> : {};
  const status = state.status === 'ready' || state.status === 'downloading' || state.status === 'error'
    ? state.status : 'idle';
  return {
    ...DEFAULT_PYODIDE_ENV_STATE,
    ...state,
    status,
    environmentId: validId(state.environmentId) ? state.environmentId : 'legacy',
    packages: Array.isArray(state.packages) ? state.packages.filter(pkg =>
      pkg && typeof pkg.name === 'string' && typeof pkg.version === 'string' && Number.isFinite(pkg.installedAt)) : [],
  };
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{1,64}$/i.test(value);
}

let localQueue: Promise<unknown> = Promise.resolve();
export async function withPyodideEnvLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(PYODIDE_ENV_STORAGE_KEY, { signal }, operation);
  }
  const pending = localQueue.then(() => {
    signal?.throwIfAborted();
    return operation();
  });
  localQueue = pending.catch(() => undefined);
  return pending;
}

async function writeState(state: PyodideEnvState): Promise<PyodideEnvState> {
  const next = normalizeState({ ...state, updatedAt: Date.now() });
  await chrome.storage.local.set({ [PYODIDE_ENV_STORAGE_KEY]: next });
  return next;
}

/** 全量写入状态 */
export async function setPyodideEnvState(state: PyodideEnvState): Promise<void> {
  await withPyodideEnvLock(() => writeState(state));
}

/** 局部更新（基于最新值合并，避免并发覆盖） */
export async function updatePyodideEnvState(patch: Partial<PyodideEnvState>): Promise<PyodideEnvState> {
  return withPyodideEnvLock(async () => writeState({ ...await readState(), ...patch }));
}

/** Ignore late verification results after another context removes or replaces the runtime. */
export function updatePyodideEnvIfCurrent(
  environmentId: string,
  patch: Partial<PyodideEnvState> | ((current: PyodideEnvState) => Partial<PyodideEnvState>),
): Promise<PyodideEnvState | undefined> {
  return withPyodideEnvLock(async () => {
    const current = await readState();
    if (current.environmentId !== environmentId) return undefined;
    const changes = typeof patch === 'function' ? patch(current) : patch;
    return Object.keys(changes).length ? writeState({ ...current, ...changes }) : current;
  });
}

export function beginPyodideSetup(): Promise<PyodideEnvState> {
  return withPyodideEnvLock(async () => {
    const current = await readState();
    if (current.status === 'ready') {
      throw new Error('Python runtime is already installed in another context');
    }
    return writeState({
      ...current, environmentId: crypto.randomUUID(), status: 'downloading', lastError: '',
    });
  });
}

/** Publish revocation before deleting files, and serialize the cleanup against setup and toggles. */
export async function resetPyodideEnvState(cleanup: () => Promise<void>): Promise<void> {
  await withPyodideEnvLock(async () => {
    await writeState({ ...DEFAULT_PYODIDE_ENV_STATE, environmentId: crypto.randomUUID() });
    await cleanup();
  });
}

/**
 * 订阅状态变化（chrome.storage.onChanged，天然跨上下文）。
 * @returns 取消订阅函数
 */
export function watchPyodideEnv(listener: (state: PyodideEnvState, previous: PyodideEnvState) => void): () => void {
  const handler = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => {
    if (areaName !== 'local' || !(PYODIDE_ENV_STORAGE_KEY in changes)) return;
    const change = changes[PYODIDE_ENV_STORAGE_KEY];
    listener(normalizeState(change?.newValue), normalizeState(change?.oldValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/** 快捷判定：环境是否已核验可用 */
export function isPyodideReady(state: PyodideEnvState): boolean {
  return state.status === 'ready';
}

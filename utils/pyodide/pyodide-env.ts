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
  skillScriptsEnabled: boolean;
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
  skillScriptsEnabled: false,
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
  return {
    ...DEFAULT_PYODIDE_ENV_STATE,
    ...state,
    skillScriptsEnabled: state.status === 'ready' && state.skillScriptsEnabled === true,
    packages: Array.isArray(state.packages) ? state.packages : [],
  };
}

async function withEnvLock<T>(operation: () => Promise<T>): Promise<T> {
  return typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request(PYODIDE_ENV_STORAGE_KEY, operation)
    : operation();
}

async function writeState(state: PyodideEnvState): Promise<PyodideEnvState> {
  const next = normalizeState({ ...state, updatedAt: Date.now() });
  await chrome.storage.local.set({ [PYODIDE_ENV_STORAGE_KEY]: next });
  return next;
}

/** 全量写入状态 */
export async function setPyodideEnvState(state: PyodideEnvState): Promise<void> {
  await withEnvLock(() => writeState(state));
}

/** 局部更新（基于最新值合并，避免并发覆盖） */
export async function updatePyodideEnvState(patch: Partial<PyodideEnvState>): Promise<PyodideEnvState> {
  return withEnvLock(async () => writeState({ ...await readState(), ...patch }));
}

export function setSkillScriptsEnabled(enabled: boolean): Promise<PyodideEnvState> {
  return withEnvLock(async () => {
    const current = await readState();
    if (enabled && current.status !== 'ready') throw new Error('Python runtime is not ready');
    return writeState({ ...current, skillScriptsEnabled: enabled });
  });
}

/** Publish revocation before deleting files, and serialize the cleanup against setup and toggles. */
export async function resetPyodideEnvState(cleanup: () => Promise<void>): Promise<void> {
  await withEnvLock(async () => {
    await writeState(DEFAULT_PYODIDE_ENV_STATE);
    await cleanup();
  });
}

export async function isSkillScriptSupportEnabled(): Promise<boolean> {
  return (await getPyodideEnvState()).skillScriptsEnabled;
}

/** Guard a workspace mutation during the gap between authorization and its IndexedDB commit. */
export async function withSkillScriptSupport<T>(
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const revoked = new AbortController();
  const deny = () => revoked.abort(new Error('Skill script support was disabled'));
  const unwatch = watchPyodideEnv(state => { if (!state.skillScriptsEnabled) deny(); });
  const combined = signal ? AbortSignal.any([signal, revoked.signal]) : revoked.signal;
  try {
    if (!await isSkillScriptSupportEnabled()) deny();
    combined.throwIfAborted();
    return await operation(combined);
  } finally {
    unwatch();
  }
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

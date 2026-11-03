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
    const container = await chrome.storage.local.get(PYODIDE_ENV_STORAGE_KEY);
    const raw = container?.[PYODIDE_ENV_STORAGE_KEY];
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PYODIDE_ENV_STATE };
    return {
      ...DEFAULT_PYODIDE_ENV_STATE,
      ...(raw as Partial<PyodideEnvState>),
      packages: Array.isArray(raw.packages) ? raw.packages : [],
    };
  } catch {
    return { ...DEFAULT_PYODIDE_ENV_STATE };
  }
}

/** 全量写入状态 */
export async function setPyodideEnvState(state: PyodideEnvState): Promise<void> {
  const next: PyodideEnvState = { ...state, updatedAt: Date.now() };
  await chrome.storage.local.set({ [PYODIDE_ENV_STORAGE_KEY]: next });
}

/** 局部更新（基于最新值合并，避免并发覆盖） */
export async function updatePyodideEnvState(patch: Partial<PyodideEnvState>): Promise<PyodideEnvState> {
  const current = await getPyodideEnvState();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [PYODIDE_ENV_STORAGE_KEY]: next });
  return next;
}

/**
 * 订阅状态变化（chrome.storage.onChanged，天然跨上下文）。
 * @returns 取消订阅函数
 */
export function watchPyodideEnv(listener: (state: PyodideEnvState) => void): () => void {
  const handler = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
    if (areaName !== 'local' || !(PYODIDE_ENV_STORAGE_KEY in changes)) return;
    const raw = changes[PYODIDE_ENV_STORAGE_KEY]?.newValue;
    if (!raw || typeof raw !== 'object') return;
    listener({
      ...DEFAULT_PYODIDE_ENV_STATE,
      ...(raw as Partial<PyodideEnvState>),
      packages: Array.isArray((raw as { packages?: unknown }).packages)
        ? ((raw as { packages: PyodideInstalledPackage[] }).packages)
        : [],
    });
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/** 快捷判定：环境是否已核验可用 */
export function isPyodideReady(state: PyodideEnvState): boolean {
  return state.status === 'ready';
}

import { LocalWriteFingerprint, subscribeStorageKey } from '../shared/storage-sync';

/**
 * 智能体 · python_run 注入关联（共享数据层）
 *
 * 背景：预置智能体不可编辑（预置表被冻结，见 agent-store），无法在智能体
 * 编辑器里勾选「Python 运行」工具组。管理中心「Python 环境」页面提供一个
 * 注入组件，把「哪些预置智能体获得 python_run」记录在这里；运行时装配
 * （runtime-builder）据此在装配时按实际设置注入。
 *
 * 单一事实源：chrome.storage.local[AGENT_PYTHON_LINKS_STORAGE_KEY]
 *   = string[]（已注入的智能体 id，去重保序）
 * localStorage 为同源同步读缓存；任一上下文写入后，其它上下文经
 * chrome.storage.onChanged 重建内存态——管理中心勾选后侧边栏立刻生效。
 *
 * 不变量：
 *   1. 只记录显式勾选的 id，缺省为空 = 不注入任何智能体；
 *   2. Python 环境被删除时由 purgePyodideEnvironment 统一清空本表
 *      （见 utils/pyodide/pyodide-runtime）；
 *   3. 本模块只负责持久化，不感知环境状态；「环境未就绪不注入」的判定
 *      由装配层（runtime-builder）与 UI（仅就绪时展示注入组件）负责，
 *      两层共同保证不会出现环境已删除但智能体仍引用 python_run 的情况。
 */

/** 存储键（chrome.storage.local 与 localStorage 缓存同名） */
export const AGENT_PYTHON_LINKS_STORAGE_KEY = 'agentNexusAgentPythonToolLinks';

/** 内存表：已注入 python_run 的智能体 id 集合 */
let linkedIds = new Set<string>();
/** 变更监听器（本上下文写入或跨上下文同步后触发） */
const listeners = new Set<() => void>();
/** 本上下文写入指纹（onChanged 自事件跳过） */
const fingerprint = new LocalWriteFingerprint();
/** 恢复代数：迟到的旧读取结果不得覆盖更新后的内存态 */
let restoreVersion = 0;
/** 串行化写入：快速连续勾选时保证 chrome.storage 落盘顺序与内存态一致 */
let writeChain: Promise<void> = Promise.resolve();

function normalizeIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) return ids;
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id) ids.add(id);
  }
  return ids;
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn('[AgentPythonLinks] 变更监听器执行失败:', error);
    }
  }
}

function writeLocalCache(ids: ReadonlySet<string>): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(AGENT_PYTHON_LINKS_STORAGE_KEY, JSON.stringify([...ids]));
    }
  } catch {
    /* 缓存失败不影响内存态与权威源 */
  }
}

/**
 * 应用新集合（内存态 + 可选同步缓存），仅在内容变化时广播。
 * 外部同步（onChanged）也走这里，保证两条路径的收敛逻辑一致。
 */
function applyIds(next: Set<string>, syncCache: boolean): void {
  const changed = !sameIds(linkedIds, next);
  linkedIds = next;
  if (syncCache) writeLocalCache(next);
  if (changed) notify();
}

/** 当前已注入 python_run 的智能体 id（快照，调用方不得修改） */
export function pythonToolLinkedAgentIds(): string[] {
  return [...linkedIds];
}

/** 指定智能体是否被注入 python_run（仅读内存态） */
export function isPythonToolLinked(agentId: string): boolean {
  return !!agentId && linkedIds.has(agentId);
}

/** 订阅注入集合变更；返回退订函数 */
export function onAgentPythonToolLinksChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 从 chrome.storage 权威源恢复（异步，各上下文启动 / 装配前 await 一次）。
 * 读取失败保持现有内存态（不把用户配置误清空）。
 */
export async function restoreAgentPythonToolLinks(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  const version = ++restoreVersion;
  let stored: unknown;
  try {
    const container = await chrome.storage.local.get(AGENT_PYTHON_LINKS_STORAGE_KEY);
    stored = container?.[AGENT_PYTHON_LINKS_STORAGE_KEY];
  } catch (error) {
    console.warn('[AgentPythonLinks] 读取注入关联失败:', error);
    return;
  }
  if (version !== restoreVersion) return;
  applyIds(normalizeIds(stored), true);
}

/** 持久化新集合（先更新内存态与缓存，再写权威源） */
function persistIds(next: Set<string>): Promise<void> {
  const snapshot = [...next].sort();
  fingerprint.mark(snapshot);
  applyIds(new Set(snapshot), true);
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return Promise.resolve();
  writeChain = writeChain.then(async () => {
    try {
      await chrome.storage.local.set({ [AGENT_PYTHON_LINKS_STORAGE_KEY]: snapshot });
    } catch (error) {
      console.warn('[AgentPythonLinks] 写入注入关联失败:', error);
    }
  });
  return writeChain;
}

/** 设置单个智能体的注入态（幂等：状态未变化时不产生写入） */
export function setAgentPythonToolLinked(agentId: string, linked: boolean): Promise<void> {
  const id = typeof agentId === 'string' ? agentId.trim() : '';
  if (!id) return Promise.resolve();
  if (linkedIds.has(id) === linked) return Promise.resolve();
  const next = new Set(linkedIds);
  if (linked) next.add(id);
  else next.delete(id);
  return persistIds(next);
}

/** 清空全部注入（删除 Python 环境时调用；幂等） */
export function clearAgentPythonToolLinks(): Promise<void> {
  if (linkedIds.size === 0) return Promise.resolve();
  return persistIds(new Set());
}

// 模块初始化：localStorage 同步恢复（chrome.storage 异步恢复由消费方显式调用）
(function restoreFromLocalStorage(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(AGENT_PYTHON_LINKS_STORAGE_KEY);
    if (!raw) return;
    applyIds(normalizeIds(JSON.parse(raw)), false);
  } catch (error) {
    console.warn('[AgentPythonLinks] localStorage 恢复失败:', error);
  }
})();

// 跨上下文同步：其它页面写入 → 重建内存态并广播（本模块自事件已被指纹跳过）
subscribeStorageKey(AGENT_PYTHON_LINKS_STORAGE_KEY, fingerprint, value => {
  applyIds(normalizeIds(value), true);
});

import { linkedSkillIds, restoreAgentSkillLinks, onAgentSkillLinksChange } from './agent-skill-links';
import { pluginAgent, pluginAgents, onPluginsChange } from '@/utils/plugins/catalog';
/**
 * 智能体存储（共享数据层）
 *
 * 供 sidepanel 与 hub 管理页等多个扩展页面共用（扩展页面同源，但 localStorage /
 * chrome.storage / 内存模块互不可见，必须经跨上下文同步对齐）。
 *
 * 分层：
 *   utils/agents/agent-types.ts  类型 + 不变量 + 纯归一化/校验/排序/分组/ID 生成
 *   本文件                       预置表 + 内存表 + 持久化 + 跨上下文同步 + 查询/写入门面
 *
 * 持久化模型：
 *   - 权威源：chrome.storage.local['agentNexusCustomAgents']（仅自定义智能体数组）
 *   - 缓存：  localStorage['agentNexusCustomAgents']（同步读兜底，
 *             「清除浏览数据」场景由 chrome.storage 恢复）
 *   - 同步：  任一上下文写入 → 其它上下文经 chrome.storage.onChanged
 *             重建内存表并广播变更（utils/shared/storage-sync）
 *
 * 不变量（全部在本文件内收敛，外部无法绕过）：
 *   1. 预置智能体不可被覆盖、不可被删除、其 ID 不可被自定义智能体占用；
 *   2. id 全局唯一（用于预置判定与按 id 引用），name 全局唯一（存储键）；
 *   3. 内存表中的 name 键与 config.name 恒等（键名漂移会让按名查询静默失败）；
 *   4. 任何进入内存表的数据都已通过 normalizeAgentConfig 收敛。
 *
 * 安全：本层是唯一写入口。写入前统一归一化并施加长度/数量上限，
 * 防止异常调用方（或被篡改的持久化数据）写入无限体积的记录撑爆存储配额。
 */

import {
  autoActionConfig,
  dataHarvesterConfig,
  visionAssistantConfig,
  deepSearchConfig,
  bilibiliAgentConfig,
  mindmapAssistantConfig,
  visionActionConfig,
} from './presets';
import {
  AGENT_NAME_MAX_CHARS,
  compareAgents,
  filterAvailableAgents,
  generateAgentId,
  normalizeAgentConfig,
  type AgentConfig,
  type PresetAgentConfig,
} from './agent-types';
import { LocalWriteFingerprint, subscribeStorageKey } from '../shared/storage-sync';

// 类型与纯逻辑的统一出口：外部一律从本模块导入领域类型，
// 保持「只认识存储门面」的调用习惯，底层分层可自由演进
export * from './agent-types';
// ──── 预置智能体 ────

/**
 * 预置智能体表（声明顺序即列表展示顺序；对象冻结防止运行期被意外改写）。
 * 对外只读：预置不可被覆盖/删除/改名，外部拿到的引用不得被改写。
 *
 * 每个预置都必须显式声明发布闸门 `available`（编译期强制，见 PresetAgentConfig）：
 * false = 底层禁用——该预置在管理中心与输入框 @ 选择器中都看不到，
 * 用户无法通过任何入口把它打开（与用户级 enabled 开关相互独立）。
 */
export const PRESET_AGENTS: readonly PresetAgentConfig[] = Object.freeze([
  Object.freeze(autoActionConfig),
  Object.freeze(dataHarvesterConfig),
  Object.freeze(visionAssistantConfig),
  Object.freeze(deepSearchConfig),
  Object.freeze(bilibiliAgentConfig),
  Object.freeze(mindmapAssistantConfig),
  Object.freeze(visionActionConfig),
]);

/** 预置智能体 ID 集合（由预置表派生，杜绝两处清单漂移） */
export const PRESET_AGENT_IDS: ReadonlySet<string> = new Set(
  PRESET_AGENTS.map(agent => agent.id),
);

/**
 * 底层禁用的预置智能体 id 集合（发布闸门 available === false）。
 * 由预置表派生——发布态是代码事实，不进存储、不跨上下文同步。
 */
const unavailablePresetIds = new Set(
  PRESET_AGENTS.filter(agent => agent.available === false).map(agent => agent.id),
);

/**
 * 该智能体是否对外可见（发布态闸门）。
 *
 * 与 isAgentEnabled（用户级运行开关）正交：
 *   - 不可用 = 管理中心与 @ 选择器都看不到，用户无法启用；
 *   - 停用   = 管理中心仍可见，只是不能被 @ 选中。
 * 自定义与插件智能体恒为可用（无发布闸门）。
 */
export function isAgentAvailable(agentId: string): boolean {
  return !unavailablePresetIds.has(agentId);
}

/** 是否为预置智能体（预置不可被覆盖/删除/占用 ID） */
export function isPresetAgent(agentId: string): boolean {
  return PRESET_AGENT_IDS.has(agentId);
}

// ──── 内存表与索引 ────

/**
 * 全量内存表：键为智能体名（= config.name，不变量 3）。
 * 预置项在模块初始化时装入且永不删除；自定义项随持久化重建整体替换。
 */
const agentsByName = new Map<string, AgentConfig>();

/** id → name 索引（O(1) 按 id 查询与 ID 冲突判定；由 applyAgents 统一重建） */
let agentsById = new Map<string, string>();

/** 重建 id 索引并输出重复 id 告警（预置表构造上唯一，重复只可能来自自定义数据） */
function reindex(): void {
  const index = new Map<string, string>();
  for (const [name, agent] of agentsByName) {
    const existing = index.get(agent.id);
    if (existing !== undefined) {
      // 重复 id 会让按 id 的引用（会话回显、预置判定）指向错误对象，必须告警
      console.warn(
        `[AgentStore] 检测到重复智能体 ID "${agent.id}"：${existing} / ${name}，` +
          '按 id 查询将命中先注册者',
      );
      continue;
    }
    index.set(agent.id, name);
  }
  agentsById = index;
}

/** 全量写入（预置 + 自定义）：统一重建索引，保证不变量 2/4 在任何写路径上成立 */
function applyAgents(agents: Iterable<AgentConfig>): void {
  agentsByName.clear();
  for (const agent of agents) agentsByName.set(agent.name, agent);
  reindex();
}

// ──── 变更通知 ────

type ChangeListener = () => void;
const listeners = new Set<ChangeListener>();

/** 订阅智能体集合变更（本上下文写入或跨上下文同步重建后触发）；返回退订函数 */
export function onAgentsChange(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyChange(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn('[AgentStore] 变更监听器执行失败:', error);
    }
  }
}

// ──── 持久化与跨上下文同步 ────

/** 自定义智能体存储 key（chrome.storage 权威 + localStorage 缓存共用） */
const CUSTOM_AGENTS_STORAGE_KEY = 'agentNexusCustomAgents';

/**
 * 预置 / 插件智能体的启停覆盖 key（只记录停用项，减小体积）。
 * 自定义智能体的启停写在记录自身（随自定义列表持久化）；
 * 预置与插件记录不可编辑（预置表被冻结），故用独立覆盖表承载。
 */
const AGENT_ENABLE_OVERRIDES_STORAGE_KEY = 'agentNexusAgentEnableOverrides';

/** 本上下文写入指纹（onChanged 自事件跳过） */
const writeFingerprint = new LocalWriteFingerprint();

/** 启停覆盖的写入指纹（与自定义列表各自独立，避免互相误判为自事件） */
const enableFingerprint = new LocalWriteFingerprint();

/** 停用覆盖集合：agentId 集合（缺省 = 启用） */
const disabledAgentIds = new Set<string>();

/** 自定义智能体快照（按名称稳定排序，保证不同上下文写出的数组顺序一致） */
function customAgentSnapshot(): AgentConfig[] {
  return [...agentsByName.values()]
    .filter(agent => !isPresetAgent(agent.id))
    .sort(compareAgents);
}

/** 把内存中的自定义智能体写入权威源与缓存（先登记指纹再写 chrome.storage） */
function persistCustomAgents(): void {
  const customAgents = customAgentSnapshot();
  writeFingerprint.mark(customAgents);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(CUSTOM_AGENTS_STORAGE_KEY, JSON.stringify(customAgents));
    }
  } catch (error) {
    console.warn('[AgentStore] 写 localStorage 缓存失败:', error);
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      void chrome.storage.local
        .set({ [CUSTOM_AGENTS_STORAGE_KEY]: customAgents })
        .catch(error => console.warn('[AgentStore] 写 chrome.storage 失败:', error));
    }
  } catch (error) {
    console.warn('[AgentStore] chrome.storage 不可用，本次仅写入 localStorage:', error);
  }
  notifyChange();
}

/**
 * 以给定自定义智能体列表重建内存表（预置项永不被移除/覆盖），
 * 刷新 localStorage 缓存并广播变更。用于启动恢复与跨上下文同步。
 *
 * 逐条归一化：结构不可修复（缺 id/name/system）或与预置 ID 撞车的记录被跳过，
 * 其余记录（含旧版本缺 category/tags 的）一律收敛后接纳——恢复阶段丢弃数据
 * 对用户而言是「智能体凭空消失」，能修复就必须修复。
 *
 * @returns 实际生效的自定义智能体数量
 */
function rebuildCustomAgents(items: unknown): number {
  const next: AgentConfig[] = [...PRESET_AGENTS];
  const seenIds = new Set<string>(PRESET_AGENT_IDS);
  const seenNames = new Set<string>(PRESET_AGENTS.map(agent => agent.name));

  if (Array.isArray(items)) {
    for (const item of items) {
      const agent = normalizeAgentConfig(item);
      if (!agent) {
        console.warn('[AgentStore] 跳过结构不完整的自定义智能体记录:', item);
        continue;
      }
      if (agent.id.startsWith('ed25519:') || agent.plugin) continue;
      if (isPresetAgent(agent.id)) {
        console.warn(`[AgentStore] 跳过与预置 ID 撞车的自定义智能体: "${agent.name}" (${agent.id})`);
        continue;
      }
      // ID 唯一性：重复 ID 会误触按 ID 分派的特殊分支（如 deep-search 的站点注入）
      if (seenIds.has(agent.id)) {
        console.warn(`[AgentStore] 自定义智能体 ID 重复，后者被跳过: "${agent.name}" (${agent.id})`);
        continue;
      }
      // 名称唯一性：name 是存储键，重复会让后者覆盖前者的查询入口
      if (seenNames.has(agent.name)) {
        console.warn(`[AgentStore] 自定义智能体同名冲突，后者被跳过: "${agent.name}"`);
        continue;
      }
      seenIds.add(agent.id);
      seenNames.add(agent.name);
      next.push(agent);
    }
  }

  applyAgents(next);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(CUSTOM_AGENTS_STORAGE_KEY, JSON.stringify(customAgentSnapshot()));
    }
  } catch {
    /* 缓存失败不影响内存态 */
  }
  notifyChange();
  return next.length - PRESET_AGENTS.length;
}

/** 模块初始化：装入预置表（自定义项由 localStorage 同步恢复 / chrome.storage 异步恢复补入） */
applyAgents(PRESET_AGENTS);

/** 模块初始化：localStorage 同步恢复（chrome.storage 异步恢复由各上下文启动时显式调用） */
(function restoreFromLocalStorage(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(CUSTOM_AGENTS_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) rebuildCustomAgents(parsed);
    }
    // 启停覆盖同步恢复（预置 / 插件智能体的停用态）
    const overridesRaw = localStorage.getItem(AGENT_ENABLE_OVERRIDES_STORAGE_KEY);
    if (overridesRaw) applyEnableOverrides(JSON.parse(overridesRaw));
  } catch (error) {
    console.warn('[AgentStore] localStorage 恢复失败:', error);
  }
})();

/**
 * 从 chrome.storage 权威源恢复（异步，各上下文启动时 await 一次）。
 * 覆盖两类场景：localStorage 被清除后的恢复；本上下文启动期间其它页面的写入。
 */
export async function restoreCustomAgentsFromStorage(): Promise<void> {
  await restoreAgentSkillLinks();
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const result = await chrome.storage.local.get([
      CUSTOM_AGENTS_STORAGE_KEY,
      AGENT_ENABLE_OVERRIDES_STORAGE_KEY,
    ]);
    const stored = result?.[CUSTOM_AGENTS_STORAGE_KEY];
    if (Array.isArray(stored)) {
      if (!writeFingerprint.isOwn(stored)) {
        const count = rebuildCustomAgents(stored);
        if (count > 0) {
          console.log(`[AgentStore] 从 chrome.storage 恢复 ${count} 个自定义智能体`);
        }
      }
    }
    // 启停覆盖：先整体复位（对端重新启用的智能体在本上下文同步生效），再应用
    const overrides = result?.[AGENT_ENABLE_OVERRIDES_STORAGE_KEY];
    if (overrides && typeof overrides === 'object' && !enableFingerprint.isOwn(overrides)) {
      applyEnableOverrides(overrides);
      notifyChange();
    }
  } catch (error) {
    console.warn('[AgentStore] chrome.storage 恢复失败:', error);
  }
}

// 跨上下文同步订阅：其它页面写入 → 重建/应用并广播（本模块自事件已被指纹跳过）
subscribeStorageKey(CUSTOM_AGENTS_STORAGE_KEY, writeFingerprint, newValue => {
  rebuildCustomAgents(newValue);
});

// 启停覆盖的跨上下文同步：hub 停用 → 侧边栏 @ 选择器立即不再显示该智能体
subscribeStorageKey(AGENT_ENABLE_OVERRIDES_STORAGE_KEY, enableFingerprint, newValue => {
  applyEnableOverrides(newValue);
  notifyChange();
});

// ──── 启用 / 停用 ────

/** 启停覆盖快照（仅停用项） */
function enableOverrideSnapshot(): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  for (const id of disabledAgentIds) overrides[id] = false;
  return overrides;
}

/** 把启停覆盖写入权威源与缓存（先登记指纹再写 chrome.storage） */
function persistEnableOverrides(): void {
  const overrides = enableOverrideSnapshot();
  enableFingerprint.mark(overrides);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(AGENT_ENABLE_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    /* 缓存失败不阻断 */
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      void chrome.storage.local
        .set({ [AGENT_ENABLE_OVERRIDES_STORAGE_KEY]: overrides })
        .catch(error => console.warn('[AgentStore] 写启停覆盖失败:', error));
    }
  } catch {
    /* chrome 不可用时仅本地 */
  }
}

/** 应用启停覆盖（外部数据防御：仅接受 { [id]: false } 形态，其余一律视为启用） */
function applyEnableOverrides(overrides: unknown): void {
  disabledAgentIds.clear();
  if (!overrides || typeof overrides !== 'object') return;
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (value === false) disabledAgentIds.add(key);
  }
}

/**
 * 解析某智能体的启用态（自定义记录自带；预置 / 插件查覆盖表；缺省 = 启用）。
 */
export function isAgentEnabled(agentId: string): boolean {
  const name = agentsById.get(agentId);
  const record = name === undefined ? undefined : agentsByName.get(name);
  if (record && !isPresetAgent(record.id) && !record.plugin) return record.enabled !== false;
  return !disabledAgentIds.has(agentId);
}

/** 列表出口统一补齐 enabled 字段（预置记录被冻结，停用态以副本呈现，不改写原对象） */
function withEnabled(agent: AgentConfig): AgentConfig {
  const enabled = isAgentEnabled(agent.id);
  const extra = linkedSkillIds(agent.id);
  if (extra.length) agent = { ...agent, skills: [...new Set([...(agent.skills ?? []), ...extra])] };
  if ((agent.enabled !== false) === enabled) return agent;
  return { ...agent, enabled };
}

/**
 * 切换智能体启用态（按 id）。
 * 自定义智能体：写入记录本身（随自定义列表持久化）；
 * 预置 / 插件智能体：记录不可编辑，改用启停覆盖表。
 * 两种路径都广播变更——hub 列表与侧边栏 @ 选择器实时同步。
 */
export function setAgentEnabled(agentId: string, enabled: boolean): boolean {
  const name = agentsById.get(agentId);
  const record = name === undefined ? undefined : agentsByName.get(name);
  if (record && !isPresetAgent(record.id) && !record.plugin) {
    record.enabled = enabled;
    persistCustomAgents();
    return true;
  }
  if (!record && !getAgentById(agentId)) return false; // 未知 id
  if (enabled) disabledAgentIds.delete(agentId);
  else disabledAgentIds.add(agentId);
  persistEnableOverrides();
  notifyChange();
  return true;
}

// ──── 查询 API ────

/** 按名称获取智能体配置 */
export function getAgentConfig(agentName: string): AgentConfig | null {
  const record = pluginAgent(agentName) ?? agentsByName.get(agentName) ?? null;
  return record ? withEnabled(record) : null;
}

/** 按 ID 获取智能体配置 */
export function getAgentById(agentId: string): AgentConfig | null {
  const external = pluginAgent(agentId);
  if (external) return withEnabled(external);
  const name = agentsById.get(agentId);
  const record = name === undefined ? null : (agentsByName.get(name) ?? null);
  return record ? withEnabled(record) : null;
}

/**
 * 全部**对外可见**的智能体（预置 + 自定义 + 插件）。
 *
 * 顺序：预置按声明顺序在前，自定义按名称稳定排序在后——
 * 让「开箱即用的能力」永远出现在列表顶部，且自定义部分的顺序与数据恢复顺序无关。
 *
 * 底层禁用的预置（available === false）**不进入本列表**：
 * 管理中心与输入框 @ 选择器共用这一个出口，闸门在此收口，
 * 新增消费方不必（也不会）再各自过滤一遍。
 * 注意：被禁用的预置仍可按 id / 名称解析（getAgentById / getAgentConfig）——
 * 历史会话引用它时仍能正确回显，不会静默退化成「无智能体」。
 */
export function getAllAgents(): AgentConfig[] {
  const presets = filterAvailableAgents(
    PRESET_AGENTS.filter(agent => agentsByName.has(agent.name)),
  );
  const customs = [...agentsByName.values()]
    .filter(agent => !isPresetAgent(agent.id))
    .sort(compareAgents);
  return [...presets, ...customs, ...pluginAgents()].map(withEnabled);
}

/** ID 是否已被占用（exceptId 用于编辑场景排除自身） */
export function isAgentIdTaken(agentId: string, exceptId?: string): boolean {
  if (!agentId) return false;
  if (exceptId !== undefined && agentId === exceptId) return false;
  return agentsById.has(agentId);
}

/**
 * 为指定名称生成唯一 ID（自定义智能体新建时使用）。
 * exceptId 传入「正在编辑的自身 ID」，避免编辑未改名时 ID 被判为冲突。
 */
export function generateUniqueAgentId(name: string, exceptId?: string): string {
  return generateAgentId(name, candidate => isAgentIdTaken(candidate, exceptId));
}

// ──── 写入 API（仅自定义智能体；预置不可覆盖/删除） ────

/** 写入失败原因（管理页据此给出精确可读提示，而非一律「保存失败」） */
export type AgentWriteFailureReason =
  /** 数据不合法：名称为空/超长、结构缺失、ID 与其它智能体冲突 */
  | 'invalid'
  /** 目标名称已被其它智能体占用 */
  | 'name-exists'
  /** 目标名称指向预置智能体（不可覆盖/不可被重命名占用） */
  | 'preset-name'
  /** 尝试以预置 ID 写入自定义智能体 */
  | 'preset-id'
  /** 尝试删除预置智能体 */
  | 'preset-delete'
  /** 目标智能体不存在（可能已在其它页面被删除） */
  | 'not-found';

export type AgentWriteResult =
  | { ok: true; agent: AgentConfig }
  | { ok: false; reason: AgentWriteFailureReason };

/**
 * 新增或更新自定义智能体（重命名在同一次调用内原子完成）。
 *
 * @param config 待写入配置（name 即目标键；归一化在本层进行，不信任调用方）
 * @param options.previousName 重命名场景下被更新智能体的旧名称。
 *   提供且与目标名不同时，旧键在新键写入的同一变更内移除——杜绝「先写后删」
 *   协议下同一 ID 短暂出现两条记录、以及两次持久化之间的中断窗口。
 *
 * 不变量执行：预置不可被覆盖/重命名/占用 ID；名称与 ID 全局唯一（更新自身除外）。
 */
export function setAgentConfig(
  config: AgentConfig,
  options: { previousName?: string } = {},
): AgentWriteResult {
  const name = typeof config?.name === 'string' ? config.name.trim() : '';
  // 名称长度上限在此拒绝而非钳制：钳制会静默改写用户的输入并可能与既有智能体重名，
  // 明确报错让管理页提示「请缩短名称」是唯一正确处置
  if (!name || name.length > AGENT_NAME_MAX_CHARS) {
    return { ok: false, reason: 'invalid' };
  }
  if (config?.plugin || config?.id?.startsWith('ed25519:')) return { ok: false, reason: 'invalid' };
  const normalized = normalizeAgentConfig({ ...config, name });
  if (!normalized || normalized.name !== name) {
    return { ok: false, reason: 'invalid' };
  }

  // 被更新的既有条目：重命名取旧键，否则取目标键（不存在 = 新建）
  const previousName = options.previousName?.trim();
  const renaming = !!previousName && previousName !== name;
  const source = agentsByName.get(renaming ? (previousName as string) : name);

  // 目标名被「其它智能体」占用（重命名撞名 / 新建撞名）；撞上预置单独给出原因
  const target = agentsByName.get(name);
  if (target && target !== source) {
    return { ok: false, reason: isPresetAgent(target.id) ? 'preset-name' : 'name-exists' };
  }
  if (source && isPresetAgent(source.id)) {
    console.warn(`[AgentStore] 拒绝覆盖预置智能体: "${source.name}"`);
    return { ok: false, reason: 'preset-name' };
  }
  if (isPresetAgent(normalized.id)) {
    console.warn(`[AgentStore] 拒绝以预置 ID 写入自定义智能体: "${normalized.id}"`);
    return { ok: false, reason: 'preset-id' };
  }
  // ID 冲突判定排除「被更新的自身」：编辑/重命名既有智能体时 ID 不变是常态
  if (isAgentIdTaken(normalized.id, source?.id)) {
    console.warn(`[AgentStore] 拒绝与其它智能体冲突的 ID: "${normalized.id}"`);
    return { ok: false, reason: 'invalid' };
  }

  if (renaming) agentsByName.delete(previousName as string);
  agentsByName.set(name, normalized);
  reindex();
  persistCustomAgents();
  return { ok: true, agent: normalized };
}

/** 删除自定义智能体（预置不可删） */
export function removeAgentConfig(agentName: string): AgentWriteResult {
  const existing = agentsByName.get(agentName);
  if (!existing) return { ok: false, reason: 'not-found' };
  if (isPresetAgent(existing.id)) {
    console.warn(`[AgentStore] 拒绝删除预置智能体: "${agentName}"`);
    return { ok: false, reason: 'preset-delete' };
  }
  agentsByName.delete(agentName);
  reindex();
  persistCustomAgents();
  return { ok: true, agent: existing };
}

onPluginsChange(notifyChange);

onAgentSkillLinksChange(notifyChange);

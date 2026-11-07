import { pluginSkills, onPluginsChange } from '@/utils/plugins/catalog';
/**
 * 技能存储（Skill Store）
 *
 * 数据来源：
 *   - 预置技能：项目根 skills/ 目录，构建期由 import.meta.glob 以原样字符串打包
 *   - 自定义技能：chrome.storage.local 权威源 + localStorage 同步缓存
 *     （localStorage 会被「清除浏览数据」抹掉 → chrome.storage 是恢复源；
 *      与 utils/agents/agent-store.ts 的持久化模式完全同构。
 *      多文件技能的载荷（files，可含数 MB 文本）同键存储——localStorage
 *      镜像超过安全上限自动跳过，chrome.storage（unlimitedStorage）无此顾虑）
 *   - 预置技能的启停覆盖：独立 overrides key 持久化（默认启用）
 *
 * 身份模型（v2，详见 skill-types.ts）：
 *   - 内存表以 id 为键；id 全局唯一、创建后不可变；
 *   - id 分两个区间：内置技能占用保留区间（presetSkillIdFromName），
 *     自定义技能的生成 / 导入一律在其余区间取值（generateUniqueSkillId /
 *     generateSkillId 内部让位），互不侵占；
 *   - name **允许同名**：同名是常态而非异常（多站点各自的同名规范、重复导入），
 *     消歧由 id 与模型标识 `${name}-${id}` 承担。按名查询是「首个注册者」语义
 *     （reindexNames 先到先得），仅作旧数据兼容兜底，新引用一律走 id；
 *   - 旧版持久化数据（无 id）在恢复时由名称经确定性哈希生成 id ——
 *     各上下文从同一份数组按同一顺序恢复，生成结果完全一致，无需协调。
 *
 * 跨上下文同步（utils/shared/storage-sync）：sidepanel 与 hub 管理页共享同一份
 * 数据；任一上下文写入 → 其它上下文经 chrome.storage.onChanged 重建内存表并广播。
 */

import type { SkillRecord, StoredSkill } from './skill-types';
import {
  SKILL_NAME_PATTERN,
  SKILL_NAME_MAX_CHARS,
  SKILL_ID_PATTERN,
  composeModelSkillId,
  generateSkillId,
  generateUniqueSkillId,
  presetSkillIdFromName,
  normalizeAllowedToolList,
  normalizeFolderList,
} from './skill-types';
import { parseFrontmatter, normalizeSkillName, parseAllowedTools, parseSkillTags } from './frontmatter-parser';
import { AGENT_CATEGORY_UNCATEGORIZED, normalizeCategory } from '../agents/agent-types';
import { LocalWriteFingerprint, subscribeStorageKey } from '../shared/storage-sync';

// ──── 预置技能加载（构建期打包） ────

/** /skills/<技能名>/<相对路径> → 文件文本 */
const presetFileModules = import.meta.glob('/skills/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** 从 glob 结果分组，返回「目录名 → 文件集」（记录构建与 id 分配由 initStore 统一执行） */
function collectPresetSkillFiles(): Array<{ folderName: string; files: Record<string, string> }> {
  const bySkill = new Map<string, Map<string, string>>();

  for (const [path, content] of Object.entries(presetFileModules)) {
    // path 形如 '/skills/bilibili-video-summary/SKILL.md' 或 '/skills/xxx/references/a.md'
    const match = path.match(/^\/skills\/([^/]+)\/(.+)$/);
    if (!match || typeof content !== 'string') continue;
    const [, skillName, relPath] = match;
    if (!bySkill.has(skillName)) bySkill.set(skillName, new Map());
    bySkill.get(skillName)!.set(relPath, content);
  }

  const collected: Array<{ folderName: string; files: Record<string, string> }> = [];
  for (const [folderName, files] of bySkill) {
    if (!files.has('SKILL.md')) {
      console.warn(`[SkillStore] 预置技能目录 ${folderName} 缺少 SKILL.md，跳过`);
      continue;
    }
    // 同名冲突防御：后加载的预置技能目录覆盖前者，显式告警便于排查打包内容
    if (collected.some(existing => existing.folderName === folderName)) {
      console.warn(`[SkillStore] 预置技能目录冲突: "${folderName}"（后者覆盖前者）`);
    }
    collected.push({ folderName, files: Object.fromEntries(files) });
  }
  return collected;
}

// ──── 记录构建 ────

/**
 * 由文件集合解析 frontmatter 并构建运行时记录；SKILL.md 缺失或名称非法时返回 null。
 * id 由调用方指定（新建场景传入 generateUniqueSkillId 结果；编辑场景沿用原 id；
 * 预置场景传入 presetSkillIdFromName 结果）。
 */
function buildSkillRecord(
  name: string,
  files: Map<string, string> | Record<string, string>,
  source: SkillRecord['source'],
  id: string,
  enabled = true,
): SkillRecord | null {
  const fileMap =
    files instanceof Map ? files : new Map(Object.entries(files));
  const skillMd = fileMap.get('SKILL.md');
  if (!skillMd) {
    console.warn(`[SkillStore] 技能 ${name} 缺少 SKILL.md，跳过`);
    return null;
  }

  const { data, body } = parseFrontmatter(skillMd);
  // 名称以 frontmatter 为准（缺省回落目录/传入名），统一走规范化
  const normalizedName = normalizeSkillName(data['name'] || name);
  if (!normalizedName || !SKILL_NAME_PATTERN.test(normalizedName)) {
    console.warn(`[SkillStore] 技能名 "${name}" 规范化后仍不合法（需匹配 ${SKILL_NAME_PATTERN}），跳过`);
    return null;
  }
  // 长度上限兜底：超长名（外部写入/导入）会污染模型标识与提示词清单，明确拒绝
  if (normalizedName.length > SKILL_NAME_MAX_CHARS) {
    console.warn(`[SkillStore] 技能名 "${normalizedName}" 超过 ${SKILL_NAME_MAX_CHARS} 字符上限，跳过`);
    return null;
  }
  if (!id || !SKILL_ID_PATTERN.test(id)) {
    console.warn(`[SkillStore] 技能 ${normalizedName} 的 id "${id}" 不合法，跳过`);
    return null;
  }

  const description = (data['description'] || '').trim();
  if (!description) {
    console.warn(`[SkillStore] 技能 ${normalizedName} 缺少 description，跳过`);
    return null;
  }

  // 分类必选：编辑器强制选择；此处兜底历史/导入/预置数据缺 frontmatter category
  // 的情形，统一归入通用分类——保证入库记录的 category 恒非空（与智能体同一分类规范）
  const category = normalizeCategory(data['category']) || AGENT_CATEGORY_UNCATEGORIZED;

  return {
    id,
    name: normalizedName,
    description,
    compatibility: data['compatibility'] || undefined,
    license: data['license'] || undefined,
    allowedTools: parseAllowedTools(data['allowed-tools']),
    files: Object.fromEntries(fileMap),
    body,
    category,
    tags: parseSkillTags(data['tags']),
    source,
    enabled,
    updatedAt: Date.now(),
  };
}

// ──── 存储与恢复 ────

/** 自定义技能存储 key（chrome.storage 权威 + localStorage 缓存共用） */
const CUSTOM_SKILLS_STORAGE_KEY = 'agentNexusCustomSkills';

/**
 * localStorage 镜像的安全上限（字符）。localStorage 总配额约 5MB，且与
 * 其它域数据共享；多文件技能（导入上限 10M 字符）轻松超配额——超过该值时
 * 跳过镜像只写权威源，避免每次保存都触发 QuotaExceededError。chrome.storage
 * （unlimitedStorage）才是恢复源，镜像缺失只影响「chrome 意外清空且无备份」
 * 这一边缘场景的兜底，属可接受的降级。
 */
const LOCAL_MIRROR_MAX_CHARS = 4 * 1024 * 1024;

/** 预置技能启停覆盖 key（按 id 记录被显式停用的预置 → false；默认启用） */
const PRESET_TOGGLE_STORAGE_KEY = 'agentNexusSkillPresetToggles';

/** 内存中的技能表（预置 + 自定义），键为技能 id */
const skillMap = new Map<string, SkillRecord>();

/** name → id 软索引（同名时保留首个注册者；仅供按名兜底查询，不承担唯一性） */
const idByName = new Map<string, string>();

/** 重建 name 索引（每次内存表变更后调用，保证与 skillMap 恒等） */
function reindexNames(): void {
  idByName.clear();
  for (const [id, skill] of skillMap) {
    // 同名不告警：同名是常态（见文件头身份模型），首个注册者胜出即按名查询语义
    if (!idByName.has(skill.name)) idByName.set(skill.name, id);
  }
}

/** 本上下文写入指纹 × 2（自定义技能 / 预置启停覆盖，onChanged 自事件跳过） */
const skillsFingerprint = new LocalWriteFingerprint();
const togglesFingerprint = new LocalWriteFingerprint();

/**
 * chrome.storage 写入队列与落盘确认。
 *
 * 自定义技能含多文件载荷（可达数 MB），写入是重操作：串行排队防止乱序
 * 覆盖（toggle 开关 + 编辑保存连击），失败被记录而非吞掉——导入与编辑
 * 保存后调用 flushSkillStoreWrites() 等待落盘并上报失败，杜绝
 * 「界面提示已保存、重启后技能消失」的静默丢失。
 */
let customSkillsWriteTail: Promise<void> = Promise.resolve();
let lastCustomSkillsWriteError: unknown = null;

/** 等待排队中的 chrome.storage 写入完成；失败时返回可读错误（成功后错误状态复位） */
export async function flushSkillStoreWrites(): Promise<{ ok: boolean; error?: string }> {
  await customSkillsWriteTail;
  if (lastCustomSkillsWriteError !== null) {
    const error = lastCustomSkillsWriteError;
    const message =
      error instanceof Error ? error.message : error !== undefined ? String(error) : '未知错误';
    return { ok: false, error: message };
  }
  return { ok: true };
}

// ──── 写入原子性（导入的快照 / 回滚） ────

/**
 * 拍下当前自定义技能的深拷贝快照（导入等批量写入前的回滚点）。
 *
 * 背景：commitImportCandidates 先写内存表再排队持久化，落盘失败时内存表
 * 已包含新技能——列表会「显示已导入」而持久层没有，用户关页即丢、重试还会
 * 产生同名重复。写入方在批量提交前拍快照，flush 失败时回滚，保证
 * 「列表所见 = 持久层所存」。
 */
export function snapshotCustomSkills(): unknown[] {
  const items = Array.from(skillMap.values())
    .filter(s => s.source === 'custom')
    .map(serializeSkill);
  // 深拷贝隔离：回滚 rebuild 会逐条重建记录，快照绝不能与内存表共享引用
  return typeof structuredClone === 'function'
    ? structuredClone(items)
    : JSON.parse(JSON.stringify(items)) as unknown[];
}

/**
 * 回滚到快照（整体替换内存表并重新排队持久化；快照非法时保持现状并告警）。
 *
 * 破坏性前置校验：rebuildCustomSkills 是「清空后重建」的权威替换语义——
 * 对被污染的快照（非数组 / 含不可恢复条目）直接重建等于清空用户技能。
 * 回滚点只可能来自 snapshotCustomSkills 的序列化产物，任何不可恢复条目
 * 都意味着快照本身被篡改或代码缺陷：宁可放弃回滚（保持现状 + 显式告警），
 * 绝不用一次「成功的回滚」毁掉全部数据。空数组是合法回滚点（导入前就没有
 * 自定义技能），照常执行。
 */
export function rollbackCustomSkills(snapshot: unknown): void {
  try {
    if (!Array.isArray(snapshot)) {
      console.warn('[SkillStore] 回滚快照形态非法（非数组），已忽略回滚请求');
      return;
    }
    if (snapshot.length > 0) {
      // 试解全部条目（deserializeSkill 无副作用，不落内存表）：允许重复解析的
      // 一次性开销，换取「绝不清空」的确定性
      const validCount = snapshot.filter(item => deserializeSkill(item) !== null).length;
      if (validCount !== snapshot.length) {
        console.warn(
          `[SkillStore] 回滚快照含 ${snapshot.length - validCount} 条不可恢复记录，疑似被污染，已忽略回滚请求`,
        );
        return;
      }
    }
    rebuildCustomSkills(snapshot);
    persistCustomSkills();
    console.warn('[SkillStore] 自定义技能已回滚到导入前的快照');
  } catch (error) {
    // 回滚本身失败是最坏路径：内存表可能处于中间态，保持现状并显式告警，
    // 绝不再抛出（调用方已在展示错误，叠加异常只会掩盖根因）
    console.error('[SkillStore] 回滚自定义技能失败（内存表保持当前状态）:', error);
  }
}

// ──── 变更通知 ────

type ChangeListener = () => void;
const listeners = new Set<ChangeListener>();

/** 订阅技能集合变更（本上下文写入或跨上下文同步重建后触发）；返回退订函数 */
export function onSkillsChange(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyChange(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn('[SkillStore] 变更监听器执行失败:', error);
    }
  }
}

/** 序列化（剥离派生字段 body） */
function serializeSkill(skill: SkillRecord): StoredSkill {
  const { body: _body, ...rest } = skill;
  return rest;
}

/** 预置启停覆盖快照（按 id 仅保留停用项，减小存储体积） */
function presetToggleSnapshot(): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  for (const skill of skillMap.values()) {
    if (skill.source === 'preset' && !skill.enabled) {
      overrides[skill.id] = false;
    }
  }
  return overrides;
}

/** 持久化预置启停覆盖（localStorage 缓存 + chrome.storage 权威） */
function persistPresetToggles(): void {
  const overrides = presetToggleSnapshot();
  togglesFingerprint.mark(overrides);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PRESET_TOGGLE_STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    /* 缓存失败不阻断 */
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      void chrome.storage.local
        .set({ [PRESET_TOGGLE_STORAGE_KEY]: overrides })
        .catch(error => console.warn('[SkillStore] 预置启停写入 chrome.storage 失败:', error));
    }
  } catch {
    /* chrome 不可用时仅本地 */
  }
}

/**
 * 应用预置启停覆盖（外部数据防御：仅接受 { [预置技能id或旧版名称]: false } 形态）。
 * 键优先按 id 命中；未命中时按名称回落（兼容 v1 以名称为键的历史数据）。
 */
function applyPresetToggles(overrides: unknown): void {
  if (!overrides || typeof overrides !== 'object') return;
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (value !== false) continue;
    const byId = skillMap.get(key);
    if (byId?.source === 'preset') {
      byId.enabled = false;
      continue;
    }
    const idByNameHit = idByName.get(key);
    const byName = idByNameHit ? skillMap.get(idByNameHit) : undefined;
    if (byName?.source === 'preset') {
      byName.enabled = false;
    }
  }
}

/**
 * 反序列化（重新解析 body）。逐条防御：结构/类型不符或解析抛错时返回 null，绝不影响同批其它记录。
 * 旧版记录无 id：由名称经确定性哈希生成（与其它上下文一致）。
 */
function deserializeSkill(raw: unknown): SkillRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<StoredSkill>;
  if (typeof candidate.name !== 'string' || typeof candidate.files !== 'object' || candidate.files === null) {
    return null;
  }
  // files 值必须是字符串（外部写入/旧版本可能塞入任意 JSON），否则逐条跳过该键
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(candidate.files as Record<string, unknown>)) {
    if (typeof content === 'string') files[path] = content;
  }
  if (!files['SKILL.md']) return null;
  // id：显式存在且合法则沿用（跨版本稳定引用的前提）；否则由名称确定性生成
  const existingId =
    typeof candidate.id === 'string' && SKILL_ID_PATTERN.test(candidate.id)
      ? candidate.id
      : undefined;
  const id = existingId ?? generateSkillId(candidate.name, candidateId => skillMap.has(candidateId));
  try {
    const record = buildSkillRecord(
      candidate.name,
      files,
      'custom',
      id,
      candidate.enabled !== false,
    );
    if (!record) return null;
    // 持久化的 allowedTools 覆盖（setCustomSkill 显式传入时优于 frontmatter）：
    // 重建时同样应用，否则重启/跨上下文同步后覆盖静默回退到 frontmatter 值，
    // 造成「保存时生效、恢复后变样」的隐性不一致；经共享归一化保证形态不变
    if (Array.isArray(candidate.allowedTools)) {
      const normalized = normalizeAllowedToolList(candidate.allowedTools);
      if (normalized.length > 0) record.allowedTools = normalized;
    }
    // 显式目录（可能为空目录）随记录恢复：否则用户新建的空目录在重启后消失
    record.folders = normalizeFolderList(candidate.folders);
    return record;
  } catch (error) {
    console.warn(`[SkillStore] 自定义技能 "${candidate.name}" 解析失败，已跳过:`, error);
    return null;
  }
}

/** 把自定义技能写入权威源与缓存（先登记指纹再写 chrome.storage），并广播变更 */
function persistCustomSkills(): void {
  const customSkills = Array.from(skillMap.values())
    .filter(s => s.source === 'custom')
    .map(serializeSkill);
  skillsFingerprint.mark(customSkills);
  const payload = JSON.stringify(customSkills);
  // localStorage 同步缓存：超过安全上限（多文件技能）跳过——权威源不受影响
  try {
    if (typeof localStorage !== 'undefined' && payload.length <= LOCAL_MIRROR_MAX_CHARS) {
      localStorage.setItem(CUSTOM_SKILLS_STORAGE_KEY, payload);
    }
  } catch (error) {
    console.warn('[SkillStore] 持久化自定义技能到 localStorage 失败:', error);
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      // 串行排队写权威源；失败记录在案，由 flushSkillStoreWrites 向调用方上报
      customSkillsWriteTail = customSkillsWriteTail.then(async () => {
        try {
          await chrome.storage.local.set({ [CUSTOM_SKILLS_STORAGE_KEY]: customSkills });
          lastCustomSkillsWriteError = null;
        } catch (error) {
          lastCustomSkillsWriteError = error;
          console.error('[SkillStore] 写入 chrome.storage 失败（数据仍在本上下文内存，保存方应上报并重试）:', error);
        }
      });
    }
  } catch (error) {
    console.warn('[SkillStore] chrome.storage 不可用，本次仅写入内存/localStorage:', error);
  }
  notifyChange();
}

/**
 * 重建 / 恢复过程中的 id 冲突裁决。
 *
 * @param record 待入库记录（其 id 已与既有占用者相同）
 * @returns 应采用的新 id（调用方据此改写 record.id 后照常入库）；
 *          null = 判定为同一条记录的重复副本，跳过入库
 *
 * 三种情形分别处理，核心原则是「绝不静默丢数据」：
 *   1. 占用者是**内置技能**——自定义 id 落进了保留区间。任何正常版本的生成器
 *      都不会产出这种 id，只可能是外部写入的异常数据；改用确定性派生的新 id
 *      保住记录（新 id 必在非保留区间）；
 *   2. 占用者是**同名自定义技能**——同一逻辑记录的重复副本（跨上下文从同一份
 *      数据恢复的常见形态），以后到者跳过，语义等同于「同一记录只留一份」；
 *   3. 占用者是**异名自定义技能**——两条不同记录撞了 id，重新派生后并存。
 *
 * 重派生走 generateSkillId（同名 + 同初始占用状态 → 各上下文收敛到同一个新
 * id），避免各上下文对同一条记录各起一个名字。
 */
function resolveIdCollision(record: SkillRecord): string | null {
  const owner = skillMap.get(record.id);
  if (!owner) return record.id;
  if (owner.source !== 'preset' && owner.name === record.name) {
    console.warn(`[SkillStore] 自定义技能 id "${record.id}" 重复（${record.name}），后者已跳过`);
    return null;
  }
  const fresh = generateSkillId(record.name, candidate => skillMap.has(candidate));
  console.warn(
    `[SkillStore] 技能 "${record.name}" 的 id "${record.id}" 与${
      owner.source === 'preset' ? '内置技能' : `另一技能 "${owner.name}"`
    }冲突，已改用 "${fresh}" 保留数据（指向旧 id 的关联需重新绑定）`,
  );
  return fresh;
}

/**
 * 以给定自定义技能列表重建内存表（预置配置永不被移除/覆盖），刷新缓存并广播。
 * 用于启动恢复与跨上下文同步——对端的新增/修改/删除全部生效；
 * 单条损坏记录跳过并告警，不阻断同批其余记录；id 冲突经 resolveIdCollision
 * 裁决（重复副本跳过、不同技能改 id 保留，见其注释）。
 * 与预置同名的自定义记录照常入库：同名是常态，id 与模型标识均不冲突，
 * 按 id 的引用永不混淆（纯名称引用解析到先注册者，属旧数据兼容语义）。
 */
function rebuildCustomSkills(items: unknown): number {
  for (const [id, record] of Array.from(skillMap.entries())) {
    if (record.source === 'custom') skillMap.delete(id);
  }
  if (Array.isArray(items)) {
    for (const item of items) {
      try {
        const record = deserializeSkill(item);
        if (!record) continue;
        if (skillMap.has(record.id)) {
          const resolvedId = resolveIdCollision(record);
          if (resolvedId === null) continue;
          record.id = resolvedId;
        }
        skillMap.set(record.id, record);
      } catch (error) {
        console.warn('[SkillStore] 重建自定义技能时单条记录处理失败，已跳过:', error);
      }
    }
  }
  reindexNames();
  try {
    if (typeof localStorage !== 'undefined') {
      // 与 persistCustomSkills 同一安全上限：重建期间的缓存回写同样不能撑爆配额
      const snapshot = JSON.stringify(
        Array.from(skillMap.values()).filter(s => s.source === 'custom').map(serializeSkill),
      );
      if (snapshot.length <= LOCAL_MIRROR_MAX_CHARS) {
        localStorage.setItem(CUSTOM_SKILLS_STORAGE_KEY, snapshot);
      }
    }
  } catch {
    /* 缓存失败不影响内存态 */
  }
  notifyChange();
  return Array.from(skillMap.values()).filter(s => s.source === 'custom').length;
}

/** 启动时同步恢复：预置技能（保留区间确定性分配 id）→ 预置启停覆盖 → localStorage 自定义技能 */
function initStore(): void {
  for (const { folderName, files } of collectPresetSkillFiles()) {
    // 预置 id：保留区间 + 名称哈希（确定性，跨上下文 / 跨版本稳定），与智能体
    // 预设、工具→技能映射表里硬编码的 presetSkillIdFromName(...) 必须同源——
    // 两侧传入同一个技能名（frontmatter name），否则硬编码引用会落空
    const name = normalizeSkillName(parseFrontmatter(files['SKILL.md']).data['name'] || folderName);
    if (!name) continue;
    const id = presetSkillIdFromName(name);
    const preset = buildSkillRecord(folderName, files, 'preset', id);
    if (!preset) continue;
    // 理论不可达：两个内置技能同名（或确定性哈希碰撞）。跳过并显式告警，
    // 绝不覆盖先注册者——预置技能不落持久化，覆盖即静默丢失
    if (skillMap.has(preset.id)) {
      console.warn(`[SkillStore] 内置技能 id 冲突: "${preset.id}"（${name}），后者已跳过`);
      continue;
    }
    skillMap.set(preset.id, preset);
  }
  reindexNames();
  try {
    if (typeof localStorage === 'undefined') return;
    // 预置启停覆盖（缓存态；权威态在异步恢复时对账）
    const togglesRaw = localStorage.getItem(PRESET_TOGGLE_STORAGE_KEY);
    if (togglesRaw) {
      applyPresetToggles(JSON.parse(togglesRaw));
    }
    const raw = localStorage.getItem(CUSTOM_SKILLS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      const record = deserializeSkill(item);
      if (!record) continue;
      // id 冲突经同一裁决（与 rebuildCustomSkills 共用）：重复副本跳过、
      // 不同技能改 id 保留，绝不静默丢数据
      if (skillMap.has(record.id)) {
        const resolvedId = resolveIdCollision(record);
        if (resolvedId === null) continue;
        record.id = resolvedId;
      }
      skillMap.set(record.id, record);
    }
    reindexNames();
  } catch (error) {
    console.warn('[SkillStore] 从 localStorage 恢复自定义技能失败:', error);
  }
}

initStore();

/**
 * 异步恢复：chrome.storage.local 权威源对账（各上下文启动时 await 一次）。
 * 覆盖：localStorage 被清除后的恢复、本上下文启动期间其它页面的写入。
 * 自定义技能按权威列表整体重建（对端的删除同样生效）；预置启停覆盖独立对账。
 */
export async function restoreCustomSkillsFromStorage(): Promise<void> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const result = await chrome.storage.local.get([
      CUSTOM_SKILLS_STORAGE_KEY,
      PRESET_TOGGLE_STORAGE_KEY,
    ]);
    const stored = result?.[CUSTOM_SKILLS_STORAGE_KEY];
    if (Array.isArray(stored) && !skillsFingerprint.isOwn(stored)) {
      const count = rebuildCustomSkills(stored);
      if (count > 0) {
        console.log(`[SkillStore] 从 chrome.storage 恢复 ${count} 个自定义技能`);
      }
    }
    const toggles = result?.[PRESET_TOGGLE_STORAGE_KEY];
    if (toggles && typeof toggles === 'object' && !togglesFingerprint.isOwn(toggles)) {
      // 预置先复位为启用，再应用覆盖（对端重新启用的预置在本上下文同步生效）
      for (const record of skillMap.values()) {
        if (record.source === 'preset') record.enabled = true;
      }
      applyPresetToggles(toggles);
      notifyChange();
    }
  } catch (error) {
    console.warn('[SkillStore] chrome.storage 恢复失败:', error);
  }
}

// 跨上下文同步订阅：其它页面写入 → 重建/应用并广播（自事件已被指纹跳过）
subscribeStorageKey(CUSTOM_SKILLS_STORAGE_KEY, skillsFingerprint, newValue => {
  rebuildCustomSkills(newValue);
});
subscribeStorageKey(PRESET_TOGGLE_STORAGE_KEY, togglesFingerprint, newValue => {
  for (const record of skillMap.values()) {
    if (record.source === 'preset') record.enabled = true;
  }
  applyPresetToggles(newValue);
  notifyChange();
});

// ──── 查询 API ────

/** 全部技能（预置在前 + 自定义按名称稳定排序） */
export function getAllSkills(): SkillRecord[] {
  const presets: SkillRecord[] = [];
  const customs: SkillRecord[] = [];
  for (const skill of skillMap.values()) {
    (skill.source === 'preset' ? presets : customs).push(skill);
  }
  customs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return [...presets, ...customs, ...pluginSkills()];
}

/** 所有启用状态的技能（可用清单注入与 load_skill 报错回显的口径；「/」卡片用同一口径自行过滤） */
export function getEnabledSkills(): SkillRecord[] {
  return getAllSkills().filter(s => s.enabled);
}

/** 按 id 精确获取技能（首选查询路径） */
export function getSkillById(id: string): SkillRecord | undefined {
  return id.startsWith('ed25519:') ? pluginSkills().find(s => s.id === id) : skillMap.get(id);
}

/** 按名称获取技能（同名时命中先注册者；仅供旧数据兼容与默认名避让，新引用走 id） */
export function getSkillByName(name: string): SkillRecord | undefined {
  const id = idByName.get(name);
  return id === undefined ? undefined : skillMap.get(id);
}

/**
 * 解析技能引用（id / 模型标识 name-id / 名称，三者按序命中）。
 *
 * 优先级设计：
 *   1. id 精确命中 —— 一切持久化引用（智能体关联、会话回显）的唯一锚点；
 *   2. 模型标识 `${name}-${id}` 精确命中 —— load_skill / read_skill_file 的
 *      规范入参，先于纯名称匹配（名称可能是模型标识的前缀）；
 *   3. 名称命中 —— 人工输入与旧会话历史（v1 以名称持久化）的兜底。
 *      技能允许同名：名称命中返回首个注册者，因此新数据一律按 id / 模型标识
 *      引用，名称解析只对旧数据负责。
 */
export function resolveSkill(ref: string): SkillRecord | undefined {
  const trimmed = typeof ref === 'string' ? ref.trim() : '';
  if (!trimmed) return undefined;

  if (trimmed.startsWith('ed25519:')) return pluginSkills().find(s => s.id === trimmed);
  const byId = skillMap.get(trimmed);
  if (byId) return byId;

  for (const skill of skillMap.values()) {
    if (composeModelSkillId(skill.name, skill.id) === trimmed) return skill;
  }

  const idByNameHit = idByName.get(trimmed);
  return idByNameHit === undefined ? undefined : skillMap.get(idByNameHit);
}

/**
 * 生成未占用的技能名：冲突时追加 -2/-3…（确定性保证跨上下文一致）。
 *
 * 同名技能已合法，本函数不再服务于「能不能存」——只为新建表单提供一个不与
 * 既有技能撞车的默认名（管理页学习草稿预填用）。撞车也不影响保存结果，
 * 用户仍可手动改回原名。
 */
export function uniqueSkillName(base: string): string {
  let candidate = base;
  let counter = 2;
  while (idByName.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
    if (counter > 999) {
      candidate = `${base}-${Date.now().toString(36)}`;
      break;
    }
  }
  return candidate;
}

// ──── 写入 API（仅自定义技能） ────

/** 写入失败原因（管理页据此给出精确可读提示） */
export type SkillWriteFailureReason =
  | 'invalid'
  /** 编辑目标已被其它页面删除（编辑器还开着旧副本） */
  | 'not-found';

export type SkillWriteResult =
  | { ok: true; skill: SkillRecord }
  | { ok: false; reason: SkillWriteFailureReason };

/**
 * 新增或更新自定义技能。
 * @param input 名称（自动规范化；允许与既有技能同名）、files（须含 SKILL.md）、
 *   id（编辑时沿用原 id）与可选属性；新技能缺省 id 时在非保留区间内随机生成
 * @returns 写入结果（失败附精确原因）
 */
export function setCustomSkill(input: {
  id?: string;
  name: string;
  files: Record<string, string>;
  /** 显式目录（含空目录）：相对路径列表，经归一化后随记录持久化 */
  folders?: string[];
  description?: string;
  compatibility?: string;
  license?: string;
  allowedTools?: string[];
  enabled?: boolean;
}): SkillWriteResult {
  // 名称规范化 + 合法性（与 buildSkillRecord 内部校验同一 pattern：此处早退
  // 省去后续构建，双重校验保持防御一致性）
  const normalizedName = normalizeSkillName(input.name || '');
  if (!normalizedName || !SKILL_NAME_PATTERN.test(normalizedName)) {
    return { ok: false, reason: 'invalid' };
  }

  // id 解析：显式传入须命中既有自定义技能（编辑场景；未命中 = 编辑期间已被
  // 其它页面删除，精确报因而非误导性的「表单不合法」）；新建场景在非保留
  // 区间内随机取号 + 写前占用确认（并发保护，见 generateUniqueSkillId）
  let id: string;
  if (input.id) {
    const existing = skillMap.get(input.id);
    if (!existing) {
      return { ok: false, reason: 'not-found' };
    }
    if (existing.source !== 'custom') {
      return { ok: false, reason: 'invalid' };
    }
    id = input.id;
  } else {
    id = generateUniqueSkillId(candidate => skillMap.has(candidate));
  }

  const record = buildSkillRecord(normalizedName, input.files, 'custom', id, input.enabled !== false);
  if (!record) return { ok: false, reason: 'invalid' };

  // 名称不查重：同名是常态（见文件头身份模型），id 与模型标识已足够消歧。
  // 编辑自身改名到任意既有名称同样放行——不存在「与谁冲突」的概念。

  // 显式传入的可选字段优先（frontmatter 中的值作为回落）；
  // allowedTools 经共享归一化（去空白 + 去重保序，见 skill-types）——外部输入
  // （导入/备份恢复）不受 frontmatter 编辑器约束，脏形态不应入库并向激活段/请求侧扩散
  if (input.description) record.description = input.description;
  if (Array.isArray(input.allowedTools)) {
    record.allowedTools = normalizeAllowedToolList(input.allowedTools);
  }
  if (input.compatibility) record.compatibility = input.compatibility;
  if (input.license) record.license = input.license;
  // 显式目录（含空目录）恒以归一化形态入库——形状统一，空目录不因缺省而丢失
  record.folders = normalizeFolderList(input.folders);
  skillMap.set(record.id, record);
  reindexNames();
  persistCustomSkills();
  return { ok: true, skill: record };
}

/** 删除自定义技能（按 id；预置技能不可删） */
export function removeCustomSkill(id: string): boolean {
  const record = skillMap.get(id);
  if (!record || record.source === 'preset') return false;
  skillMap.delete(id);
  reindexNames();
  persistCustomSkills();
  return true;
}

/** 切换启用状态（按 id；自定义入自定义持久化，预置写启停覆盖，均跨上下文同步） */
export function setSkillEnabled(id: string, enabled: boolean): boolean {
  const record = skillMap.get(id);
  if (!record) return false;
  if (record.source === 'custom') {
    record.enabled = enabled;
    persistCustomSkills();
  } else {
    record.enabled = enabled;
    persistPresetToggles();
    notifyChange();
  }
  return true;
}

export type { SkillRecord, StoredSkill };

onPluginsChange(notifyChange);

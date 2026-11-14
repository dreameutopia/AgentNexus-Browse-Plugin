import { allocateSkillIdentity, isSkillId, isBuiltinSkillId } from './skill-identity';
import { onPluginsChange } from '@/utils/plugins/catalog';
import { withNamedLock } from '@/utils/shared/async-lock';
import { withAgentSkillAssociation } from '@/utils/agents/agent-skill-links';
import { errorDetails } from '@/utils/shared/error-details';
import { SKILLS_STORAGE_KEY as CUSTOM_SKILLS_STORAGE_KEY, SKILLS_REVISION_KEY as CUSTOM_SKILLS_REVISION_KEY, SKILL_TOGGLES_STORAGE_KEY as PRESET_TOGGLE_STORAGE_KEY } from './skill-storage';
/** Skill storage: built-ins use the protected static 1..1000 map; local and imported Skills use durable numeric IDs >=1001. Names are metadata, never lookup keys. */
import type { SkillRecord, StoredSkill } from './skill-types';
import { decodeSkillBytes, decodeSkillText, isSkillResourcePath, validateSkillBinaries, validateSkillFolders } from './skill-resources';
import { SKILL_NAME_PATTERN, SKILL_NAME_MAX_CHARS, SKILL_ID_PATTERN, SKILL_IMPORT_MAX_FILES, SKILL_IMPORT_MAX_FILE_CHARS, SKILL_IMPORT_MAX_TOTAL_CHARS, SKILL_DESCRIPTION_MAX_CHARS, SKILL_RESOURCE_MAX_TOTAL_BYTES, presetSkillIdFromName, normalizeAllowedToolList } from './skill-types';
import { parseFrontmatter, normalizeSkillName, parseAllowedTools, parseSkillTags, updateSkillFrontmatter } from './frontmatter-parser';
import { AGENT_CATEGORY_UNCATEGORIZED, normalizeCategory } from '../agents/agent-types';
import { LocalWriteFingerprint, subscribeStorageKey } from '../shared/storage-sync';
// ──── 预置技能加载（构建期打包） ────
/** The Vite asset loader preserves bytes for all resource types, including SVG. */
const presetFileModules = import.meta.glob(['/skills/**/*', '!/skills/**/.git/**'], {
    query: '?agentnexus-skill-bytes',
    import: 'default',
    eager: true,
    exhaustive: true,
}) as Record<string, string>;
/** 从 glob 结果分组，返回「目录名 → 文件集」（记录构建与 id 分配由 initStore 统一执行） */
function collectPresetSkillFiles() {
    const bySkill = new Map<string, {
        folderName: string;
        files: Record<string, string>;
        resourceBytes: Record<string, string>;
    }>();
    const invalid = new Set<string>();
    for (const [path, encoded] of Object.entries(presetFileModules)) {
        const match = path.match(/^\/skills\/([^/]+)\/(.+)$/);
        if (!match)
            continue;
        const [, folderName, relative] = match;
        try {
            if (!isSkillResourcePath(relative))
                throw new Error('Invalid bundled skill asset');
            const content = decodeSkillText(decodeSkillBytes(encoded));
            let entry = bySkill.get(folderName);
            if (!entry) {
                entry = { folderName, files: Object.create(null), resourceBytes: Object.create(null) };
                bySkill.set(folderName, entry);
            }
            if (content === undefined)
                entry.resourceBytes[relative] = encoded;
            else
                entry.files[relative] = content;
        }
        catch (error) {
            invalid.add(folderName);
            console.warn('[SkillStore] Cannot load bundled skill resource:', path, error);
        }
    }
    return [...bySkill.values()].filter(entry => !invalid.has(entry.folderName) && !!entry.files['SKILL.md']);
}
// ──── 记录构建 ────
/**
 * 由文件集合解析 frontmatter 并构建运行时记录；SKILL.md 缺失或名称非法时返回 null。
 * id 由调用方指定（新建场景由事务分配器生成；编辑场景沿用原 id；
 * 预置场景传入 presetSkillIdFromName 结果）。
 */
function buildSkillRecord(name: string, files: Map<string, string> | Record<string, string>, source: SkillRecord['source'], id: string, enabled = true): SkillRecord | null {
    const fileMap = files instanceof Map ? files : new Map(Object.entries(files));
    if (fileMap.size > SKILL_IMPORT_MAX_FILES)
        return null;
    let total = 0, bytes = 0;
    for (const [path, content] of fileMap) {
        if (!isSkillResourcePath(path) || typeof content !== 'string' || content.length > SKILL_IMPORT_MAX_FILE_CHARS)
            return null;
        total += content.length;
        bytes += new Blob([content]).size;
        if (total > SKILL_IMPORT_MAX_TOTAL_CHARS || bytes > SKILL_RESOURCE_MAX_TOTAL_BYTES)
            return null;
    }
    try {
        validateSkillBinaries({}, Object.fromEntries(fileMap));
    }
    catch {
        return null;
    }
    const skillMd = fileMap.get('SKILL.md');
    if (!skillMd) {
        console.warn(`[SkillStore] 技能 ${name} 缺少 SKILL.md，跳过`);
        return null;
    }
    const { data, body } = parseFrontmatter(skillMd.replace(/^\uFEFF/, ''));
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
    if (!isSkillId(id)) {
        console.warn(`[SkillStore] 技能 ${normalizedName} 的 id "${id}" 不合法，跳过`);
        return null;
    }
    const description = (data['description'] || '').trim();
    if (!description || description.length > SKILL_DESCRIPTION_MAX_CHARS) {
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
/** Skill records have one authoritative storage source. */
let restoredRevision: unknown;
let pendingRevision: string | undefined;
let restored = false;
let restorePending: Promise<void> | undefined;
/** 内存中的技能表（预置 + 自定义），键为技能 id */
const skillMap = new Map<string, SkillRecord>();
/** Preset toggle payloads are small; only these need a structural write fingerprint. */
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
export async function flushSkillStoreWrites(): Promise<{
    ok: boolean;
    error?: string;
}> {
    await customSkillsWriteTail;
    if (lastCustomSkillsWriteError !== null) {
        const error = lastCustomSkillsWriteError;
        const message = errorDetails(error);
        return { ok: false, error: message };
    }
    return { ok: true };
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
        }
        catch (error) {
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
/** Persist preset toggles to the authoritative source. */
async function persistPresetToggles(): Promise<boolean> {
    const overrides = presetToggleSnapshot();
    togglesFingerprint.mark(overrides);
    try { await chrome.storage.local.set({ [PRESET_TOGGLE_STORAGE_KEY]: overrides }); }
    catch { return false; }
    return true;
}
/**
 * 应用预置启停覆盖，仅接受 { [数字技能 ID]: false }。
 */
function applyPresetToggles(overrides: unknown): void {
    if (!overrides || typeof overrides !== 'object')
        return;
    for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
        if (value !== false)
            continue;
        const byId = skillMap.get(key);
        if (['4', '5'].includes(key))
            continue;
        if (byId?.source === 'preset') {
            byId.enabled = false;
            continue;
        }
    }
}
/**
 * 反序列化（重新解析 body）。逐条防御：结构/类型不符或解析抛错时返回 null，绝不影响同批其它记录。
 * 只接受当前数字 ID 与身份键格式。
 */
function deserializeSkill(raw: unknown): SkillRecord | null {
    if (!raw || typeof raw !== 'object')
        return null;
    const candidate = raw as Partial<StoredSkill>;
    if (typeof candidate.name !== 'string' || typeof candidate.files !== 'object' || candidate.files === null) {
        return null;
    }
    // files 值必须是字符串（外部写入/旧版本可能塞入任意 JSON），否则逐条跳过该键
    const files: Record<string, string> = Object.create(null);
    for (const [path, content] of Object.entries(candidate.files as Record<string, unknown>)) {
        if (typeof content === 'string')
            files[path] = content;
    }
    if (!files['SKILL.md'])
        return null;
    // 持久化 ID 与身份键缺失时丢弃，不推断或迁移。
    const existingId = typeof candidate.id === 'string' && SKILL_ID_PATTERN.test(candidate.id)
        ? candidate.id
        : undefined;
    if (!existingId || isBuiltinSkillId(existingId))
        return null;
    const id = existingId;
    try {
        const record = buildSkillRecord(candidate.name, files, 'custom', id, candidate.enabled !== false);
        if (!record)
            return null;
        if (typeof candidate.identityKey !== 'string' || !candidate.identityKey ||
            !Number.isSafeInteger(candidate.updatedAt) || candidate.updatedAt! < 0) return null;
        record.identityKey = candidate.identityKey;
        record.updatedAt = candidate.updatedAt!;
        if (candidate.origin && typeof candidate.origin === 'object')
            record.origin = candidate.origin;
        // Metadata is derived from SKILL.md; persisted derivatives never override it.
        // 显式目录（可能为空目录）随记录恢复：否则用户新建的空目录在重启后消失
        record.folders = validateSkillFolders(candidate.folders, record.files, candidate.resourceBytes);
        if (candidate.resourceBytes !== undefined)
            record.resourceBytes = validateSkillBinaries(candidate.resourceBytes, files);
        return record;
    }
    catch (error) {
        console.warn(`[SkillStore] 自定义技能 "${candidate.name}" 解析失败，已跳过:`, error);
        return null;
    }
}
/** Commit records and revision together, then notify subscribers. */
function persistCustomSkills(extra: Record<string, unknown> = {}): void {
    const customSkills = Array.from(skillMap.values()).filter(skill => skill.source === 'custom').map(serializeSkill);
    customSkillsWriteTail = customSkillsWriteTail.then(async () => {
        try {
            const revision = crypto.randomUUID();
            pendingRevision = revision;
            await chrome.storage.local.set({ ...extra, [CUSTOM_SKILLS_STORAGE_KEY]: customSkills, [CUSTOM_SKILLS_REVISION_KEY]: revision });
            restoredRevision = revision;
            restored = true;
            lastCustomSkillsWriteError = null;
        } catch (error) {
            lastCustomSkillsWriteError = error;
            console.error('[SkillStore] Skill persistence failed; caller must report the failed operation:', error);
            return;
        } finally { pendingRevision = undefined; }
        notifyChange();
    });
}
/**
 * 以给定自定义技能列表重建内存表（预置配置永不被移除/覆盖），刷新缓存并广播。
 * 用于启动恢复与跨上下文同步——对端的新增/修改/删除全部生效；
 * 单条损坏记录跳过并告警；重复数字 ID 拒绝覆盖。
 * 同名记录按唯一数字 ID 共存，运行时不做名称解析。
 */
function rebuildCustomSkills(items: unknown): number {
    for (const [id, record] of Array.from(skillMap.entries())) {
        if (record.source === 'custom')
            skillMap.delete(id);
    }
    if (Array.isArray(items)) {
        for (const item of items) {
            try {
                const record = deserializeSkill(item);
                if (!record)
                    continue;
                if (skillMap.has(record.id)) {
                    console.warn('[SkillStore] Duplicate persisted Skill ID skipped', record.id);
                    continue;
                }
                skillMap.set(record.id, record);
            }
            catch (error) {
                console.warn('[SkillStore] 重建自定义技能时单条记录处理失败，已跳过:', error);
            }
        }
    }
    notifyChange();
    return Array.from(skillMap.values()).filter(s => s.source === 'custom').length;
}
/** Initialize bundled presets; persisted data is loaded asynchronously on demand. */
function initStore(): void {
    for (const { folderName, files, resourceBytes } of collectPresetSkillFiles()) {
        // Registered built-in IDs must match presets and tool mappings.
        const name = normalizeSkillName(parseFrontmatter(files['SKILL.md'].replace(/^\uFEFF/, '')).data['name'] || folderName);
        if (!name)
            continue;
        const id = presetSkillIdFromName(name);
        const preset = buildSkillRecord(folderName, files, 'preset', id);
        if (!preset)
            continue;
        if (Object.keys(resourceBytes).length) {
            try {
                preset.resourceBytes = validateSkillBinaries(resourceBytes, files);
            }
            catch (error) {
                console.warn('[SkillStore] Invalid bundled skill resources:', folderName, error);
                continue;
            }
        }
        // 理论不可达：两个内置技能同名（或确定性哈希碰撞）。跳过并显式告警，
        // 绝不覆盖先注册者——预置技能不落持久化，覆盖即静默丢失
        if (skillMap.has(preset.id)) {
            console.warn(`[SkillStore] 内置技能 id 冲突: "${preset.id}"（${name}），后者已跳过`);
            continue;
        }
        skillMap.set(preset.id, preset);
    }
}
initStore();
/**
 * 异步恢复：chrome.storage.local 权威源对账（各上下文启动时 await 一次）。
 * 本上下文启动及其它页面写入后通过版本号按需读取文件记录。
 * 自定义技能按权威列表整体重建（对端的删除同样生效）；预置启停覆盖独立对账。
 */
export async function restoreCustomSkillsFromStorage(strict = false): Promise<void> {
    if (restorePending) return strict ? restorePending : restorePending.catch(error => console.warn('[SkillStore] Restore failed:', error));
    const operation = async () => {
        if (typeof chrome === 'undefined' || !chrome.storage?.local) {
            throw new Error('[SKILL_STORAGE_UNAVAILABLE] Skill storage is unavailable');
        }
        const result = await chrome.storage.local.get([CUSTOM_SKILLS_REVISION_KEY, PRESET_TOGGLE_STORAGE_KEY]);
        if (!restored || restoredRevision !== result[CUSTOM_SKILLS_REVISION_KEY]) {
            const snapshot = await chrome.storage.local.get([CUSTOM_SKILLS_STORAGE_KEY, CUSTOM_SKILLS_REVISION_KEY]);
            const stored = snapshot[CUSTOM_SKILLS_STORAGE_KEY];
            if (stored !== undefined && !Array.isArray(stored)) throw new Error('[SKILL_STORAGE_INVALID] Skill records must be an array');
            for (const candidate of stored ?? []) {
                if (!candidate || !isSkillId(candidate.id) || isBuiltinSkillId(candidate.id) || typeof candidate.identityKey !== 'string') continue;
                if (await allocateSkillIdentity(candidate.identityKey, candidate.id) !== candidate.id) {
                    throw new Error('[SKILL_ID_CONFLICT] Stored Skill ' + candidate.id + ' belongs to another identity; no records were overwritten');
                }
            }
            rebuildCustomSkills(stored ?? []);
            restoredRevision = snapshot[CUSTOM_SKILLS_REVISION_KEY];
            restored = true;
        }
        const toggles = result[PRESET_TOGGLE_STORAGE_KEY];
        if (toggles === undefined || (toggles && typeof toggles === 'object' && !Array.isArray(toggles))) {
            const previous = JSON.stringify(presetToggleSnapshot());
            // 预置先复位为启用，再应用覆盖（对端重新启用的预置在本上下文同步生效）
            for (const record of skillMap.values()) {
                if (record.source === 'preset')
                    record.enabled = true;
            }
            applyPresetToggles(toggles);
            if (previous !== JSON.stringify(presetToggleSnapshot())) notifyChange();
        }
    };
    restorePending = operation();
    try { await restorePending; }
    catch (error) {
        restored = false;
        if (strict) throw error;
        console.warn('[SkillStore] Restore failed:', error);
    } finally { restorePending = undefined; }
}
// 跨上下文同步订阅：其它页面写入 → 重建/应用并广播（自事件已被指纹跳过）
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[CUSTOM_SKILLS_STORAGE_KEY]) return;
    const revision = changes[CUSTOM_SKILLS_REVISION_KEY]?.newValue;
    if (typeof revision === 'string' && (revision === pendingRevision || restored && revision === restoredRevision)) return;
    restored = false;
    const next = changes[CUSTOM_SKILLS_STORAGE_KEY].newValue;
    if (next === undefined || Array.isArray(next)) void restoreCustomSkillsFromStorage();
    else console.error('[SKILL_STORAGE_INVALID] Ignored invalid Skill collection');
});
subscribeStorageKey(PRESET_TOGGLE_STORAGE_KEY, togglesFingerprint, newValue => {
    for (const record of skillMap.values()) {
        if (record.source === 'preset')
            record.enabled = true;
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
    return [...presets, ...customs];
}
/** 所有启用状态的技能（发现清单与加载工具同源）。 */
export function getEnabledSkills(): SkillRecord[] {
    return getAllSkills().filter(s => s.enabled);
}
/** Exact decimal ID lookup; resource refs and names are not Skill identities. */
export function getSkillById(id: string): SkillRecord | undefined {
    if (!isSkillId(id))
        return undefined;
    return skillMap.get(id);
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
    while ([...skillMap.values()].some(skill => skill.name === candidate)) {
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
export type SkillWriteFailureReason = 'invalid'
/** 编辑目标已被其它页面删除（编辑器还开着旧副本） */
 | 'not-found' | 'storage' | 'conflict';
export type SkillWriteResult = {
    ok: true;
    skill: SkillRecord;
} | {
    ok: false;
    reason: SkillWriteFailureReason;
    error?: string;
};
/**
 * 新增或更新自定义技能。
 * @param input 名称（自动规范化；允许与既有技能同名）、files（须含 SKILL.md）、
 *   id（编辑时沿用原 id）与可选属性；新技能通过事务分配器递增取号
 * @returns 写入结果（失败附精确原因）
 */
export async function setCustomSkill(input: {
    id?: string;
    name: string;
    files: Record<string, string>;
    resourceBytes?: Record<string, string>;
    /** 显式目录（含空目录）：相对路径列表，经归一化后随记录持久化 */
    folders?: string[];
    description?: string;
    compatibility?: string;
    license?: string;
    allowedTools?: string[];
    enabled?: boolean;
    expectedUpdatedAt?: number;
    signal?: AbortSignal;
    managedIdentity?: string;
    associateAgentId?: string;
    origin?: SkillRecord['origin'];
}): Promise<SkillWriteResult> {
    return withSkillStoreMutation(async () => {
        input.signal?.throwIfAborted();
        // 名称规范化 + 合法性（与 buildSkillRecord 内部校验同一 pattern：此处早退
        // 省去后续构建，双重校验保持防御一致性）
        const normalizedName = normalizeSkillName(input.name || '');
        if (!normalizedName || !SKILL_NAME_PATTERN.test(normalizedName)) {
            return { ok: false, reason: 'invalid' };
        }
        // id 解析：显式传入须命中既有自定义技能（编辑场景；未命中 = 编辑期间已被
        // 其它页面删除，精确报因而非误导性的「表单不合法」）；新建场景在非保留
        // A durable transaction allocator serializes IDs across extension contexts.
        let id: string;
        let identityKey: string | undefined;
        if (input.id) {
            const existing = skillMap.get(input.id);
            if (existing && input.managedIdentity && existing.identityKey !== input.managedIdentity) return { ok: false, reason: 'conflict', error: 'Skill ID belongs to another identity' };
            if (!existing && (!input.managedIdentity?.startsWith('plugin:') || isBuiltinSkillId(input.id)))
                return { ok: false, reason: 'not-found' };
            if (input.managedIdentity && await allocateSkillIdentity(input.managedIdentity, input.id) !== input.id)
                return { ok: false, reason: 'invalid' };
            if (input.expectedUpdatedAt !== undefined && existing?.updatedAt !== input.expectedUpdatedAt)
                return { ok: false, reason: 'conflict' };
            if (existing && existing.source !== 'custom') {
                return { ok: false, reason: 'invalid' };
            }
            id = input.id;
        }
        else {
            identityKey = 'custom:new:' + crypto.randomUUID();
            id = await allocateSkillIdentity(identityKey);
        }
        let files = input.files;
        try {
            const overrides: Record<string, string> = {};
            for (const key of ['description', 'compatibility', 'license'] as const) if (input[key] !== undefined) {
                if (typeof input[key] !== 'string' || input[key]!.length > 1024) throw new Error('Invalid Skill metadata: ' + key);
                overrides[key] = input[key]!;
            }
            if (input.allowedTools !== undefined) overrides['allowed-tools'] = normalizeAllowedToolList(input.allowedTools).join(' ');
            if (Object.keys(overrides).length) files = { ...files, 'SKILL.md': updateSkillFrontmatter(files['SKILL.md'], overrides) };
        } catch (error) { return { ok: false, reason: 'invalid', error: errorDetails(error) }; }
        const record = buildSkillRecord(normalizedName, files, 'custom', id, input.enabled !== false);
        if (!record)
            return { ok: false, reason: 'invalid' };
        const resourceBytes = input.resourceBytes ?? skillMap.get(id)?.resourceBytes;
        if (resourceBytes !== undefined) {
            try {
                record.resourceBytes = validateSkillBinaries(resourceBytes, record.files);
            }
            catch (error) {
                console.warn('[SkillStore] Invalid skill resources:', error);
                return { ok: false, reason: 'invalid' };
            }
        }
        // 名称不查重：同名技能仅用唯一 ID 消歧。
        // 编辑自身改名到任意既有名称同样放行——不存在「与谁冲突」的概念。
        // 显式传入的可选字段优先（frontmatter 中的值作为回落）；
        // allowedTools 经共享归一化（去空白 + 去重保序，见 skill-types）——外部输入
        // （导入/备份恢复）不受 frontmatter 编辑器约束，脏形态不应入库并向激活段/请求侧扩散
        // 显式目录（含空目录）恒以归一化形态入库——形状统一，空目录不因缺省而丢失
        try { record.folders = validateSkillFolders(input.folders ?? skillMap.get(id)?.folders, record.files, record.resourceBytes); }
        catch (error) { return { ok: false, reason: 'invalid', error: errorDetails(error) }; }
        record.identityKey = input.managedIdentity ?? (input.id ? skillMap.get(input.id)?.identityKey : identityKey);
        record.origin = input.origin ?? (input.id ? skillMap.get(input.id)?.origin : undefined);
        record.updatedAt = Math.max(Date.now(), (skillMap.get(id)?.updatedAt ?? 0) + 1);
        const previous = skillMap.get(record.id);
        skillMap.set(record.id, record);
        let flushed: Awaited<ReturnType<typeof flushSkillStoreWrites>>;
        try {
            const commit = async (extra: Record<string, unknown> = {}) => {
                input.signal?.throwIfAborted();
                persistCustomSkills(extra);
                const result = await flushSkillStoreWrites();
                if (!result.ok) throw new Error(result.error || 'Skill persistence failed');
                return result;
            };
            flushed = input.associateAgentId
                ? await withAgentSkillAssociation(input.associateAgentId, id, commit)
                : await commit();
        } catch (error) { flushed = { ok: false, error: errorDetails(error) }; }
        if (!flushed.ok) {
            if (previous)
                skillMap.set(record.id, previous);
            else
                skillMap.delete(record.id);
            notifyChange();
            return { ok: false, reason: 'storage', error: flushed.error };
        }
        return { ok: true, skill: record };
    });
}
/** 删除自定义技能（按 id；预置技能不可删） */
export async function removeCustomSkill(id: string, expectedUpdatedAt?: number, signal?: AbortSignal): Promise<boolean> {
    return withSkillStoreMutation(async () => {
        signal?.throwIfAborted();
        const record = skillMap.get(id);
        if (!record || isBuiltinSkillId(record.id) || (expectedUpdatedAt !== undefined && record.updatedAt !== expectedUpdatedAt))
            return false;
        skillMap.delete(id);
        persistCustomSkills();
        const flushed = await flushSkillStoreWrites();
        if (!flushed.ok) {
            skillMap.set(id, record);
            notifyChange();
            throw new Error('[SKILL_STORAGE_ERROR] Delete was not committed: ' + (flushed.error ?? 'Unknown storage error'));
        }
        return true;
    });
}
/** 切换启用状态（按 id；自定义入自定义持久化，预置写启停覆盖，均跨上下文同步） */
export async function setSkillEnabled(id: string, enabled: boolean): Promise<boolean> {
    return withSkillStoreMutation(async () => {
        if (['4', '5'].includes(id) && !enabled)
            return false;
        const record = skillMap.get(id);
        if (!record)
            return false;
        if (record.source === 'custom') {
            const previous = record.enabled, previousUpdatedAt = record.updatedAt;
            record.enabled = enabled;
            record.updatedAt = Math.max(Date.now(), record.updatedAt + 1);
            persistCustomSkills();
            if (!(await flushSkillStoreWrites()).ok) {
                record.enabled = previous;
                record.updatedAt = previousUpdatedAt;
                notifyChange();
                return false;
            }
        }
        else {
            const previous = record.enabled;
            record.enabled = enabled;
            if (!await persistPresetToggles()) {
                record.enabled = previous;
                notifyChange();
                return false;
            }
            notifyChange();
        }
        return true;
    });
}
export type { SkillRecord, StoredSkill };
onPluginsChange(notifyChange);
async function withSkillStoreMutation<T>(work: () => Promise<T>): Promise<T> {
    return withNamedLock('agentnexus-skill-store', async () => {
        await flushSkillStoreWrites();
        await restoreCustomSkillsFromStorage(true);
        return work();
    });
}

import { createPluginsBackupHandler } from '@/utils/plugins/backup';
/**
 * 数据分区处理器注册表（备份引擎的「数据面」）
 *
 * 每个分区一个 handler，实现 types.ts 的 SectionHandler 契约：
 *   collect()  → 导出采集（无数据返回 null → 该分区不进备份文件）
 *   validate() → 纯结构校验（全部分区先校验、任一失败零写入）
 *   apply()    → 按策略写入；**抛错时自身状态必须不变**（写前快照 + 失败还原），
 *                成功后返回跨分区回滚闭包
 *
 * 设计约束（防止「统计缺数 / 备份漏项」这类静默故障）：
 * 1. **键名单一事实源**：所有 chrome.storage.local / localStorage 键都取自
 *    storage-keys.ts，源模块改名时只改一处；
 * 2. **写入走源模块 API**：会话/图片/笔记/捕获文件的恢复一律调用其宿主模块的
 *    原子恢复方法（单事务），从而保住「唯一索引」「计数不变量」「缓存失效」
 *    这些由源模块精心维护的约束——绕开它们直接写 IDB 会制造脏数据；
 * 3. **失败即还原**：任何分区写入过程中抛错，先用写前快照还原本分区，
 *    再把错误抛给编排器（编排器负责回滚**其它**已写分区）；
 * 4. **收集失败不吞**：collect 抛错由编排器记入 issues 并跳过该分区，
 *    绝不静默返回「空数组」——空数组与「没有数据」在备份里含义完全不同。
 */

import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { imageDatabase } from '@/entrypoints/sidepanel/core/images/image-database';
import type { ChatMessageRecord, ChatSessionMeta } from '@/entrypoints/sidepanel/core/types';
import { notesDB } from '@/utils/notes-database';
import { downloadDB, type CapturedFileRecord } from '@/utils/download-database';
import type { Note } from '@/types';

import { base64ToBytes, bytesToBase64 } from './bytes';
import { decodeWorkspaceBackups, encodeWorkspaceBackups } from './workspace-backup';
import {
  AGENTS_STORAGE_KEY,
  FILES_STORAGE_KEY,
  LOCAL_MIRROR_KEYS,
  MISC_CHROME_KEYS,
  MISC_LOCAL_KEYS,
  PLANS_STORAGE_KEY,
  SKILLS_STORAGE_KEY,
  SKILLS_REVISION_KEY,
  SKILL_TOGGLES_STORAGE_KEY,
  SKILL_LIFECYCLE_KEYS,
  USAGE_METRICS_STORAGE_KEY,
} from './storage-keys';
import type { BackupAreaLike } from './ports';
import type { LocalStoreLike } from '../config/types';
import type {
  AgentsPayload,
  ApplyOutcome,
  BackupStrategy,
  CapturedFileBackupEntry,
  CapturedFilesPayload,
  ConversationsPayload,
  FilesPayload,
  ImageBackupEntry,
  ImagesPayload,
  MetricsPayload,
  MiscPayload,
  NotesPayload,
  PlansPayload,
  SectionHandler,
  SkillsPayload,
} from './types';

// ==================== 通用工具 ====================

/** 是否为普通对象（非数组、非 null） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 值能否被 JSON 序列化（备份文件是 JSON 文本）。
 *
 * 循环引用会让 JSON.stringify 抛错；Blob / ArrayBuffer 会被静默序列化成 `{}`
 * （= 数据丢失）。两者都要在导出前拦下来，而不是等到整份文件序列化时炸掉。
 */
function isJsonSafe(value: unknown): boolean {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string';
  } catch {
    return false;
  }
}

/** 解析 localStorage 中的 JSON；失败返回 undefined（不抛错） */
function parseJson(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 从 localStorage 读字符串值（不可用时返回 null） */
function readLocal(deps: SectionDeps, key: string): string | null {
  try {
    return deps.localStore?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 写 localStorage（不可用或抛错时静默跳过——chrome 侧才是权威源） */
function writeLocal(deps: SectionDeps, key: string, value: string): void {
  try {
    deps.localStore?.setItem(key, value);
  } catch {
    /* 隐私模式等场景下 localStorage 不可写：chrome 侧仍会写入，不阻断 */
  }
}

/** 删除 localStorage 键（不可用或抛错时静默跳过） */
function removeLocal(deps: SectionDeps, key: string): void {
  try {
    deps.localStore?.removeItem(key);
  } catch {
    /* 同上 */
  }
}

/** chrome.storage.local 读单键（读失败返回 undefined，不抛错） */
async function readChrome(deps: SectionDeps, key: string): Promise<unknown> {
  try {
    const result = await deps.area.get([key]);
    return result?.[key];
  } catch {
    return undefined;
  }
}

/** 处理器依赖（存储端口；测试可注入内存实现） */
export interface SectionDeps {
  area: BackupAreaLike;
  localStore: LocalStoreLike | null;
  /**
   * 导出时是否包含多媒体。
   * false 时：图片 / 捕获文件分区整体不进备份；笔记中的**内联 base64 图片**
   * 被剥离（否则「不包含多媒体」的备份仍会因笔记里的图片而臃肿）。
   */
  includeMedia?: boolean;
}

/**
 * 「键值类」分区的通用写入器。
 *
 * 统一保证：
 * - 写前快照（chrome 值 + localStorage 值）→ 失败时原样还原（分区原子性）；
 * - fill 策略下「本机已有数据则跳过」（返回 skipped，不触碰存储）；
 * - chrome 与 localStorage 双写（chrome 为权威源，localStorage 为同步读缓存；
 *   只写一侧会在「chrome 被清但 localStorage 尚存」的恢复路径上留下新旧不一致）。
 */
async function applyKeyValueSection(
  deps: SectionDeps,
  options: {
    /** chrome 键 */
    chromeKey: string;
    /** localStorage 镜像键（可多个） */
    localKeys?: readonly string[];
    /** 从载荷取出要写入的 chrome 值 */
    chromeValue(data: unknown): unknown;
    /** 从载荷取出要写入的 localStorage 值（键 → 字符串；undefined = 不写） */
    localValues?(data: unknown): Record<string, string | undefined>;
    /** 本机是否已有数据（fill 策略判定） */
    hasLocalData(chromeValue: unknown, localValues: Record<string, string | undefined>): boolean;
  },
  data: unknown,
  strategy: BackupStrategy,
): Promise<ApplyOutcome> {
  const { chromeKey, localKeys = [] } = options;
  const nextChrome = options.chromeValue(data);
  const nextLocal = options.localValues?.(data) ?? {};

  const preChrome = await readChrome(deps, chromeKey);
  const preLocal: Record<string, string | null> = {};
  for (const key of localKeys) preLocal[key] = readLocal(deps, key);

  if (strategy === 'fill') {
    const currentLocal: Record<string, string | undefined> = {};
    for (const key of localKeys) {
      const value = preLocal[key];
      if (value !== null) currentLocal[key] = value;
    }
    if (options.hasLocalData(preChrome, currentLocal)) {
      return { skipped: true, reason: 'already-configured' };
    }
  }

  try {
    await deps.area.set({ [chromeKey]: nextChrome });
    for (const key of localKeys) {
      const value = nextLocal[key];
      if (value === undefined) removeLocal(deps, key);
      else writeLocal(deps, key, value);
    }
  } catch (error) {
    // 分区原子性：写失败即还原写前状态，再把错误抛给编排器
    try {
      if (preChrome === undefined) await deps.area.remove([chromeKey]);
      else await deps.area.set({ [chromeKey]: preChrome });
      for (const key of localKeys) {
        const value = preLocal[key];
        if (value === null) removeLocal(deps, key);
        else writeLocal(deps, key, value);
      }
    } catch {
      /* 还原失败：编排器会记录 rollback-failed（本分区不在「已写列表」中） */
    }
    throw error;
  }

  return {
    rollback: async () => {
      if (preChrome === undefined) await deps.area.remove([chromeKey]);
      else await deps.area.set({ [chromeKey]: preChrome });
      for (const key of localKeys) {
        const value = preLocal[key];
        if (value === null) removeLocal(deps, key);
        else writeLocal(deps, key, value);
      }
    },
  };
}

// ==================== 技能分区 ====================

/** 技能记录的结构校验（StoredSkill：id/name/files 等必需字段） */
function isValidStoredSkill(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || !/^[1-9][0-9]*$/.test(value.id) || !Number.isSafeInteger(Number(value.id)) || Number(value.id) <= 1000) return false;
  if (typeof value.identityKey !== 'string' || !value.identityKey || value.identityKey.length > 2048 || !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0) return false;
  if (typeof value.name !== 'string' || !value.name) return false;
  if (!isRecord(value.files) || typeof value.files['SKILL.md'] !== 'string') return false;
  return true;
}

function isSkillsPayload(value: unknown): value is SkillsPayload {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.custom)) return false;
  if (!value.custom.every(isValidStoredSkill)) return false;
  if (!isRecord(value.toggles)) return false;
  if (value.lifecycle !== undefined && (!isRecord(value.lifecycle) || Object.keys(value.lifecycle).some(key => !SKILL_LIFECYCLE_KEYS.includes(key as typeof SKILL_LIFECYCLE_KEYS[number])))) return false;
  return Object.values(value.toggles).every(item => typeof item === 'boolean');
}

export function createSkillsHandler(deps: SectionDeps): SectionHandler {
  return {
    id: 'skills',
    async collect(): Promise<unknown | null> {
      const chrome = await deps.area.get([SKILLS_STORAGE_KEY, SKILL_TOGGLES_STORAGE_KEY, ...SKILL_LIFECYCLE_KEYS]);
      const chromeSkills = chrome?.[SKILLS_STORAGE_KEY];
      const chromeToggles = chrome?.[SKILL_TOGGLES_STORAGE_KEY];

      const custom = Array.isArray(chromeSkills) ? chromeSkills : [];
      const toggles = isRecord(chromeToggles) ? chromeToggles : {};
      const lifecycle = Object.fromEntries(SKILL_LIFECYCLE_KEYS.filter(key => chrome[key] !== undefined).map(key => [key, chrome[key]]));
      if (!custom.length && !Object.keys(toggles).length && !Object.keys(lifecycle).length) return null;
      return { custom, toggles: toggles as Record<string, boolean>, ...(Object.keys(lifecycle).length ? { lifecycle } : {}) } satisfies SkillsPayload;
    },
    validate(data: unknown): boolean {
      return isSkillsPayload(data);
    },
    async apply(data: unknown, strategy: BackupStrategy): Promise<ApplyOutcome> {
      if (!isSkillsPayload(data)) throw new Error('技能分区数据非法');
      const keys = [SKILLS_STORAGE_KEY, SKILLS_REVISION_KEY, SKILL_TOGGLES_STORAGE_KEY, ...SKILL_LIFECYCLE_KEYS];
      const previous = await deps.area.get(keys);
      const hasCurrent = (Array.isArray(previous[SKILLS_STORAGE_KEY]) && previous[SKILLS_STORAGE_KEY].length > 0) || (isRecord(previous[SKILL_TOGGLES_STORAGE_KEY]) && Object.keys(previous[SKILL_TOGGLES_STORAGE_KEY]).length > 0) || SKILL_LIFECYCLE_KEYS.some(key => previous[key] !== undefined);
      if (strategy === 'fill' && hasCurrent) return {skipped:true,reason:'already-configured'};
      const rollback = async () => {
        const restore = Object.fromEntries(keys.filter(key => previous[key] !== undefined).map(key => [key,previous[key]]));
        if (Object.keys(restore).length) await deps.area.set(restore);
        await deps.area.remove(keys.filter(key => previous[key] === undefined));
      };
      try {
        // One Chrome storage write commits Skill records, toggles and lifecycle state together.
        await deps.area.set({ [SKILLS_STORAGE_KEY]: data.custom, [SKILLS_REVISION_KEY]: crypto.randomUUID(), [SKILL_TOGGLES_STORAGE_KEY]: data.toggles, ...Object.fromEntries(SKILL_LIFECYCLE_KEYS.map(key => [key, data.lifecycle?.[key] ?? (key.endsWith(':packages') ? [] : key === 'agentNexusSkillCaptureHidden' ? false : {})])) });
      } catch(error) { await rollback(); throw error; }
      return {rollback};
    },
  };
}

// ==================== 智能体分区 ====================

function isAgentConfigLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.name === 'string' && !!value.name && typeof value.id === 'string' && !!value.id;
}

function isAgentsPayload(value: unknown): value is AgentsPayload {
  if (!isRecord(value)) return false;
  return Array.isArray(value.custom) && value.custom.every(isAgentConfigLike);
}

export function createAgentsHandler(deps: SectionDeps): SectionHandler {
  return {
    id: 'agents',
    async collect(): Promise<unknown | null> {
      const chrome = await deps.area.get([AGENTS_STORAGE_KEY]);
      const chromeAgents = chrome?.[AGENTS_STORAGE_KEY];
      const localAgents = parseJson(readLocal(deps, AGENTS_STORAGE_KEY));
      // 同技能：chrome 为空时回落 localStorage 镜像（chrome 写失败时镜像更新）
      const custom =
        Array.isArray(chromeAgents) && chromeAgents.length
          ? chromeAgents
          : Array.isArray(localAgents) && localAgents.length
            ? localAgents
            : Array.isArray(chromeAgents)
              ? chromeAgents
              : [];
      if (!custom.length) return null;
      return { custom } satisfies AgentsPayload;
    },
    validate(data: unknown): boolean {
      return isAgentsPayload(data);
    },
    async apply(data: unknown, strategy: BackupStrategy): Promise<ApplyOutcome> {
      if (!isAgentsPayload(data)) throw new Error('智能体分区数据非法');
      return applyKeyValueSection(
        deps,
        {
          chromeKey: AGENTS_STORAGE_KEY,
          localKeys: [AGENTS_STORAGE_KEY],
          chromeValue: () => data.custom,
          localValues: () => ({ [AGENTS_STORAGE_KEY]: JSON.stringify(data.custom) }),
          hasLocalData: (chromeValue, localValues) =>
            (Array.isArray(chromeValue) && chromeValue.length > 0) ||
            Object.keys(localValues).length > 0,
        },
        data,
        strategy,
      );
    },
  };
}

// ==================== 会话计划分区 ====================

function isPlansPayload(value: unknown): value is PlansPayload {
  if (!isRecord(value)) return false;
  return isRecord(value.payload);
}

/** 计划载荷里的会话数（用于「chrome 为空时回落镜像」的判定） */
function planSessionCount(value: unknown): number {
  if (!isRecord(value)) return 0;
  const sessions = value.sessions;
  return isRecord(sessions) ? Object.keys(sessions).length : 0;
}

export function createPlansHandler(deps: SectionDeps): SectionHandler {
  return {
    id: 'plans',
    async collect(): Promise<unknown | null> {
      const chrome = await deps.area.get([PLANS_STORAGE_KEY]);
      const chromePlans = chrome?.[PLANS_STORAGE_KEY];
      const localPlans = parseJson(readLocal(deps, PLANS_STORAGE_KEY));
      // 同技能：chrome 的会话表为空时回落 localStorage 镜像
      const payload = planSessionCount(chromePlans) > 0
        ? isRecord(chromePlans)
          ? chromePlans
          : null
        : planSessionCount(localPlans) > 0
          ? isRecord(localPlans)
            ? localPlans
            : null
          : isRecord(chromePlans)
            ? chromePlans
            : null;
      if (!payload) return null;
      return { payload } satisfies PlansPayload;
    },
    validate(data: unknown): boolean {
      return isPlansPayload(data);
    },
    async apply(data: unknown, strategy: BackupStrategy): Promise<ApplyOutcome> {
      if (!isPlansPayload(data)) throw new Error('会话计划分区数据非法');
      return applyKeyValueSection(
        deps,
        {
          chromeKey: PLANS_STORAGE_KEY,
          localKeys: [PLANS_STORAGE_KEY],
          chromeValue: () => data.payload,
          localValues: () => ({ [PLANS_STORAGE_KEY]: JSON.stringify(data.payload) }),
          hasLocalData: (chromeValue, localValues) =>
            isRecord(chromeValue) || Object.keys(localValues).length > 0,
        },
        data,
        strategy,
      );
    },
  };
}

// ==================== 托管文件分区 ====================

function isFilesPayload(value: unknown): value is FilesPayload {
  if (!isRecord(value)) return false;
  if (!isRecord(value.files)) return false;
  return Object.values(value.files).every(item => isRecord(item) && typeof item.id === 'string');
}

export function createFilesHandler(deps: SectionDeps): SectionHandler {
  return {
    id: 'files',
    async collect(): Promise<unknown | null> {
      const chrome = await deps.area.get([FILES_STORAGE_KEY]);
      const files = chrome?.[FILES_STORAGE_KEY];
      if (!isRecord(files)) return null;
      const count = Object.keys(files).length;
      if (!count) return null;
      return { files } satisfies FilesPayload;
    },
    validate(data: unknown): boolean {
      return isFilesPayload(data);
    },
    async apply(data: unknown, strategy: BackupStrategy): Promise<ApplyOutcome> {
      if (!isFilesPayload(data)) throw new Error('托管文件分区数据非法');
      return applyKeyValueSection(
        deps,
        {
          chromeKey: FILES_STORAGE_KEY,
          chromeValue: () => data.files,
          hasLocalData: chromeValue => isRecord(chromeValue) && Object.keys(chromeValue).length > 0,
        },
        data,
        strategy,
      );
    },
  };
}

// ==================== 用量统计分区 ====================

function isMetricsPayload(value: unknown): value is MetricsPayload {
  return isRecord(value) && 'metrics' in value;
}

export function createMetricsHandler(deps: SectionDeps): SectionHandler {
  return {
    id: 'metrics',
    async collect(): Promise<unknown | null> {
      const chrome = await deps.area.get([USAGE_METRICS_STORAGE_KEY]);
      const metrics = chrome?.[USAGE_METRICS_STORAGE_KEY];
      if (metrics === undefined || metrics === null) return null;
      return { metrics } satisfies MetricsPayload;
    },
    validate(data: unknown): boolean {
      return isMetricsPayload(data);
    },
    async apply(data: unknown, strategy: BackupStrategy): Promise<ApplyOutcome> {
      if (!isMetricsPayload(data)) throw new Error('用量统计分区数据非法');
      return applyKeyValueSection(
        deps,
        {
          chromeKey: USAGE_METRICS_STORAGE_KEY,
          chromeValue: () => data.metrics,
          hasLocalData: chromeValue => chromeValue !== undefined && chromeValue !== null,
        },
        data,
        strategy,
      );
    },
  };
}

// ==================== 杂项分区（开关 / 主题 / 队列） ====================

function isMiscPayload(value: unknown): value is MiscPayload {
  if (!isRecord(value)) return false;
  if (!isRecord(value.chrome)) return false;
  if (!isRecord(value.local)) return false;
  if (!Object.values(value.local).every(item => typeof item === 'string')) return false;
  // 键白名单：备份文件是外部输入，绝不允许它指定任意 chrome.storage.local 键
  // （否则一份恶意备份就能往扩展存储里塞任意键）
  if (!Object.keys(value.chrome).every(key => (MISC_CHROME_KEYS as readonly string[]).includes(key))) {
    return false;
  }
  if (!Object.keys(value.local).every(key => (MISC_LOCAL_KEYS as readonly string[]).includes(key))) {
    return false;
  }
  return true;
}

export function createMiscHandler(deps: SectionDeps): SectionHandler {
  return {
    id: 'misc',
    async collect(): Promise<unknown | null> {
      const chrome = await deps.area.get([...MISC_CHROME_KEYS]);
      const chromePart: Record<string, unknown> = {};
      let chromeCount = 0;
      for (const key of MISC_CHROME_KEYS) {
        const value = chrome?.[key];
        if (value === undefined || value === null) continue;
        chromePart[key] = value;
        chromeCount++;
      }
      const localPart: Record<string, string> = {};
      for (const key of MISC_LOCAL_KEYS) {
        const value = readLocal(deps, key);
        if (value === null) continue;
        localPart[key] = value;
      }
      if (!chromeCount && !Object.keys(localPart).length) return null;
      return { chrome: chromePart, local: localPart } satisfies MiscPayload;
    },
    validate(data: unknown): boolean {
      return isMiscPayload(data);
    },
    async apply(data: unknown, strategy: BackupStrategy): Promise<ApplyOutcome> {
      if (!isMiscPayload(data)) throw new Error('杂项分区数据非法');
      // 逐键写入（每个键一次 set，保证「只写备份里有的键」；未出现的键保持原状，
      // 避免把用户本机的额外开关误清空）
      const preChrome = await deps.area.get([...MISC_CHROME_KEYS]);
      const preLocal: Record<string, string | null> = {};
      for (const key of MISC_LOCAL_KEYS) preLocal[key] = readLocal(deps, key);

      if (strategy === 'fill') {
        const hasChrome = MISC_CHROME_KEYS.some(
          key => preChrome?.[key] !== undefined && preChrome?.[key] !== null,
        );
        const hasLocal = MISC_LOCAL_KEYS.some(key => preLocal[key] !== null);
        if (hasChrome || hasLocal) return { skipped: true, reason: 'already-configured' };
      }

      try {
        const chromeItems: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(data.chrome)) {
          // 双保险：即使 validate 被绕过，也只写白名单内的键
          if (!(MISC_CHROME_KEYS as readonly string[]).includes(key)) continue;
          chromeItems[key] = value;
        }
        if (Object.keys(chromeItems).length) await deps.area.set(chromeItems);
        for (const [key, value] of Object.entries(data.local)) {
          if (!(MISC_LOCAL_KEYS as readonly string[]).includes(key)) continue;
          writeLocal(deps, key, value);
        }
      } catch (error) {
        try {
          const restore: Record<string, unknown> = {};
          for (const key of MISC_CHROME_KEYS) {
            const value = preChrome?.[key];
            if (value !== undefined) restore[key] = value;
          }
          if (Object.keys(restore).length) await deps.area.set(restore);
          for (const key of MISC_LOCAL_KEYS) {
            const value = preLocal[key];
            if (value === null) removeLocal(deps, key);
            else writeLocal(deps, key, value);
          }
        } catch {
          /* 还原失败：编排器记录 rollback-failed */
        }
        throw error;
      }

      return {
        rollback: async () => {
          const restore: Record<string, unknown> = {};
          for (const key of MISC_CHROME_KEYS) {
            const value = preChrome?.[key];
            if (value !== undefined) restore[key] = value;
          }
          if (Object.keys(restore).length) await deps.area.set(restore);
          for (const key of MISC_LOCAL_KEYS) {
            const value = preLocal[key];
            if (value === null) removeLocal(deps, key);
            else writeLocal(deps, key, value);
          }
        },
      };
    },
  };
}

// ==================== 图片分区（多媒体，受 includeMedia 门控） ====================

function isImageEntry(value: unknown): value is ImageBackupEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.hash === 'string' &&
    !!value.hash &&
    typeof value.mime === 'string' &&
    typeof value.byteSize === 'number' &&
    Number.isFinite(value.byteSize) &&
    typeof value.createdAt === 'number' &&
    typeof value.data === 'string' &&
    (value.shortId === undefined ||
      (typeof value.shortId === 'string' && /^[0-9a-z]{8}$/.test(value.shortId)))
  );
}

function isImagesPayload(value: unknown): value is ImagesPayload {
  if (!isRecord(value)) return false;
  return Array.isArray(value.images) && value.images.every(isImageEntry);
}

export function createImagesHandler(): SectionHandler {
  return {
    id: 'images',
    media: true,
    async collect(): Promise<unknown | null> {
      const records = await imageDatabase.listAll();
      if (!records.length) return null;
      const images: ImageBackupEntry[] = [];
      for (const record of records) {
        try {
          const bytes = new Uint8Array(await record.blob.arrayBuffer());
          images.push({
            hash: record.hash,
            mime: record.mime,
            byteSize: record.byteSize,
            createdAt: record.createdAt,
            // 短 id 一并备份：历史回答里的截图引用依赖它
            ...(record.shortId ? { shortId: record.shortId } : {}),
            data: bytesToBase64(bytes),
          });
        } catch {
          // 单张图片读取失败 → 跳过该张（不导出），其余照常；
          // 由编排器在 issues 中提示（导出方据此知道备份不完整）
          console.warn('[Backup] 图片读取失败，已跳过:', record.hash.slice(0, 12));
        }
      }
      if (!images.length) return null;
      return { images } satisfies ImagesPayload;
    },
    validate(data: unknown): boolean {
      return isImagesPayload(data);
    },
    async apply(data: unknown, strategy: BackupStrategy): Promise<ApplyOutcome> {
      if (!isImagesPayload(data)) throw new Error('图片分区数据非法');
      const existing = await imageDatabase.listAll();
      if (strategy === 'fill' && existing.length) {
        return { skipped: true, reason: 'already-configured' };
      }
      const records = data.images.map(entry => {
        const bytes = base64ToBytes(entry.data);
        if (!bytes) throw new Error(`图片 ${entry.hash.slice(0, 12)} 的 base64 数据损坏`);
        return {
          hash: entry.hash,
          mime: entry.mime,
          byteSize: entry.byteSize,
          createdAt: entry.createdAt,
          // 短 id 一并恢复：历史回答里的 <agent-image id="..."> 继续有效
          ...(entry.shortId ? { shortId: entry.shortId } : {}),
          blob: new Blob([bytes.slice().buffer as ArrayBuffer], { type: entry.mime }),
        };
      });
      // 原子恢复（单事务清空 + 写入）；失败时自身状态不变
      await imageDatabase.restoreAll(records);
      // 回滚闭包：还原导入前的图片库
      return {
        rollback: async () => {
          await imageDatabase.restoreAll(existing);
        },
      };
    },
  };
}

// ==================== 笔记分区 ====================

/**
 * 剥离 HTML 中的内联 base64 图片。
 *
 * 笔记正文（Tiptap HTML）允许内嵌 data URL 图片——它们是**多媒体**的一部分，
 * 「不包含多媒体」的备份必须把它们摘掉，否则备份体积仍被笔记图片撑大。
 * 只替换 src / url(...) 里的 data URL，其余正文原样保留。
 *
 * @returns 剥离后的 HTML 与被剥离的图片数量
 */
export function stripInlineDataUrls(html: string): { html: string; removed: number } {
  if (typeof html !== 'string' || !html.includes('data:')) return { html, removed: 0 };
  let removed = 0;
  const stripped = html
    .replace(/(src\s*=\s*)(["'])data:[^"']*\2/gi, (match, prefix: string, quote: string) => {
      removed++;
      return `${prefix}${quote}${quote}`;
    })
    .replace(/url\(\s*(['"]?)data:[^)]*\)/gi, () => {
      removed++;
      return 'url()';
    });
  return { html: stripped, removed };
}

function isNoteLike(value: unknown): value is Note {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    !!value.id &&
    typeof value.content === 'string' &&
    typeof value.title === 'string'
  );
}

function isNotesPayload(value: unknown): value is NotesPayload {
  if (!isRecord(value)) return false;
  return Array.isArray(value.notes) && value.notes.every(isNoteLike);
}

export function createNotesHandler(deps: SectionDeps): SectionHandler {
  const notices: string[] = [];
  return {
    id: 'notes',
    notices,
    async collect(): Promise<unknown | null> {
      const notes = await notesDB.listAllNotes();
      if (!notes.length) return null;
      const includeMedia = deps.includeMedia !== false;
      let strippedNotes = 0;
      let strippedImages = 0;
      const exported = notes.map(note => {
        if (includeMedia) return note;
        const result = stripInlineDataUrls(note.content ?? '');
        if (result.removed === 0) return note;
        strippedNotes++;
        strippedImages += result.removed;
        return { ...note, content: result.html };
      });
      if (strippedNotes > 0) {
        notices.push(
          `未包含多媒体：已从 ${strippedNotes} 条笔记中剥离 ${strippedImages} 张内联图片（正文其余内容完整保留）`,
        );
      }
      return { notes: exported } satisfies NotesPayload;
    },
    validate(data: unknown): boolean {
      return isNotesPayload(data);
    },
    async apply(data: unknown, strategy: BackupStrategy): Promise<ApplyOutcome> {
      if (!isNotesPayload(data)) throw new Error('笔记分区数据非法');
      const existing = await notesDB.listAllNotes();
      if (strategy === 'fill' && existing.length) {
        return { skipped: true, reason: 'already-configured' };
      }
      // 原子恢复（单事务清空 + 写入）；失败时自身状态不变
      await notesDB.restoreNotes(data.notes as Note[]);
      return {
        rollback: async () => {
          await notesDB.restoreNotes(existing);
        },
      };
    },
  };
}

// ==================== 会话分区 ====================

function isSessionLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.chatId === 'string' && !!value.chatId;
}

function isMessageLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    !!value.id &&
    typeof value.chatId === 'string' &&
    !!value.chatId
  );
}

function isConversationsPayload(value: unknown): value is ConversationsPayload {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.sessions) || !value.sessions.every(isSessionLike)) return false;
  if (!Array.isArray(value.messages) || !value.messages.every(isMessageLike)) return false;
  // 消息必须归属于本分区内的某个会话（否则恢复时会成为孤儿消息被丢弃）
  const chatIds = new Set(value.sessions.map(session => (session as { chatId: string }).chatId));
  if (chatIds.size !== value.sessions.length ||
      !value.messages.every(message => chatIds.has((message as { chatId: string }).chatId))) return false;
  if (value.workspaces !== undefined) {
    try { decodeWorkspaceBackups(value.workspaces, chatIds, false); }
    catch { return false; }
  }
  return true;
}

export function createConversationsHandler(includeMedia = true): SectionHandler {
  const notices: string[] = [];
  return {
    id: 'conversations',
    notices,
    async collect(): Promise<unknown | null> {
      notices.length = 0;
      const [sessions, messages] = await Promise.all([
        chatDatabase.listAllSessions(),
        chatDatabase.listAllMessages(),
      ]);
      if (!sessions.length && !messages.length) return null;
      // 防御：逐条确认可 JSON 序列化。备份文件是 JSON —— 若某条记录含循环
      // 引用 / Blob，序列化会在**整份文件**上抛错，导致一次都不能导出；
      // 逐条过滤则只丢掉那一条，并如实告知用户丢了多少。
      const exportable: unknown[] = [];
      let dropped = 0;
      for (const message of messages) {
        if (isJsonSafe(message)) exportable.push(message);
        else dropped++;
      }
      if (dropped > 0) {
        notices.push(`${dropped} 条消息无法序列化（可能含循环引用或二进制），未包含在本次备份中`);
      }
      const payload: ConversationsPayload = { sessions, messages: exportable };
      if (includeMedia) {
        try {
          payload.workspaces = await encodeWorkspaceBackups(
            await chatDatabase.listWorkspaces(),
            new Set(sessions.map(session => session.chatId)),
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          notices.push(`本次未包含 Python 工作区文件：${reason}。会话文字仍可备份，产物可从原会话单独下载。`);
        }
      }
      return payload;
    },
    validate(data: unknown): boolean {
      return isConversationsPayload(data);
    },
    async apply(data: unknown, strategy: BackupStrategy): Promise<ApplyOutcome> {
      if (!isConversationsPayload(data)) throw new Error('会话分区数据非法');
      // 本机现有数据（仅用于「补充导入」判定与失败回滚）
      const existingSessions = await chatDatabase.listAllSessions();
      const existingMessages = await chatDatabase.listAllMessages();
      if (strategy === 'fill' && existingSessions.length) {
        return { skipped: true, reason: 'already-configured' };
      }
      // 原子恢复（单事务清空 + 写入）；失败时自身状态不变。
      // 写入的是**备份里的**会话与消息——写本机现有数据等于什么都没做。
      const sessions = data.sessions as ChatSessionMeta[];
      const workspaces = data.workspaces === undefined ? undefined : decodeWorkspaceBackups(
        data.workspaces, new Set(sessions.map(session => session.chatId)), true,
      );
      const previousWorkspaces = await chatDatabase.restoreSessions(
        sessions,
        data.messages as ChatMessageRecord[],
        workspaces,
      );
      return {
        rollback: async () => {
          await chatDatabase.restoreSessions(existingSessions, existingMessages, previousWorkspaces);
        },
      };
    },
  };
}

// ==================== 捕获文件分区（多媒体，受 includeMedia 门控） ====================

function isCapturedFileEntry(value: unknown): value is CapturedFileBackupEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    !!value.id &&
    typeof value.filename === 'string' &&
    typeof value.data === 'string'
  );
}

function isCapturedFilesPayload(value: unknown): value is CapturedFilesPayload {
  if (!isRecord(value)) return false;
  return Array.isArray(value.files) && value.files.every(isCapturedFileEntry);
}

export function createCapturedFilesHandler(): SectionHandler {
  return {
    id: 'capturedFiles',
    media: true,
    async collect(): Promise<unknown | null> {
      const records = await downloadDB.getAllFiles();
      if (!records.length) return null;
      const files: CapturedFileBackupEntry[] = [];
      for (const record of records) {
        try {
          const bytes = new Uint8Array(await record.blobData.arrayBuffer());
          files.push({
            id: record.id,
            filename: record.filename,
            sourcePageUrl: record.sourcePageUrl,
            mimeType: record.mimeType,
            size: record.size,
            capturedAt: record.capturedAt,
            data: bytesToBase64(bytes),
          });
        } catch {
          console.warn('[Backup] 捕获文件读取失败，已跳过:', record.id);
        }
      }
      if (!files.length) return null;
      return { files } satisfies CapturedFilesPayload;
    },
    validate(data: unknown): boolean {
      return isCapturedFilesPayload(data);
    },
    async apply(data: unknown, strategy: BackupStrategy): Promise<ApplyOutcome> {
      if (!isCapturedFilesPayload(data)) throw new Error('捕获文件分区数据非法');
      const existing = await downloadDB.getAllFiles();
      if (strategy === 'fill' && existing.length) {
        return { skipped: true, reason: 'already-configured' };
      }
      const records: CapturedFileRecord[] = data.files.map(entry => {
        const bytes = base64ToBytes(entry.data);
        if (!bytes) throw new Error(`捕获文件 ${entry.id} 的 base64 数据损坏`);
        return {
          id: entry.id,
          filename: entry.filename,
          sourcePageUrl: entry.sourcePageUrl,
          mimeType: entry.mimeType,
          size: entry.size,
          capturedAt: entry.capturedAt,
          blobData: new Blob([bytes.slice().buffer as ArrayBuffer], { type: entry.mimeType }),
        };
      });
      // 原子恢复（单事务清空 + 写入）；失败时自身状态不变
      await downloadDB.restoreFiles(records);
      return {
        rollback: async () => {
          await downloadDB.restoreFiles(existing);
        },
      };
    },
  };
}

// ==================== 注册表 ====================

/**
 * 全部数据分区处理器（顺序 = DATA_SECTION_ORDER，由编排器按此序写入）。
 *
 * capturedFiles 恒为末位（唯一允许返回 rollback:null 的分区，但它返回的是
 * 真实闭包——闭包永远比 null 安全，编排器不依赖这个特例）。
 */
export function createDataSectionHandlers(deps: SectionDeps): SectionHandler[] {
  return [
    createSkillsHandler(deps),
    createAgentsHandler(deps),
    createPlansHandler(deps),
    createFilesHandler(deps),
    createMetricsHandler(deps),
    createMiscHandler(deps),
    createPluginsBackupHandler(),
    createImagesHandler(),
    createNotesHandler(deps),
    createConversationsHandler(deps.includeMedia !== false),
    createCapturedFilesHandler(),
  ];
}

/** 与 localStorage 镜像键一致的数据分区（技能 / 智能体 / 计划） */
export const MIRRORED_SECTION_KEYS = LOCAL_MIRROR_KEYS;

/** 备份 misc 分区涉及的 chrome 键（导出与统计同源复用） */
export const MISC_SECTION_CHROME_KEYS = MISC_CHROME_KEYS;

/** 备份 misc 分区涉及的 localStorage 键 */
export const MISC_SECTION_LOCAL_KEYS = MISC_LOCAL_KEYS;

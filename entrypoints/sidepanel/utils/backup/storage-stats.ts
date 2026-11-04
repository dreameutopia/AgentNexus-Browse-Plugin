/**
 * 存储占用统计引擎（管理中心的「当前占用」面板数据源）
 *
 * 目标：给用户一个**完整、可核对、不缺数**的占用视图，并告诉他怎么缩小。
 *
 * 三条硬约束（决定了本文件的全部设计）：
 * 1. **不缺数**：每个字节必须归属且仅归属一个分类。chrome.storage.local 的
 *    未被任何分类认领的键一律归入「其他」；**分类合计恒等于总占用**，
 *    差额（浏览器逐键计量的额外开销）也归入「其他」并在 issues 中说明。
 *    「统计为 0」与「统计失败」是两种语义，本引擎用 -1 区分，绝不混同。
 * 2. **不谎报**：读不到就报失败（-1 + issue），绝不用 0 冒充。
 *    IndexedDB 各库的体积靠遍历记录估算，误差只影响占比，不影响大小量级。
 * 3. **口径自洽**：分类（所有权视图：字节归谁）与对话媒体构成（归属视图：
 *    字节被谁用到）是两套口径，分别呈现，绝不互相相加。
 *
 * 分面计量（关键设计）：chrome.storage.local / localStorage / IndexedDB
 * 三个存储面**分别**计量、分别对账，最后才合并到分类上。
 * 若把三个面的字节混在一个桶里再对账，「本地镜像键」与「chrome 权威键」
 * 会互相污染，导致对账差额失真、分类合计与总量对不上。
 */

import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { imageDatabase } from '@/entrypoints/sidepanel/core/images/image-database';
import { protocolImageRefs } from '@/entrypoints/sidepanel/core/context/protocol-history';
import type { ChatMessageRecord } from '@/entrypoints/sidepanel/core/types';
import { notesDB } from '@/utils/notes-database';
import { downloadDB } from '@/utils/download-database';
import { listFileMeta as pyodideListFileMeta } from '@/utils/pyodide/pyodide-cache';
import type { MessageKey } from '@/utils/i18n';

import { configRawStorageKeys, configStorageKeys } from '../config/engine';
import type { LocalStoreLike } from '../config/types';
import { estimateValueBytes, jsonBytes, utf8Bytes } from './bytes';
import {
  defaultArea,
  defaultIdb,
  defaultLocalStore,
  estimateDatabaseBytes,
  localStorageEntries,
  type BackupAreaLike,
  type IdbPort,
} from './ports';
import {
  CHROME_KEY_CATEGORY,
  LOCAL_KEY_CATEGORY,
  LOCAL_MIRROR_KEYS,
  NOTES_FOLDERS_STORAGE_KEY,
  SKILL_TOGGLES_STORAGE_KEY,
} from './storage-keys';
import type { StorageCategoryId } from './types';
import type {
  ConversationMediaSplit,
  StorageCategoryStat,
  StorageChildStat,
  StorageReport,
} from './types';

/** 统计选项（全部可注入，便于测试与降级） */
export interface CollectStorageOptions {
  /** chrome.storage.local 端口（默认生产单例；不可用时该存储面报「不可用」） */
  area?: BackupAreaLike | null;
  /** localStorage 端口（默认生产单例；隐私模式不可用时返回 null） */
  localStore?: LocalStoreLike | null;
  /** IndexedDB 端口（默认生产单例；用于枚举未知数据库） */
  idb?: IdbPort | null;
  /** 是否执行 IndexedDB 统计（关闭后 idb 类分类显示「—」） */
  includeIdb?: boolean;
}

/** 分类的固定展示顺序 */
export const STORAGE_CATEGORY_ORDER: readonly StorageCategoryId[] = [
  'conversations',
  'images',
  'notes',
  'capturedFiles',
  'skills',
  'agents',
  'plans',
  'files',
  'metrics',
  'misc',
  'config',
  'python',
  'other',
];

/** 分类标签（i18n 键） */
const CATEGORY_LABEL_KEYS: Record<StorageCategoryId, MessageKey> = {
  conversations: 'sidepanel.backup.catConversations',
  images: 'sidepanel.backup.catImages',
  notes: 'sidepanel.backup.catNotes',
  capturedFiles: 'sidepanel.backup.catCapturedFiles',
  skills: 'sidepanel.backup.catSkills',
  agents: 'sidepanel.backup.catAgents',
  plans: 'sidepanel.backup.catPlans',
  files: 'sidepanel.backup.catFiles',
  metrics: 'sidepanel.backup.catMetrics',
  misc: 'sidepanel.backup.catMisc',
  config: 'sidepanel.backup.catConfig',
  python: 'sidepanel.backup.catPython',
  other: 'sidepanel.backup.catOther',
};

/** 分类的「如何缩小」提示（i18n 键） */
const CATEGORY_TIP_KEYS: Partial<Record<StorageCategoryId, MessageKey>> = {
  conversations: 'sidepanel.backup.tipConversations',
  images: 'sidepanel.backup.tipImages',
  notes: 'sidepanel.backup.tipNotes',
  capturedFiles: 'sidepanel.backup.tipCapturedFiles',
  skills: 'sidepanel.backup.tipSkills',
  agents: 'sidepanel.backup.tipAgents',
  plans: 'sidepanel.backup.tipPlans',
  files: 'sidepanel.backup.tipFiles',
  metrics: 'sidepanel.backup.tipMetrics',
  misc: 'sidepanel.backup.tipMisc',
  config: 'sidepanel.backup.tipConfig',
  python: 'sidepanel.backup.tipPython',
  other: 'sidepanel.backup.tipOther',
};

/** 子项标签（i18n 键；键名 = `${分类}.${子项}`） */
const CHILD_LABEL_KEYS: Record<string, MessageKey> = {
  'conversations.sessions': 'sidepanel.backup.subSessions',
  'conversations.messages': 'sidepanel.backup.subMessages',
  'images.referenced': 'sidepanel.backup.subReferenced',
  'images.orphan': 'sidepanel.backup.subOrphan',
  'skills.custom': 'sidepanel.backup.subCustomSkills',
  'skills.toggles': 'sidepanel.backup.subSkillToggles',
  'agents.custom': 'sidepanel.backup.subCustomAgents',
  'plans.sessions': 'sidepanel.backup.subPlanSessions',
  'files.content': 'sidepanel.backup.subFileContent',
  'files.meta': 'sidepanel.backup.subFileMeta',
  'notes.content': 'sidepanel.backup.subNoteContent',
  'notes.meta': 'sidepanel.backup.subNoteMeta',
  'notes.folders': 'sidepanel.backup.subNoteFolders',
  'capturedFiles.binary': 'sidepanel.backup.subCapturedBinary',
  'metrics.totals': 'sidepanel.backup.subMetricsTotals',
  'metrics.requests': 'sidepanel.backup.subMetricsRequests',
  'misc.chrome': 'sidepanel.backup.subMiscChrome',
  'misc.local': 'sidepanel.backup.subMiscLocal',
  'config.domains': 'sidepanel.backup.subConfigDomains',
  'config.raw': 'sidepanel.backup.subConfigRaw',
  'python.cache': 'sidepanel.backup.subPythonCache',
  'python.env': 'sidepanel.backup.subPythonEnv',
  'other.chrome': 'sidepanel.backup.subOtherChrome',
  'other.local': 'sidepanel.backup.subOtherLocal',
  'other.database': 'sidepanel.backup.subOtherDatabase',
};

/** 分类是否随备份导出 */
const CATEGORY_IN_BACKUP: Record<StorageCategoryId, boolean> = {
  conversations: true,
  images: true,
  notes: true,
  capturedFiles: true,
  skills: true,
  agents: true,
  plans: true,
  files: true,
  metrics: true,
  misc: true,
  config: true,
  python: false,
  other: false,
};

/** 子项累加器 */
interface ChildBucket {
  bytes: number;
  count: number;
}

/** 分类累加器（合并三个存储面后的结果） */
interface CategoryBucket {
  bytes: number;
  count: number;
  known: boolean;
  children: Map<string, ChildBucket>;
  /** 无引用、可安全清理的字节（仅图片） */
  reclaimableBytes?: number;
  reclaimableCount?: number;
}

function emptyBucket(): CategoryBucket {
  return { bytes: 0, count: 0, known: true, children: new Map() };
}

function addChild(
  bucket: CategoryBucket,
  childId: string,
  bytes: number,
  count = 0,
): void {
  if (bytes < 0) {
    bucket.known = false;
    return;
  }
  let child = bucket.children.get(childId);
  if (!child) {
    child = { bytes: 0, count: 0 };
    bucket.children.set(childId, child);
  }
  child.bytes += bytes;
  child.count += count;
}

/** 分类 id → i18n 标签键 */
export function categoryLabelKey(id: StorageCategoryId): MessageKey {
  return CATEGORY_LABEL_KEYS[id] ?? 'sidepanel.backup.catOther';
}

/**
 * 采集完整存储占用报告。
 *
 * 任何单个存储面的失败都被记录进 issues 并以「-1（统计失败）」呈现，
 * 不影响其余存储面的统计。
 */
export async function collectStorageReport(
  options: CollectStorageOptions = {},
): Promise<StorageReport> {
  const issues: string[] = [];
  const buckets = new Map<StorageCategoryId, CategoryBucket>();
  for (const id of STORAGE_CATEGORY_ORDER) buckets.set(id, emptyBucket());
  const bucket = (id: StorageCategoryId): CategoryBucket => {
    let value = buckets.get(id);
    if (!value) {
      value = emptyBucket();
      buckets.set(id, value);
    }
    return value;
  };

  const area = options.area === undefined ? safeArea(issues) : options.area;
  const localStore =
    options.localStore === undefined ? safeLocalStore(issues) : options.localStore;
  const idb = options.idb === undefined ? safeIdb() : options.idb;
  const includeIdb = options.includeIdb !== false;

  // ── 1) chrome.storage.local ──
  let chromeBytes = -1;
  if (area) {
    chromeBytes = await measureChromeStorage(area, bucket, issues);
  } else {
    issues.push('chrome.storage.local 不可用，未统计其占用');
  }

  // ── 2) localStorage ──
  let localBytes = -1;
  if (localStore) {
    localBytes = measureLocalStorage(localStore, bucket);
  } else {
    issues.push('localStorage 不可用（隐私模式？），未统计其占用');
  }

  // ── 3) IndexedDB 各库 ──
  const idbResult = includeIdb
    ? await measureIndexedDb(idb, bucket, issues)
    : { bytes: -1, known: false };
  if (includeIdb && !idbResult.known) {
    issues.push('部分 IndexedDB 数据库统计失败，其占用可能偏低');
  }
  if (!includeIdb) {
    // 未统计数据库时，纯数据库类分类标为「不可知」（-1）而不是 0——
    // 报 0 等于谎报「没有占用」，会让用户误以为已清空。
    issues.push('本次未统计数据库占用，数据库类分类显示为「—」');
    for (const id of ['conversations', 'images', 'notes', 'capturedFiles'] as const) {
      bucket(id).known = false;
    }
  }

  // ── 4) 汇总 ──
  //    某个存储面统计失败时，合计退化为「已知部分之和」，并在 issues 中
  //    明确说明（不静默少算，也不谎报总量）。
  const totalBytes = sumPartial([chromeBytes, localBytes, idbResult.bytes], issues);

  // ── 5) 生成报告 ──
  const categories = buildCategories(buckets, totalBytes);

  return {
    totalBytes,
    chromeBytes,
    localBytes,
    idbBytes: idbResult.bytes,
    categories,
    conversationMedia: buildConversationMedia(bucket),
    issues,
    generatedAt: Date.now(),
  };
}

// ==================== 各存储面测量 ====================

/** 安全获取 chrome 端口（不可用时记录 issue 并返回 null） */
function safeArea(issues: string[]): BackupAreaLike | null {
  try {
    return defaultArea();
  } catch (error) {
    issues.push(`chrome.storage.local 不可用：${describe(error)}`);
    return null;
  }
}

/** 安全获取 localStorage 端口（不可用时返回 null） */
function safeLocalStore(issues: string[]): LocalStoreLike | null {
  const store = defaultLocalStore();
  if (!store) issues.push('localStorage 不可用（隐私模式？），未统计其占用');
  return store;
}

/** 安全获取 IndexedDB 端口 */
function safeIdb(): IdbPort | null {
  return defaultIdb();
}

/**
 * chrome.storage.local 计量。
 *
 * 逐键计量（getBytesInUse([key])）优先——这是浏览器的权威口径；
 * 不可用时回退到「值的 JSON 字节数」估算（并在 issues 中说明是估算值）。
 *
 * 返回值 = 本存储面的**合计字节**（已把与浏览器总量之间的差额并入「其他」，
 * 因此与分类合计自洽）。
 */
async function measureChromeStorage(
  area: BackupAreaLike,
  bucket: (id: StorageCategoryId) => CategoryBucket,
  issues: string[],
): Promise<number> {
  let all: Record<string, unknown> = {};
  let enumerated = false;
  if (typeof area.getAll === 'function') {
    try {
      all = await area.getAll();
      enumerated = true;
    } catch (error) {
      issues.push(`读取 chrome.storage.local 全量键值失败：${describe(error)}`);
    }
  }

  // 未提供 getAll 时，退化为「已知键 + 配置键」清单
  const keys = new Set<string>(Object.keys(all));
  if (!enumerated) {
    for (const key of Object.keys(CHROME_KEY_CATEGORY)) keys.add(key);
    for (const key of configStorageKeys()) keys.add(key);
  }

  const configKeys = new Set(configStorageKeys());
  const configRawKeys = new Set(configRawStorageKeys());
  let measuredSum = 0;
  let usedEstimate = false;

  for (const key of keys) {
    let bytes = -1;
    if (typeof area.getBytesInUse === 'function') {
      try {
        bytes = await area.getBytesInUse([key]);
      } catch {
        bytes = -1;
      }
    }
    if (bytes < 0) {
      usedEstimate = true;
      const value = enumerated ? all[key] : (await area.get([key]))?.[key];
      bytes = value === undefined ? 0 : Math.max(0, jsonBytes(value));
    }
    const category = CHROME_KEY_CATEGORY[key] ?? (configKeys.has(key) ? 'config' : 'other');
    // 条目数需要键的值；未枚举到全量键时按需补读（仅限需要计数的分类）
    let rawValue: unknown = enumerated ? all[key] : undefined;
    if (rawValue === undefined && VALUE_COUNTED_CATEGORIES.has(category)) {
      rawValue = (await area.get([key]))?.[key];
    }
    const count = itemCountOf(category, key, rawValue);
    bucket(category).bytes += bytes;
    bucket(category).count += count;
    if (category === 'config') {
      addChild(bucket('config'), configRawKeys.has(key) ? 'raw' : 'domains', bytes, 1);
    } else if (category === 'other') {
      addChild(bucket('other'), 'chrome', bytes, 1);
    } else if (category === 'files') {
      addFileChildren(bucket('files'), rawValue, bytes, count);
    } else {
      addChild(bucket(category), childIdOf(category, key, 'chrome'), bytes, count);
    }
    measuredSum += bytes;
  }

  if (usedEstimate) {
    issues.push('部分 chrome.storage.local 键不支持精确字节计量，分类数值为估算值');
  }

  // 浏览器权威总量（getBytesInUse(null)）
  let authoritative = -1;
  if (typeof area.getBytesInUse === 'function') {
    try {
      authoritative = await area.getBytesInUse(null);
    } catch {
      authoritative = -1;
    }
  }
  if (authoritative < 0) return measuredSum;

  const diff = authoritative - measuredSum;
  const tolerance = Math.max(1024, Math.floor(authoritative * 0.02));
  if (Math.abs(diff) > tolerance) {
    issues.push(
      `chrome.storage.local 逐键合计与浏览器总量相差 ${diff > 0 ? '+' : ''}${diff} 字节` +
        (diff > 0 ? '，已计入「其他」分类' : '，以逐键合计为准'),
    );
  }
  if (diff > 0) {
    // 多出来的部分归入「其他」，保证「分类合计 == 总量」
    bucket('other').bytes += diff;
    addChild(bucket('other'), 'chrome', diff);
    return authoritative;
  }
  if (diff < 0) {
    // 逐键计量高于浏览器总量（逐键含额外开销）：以逐键合计为准，保证自洽
    return measuredSum;
  }
  return authoritative;
}

/**
 * 某个存储键承载的**条目数**（逻辑条目，不是存储键数）。
 *
 * 口径说明：
 * - 字节数是**物理占用**（chrome 与 localStorage 各存一份就各算一份）；
 * - 条目数是**逻辑条目**（5 个技能就是 5 项，不是 10 项）——因此 localStorage
 *   镜像键不再重复计数，否则用户会看到「5 个技能 / 10 项」这种自相矛盾的数字；
 * - 无法归类的键贡献 0（不展示条数），避免用无意义的数字充数。
 */
function itemCountOf(category: StorageCategoryId, key: string, value: unknown): number {
  switch (category) {
    case 'skills': {
      if (key === SKILL_TOGGLES_STORAGE_KEY) {
        return isRecordLike(value) ? Object.keys(value).length : 0;
      }
      return Array.isArray(value) ? value.length : 0;
    }
    case 'agents':
      return Array.isArray(value) ? value.length : 0;
    case 'plans': {
      const sessions = isRecordLike(value) ? value.sessions : undefined;
      return isRecordLike(sessions) ? Object.keys(sessions).length : 0;
    }
    case 'files':
      return isRecordLike(value) ? Object.keys(value).length : 0;
    case 'metrics': {
      const byModel = isRecordLike(value) ? value.byModel : undefined;
      const byScope = isRecordLike(value) ? value.byScope : undefined;
      const models = isRecordLike(byModel) ? Object.keys(byModel).length : 0;
      const scopes = isRecordLike(byScope) ? Object.keys(byScope).length : 0;
      return models + scopes;
    }
    case 'notes':
      // 笔记条目数由笔记库（IndexedDB）统计给出；此处是存储键侧，
      // 不重复计数（否则同一批笔记会被数两次）
      return 0;
    case 'config':
      // 配置以「域」计（由引擎诊断给出），此处不重复计数
      return 0;
    default:
      return 1;
  }
}

/** 是否为普通对象（非数组、非 null） */
function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 条目数需要读取键值的分类（其余分类的条目数不依赖键值） */
const VALUE_COUNTED_CATEGORIES: ReadonlySet<StorageCategoryId> = new Set([
  'skills',
  'agents',
  'plans',
  'files',
  'metrics',
]);

/**
 * localStorage 全量枚举（优先用端口自带的 entries()）。
 *
 * 端口未提供枚举能力时，只有当它**就是**全局 localStorage 时才回退到全局
 * 枚举——否则宁可只统计已知键（口径自洽：统计了多少就计入多少），
 * 也不去读一个与端口无关的存储面（那会让合计与分类对不上）。
 */
interface EnumerableLocalStore extends LocalStoreLike {
  entries?(): { key: string; value: string }[] | null;
}

function readLocalEntries(store: LocalStoreLike): { key: string; value: string }[] | null {
  const candidate = store as EnumerableLocalStore;
  if (typeof candidate.entries === 'function') {
    try {
      return candidate.entries() ?? null;
    } catch {
      return null;
    }
  }
  if (typeof localStorage !== 'undefined' && (store as unknown) === localStorage) {
    return localStorageEntries();
  }
  return null;
}

/** localStorage 计量（UTF-8 估算：键名 + 值） */
function measureLocalStorage(
  store: LocalStoreLike,
  bucket: (id: StorageCategoryId) => CategoryBucket,
): number {
  const entries = readLocalEntries(store);
  if (!entries) {
    // 端口可用但无法枚举：退化为按已知键逐个读（未分类键此时不可见，
    // 但「合计」与「分类合计」仍然自洽——不多算也不少算）
    let total = 0;
    for (const key of Object.keys(LOCAL_KEY_CATEGORY)) {
      const value = safeGetItem(store, key);
      if (value === null) continue;
      const bytes = utf8Bytes(key) + utf8Bytes(value);
      const category = LOCAL_KEY_CATEGORY[key] ?? 'other';
      const count = (LOCAL_MIRROR_KEYS as readonly string[]).includes(key)
        ? 0
        : itemCountOf(category, key, undefined);
      bucket(category).bytes += bytes;
      bucket(category).count += count;
      addChild(bucket(category), childIdOf(category, key, 'local'), bytes, count);
      total += bytes;
    }
    return total;
  }
  let total = 0;
  for (const entry of entries) {
    const bytes = utf8Bytes(entry.key) + utf8Bytes(entry.value);
    const category = LOCAL_KEY_CATEGORY[entry.key] ?? 'other';
    // localStorage 镜像键不重复计数（逻辑条目已由 chrome 权威源计入）
    const count = (LOCAL_MIRROR_KEYS as readonly string[]).includes(entry.key)
      ? 0
      : itemCountOf(category, entry.key, undefined);
    bucket(category).bytes += bytes;
    bucket(category).count += count;
    addChild(bucket(category), childIdOf(category, entry.key, 'local'), bytes, count);
    total += bytes;
  }
  return total;
}

/** 读 localStorage 单键（抛错时返回 null） */
function safeGetItem(store: LocalStoreLike, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

/**
 * 子项归属：把某个键映射到所属分类的子项 id。
 *
 * 参数 plane 用于区分同一分类在不同存储面上的子项（misc 的「扩展存储键」
 * 与「本地存储键」、other 的三种来源都必须分开，否则子项含义会串）。
 * 未登记的键统一归入该分类的默认子项。
 */
function childIdOf(
  category: StorageCategoryId,
  key: string,
  plane: 'chrome' | 'local',
): string {
  switch (category) {
    case 'skills':
      return key === 'agentNexusSkillPresetToggles' ? 'toggles' : 'custom';
    case 'agents':
      return 'custom';
    case 'plans':
      return 'sessions';
    case 'files':
      return 'content';
    case 'notes':
      return key === NOTES_FOLDERS_STORAGE_KEY ? 'folders' : 'content';
    case 'capturedFiles':
      return 'binary';
    case 'metrics':
      return 'totals';
    case 'misc':
      return plane === 'local' ? 'local' : 'chrome';
    case 'config':
      return 'domains';
    case 'python':
      return 'env';
    case 'other':
      return plane === 'local' ? 'local' : 'chrome';
    default:
      return category;
  }
}

/**
 * 托管文件的子项拆分（内容 vs 元信息）。
 *
 * 直接按记录切分，而不是把整个键算作一个子项——托管文件的内容常常远大于
 * 元信息，用户需要看到这层差异才知道「删哪一类最划算」。
 * 差额（键的 JSON 结构开销）并入「元信息」，保证子项合计 == 父项合计。
 */
function addFileChildren(
  bucket: CategoryBucket,
  value: unknown,
  parentBytes: number,
  count: number,
): void {
  let contentBytes = 0;
  let metaBytes = 0;
  if (isRecordLike(value)) {
    for (const file of Object.values(value)) {
      if (!isRecordLike(file)) continue;
      const { content, ...meta } = file;
      contentBytes += Math.max(0, jsonBytes(content));
      metaBytes += Math.max(0, jsonBytes(meta));
    }
  }
  const diff = parentBytes - contentBytes - metaBytes;
  if (diff > 0) metaBytes += diff;
  addChild(bucket, 'content', contentBytes, count);
  // 元信息不是独立条目 → 不重复计数（否则「N 个文件」会被数成 2N）
  addChild(bucket, 'meta', metaBytes, 0);
}

/** IndexedDB 各库计量（估算） */
async function measureIndexedDb(
  idb: IdbPort | null,
  bucket: (id: StorageCategoryId) => CategoryBucket,
  issues: string[],
): Promise<{ bytes: number; known: boolean }> {
  if (!idb) {
    issues.push('IndexedDB 不可用，未统计数据库占用');
    return { bytes: -1, known: false };
  }

  let total = 0;
  let known = true;
  /** 全部消息（null = 读取失败；图片引用判定依赖它，失败时不做「可回收」判定） */
  let messages: ChatMessageRecord[] | null = null;

  // ── 会话库（转录）：会话元信息 + 消息文字与结构 ──
  try {
    const sessions = await chatDatabase.listAllSessions();
    messages = await chatDatabase.listAllMessages();
    let sessionBytes = 0;
    for (const session of sessions) sessionBytes += Math.max(0, jsonBytes(session));
    let messageBytes = 0;
    for (const message of messages) messageBytes += Math.max(0, jsonBytes(message));
    const bytes = sessionBytes + messageBytes;
    total += bytes;
    bucket('conversations').bytes += bytes;
    bucket('conversations').count += sessions.length + messages.length;
    addChild(bucket('conversations'), 'sessions', sessionBytes, sessions.length);
    addChild(bucket('conversations'), 'messages', messageBytes, messages.length);
  } catch (error) {
    known = false;
    messages = null;
    issues.push(`会话数据库统计失败：${describe(error)}`);
  }

  // ── 图片库：按内容寻址的字节 + 引用 / 孤儿拆分 ──
  try {
    const records = await imageDatabase.listAll();
    let imageBytes = 0;
    const sizeByHash = new Map<string, number>();
    for (const record of records) {
      const bytes = record.byteSize >= 0 ? record.byteSize : estimateValueBytes(record.blob);
      sizeByHash.set(record.hash, bytes);
      imageBytes += bytes;
    }
    total += imageBytes;
    bucket('images').bytes += imageBytes;
    bucket('images').count += records.length;

    if (messages) {
      // 引用集合 = 消息里的 imageRefs + modelMessages 里的协议引用
      const referenced = collectReferencedImageHashes(messages);
      let referencedBytes = 0;
      let referencedCount = 0;
      for (const hash of referenced) {
        const size = sizeByHash.get(hash);
        if (size === undefined) continue;
        referencedBytes += size;
        referencedCount += 1;
      }
      const orphanBytes = Math.max(0, imageBytes - referencedBytes);
      const orphanCount = Math.max(0, records.length - referencedCount);
      addChild(bucket('images'), 'referenced', referencedBytes, referencedCount);
      addChild(bucket('images'), 'orphan', orphanBytes, orphanCount);
      bucket('images').reclaimableBytes = orphanBytes;
      bucket('images').reclaimableCount = orphanCount;
    } else {
      // 引用关系不可知 → **不判定**可回收量。猜「全部可回收」会让用户
      // 删掉仍在使用的图片；宁可少给一条提示，也不能给出危险的结论。
      issues.push('会话消息读取失败，无法判定图片引用关系，未标注可回收的孤儿图片');
    }
  } catch (error) {
    known = false;
    issues.push(`图片数据库统计失败：${describe(error)}`);
  }

  // ── 笔记库 ──
  try {
    const notes = await notesDB.listAllNotes();
    let contentBytes = 0;
    let metaBytes = 0;
    for (const note of notes) {
      contentBytes += Math.max(
        0,
        jsonBytes({ content: note.content, text: note.text ?? '' }),
      );
      metaBytes += Math.max(
        0,
        jsonBytes({
          id: note.id,
          kind: note.kind,
          title: note.title,
          category: note.category,
          tags: note.tags ?? [],
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          ...(note.source ? { source: note.source } : {}),
        }),
      );
    }
    const bytes = contentBytes + metaBytes;
    total += bytes;
    bucket('notes').bytes += bytes;
    bucket('notes').count += notes.length;
    addChild(bucket('notes'), 'content', contentBytes, notes.length);
    // 元信息不是独立条目 → 不重复计数
    addChild(bucket('notes'), 'meta', metaBytes, 0);
  } catch (error) {
    known = false;
    issues.push(`笔记数据库统计失败：${describe(error)}`);
  }

  // ── 捕获文件库 ──
  try {
    const files = await downloadDB.getAllFiles();
    let bytes = 0;
    for (const file of files) bytes += Math.max(0, file.size || estimateValueBytes(file.blobData));
    total += bytes;
    bucket('capturedFiles').bytes += bytes;
    bucket('capturedFiles').count += files.length;
    addChild(bucket('capturedFiles'), 'binary', bytes, files.length);
  } catch (error) {
    known = false;
    issues.push(`捕获文件数据库统计失败：${describe(error)}`);
  }

  // ── Python 运行时缓存（IndexedDB） ──
  try {
    const metas = await pyodideListFileMeta();
    let bytes = 0;
    for (const meta of metas) bytes += Math.max(0, meta.size);
    total += bytes;
    bucket('python').bytes += bytes;
    bucket('python').count += metas.length;
    addChild(bucket('python'), 'cache', bytes, metas.length);
  } catch (error) {
    known = false;
    issues.push(`Python 运行时缓存统计失败：${describe(error)}`);
  }

  // ── 其它数据库（历史遗留 / 第三方写入）：逐库估算，避免漏算 ──
  try {
    const knownDbs = new Set([
      'AgentNexusChatDB',
      'AgentNexusImageDB',
      'AgentNexusNotesDB',
      'CapturedFileDB',
      'AgentNexusPyodideDB',
    ]);
    const databases = await idb.databases();
    if (databases === null) {
      issues.push('当前浏览器不支持枚举 IndexedDB 数据库，未分类数据库的占用可能未被计入');
    } else {
      for (const item of databases) {
        if (knownDbs.has(item.name)) continue;
        const bytes = await estimateDatabaseBytes(idb, item.name);
        if (bytes < 0) {
          known = false;
          issues.push(`数据库 ${item.name} 统计失败`);
          continue;
        }
        total += bytes;
        bucket('other').bytes += bytes;
        addChild(bucket('other'), 'database', bytes);
      }
    }
  } catch (error) {
    issues.push(`枚举 IndexedDB 数据库失败：${describe(error)}`);
  }

  return { bytes: total, known };
}

/** 采集「仍被会话引用」的图片哈希集合（基于已读出的消息，不再二次读库） */
function collectReferencedImageHashes(messages: readonly ChatMessageRecord[]): Set<string> {
  const refs = new Set<string>();
  for (const message of messages) {
    const list = Array.isArray(message.imageRefs) ? message.imageRefs : [];
    for (const ref of list) if (typeof ref === 'string') refs.add(ref);
    // 模型面消息里也可能带图片引用（modelMessages / modelContext）
    for (const ref of protocolImageRefs(message.modelMessages)) refs.add(ref);
    for (const ref of protocolImageRefs(message.modelContext)) refs.add(ref);
  }
  return refs;
}

// ==================== 汇总与呈现 ====================

/**
 * 部分求和：统计失败的存储面按 0 计入，合计 = 已知部分之和。
 * 失败面会在 issues 中显式说明（不静默少算，也不谎报总量）。
 */
function sumPartial(values: number[], issues: string[]): number {
  let total = 0;
  let missing = 0;
  for (const value of values) {
    if (value < 0) {
      missing++;
      continue;
    }
    total += value;
  }
  if (missing) {
    issues.push(`${missing} 个存储面统计失败，合计为已知部分之和，实际占用可能更高`);
  }
  return total;
}

/** 生成分类明细（含子项与占比） */
function buildCategories(
  buckets: Map<StorageCategoryId, CategoryBucket>,
  totalBytes: number,
): StorageCategoryStat[] {
  const stats: StorageCategoryStat[] = [];
  for (const id of STORAGE_CATEGORY_ORDER) {
    const value = buckets.get(id) ?? emptyBucket();
    const bytes = value.known ? value.bytes : -1;
    const children = buildChildren(id, value);
    stats.push({
      id,
      labelKey: categoryLabelKey(id),
      bytes,
      count: value.count || undefined,
      share: bytes > 0 && totalBytes > 0 ? Math.min(1, bytes / totalBytes) : 0,
      inBackup: CATEGORY_IN_BACKUP[id],
      tipKey: CATEGORY_TIP_KEYS[id],
      children: children.length ? children : undefined,
      reclaimableBytes: value.reclaimableBytes,
      reclaimableCount: value.reclaimableCount,
    });
  }
  return stats;
}

/** 生成分类子项（share 相对父项） */
function buildChildren(id: StorageCategoryId, value: CategoryBucket): StorageChildStat[] {
  const out: StorageChildStat[] = [];
  const parentBytes = value.bytes;
  for (const [childId, child] of value.children) {
    out.push({
      id: childId,
      labelKey: CHILD_LABEL_KEYS[`${id}.${childId}`] ?? 'sidepanel.backup.catOther',
      bytes: child.bytes,
      count: child.count || undefined,
      share: parentBytes > 0 ? Math.min(1, child.bytes / parentBytes) : 0,
    });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}

/** 对话数据的「文字 vs 多媒体」构成（归属视图） */
function buildConversationMedia(
  bucket: (id: StorageCategoryId) => CategoryBucket,
): ConversationMediaSplit {
  const conversations = bucket('conversations');
  const images = bucket('images');
  const textBytes = conversations.known ? conversations.bytes : -1;
  const referencedBytes =
    images.known && images.reclaimableBytes !== undefined
      ? Math.max(0, images.bytes - images.reclaimableBytes)
      : -1;
  const totalBytes =
    textBytes >= 0 && referencedBytes >= 0 ? textBytes + referencedBytes : -1;
  const referencedCount =
    images.reclaimableBytes !== undefined && images.reclaimableCount !== undefined
      ? Math.max(0, images.count - images.reclaimableCount)
      : undefined;
  return {
    textBytes,
    mediaBytes: referencedBytes,
    totalBytes,
    mediaShare:
      totalBytes > 0 && referencedBytes >= 0
        ? Math.max(0, Math.min(1, referencedBytes / totalBytes))
        : 0,
    mediaCount: referencedCount,
    textCount: conversations.count || undefined,
  };
}

/** 错误转可读文本 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

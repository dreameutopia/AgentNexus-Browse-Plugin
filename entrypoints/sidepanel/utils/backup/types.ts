/**
 * 备份引擎类型 —— 备份文件格式、分区处理器契约、存储占用报告
 *
 * 文件格式（agentnexus.backup）：
 *   { format, version, appVersion, exportedAt, sections: { <id>: {schema,rev,updatedAt,data} }, checksum }
 * - v1（历史格式）：仅 6 个配置分区，解析器仍然接受（按文件自带 version 复核校验和）；
 * - v2：配置分区 + 数据分区（技能/智能体/计划/文件/用量/杂项/笔记/图片/会话/捕获文件）。
 *
 * 分区处理器契约（SectionHandler）——防御性核心约定：
 * 1. collect()    导出采集；返回 null = 无数据（分区不写入备份）；
 * 2. validate()   纯函数结构校验，**全部分区先校验、任一失败零写入**；
 * 3. apply()      按策略写入，必须**对本分区原子**（抛错时自身状态不变，
 *                 单事务/单键 set 实现）；成功返回跨分区回滚闭包
 *                 （后续分区失败时逆序撤销本分区）；
 *    - 返回 {skipped} = 补充导入下本机已有数据、按约定跳过；
 *    - 返回 {rollback: null} **仅允许最后一个生效分区使用**（原子且其后无分区，
 *      失败时它自身未变、无需被他人回滚）——编排器按顺序执行天然满足，
 *      注册表顺序见 DATA_SECTION_ORDER（capturedFiles 恒为末位）。
 * 4. 契约由编排器（engine.ts）+ 注册表顺序 + 测试共同保证，处理器不得绕过。
 */

import type { MessageKey } from '@/utils/i18n';
import type { ConfigEngine, SectionId } from '../config/engine';
import type { LocalStoreLike, StorageAreaLike } from '../config/types';

/** 备份文件格式标记（复用 config/backup 的历史值，单一事实源在 format.ts） */
export type { SectionId };

/** 当前备份格式版本（2 = 含数据分区；1 = 仅配置分区的历史格式） */
export const BACKUP_VERSION = 2;

/** 导入策略（语义与历史版本一致） */
export type BackupStrategy =
  /** 覆盖导入：以备份为准 */
  | 'replace'
  /** 补充导入：只填补本机空缺，已有值一律保留 */
  | 'fill';

/** 单个分区（文件内） */
export interface BackupSection {
  schema: number;
  rev: number;
  updatedAt: number;
  data: unknown;
}

/** 备份文件 */
export interface BackupFile {
  format: string;
  version: number;
  appVersion: string;
  exportedAt: string;
  sections: Record<string, BackupSection>;
  checksum: string;
}

/** 解析失败码（与历史 ParseFailure 一一对应，UI 按码取文案） */
export type ParseFailure =
  | 'not-json'
  | 'bad-format'
  | 'bad-version'
  | 'future-version'
  | 'checksum'
  | 'no-sections'
  | 'invalid-section';

export type ParseResult =
  | { ok: true; backup: BackupFile; warnings: string[] }
  | { ok: false; errors: ParseFailure[] };

/** 导入报告（字段语义与历史 ApplyReport 兼容） */
export interface ApplyReport {
  /** 实际写入的分区（失败且成功回滚后会被清空） */
  applied: string[];
  /** 跳过的分区（本机已有数据 / 未知分区） */
  skipped: { id: string; reason: string }[];
  /** 失败分区（含回滚失败条目 message='rollback-failed'） */
  errors: { id: string; message: string }[];
  /** 是否因失败触发了回滚且**全部**已写分区均还原成功 */
  rolledBack: boolean;
}

// ==================== 分区处理器 ====================

/** 回滚闭包（跨分区失败时逆序执行；自身失败只记入报告，不阻断其余回滚） */
export type RollbackFn = () => Promise<void>;

/** apply 成功产物：跳过（补充导入命中已有值）或回滚闭包（null = 原子末位分区） */
export type ApplyOutcome = { skipped: true; reason: string } | { rollback: RollbackFn | null };

/** 处理器可依赖的注入端口（测试注入内存实现；缺省走 chrome/localStorage 单例） */
export interface BackupPorts {
  engine: ConfigEngine;
  area: StorageAreaLike;
  localStore: LocalStoreLike | null;
}

export interface SectionHandler {
  /** 分区 id（配置分区 = SectionId，数据分区 = DataSectionId） */
  id: string;
  /** 媒体门控：导出时 includeMedia=false 则整体跳过（图片/捕获文件） */
  media?: boolean;
  /** 导出采集；null = 无数据（该分区不出现在备份中） */
  collect(): Promise<unknown | null>;
  /** 纯结构校验（全部分区先校验；false → 整体拒绝、零写入）。不得有副作用、不得抛错 */
  validate(data: unknown): boolean;
  /**
   * 按策略写入。
   * @throws 本分区失败（必须保证自身状态未变——原子写）
   * @returns 跳过原因，或跨分区回滚闭包（null 仅限末位分区）
   */
  apply(data: unknown, strategy: BackupStrategy): Promise<ApplyOutcome>;
}

// ==================== 数据分区 ====================

/**
 * 数据分区 id。
 * 顺序即**导入写入顺序**（快照/写入/回滚均按此序）：
 * - 前段（chrome/localStorage 键值类）失败可整体回滚，代价低；
 * - capturedFiles 恒为末位且为单事务原子写——它是唯一允许返回
 *   rollback:null 的分区（其后无分区，失败时自身未变即可）。
 */
export type DataSectionId =
  | 'skills'
  | 'agents'
  | 'plans'
  | 'files'
  | 'metrics'
  | 'misc'
  | 'images'
  | 'notes'
  | 'conversations'
  | 'capturedFiles';

/** 数据分区写入顺序（含媒体门控分区；导出顺序同此序） */
export const DATA_SECTION_ORDER: readonly DataSectionId[] = [
  'skills',
  'agents',
  'plans',
  'files',
  'metrics',
  'misc',
  'images',
  'notes',
  'conversations',
  'capturedFiles',
];

/** 受「包含多媒体」开关控制的分区（导出时可整体剔除以缩小文件） */
export const MEDIA_SECTION_IDS: ReadonlySet<string> = new Set(['images', 'capturedFiles']);

/** 各分区的展示标签（i18n 键，UI 预览列表用） */
export const SECTION_LABEL_KEYS: Record<string, MessageKey> = {
  // 配置分区
  channels: 'sidepanel.backup.secChannels',
  appSettings: 'sidepanel.backup.secAppSettings',
  asrConfig: 'sidepanel.backup.secAsrConfig',
  systemSettings: 'sidepanel.backup.secSystemSettings',
  locale: 'sidepanel.backup.secLocale',
  workflows: 'sidepanel.backup.secWorkflows',
  // 数据分区
  skills: 'sidepanel.backup.secSkills',
  agents: 'sidepanel.backup.secAgents',
  plans: 'sidepanel.backup.secPlans',
  files: 'sidepanel.backup.secFiles',
  metrics: 'sidepanel.backup.secMetrics',
  misc: 'sidepanel.backup.secMisc',
  images: 'sidepanel.backup.secImages',
  notes: 'sidepanel.backup.secNotes',
  conversations: 'sidepanel.backup.secConversations',
  capturedFiles: 'sidepanel.backup.secCapturedFiles',
};

/** 任一分区的展示标签（未知分区返回 undefined，UI 回落显示原始 id） */
export function sectionLabelKey(id: string): MessageKey | undefined {
  return SECTION_LABEL_KEYS[id];
}

/** 分区摘要（导入预览用：条目数等，key+参数交给 UI 做 i18n 插值） */
export type SectionSummary = { key: MessageKey; params: Record<string, number> };

// ==================== 存储占用报告 ====================

/** 报告分类中的一项（bytes = -1 表示该项统计失败，UI 显示「—」） */
export interface StorageCategoryStat {
  id: string;
  labelKey: MessageKey;
  /** 占用字节数（估算值；-1 = 统计失败） */
  bytes: number;
  /** 条目数（会话/技能/笔记等；未知不提供） */
  count?: number;
  countKey?: MessageKey;
  countParams?: Record<string, number>;
  /** 占总用量比例（0..1；bytes<0 时为 0） */
  share: number;
  /** 是否随备份导出（false = 仅统计，tip 说明缩小方式/不备份原因） */
  inBackup: boolean;
  /** 如何缩小的提示（i18n 键） */
  tipKey?: MessageKey;
  /** 子项（如对话数据 → 文字 / 图片），share 相对**父项** */
  children?: StorageChildStat[];
  /** 无引用、可安全清理的字节数（仅图片提供；>0 时 UI 追加提示行） */
  reclaimableBytes?: number;
  reclaimableCount?: number;
}

/** 分类子项 */
export interface StorageChildStat {
  id: string;
  labelKey: MessageKey;
  bytes: number;
  count?: number;
  countKey?: MessageKey;
  countParams?: Record<string, number>;
  share: number;
}

/** 存储占用总报告 */
export interface StorageReport {
  /** 全插件合计（chrome.storage.local + localStorage + 全部 IndexedDB 库） */
  totalBytes: number;
  /** chrome.storage.local 精确总量（getBytesInUse(null)；不可用为 -1） */
  chromeBytes: number;
  /** localStorage 合计（UTF-8 估算；不可用为 -1） */
  localBytes: number;
  /** IndexedDB 各库合计（估算） */
  idbBytes: number;
  categories: StorageCategoryStat[];
  /** 统计过程中的非致命问题（透明呈现，不静默吞掉） */
  issues: string[];
  generatedAt: number;
}

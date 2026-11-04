/**
 * 备份与存储统计引擎（对外统一入口）
 *
 * 分层：
 *   bytes.ts        纯字节工具（UTF-8 计量 / 格式化 / base64）
 *   ports.ts        存储端口（chrome.storage.local / localStorage / IndexedDB）
 *   storage-keys.ts 键名清单（单一事实源：键 → 分类映射）
 *   types.ts        类型与契约（备份文件格式 / 分区契约 / 占用报告）
 *   format.ts       备份文件格式（校验和 / 序列化 / 解析）
 *   sections.ts     数据分区处理器注册表（10 个数据分区）
 *   engine.ts       编排器（导出 / 导入）
 *   storage-stats.ts 存储占用统计引擎
 *
 * 消费方（管理中心的备份分区）只需从本入口导入。
 */

export { BACKUP_VERSION, DATA_SECTION_ORDER, MEDIA_SECTION_IDS, SECTION_LABEL_KEYS, sectionLabelKey } from './types';
export type {
  ParseFailure,
  ApplyReport,
  BackupFile,
  BackupSection,
  BackupStrategy,
  SectionHandler,
  SectionSummary,
  StorageCategoryId,
  StorageCategoryStat,
  StorageChildStat,
  StorageReport,
  ConversationMediaSplit,
} from './types';

export {
  BACKUP_FORMAT,
  computeBackupChecksum,
  defaultBackupFileName,
  defaultFullBackupFileName,
  downloadBackup,
  fillMerge,
  MIN_BACKUP_VERSION,
  parseFullBackup,
  serializeBackup,
  serializeBackupCompact,
  stripSecrets,
} from './format';

export {
  applyFullBackup,
  buildFullBackup,
  defaultSectionDeps,
  DATA_SECTION_SCHEMA,
} from './engine';
export type { ApplyBackupOptions, BuildBackupOptions, BuildBackupResult } from './engine';

export { createDataSectionHandlers } from './sections';
export type { SectionDeps } from './sections';

export {
  categoryLabelKey,
  collectStorageReport,
  STORAGE_CATEGORY_ORDER,
} from './storage-stats';
export type { CollectStorageOptions } from './storage-stats';

export { estimateValueBytes, formatBytes, jsonBytes, percentText, utf8Bytes } from './bytes';

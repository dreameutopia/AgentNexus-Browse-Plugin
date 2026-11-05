/**
 * 配置持久化引擎 —— 统一出口
 *
 * 典型用法：
 *   import { getEngine, initConfigEngine } from '@/entrypoints/sidepanel/utils/config';
 *
 *   // 启动（main.ts 挂载 Vue 前）
 *   await initConfigEngine();
 *
 *   // 读写受管配置域
 *   const state = await getEngine().domain<ChannelState>('channels').load();
 *   await getEngine().domain<ChannelState>('channels').save(next);
 *
 *   // 备份导出 / 导入
 *   const file = await buildBackup({ includeSecrets: true });
 *   downloadBackup(serializeBackup(file));
 *   const parsed = parseBackup(text);
 *   if (parsed.ok) await applyBackup(parsed.backup, 'replace');
 */

export type {
  DomainDiagnostics,
  DomainLoadResult,
  DomainSaveResult,
  DomainSource,
  EngineDiagnostics,
  EngineHealth,
  LocalStoreLike,
  SnapshotEntry,
  StorageAreaLike,
} from './types';

export {
  checksum,
  checksumOf,
  stableStringify,
} from './checksum';

export {
  decodeEnvelope,
  encodeEnvelope,
  computeDataChecksum,
  ENGINE_FORMAT,
  ENGINE_SCHEMA,
  type Envelope,
  type DecodeResult,
} from './envelope';

export {
  ConfigFrozenError,
  ConfigWriteError,
  DEFAULT_SNAPSHOT_COUNT,
  DEFAULT_VERIFY_RETRIES,
  isInitialEmptyState,
  MIRROR_SUFFIX,
  ResilientDomain,
  SNAPSHOT_SUFFIX,
  type DomainOptions,
} from './kv-store';

export {
  ALL_SECTION_IDS,
  ConfigEngine,
  getEngine,
  initConfigEngine,
  setEngineForTesting,
  syncExternalStores,
  type DomainId,
  type EngineDeps,
  type InitReport,
  type RawSectionId,
  type SectionId,
  type SectionSnapshot,
} from './engine';

export {
  applyBackup,
  buildBackup,
  defaultBackupFileName,
  downloadBackup,
  fillMerge,
  parseBackup,
  serializeBackup,
  stripSecrets,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  type ApplyReport,
  type BackupFile,
  type BackupSection,
  type BackupStrategy,
  type BuildBackupOptions,
  type ParseFailure,
  type ParseResult,
} from './backup';

export {
  isRecord,
  isChannelStateLike,
  isAppSettingsLike,
  isUserAsrConfigLike,
} from './validators';

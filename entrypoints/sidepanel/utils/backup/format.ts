/**
 * 备份文件格式层 —— 校验和、序列化、解析（v1 与 v2 统一入口）
 *
 * 与 config/backup.ts 的关系（单一事实源原则）：
 * - BACKUP_FORMAT / stripSecrets / fillMerge / serializeBackup / downloadBackup /
 *   defaultBackupFileName **直接复用** config/backup 的既有导出（同一格式家族）；
 * - 校验和公式与 config/backup.ts 完全一致（checksumOf({format, version, sections})，
 *   按文件自带 version 复核）——tests/backup 会用 config/backup.buildBackup 产出的
 *   v1 文件跑本解析器，以测试强制两条路径公式同步，杜绝漂移；
 * - 解析接受 version ∈ [1, 2]：v1 = 仅配置分区的历史格式，v2 = 含数据分区。
 * - 未知分区仅告警并跳过（前向兼容，与历史行为一致）。
 */

import { ALL_SECTION_IDS } from '../config/engine';
import {
  BACKUP_FORMAT,
  defaultBackupFileName,
  downloadBackup,
  fillMerge,
  serializeBackup,
  stripSecrets,
} from '../config/backup';
import { checksumOf } from '../config/checksum';
import { BACKUP_VERSION, DATA_SECTION_ORDER, type BackupFile, type ParseFailure, type ParseResult } from './types';

// 复用历史格式家族的公共件（不重复实现）
export {
  BACKUP_FORMAT,
  defaultBackupFileName,
  downloadBackup,
  fillMerge,
  serializeBackup,
  stripSecrets,
};

/** 可接受的最低历史版本 */
export const MIN_BACKUP_VERSION = 1;

/**
 * 默认备份文件名（完整备份：配置 + 数据）
 * 与 config/backup 的 defaultBackupFileName 区分开——前者是「配置备份」，
 * 后者是「完整备份」，文件名不同可避免用户把两者搞混。
 */
export function defaultFullBackupFileName(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `agentnexus-backup-${stamp}.json`;
}

/**
 * 序列化为紧凑 JSON（完整备份用）。
 *
 * 校验和是对 sections 对象计算的，与序列化格式无关，因此紧凑序列化
 * 不影响完整性校验；数据分区含 base64 图片时，缩进会额外膨胀约 10%。
 */
export function serializeBackupCompact(backup: BackupFile): string {
  return JSON.stringify(backup);
}

/** 已知分区全集：配置 6 分区 + 数据 9 分区（解析告警判定用） */
const KNOWN_SECTION_IDS: ReadonlySet<string> = new Set<string>([
  ...ALL_SECTION_IDS,
  ...DATA_SECTION_ORDER,
]);

/** 校验和（公式必须与 config/backup.ts 的 computeBackupChecksum 一致，见文件头注释） */
export function computeBackupChecksum(version: number, sections: unknown): string {
  return checksumOf({ format: BACKUP_FORMAT, version, sections });
}

/**
 * 解析备份文本（不做任何写入）。
 * v1 文件按其自带 version 复核校验和 → 新旧文件同一公式互通。
 */
export function parseFullBackup(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['not-json'] };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['bad-format'] };
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.format !== BACKUP_FORMAT) return { ok: false, errors: ['bad-format'] };

  const version = candidate.version;
  if (typeof version !== 'number' || !Number.isFinite(version) || version < 1) {
    return { ok: false, errors: ['bad-version'] };
  }
  if (version > BACKUP_VERSION || version < MIN_BACKUP_VERSION) {
    return { ok: false, errors: ['future-version'] };
  }

  const sections = candidate.sections;
  if (typeof sections !== 'object' || sections === null || Array.isArray(sections)) {
    return { ok: false, errors: ['bad-format'] };
  }
  const sectionMap = sections as Record<string, unknown>;
  const keys = Object.keys(sectionMap);
  if (!keys.length) return { ok: false, errors: ['no-sections'] };

  const expected = computeBackupChecksum(version, sectionMap);
  if (typeof candidate.checksum !== 'string' || candidate.checksum !== expected) {
    return { ok: false, errors: ['checksum'] };
  }

  const errors: ParseFailure[] = [];
  const warnings: string[] = [];
  for (const key of keys) {
    const value = sectionMap[key];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push('invalid-section');
      continue;
    }
    const section = value as Record<string, unknown>;
    if (section.data === undefined || typeof section.schema !== 'number') {
      errors.push('invalid-section');
      continue;
    }
    if (!KNOWN_SECTION_IDS.has(key)) warnings.push(`unknown-section:${key}`);
  }
  if (errors.length) return { ok: false, errors };

  const backup: BackupFile = {
    format: BACKUP_FORMAT,
    version,
    appVersion: typeof candidate.appVersion === 'string' ? candidate.appVersion : '',
    exportedAt: typeof candidate.exportedAt === 'string' ? candidate.exportedAt : '',
    sections: sectionMap as BackupFile['sections'],
    checksum: expected,
  };
  return { ok: true, backup, warnings };
}

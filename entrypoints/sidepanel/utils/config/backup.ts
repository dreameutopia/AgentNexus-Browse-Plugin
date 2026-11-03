/**
 * 备份导出 / 导入恢复
 *
 * 文件格式（agentnexus.backup v1）：
 *   {
 *     format, version, appVersion, exportedAt,
 *     sections: { <sectionId>: { schema, rev, updatedAt, data } },
 *     checksum            // 对 { version, sections } 的稳定序列化校验和
 *   }
 *
 * 保证：
 * - **先全量校验再落盘**：任何分区非法 → 整体拒绝，不写一个字节
 * - **落盘失败可回滚**：逐分区写入，中途异常 → 用导入前快照回滚已写分区
 * - **校验和防损坏**：文件被截断/改坏在解析阶段即被拒绝
 * - **前向兼容**：未来版本新增的分区会被跳过并报告，不会让整个导入失败
 * - **可剥离密钥**：导出时可选择不含 API Key，便于分享
 */

import { checksumOf, stableStringify } from './checksum';
import {
  ALL_SECTION_IDS,
  getEngine,
  type ConfigEngine,
  type SectionId,
} from './engine';

/** 备份文件格式标记 */
export const BACKUP_FORMAT = 'agentnexus.backup';
/** 当前备份格式版本 */
export const BACKUP_VERSION = 1;

/** 导入策略 */
export type BackupStrategy =
  /** 覆盖导入：以备份为准 */
  | 'replace'
  /** 补充导入：只填补本机为空的字段，已有值一律保留 */
  | 'fill';

export interface BackupSection {
  schema: number;
  rev: number;
  updatedAt: number;
  data: unknown;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  appVersion: string;
  exportedAt: string;
  sections: Record<string, BackupSection>;
  checksum: string;
}

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

export interface ApplyReport {
  /** 实际写入的分区 */
  applied: SectionId[];
  /** 跳过的分区（本机已有数据 / 未知分区） */
  skipped: { id: string; reason: string }[];
  /** 失败分区 */
  errors: { id: string; message: string }[];
  /** 是否因失败触发了回滚 */
  rolledBack: boolean;
}

export interface BuildBackupOptions {
  /** 是否包含 API Key 等密钥字段，默认 true */
  includeSecrets?: boolean;
  appVersion?: string;
}

/** 需要从导出内容中剔除的敏感字段名 */
const SECRET_KEYS = new Set(['apiKey', 'api_key']);

class BackupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

// ==================== 构建 ====================

/** 采集全部分区并生成备份对象 */
export async function buildBackup(
  options: BuildBackupOptions = {},
  engine: ConfigEngine = getEngine()
): Promise<BackupFile> {
  const includeSecrets = options.includeSecrets !== false;
  const appVersion =
    options.appVersion ?? (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '');

  const sections: Record<string, BackupSection> = {};
  for (const id of ALL_SECTION_IDS) {
    const snapshot = await engine.readSection(id);
    if (!snapshot || snapshot.data === null || snapshot.data === undefined) continue;
    sections[id] = {
      schema: snapshot.schema,
      rev: snapshot.rev,
      updatedAt: snapshot.updatedAt,
      data: includeSecrets ? snapshot.data : stripSecrets(snapshot.data),
    };
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    sections,
    checksum: computeBackupChecksum(BACKUP_VERSION, sections),
  };
}

/** 序列化为可写入文件的 JSON 文本 */
export function serializeBackup(backup: BackupFile): string {
  return JSON.stringify(backup, null, 2);
}

/** 默认文件名：agentnexus-config-20260929-153045.json */
export function defaultBackupFileName(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `agentnexus-config-${stamp}.json`;
}

/** 触发浏览器下载（扩展页面 / 普通网页均可） */
export function downloadBackup(json: string, filename: string = defaultBackupFileName()): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    throw new BackupError('no-download', 'download is not available in this context');
  }
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ==================== 解析 ====================

/** 解析并校验备份 JSON 文本（不做任何写入） */
export function parseBackup(text: string): ParseResult {
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
  if (version > BACKUP_VERSION) return { ok: false, errors: ['future-version'] };

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
    if (!(ALL_SECTION_IDS as readonly string[]).includes(key)) {
      warnings.push(`unknown-section:${key}`);
    }
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

// ==================== 导入 ====================

/**
 * 应用备份（先全量校验 → 再逐分区写入 → 失败回滚）
 * @param strategy replace = 覆盖；fill = 仅填补本机空缺
 */
export async function applyBackup(
  backup: BackupFile,
  strategy: BackupStrategy,
  engine: ConfigEngine = getEngine()
): Promise<ApplyReport> {
  const report: ApplyReport = { applied: [], skipped: [], errors: [], rolledBack: false };

  // 1) 全量校验：任何一个分区不合法 → 直接拒绝，不写任何数据
  const pending: { id: SectionId; data: unknown }[] = [];
  for (const [id, section] of Object.entries(backup.sections)) {
    if (!(ALL_SECTION_IDS as readonly string[]).includes(id)) {
      report.skipped.push({ id, reason: 'unknown-section' });
      continue;
    }
    const sectionId = id as SectionId;
    const data = (section as BackupSection).data;
    if (!engine.validateSection(sectionId, data)) {
      report.errors.push({ id, message: 'invalid-section' });
    } else {
      pending.push({ id: sectionId, data });
    }
  }
  if (report.errors.length) return report;

  // 2) 读取导入前快照（回滚用）
  const preImages = new Map<SectionId, Awaited<ReturnType<ConfigEngine['readSection']>>>();
  for (const item of pending) {
    preImages.set(item.id, await engine.readSection(item.id));
  }

  // 3) 逐分区写入
  const written: SectionId[] = [];
  for (const item of pending) {
    const pre = preImages.get(item.id) ?? null;
    try {
      if (strategy === 'fill') {
        if (pre && pre.data !== null) {
          const merged = fillMerge(pre.data, item.data);
          if (stableStringify(merged) === stableStringify(pre.data)) {
            report.skipped.push({ id: item.id, reason: 'already-configured' });
            continue;
          }
          await engine.writeSection(item.id, merged);
        } else {
          await engine.writeSection(item.id, item.data);
        }
      } else {
        await engine.writeSection(item.id, item.data);
      }
      written.push(item.id);
      report.applied.push(item.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push({ id: item.id, message });

      // 4) 回滚已写入分区
      let rollbackOk = true;
      for (const rollbackId of written) {
        try {
          const rollbackPre = preImages.get(rollbackId);
          if (rollbackPre && rollbackPre.data !== null) {
            await engine.writeSection(rollbackId, rollbackPre.data);
          } else {
            await engine.clearSection(rollbackId);
          }
        } catch {
          rollbackOk = false;
          report.errors.push({ id: rollbackId, message: 'rollback-failed' });
        }
      }
      report.rolledBack = written.length > 0 && rollbackOk;
      report.applied = [];
      return report;
    }
  }

  return report;
}

// ==================== 工具 ====================

function computeBackupChecksum(version: number, sections: unknown): string {
  return checksumOf({ format: BACKUP_FORMAT, version, sections });
}

/** 递归剔除敏感字段（返回新对象，不修改入参） */
export function stripSecrets(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(item => stripSecrets(item));
  if (typeof data !== 'object' || data === null) return data;
  const source = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (SECRET_KEYS.has(key)) continue;
    result[key] = stripSecrets(value);
  }
  return result;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/**
 * 补充合并：current 里为空的字段才取 incoming，已有值一律保留。
 * - 对象递归；数组/标量按「空即填」处理（不做并集，避免语义歧义）
 */
export function fillMerge(current: unknown, incoming: unknown): unknown {
  if (isEmptyValue(current)) return incoming;
  if (isEmptyValue(incoming)) return current;
  if (Array.isArray(current) || Array.isArray(incoming)) return current;
  if (typeof current === 'object' && typeof incoming === 'object') {
    const base = { ...(current as Record<string, unknown>) };
    const patch = incoming as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (isEmptyValue(base[key])) base[key] = value;
      else if (
        typeof base[key] === 'object' &&
        base[key] !== null &&
        !Array.isArray(base[key]) &&
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        base[key] = fillMerge(base[key], value);
      }
    }
    return base;
  }
  return current;
}

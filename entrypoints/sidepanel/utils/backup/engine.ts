/**
 * 备份编排器（导出 / 导入的统一入口）
 *
 * 职责：
 * 1. **导出**：采集配置分区（6 个）+ 数据分区（10 个），合成一个备份文件；
 *    单个分区采集失败**不中断**整体导出，而是记入 issues 并跳过该分区
 *    （否则一条脏数据会让用户完全无法备份——比缺一个分区更糟）；
 * 2. **导入**：先**全量校验**（任一分区非法 → 整体拒绝、零写入），再按
 *    「配置 → 数据」的固定顺序逐分区写入；中途失败 → 逆序回滚已写分区。
 *
 * 顺序即正确性：
 * - 配置分区先写：配置（渠道 / 模型 / ASR）被后续分区引用，配置就绪后
 *   恢复出来的技能 / 智能体 / 会话才能立即可用；
 * - 数据分区按 DATA_SECTION_ORDER 写：键值类在前（代价低、可回滚），
 *   二进制类在后；
 * - capturedFiles 恒为末位：它是唯一「整表替换 + 单事务」的分区，失败时
 *   自身状态不变，无需被回滚。
 *
 * 校验和：备份文件里 sections 的校验和由 format.computeBackupChecksum 计算，
 * 与 config/backup 的历史公式完全一致（同一格式家族，v1/v2 互通）。
 */

import {
  ALL_SECTION_IDS,
  getEngine,
  type ConfigEngine,
  type SectionId,
} from '../config/engine';
import { fillMerge, stripSecrets } from '../config/backup';
import { stableStringify } from '../config/checksum';
import { BACKUP_FORMAT, computeBackupChecksum } from './format';
import { defaultArea, defaultLocalStore } from './ports';
import { createDataSectionHandlers, type SectionDeps } from './sections';
import type {
  ApplyReport,
  BackupFile,
  BackupSection,
  BackupStrategy,
  SectionHandler,
} from './types';
import { BACKUP_VERSION, DATA_SECTION_ORDER } from './types';

/** 导出选项 */
export interface BuildBackupOptions {
  /** 是否包含 API 密钥（仅作用于**配置分区**；数据分区不做递归剔除，
   *  因为会话 / 技能正文里可能合法出现同名字段，盲目剔除会损坏内容） */
  includeSecrets?: boolean;
  /** 是否包含多媒体（图片 / 捕获文件）；false 时这两个分区不进备份文件 */
  includeMedia?: boolean;
  /** 写入备份文件的插件版本号 */
  appVersion?: string;
  /** 配置引擎（默认生产单例；测试注入） */
  engine?: ConfigEngine;
  /** 存储端口（默认 chrome.storage.local + localStorage；测试注入） */
  deps?: SectionDeps;
}

/** 导出结果 */
export interface BuildBackupResult {
  /** 备份文件对象（可直接 serializeBackup 落盘） */
  backup: BackupFile;
  /** 采集过程中的非致命问题（分区被跳过 / 降级）；UI 需明确提示 */
  issues: string[];
  /** 采集过程中的提示（内容被降级但分区完整，如剥离了笔记内联图片） */
  notices: string[];
  /** 实际写入备份的分区 id（配置 + 数据） */
  sectionIds: string[];
}

/** 导入选项 */
export interface ApplyBackupOptions {
  /** 配置引擎（默认生产单例；测试注入） */
  engine?: ConfigEngine;
  /** 存储端口（默认 chrome.storage.local + localStorage；测试注入） */
  deps?: SectionDeps;
}

/** 默认存储端口（生产环境）；chrome 不可用时抛错由调用方降级 */
export function defaultSectionDeps(): SectionDeps {
  return { area: defaultArea(), localStore: defaultLocalStore() };
}

/**
 * 构建完整备份（配置分区 + 数据分区）。
 *
 * @param options.includeMedia=false 时跳过图片 / 捕获文件分区（导出文件显著变小）
 */
export async function buildFullBackup(options: BuildBackupOptions = {}): Promise<BuildBackupResult> {
  const includeSecrets = options.includeSecrets !== false;
  const includeMedia = options.includeMedia !== false;
  const appVersion = options.appVersion ?? (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '');
  const engine = options.engine ?? getEngine();
  const deps = options.deps ?? defaultSectionDeps();

  const issues: string[] = [];
  const notices: string[] = [];
  const sections: Record<string, BackupSection> = {};

  // ── 配置分区 ──
  for (const id of ALL_SECTION_IDS) {
    try {
      const snapshot = await engine.readSection(id);
      if (!snapshot || snapshot.data === null || snapshot.data === undefined) continue;
      sections[id] = {
        schema: snapshot.schema,
        rev: snapshot.rev,
        updatedAt: snapshot.updatedAt,
        data: includeSecrets ? snapshot.data : stripSecrets(snapshot.data),
      };
    } catch (error) {
      issues.push(`配置分区 ${id} 采集失败：${describe(error)}`);
    }
  }

  // ── 数据分区 ──
  const handlers = createDataSectionHandlers({ ...deps, includeMedia });
  for (const handler of handlers) {
    if (handler.media && !includeMedia) continue;
    try {
      const data = await handler.collect();
      if (data === null || data === undefined) continue;
      sections[handler.id] = {
        schema: DATA_SECTION_SCHEMA,
        rev: 0,
        updatedAt: Date.now(),
        data,
      };
      if (handler.notices?.length) notices.push(...handler.notices);
    } catch (error) {
      issues.push(`数据分区 ${handler.id} 采集失败：${describe(error)}`);
    }
  }

  const backup: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    sections,
    checksum: computeBackupChecksum(BACKUP_VERSION, sections),
  };
  return { backup, issues, notices, sectionIds: Object.keys(sections) };
}

/** 数据分区载荷的结构版本（字段增删时 +1，便于将来做迁移） */
export const DATA_SECTION_SCHEMA = 1;

/**
 * 应用备份（先全量校验 → 再逐分区写入 → 失败回滚）。
 *
 * @param strategy replace = 覆盖（以备份为准）；fill = 补充（只填补本机空缺）
 */
export async function applyFullBackup(
  backup: BackupFile,
  strategy: BackupStrategy,
  options: ApplyBackupOptions = {},
): Promise<ApplyReport> {
  const engine = options.engine ?? getEngine();
  const deps = options.deps ?? defaultSectionDeps();
  const report: ApplyReport = { applied: [], skipped: [], errors: [], rolledBack: false };

  const handlers = new Map<string, SectionHandler>(
    createDataSectionHandlers(deps).map(handler => [handler.id, handler] as const),
  );

  // ── 1) 全量校验：任一分区非法 → 整体拒绝，零写入 ──
  const configPending: { id: SectionId; data: unknown }[] = [];
  const dataPending: { id: string; handler: SectionHandler; data: unknown }[] = [];
  for (const [id, section] of Object.entries(backup.sections)) {
    const data = section?.data;
    if ((ALL_SECTION_IDS as readonly string[]).includes(id)) {
      if (!engine.validateSection(id as SectionId, data)) {
        report.errors.push({ id, message: 'invalid-section' });
      } else {
        configPending.push({ id: id as SectionId, data });
      }
      continue;
    }
    const handler = handlers.get(id);
    if (!handler) {
      report.skipped.push({ id, reason: 'unknown-section' });
      continue;
    }
    if (!handler.validate(data)) {
      report.errors.push({ id, message: 'invalid-section' });
    } else {
      dataPending.push({ id, handler, data });
    }
  }
  if (report.errors.length) return report;

  // ── 2) 读取配置分区的导入前快照（回滚用） ──
  const preImages = new Map<SectionId, Awaited<ReturnType<ConfigEngine['readSection']>>>();
  for (const item of configPending) {
    try {
      preImages.set(item.id, await engine.readSection(item.id));
    } catch (error) {
      report.errors.push({ id: item.id, message: describe(error) });
    }
  }
  if (report.errors.length) return report;

  // ── 3) 逐分区写入（配置 → 数据）；失败即逆序回滚已写分区 ──
  const rollbacks: { id: string; rollback: () => Promise<void> }[] = [];
  const written: string[] = [];

  const rollbackAll = async (): Promise<boolean> => {
    let ok = true;
    for (let i = rollbacks.length - 1; i >= 0; i--) {
      const item = rollbacks[i];
      try {
        await item.rollback();
      } catch {
        ok = false;
        report.errors.push({ id: item.id, message: 'rollback-failed' });
      }
    }
    return ok;
  };

  // 3a) 配置分区
  for (const item of configPending) {
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
      rollbacks.push({
        id: item.id,
        rollback: async () => {
          if (pre && pre.data !== null) await engine.writeSection(item.id, pre.data);
          else await engine.clearSection(item.id);
        },
      });
    } catch (error) {
      report.errors.push({ id: item.id, message: describe(error) });
      const ok = await rollbackAll();
      report.rolledBack = written.length > 0 && ok;
      report.applied = [];
      return report;
    }
  }

  // 3b) 数据分区（按 DATA_SECTION_ORDER 固定顺序）
  const ordered: { id: string; handler: SectionHandler; data: unknown }[] = [];
  for (const id of DATA_SECTION_ORDER) {
    const found = dataPending.find(item => item.id === id);
    if (found) ordered.push(found);
  }
  // 兜底：注册表里新增但未进 DATA_SECTION_ORDER 的分区不应被静默丢弃
  for (const item of dataPending) {
    if (!ordered.some(entry => entry.id === item.id)) ordered.push(item);
  }

  for (const item of ordered) {
    try {
      const outcome = await item.handler.apply(item.data, strategy);
      if ('skipped' in outcome) {
        report.skipped.push({ id: item.id, reason: outcome.reason });
        continue;
      }
      written.push(item.id);
      report.applied.push(item.id);
      if (outcome.rollback) {
        rollbacks.push({ id: item.id, rollback: outcome.rollback });
      }
    } catch (error) {
      report.errors.push({ id: item.id, message: describe(error) });
      const ok = await rollbackAll();
      report.rolledBack = written.length > 0 && ok;
      report.applied = [];
      return report;
    }
  }

  return report;
}

/** 错误转可读文本（绝不抛错） */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

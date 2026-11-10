/**
 * 归档会话到期清理（保留策略的执行端）
 *
 * 策略本身在 utils/sessions/session-archive-policy（用户偏好，本模块只读）；
 * 本模块负责把策略落到数据上：找出归档满 N 天的会话并**走删除引擎**删除
 * （绝不直接删存储行 —— 图片按引用回收、上传文件回收、计划墓碑、活跃指针
 * 等收尾动作都在删除引擎里，绕开它就会留下残余数据）。
 *
 * 触发点（多入口、幂等）：
 *   - 管理中心「会话管理」分区激活时；
 *   - 后台 worker 启动时；
 *   - 侧边栏启动时。
 *
 * 幂等与并发：同进程内单飞（同一时刻只跑一次清理）；跨上下文并发由
 * 「删除后列表自然收敛」保证 —— 重复删除已不存在的会话是安全的 no-op
 * （删除引擎对不存在的会话同样走完整回收流程，不会报错）。
 */

import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { sessionDeletionEngine } from '@/entrypoints/sidepanel/core/context/session-deletion-engine';
import {
  loadSessionArchivePolicy,
  type SessionArchivePolicy,
} from './session-archive-policy';
import { listBusySessions, notifySessionsChanged } from './session-bridge';

/** 清理结果（供调用方展示与埋点） */
export interface ArchiveSweepResult {
  /** 到期且已删除的会话 id */
  deleted: string[];
  /** 跳过的会话数（未到期 / 正在执行 / 自动删除已关闭） */
  skipped: number;
  /** 非致命问题（单条失败不阻断其余清理） */
  issues: string[];
}

/** 一天（毫秒） */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 单进程内的单飞句柄：并发调用共用同一次清理 */
let inFlight: Promise<ArchiveSweepResult> | null = null;

/**
 * 清理到期归档会话。
 *
 * @param now 判定时刻（毫秒；可注入以获得确定性测试）
 */
export async function sweepExpiredArchivedSessions(
  now: number = Date.now(),
): Promise<ArchiveSweepResult> {
  if (inFlight) return inFlight;
  inFlight = runSweep(now).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** 单次清理的执行体（不含单飞包装） */
async function runSweep(now: number): Promise<ArchiveSweepResult> {
  const issues: string[] = [];
  const deleted: string[] = [];
  let skipped = 0;

  let policy: SessionArchivePolicy;
  try {
    policy = await loadSessionArchivePolicy();
  } catch (error) {
    return { deleted, skipped, issues: [`读取归档策略失败: ${describe(error)}`] };
  }

  let archived: Awaited<ReturnType<typeof chatDatabase.listSessions>> = [];
  try {
    archived = await chatDatabase.listSessions({ scope: 'archived', limit: 500 });
  } catch (error) {
    return { deleted, skipped, issues: [`读取归档会话失败: ${describe(error)}`] };
  }
  if (archived.length === 0) return { deleted, skipped, issues };

  // 自动删除关闭：全部跳过（归档只是收纳，用户明确要留着）
  if (!policy.autoDelete) return { deleted, skipped: archived.length, issues };

  const deadline = now - policy.retentionDays * DAY_MS;
  const expired = archived.filter(meta => {
    const archivedAt = Number(meta.archivedAt);
    return Number.isFinite(archivedAt) && archivedAt <= deadline;
  });
  if (expired.length === 0) return { deleted, skipped: archived.length, issues };

  // 正在执行的会话一律跳过：运行中的会话被删会让模型继续消耗请求、
  // 快照全部落空。清理是后台动作，等它自然结束再由下一轮清理接手。
  let busy = new Set<string>();
  try {
    busy = await listBusySessions(expired.map(meta => meta.chatId));
  } catch (error) {
    issues.push(`查询运行态失败（到期会话按未运行处理）: ${describe(error)}`);
  }

  for (const meta of expired) {
    if (busy.has(meta.chatId)) {
      skipped++;
      continue;
    }
    try {
      await sessionDeletionEngine.deleteSession(meta.chatId);
      deleted.push(meta.chatId);
    } catch (error) {
      issues.push(`删除归档会话 ${meta.chatId} 失败: ${describe(error)}`);
      skipped++;
    }
  }

  if (deleted.length > 0) notifySessionsChanged('swept');
  return { deleted, skipped, issues };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

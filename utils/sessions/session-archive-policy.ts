/**
 * 归档会话保留策略（存档偏好）
 *
 * 「归档」是收纳而非删除：会话与全部关联数据原地保留，只从常规列表隐去。
 * 用户可另行设定「归档会话到期后自动删除」——本模块就是这条策略的**唯一事实源**：
 *   - autoDelete：是否开启到期自动删除（默认开启）；
 *   - retentionDays：归档满多少天后自动删除（默认 30 天）。
 *
 * 持久化走 chrome.storage.local（单一键），跨上下文实时同步走
 * utils/shared/storage-sync 的订阅件（与智能体 / 技能 / 语言同步同构）：
 * 任一上下文改了策略，其余上下文立即可见 —— 管理中心改了保留期，
 * 侧边栏不必重开就能按新策略清理。
 *
 * 策略与「已归档会话集合」是**两件事**：本模块只管策略，会话侧的归档标记
 * 落在会话记录本身（ChatSessionMeta.archivedAt），到期判定由
 * session-archive-sweeper 负责。
 */

import { LocalWriteFingerprint, subscribeStorageKey } from '@/utils/shared/storage-sync';

/** chrome.storage.local 键名（备份 / 存储统计共用清单需登记，见 backup/storage-keys） */
export const SESSION_ARCHIVE_POLICY_STORAGE_KEY = 'agentNexusSessionArchivePolicy';

/** 保留期上下界（天）：下限 1 天（当天即到期没有意义），上限 10 年（防手滑输入） */
export const SESSION_ARCHIVE_MIN_RETENTION_DAYS = 1;
export const SESSION_ARCHIVE_MAX_RETENTION_DAYS = 3650;

export interface SessionArchivePolicy {
  /** 归档会话到期后是否自动删除（默认开启） */
  autoDelete: boolean;
  /** 自动删除期限（天；默认 30） */
  retentionDays: number;
}

/** 默认策略：自动删除开启，保留 30 天 */
export const DEFAULT_SESSION_ARCHIVE_POLICY: SessionArchivePolicy = {
  autoDelete: true,
  retentionDays: 30,
};

/**
 * 归一化策略（对外部输入一律防御）。
 *
 * 策略可能来自旧版本备份、被手改过的 chrome.storage 或损坏的 JSON ——
 * 任何不合法的值都必须收敛到合法区间，绝不把 NaN / 负数 / 字符串带进
 * 「到期时间」计算（那会让到期判定永远不成立或立刻成立）。
 */
export function normalizeSessionArchivePolicy(value: unknown): SessionArchivePolicy {
  const source = (value ?? {}) as Partial<SessionArchivePolicy>;
  const autoDelete =
    typeof source.autoDelete === 'boolean'
      ? source.autoDelete
      : DEFAULT_SESSION_ARCHIVE_POLICY.autoDelete;
  const rawDays = Number(source.retentionDays);
  const retentionDays = Number.isFinite(rawDays)
    ? Math.min(
        SESSION_ARCHIVE_MAX_RETENTION_DAYS,
        Math.max(SESSION_ARCHIVE_MIN_RETENTION_DAYS, Math.round(rawDays)),
      )
    : DEFAULT_SESSION_ARCHIVE_POLICY.retentionDays;
  return { autoDelete, retentionDays };
}

/** 本上下文的写入指纹（跳过 storage.onChanged 的自事件，避免重复刷新） */
const writeFingerprint = new LocalWriteFingerprint();

/**
 * 读取策略（读不到 / 损坏时回落默认策略）。
 *
 * 刻意**不抛错**：策略读不出来不该让管理中心整个分区打不开 ——
 * 回落默认（自动删除 + 30 天）是最安全的行为，用户仍可在界面上改。
 */
export async function loadSessionArchivePolicy(): Promise<SessionArchivePolicy> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { ...DEFAULT_SESSION_ARCHIVE_POLICY };
  }
  try {
    const stored = await chrome.storage.local.get(SESSION_ARCHIVE_POLICY_STORAGE_KEY);
    return normalizeSessionArchivePolicy(stored[SESSION_ARCHIVE_POLICY_STORAGE_KEY]);
  } catch (error) {
    console.warn('[SessionArchivePolicy] 读取归档策略失败，回落默认:', error);
    return { ...DEFAULT_SESSION_ARCHIVE_POLICY };
  }
}

/**
 * 保存策略（局部更新 + 归一化），返回落库后的最终值。
 *
 * 写入前登记指纹：onChanged 回调据此跳过自事件，不会出现「保存 → 触发
 * 变更 → 再保存」的自激循环。
 */
export async function saveSessionArchivePolicy(
  patch: Partial<SessionArchivePolicy>,
): Promise<SessionArchivePolicy> {
  const current = await loadSessionArchivePolicy();
  const next = normalizeSessionArchivePolicy({ ...current, ...patch });
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return next;
  try {
    writeFingerprint.mark(next);
    await chrome.storage.local.set({ [SESSION_ARCHIVE_POLICY_STORAGE_KEY]: next });
  } catch (error) {
    console.warn('[SessionArchivePolicy] 保存归档策略失败:', error);
  }
  return next;
}

/**
 * 订阅策略的跨上下文变更（自事件已跳过），返回退订函数。
 *
 * 变更回调收到的是**归一化后**的策略：外部写入的脏值不会渗进业务层。
 */
export function watchSessionArchivePolicy(
  handler: (policy: SessionArchivePolicy) => void,
): () => void {
  return subscribeStorageKey(
    SESSION_ARCHIVE_POLICY_STORAGE_KEY,
    writeFingerprint,
    value => handler(normalizeSessionArchivePolicy(value)),
  );
}

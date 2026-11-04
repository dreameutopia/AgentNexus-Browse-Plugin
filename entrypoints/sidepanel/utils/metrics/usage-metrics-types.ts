/**
 * AI 用量监控指标 — 数据模型（纯类型，无副作用）
 *
 * 分层：
 *   - 持久化结构 UsageMetricsData：chrome.storage.local 中的原始聚合数据
 *     （totals + byModel 映射 + 最近错误环形缓冲，追加式计数，体量恒定）
 *   - 展示结构 UsageMetricsSnapshot：由引擎从持久化结构派生，
 *     models 已按总 token 降序并带上占比，UI 直接渲染
 */

import type { TokenUsage } from '../stream/types';

/** 请求类别（用于区分计数来源，均为真实 AI 推理请求） */
export type UsageRequestKind = 'chat' | 'probe' | 'asr' | 'compaction';

/** 单次尝试结局：成功 / 失败（含建连失败与流内错误）/ 用户中止 */
export type UsageOutcome = 'success' | 'failed' | 'aborted';

/** 计数聚合（全局与每模型共用同一形状，字段语义见 UsageMetricsData） */
export interface UsageCounters {
  cacheHitRequests: number;
  cacheObservedRequests: number;
  /** Continuation requests only, excluding cold starts and unreported usage. */
  continuationInputTokens: number;
  continuationCachedTokens: number;
  continuationCacheRequests: number;
  /** 发起的总请求次数（含自动重试的每次尝试、失败与中止） */
  requests: number;
  /** 成功完成的请求次数 */
  success: number;
  /** 失败的请求次数（HTTP 错误 / 网络 / 超时 / 流内错误） */
  failed: number;
  /** 用户主动中止的请求次数（不计成功也不计失败） */
  aborted: number;
  /** 输入 token 总量（含缓存命中部分；仅统计协议上报了 usage 的请求） */
  inputTokens: number;
  /** 输出 token 总量（含推理，协议未拆分时） */
  outputTokens: number;
  /** 总 token（协议上报或由 input+output 推导） */
  totalTokens: number;
  /** 缓存命中的输入 token 总量（仅统计上报了缓存字段的请求） */
  cachedInputTokens: number;
  /** 上报了缓存字段的请求数（缓存命中率的分母基准） */
  cacheReportedRequests: number;
  /** 上报了缓存字段的请求的输入 token 总量（缓存命中率的分母） */
  cacheEligibleInputTokens: number;
  /** 推理 token 总量（协议拆分上报时才有） */
  reasoningTokens: number;
}

/** 每模型聚合（存储键：`${provider}::${model}`） */
export interface ModelUsageMetrics extends UsageCounters {
  requestKind?: UsageRequestKind;
  channelId?: string;
  modelId?: string;
  channelLabel?: string;
  agentId?: string;
  /** 协议类型标识（ProviderType 或 asr 等扩展标签） */
  provider: string;
  /** 模型名（脏数据防御：空值归一为 '(unknown)'） */
  model: string;
  /** 最近一次请求时间戳（ms） */
  lastUsedAt: number;
  /** 占比快照（0~1，基于 totalTokens，由引擎派生，持久化时剥离） */
  share?: number;
}

/** 最近错误记录（环形缓冲，最多保留 N 条，便于排查「失败请求」的原因） */
export interface UsageErrorRecord {
  /** 发生时间戳（ms） */
  at: number;
  provider: string;
  model: string;
  kind: UsageRequestKind;
  /** 一句话摘要（截断存储，绝不包含密钥/完整响应） */
  summary: string;
}

/** 持久化结构（chrome.storage.local，schemaVersion 向前兼容迁移） */
export interface UsageMetricsData {
  byScope: Record<string, ModelUsageMetrics>;
  recentRequests: UsageRequestDetail[];
  schemaVersion: number;
  /** 统计起点（首次记录时间戳） */
  startedAt: number;
  /** 最近一次记录时间戳 */
  updatedAt: number;
  totals: UsageCounters;
  byModel: Record<string, ModelUsageMetrics>;
  recentErrors: UsageErrorRecord[];
}

/** 展示快照（引擎派生：models 排序 + 占比；不可变，UI 直接消费） */
export interface UsageMetricsSnapshot {
  scopes: ModelUsageMetrics[];
  recentRequests: UsageRequestDetail[];
  schemaVersion: number;
  startedAt: number;
  updatedAt: number;
  totals: UsageCounters;
  /** 按 totalTokens 降序（无 token 的模型按请求数排在其后） */
  models: ModelUsageMetrics[];
  /** 时间倒序的最近错误（最多 N 条） */
  recentErrors: UsageErrorRecord[];
  /** 数据是否已从存储水合完成（false 时 UI 可显示加载态） */
  hydrated: boolean;
}

/** 计数请求入参（引擎唯一的写入 API） */
export interface UsageRecordInput extends UsageRequestContext {
  provider: string;
  model: string;
  kind: UsageRequestKind;
  outcome: UsageOutcome;
  /** 协议上报的 token 消耗（可缺省：仅计请求次数）；口径见 stream/types.ts 的 TokenUsage */
  usage?: TokenUsage;
  /** 失败时的一句话摘要（调用方保证脱敏：不传 URL / 密钥 / 完整响应） */
  errorSummary?: string;
}

type UsageRequestContext = Omit<import('../stream/types').RequestMetricsContext, 'kind'>;
export interface UsageRequestDetail extends UsageRecordInput {
  at: number;
}

/** 空计数（reset / 初始化用） */
export function createEmptyCounters(): UsageCounters {
  return {
    cacheHitRequests: 0,
    cacheObservedRequests: 0,
    continuationInputTokens: 0,
    continuationCachedTokens: 0,
    continuationCacheRequests: 0,
    requests: 0,
    success: 0,
    failed: 0,
    aborted: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheReportedRequests: 0,
    cacheEligibleInputTokens: 0,
    reasoningTokens: 0,
  };
}

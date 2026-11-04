/**
 * AI 用量监控指标引擎 — 所有 AI API 请求的统一计数中枢
 *
 * 职责（单一事实源，插桩点只需一行 record()）：
 *   1. 计数聚合：总/成功/失败/中止次数、输入/输出/总/推理 token、缓存命中（内存 O(1) 追加）
 *   2. 每模型拆分：按 `${provider}::${model}` 聚合，支撑「各模型 token 消耗占比」
 *   3. 持久化：chrome.storage.local 防抖写入（2s 合并高频记录）+ 写队列串行化 +
 *      页面卸载/隐藏时冲刷；读写任何失败都静默降级为纯内存统计，绝不影响 AI 请求主流程
 *   4. 订阅广播：record / reset / 跨上下文存储变更都会通知订阅者（设置页实时刷新）
 *
 * 防御性设计：
 *   - record() 永不抛错、永不记录敏感信息（无 URL / 密钥 / 完整响应体，摘要仅单行截断）
 *   - 存储数据畸形（字段缺失 / 类型错误）→ 整体重置，不带病运行；
 *     读到比当前代码更新的 schemaVersion → 只读降级（不采纳、不写盘），保护未来版本数据
 *   - 跨上下文同步复用项目统一指纹模式（utils/shared/storage-sync）：
 *     自事件（本上下文写入的 onChanged 回流）跳过，杜绝旧快照覆盖防抖窗口内的新记录
 *   - reset() 带水合纪元守卫：在途水合完成后若纪元已变即作废，杜绝旧数据覆盖清零结果
 *   - 持久化写深拷贝快照 + 写前登记指纹：序列化时点确定，与自事件识别严格一致
 *   - 计数聚合带 2^53 安全上限，杜绝溢出为非精确整数
 *   - byModel 容量上限（超出后新模型仅计总账并一次性告警，防脏数据撑爆存储）
 *
 * 插桩点（全部 AI 推理请求，缺一不可）：
 *   - StreamClient.executeRequest  — 全部对话/视觉/工具调用（含每次重试尝试）
 *   - probeConnection              — 连通性测试（kind='probe'）
 *   - convertAudioToText           — 语音识别（kind='asr'）
 */

import type {
  ModelUsageMetrics,
  UsageCounters,
  UsageErrorRecord,
  UsageMetricsData,
  UsageMetricsSnapshot,
  UsageRecordInput,
} from './usage-metrics-types';
import { createEmptyCounters } from './usage-metrics-types';
import { LocalWriteFingerprint, subscribeStorageKey } from '@/utils/shared/storage-sync';

// ==================== 常量 ====================

/** chrome.storage.local 持久化键（v1：结构变更时升版本并做迁移） */
export const USAGE_METRICS_STORAGE_KEY = 'ai_usage_metrics_v1';

/** 当前结构版本 */
const SCHEMA_VERSION = 2;

/** 防抖写入间隔（ms）：高频对话循环内多条记录合并为一次写盘 */
const PERSIST_DEBOUNCE_MS = 2000;

/** 最近错误环形缓冲容量 */
const MAX_RECENT_ERRORS = 20;

/** 每模型聚合的模型数上限（防御：异常场景下防存储膨胀） */
const MAX_MODELS = 500;

/** 计数安全上限（Number.MAX_SAFE_INTEGER 之下留余量，超限即封顶） */
const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER / 2;

/** 单条错误摘要最大长度 */
const MAX_ERROR_SUMMARY_LEN = 200;

// ==================== 工具 ====================

/** 非负安全整数化：非法值归 0，超上限封顶 */
function toSafeCount(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(Math.floor(num), MAX_SAFE_COUNT);
}

/** 安全累加（封顶后不再增长，保持精确整数语义） */
function addSafe(current: number, delta: number): number {
  const next = current + delta;
  return next > MAX_SAFE_COUNT ? MAX_SAFE_COUNT : next;
}

/** 模型键：provider::model（脏数据归一，键稳定可合并） */
function modelKeyOf(provider: string, model: string): string {
  const p = (provider || '').toString().trim() || 'unknown';
  const m = (model || '').toString().trim() || '(unknown)';
  return `${p}::${m}`;
}

// ==================== 引擎 ====================

class UsageMetricsEngine {
  /** 内存态权威数据（未水合时也先累积，水合后合并） */
  private data: UsageMetricsData = createEmptyData();

  /** 是否已从 storage 水合（或水合失败已降级） */
  private hydrated = false;

  /** 水合前累积的记录（水合完成后回放，避免启动早期丢计数） */
  private pendingBeforeHydrate: UsageRecordInput[] = [];

  /** 水合发起标记（只发起一次） */
  private hydrateStarted = false;

  /**
   * 水合纪元：reset() 时自增；在途水合完成后若纪元已变，其结果作废 —
   * 杜绝「水合读回旧数据覆盖刚清零的内存态」的竞态。
   */
  private hydrateEpoch = 0;

  /** 防抖定时器 */
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  /** 写队列尾（串行化所有写操作，杜绝并发交错覆盖） */
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * 本上下文最近写入 storage 的值指纹（项目统一的跨上下文同步模式）：
   * onChanged 对写入方上下文同样触发，若不区分会把防抖窗口内的新内存记录
   * 用已落盘的旧快照覆盖掉 —— 指纹命中即跳过自事件。
   */
  private ownWrites = new LocalWriteFingerprint();

  /** 跨上下文订阅退订函数（chrome.storage 不可用时为空操作） */
  private storageUnsubscribe: (() => void) | undefined;

  /** storage 监听是否已注册 */
  private storageListenerBound = false;

  /** 订阅者集合 */
  private listeners = new Set<(snapshot: UsageMetricsSnapshot) => void>();

  /**
   * 只读降级标记：读到比当前代码更新的 schemaVersion（未来版本装旧代码）时置位 —
   * 本上下文继续内存统计但绝不写盘，避免用 v1 结构覆盖破坏未来版本的数据。
   */
  private persistenceDisabled = false;

  /** byModel 触顶一次性告警标记（防日志刷屏） */
  private modelsCapWarned = false;

  /** 卸载冲刷是否已注册 */
  private unloadFlushBound = false;

  // -------------------- 对外 API --------------------

  /**
   * 记录一次 AI 请求尝试（fire-and-forget，永不抛错）。
   * 每个真实发出的 HTTP 尝试调用一次（含自动重试的每次尝试）。
   */
  record(input: UsageRecordInput): void {
    try {
      if (!input || typeof input !== 'object') return;

      const provider = (input.provider || '').toString();
      const model = (input.model || '').toString();
      const kind = input.kind === 'probe' || input.kind === 'asr' || input.kind === 'compaction' ? input.kind : 'chat';
      const outcome = input.outcome === 'success' || input.outcome === 'aborted' ? input.outcome : 'failed';
      const usage = safeUsage(input.usage);

      if (this.hydrated) {
        this.applyRecord(this.data, { ...input, provider, model, kind, outcome, usage });
        this.data.updatedAt = Date.now();
        this.schedulePersist();
        this.notify();
      } else {
        // 水合未完成：先暂存（容量防御），完成后回放
        if (this.pendingBeforeHydrate.length < 1000) {
          this.pendingBeforeHydrate.push({ ...input, provider, model, kind, outcome, usage });
        }
        this.ensureHydrated();
      }
    } catch (error) {
      // 计数失败绝不影响 AI 主流程
      console.warn('[UsageMetrics] record 失败（已忽略）:', error);
    }
  }

  /** 当前展示快照（不可变副本；models 已排序 + 带占比） */
  getSnapshot(): UsageMetricsSnapshot {
    this.ensureHydrated();
    const models = Object.values(this.data.byModel)
      .map(entry => ({ ...entry, share: 0 }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);
    const grandTotal = this.data.totals.totalTokens;
    for (const entry of models) {
      entry.share = grandTotal > 0 ? Math.min(entry.totalTokens / grandTotal, 1) : 0;
    }
    return {
      schemaVersion: this.data.schemaVersion,
      startedAt: this.data.startedAt,
      updatedAt: this.data.updatedAt,
      totals: { ...this.data.totals },
      scopes: Object.values(this.data.byScope).map(entry => ({ ...entry })).sort((a, b) => b.inputTokens - a.inputTokens),
      recentRequests: this.data.recentRequests.map(entry => ({ ...entry, usage: entry.usage ? { ...entry.usage } : undefined })),
      models,
      recentErrors: this.data.recentErrors.map(e => ({ ...e })),
      hydrated: this.hydrated,
    };
  }

  /**
   * 订阅指标变化（record / reset / 跨上下文存储变更均会触发）。
   * @returns 退订函数
   */
  subscribe(listener: (snapshot: UsageMetricsSnapshot) => void): () => void {
    this.ensureHydrated();
    this.listeners.add(listener);
    // 注册即推一次当前快照，省去调用方首次手动拉取
    try {
      listener(this.getSnapshot());
    } catch (error) {
      console.warn('[UsageMetrics] 订阅者首次回调失败:', error);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 清零全部统计（确认后由 UI 调用）：作废在途水合 → 清内存 → 立即持久化 → 广播。
   * 纪元自增保证「正在读取旧数据的水合过程」完成后不会反过来覆盖清零结果。
   */
  reset(): void {
    this.hydrateEpoch++;
    this.pendingBeforeHydrate = [];
    this.data = createEmptyData();
    this.data.updatedAt = Date.now();
    this.hydrated = true;
    void this.persistNow();
    this.notify();
  }

  // -------------------- 内部实现 --------------------

  /** 惰性水合（只发起一次；失败也标记完成，降级为纯内存统计） */
  private ensureHydrated(): void {
    if (this.hydrated || this.hydrateStarted) return;
    this.hydrateStarted = true;
    this.bindStorageListener();
    this.bindUnloadFlush();

    // 捕获当前纪元：await 期间若发生 reset()，本次水合结果整体作废
    const epoch = this.hydrateEpoch;

    void (async () => {
      let loaded: UsageMetricsData | null = null;
      try {
        if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
          const bag = await chrome.storage.local.get(USAGE_METRICS_STORAGE_KEY);
          const raw = bag?.[USAGE_METRICS_STORAGE_KEY];
          if (this.isFutureSchema(raw)) {
            // 未来版本数据：不采纳（结构无法理解），且禁止本上下文写盘覆盖
            this.enterReadOnlyMode();
          } else {
            loaded = this.parseStored(raw);
          }
        }
      } catch (error) {
        console.warn('[UsageMetrics] 存储读取失败，降级为纯内存统计:', error);
      }

      // reset() 已在读取期间接管（纪元已变）：丢弃旧数据，避免覆盖清零后的内存态
      if (epoch !== this.hydrateEpoch) return;

      this.data = loaded ?? createEmptyData();

      // 回放水合前累积的记录（后写覆盖：合并到已加载的数据上）
      const pending = this.pendingBeforeHydrate;
      this.pendingBeforeHydrate = [];
      for (const item of pending) {
        this.applyRecord(this.data, item);
      }
      if (pending.length > 0) {
        this.data.updatedAt = Date.now();
      }

      this.hydrated = true;
      this.notify();
      if (pending.length > 0) {
        this.schedulePersist();
      }
    })();
  }

  /** 解析并校验存储数据；任何畸形都返回 null（调用方重置，不带病运行） */
  private parseStored(raw: unknown): UsageMetricsData | null {
    if (!raw || typeof raw !== 'object') return null;
    const data = raw as UsageMetricsData;
    if (data.schemaVersion !== 1 && data.schemaVersion !== SCHEMA_VERSION) {
      return null;
    }
    // 深度防御：totals / byModel / recentErrors 结构异常即弃用
    if (!data.totals || typeof data.totals !== 'object') return null;
    if (!data.byModel || typeof data.byModel !== 'object' || Array.isArray(data.byModel)) return null;
    if (!Array.isArray(data.recentErrors)) return null;
    if (typeof data.startedAt !== 'number' || typeof data.updatedAt !== 'number') return null;

    const result = createEmptyData();
    result.startedAt = data.startedAt;
    result.updatedAt = data.updatedAt;
    // totals 逐字段安全化（缺字段归 0）
    for (const key of Object.keys(result.totals) as Array<keyof UsageCounters>) {
      result.totals[key] = toSafeCount(data.totals[key]);
    }
    // byModel 逐条校验，单条畸形只丢该条
    for (const [key, entry] of Object.entries(data.byModel)) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.provider !== 'string' || typeof entry.model !== 'string') continue;
      const sanitized: ModelUsageMetrics = {
        ...metricContext(entry),
        provider: entry.provider,
        model: entry.model,
        lastUsedAt: typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : Date.now(),
        ...createEmptyCounters(),
      };
      for (const ck of Object.keys(sanitized) as Array<keyof UsageCounters>) {
        const v = (entry as any)[ck];
        if (typeof v === 'number') (sanitized as any)[ck] = toSafeCount(v);
      }
      result.byModel[key] = sanitized;
    }
    if (data.byScope && typeof data.byScope === 'object' && !Array.isArray(data.byScope)) {
      for (const [key, entry] of Object.entries(data.byScope).slice(0, MAX_MODELS)) {
        if (!entry || typeof entry.provider !== 'string' || typeof entry.model !== 'string') continue;
        const sanitized: ModelUsageMetrics = {
          ...metricContext(entry), provider: entry.provider, model: entry.model,
          requestKind: entry.requestKind === 'compaction' ? 'compaction' : entry.requestKind === 'probe' ? 'probe' : entry.requestKind === 'asr' ? 'asr' : 'chat',
          lastUsedAt: toSafeCount(entry.lastUsedAt), ...createEmptyCounters(),
        };
        for (const counter of Object.keys(createEmptyCounters()) as Array<keyof UsageCounters>) sanitized[counter] = toSafeCount(entry[counter]);
        result.byScope[key] = sanitized;
      }
    }
    if (Array.isArray(data.recentRequests)) {
      result.recentRequests = data.recentRequests.slice(0, 100).filter(e => e && typeof e.model === 'string' && typeof e.provider === 'string')
        .map(e => ({ ...metricContext(e), at: toSafeCount(e.at), provider: e.provider.slice(0, 40), model: e.model.slice(0, 120),
          kind: e.kind === 'compaction' ? 'compaction' : e.kind === 'asr' ? 'asr' : e.kind === 'probe' ? 'probe' : 'chat',
          outcome: e.outcome === 'success' ? 'success' : e.outcome === 'aborted' ? 'aborted' : 'failed', usage: safeUsage(e.usage) }));
    }
    // recentErrors 逐条截断
    for (const err of data.recentErrors) {
      if (!err || typeof err !== 'object') continue;
      result.recentErrors.push({
        at: typeof err.at === 'number' ? err.at : Date.now(),
        provider: String(err.provider ?? '').slice(0, 40),
        model: String(err.model ?? '').slice(0, 120),
        kind: err.kind === 'probe' || err.kind === 'asr' ? err.kind : 'chat',
        summary: String(err.summary ?? '').slice(0, MAX_ERROR_SUMMARY_LEN),
      });
      if (result.recentErrors.length >= MAX_RECENT_ERRORS) break;
    }
    return result;
  }

  /** 单条记录落到聚合数据（纯函数式：对传入 data 就地更新） */
  private applyRecord(data: UsageMetricsData, input: UsageRecordInput): void {
    const outcome = input.outcome;
    const usage = input.usage;

    // 统计起点：首条记录时落定（reset 后重新起算）
    if (!data.startedAt) data.startedAt = Date.now();

    // ---- 总账 ----
    const totals = data.totals;
    const before = { ...totals };
    totals.requests = addSafe(totals.requests, 1);
    if (outcome === 'success') totals.success = addSafe(totals.success, 1);
    else if (outcome === 'failed') totals.failed = addSafe(totals.failed, 1);
    else totals.aborted = addSafe(totals.aborted, 1);

    const inputTokens = usage?.inputTokens !== undefined ? toSafeCount(usage.inputTokens) : 0;
    const outputTokens = usage?.outputTokens !== undefined ? toSafeCount(usage.outputTokens) : 0;
    const totalTokens =
      usage?.totalTokens !== undefined
        ? toSafeCount(usage.totalTokens)
        : inputTokens + outputTokens;

    totals.inputTokens = addSafe(totals.inputTokens, inputTokens);
    totals.outputTokens = addSafe(totals.outputTokens, outputTokens);
    totals.totalTokens = addSafe(totals.totalTokens, totalTokens);
    if (usage?.reasoningTokens !== undefined) {
      totals.reasoningTokens = addSafe(totals.reasoningTokens, toSafeCount(usage.reasoningTokens));
    }
    if (usage?.cachedInputTokens !== undefined && usage.inputTokens !== undefined) {
      // 仅上报了缓存字段的请求参与命中率统计（undefined = 协议未上报，不进分母）
      totals.cachedInputTokens = addSafe(totals.cachedInputTokens, toSafeCount(usage.cachedInputTokens));
      totals.cacheReportedRequests = addSafe(totals.cacheReportedRequests, 1);
      totals.cacheEligibleInputTokens = addSafe(totals.cacheEligibleInputTokens, inputTokens);
    }
    addCacheDiagnostics(totals, input);
    const context = metricContext(input);
    const scopeKey = JSON.stringify([input.provider, context.channelId ?? '', context.modelId ?? input.model, context.agentId ?? '', input.kind]);
    if (data.byScope[scopeKey] || Object.keys(data.byScope).length < MAX_MODELS) {
      const scope = data.byScope[scopeKey] ??= { ...context, requestKind: input.kind, provider: input.provider, model: input.model, lastUsedAt: 0, ...createEmptyCounters() };
      for (const counter of Object.keys(before) as Array<keyof UsageCounters>) scope[counter] = addSafe(scope[counter], totals[counter] - before[counter]);
      scope.lastUsedAt = Date.now();
    }
    data.recentRequests.unshift({ ...context, at: Date.now(), provider: input.provider.slice(0, 40), model: input.model.slice(0, 120),
      kind: input.kind, outcome, usage: safeUsage(usage) });
    data.recentRequests.length = Math.min(data.recentRequests.length, 100);

    // ---- 每模型拆分（容量防御：超上限后新模型只进总账） ----
    const key = context.channelId
      ? JSON.stringify([input.provider, context.channelId, context.modelId ?? input.model])
      : modelKeyOf(input.provider, input.model);
    let entry = data.byModel[key];
    if (!entry) {
      if (Object.keys(data.byModel).length >= MAX_MODELS) {
        if (!this.modelsCapWarned) {
          this.modelsCapWarned = true;
          console.warn(
            `[UsageMetrics] 模型数已达上限 ${MAX_MODELS}，新模型仅计入总账不再拆分（防御脏数据膨胀）`
          );
        }
        return;
      }
      entry = {
        ...context,
        provider: (input.provider || '').toString().trim() || 'unknown',
        model: (input.model || '').toString().trim() || '(unknown)',
        lastUsedAt: 0,
        ...createEmptyCounters(),
      };
      data.byModel[key] = entry;
    }
    entry.requests = addSafe(entry.requests, 1);
    if (outcome === 'success') entry.success = addSafe(entry.success, 1);
    else if (outcome === 'failed') entry.failed = addSafe(entry.failed, 1);
    else entry.aborted = addSafe(entry.aborted, 1);
    entry.inputTokens = addSafe(entry.inputTokens, inputTokens);
    entry.outputTokens = addSafe(entry.outputTokens, outputTokens);
    entry.totalTokens = addSafe(entry.totalTokens, totalTokens);
    if (usage?.reasoningTokens !== undefined) {
      entry.reasoningTokens = addSafe(entry.reasoningTokens, toSafeCount(usage.reasoningTokens));
    }
    if (usage?.cachedInputTokens !== undefined && usage.inputTokens !== undefined) {
      entry.cachedInputTokens = addSafe(entry.cachedInputTokens, toSafeCount(usage.cachedInputTokens));
      entry.cacheReportedRequests = addSafe(entry.cacheReportedRequests, 1);
      entry.cacheEligibleInputTokens = addSafe(entry.cacheEligibleInputTokens, inputTokens);
    }
    entry.lastUsedAt = Date.now();
    addCacheDiagnostics(entry, input);

    // ---- 失败摘要环形缓冲 ----
    if (outcome === 'failed' && input.errorSummary) {
      data.recentErrors.unshift({
        at: Date.now(),
        provider: (input.provider || '').toString().slice(0, 40),
        model: (input.model || '').toString().slice(0, 120),
        kind: input.kind,
        summary: String(input.errorSummary).slice(0, MAX_ERROR_SUMMARY_LEN),
      });
      if (data.recentErrors.length > MAX_RECENT_ERRORS) {
        data.recentErrors.length = MAX_RECENT_ERRORS;
      }
    }
  }

  /** 防抖持久化（合并高频记录） */
  private schedulePersist(): void {
    if (this.persistTimer !== undefined) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** 立即持久化（串行写队列；只读降级 / 序列化 / 写入失败均仅告警，不影响内存统计） */
  private persistNow(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      try {
        if (this.persistenceDisabled) return;
        if (typeof chrome === 'undefined' || !chrome.storage?.local?.set) return;
        // 深拷贝冻结本次写入内容：确定序列化时点，且与登记的自事件指纹严格一致；
        // 也杜绝「set 引用与内存共享对象，写入内容随后续 record 漂移」的时点歧义
        const snapshot = JSON.parse(JSON.stringify(this.data)) as UsageMetricsData;
        // 先登记指纹再写入：onChanged 回流时据此跳过自事件（防旧快照覆盖新内存记录）
        this.ownWrites.mark(snapshot);
        await chrome.storage.local.set({ [USAGE_METRICS_STORAGE_KEY]: snapshot });
      } catch (error) {
        console.warn('[UsageMetrics] 存储写入失败（内存统计不受影响）:', error);
      }
    });
    return this.writeChain;
  }

  /** 广播快照给全部订阅者（订阅者异常隔离） */
  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('[UsageMetrics] 订阅者回调失败:', error);
      }
    }
  }

  /**
   * 跨上下文同步：其它上下文（如 hub 页将来的用量视图）写入时采用其数据。
   * 复用项目统一的订阅模式（utils/shared/storage-sync）：
   *   - 自事件（本上下文写入的回流）经指纹识别跳过 — 否则会用已落盘的旧快照
   *     覆盖防抖窗口内新增的内存记录；
   *   - 仅采纳不旧于当前内存态的数据（updatedAt 守卫），陈旧外部事件直接忽略；
   *   - 未来版本数据触发只读降级，不采纳也不覆盖。
   * 约束：handler 内绝不回写 storage，从结构上杜绝同步循环。
   */
  private bindStorageListener(): void {
    if (this.storageListenerBound) return;
    this.storageListenerBound = true;
    this.storageUnsubscribe = subscribeStorageKey(
      USAGE_METRICS_STORAGE_KEY,
      this.ownWrites,
      next => {
        if (this.isFutureSchema(next)) {
          this.enterReadOnlyMode();
          return;
        }
        const parsed = this.parseStored(next);
        if (!parsed) return;
        if (parsed.updatedAt < this.data.updatedAt) return;
        this.data = parsed;
        this.hydrated = true;
        this.notify();
      },
    );
  }

  /** 判定存储数据是否来自比当前代码更新的结构版本（未来版本装旧代码） */
  private isFutureSchema(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const version = (raw as UsageMetricsData).schemaVersion;
    return typeof version === 'number' && version > SCHEMA_VERSION;
  }

  /** 进入只读降级：继续内存统计但永不写盘，保护未来版本数据不被覆盖破坏 */
  private enterReadOnlyMode(): void {
    if (this.persistenceDisabled) return;
    this.persistenceDisabled = true;
    console.warn(
      `[UsageMetrics] 检测到更高 schema 版本的统计数据（当前支持 v${SCHEMA_VERSION}），` +
        '本上下文切换为只读内存统计，不会覆盖存储中的新版本数据'
    );
  }

  /** 页面隐藏/卸载前冲刷未落盘数据 */
  private bindUnloadFlush(): void {
    if (this.unloadFlushBound) return;
    if (typeof window === 'undefined') return;
    this.unloadFlushBound = true;
    const flush = () => {
      if (this.persistTimer !== undefined) {
        clearTimeout(this.persistTimer);
        this.persistTimer = undefined;
      }
      void this.persistNow();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
}

/** 空数据工厂 */
function metricContext(input: Partial<UsageRecordInput>): import('../stream/types').RequestMetricsContext {
  const result: import('../stream/types').RequestMetricsContext = {};
  for (const key of ['channelId', 'modelId', 'channelLabel', 'agentId', 'runId'] as const) {
    if (typeof input[key] === 'string') result[key] = input[key]!.slice(0, 160);
  }
  for (const key of ['iteration', 'sharedPrefixMessages'] as const) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key]) && input[key]! >= 0) result[key] = toSafeCount(input[key]);
  }
  for (const key of ['compacted', 'trimmed', 'prefixChanged'] as const) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }
  return result;
}

function safeUsage(usage: UsageRecordInput['usage']): UsageRecordInput['usage'] {
  if (!usage || typeof usage !== 'object') return undefined;
  const result: NonNullable<UsageRecordInput['usage']> = {};
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens', 'reasoningTokens'] as const) {
    if (typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key]! >= 0) result[key] = toSafeCount(usage[key]);
  }
  if (result.inputTokens !== undefined && result.cachedInputTokens !== undefined) result.cachedInputTokens = Math.min(result.cachedInputTokens, result.inputTokens);
  return result;
}

function addCacheDiagnostics(totals: UsageCounters, input: UsageRecordInput): void {
  const usage = input.usage;
  if (usage?.cachedInputTokens === undefined || usage.inputTokens === undefined) return;
  totals.cacheObservedRequests = addSafe(totals.cacheObservedRequests, 1);
  if (usage.cachedInputTokens > 0) totals.cacheHitRequests = addSafe(totals.cacheHitRequests, 1);
  if ((input.iteration ?? 0) > 1 && input.kind === 'chat') {
    totals.continuationCacheRequests = addSafe(totals.continuationCacheRequests, 1);
    totals.continuationInputTokens = addSafe(totals.continuationInputTokens, toSafeCount(usage.inputTokens));
    totals.continuationCachedTokens = addSafe(totals.continuationCachedTokens, toSafeCount(usage.cachedInputTokens));
  }
}

function createEmptyData(): UsageMetricsData {
  return {
    schemaVersion: SCHEMA_VERSION,
    startedAt: 0,
    updatedAt: 0,
    totals: createEmptyCounters(),
    byModel: {},
    byScope: {},
    recentRequests: [],
    recentErrors: [],
  };
}

/** 全局单例（sidepanel 内所有插桩点共享同一份内存聚合） */
export const aiUsageMetrics = new UsageMetricsEngine();

/**
 * 任意错误 → 指标用一句话摘要（脱敏：只取单行，绝不携带完整响应体 / URL / 密钥）。
 * 鸭子类型识别 ApiRequestError.toSingleLine()，避免引擎反向依赖 stream 层。
 */
export function summarizeErrorForMetrics(error: unknown): string {
  try {
    const anyError = error as any;
    if (anyError && typeof anyError.toSingleLine === 'function') {
      return String(anyError.toSingleLine()).slice(0, MAX_ERROR_SUMMARY_LEN);
    }
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    return (message.split('\n')[0] || 'unknown error').slice(0, MAX_ERROR_SUMMARY_LEN);
  } catch {
    return 'unknown error';
  }
}

export default aiUsageMetrics;

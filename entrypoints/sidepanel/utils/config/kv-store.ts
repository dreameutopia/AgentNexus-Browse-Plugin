/**
 * 弹性存储域（ResilientDomain）
 *
 * 单个配置域的三层冗余与写入校验：
 *
 *   读取恢复阶梯：primary → mirror → snapshot(newest→oldest) → salvage(降级读) → none
 *   写入流程：    构造封套 → 旧值压入快照环 → 单次 set 同时写三键 → 读回校验 → 不一致/异常重试
 *
 * 关键保证：
 * - **写不进去一定抛错**（ConfigWriteError），调用方能提示用户，绝不静默吞掉
 * - **写坏了能恢复**：镜像与快照在同一次 set 中落盘，主副本被截断时读侧自动降级并回填自愈
 * - **并发安全**：同域写入串行（promise 链），rev 单调递增不互相覆盖
 * - **降级保护**：读到更高 schema 的数据 → frozen，save() 拒绝覆写
 */

import { encodeEnvelope, decodeEnvelope, ENGINE_SCHEMA } from './envelope';
import { stableStringify } from './checksum';
import type {
  DomainDiagnostics,
  DomainLoadResult,
  DomainSaveResult,
  SnapshotEntry,
  StorageAreaLike,
} from './types';

/** 镜像副本键后缀 */
export const MIRROR_SUFFIX = '__mirror';
/** 滚动快照键后缀 */
export const SNAPSHOT_SUFFIX = '__snaps';
/** 默认保留的快照层数 */
export const DEFAULT_SNAPSHOT_COUNT = 5;
/** 默认读回校验重试次数（首次写入之外的额外尝试） */
export const DEFAULT_VERIFY_RETRIES = 3;

/**
 * 判定一组读取告警是否**只是「从未配置过」的初始空态**。
 *
 * 域在首次使用前，存储里主副本 / 镜像 / 快照三层都没有数据，
 * 恢复阶梯会如实记录 'primary:empty' / 'mirror:empty' / 'snapshots:empty'——
 * 这不是异常，而是「还没写过」的正常事实。
 *
 * 消费方据此把「空态」与「真的损坏」区分开：
 * 空态静默跳过（不刷无意义的红色告警），损坏照常告警并走修复流程。
 * 若不区分，每个未配置的域在每次启动时都会刷一条告警，
 * 真正的损坏告警会被淹没在噪声里。
 */
export function isInitialEmptyState(issues: readonly string[]): boolean {
  if (issues.length === 0) return false;
  return issues.every(
    issue =>
      issue === 'primary:empty' || issue === 'mirror:empty' || issue === 'snapshots:empty',
  );
}

/** 写入失败（未通过读回校验 / 配额超限 / 载荷非法） */
export class ConfigWriteError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = 'ConfigWriteError';
    this.code = code;
    this.detail = detail;
  }
}

/** 数据 schema 高于当前引擎，写入被冻结（插件降级保护） */
export class ConfigFrozenError extends Error {
  readonly storedSchema: number;

  constructor(storedSchema: number, key: string) {
    super(`config "${key}" was written by a newer schema (v${storedSchema}), write refused to avoid data loss`);
    this.name = 'ConfigFrozenError';
    this.storedSchema = storedSchema;
  }
}

export interface DomainOptions<T> {
  /** 域 id（日志与诊断用） */
  id: string;
  /** 存储区域（生产为 chrome.storage.local 包装，测试注入内存实现） */
  area: StorageAreaLike;
  /** 主副本键名（必须沿用历史键名以兼容存量安装） */
  key: string;
  /** 结构校验器：拒绝明显不属于该域的数据 */
  validate: (data: unknown) => data is T;
  /** 快照层数，默认 5 */
  snapshotCount?: number;
  /** 读回校验重试次数，默认 3（即最多写 3 次） */
  verifyRetries?: number;
  /** 重试间隔（毫秒），默认指数递增 20/40/60；测试注入空实现以提速 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export class ResilientDomain<T> {
  readonly id: string;
  readonly key: string;
  readonly mirrorKey: string;
  readonly snapshotKey: string;

  private readonly area: StorageAreaLike;
  private readonly validateData: (data: unknown) => data is T;
  private readonly snapshotCount: number;
  private readonly verifyRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** 最近一次成功 load/save 的内存缓存（供写入计算 rev 基准，避免重复 IO） */
  private cache: { data: T; rev: number; updatedAt: number; frozen: boolean } | null = null;
  private lastLoad: DomainLoadResult<T> | null = null;
  /** 冻结时存储数据的真实 schema 版本（供 ConfigFrozenError 报错） */
  private frozenSchema: number | null = null;
  /** 写入串行队列 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: DomainOptions<T>) {
    this.id = options.id;
    this.key = options.key;
    this.mirrorKey = options.key + MIRROR_SUFFIX;
    this.snapshotKey = options.key + SNAPSHOT_SUFFIX;
    this.area = options.area;
    this.validateData = options.validate;
    this.snapshotCount = Math.max(1, options.snapshotCount ?? DEFAULT_SNAPSHOT_COUNT);
    this.verifyRetries = Math.max(0, options.verifyRetries ?? DEFAULT_VERIFY_RETRIES);
    this.sleep = options.sleep ?? defaultSleep;
  }

  // ==================== 队列 ====================

  private enqueue<R>(task: () => Promise<R>): Promise<R> {
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  // ==================== 读取 ====================

  /** 读取（含恢复阶梯）。读操作不进写队列，可与写并发。 */
  async load(): Promise<DomainLoadResult<T>> {
    const result = await this.loadLocked();
    this.lastLoad = result;
    return result;
  }

  private async loadLocked(): Promise<DomainLoadResult<T>> {
    const raw = await this.area.get([this.key, this.mirrorKey, this.snapshotKey]);
    const issues: string[] = [];

    // 1) 主副本
    const primary = decodeEnvelope<T>(raw[this.key], { allowSchemaFuture: true });
    if (primary.ok && this.validateData(primary.data)) {
      const frozen = primary.schema > ENGINE_SCHEMA;
      if (frozen) issues.push(`schema-future:${primary.schema}`);
      if (primary.legacy) issues.push('legacy-raw-format');
      this.frozenSchema = frozen ? primary.schema : null;
      const result: DomainLoadResult<T> = {
        data: primary.data,
        source: 'primary',
        rev: primary.rev,
        updatedAt: primary.updatedAt,
        frozen,
        issues,
      };
      this.cache = { data: primary.data, rev: primary.rev, updatedAt: primary.updatedAt, frozen };
      // 主副本可用 → 检查镜像/快照是否完好，坏了就排队修复（只补副本，不碰主副本）
      void this.scheduleRepair(raw[this.key], raw);
      return result;
    }

    const primaryReason = primary.ok ? 'invalid-data' : primary.reason;
    issues.push(`primary:${primaryReason}${primary.ok ? '' : primary.detail ? `(${primary.detail})` : ''}`);

    // 2) 镜像副本
    const mirror = decodeEnvelope<T>(raw[this.mirrorKey], { allowSchemaFuture: true });
    if (mirror.ok && this.validateData(mirror.data)) {
      issues.push('recovered-from-mirror');
      const frozen = mirror.schema > ENGINE_SCHEMA;
      this.frozenSchema = frozen ? mirror.schema : null;
      const result: DomainLoadResult<T> = {
        data: mirror.data,
        source: 'mirror',
        rev: mirror.rev,
        updatedAt: mirror.updatedAt,
        frozen,
        issues,
      };
      this.cache = { data: mirror.data, rev: mirror.rev, updatedAt: mirror.updatedAt, frozen };
      // 自愈：把镜像写回主副本（复核后写，避免覆盖并发产生的新值）
      void this.scheduleRestorePrimary(raw[this.key], mirror);
      return result;
    }
    if (!mirror.ok) issues.push(`mirror:${mirror.reason}`);

    // 3) 滚动快照（新 → 旧）
    const snapshots = this.decodeSnapshots(raw[this.snapshotKey]);
    for (const entry of snapshots) {
      if (this.validateData(entry.data)) {
        issues.push(`recovered-from-snapshot:rev${entry.rev}`);
        this.cache = { data: entry.data, rev: entry.rev, updatedAt: entry.updatedAt, frozen: false };
        // 从快照恢复 → 主副本/镜像都是坏的，排队回填（复核后写，不会覆盖并发新值）
        void this.scheduleRestorePrimary(raw[this.key], entry);
        return {
          data: entry.data,
          source: 'snapshot',
          rev: entry.rev,
          updatedAt: entry.updatedAt,
          frozen: false,
          issues,
        };
      }
    }
    if (!snapshots.length) issues.push('snapshots:empty');

    // 4) 抢救读：校验和不匹配但结构可用 → 用（宁可脏也不丢），并打上标记
    const salvage = decodeEnvelope<T>(raw[this.key], {
      allowSchemaFuture: true,
      allowChecksumMismatch: true,
    });
    if (salvage.ok && this.validateData(salvage.data)) {
      issues.push('checksum-mismatch-salvaged');
      const salvageFrozen = salvage.schema > ENGINE_SCHEMA;
      this.cache = { data: salvage.data, rev: salvage.rev, updatedAt: salvage.updatedAt, frozen: salvageFrozen };
      return {
        data: salvage.data,
        source: 'salvage',
        rev: salvage.rev,
        updatedAt: salvage.updatedAt,
        frozen: salvageFrozen,
        issues,
      };
    }

    // 5) 全部不可用
    return { data: null, source: 'none', rev: 0, updatedAt: 0, frozen: false, issues };
  }

  private decodeSnapshots(raw: unknown): SnapshotEntry<T>[] {
    const decoded = decodeEnvelope<unknown>(raw);
    if (!decoded.ok || !Array.isArray(decoded.data)) return [];
    const entries: SnapshotEntry<T>[] = [];
    for (const item of decoded.data) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (record.data === undefined) continue;
      entries.push({
        rev: typeof record.rev === 'number' ? record.rev : 0,
        updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
        data: record.data as T,
      });
    }
    // 理论上写入即有序，这里再兜一层按 rev 降序
    return entries.sort((a, b) => b.rev - a.rev);
  }

  // ==================== 自愈 ====================

  /** 快照键是否存有「可解开的封套 + 数组」（区别于缺失与损坏） */
  private snapshotEnvelopeOk(raw: unknown): boolean {
    if (raw === undefined || raw === null) return false;
    const decoded = decodeEnvelope<unknown>(raw);
    return decoded.ok && Array.isArray(decoded.data);
  }

  /** 主副本可用但副本层损坏 → 补齐镜像/快照 */
  private scheduleRepair(storedPrimary: unknown, loaded: Record<string, unknown>): void {
    void this.enqueue(async () => {
      try {
        const decodedPrimary = decodeEnvelope<T>(storedPrimary);
        if (!decodedPrimary.ok) return;
        const mirror = decodeEnvelope<T>(loaded[this.mirrorKey]);
        const mirrorOk =
          mirror.ok && this.validateData(mirror.data) && mirror.rev === decodedPrimary.rev;
        const snapsOk = this.snapshotEnvelopeOk(loaded[this.snapshotKey]);
        if (mirrorOk && snapsOk) return;

        const fresh = await this.area.get([this.key]);
        const current = decodeEnvelope<T>(fresh[this.key]);
        // 主副本已被并发写入更新 → 修复对象已过期，放弃（下次读取自然会再判）
        if (!current.ok || stableStringify(fresh[this.key]) !== stableStringify(storedPrimary)) return;

        const payload: Record<string, unknown> = {};
        if (!mirrorOk) payload[this.mirrorKey] = storedPrimary;
        if (!snapsOk) {
          payload[this.snapshotKey] = encodeEnvelope<SnapshotEntry<T>[]>(
            [{
              rev: decodedPrimary.rev,
              updatedAt: decodedPrimary.updatedAt,
              data: decodedPrimary.data,
            }],
            decodedPrimary.rev,
            decodedPrimary.updatedAt
          );
        }
        await this.area.set(payload);
      } catch (error) {
        console.warn(`[ConfigEngine] domain=${this.id} 副本修复失败:`, describeError(error));
      }
    });
  }

  /** 主副本损坏（或来自快照的恢复）→ 回填主副本 + 镜像 */
  private scheduleRestorePrimary(
    brokenPrimary: unknown,
    recovered: { data: T; rev: number; updatedAt: number }
  ): void {
    void this.enqueue(async () => {
      try {
        const fresh = await this.area.get([this.key]);
        const current = decodeEnvelope<T>(fresh[this.key]);
        if (current.ok && this.validateData(current.data)) return; // 已被修复/更新
        if (stableStringify(fresh[this.key]) !== stableStringify(brokenPrimary)) return; // 变了，保守放弃
        const restored = encodeEnvelope(recovered.data, recovered.rev, recovered.updatedAt);
        await this.area.set({ [this.key]: restored, [this.mirrorKey]: restored });
      } catch (error) {
        console.warn(`[ConfigEngine] domain=${this.id} 主副本回填失败:`, describeError(error));
      }
    });
  }

  // ==================== 写入 ====================

  /**
   * 写入并读回校验。
   * @throws ConfigFrozenError 插件降级（数据 schema 更高）时拒绝覆写
   * @throws ConfigWriteError   载荷非法 / 配额超限 / 重试后仍未通过读回校验
   */
  save(data: T): Promise<DomainSaveResult> {
    return this.enqueue(() => this.saveLocked(data));
  }

  private async saveLocked(data: T): Promise<DomainSaveResult> {
    if (!this.validateData(data)) {
      throw new ConfigWriteError('invalid-payload', `domain "${this.id}" payload failed validation`);
    }

    // rev 基准：优先内存缓存，其次现场读（含恢复阶梯）
    const base = this.cache ?? (await this.load());
    if (base.frozen) {
      throw new ConfigFrozenError(this.frozenSchema ?? ENGINE_SCHEMA + 1, this.key);
    }

    const rev = base.rev + 1;
    const updatedAt = Date.now();
    const envelope = encodeEnvelope(data, rev, updatedAt);

    // 旧值先压入快照环，再整体覆写（快照是最后一道防线）
    const previous: SnapshotEntry<T>[] =
      base.data === null
        ? []
        : [{ rev: base.rev, updatedAt: base.updatedAt, data: base.data }];
    const history = await this.readSnapshots();
    const nextSnapshots = [...previous, ...history].slice(0, this.snapshotCount);
    const snapshotEnvelope = encodeEnvelope<SnapshotEntry<T>[]>(nextSnapshots, rev, updatedAt);

    const payload: Record<string, unknown> = {
      [this.key]: envelope,
      [this.mirrorKey]: envelope,
      [this.snapshotKey]: snapshotEnvelope,
    };

    let attempts = 0;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.verifyRetries; attempt++) {
      attempts++;
      try {
        await this.area.set(payload);
        const verify = await this.area.get([this.key, this.mirrorKey]);
        const primaryOk = stableStringify(verify[this.key]) === stableStringify(envelope);
        const mirrorOk = stableStringify(verify[this.mirrorKey]) === stableStringify(envelope);
        if (primaryOk && mirrorOk) {
          this.cache = { data, rev, updatedAt, frozen: false };
          this.lastLoad = { data, source: 'primary', rev, updatedAt, frozen: false, issues: [] };
          return {
            rev,
            updatedAt,
            bytes: JSON.stringify(payload).length,
            verified: true,
            attempts,
          };
        }
        lastError = `read-back mismatch (primary=${primaryOk} mirror=${mirrorOk})`;
      } catch (error) {
        lastError = error;
        // 配额超限重试无意义，直接失败并给出可诊断的错误
        const message = describeError(error);
        if (/QUOTA|quota|MAX_WRITE|bytes/i.test(message)) {
          throw new ConfigWriteError('quota-exceeded', `domain "${this.id}" storage quota exceeded`, message);
        }
      }
      if (attempt < this.verifyRetries) await this.sleep(20 * (attempt + 1));
    }

    throw new ConfigWriteError(
      'unverified',
      `domain "${this.id}" write could not be verified after ${attempts} attempt(s)`,
      describeError(lastError)
    );
  }

  /** 读取当前快照环（解析失败返回空数组，不抛错 —— 快照是兜底，坏了不能拖垮主流程） */
  async readSnapshots(): Promise<SnapshotEntry<T>[]> {
    try {
      const raw = await this.area.get([this.snapshotKey]);
      return this.decodeSnapshots(raw[this.snapshotKey]);
    } catch {
      return [];
    }
  }

  /** 清空该域全部数据（含副本与快照），用于重置/回滚 */
  clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.area.remove([this.key, this.mirrorKey, this.snapshotKey]);
      this.cache = null;
      this.lastLoad = null;
    });
  }

  /** 返回最近一次 load 的内存结果（不做 IO）；从未读取过返回 null */
  peek(): DomainLoadResult<T> | null {
    return this.lastLoad;
  }

  // ==================== 诊断 ====================

  async diagnostics(): Promise<DomainDiagnostics> {
    let raw: Record<string, unknown> = {};
    try {
      raw = await this.area.get([this.key, this.mirrorKey, this.snapshotKey]);
    } catch (error) {
      return {
        id: this.id,
        key: this.key,
        source: 'none',
        rev: 0,
        updatedAt: 0,
        mirrorOk: false,
        snapshotCount: 0,
        bytes: -1,
        frozen: false,
        issues: [`read-failed:${describeError(error)}`],
      };
    }

    const issues: string[] = [];
    const primary = decodeEnvelope<T>(raw[this.key], { allowSchemaFuture: true, allowChecksumMismatch: true });
    const mirror = decodeEnvelope<T>(raw[this.mirrorKey], { allowSchemaFuture: true });
    const snapshots = this.decodeSnapshots(raw[this.snapshotKey]);
    const frozen = primary.ok && primary.schema > ENGINE_SCHEMA;

    const mirrorOk = mirror.ok && this.validateData(mirror.data);
    const snapshotEnvelopeOk = this.snapshotEnvelopeOk(raw[this.snapshotKey]);
    const hasAny = !!raw[this.key] || !!raw[this.mirrorKey] || !!raw[this.snapshotKey];

    // 全空 = 用户尚未配置（全新安装），不算告警；只要有任一层存在就按层验收
    if (hasAny) {
      if (!raw[this.key]) issues.push('primary:missing');
      else if (!primary.ok) issues.push(`primary:${primary.reason}`);
      else if (!this.validateData(primary.data)) issues.push('primary:invalid-data');
      if (raw[this.mirrorKey] && !mirrorOk) {
        issues.push(`mirror:${mirror.ok ? 'invalid-data' : mirror.reason}`);
      }
      // 快照环允许为空数组（只写过一次），只在「封套本身解不开」时报损坏
      if (raw[this.snapshotKey] && !snapshotEnvelopeOk) issues.push('snapshots:corrupt');
    }

    let bytes = -1;
    if (this.area.getBytesInUse) {
      try {
        bytes = await this.area.getBytesInUse([this.key, this.mirrorKey, this.snapshotKey]);
      } catch {
        bytes = -1;
      }
    }

    return {
      id: this.id,
      key: this.key,
      source: this.lastLoad?.source ?? (primary.ok ? 'primary' : 'none'),
      rev: primary.ok ? primary.rev : 0,
      updatedAt: primary.ok ? primary.updatedAt : 0,
      mirrorOk,
      snapshotCount: snapshots.length,
      bytes,
      frozen,
      issues,
    };
  }
}

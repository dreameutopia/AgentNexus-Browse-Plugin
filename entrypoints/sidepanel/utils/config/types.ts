/**
 * 配置持久化引擎 —— 基础类型
 *
 * 设计目标（工业级）：
 * 1. 主副本 + 镜像副本 + 滚动快照三层冗余，任何一层损坏都能自愈/降级恢复
 * 2. 写后读回校验（read-back verify），写入未生效立即重试，最终失败向上抛错（绝不静默丢数据）
 * 3. 封套带 schema 版本 + 校验和，插件降级时冻结写入（防止新版本数据被旧版本覆写）
 * 4. 存储层与 chrome 完全解耦（StorageAreaLike / LocalStoreLike 注入），可在 Node 里单测
 */

/** 可注入的存储区域抽象（生产实现包装 chrome.storage.local，测试实现用内存 Map） */
export interface StorageAreaLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  /** 返回已用字节数；实现不支持时返回 -1 */
  getBytesInUse?(keys: string[]): Promise<number>;
}

/** 可注入的 Web Storage 抽象（生产实现为 window.localStorage） */
export interface LocalStoreLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 一次读取最终生效的来源（恢复阶梯：primary → mirror → snapshot → salvage → none） */
export type DomainSource = 'primary' | 'mirror' | 'snapshot' | 'salvage' | 'none';

/** 域读取结果 */
export interface DomainLoadResult<T> {
  /** 恢复出的数据；source='none' 时为 null */
  data: T | null;
  source: DomainSource;
  /** 数据对应的修订号（每次成功写入 +1） */
  rev: number;
  /** 最后一次成功写入的时间戳（无数据为 0） */
  updatedAt: number;
  /**
   * 封套 schema 高于当前引擎（插件被降级）→ 只读保护：
   * 数据仍可读，但 save() 会拒绝覆写，避免旧版本把新版本数据打坏
   */
  frozen: boolean;
  /** 本次读取发现并已处理的问题（用于日志与诊断面板） */
  issues: string[];
}

/** 域写入结果 */
export interface DomainSaveResult {
  rev: number;
  updatedAt: number;
  /** 本次写入的总字节数（主副本 + 镜像 + 快照） */
  bytes: number;
  /** 是否通过写后读回校验 */
  verified: boolean;
  /** 实际写入尝试次数（>1 说明发生过重试） */
  attempts: number;
}

/** 滚动快照条目 */
export interface SnapshotEntry<T> {
  rev: number;
  updatedAt: number;
  data: T;
}

/** 单个域的健康诊断 */
export interface DomainDiagnostics {
  id: string;
  key: string;
  source: DomainSource;
  rev: number;
  updatedAt: number;
  /** 镜像副本是否可用 */
  mirrorOk: boolean;
  /** 可用快照层数 */
  snapshotCount: number;
  /** 该域三个键的总字节数；不支持统计时为 -1 */
  bytes: number;
  frozen: boolean;
  issues: string[];
}

/** 引擎整体健康摘要（供 UI 展示） */
export interface EngineHealth {
  /** 无任何告警 */
  healthy: boolean;
  /** 告警条数 */
  issueCount: number;
  /** 所有域的可用快照总层数 */
  snapshotTotal: number;
  /** 所有域的总字节数；不支持统计时为 -1 */
  bytes: number;
}

/** 引擎完整诊断 */
export interface EngineDiagnostics {
  domains: DomainDiagnostics[];
  health: EngineHealth;
}

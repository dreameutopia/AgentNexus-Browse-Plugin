/**
 * 配置持久化引擎（门面）
 *
 * 统一管理插件的「用户配置类」持久化数据：
 *   - chrome.storage.local 域：channels / appSettings / asrConfig（封套 + 镜像 + 快照）
 *   - localStorage 遗留域：systemSettings
 *     （localStorage 会在「清除浏览数据」时被抹掉 → 引擎把它镜像进 storage.local，
 *       启动时双向对账：localStorage 有值以它为准回灌引擎；localStorage 空了用引擎回填）
 *   - 原生键（只读透传，格式不能动，否则会破坏既有读取方）：ui_locale / workflows
 *
 * 智能体/技能数据已迁移至共享存储层（utils/agents、utils/skills，
 * chrome.storage 权威源 + 跨上下文同步），不再经由本引擎。
 *
 * 启动流程（main.ts 在挂载 Vue 前调用 initConfigEngine）：
 *   init() → 对账 localStorage ↔ 引擎 → 输出诊断（有告警只 warn，不阻塞启动）
 *
 * 所有依赖（storage area / localStorage）均可注入，可在 Node 中单测。
 */

import { SUPPORTED_LOCALES } from '@/utils/i18n/core';
import { stableStringify } from './checksum';
import { ResilientDomain } from './kv-store';
import { ENGINE_SCHEMA } from './envelope';
import type {
  DomainDiagnostics,
  EngineDiagnostics,
  EngineHealth,
  LocalStoreLike,
  StorageAreaLike,
} from './types';
import {
  isRecord,
  isChannelStateLike,
  isAppSettingsLike,
  isUserAsrConfigLike,
} from './validators';

/** 受管配置域（storage.local 中带封套的键） */
export type DomainId =
  | 'channels'
  | 'appSettings'
  | 'asrConfig'
  | 'systemSettings';

/** 受管原生键（保持裸值存储，避免破坏既有读取方） */
export type RawSectionId = 'locale' | 'workflows';

/** 备份/导入导出涉及的全部分区 */
export type SectionId = DomainId | RawSectionId;

export const ALL_SECTION_IDS: readonly SectionId[] = [
  'channels',
  'appSettings',
  'asrConfig',
  'systemSettings',
  'locale',
  'workflows',
];

/** 分区快照（读取/备份用） */
export interface SectionSnapshot {
  id: SectionId;
  data: unknown;
  /** 数据结构版本；原生键恒为 0 */
  schema: number;
  rev: number;
  updatedAt: number;
}

interface ExternalBinding {
  /** localStorage 键名 */
  storageKey: string;
}

interface DomainDef {
  id: DomainId;
  /** chrome.storage.local 主键（沿用历史键名，保证存量安装无缝升级） */
  key: string;
  validate: (data: unknown) => boolean;
  /** 存在表示该域同时落在 localStorage（遗留读取方仍在用） */
  external?: ExternalBinding;
}

const DOMAIN_DEFS: readonly DomainDef[] = [
  { id: 'channels', key: 'agent_nexus_channels', validate: isChannelStateLike },
  { id: 'appSettings', key: 'agent_nexus_app_settings', validate: isAppSettingsLike },
  { id: 'asrConfig', key: 'agent_nexus_asr_config', validate: isUserAsrConfigLike },
  {
    id: 'systemSettings',
    key: 'agent_nexus_ls_systemSettings',
    validate: isRecord,
    external: { storageKey: 'systemSettings' },
  },
];

const RAW_SECTION_DEFS: Record<RawSectionId, { key: string; validate: (value: unknown) => boolean }> = {
  locale: {
    key: 'ui_locale',
    validate: (value): value is string =>
      typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value),
  },
  workflows: { key: 'workflows', validate: Array.isArray },
};

/** init() / syncExternals() 的执行报告 */
export interface InitReport {
  /** localStorage 为空、已用引擎数据回填的分区 */
  seeded: SectionId[];
  /** localStorage 有值、已回灌引擎的分区 */
  mirrored: SectionId[];
  /** 非致命问题（只记录，不阻塞启动） */
  issues: string[];
}

export interface EngineDeps {
  area: StorageAreaLike;
  localStore?: LocalStoreLike | null;
}

function safeLocalStorage(): LocalStoreLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    // 隐私模式下访问 localStorage 可能抛异常
    const probe = '__agentnexus_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

function createChromeArea(): StorageAreaLike {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('chrome.storage.local is unavailable in this context');
  }
  const area = chrome.storage.local;
  return {
    async get(keys) {
      return (await area.get(keys)) as Record<string, unknown>;
    },
    async set(items) {
      await area.set(items as Record<string, unknown>);
    },
    async remove(keys) {
      await area.remove(keys);
    },
    async getBytesInUse(keys) {
      try {
        return await area.getBytesInUse(keys);
      } catch {
        return -1;
      }
    },
  };
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class ConfigEngine {
  private readonly deps: EngineDeps;
  private readonly domains = new Map<DomainId, ResilientDomain<unknown>>();
  private readonly defById = new Map<DomainId, DomainDef>();
  private initPromise: Promise<InitReport> | null = null;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    for (const def of DOMAIN_DEFS) {
      this.defById.set(def.id, def);
      this.domains.set(
        def.id,
        new ResilientDomain<unknown>({
          id: def.id,
          area: this.deps.area,
          key: def.key,
          // def.validate 是各域专用的结构谓词，此处按 unknown 谓词注入（运行时语义不变）
          validate: def.validate as (data: unknown) => data is unknown,
        })
      );
    }
  }

  // ==================== 生命周期 ====================

  /** 幂等初始化：localStorage ↔ 引擎对账。失败不抛（报告写进 issues）。 */
  init(): Promise<InitReport> {
    this.initPromise ??= this.runSync();
    return this.initPromise;
  }

  /** 重新执行 localStorage ↔ 引擎对账（配置写入后调用）。先等初始化完成，避免并发对账。 */
  async syncExternals(): Promise<InitReport> {
    try {
      await this.init();
    } catch {
      // 初始化失败不阻塞重新对账
    }
    return this.runSync();
  }

  private async runSync(): Promise<InitReport> {
    const report: InitReport = { seeded: [], mirrored: [], issues: [] };
    const localStore = this.deps.localStore;
    for (const def of DOMAIN_DEFS) {
      if (!def.external || !localStore) continue;
      try {
        await this.syncExternalDomain(def, localStore, report);
      } catch (error) {
        report.issues.push(`${def.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return report;
  }

  private async syncExternalDomain(
    def: DomainDef,
    localStore: LocalStoreLike,
    report: InitReport
  ): Promise<void> {
    const binding = def.external;
    if (!binding) return;
    const domain = this.domains.get(def.id);
    if (!domain) return;

    const raw = localStore.getItem(binding.storageKey);
    const hasLocalValue = !!raw && raw.trim().length > 0;
    const parsed = hasLocalValue ? safeParseJson(raw as string) : null;
    const localValid = parsed !== null && def.validate(parsed);

    if (hasLocalValue && localValid) {
      // localStorage 有合法值 → 它是用户最近一次写入的事实源，回灌引擎
      const current = await domain.load();
      if (current.data === null || stableStringify(current.data) !== stableStringify(parsed)) {
        await domain.save(parsed);
        report.mirrored.push(def.id);
      }
      return;
    }

    if (hasLocalValue && !localValid) {
      report.issues.push(`${def.id}: localStorage 数据损坏，尝试用引擎副本修复`);
    }

    // localStorage 为空（或损坏）→ 用引擎数据回填
    const state = await domain.load();
    if (state.data !== null) {
      localStore.setItem(binding.storageKey, JSON.stringify(state.data));
      report.seeded.push(def.id);
    } else if (hasLocalValue && !localValid) {
      // 引擎也没有可用数据 → 用损坏的原始串覆盖没有意义，保留现场供排查
      report.issues.push(`${def.id}: 无可用副本，localStorage 损坏数据未被覆盖`);
    }
  }

  // ==================== 域访问 ====================

  /** 取受管配置域（类型由调用方声明，运行时由域校验器兜底） */
  domain<T>(id: DomainId): ResilientDomain<T> {
    const domain = this.domains.get(id);
    if (!domain) throw new Error(`unknown config domain: ${id}`);
    return domain as unknown as ResilientDomain<T>;
  }

  // ==================== 分区读写（备份/导入用） ====================

  async readSection(id: SectionId): Promise<SectionSnapshot | null> {
    await this.init();
    if (this.isDomainId(id)) {
      const state = await this.domain<unknown>(id).load();
      if (state.data === null) return null;
      return { id, data: state.data, schema: ENGINE_SCHEMA, rev: state.rev, updatedAt: state.updatedAt };
    }
    const def = RAW_SECTION_DEFS[id];
    const raw = await this.deps.area.get([def.key]);
    const value = raw[def.key];
    if (value === undefined || value === null) return null;
    if (!def.validate(value)) return null;
    return { id, data: value, schema: 0, rev: 0, updatedAt: 0 };
  }

  /**
   * 写入分区（导入恢复用）
   * @throws Error 校验不通过 / 写入未通过读回校验
   */
  async writeSection(id: SectionId, data: unknown): Promise<void> {
    await this.init();
    if (this.isDomainId(id)) {
      const def = this.defById.get(id);
      if (!def || !def.validate(data)) {
        throw new Error(`section "${id}" failed validation`);
      }
      await this.domain<unknown>(id).save(data);
      // 遗留读取方仍在读 localStorage → 写穿过去
      if (def.external && this.deps.localStore) {
        try {
          this.deps.localStore.setItem(def.external.storageKey, JSON.stringify(data));
        } catch (error) {
          console.warn(`[ConfigEngine] ${id} 写穿 localStorage 失败:`, error);
        }
      }
      return;
    }
    const rawDef = RAW_SECTION_DEFS[id];
    if (!rawDef.validate(data)) throw new Error(`section "${id}" failed validation`);
    await this.deps.area.set({ [rawDef.key]: data });
  }

  /** 清空分区（导入回滚时用） */
  async clearSection(id: SectionId): Promise<void> {
    await this.init();
    if (this.isDomainId(id)) {
      await this.domain<unknown>(id).clear();
      const def = this.defById.get(id);
      if (def?.external && this.deps.localStore) {
        try {
          this.deps.localStore.removeItem(def.external.storageKey);
        } catch (error) {
          console.warn(`[ConfigEngine] ${id} 清除 localStorage 失败:`, error);
        }
      }
      return;
    }
    await this.deps.area.remove([RAW_SECTION_DEFS[id].key]);
  }

  private isDomainId(id: SectionId): id is DomainId {
    return (this.defById as Map<string, DomainDef>).has(id);
  }

  /**
   * 校验分区数据是否合法（导入恢复在**写入前**做全量校验用）
   * @returns false = 数据不属于该分区，拒绝写入
   */
  validateSection(id: SectionId, data: unknown): boolean {
    if (this.isDomainId(id)) return this.defById.get(id)?.validate(data) ?? false;
    const def = RAW_SECTION_DEFS[id];
    return def ? def.validate(data) : false;
  }

  // ==================== 诊断 ====================

  async diagnostics(): Promise<EngineDiagnostics> {
    const domains: DomainDiagnostics[] = [];
    for (const def of DOMAIN_DEFS) {
      const domain = this.domains.get(def.id);
      if (domain) domains.push(await domain.diagnostics());
    }

    let issueCount = 0;
    let snapshotTotal = 0;
    let bytes = 0;
    let bytesKnown = true;
    for (const item of domains) {
      issueCount += item.issues.length;
      snapshotTotal += item.snapshotCount;
      if (item.bytes < 0) bytesKnown = false;
      else bytes += item.bytes;
    }

    const health: EngineHealth = {
      healthy: issueCount === 0,
      issueCount,
      snapshotTotal,
      bytes: bytesKnown ? bytes : -1,
    };
    return { domains, health };
  }
}

// ==================== 单例 ====================

let singleton: ConfigEngine | null = null;

/** 获取生产单例（chrome.storage.local + localStorage 注入） */
export function getEngine(): ConfigEngine {
  if (!singleton) {
    singleton = new ConfigEngine({ area: createChromeArea(), localStore: safeLocalStorage() });
  }
  return singleton;
}

/** 测试注入：替换/清除单例 */
export function setEngineForTesting(engine: ConfigEngine | null): void {
  singleton = engine;
}

/** 启动初始化（幂等；main.ts 在挂载前调用） */
export function initConfigEngine(): Promise<InitReport> {
  return getEngine().init();
}

/** 重新对账 localStorage ↔ 引擎（SettingsModal 等直接写 localStorage 的位置调用） */
export function syncExternalStores(): Promise<InitReport> {
  return getEngine().syncExternals();
}

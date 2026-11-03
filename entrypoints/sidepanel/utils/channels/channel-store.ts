/**
 * 渠道存储（ChannelStore）
 *
 * 职责：
 *   - 渠道配置的持久化（配置持久化引擎 channels 域：主副本 + 镜像 + 快照三层冗余，
 *     写入读回校验，见 utils/config/kv-store.ts）；
 *   - 内存缓存的权威读取面：全部读方法返回深拷贝，外部拿到的快照
 *     绝不可能反向篡改内部状态（防御别名污染）；
 *   - 保存前的语义校验（validateChannelState）与字段归一化（normalizeChannelState）；
 *   - 变更通知（subscribe）+ 跨上下文同步（chrome.storage.onChanged → 重载 → 通知），
 *     hub 备份恢复等其它上下文的写入能在本上下文即时生效。
 *
 * 加载语义：单飞（并发 load 只触发一次 IO）、幂等（已加载后调用只做对账重读）。
 * 失败语义：load 失败保持空态并抛出（调用方决定降级）；save 校验失败以
 * 结果值返回（预期内失败），持久化失败上抛（ConfigWriteError 等，绝不静默）。
 */

import { getEngine } from '../config/engine';
import {
  cloneChannel,
  cloneChannelState,
  type ChannelConfig,
  type ChannelState,
} from './channel-types';
import { normalizeChannelState, validateChannelState } from './channel-validation';

/** 保存结果：预期内的校验失败以值返回，不走异常控制流 */
export type ChannelSaveResult =
  | { ok: true }
  | { ok: false; errors: string[] };

type Listener = () => void;

const STORAGE_KEY = 'agent_nexus_channels';

class ChannelStore {
  private channels: ChannelConfig[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private readonly listeners = new Set<Listener>();
  private storageWatcherAttached = false;

  // ==================== 加载 ====================

  /**
   * 从持久化引擎加载（单飞 + 幂等）。
   * 每次调用都重读一次存储——保证「备份恢复 / 其它上下文写入」后
   * 本上下文拿到的是最新事实（重读本身走引擎的恢复阶梯，失败会抛）。
   */
  async load(): Promise<void> {
    if (this.loadPromise) {
      await this.loadPromise;
      // 已加载过：后续调用直接重读（对账语义），不复用旧结果
      if (this.loaded) return;
    }
    this.loadPromise = (async () => {
      const state = await getEngine().domain<ChannelState>('channels').load();
      // null = 存储完全不可用（首装或全副本损坏）：按空态起步，不抛错阻塞启动
      const normalized = state.data ? normalizeChannelState(state.data) : { channels: [] };
      this.channels = normalized.channels;
      this.loaded = true;
      if (state.data && state.source !== 'primary') {
        console.warn(`[ChannelStore] 渠道配置已从 ${state.source} 副本恢复:`, state.issues);
      } else if (state.issues.length) {
        console.warn('[ChannelStore] 渠道配置读取告警:', state.issues);
      }
    })();
    try {
      await this.loadPromise;
    } finally {
      // 失败时清掉单飞句柄，下次调用可重试
      this.loadPromise = null;
    }
    this.attachStorageWatcher();
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  // ==================== 读取（一律深拷贝） ====================

  /** 全部渠道（深拷贝快照） */
  getAll(): ChannelConfig[] {
    return this.channels.map(cloneChannel);
  }

  /** 单个渠道（深拷贝；不存在返回 null） */
  get(channelId: string): ChannelConfig | null {
    const found = this.channels.find(channel => channel.id === channelId);
    return found ? cloneChannel(found) : null;
  }

  // ==================== 写入 ====================

  /**
   * 整体保存渠道文档（设置界面的「保存」入口）。
   * 流程：归一化 → 语义校验（失败以值返回，不写盘）→ 引擎保存（失败上抛）
   *       → 更新内存 → 通知订阅方。
   */
  async save(state: ChannelState): Promise<ChannelSaveResult> {
    const normalized = normalizeChannelState(state);
    const errors = validateChannelState(normalized);
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    // 引擎写入带读回校验，未通过会抛 ConfigWriteError——上抛给调用方呈现
    await getEngine().domain<ChannelState>('channels').save(normalized);
    this.channels = normalized.channels;
    this.loaded = true;
    this.notify();
    return { ok: true };
  }

  // ==================== 变更通知 ====================

  /** 订阅渠道变更（任何 save / 跨上下文同步完成后触发）；返回取消订阅函数 */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        // 单个订阅者异常绝不影响其它订阅者与主流程
        console.warn('[ChannelStore] 变更监听器执行失败:', error);
      }
    }
  }

  // ==================== 跨上下文同步 ====================

  /**
   * 监听 chrome.storage.local 中本域键的变化（幂等）。
   * hub 备份恢复、另一个侧边栏上下文写入时，本上下文自动重载并通知——
   * 模型选择器等消费方无需手动对账。
   */
  private attachStorageWatcher(): void {
    if (this.storageWatcherAttached) return;
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    this.storageWatcherAttached = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!(STORAGE_KEY in changes)) return;
      void this.load()
        .then(() => this.notify())
        .catch(error => console.warn('[ChannelStore] 跨上下文同步重载失败:', error));
    });
  }
}

/** 全局单例 */
export const channelStore = new ChannelStore();
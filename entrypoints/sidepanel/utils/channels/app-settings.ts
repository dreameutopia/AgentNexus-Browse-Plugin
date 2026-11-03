/**
 * 应用设置存储（AppSettingsStore）
 *
 * 管理与渠道无关的全局配置：
 *   - interactTimeoutMinutes（interact 询问弹窗等待时长）
 *   - 文本/视觉对话轮次上限、连续工具失败阈值（循环守卫参数）
 *   - retryCount / retryInterval / temperature（全局请求参数，不按渠道单独配置）
 *   - defaultContextThreshold（新建模型的默认上下文阈值）
 *   - activeModelRef（当前生效模型的稳定引用；新会话与一次性调用方的默认选择）
 *
 * 与 ChannelStore 同构：持久化走配置引擎 appSettings 域（三层冗余 + 读回校验）、
 * 读取返回深拷贝、保存前归一化 + 校验、变更通知、跨上下文自动同步。
 */

import { getEngine } from '../config/engine';
import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type ModelRef,
} from './channel-types';
import { normalizeAppSettings, validateAppSettings } from './channel-validation';

export type AppSettingsSaveResult =
  | { ok: true }
  | { ok: false; errors: string[] };

type Listener = () => void;

const STORAGE_KEY = 'agent_nexus_app_settings';

class AppSettingsStore {
  private settings: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    activeModelRef: null,
  };
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private readonly listeners = new Set<Listener>();
  private storageWatcherAttached = false;

  // ==================== 加载 ====================

  /** 从持久化引擎加载（单飞 + 幂等 + 对账重读，语义同 ChannelStore.load） */
  async load(): Promise<void> {
    if (this.loadPromise) {
      await this.loadPromise;
      if (this.loaded) return;
    }
    this.loadPromise = (async () => {
      const state = await getEngine().domain<AppSettings>('appSettings').load();
      this.settings = state.data ? normalizeAppSettings(state.data) : normalizeAppSettings(DEFAULT_APP_SETTINGS);
      this.loaded = true;
      if (state.data && state.source !== 'primary') {
        console.warn(`[AppSettingsStore] 应用设置已从 ${state.source} 副本恢复:`, state.issues);
      } else if (state.issues.length) {
        console.warn('[AppSettingsStore] 应用设置读取告警:', state.issues);
      }
    })();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
    this.attachStorageWatcher();
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  // ==================== 读取（深拷贝） ====================

  get(): AppSettings {
    return cloneAppSettings(this.settings);
  }

  getActiveModelRef(): ModelRef | null {
    return this.settings.activeModelRef ? { ...this.settings.activeModelRef } : null;
  }

  getInteractTimeoutMinutes(): number {
    return this.settings.interactTimeoutMinutes;
  }

  // ==================== 写入 ====================

  /**
   * 部分更新（深合并）：patch 的字段覆盖当前值，activeModelRef 传 null 是
   * 合法业务值（清除默认模型），因此判空一律用 'in' 检查，不能用 ?? 。
   */
  async save(patch: Partial<AppSettings>): Promise<AppSettingsSaveResult> {
    const merged: AppSettings = {
      ...this.settings,
      ...patch,
      activeModelRef:
        'activeModelRef' in patch ? (patch.activeModelRef ?? null) : this.settings.activeModelRef,
    };
    const normalized = normalizeAppSettings(merged);
    const errors = validateAppSettings(normalized);
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    await getEngine().domain<AppSettings>('appSettings').save(normalized);
    this.settings = normalized;
    this.loaded = true;
    this.notify();
    return { ok: true };
  }

  // ==================== 变更通知 / 跨上下文同步 ====================

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.warn('[AppSettingsStore] 变更监听器执行失败:', error);
      }
    }
  }

  private attachStorageWatcher(): void {
    if (this.storageWatcherAttached) return;
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    this.storageWatcherAttached = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!(STORAGE_KEY in changes)) return;
      void this.load()
        .then(() => this.notify())
        .catch(error => console.warn('[AppSettingsStore] 跨上下文同步重载失败:', error));
    });
  }
}

/** 全局单例 */
export const appSettingsStore = new AppSettingsStore();
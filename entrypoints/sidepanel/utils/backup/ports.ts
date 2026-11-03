/**
 * 备份引擎的默认存储端口 —— chrome.storage.local / localStorage 的最小封装
 *
 * 与 config/engine 的 StorageAreaLike / LocalStoreLike 契约对齐：
 * - area：结构化克隆读写 + getBytesInUse（存储统计需要精确字节数）；
 * - localStore：probe 探测可用性（隐私模式访问抛错 → 返回 null，调用方降级）。
 * 测试注入内存实现即可完全脱离 chrome 运行。
 */

import type { LocalStoreLike, StorageAreaLike } from '../config/types';

/** chrome.storage.local 是否可用（扩展上下文外返回 false） */
export function chromeAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

/**
 * 默认 chrome.storage.local 端口。
 * @throws 不可用时抛错——由调用方（编排器/UI）转成可读错误，绝不静默空写。
 */
export function defaultArea(): StorageAreaLike {
  if (!chromeAvailable()) {
    throw new Error('chrome.storage.local 不可用（非扩展上下文或存储被禁用）');
  }
  const area = chrome.storage.local;
  return {
    async get(keys: string[]): Promise<Record<string, unknown>> {
      return (await area.get(keys)) as Record<string, unknown>;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      await area.set(items);
    },
    async remove(keys: string[]): Promise<void> {
      await area.remove(keys);
    },
    async getBytesInUse(keys: string[]): Promise<number> {
      try {
        return await area.getBytesInUse(keys);
      } catch {
        return -1;
      }
    },
  };
}

/** 存储统计专用：全键精确字节数（null = 所有键）；不可用返回 -1 */
export async function chromeBytesInUse(keys: string[] | null): Promise<number> {
  if (!chromeAvailable()) return -1;
  try {
    return await chrome.storage.local.getBytesInUse(keys);
  } catch {
    return -1;
  }
}

/**
 * 默认 localStorage 端口（隐私模式访问可能整体抛错 → null，调用方按不可用降级）。
 */
export function defaultLocalStore(): LocalStoreLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__agentnexus_backup_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/** localStorage 全量键值快照（统计用）；不可用返回 null */
export function localStorageEntries(): { key: string; value: string }[] | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const out: { key: string; value: string }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null) continue;
      out.push({ key, value: localStorage.getItem(key) ?? '' });
    }
    return out;
  } catch {
    return null;
  }
}

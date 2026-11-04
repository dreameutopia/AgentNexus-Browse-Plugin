/**
 * 备份引擎的默认存储端口 —— chrome.storage.local / localStorage 的最小封装
 *
 * 与 config/engine 的 StorageAreaLike / LocalStoreLike 契约对齐：
 * - area：结构化克隆读写 + getBytesInUse（存储统计需要精确字节数）；
 * - localStore：probe 探测可用性（隐私模式访问抛错 → 返回 null，调用方降级）。
 * 测试注入内存实现即可完全脱离 chrome 运行。
 */

import type { LocalStoreLike, StorageAreaLike } from '../config/types';
import { estimateValueBytes } from './bytes';

/**
 * 备份 / 统计用存储端口（配置引擎端口的超集）
 *
 * 相对 StorageAreaLike 只多一个**可选**能力：getAll()——读取全部键值。
 * 统计引擎需要它来枚举「未被任何分类认领」的残余键（否则这些键的占用会被
 * 静默漏掉，表现为统计缺数）。未实现该能力时统计自动降级为「已知键合计」
 * 口径，并在 issues 中注明。
 */
export interface BackupAreaLike extends StorageAreaLike {
  getAll?(): Promise<Record<string, unknown>>;
  /**
   * 已用字节数；keys 传 null 表示「全部键」（浏览器权威口径）。
   * 声明为可选方法参数放宽到 `string[] | null`——方法参数是双变的，
   * 因此仍然兼容配置引擎的 `getBytesInUse?(keys: string[])` 契约。
   */
  getBytesInUse?(keys: string[] | null): Promise<number>;
}

/** chrome.storage.local 是否可用（扩展上下文外返回 false） */
export function chromeAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

/**
 * 默认 chrome.storage.local 端口。
 * @throws 不可用时抛错——由调用方（编排器/UI）转成可读错误，绝不静默空写。
 */
export function defaultArea(): BackupAreaLike {
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
    async getBytesInUse(keys: string[] | null): Promise<number> {
      try {
        return await area.getBytesInUse(keys);
      } catch {
        return -1;
      }
    },
    async getAll(): Promise<Record<string, unknown>> {
      return (await area.get(null)) as Record<string, unknown>;
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
 * localStorage 端口（附带可选的全量枚举能力）
 *
 * 配置引擎的 LocalStoreLike 只有 get/set/remove；存储统计还需要「枚举全部
 * 键值」才能发现未被分类认领的残余键（否则统计缺数且无提示）。
 * entries() 为**可选**：端口没实现时，统计自动降级为「只统计已知键」。
 */
export interface BackupLocalStore extends LocalStoreLike {
  entries?(): { key: string; value: string }[] | null;
}

/**
 * 默认 localStorage 端口（隐私模式访问可能整体抛错 → null，调用方按不可用降级）。
 *
 * 返回的是**包装对象**而非裸 localStorage：包装对象额外提供 `entries()`
 * （全量键值枚举），让存储统计不必依赖全局对象——测试注入的内存实现也能
 * 走同一条枚举路径。语义与裸 localStorage 完全一致。
 */
export function defaultLocalStore(): BackupLocalStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__agentnexus_backup_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return {
      getItem: (key: string) => localStorage.getItem(key),
      setItem: (key: string, value: string) => localStorage.setItem(key, value),
      removeItem: (key: string) => localStorage.removeItem(key),
      entries: () => localStorageEntries(),
    };
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

// ==================== IndexedDB 端口 ====================

/**
 * IndexedDB 端口（统计引擎用；测试可注入内存实现）
 *
 * 只暴露统计需要的能力：
 * - databases()：枚举本 origin 下的全部数据库（用于发现「未分类」的库，
 *   如历史遗留库 / 第三方写入的库）；浏览器不支持 indexedDB.databases()
 *   时返回空数组，调用方按「无法枚举」降级并在 issues 中说明。
 * - open()：打开指定数据库（**不带版本号**，因此不会触发 onupgradeneeded，
 *   也就不会意外创建/升级任何库）；失败返回 null 而不是抛错。
 */
export interface IdbPort {
  /**
   * 枚举本 origin 下的全部数据库。
   * 返回 null = **浏览器不支持枚举**（如部分 Firefox 版本）；
   * 返回 [] = 支持枚举但确实没有其它数据库。两者必须区分：否则统计会把
   * 「无法枚举」误报成「没有其它数据」，造成占用缺数而无任何提示。
   */
  databases(): Promise<{ name: string }[] | null>;
  open(name: string): Promise<IDBDatabase | null>;
}

/** 默认 IndexedDB 端口；当前上下文无 indexedDB 时返回 null */
export function defaultIdb(): IdbPort | null {
  if (typeof indexedDB === 'undefined') return null;
  return {
    async databases(): Promise<{ name: string }[] | null> {
      const factory = indexedDB as IDBFactory & {
        databases?: () => Promise<{ name: string }[]>;
      };
      if (typeof factory.databases !== 'function') return null;
      try {
        const list = await factory.databases();
        return Array.isArray(list) ? list.filter((item): item is IDBDatabaseInfo & { name: string } => typeof item?.name === 'string') : null;
      } catch {
        return null;
      }
    },
    async open(name: string): Promise<IDBDatabase | null> {
      return new Promise<IDBDatabase | null>(resolve => {
        let settled = false;
        const finish = (db: IDBDatabase | null) => {
          if (settled) return;
          settled = true;
          resolve(db);
        };
        try {
          const request = indexedDB.open(name);
          request.onsuccess = () => finish(request.result);
          request.onerror = () => finish(null);
          request.onblocked = () => finish(null);
        } catch {
          finish(null);
        }
      });
    },
  };
}

/**
 * 读取对象 store 的全部记录（只读事务；失败返回 null，绝不返回空数组
 * 冒充「库里没数据」——那会让统计缺数且无任何告警）。
 */
export async function readAllRecords(
  db: IDBDatabase,
  storeName: string,
): Promise<unknown[] | null> {
  if (!db.objectStoreNames.contains(storeName)) return null;
  return new Promise<unknown[] | null>(resolve => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => resolve(null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * 估算任意 IndexedDB 库的总体积（遍历全部 object store）。
 * 无法打开 / 无权限的库返回 -1（调用方按「统计失败」处理，不填 0）。
 */
export async function estimateDatabaseBytes(idb: IdbPort, name: string): Promise<number> {
  const db = await idb.open(name);
  if (!db) return -1;
  let total = 0;
  let readable = true;
  try {
    for (const storeName of Array.from(db.objectStoreNames)) {
      const records = await readAllRecords(db, storeName);
      if (records === null) {
        readable = false;
        break;
      }
      for (const record of records) total += estimateValueBytes(record);
    }
  } catch {
    readable = false;
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略关闭异常 */
    }
  }
  return readable ? total : -1;
}

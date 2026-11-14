import {
  invariant,
  LIMITS,
  persistedPackages,
  type PluginSnapshot,
  type InstalledPlugin,
} from './contracts';
import {
  OPERATION_LOG_LIMIT,
  type PluginOperationQuery,
  type PluginOperationRecord,
} from './operations';

export interface PluginState extends PluginSnapshot {
  schemaVersion: 1;
}
export interface ReleaseRecord {
  id: string;
  key: string;
  version: string;
  digest: string;
  bytes: Uint8Array;
}
export const emptyState = (): PluginState => ({
  schemaVersion: 1,
  generation: 0,
  packages: [],
});
/**
 * 存储记录 → 可安全消费的状态。
 *
 * IndexedDB 可能被外部工具写坏：generation 非数字、packages 非数组、塞入
 * null/原始值。这里做无抛错的收敛，保证后续对账与依赖计算拿到的是结构正确
 * 的输入，而不是在 `snapshot()` 的异常分支里二次崩溃。
 */
function normalizeState(value: unknown): PluginState {
  if (!value || typeof value !== 'object') return emptyState();
  const candidate = value as Partial<PluginState>;
  const generation =
    Number.isSafeInteger(candidate.generation) && candidate.generation! >= 0
      ? candidate.generation!
      : 0;
  const packages = Array.isArray(candidate.packages)
    ? (candidate.packages.filter(
        (plugin) =>
          plugin && typeof plugin === 'object' && typeof plugin.key === 'string',
      ) as InstalledPlugin[])
    : [];
  return {
    schemaVersion: 1,
    generation,
    packages: persistedPackages(packages),
  };
}
/** release 记录必须自洽：id = key@version，digest 为 sha256，bytes 为二进制 */
function assertReleaseRecord(record: ReleaseRecord): void {
  invariant(
    record &&
      typeof record.id === 'string' &&
      record.id === `${record.key}@${record.version}` &&
      /^[a-f0-9]{64}$/.test(record.digest) &&
      record.bytes instanceof Uint8Array,
    'INVALID_RELEASE_RECORD',
    String(record?.id),
  );
}
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? new Error('PLUGIN_TRANSACTION_ABORTED'));
  });
}
/** One CAS record serializes all lifecycle mutations across contexts and worker restarts. */
export class PluginRepository {
  private database?: Promise<IDBDatabase>;
  constructor(private readonly name = 'agentnexus-plugins-v1') {}
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      // v2：新增 operations 操作日志 store；旧库原地升级，不清空任何数据。
      const r = indexedDB.open(this.name, 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('state'))
          db.createObjectStore('state');
        if (!db.objectStoreNames.contains('releases')) {
          const releases = db.createObjectStore('releases', { keyPath: 'id' });
          releases.createIndex('plugin', 'key');
        }
        if (!db.objectStoreNames.contains('operations')) {
          const operations = db.createObjectStore('operations', {
            keyPath: 'id',
          });
          operations.createIndex('at', 'at');
          operations.createIndex('plugin', 'pluginKey');
        }
      };
      r.onsuccess = () => {
        r.result.onversionchange = () => {
          r.result.close();
          this.database = undefined;
        };
        resolve(r.result);
      };
      r.onerror = () => {
        this.database = undefined;
        reject(r.error);
      };
      r.onblocked = () => {
        this.database = undefined;
        reject(
          new Error('PLUGIN_DATABASE_BLOCKED: close older extension pages'),
        );
      };
    });
    this.database = pending;
    // 打开失败（含同步 SecurityError）不能让缓存 Promise 永久拒绝：
    // 下一次请求应重新尝试，否则 IndexedDB 短暂不可用会锁死整个插件系统。
    pending.catch(() => {
      if (this.database === pending) this.database = undefined;
    });
    return pending;
  }
  async read(): Promise<PluginState> {
    const db = await this.open(),
      tx = db.transaction('state', 'readonly'),
      done = completed(tx);
    const state = await request<PluginState | undefined>(
      tx.objectStore('state').get('active'),
    );
    await done;
    return normalizeState(state);
  }
  async release(
    key: string,
    version: string,
  ): Promise<ReleaseRecord | undefined> {
    const db = await this.open(),
      tx = db.transaction('releases', 'readonly'),
      done = completed(tx);
    const result = await request<ReleaseRecord | undefined>(
      tx.objectStore('releases').get(`${key}@${version}`),
    );
    await done;
    return result;
  }
  async dump(): Promise<{ state: PluginState; releases: ReleaseRecord[] }> {
    const db = await this.open(),
      tx = db.transaction(['state', 'releases'], 'readonly'),
      done = completed(tx);
    const [state, releases] = await Promise.all([
      request<PluginState | undefined>(tx.objectStore('state').get('active')),
      request<ReleaseRecord[]>(tx.objectStore('releases').getAll()),
    ]);
    await done;
    return { state: normalizeState(state), releases };
  }
  async restore(
    expected: number,
    packages: InstalledPlugin[],
    records: ReleaseRecord[],
  ): Promise<PluginState> {
    const stored = persistedPackages(packages);
    invariant(
      new TextEncoder().encode(JSON.stringify(stored)).length <= LIMITS.snapshot,
      'CATALOG_SIZE_LIMIT',
    );
    for (const record of records) assertReleaseRecord(record);
    const db = await this.open(),
      tx = db.transaction(['state', 'releases'], 'readwrite'),
      done = completed(tx);
    try {
      const store = tx.objectStore('state'),
        current = await request<PluginState | undefined>(store.get('active'));
      invariant((current?.generation ?? 0) === expected, 'STALE_GENERATION');
      const releases = tx.objectStore('releases');
      releases.clear();
      for (const record of records) releases.add(record);
      const state: PluginState = {
        schemaVersion: 1,
        generation: expected + 1,
        packages: stored,
      };
      store.put(state, 'active');
      await done;
      return state;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* The transaction may already be aborted. */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }
  async commit(
    expected: number,
    packages: InstalledPlugin[],
    release?: ReleaseRecord,
    removeKey?: string,
  ): Promise<PluginState> {
    const stored = persistedPackages(packages);
    invariant(
      new TextEncoder().encode(JSON.stringify(stored)).length <= LIMITS.snapshot,
      'CATALOG_SIZE_LIMIT',
    );
    if (release) assertReleaseRecord(release);
    const db = await this.open(),
      tx = db.transaction(['state', 'releases'], 'readwrite'),
      done = completed(tx);
    try {
      const stateStore = tx.objectStore('state'),
        releases = tx.objectStore('releases');
      const current = await request<PluginState | undefined>(
        stateStore.get('active'),
      );
      invariant((current?.generation ?? 0) === expected, 'STALE_GENERATION');
      if (release) {
        const existing = await request<ReleaseRecord | undefined>(
          releases.get(release.id),
        );
        invariant(
          !existing || existing.digest === release.digest,
          'VERSION_CONTENT_CONFLICT',
        );
        releases.put(release);
      }
      if (removeKey) {
        const keys = await request(
          releases.index('plugin').getAllKeys(removeKey),
        );
        for (const key of keys) releases.delete(key);
      }
      const next: PluginState = {
        schemaVersion: 1,
        generation: expected + 1,
        packages: stored,
      };
      stateStore.put(next, 'active');
      await done;
      return next;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* already aborted */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  /**
   * 追加操作日志并在同一事务内裁剪到上限。
   *
   * 日志写入失败不能反向影响插件操作本身，调用方负责吞掉异常；但这里仍保证
   * “写入 + 裁剪”原子，避免并发写入把日志撑爆。
   */
  async appendOperations(records: PluginOperationRecord[]): Promise<void> {
    if (!records.length) return;
    const db = await this.open(),
      tx = db.transaction('operations', 'readwrite'),
      done = completed(tx);
    try {
      const store = tx.objectStore('operations');
      for (const record of records) store.put(record);
      const total = await request<number>(store.count());
      let excess = total - OPERATION_LOG_LIMIT;
      if (excess > 0) {
        await new Promise<void>((resolve, reject) => {
          const cursor = store.index('at').openCursor();
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (!entry || excess <= 0) return resolve();
            entry.delete();
            excess -= 1;
            entry.continue();
          };
          cursor.onerror = () => reject(cursor.error);
        });
      }
      await done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* already aborted */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  /** 按时间倒序查询日志；过滤在游标内完成，避免把全部记录读进内存 */
  async listOperations(
    query: PluginOperationQuery = {},
  ): Promise<PluginOperationRecord[]> {
    const requested = Number(query.limit ?? 100);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), 200)
      : 100;
    const db = await this.open(),
      tx = db.transaction('operations', 'readonly'),
      done = completed(tx);
    const records: PluginOperationRecord[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const cursor = tx
          .objectStore('operations')
          .index('at')
          .openCursor(null, 'prev');
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry || records.length >= limit) return resolve();
          const record = entry.value as PluginOperationRecord;
          if (
            (!query.pluginKey || record.pluginKey === query.pluginKey) &&
            (!query.action || record.action === query.action) &&
            (!query.status || record.status === query.status)
          )
            records.push(record);
          entry.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
      await done;
      return records;
    } catch (error) {
      await done.catch(() => undefined);
      throw error;
    }
  }

  async clearOperations(): Promise<void> {
    const db = await this.open(),
      tx = db.transaction('operations', 'readwrite'),
      done = completed(tx);
    try {
      tx.objectStore('operations').clear();
      await done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* already aborted */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }
}

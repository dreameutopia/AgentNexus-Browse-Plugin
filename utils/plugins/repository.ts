import {
  invariant,
  LIMITS,
  type PluginSnapshot,
  type InstalledPlugin,
} from './contracts';

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
    return (this.database ??= new Promise((resolve, reject) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('state');
        const releases = r.result.createObjectStore('releases', {
          keyPath: 'id',
        });
        releases.createIndex('plugin', 'key');
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
    }));
  }
  async read(): Promise<PluginState> {
    const db = await this.open(),
      tx = db.transaction('state', 'readonly'),
      done = completed(tx);
    const state = await request<PluginState | undefined>(
      tx.objectStore('state').get('active'),
    );
    await done;
    return state ?? emptyState();
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
    return { state: state ?? emptyState(), releases };
  }
  async restore(
    expected: number,
    packages: InstalledPlugin[],
    records: ReleaseRecord[],
  ): Promise<PluginState> {
    invariant(
      new TextEncoder().encode(JSON.stringify(packages)).length <=
        LIMITS.snapshot,
      'CATALOG_SIZE_LIMIT',
    );
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
        packages,
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
    invariant(
      new TextEncoder().encode(JSON.stringify(packages)).length <=
        LIMITS.snapshot,
      'CATALOG_SIZE_LIMIT',
    );
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
        packages,
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
}

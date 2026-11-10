/**
 * Pyodide 文件缓存（IndexedDB · URL 寻址）
 *
 * 设计要点：
 * - 以「下载 URL」为主键缓存二进制（wasm / stdlib / wheel / 锁文件 JSON），
 *   运行时经 fetch 拦截层按同一 URL 命中，二次使用零网络；
 * - 与 chrome.storage 的分工：本库只存不可变的二进制载荷，轻量状态
 *   （是否就绪、已装包列表等）走 chrome.storage.local（见 pyodide-env）；
 * - 并发去重：打开数据库与写入均做 single-flight，避免多调用竞态；
 * - 多上下文安全：sidepanel / hub 打开同一数据库；onversionchange 仅让位
 *   （当前只有 v1，无升级路径；未来升版需按 notes-database 的方式处理）。
 */

/** 缓存文件条目（data 为原始字节） */
export interface PyodideCacheEntry {
  url: string;
  data: ArrayBuffer;
  contentType: string;
  size: number;
  storedAt: number;
}

/** 元数据视图（枚举用，不含大体积 data） */
export interface PyodideCacheMeta {
  url: string;
  contentType: string;
  size: number;
  storedAt: number;
}

const DB_NAME = 'AgentNexusPyodideDB';
const DB_VERSION = 1;
const STORE = 'files';

/** 数据库打开 single-flight */
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前上下文没有 IndexedDB（仅扩展页可用）'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Python 缓存数据库被其他扩展页面阻塞，请关闭旧页面后重试'));
    };
    request.onupgradeneeded = () => {
      // v1：单 store，url 为主键
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'url' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      const current = dbPromise;
      const invalidate = () => { if (dbPromise === current) dbPromise = null; };
      // 其它上下文要求升版时静默让位（本层无升级路径，仅防止阻塞对方）
      db.onclose = invalidate;
      db.onversionchange = () => {
        invalidate();
        db.close();
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/** 在读写事务上执行请求并 await 完成（以事务 oncomplete 为落盘判定点） */
function runRequest<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    db =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error ?? new Error('事务中止'));
        tx.onerror = () => reject(tx.error ?? new Error('事务失败'));
      }),
  );
}

/** 按并发去重的待写任务（同 URL 只保留最后一次写入） */
const pendingPuts = new Map<string, Promise<void>>();

/** 写入/覆盖缓存条目 */
export function putFile(entry: PyodideCacheEntry): Promise<void> {
  const previous = pendingPuts.get(entry.url);
  const task = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
    runRequest('readwrite', store => store.put(entry)).then(() => undefined),
  );
  pendingPuts.set(entry.url, task);
  const clearPending = () => {
    if (pendingPuts.get(entry.url) === task) pendingPuts.delete(entry.url);
  };
  void task.then(clearPending, clearPending);
  return task;
}

/** 读取缓存条目（无则 null） */
export async function getFile(url: string): Promise<PyodideCacheEntry | null> {
  try {
    const entry = await runRequest<PyodideCacheEntry | undefined>('readonly', store => store.get(url));
    return entry ?? null;
  } catch {
    // 读失败按未命中处理（调用方回落网络），不让缓存故障阻塞加载
    return null;
  }
}

/** 批量判断哪些 URL 已缓存（进度页跳过已完成文件用） */
export async function hasFiles(urls: readonly string[]): Promise<Set<string>> {
  const result = new Set<string>();
  await Promise.all(
    urls.map(async url => {
      if (await getFile(url)) result.add(url);
    }),
  );
  return result;
}

/** 删除单条缓存 */
export function deleteFile(url: string): Promise<void> {
  return runRequest('readwrite', store => store.delete(url)).then(() => undefined);
}

/** 清空全部缓存（彻底卸载环境用） */
export function clearFiles(): Promise<void> {
  return runRequest('readwrite', store => store.clear()).then(() => undefined);
}

/** 枚举缓存元数据（不搬运二进制数据） */
export async function listFileMeta(): Promise<PyodideCacheMeta[]> {
  const db = await openDb();
  return new Promise<PyodideCacheMeta[]>((resolve, reject) => {
    const metas: PyodideCacheMeta[] = [];
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const value = cursor.value as PyodideCacheEntry;
      metas.push({ url: value.url, contentType: value.contentType, size: value.size, storedAt: value.storedAt });
      cursor.continue();
    };
    tx.oncomplete = () => resolve(metas);
    tx.onabort = () => reject(tx.error ?? new Error('枚举缓存事务中止'));
    tx.onerror = () => reject(tx.error ?? new Error('枚举缓存事务失败'));
  });
}

/** 缓存总字节数 */
export async function totalSize(): Promise<number> {
  const metas = await listFileMeta();
  return metas.reduce((sum, meta) => sum + meta.size, 0);
}

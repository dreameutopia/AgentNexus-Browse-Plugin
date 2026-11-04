// utils/download-database.ts

/** 数据库名（导出供备份 / 存储统计引擎定位同一份数据，避免键名漂移） */
export const CAPTURED_FILES_DB_NAME = 'CapturedFileDB';
/** 捕获文件表名（导出供备份引擎定位） */
export const CAPTURED_FILES_STORE = 'files';

const DB_NAME = CAPTURED_FILES_DB_NAME;
const STORE_NAME = CAPTURED_FILES_STORE;
const DB_VERSION = 1;

/** 捕获文件记录（导出供备份引擎复用其形状） */
export interface CapturedFileRecord {
  id: string;
  filename: string;
  sourcePageUrl: string;
  mimeType: string;
  size: number;
  capturedAt: number;
  blobData: Blob;
}

class DownloadDatabase {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(new Error('Failed to open IndexedDB.'));
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('filename', 'filename', { unique: false });
          store.createIndex('capturedAt', 'capturedAt', { unique: false });
        }
      };
    });
    // 模块加载即 open：若此处失败会产生「未处理的 Promise 拒绝」噪音。
    // 挂一个空 catch 消除噪音，真正的调用方 await 时仍会收到原始错误。
    void this.dbPromise.catch(() => undefined);
  }

  /**
   * 向数据库添加一个捕获的文件记录
   * @param fileData - 包含 Blob 和元数据的文件对象
   * @returns 文件的唯一ID
   */
  public async addFile(fileData: Omit<CapturedFileRecord, 'id' | 'size'> & { id?: string }): Promise<string> {
    const db = await this.dbPromise;
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    const id = fileData.id || crypto.randomUUID();
    const size = fileData.blobData.size;
    
    const record: CapturedFileRecord = { ...fileData, id, size };
    
    return new Promise((resolve, reject) => {
      const request = store.add(record);
      request.onsuccess = () => resolve(id);
      request.onerror = () => reject(new Error('Failed to add file to IndexedDB.'));
    });
  }

  /**
   * 获取所有已捕获文件的元数据列表（不包含大的 Blob 数据）
   * @returns 文件元数据数组
   */
  public async getFileList(): Promise<Omit<CapturedFileRecord, 'blobData'>[]> {
    const db = await this.dbPromise;
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const cursorRequest = store.openCursor();
    
    const results: Omit<CapturedFileRecord, 'blobData'>[] = [];

    return new Promise((resolve, reject) => {
      cursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const { blobData, ...metadata } = cursor.value;
          results.push(metadata);
          cursor.continue();
        } else {
          resolve(results.sort((a, b) => b.capturedAt - a.capturedAt)); // 按时间倒序排序
        }
      };
      cursorRequest.onerror = () => reject(new Error('Failed to read file list from IndexedDB.'));
    });
  }

  /**
   * 根据ID获取完整的文件记录（包含 Blob）
   * @param id - 文件ID
   * @returns 完整的文件记录
   */
  public async getFileById(id: string): Promise<CapturedFileRecord | undefined> {
    const db = await this.dbPromise;
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Failed to retrieve file by ID.'));
    });
  }

  /**
   * 清空所有文件数据
   * @returns 清理掉的文件数量
   */
  public async clearAllFiles(): Promise<number> {
    const db = await this.dbPromise;
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    const countRequest = store.count();
    const count = await new Promise<number>((resolve, reject) => {
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => reject(new Error("Failed to count items."));
    });

    return new Promise((resolve, reject) => {
        const clearRequest = store.clear();
        clearRequest.onsuccess = () => resolve(count);
        clearRequest.onerror = () => reject(new Error('Failed to clear object store.'));
    });
  }
  /**
   * 全部捕获文件（含 Blob 本体；备份 / 存储统计用）。
   * 读取失败抛错——绝不返回空数组冒充「没有捕获文件」。
   */
  public async getAllFiles(): Promise<CapturedFileRecord[]> {
    const db = await this.dbPromise;
    return new Promise<CapturedFileRecord[]>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => {
        const result = request.result as CapturedFileRecord[] | undefined;
        resolve(Array.isArray(result) ? result : []);
      };
      request.onerror = () => reject(new Error('Failed to read all files from IndexedDB.'));
    });
  }

  /**
   * 原子恢复：单事务内清空表并写入给定记录（保留原始 id / 时间戳）。
   *
   * 事务失败即整体不落库（备份契约的分区原子性硬要求）；整表替换语义。
   */
  public async restoreFiles(files: readonly CapturedFileRecord[]): Promise<void> {
    const db = await this.dbPromise;
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const clearRequest = store.clear();
      clearRequest.onsuccess = () => {
        for (const file of files) store.put(file);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Failed to restore captured files.'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Restore transaction aborted.'));
    });
  }
}

// 导出一个单例，供 background.ts 使用
export const downloadDB = new DownloadDatabase();
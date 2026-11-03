// utils/download-database.ts

const DB_NAME = 'CapturedFileDB';
const STORE_NAME = 'files';
const DB_VERSION = 1;

interface CapturedFileRecord {
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
}

// 导出一个单例，供 background.ts 使用
export const downloadDB = new DownloadDatabase();
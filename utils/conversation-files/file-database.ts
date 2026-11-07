/**
 * 会话上传文件数据库（IndexedDB：AgentNexusFileDB）
 *
 * 用户上传文件（文本 / Office 解析产物）的**唯一持久化层**，与会话转录库
 * （AgentNexusChatDB）、图片库（AgentNexusImageDB）、笔记库（AgentNexusNotesDB）
 * 完全分离，职责单一：
 *   - 主键 = 8 位文件短 id（Crockford base32，全插件唯一），模型在
 *     <upload_file> 信封与 read_file 调用中都用它引用文件——可读、可复述；
 *   - 会话归属（chatId 索引）：文件随会话隔离，删除会话时级联清理
 *     （session-deletion-engine 调用 deleteByChat）；
 *   - 正文只存**提取后的纯文本**（Office 已解析），不存原始二进制——
 *     read_file 分页读取的就是这份文本，分页边界由 skill-pagination 的
 *     确定性算法从文本现算（页码口径与信封内预览严格一致）；
 *   - 记录不可变：注册后正文与页数不再变更（同名文件再次上传会得到新的
 *     id 与新记录），因此信封内缓存的第 1 页永不失配。
 *
 * 连接管理语义与 image-database 同构：单飞 open / onclose 重开 /
 * onversionchange 让位 / onblocked 告警；写失败抛错由上层降级。
 */

/** 已注册上传文件的完整记录（keyPath: id） */
export interface StoredConversationFile {
  /** 8 位文件短 id（主键；Crockford base32，全插件唯一） */
  id: string;
  /** 归属会话 id（删除会话时级联清理） */
  chatId: string;
  /** 用户可见的原始文件名 */
  name: string;
  /** 小写扩展名（无扩展名为空串；file_type 的数据来源） */
  ext: string;
  /** 提取形态：plain = 纯文本解码；office = OOXML 本地解析产物 */
  source: 'plain' | 'office';
  /** 原始文件 MIME（可能为空串，仅元信息） */
  mimeType: string;
  /** 原始文件体积（字节，展示用） */
  sizeBytes: number;
  /** 提取文本的码点总数（与分页算法同一计数口径） */
  charCount: number;
  /**
   * 全文按 FILE_PAGE_TOKEN_BUDGET 分页的总页数。
   * 分页是确定性的（同文本恒同页），此值是注册时一次算出的缓存，
   * 读取路径始终从正文现算页边界——缓存与现算不可能漂移。
   */
  totalPages: number;
  /** 注册时间（毫秒时间戳） */
  createdAt: number;
  /** 提取后的完整纯文本（注册后不可变） */
  text: string;
}

/** 数据库名（导出供存储统计 / 备份引擎定位同一份数据，避免键名漂移） */
export const FILE_DB_NAME = 'AgentNexusFileDB';
/** 文件表名（导出供备份引擎定位） */
export const FILE_STORE_NAME = 'files';

const DB_NAME = FILE_DB_NAME;
const DB_VERSION = 1;
const FILES_STORE = FILE_STORE_NAME;
/** 会话归属索引（非唯一：一个会话可注册多个文件） */
const CHAT_ID_INDEX = 'chatId';

class FileDatabase {
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;

  // ──── 连接管理（语义同 ImageDatabase：单飞 / 断连重开 / 升级让位） ────

  private open(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    if (this.opening) return this.opening;

    this.opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => {
        this.opening = null;
        console.error('[FileDatabase] 打开失败:', request.error);
        reject(request.error);
      };
      request.onblocked = () => {
        console.warn('[FileDatabase] 打开被其他标签页阻塞（版本升级中）');
      };
      request.onsuccess = () => {
        this.db = request.result;
        this.db.onclose = () => {
          this.db = null;
          this.opening = null;
        };
        this.db.onversionchange = () => {
          console.warn('[FileDatabase] 检测到其他上下文升级数据库，当前连接主动断开');
          try {
            this.db?.close();
          } catch {
            /* 连接可能已关闭 */
          }
          this.db = null;
          this.opening = null;
        };
        resolve(this.db);
      };
      request.onupgradeneeded = event => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(FILES_STORE)) {
          const store = db.createObjectStore(FILES_STORE, { keyPath: 'id' });
          store.createIndex(CHAT_ID_INDEX, 'chatId', { unique: false });
        }
      };
    });
    return this.opening;
  }

  private async tx<T>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(stores, mode);
      let result: T;
      transaction.onabort = () => reject(transaction.error ?? new Error('事务中断'));
      transaction.onerror = event => {
        // 请求级错误优先（ConstraintError 等约束错误挂在请求上，见 image-database 同款说明）
        const requestError = (event.target as IDBRequest | null)?.error ?? null;
        reject(requestError ?? transaction.error ?? new Error('事务失败'));
      };
      transaction.oncomplete = () => resolve(result);
      Promise.resolve(work(transaction)).then(
        value => {
          result = value;
        },
        error => {
          try {
            transaction.abort();
          } catch {
            /* 事务可能已结束 */
          }
          reject(error);
        },
      );
    });
  }

  private static requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ──── CRUD ────

  /**
   * 新增注册（add 语义：主键已存在时抛 ConstraintError——
   * 短 id 撞车必须显式失败换候选重试，绝不能静默覆盖既有文件记录）。
   */
  async add(record: StoredConversationFile): Promise<void> {
    await this.tx([FILES_STORE], 'readwrite', tx => {
      tx.objectStore(FILES_STORE).add(record);
    });
  }

  async get(id: string): Promise<StoredConversationFile | null> {
    const db = await this.open();
    const tx = db.transaction([FILES_STORE], 'readonly');
    const result = (await FileDatabase.requestToPromise(
      tx.objectStore(FILES_STORE).get(id),
    )) as StoredConversationFile | undefined;
    return result ?? null;
  }

  /** 按会话列出全部文件（按注册时间升序，信封与自纠清单的稳定顺序） */
  async listByChat(chatId: string): Promise<StoredConversationFile[]> {
    const db = await this.open();
    const tx = db.transaction([FILES_STORE], 'readonly');
    const index = tx.objectStore(FILES_STORE).index(CHAT_ID_INDEX);
    const result = (await FileDatabase.requestToPromise(
      index.getAll(chatId),
    )) as StoredConversationFile[];
    return (Array.isArray(result) ? result : []).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 删除单个文件（存在返回 true） */
  async delete(id: string): Promise<boolean> {
    return this.tx([FILES_STORE], 'readwrite', async tx => {
      const store = tx.objectStore(FILES_STORE);
      const existed = await FileDatabase.requestToPromise(store.getKey(id));
      if (existed === undefined) return false;
      store.delete(id);
      return true;
    });
  }

  /** 删除一个会话的全部文件（级联清理；返回实际删除条数） */
  async deleteByChat(chatId: string): Promise<number> {
    return this.tx([FILES_STORE], 'readwrite', async tx => {
      const store = tx.objectStore(FILES_STORE);
      const index = store.index(CHAT_ID_INDEX);
      const keys = (await FileDatabase.requestToPromise(
        index.getAllKeys(chatId),
      )) as IDBValidKey[];
      const list = Array.isArray(keys) ? keys : [];
      for (const key of list) store.delete(key);
      return list.length;
    });
  }

  /** 文件总数（统计用） */
  async count(): Promise<number> {
    const db = await this.open();
    const tx = db.transaction([FILES_STORE], 'readonly');
    return FileDatabase.requestToPromise(tx.objectStore(FILES_STORE).count());
  }

  /** 清空全部文件（危险操作，仅供级联清理 / 测试） */
  async clear(): Promise<void> {
    await this.tx([FILES_STORE], 'readwrite', tx => {
      tx.objectStore(FILES_STORE).clear();
    });
  }
}

/** 全局单例 */
export const fileDatabase = new FileDatabase();

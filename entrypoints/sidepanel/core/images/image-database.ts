/**
 * 图片数据库（IndexedDB：AgentNexusImageDB）
 *
 * 图片的**唯一持久化层**，与会话转录库（AgentNexusChatDB）完全分离：
 *   - 会话消息只存内容哈希引用（imageRefs），绝不内联二进制——转录库保持
 *     「纯文本 + 结构」的小体积形态，跨库职责单一；
 *   - 以内容寻址（content-addressable）：主键 = 图片字节的 SHA-256，
 *     同一张图片（重复截图 / 同一图片多处引用）全库仅存一份，天然去重；
 *   - 谁引用谁负责清理：删除由会话删除引擎按「仍被消息引用」判定后回收
 *     （引用计数以转录库的 byImageRef 索引为权威，不在本库维护第二份计数，
 *     避免跨库双计数漂移——与 messageCount 的「单事务原子维护」同一哲学）。
 *
 * 容量：IndexedDB 无固定上限（受磁盘配额约束）；Blob 以结构化克隆原生存取，
 * 不经 base64 文本中转（存储体积 = 图片真实字节，而非 1.37 倍编码膨胀）。
 * 所有 API 幂等初始化（首次调用自动 open），写失败抛错由上层降级。
 */

/** 已入库图片的元信息 + 二进制本体（keyPath: hash） */
export interface StoredImage {
  /** 内容哈希（SHA-256 hex，主键 = 内容寻址去重键） */
  hash: string;
  /** 图片二进制（结构化克隆存储；不落 JSON，不经 base64） */
  blob: Blob;
  /** MIME（image/png 等；展示与下载文件名推导用） */
  mime: string;
  /** 字节体积（统计与配额评估用） */
  byteSize: number;
  /** 入库时间（毫秒时间戳；孤儿回收的宽限期判定依据） */
  createdAt: number;
  /**
   * 8 位资源短 id（插件内唯一）。
   *
   * 回答里引用截图时用短 id 而非 64 位内容哈希——模型可读、可复述、
   * 用户也看得懂。唯一性由 images 表上的 shortId 唯一索引在存储层保证
   * （冲突时写入方换 id 重试），因此短 id 在整个插件内不会撞车。
   */
  shortId?: string;
}

/** 数据库名（导出供备份 / 存储统计引擎定位同一份数据，避免键名漂移） */
export const IMAGE_DB_NAME = 'AgentNexusImageDB';
/** 图片表名（导出供备份引擎定位） */
export const IMAGE_STORE_NAME = 'images';

const DB_NAME = IMAGE_DB_NAME;
const DB_VERSION = 2;
const IMAGES_STORE = IMAGE_STORE_NAME;
/** 短 id 唯一索引名（回答中引用截图的查找入口） */
const SHORT_ID_INDEX = 'shortId';

class ImageDatabase {
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;

  // ──── 连接管理（语义同 ChatDatabase：单飞 / 断连重开 / 版本升级让位） ────

  private open(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    if (this.opening) return this.opening;

    this.opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => {
        this.opening = null;
        console.error('[ImageDatabase] 打开失败:', request.error);
        reject(request.error);
      };
      request.onblocked = () => {
        console.warn('[ImageDatabase] 打开被其他标签页阻塞（版本升级中）');
      };
      request.onsuccess = () => {
        this.db = request.result;
        this.db.onclose = () => {
          this.db = null;
          this.opening = null;
        };
        this.db.onversionchange = () => {
          console.warn('[ImageDatabase] 检测到其他上下文升级数据库，当前连接主动断开');
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
        const upgradeTx = (event.target as IDBOpenDBRequest).transaction!;
        let store: IDBObjectStore;
        if (!db.objectStoreNames.contains(IMAGES_STORE)) {
          store = db.createObjectStore(IMAGES_STORE, { keyPath: 'hash' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        } else {
          // 既有库升级：索引只能在升级事务里建，且必须用事务取 store
          store = upgradeTx.objectStore(IMAGES_STORE);
        }
        // 短 id 唯一索引：插件内唯一性由存储层兜底（写入冲突 → 调用方换 id 重试）
        if (!store.indexNames.contains(SHORT_ID_INDEX)) {
          store.createIndex(SHORT_ID_INDEX, 'shortId', { unique: true });
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
        // 请求级错误优先：唯一索引冲突一类的约束错误，其 DOMException 挂在
        // 请求上，而 transaction.error 在事务真正中止前仍为 null——只取后者
        // 会把 ConstraintError 变成无信息的「事务失败」，调用方
        // （短 id 分配的换 id 重试）将无法识别并重试。
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

  /** 幂等写入（同 hash 覆盖为同内容；内容寻址下重复写入是无害 no-op） */
  async put(record: StoredImage): Promise<void> {
    await this.tx([IMAGES_STORE], 'readwrite', tx => {
      tx.objectStore(IMAGES_STORE).put(record);
    });
  }

  async get(hash: string): Promise<StoredImage | null> {
    const db = await this.open();
    const tx = db.transaction([IMAGES_STORE], 'readonly');
    const result = (await ImageDatabase.requestToPromise(
      tx.objectStore(IMAGES_STORE).get(hash),
    )) as StoredImage | undefined;
    return result ?? null;
  }

  /**
   * 按短 id 取图（唯一索引命中）。
   * 回答中引用截图时由渲染层调用：短 id → 记录 → object URL。
   * 不存在返回 null（图片已被回收或 id 非法）。
   */
  async getByShortId(shortId: string): Promise<StoredImage | null> {
    if (!shortId) return null;
    const db = await this.open();
    const tx = db.transaction([IMAGES_STORE], 'readonly');
    const index = tx.objectStore(IMAGES_STORE).index(SHORT_ID_INDEX);
    const result = (await ImageDatabase.requestToPromise(
      index.get(shortId),
    )) as StoredImage | undefined;
    return result ?? null;
  }

  /** 批量删除；返回实际删除条数（幂等：不存在的 hash 不计数） */
  async deleteMany(hashes: readonly string[]): Promise<number> {
    if (hashes.length === 0) return 0;
    return this.tx([IMAGES_STORE], 'readwrite', async tx => {
      const store = tx.objectStore(IMAGES_STORE);
      let deleted = 0;
      for (const hash of hashes) {
        const existed = await ImageDatabase.requestToPromise(store.getKey(hash));
        if (existed !== undefined) {
          store.delete(hash);
          deleted += 1;
        }
      }
      return deleted;
    });
  }

  /** 全部图片哈希（孤儿回收 / 统计用） */
  async listHashes(): Promise<string[]> {
    const db = await this.open();
    const tx = db.transaction([IMAGES_STORE], 'readonly');
    const request = tx.objectStore(IMAGES_STORE).getAllKeys();
    const keys = await ImageDatabase.requestToPromise(request);
    return keys.filter((key): key is string => typeof key === 'string');
  }

  /** 图片总数（统计用） */
  async count(): Promise<number> {
    const db = await this.open();
    const tx = db.transaction([IMAGES_STORE], 'readonly');
    return ImageDatabase.requestToPromise(tx.objectStore(IMAGES_STORE).count());
  }

  /** 清空全部图片（危险操作，仅供级联清理） */
  async clear(): Promise<void> {
    await this.tx([IMAGES_STORE], 'readwrite', tx => {
      tx.objectStore(IMAGES_STORE).clear();
    });
  }

  /**
   * 全部图片记录（备份 / 存储统计用）。
   * 读取失败抛错——绝不返回空数组冒充「没有图片」（会让统计缺数且无告警）。
   */
  async listAll(): Promise<StoredImage[]> {
    const db = await this.open();
    const tx = db.transaction([IMAGES_STORE], 'readonly');
    const result = await ImageDatabase.requestToPromise(
      tx.objectStore(IMAGES_STORE).getAll() as IDBRequest<StoredImage[]>,
    );
    return Array.isArray(result) ? result : [];
  }

  /**
   * 原子恢复：单事务内清空图片表并写入给定记录。
   *
   * 事务失败即整体不落库（备份契约的分区原子性硬要求）。
   * 整表替换语义：备份即权威。
   */
  async restoreAll(records: readonly StoredImage[]): Promise<void> {
    await this.tx([IMAGES_STORE], 'readwrite', tx => {
      const store = tx.objectStore(IMAGES_STORE);
      store.clear();
      for (const record of records) store.put(record);
    });
  }
}

/** 全局单例 */
export const imageDatabase = new ImageDatabase();

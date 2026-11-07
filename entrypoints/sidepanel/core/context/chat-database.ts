/**
 * 会话数据库（IndexedDB：AgentNexusChatDB）
 *
 * 用户面转录的唯一持久化层。与统一笔记库（utils/notes-database，AgentNexusNotesDB）同模式，但：
 *   - sessions / messages 两个 store，[chatId, seq] 复合索引支持按会话分页
 *   - 删除会话在同一事务内级联删除消息（图片等关联回收由会话删除引擎统一判定）
 *   - 消息仅持有图片引用（imageRefs，内容哈希），图片二进制存于独立图片库
 *     （core/images/image-database），本库绝不内联二进制
 *   - 所有 API 幂等初始化（首次调用自动 open），写失败抛错由上层降级
 * 容量：IndexedDB 无固定上限（受磁盘配额约束），满足「无长度限制」要求。
 */

import type { ChatMessageRecord, ChatSessionMeta } from '../types';
import { normalizeImageRefs } from '../images/image-store';
import { protocolImageRefs } from './protocol-history';

/** 数据库名（导出供备份 / 存储统计引擎定位同一份数据，避免键名漂移） */
export const CHAT_DB_NAME = 'AgentNexusChatDB';
/** 会话表名（导出供备份引擎定位） */
export const CHAT_SESSIONS_STORE = 'sessions';
/** 消息表名（导出供备份引擎定位） */
export const CHAT_MESSAGES_STORE = 'messages';

/** v2：messages 增加 byImageRef（multiEntry）索引——按图片引用统计引用方 / 回收判定 */
const DB_VERSION = 2;
const DB_NAME = CHAT_DB_NAME;
const SESSIONS_STORE = CHAT_SESSIONS_STORE;
const MESSAGES_STORE = CHAT_MESSAGES_STORE;
/** 列表页标题/预览截断 */
const PREVIEW_MAX_CHARS = 80;

export interface SessionListOptions {
  /** 最多返回多少条（默认 50） */
  limit?: number;
  /** 跳过多少条（按 updatedAt 倒序） */
  offset?: number;
}

export interface MessagesPage {
  records: ChatMessageRecord[];
  /** 是否还有更早的消息 */
  hasMore: boolean;
}

/**
 * 消息字段补丁合并（纯函数，无 IO；导出供单测，patchMessage 内部复用）。
 *
 * 语义约定：
 *   - patch 中显式为 undefined 的键 = **删除该字段**（反馈清除等场景），
 *     而非「不修改」——调用方不传该键即可保留原值；
 *   - id / chatId / seq 是记录身份与排序键，强制保持原值，patch 试图改动被忽略；
 *   - updatedAt 由本函数统一推进（now 可注入，供测试确定性断言）。
 *
 * 不可变性：返回全新对象，入参 existing 不被改动（浅拷贝——嵌套结构共享引用
 * 无妨，调用方随即 put 整条结构化克隆入库，从不原地改写入参）。
 */
export function mergeMessagePatch(
  existing: ChatMessageRecord,
  patch: Partial<ChatMessageRecord>,
  now: number = Date.now(),
): ChatMessageRecord {
  const merged: ChatMessageRecord = {
    ...existing,
    ...patch,
    id: existing.id,
    chatId: existing.chatId,
    seq: existing.seq,
    updatedAt: now,
  };
  // 显式 undefined = 删键（结构化克隆会保留 undefined 值的键，收敛为真正无键）
  const mutable = merged as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete mutable[key];
  }
  return merged;
}

class ChatDatabase {
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;

  // ──── 连接管理 ────

  private open(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    if (this.opening) return this.opening;

    this.opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => {
        this.opening = null;
        console.error('[ChatDatabase] 打开失败:', request.error);
        reject(request.error);
      };
      request.onblocked = () => {
        console.warn('[ChatDatabase] 打开被其他标签页阻塞（版本升级中）');
      };
      request.onsuccess = () => {
        this.db = request.result;
        // 连接被其他上下文强制关闭（如版本升级）时允许重新打开
        this.db.onclose = () => {
          this.db = null;
          this.opening = null;
        };
        // 其他上下文请求升级版本时主动让位，避免阻塞对方升级（本连接置空后按需重连）
        this.db.onversionchange = () => {
          console.warn('[ChatDatabase] 检测到其他上下文升级数据库，当前连接主动断开');
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
        if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
          const sessions = db.createObjectStore(SESSIONS_STORE, { keyPath: 'chatId' });
          sessions.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
          const messages = db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
          messages.createIndex('byChatSeq', ['chatId', 'seq'], { unique: true });
          messages.createIndex('chatId', 'chatId', { unique: false });
          messages.createIndex('byImageRef', 'imageRefs', { unique: false, multiEntry: true });
        } else {
          // v1 → v2 升级：为既有 messages store 补建图片引用索引
          //（multiEntry：一条消息引用 N 张图即产生 N 个索引项；无 imageRefs 的旧记录不产生项）
          const upgradeTx = (event.target as IDBOpenDBRequest).transaction;
          const existing = upgradeTx?.objectStore(MESSAGES_STORE);
          if (existing && !existing.indexNames.contains('byImageRef')) {
            existing.createIndex('byImageRef', 'imageRefs', { unique: false, multiEntry: true });
          }
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
      const tx = db.transaction(stores, mode);
      let result: T;
      tx.onabort = () => reject(tx.error ?? new Error('事务中断'));
      tx.onerror = () => reject(tx.error ?? new Error('事务失败'));
      tx.oncomplete = () => resolve(result);
      Promise.resolve(work(tx)).then(
        value => {
          result = value;
        },
        error => {
          try {
            tx.abort();
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

  // ──── 会话 ────

  async createSession(meta: ChatSessionMeta): Promise<ChatSessionMeta> {
    await this.tx([SESSIONS_STORE], 'readwrite', tx => {
      tx.objectStore(SESSIONS_STORE).put(meta);
    });
    return meta;
  }

  /** 局部更新（同一事务内读-改-写，避免并发覆盖） */
  async patchSession(
    chatId: string,
    patch: Partial<Omit<ChatSessionMeta, 'chatId'>>,
  ): Promise<ChatSessionMeta | null> {
    return this.tx([SESSIONS_STORE], 'readwrite', async tx => {
      const store = tx.objectStore(SESSIONS_STORE);
      const existing = (await ChatDatabase.requestToPromise(store.get(chatId))) as
        | ChatSessionMeta
        | undefined;
      if (!existing) return null;
      const updated: ChatSessionMeta = { ...existing, ...patch, chatId };
      store.put(updated);
      return updated;
    });
  }

  async getSession(chatId: string): Promise<ChatSessionMeta | null> {
    const db = await this.open();
    const tx = db.transaction([SESSIONS_STORE], 'readonly');
    const result = (await ChatDatabase.requestToPromise(
      tx.objectStore(SESSIONS_STORE).get(chatId),
    )) as ChatSessionMeta | undefined;
    return result ?? null;
  }

  /** 按 updatedAt 倒序列出会话 */
  async listSessions(options: SessionListOptions = {}): Promise<ChatSessionMeta[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const db = await this.open();

    return new Promise((resolve, reject) => {
      const tx = db.transaction([SESSIONS_STORE], 'readonly');
      const index = tx.objectStore(SESSIONS_STORE).index('updatedAt');
      const request = index.openCursor(null, 'prev');
      const items: ChatSessionMeta[] = [];
      let skipped = 0;

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || items.length >= limit) {
          resolve(items);
          return;
        }
        if (skipped < offset) {
          skipped++;
        } else {
          items.push(cursor.value as ChatSessionMeta);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  /** 删除会话并级联删除其全部消息（同一事务；游标限定在该会话范围内，避免全库扫描） */
  async deleteSession(chatId: string): Promise<void> {
    await this.tx([SESSIONS_STORE, MESSAGES_STORE], 'readwrite', async tx => {
      tx.objectStore(SESSIONS_STORE).delete(chatId);
      const index = tx.objectStore(MESSAGES_STORE).index('chatId');
      const cursorRequest = index.openCursor(IDBKeyRange.only(chatId));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if ((cursor.value as ChatMessageRecord).chatId === chatId) {
          cursor.delete();
        }
        cursor.continue();
      };
    });
  }

  // ──── 消息 ────

  /**
   * 写入消息，并在**同一事务内**维护会话的冗余计数（messageCount）。
   *
   * 幂等语义（exactly-once 计数）：
   *   - 会话不存在 → 不写入任何内容（返回 skipped），避免产生无会话元信息的孤儿记录；
   *   - 消息 id 已存在（流式快照重复写入）→ 仅更新内容，计数不变；
   *   - 消息 id 首次出现 → 写入消息并令计数 +1。
   *
   * 计数与消息集合在同一 readwrite 事务内变更，因此并发写入、重复快照、
   * 进程中断都不会让计数与真实消息数漂移；计数口径与会话列表展示强相关，
   * 一旦漂移会直接误导用户对会话规模的判断。
   */
  async saveMessage(record: ChatMessageRecord): Promise<{ inserted: boolean; skipped: boolean }> {
    // 存储边界归一：图片引用去重/形态校验/上限收敛（防御外部写入与运行期
    // 直改 record.imageRefs 的脏数据）；其余字段原样落库。
    // uploadImageRefs（用户上传子集）同样收敛，并防御性收敛为 imageRefs 的
    // 子集——脏数据/异构备份里游离的引用按静默剔除处理（展示口径不得超出
    // GC 引用集合，否则气泡会展示已被回收的图片）
    const mergedImageRefs = [...new Set([
      ...normalizeImageRefs(record.imageRefs), ...protocolImageRefs(record.modelMessages), ...protocolImageRefs(record.modelContext),
    ])];
    const normalized: ChatMessageRecord = { ...record, imageRefs: mergedImageRefs,
      ...(record.uploadImageRefs !== undefined ? { uploadImageRefs: [...new Set(normalizeImageRefs(record.uploadImageRefs))]
        .filter(ref => mergedImageRefs.includes(ref)) } : {}) };
    return this.tx([MESSAGES_STORE, SESSIONS_STORE], 'readwrite', async tx => {
      const sessions = tx.objectStore(SESSIONS_STORE);
      const session = (await ChatDatabase.requestToPromise(sessions.get(normalized.chatId))) as
        | ChatSessionMeta
        | undefined;
      // 会话已被删除（运行中在历史抽屉删除）→ 丢弃本次写入
      if (!session) {
        return { inserted: false, skipped: true };
      }

      const messages = tx.objectStore(MESSAGES_STORE);
      const existing = await ChatDatabase.requestToPromise(messages.get(normalized.id));
      messages.put(normalized);
      if (existing !== undefined) {
        return { inserted: false, skipped: false };
      }

      sessions.put({
        ...session,
        messageCount: (session.messageCount ?? 0) + 1,
        updatedAt: Date.now(),
      });
      return { inserted: true, skipped: false };
    });
  }

  async getMessage(messageId: string): Promise<ChatMessageRecord | null> {
    const db = await this.open();
    const tx = db.transaction([MESSAGES_STORE], 'readonly');
    const result = (await ChatDatabase.requestToPromise(
      tx.objectStore(MESSAGES_STORE).get(messageId),
    )) as ChatMessageRecord | undefined;
    return result ?? null;
  }

  /**
   * 字段级局部更新单条消息（同一事务内读-改-写，与 patchSession 同模式）。
   * 合并语义见 mergeMessagePatch（纯函数，导出供单测）。
   * 返回更新后的记录；消息不存在返回 null（不抛错，调用方按未命中处理）。
   *
   * 相比「读整条记录 → 改 → saveMessage 整条回写」：本方法把读-改-写收敛在
   * 单个事务内，不会与并发的流式快照 flush 互相覆盖各自未提交的字段。
   * 与会话删除（deleteSession 同事务级联）并发时，IndexedDB 对同 store 的
   * readwrite 事务按创建顺序串行执行——本方法要么在删除前写入（随删），
   * 要么读到 undefined 返回 null，绝不会产生孤儿记录。
   */
  async patchMessage(
    messageId: string,
    patch: Partial<ChatMessageRecord>,
  ): Promise<ChatMessageRecord | null> {
    return this.tx([MESSAGES_STORE], 'readwrite', async tx => {
      const store = tx.objectStore(MESSAGES_STORE);
      const existing = (await ChatDatabase.requestToPromise(store.get(messageId))) as
        | ChatMessageRecord
        | undefined;
      if (!existing) return null;
      const updated = mergeMessagePatch(existing, patch);
      store.put(updated);
      return updated;
    });
  }

  /**
   * 按 seq 升序取某会话的消息页。
   * beforeSeq 提供「向上翻页」游标（返回紧邻其前的 limit 条）；缺省取最新一页。
   * 实现采用降序游标：从最新端收集至 limit+1 条即停，避免全量加载整个会话，
   * 第 limit+1 条仅用于判定 hasMore，不进入返回值。
   */
  async getMessagesPage(
    chatId: string,
    options: { limit?: number; beforeSeq?: number } = {},
  ): Promise<MessagesPage> {
    const limit = options.limit ?? 50;
    const db = await this.open();

    return new Promise((resolve, reject) => {
      const tx = db.transaction([MESSAGES_STORE], 'readonly');
      const index = tx.objectStore(MESSAGES_STORE).index('byChatSeq');
      // 上界开区间：beforeSeq 本身不属于该页；缺省上界 +Infinity 即全范围
      const upper = options.beforeSeq !== undefined ? options.beforeSeq : Infinity;
      const range: IDBKeyRange = IDBKeyRange.bound(
        [chatId, -Infinity],
        [chatId, upper],
        false,
        true,
      );
      const request = index.openCursor(range, 'prev');
      const collected: ChatMessageRecord[] = [];
      let settled = false;
      const finish = (hasMore: boolean) => {
        if (settled) return;
        settled = true;
        // 收集时新 → 旧，返回前反转为升序
        resolve({ records: collected.slice().reverse(), hasMore });
      };

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          finish(false);
          return;
        }
        if (collected.length >= limit) {
          finish(true);
          return;
        }
        collected.push(cursor.value as ChatMessageRecord);
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('读取消息分页失败'));
    });
  }

  /**
   * 取某会话中 seq 大于 afterSeq 的全部消息（按 seq 升序）。
   *
   * 用途：会话被压缩后，模型面的有效上下文只由「压缩点之后的记录」构成。
   * 直接按 seq 下界查询可避免把整段历史读进内存再过滤——长会话下这是
   * 单次发送的主要内存开销来源（压缩恰恰发生在会话最长的时候）。
   */
  async getMessagesAfter(chatId: string, afterSeq: number): Promise<ChatMessageRecord[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([MESSAGES_STORE], 'readonly');
      const index = tx.objectStore(MESSAGES_STORE).index('byChatSeq');
      // 下界开区间（seq > afterSeq），上界闭区间（seq 无上界）
      const range = IDBKeyRange.bound([chatId, afterSeq], [chatId, Infinity], false, false);
      const request = index.openCursor(range, 'next');
      const collected: ChatMessageRecord[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(collected);
          return;
        }
        collected.push(cursor.value as ChatMessageRecord);
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('读取压缩点之后的消息失败'));
    });
  }

  /** 会话内最大 seq（空会话返回 0；transcript-engine 分配 seq 用） */
  async getMaxSeq(chatId: string): Promise<number> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([MESSAGES_STORE], 'readonly');
      const index = tx.objectStore(MESSAGES_STORE).index('byChatSeq');
      const range = IDBKeyRange.bound([chatId, -Infinity], [chatId, Infinity]);
      const request = index.openCursor(range, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        resolve(cursor ? (cursor.value as ChatMessageRecord).seq : 0);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 某会话全部消息引用过的图片哈希（去重）。
   * 用途：会话删除前采集「待判定回收」的图片集合（删除后逐个查引用计数）。
   */
  async getImageRefsOfChat(chatId: string): Promise<string[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([MESSAGES_STORE], 'readonly');
      const index = tx.objectStore(MESSAGES_STORE).index('chatId');
      const request = index.openCursor(IDBKeyRange.only(chatId));
      const refs = new Set<string>();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve([...refs]);
          return;
        }
        const record = cursor.value as ChatMessageRecord;
        for (const ref of [...normalizeImageRefs(record.imageRefs), ...protocolImageRefs(record.modelMessages), ...protocolImageRefs(record.modelContext)]) {
          refs.add(ref);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('读取会话图片引用失败'));
    });
  }

  /**
   * 仍引用某图片的消息条数（byImageRef multiEntry 索引计数）。
   * 0 = 该图片已无任何消息引用，可安全回收——引用计数的权威判据，
   * 由会话删除引擎在删除会话后调用（此时被删会话的记录已不在库内）。
   */
  async countMessagesReferencingImage(imageRef: string): Promise<number> {
    const db = await this.open();
    const tx = db.transaction([MESSAGES_STORE], 'readonly');
    const index = tx.objectStore(MESSAGES_STORE).index('byImageRef');
    return ChatDatabase.requestToPromise(index.count(IDBKeyRange.only(imageRef)));
  }

  // ──── 全量读取 / 原子恢复（备份引擎用） ────

  /**
   * 全部会话（备份 / 存储统计用；不受 listSessions 分页限制）。
   * 读取失败抛错——由调用方记入 issues，绝不静默返回空数组（把「读失败」
   * 伪装成「没有会话」会造成统计缺数，且无任何报错）。
   */
  async listAllSessions(): Promise<ChatSessionMeta[]> {
    const db = await this.open();
    return new Promise<ChatSessionMeta[]>((resolve, reject) => {
      const tx = db.transaction([CHAT_SESSIONS_STORE], 'readonly');
      const request = tx.objectStore(CHAT_SESSIONS_STORE).openCursor();
      const items: ChatSessionMeta[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(items);
          return;
        }
        items.push(cursor.value as ChatSessionMeta);
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('读取全部会话失败'));
    });
  }

  /**
   * 全部消息（备份 / 存储统计用；不受分页限制）。
   * 读取失败抛错——同 listAllSessions，绝不把失败伪装成空库。
   */
  async listAllMessages(): Promise<ChatMessageRecord[]> {
    const db = await this.open();
    return new Promise<ChatMessageRecord[]>((resolve, reject) => {
      const tx = db.transaction([CHAT_MESSAGES_STORE], 'readonly');
      const request = tx.objectStore(CHAT_MESSAGES_STORE).openCursor();
      const items: ChatMessageRecord[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(items);
          return;
        }
        items.push(cursor.value as ChatMessageRecord);
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('读取全部消息失败'));
    });
  }

  /**
   * 原子恢复：单事务内清空会话/消息表并写入给定数据。
   *
   * 原子性是备份契约的硬要求——事务失败即整体不落库，绝不出现「会话写了、
   * 消息没写」的半截状态。整表替换语义（replace）：备份即权威，本机旧数据
   * 不保留；需要「保留本机」语义时由调用方走 fill 策略（整分区跳过）。
   *
   * 唯一索引 byChatSeq 保证重复 (chatId, seq) 会在事务内触发约束错误 →
   * 事务中止 → 数据整体不变（有意为之：备份数据自相矛盾时必须失败而非静默覆盖）。
   */
  async restoreSessions(
    sessions: readonly ChatSessionMeta[],
    messages: readonly ChatMessageRecord[],
  ): Promise<void> {
    await this.tx([CHAT_SESSIONS_STORE, CHAT_MESSAGES_STORE], 'readwrite', tx => {
      const sessionStore = tx.objectStore(CHAT_SESSIONS_STORE);
      const messageStore = tx.objectStore(CHAT_MESSAGES_STORE);
      sessionStore.clear();
      messageStore.clear();
      for (const meta of sessions) sessionStore.put(meta);
      for (const record of messages) {
        // 与 saveMessage 同一存储边界口径：imageRefs 并入协议引用、
        // uploadImageRefs 收敛为 imageRefs 子集（备份为外部数据，同样防御）
        const imageRefs = [...new Set([
          ...normalizeImageRefs(record.imageRefs), ...protocolImageRefs(record.modelMessages), ...protocolImageRefs(record.modelContext),
        ])];
        messageStore.put({ ...record, imageRefs,
          ...(record.uploadImageRefs !== undefined ? { uploadImageRefs: [...new Set(normalizeImageRefs(record.uploadImageRefs))]
            .filter(ref => imageRefs.includes(ref)) } : {}) });
      }
    });
  }
}

/** 生成会话预览文本（模块级函数，供转录引擎复用） */
export function chatPreviewOf(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > PREVIEW_MAX_CHARS
    ? `${normalized.slice(0, PREVIEW_MAX_CHARS)}…`
    : normalized;
}

/** 全局单例 */
export const chatDatabase = new ChatDatabase();

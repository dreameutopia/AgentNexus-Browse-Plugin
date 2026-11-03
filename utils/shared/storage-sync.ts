/**
 * 跨上下文存储同步通用件
 *
 * 模式（与 utils/i18n/core.ts 的语言同步同构）：
 *   - chrome.storage.local 为权威源：任一上下文写入后，其它上下文经
 *     chrome.storage.onChanged 收到通知并重建内存态；
 *   - 本上下文写入时记录值指纹，onChanged 回调里据此跳过自事件，
 *     避免本地双重刷新（onChanged 对写入方上下文同样触发）；
 *   - 约束： onChanged 处理器内绝不回写 chrome.storage，从结构上杜绝同步循环。
 *
 * localStorage 仅作为同源共享的同步读缓存（扩展页面同源共享），
 * 缓存刷新不经过 chrome.storage，同样不会形成循环。
 */

/** 值序列化（用于指纹比对；序列化失败时返回可区分的标记） */
function fingerprintOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return 'unserializable';
  }
}

/**
 * 本上下文最近写入的值指纹集合。
 *
 * 保存「最近若干次」写入指纹而非单值：连续两次快速写入（如重命名 = 新键写入 +
 * 旧键删除的两次持久化）时，第一次写入的 onChanged 事件可能在第二次指纹登记
 * 之后才到达——单值比对会把它误判为外部变更，触发一次"回到旧值"的重建。
 * 指纹带 TTL（默认 10 秒），过期自动清理，集合大小也有上限兜底。
 */
export class LocalWriteFingerprint {
  private static readonly TTL_MS = 10_000;
  private static readonly MAX_ENTRIES = 16;

  private recent = new Map<string, number /* 过期时间戳 */>();

  /** 本上下文发起写入前调用，登记即将写入的值 */
  mark(value: unknown): void {
    const now = Date.now();
    this.prune(now);
    this.recent.set(fingerprintOf(value), now + LocalWriteFingerprint.TTL_MS);
    // 上限兜底：极端高频写入时丢弃最旧指纹（Map 迭代序 = 插入序）
    while (this.recent.size > LocalWriteFingerprint.MAX_ENTRIES) {
      const oldest = this.recent.keys().next();
      if (oldest.done) break;
      this.recent.delete(oldest.value);
    }
  }

  /** 判断 onChanged 收到的值是否为本上下文近期写入的（自事件） */
  isOwn(value: unknown): boolean {
    const expiry = this.recent.get(fingerprintOf(value));
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.recent.delete(fingerprintOf(value));
      return false;
    }
    return true;
  }

  private prune(now: number): void {
    for (const [fingerprint, expiry] of this.recent) {
      if (now > expiry) this.recent.delete(fingerprint);
    }
  }
}

export interface CrossContextSubscription {
  /** 订阅 chrome.storage.local 中指定 key 的外部变更（自事件已被跳过） */
  (handler: (newValue: unknown) => void): () => void;
}

/**
 * 订阅指定 storage key 的跨上下文变更。
 * 仅监听 local 区域；key 不匹配或 chrome.storage 不可用时静默不订阅（返回空退订函数）。
 */
export function subscribeStorageKey(
  key: string,
  fingerprint: LocalWriteFingerprint,
  handler: (newValue: unknown) => void,
): () => void {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
    return () => undefined;
  }
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'local') return;
    const change = changes[key];
    if (change === undefined) return;
    const next = change.newValue;
    // 自事件跳过：本上下文写入后本地已同步过内存态
    if (fingerprint.isOwn(next)) return;
    try {
      handler(next);
    } catch (error) {
      console.warn(`[StorageSync] key="${key}" 变更处理失败:`, error);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * 请求持久化存储并输出用量概况（best-effort，幂等可重复调用）。
 *
 * 两层保障配合 manifest 的 "unlimitedStorage" 权限：
 *   - unlimitedStorage 解除 chrome.storage.local 的 10MB 配额（受磁盘配额约束）；
 *   - navigator.storage.persist() 将本源标记为持久存储，禁止浏览器在
 *     磁盘压力下自动逐出 IndexedDB（会话转录）与缓存数据。
 * 任何一步失败仅记录日志，不影响启动。
 */
export async function ensurePersistentStorage(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
    const granted = await navigator.storage.persist();
    if (typeof navigator.storage?.estimate === 'function') {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      const toMB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
      console.log(
        `[StorageSync] 持久化=${granted ? '已授予' : '未授予（跟随浏览器策略）'}，` +
          `用量 ${toMB(usage)} / 配额 ${toMB(quota)}`,
      );
    }
  } catch (error) {
    console.warn('[StorageSync] 持久化存储请求失败:', error);
  }
}

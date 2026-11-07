/**
 * 图片存储引擎（ImageStore）—— 图片的统一管理入口
 *
 * 职责：
 *   1. 内容寻址入库：data URL → 字节 → SHA-256 → 独立图片库（image-database）。
 *      同一内容恒得同一 hash，重复截图 / 同图多引用全库仅存一份（去重）；
 *   2. 短 id 分配：每条记录带一个 8 位资源短 id（插件内唯一，由存储层的
 *      唯一索引兜底），回答里用短 id 引用截图——模型可读、用户看得懂，
 *      且不把 64 位哈希塞进对话。同 hash 复用既有短 id（已发出的引用不能失效）；
 *   3. 引用解析：消息层只持有 hash 引用（imageRefs），本引擎负责
 *      hash → data URL（模型上下文用）、hash → object URL（UI 展示用）与
 *      短 id → hash/图片（回答内截图引用）的解析，
 *      上下文引擎与渲染层因此永远不接触二进制存储细节；
 *   4. 生命周期：按引用回收（由会话删除引擎判定「不再被任何消息引用」后调用
 *      deleteByHashes），同步撤销两层内存缓存与 object URL；
 *   5. 防御性：任意输入不抛错（坏 data URL → null 并告警）、缓存有界（LRU）、
 *      加密上下文缺失时回退 FNV-1a（去重键仍稳定，仅弱化抗碰撞性——
 *      本哈希只做去重与引用键，不承担安全职责）。
 *
 * 缓存设计（两层，均为 LRU + 容量上限）：
 *   - dataUrlCache：hash → data URL。上下文派生（同步快照路径）与预载共用，
 *     命中即免重复解码；驱逐无副作用（getDataUrl 会回退读库）。
 *   - objectUrlCache：hash → blob: URL。UI 缩略图/查看器共用；驱逐与删除
 *     都会 revokeObjectURL，杜绝 Blob URL 泄漏。
 */

import { imageDatabase, type StoredImage } from './image-database';

/** 图片引用（内容哈希 SHA-256 hex） */
export type ImageRef = string;

/** 单条消息允许的最大图片引用数（防御脏数据把单条记录撑成超长数组） */
export const IMAGE_REF_MAX_PER_MESSAGE = 64;

/** data URL 缓存容量（LRU；驱逐后按需回读图片库） */
const DATA_URL_CACHE_MAX = 128;

/** object URL 缓存容量（LRU；驱逐即 revoke，防 Blob URL 泄漏） */
const OBJECT_URL_CACHE_MAX = 128;

/** 短 id 映射缓存容量（LRU；hash ↔ shortId 双向映射） */
const SHORT_ID_CACHE_MAX = 256;

/** data URL 解析（仅接受 base64 形态——截图与附件恒为 base64） */
const DATA_URL_PATTERN = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/;

/** 引用形态：内容哈希 hex（SHA-256 = 64 位；FNV 回退 = 32 位，见 hashBytes） */
const IMAGE_REF_PATTERN = /^[0-9a-f]{32,64}$/;

// ==================== 短 id（回答中引用截图） ====================
// 字母表 / 生成 / 冲突判定的唯一实现在 utils/shared/short-id（与会话文件库
// 共享，杜绝两处同构复制漂移）；此处仅保留本库相关的重试常量与再导出。

import {
  generateShortId,
  isShortIdConstraintError,
  SHORT_ID_LENGTH as SHARED_SHORT_ID_LENGTH,
  SHORT_ID_PATTERN as SHARED_SHORT_ID_PATTERN,
} from '@/utils/shared/short-id';

/** 短 id 长度（8 位；回答里写 <agent-image id="xxxxxxxx" />）——再导出保持既有导入方稳定 */
export const SHORT_ID_LENGTH = SHARED_SHORT_ID_LENGTH;
/** 短 id 形态（渲染层据此判定引用是否合法）——再导出保持既有导入方稳定 */
export const SHORT_ID_PATTERN = SHARED_SHORT_ID_PATTERN;
/** 短 id 分配的最大重试次数（唯一索引冲突时换候选重试） */
const SHORT_ID_MAX_ATTEMPTS = 8;

// ==================== 纯函数（引用归一 / 形态判定） ====================

/** 判定是否为合法图片引用（内容哈希） */
export function isImageRef(value: unknown): value is ImageRef {
  return typeof value === 'string' && IMAGE_REF_PATTERN.test(value);
}

/**
 * 图片引用列表归一（任意输入 → 合规引用数组，绝不抛错）：
 * 非数组 → []；非字符串 / 形态非法项丢弃；去重保序；数量上限截断。
 * 与 normalizeToolIds / normalizeSkillRefs 同构——存储层不校验字段形状，
 * 写入前统一收敛，下游拿到的恒为干净的 ImageRef[]。
 */
export function normalizeImageRefs(value: unknown): ImageRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ImageRef>();
  const result: ImageRef[] = [];
  for (const raw of value) {
    if (result.length >= IMAGE_REF_MAX_PER_MESSAGE) break;
    if (!isImageRef(raw) || seen.has(raw)) continue;
    seen.add(raw);
    result.push(raw);
  }
  return result;
}

// ==================== 字节 / 哈希 / 编解码工具 ====================

/** base64 → 字节（跨平台：浏览器与测试环境均可用；恒为 ArrayBuffer 支撑，
 *  满足 crypto.subtle.digest / Blob 等 BufferSource 参数的窄类型要求） */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const normalized = base64.replace(/\s+/g, '');
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** 字节 → base64（分块规避超长参数栈溢出，与 utils/shared/base64 同构） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

/** SHA-256（内容寻址主路径）；不可用时回退 4 车道 FNV-1a（见文件头注释） */
async function hashBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const view = new Uint8Array(digest);
      let hex = '';
      for (const byte of view) hex += byte.toString(16).padStart(2, '0');
      return hex;
    } catch {
      /* 回落 FNV-1a */
    }
  }
  // 4 车道 FNV-1a（不同乘子）→ 32 位 hex：去重键用途下的稳定回退。
  // 本哈希只做内容寻址与引用键，不承担安全职责，弱化抗碰撞性可接受。
  const lanes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const multipliers = [0x01000193, 0x85ebca6b, 0x27d4eb2f, 0x165667b1];
  for (const byte of bytes) {
    for (let lane = 0; lane < 4; lane++) {
      lanes[lane] = Math.imul(lanes[lane] ^ byte, multipliers[lane]);
    }
  }
  return lanes.map(lane => (lane >>> 0).toString(16).padStart(8, '0')).join('');
}

/** 解析 base64 data URL；失败返回 null（非 base64 / 编码损坏） */
function parseDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array<ArrayBuffer> } | null {
  if (typeof dataUrl !== 'string') return null;
  const matched = DATA_URL_PATTERN.exec(dataUrl.trim());
  if (!matched) return null;
  const mime = matched[1] && matched[1].length > 0 ? matched[1] : 'application/octet-stream';
  const bytes = base64ToBytes(matched[2]);
  if (!bytes || bytes.length === 0) return null;
  return { mime, bytes };
}

// ==================== 引擎 ====================

class ImageStore {
  /** hash → data URL（LRU；驱逐无副作用） */
  private readonly dataUrlCache = new Map<string, string>();
  /** hash → blob: URL（LRU；驱逐即 revoke） */
  private readonly objectUrlCache = new Map<string, string>();
  /** hash → shortId（LRU；避免每次写入都回读库取短 id） */
  private readonly shortIdCache = new Map<string, string>();
  /** shortId → hash（LRU；回答渲染时按短 id 反查图片） */
  private readonly shortIdHashCache = new Map<string, string>();

  // ──── 入库（内容寻址 + 去重 + 短 id 分配） ────

  /**
   * 写入一张图片（data URL → 字节 → 内容哈希 → 独立图片库）。
   *
   * 短 id：每条记录都带一个 8 位短 id（插件内唯一），回答里用它引用截图。
   * 同 hash 重复写入沿用既有短 id（不换 id——已发出去的引用必须继续有效）；
   * 新记录分配短 id 时若与既有记录冲突（唯一索引拒绝），换候选重试。
   *
   * @returns 内容哈希引用；输入非法 / 存储失败返回 null（调用方降级为无图，不阻断主流程）
   */
  async putFromDataUrl(dataUrl: string): Promise<ImageRef | null> {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) {
      console.warn('[ImageStore] 非法图片 data URL，已忽略');
      return null;
    }
    try {
      const hash = await hashBytes(parsed.bytes);
      const record = await this.writeWithShortId({
        hash,
        blob: new Blob([parsed.bytes.slice()], { type: parsed.mime }),
        mime: parsed.mime,
        byteSize: parsed.bytes.length,
        createdAt: Date.now(),
      });
      this.dataUrlCache.set(hash, dataUrl);
      this.touchLru(this.dataUrlCache, hash, DATA_URL_CACHE_MAX);
      return hash;
    } catch (error) {
      console.warn('[ImageStore] 图片入库失败（降级为无引用）:', error);
      return null;
    }
  }

  /**
   * 写入记录并落定短 id：
   *   1) 同 hash 已有记录 → 沿用其短 id（已发出去的引用必须继续有效，
   *      换 id 会让历史回答里的 <agent-image id="..."> 失效）；
   *   2) 新记录 → 分配 8 位短 id；唯一索引冲突（撞车）时换候选重试。
   *
   * 冲突重试仍失败则抛错：宁可让本次入库整体失败（调用方降级为无图），
   * 也不写入一条没有短 id、无法被引用的记录。
   */
  private async writeWithShortId(base: StoredImage): Promise<StoredImage> {
    const cached = this.shortIdCache.get(base.hash);
    const existing = cached ? null : await imageDatabase.get(base.hash).catch(() => null);
    const reusable = cached ?? existing?.shortId;
    if (reusable) {
      const record: StoredImage = { ...base, shortId: reusable };
      await imageDatabase.put(record);
      this.shortIdCache.set(base.hash, reusable);
      this.shortIdHashCache.set(reusable, base.hash);
      this.touchLru(this.shortIdCache, base.hash, SHORT_ID_CACHE_MAX);
      this.touchLru(this.shortIdHashCache, reusable, SHORT_ID_CACHE_MAX);
      return record;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < SHORT_ID_MAX_ATTEMPTS; attempt++) {
      const candidate = generateShortId();
      const record: StoredImage = { ...base, shortId: candidate };
      try {
        await imageDatabase.put(record);
        this.shortIdCache.set(base.hash, candidate);
        this.shortIdHashCache.set(candidate, base.hash);
        this.touchLru(this.shortIdCache, base.hash, SHORT_ID_CACHE_MAX);
        this.touchLru(this.shortIdHashCache, candidate, SHORT_ID_CACHE_MAX);
        return record;
      } catch (error) {
        if (!isShortIdConstraintError(error)) throw error;
        lastError = error;
      }
    }
    throw new Error(
      `短 id 分配失败（${SHORT_ID_MAX_ATTEMPTS} 次冲突后放弃）: ${String(lastError)}`,
    );
  }

  /** 批量写入（保序去重；单张失败不影响其余） */
  async putFromDataUrls(dataUrls: readonly string[]): Promise<ImageRef[]> {
    const refs: ImageRef[] = [];
    const seen = new Set<ImageRef>();
    for (const dataUrl of dataUrls) {
      const ref = await this.putFromDataUrl(dataUrl);
      if (ref && !seen.has(ref)) {
        seen.add(ref);
        refs.push(ref);
      }
    }
    return refs;
  }

  // ──── 解析（模型上下文用 data URL） ────

  /** Reuse a successfully persisted image during UI/protocol dual bookkeeping. */
  findRefByDataUrl(dataUrl: string): ImageRef | null {
    for (const [ref, cached] of this.dataUrlCache) {
      if (cached === dataUrl) return ref;
    }
    return null;
  }

  /** 同步读缓存（未命中返回 null；上下文派生的同步快照路径用） */
  peekDataUrl(ref: ImageRef): string | null {
    const cached = this.dataUrlCache.get(ref);
    if (cached !== undefined) {
      this.touchLru(this.dataUrlCache, ref, DATA_URL_CACHE_MAX);
      return cached;
    }
    return null;
  }

  /** 读取图片 data URL（缓存未命中回退读库并回填；不存在返回 null） */
  async getDataUrl(ref: ImageRef): Promise<string | null> {
    if (!isImageRef(ref)) return null;
    const cached = this.peekDataUrl(ref);
    if (cached !== null) return cached;
    try {
      const record = await imageDatabase.get(ref);
      if (!record) return null;
      const bytes = new Uint8Array(await record.blob.arrayBuffer());
      const dataUrl = `data:${record.mime};base64,${bytesToBase64(bytes)}`;
      this.dataUrlCache.set(ref, dataUrl);
      this.touchLru(this.dataUrlCache, ref, DATA_URL_CACHE_MAX);
      return dataUrl;
    } catch (error) {
      console.warn('[ImageStore] 读取图片失败:', ref.slice(0, 12), error);
      return null;
    }
  }

  /**
   * 批量预载（会话加载 / 上下文装配前调用）：
   * 把引用对应的 data URL 提前进缓存，使后续同步派生路径 peek 命中。
   * 幂等（已缓存跳过）、失败静默降级（单图失败不影响其余）。
   */
  async preload(refs: readonly ImageRef[]): Promise<void> {
    const unique = [...new Set(refs)].filter(isImageRef);
    if (unique.length === 0) return;
    await Promise.all(
      unique.map(async ref => {
        if (this.peekDataUrl(ref) !== null) return;
        await this.getDataUrl(ref);
      }),
    );
  }

  // ──── 解析（UI 展示用 object URL） ────

  /** 同步读 object URL 缓存（未命中返回 null） */
  peekObjectUrl(ref: ImageRef): string | null {
    const cached = this.objectUrlCache.get(ref);
    if (cached !== undefined) {
      this.touchLru(this.objectUrlCache, ref, OBJECT_URL_CACHE_MAX);
      return cached;
    }
    return null;
  }

  /** 读取/创建 blob: object URL（UI 缩略图与查看器用；不存在返回 null） */
  async getObjectUrl(ref: ImageRef): Promise<string | null> {
    if (!isImageRef(ref)) return null;
    const cached = this.peekObjectUrl(ref);
    if (cached !== null) return cached;
    try {
      const record = await imageDatabase.get(ref);
      if (!record) return null;
      const url = URL.createObjectURL(record.blob);
      this.objectUrlCache.set(ref, url);
      this.evictLru(this.objectUrlCache, ref, OBJECT_URL_CACHE_MAX, evicted => {
        URL.revokeObjectURL(evicted);
      });
      return url;
    } catch (error) {
      console.warn('[ImageStore] 创建图片 object URL 失败:', ref.slice(0, 12), error);
      return null;
    }
  }

  /** 图片元信息（MIME / 体积；下载文件名与统计用） */
  async getMeta(ref: ImageRef): Promise<{ mime: string; byteSize: number } | null> {
    if (!isImageRef(ref)) return null;
    try {
      const record = await imageDatabase.get(ref);
      return record ? { mime: record.mime, byteSize: record.byteSize } : null;
    } catch {
      return null;
    }
  }

  // ──── 短 id（回答中引用截图） ────

  /** 取图片的短 id（不存在 / 未分配返回 null） */
  async getShortId(ref: ImageRef): Promise<string | null> {
    if (!isImageRef(ref)) return null;
    const cached = this.shortIdCache.get(ref);
    if (cached) return cached;
    try {
      const record = await imageDatabase.get(ref);
      if (!record?.shortId) return null;
      this.shortIdCache.set(ref, record.shortId);
      this.shortIdHashCache.set(record.shortId, ref);
      this.touchLru(this.shortIdCache, ref, SHORT_ID_CACHE_MAX);
      this.touchLru(this.shortIdHashCache, record.shortId, SHORT_ID_CACHE_MAX);
      return record.shortId;
    } catch {
      return null;
    }
  }

  /** 短 id → 内容哈希（缓存未命中回退查库） */
  async resolveShortId(shortId: string): Promise<ImageRef | null> {
    if (!shortId) return null;
    const cached = this.shortIdHashCache.get(shortId);
    if (cached) return cached;
    try {
      const record = await imageDatabase.getByShortId(shortId);
      if (!record) return null;
      this.shortIdHashCache.set(shortId, record.hash);
      this.shortIdCache.set(record.hash, shortId);
      this.touchLru(this.shortIdHashCache, shortId, SHORT_ID_CACHE_MAX);
      this.touchLru(this.shortIdCache, record.hash, SHORT_ID_CACHE_MAX);
      return record.hash;
    } catch {
      return null;
    }
  }

  /** 按短 id 读取 object URL（UI 展示用；不存在返回 null） */
  async getObjectUrlByShortId(shortId: string): Promise<string | null> {
    const ref = await this.resolveShortId(shortId);
    return ref ? this.getObjectUrl(ref) : null;
  }

  /** 按短 id 读取 data URL（模型上下文用；不存在返回 null） */
  async getDataUrlByShortId(shortId: string): Promise<string | null> {
    const ref = await this.resolveShortId(shortId);
    return ref ? this.getDataUrl(ref) : null;
  }

  /**
   * 图片创建时间（毫秒时间戳；孤儿回收的宽限期判定用）。
   * 不存在 / 读取失败一律返回 null——调用方据此保守跳过：宁可漏删一张留待
   * 下次 sweep，也绝不因一次读失败误删在途图片。
   */
  async getCreatedAt(ref: ImageRef): Promise<number | null> {
    if (!isImageRef(ref)) return null;
    try {
      const record = await imageDatabase.get(ref);
      return typeof record?.createdAt === 'number' && Number.isFinite(record.createdAt)
        ? record.createdAt
        : null;
    } catch {
      return null;
    }
  }

  // ──── 生命周期（引用回收） ────

  /**
   * 删除一批图片并同步撤销缓存（object URL 一并 revoke）。
   * @returns 实际删除条数
   */
  async deleteByHashes(refs: readonly ImageRef[]): Promise<number> {
    const unique = [...new Set(refs)].filter(isImageRef);
    if (unique.length === 0) return 0;
    let deleted = 0;
    try {
      deleted = await imageDatabase.deleteMany(unique);
    } catch (error) {
      console.warn('[ImageStore] 删除图片失败:', error);
      return 0;
    }
    for (const ref of unique) {
      this.dataUrlCache.delete(ref);
      const shortId = this.shortIdCache.get(ref);
      if (shortId !== undefined) {
        this.shortIdCache.delete(ref);
        this.shortIdHashCache.delete(shortId);
      }
      const objectUrl = this.objectUrlCache.get(ref);
      if (objectUrl !== undefined) {
        URL.revokeObjectURL(objectUrl);
        this.objectUrlCache.delete(ref);
      }
    }
    return deleted;
  }

  /** 全部图片哈希（孤儿回收用） */
  listAllHashes(): Promise<ImageRef[]> {
    return imageDatabase.listHashes();
  }

  /** 图片总数（统计用） */
  count(): Promise<number> {
    return imageDatabase.count();
  }

  /** 清空全部图片（含缓存与 object URL；仅供级联清理） */
  async clear(): Promise<void> {
    try {
      await imageDatabase.clear();
    } catch (error) {
      console.warn('[ImageStore] 清空图片库失败:', error);
    }
    this.dataUrlCache.clear();
    this.shortIdCache.clear();
    this.shortIdHashCache.clear();
    for (const url of this.objectUrlCache.values()) {
      URL.revokeObjectURL(url);
    }
    this.objectUrlCache.clear();
  }

  // ──── LRU 维护 ────

  /** 命中后移到最新端；超容时驱逐最旧（可选 onEvict 回调，如 revoke URL） */
  private touchLru(cache: Map<string, string>, key: string, max: number): void {
    const value = cache.get(key);
    if (value === undefined) return;
    cache.delete(key);
    cache.set(key, value);
    this.evictLru(cache, key, max);
  }

  /** 插入后的驱逐：容量超限时按插入序（Map 迭代序 = 最旧在前）淘汰 */
  private evictLru(
    cache: Map<string, string>,
    justKey: string,
    max: number,
    onEvict?: (value: string) => void,
  ): void {
    while (cache.size > max) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined || oldestKey === justKey) break;
      const evicted = cache.get(oldestKey);
      cache.delete(oldestKey);
      if (evicted !== undefined) onEvict?.(evicted);
    }
  }
}

/** 全局单例（sidepanel 内共享同一份内存缓存） */
export const imageStore = new ImageStore();

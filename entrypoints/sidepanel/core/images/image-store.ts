/**
 * 图片存储引擎（ImageStore）—— 图片的统一管理入口
 *
 * 职责：
 *   1. 内容寻址入库：data URL → 字节 → SHA-256 → 独立图片库（image-database）。
 *      同一内容恒得同一 hash，重复截图 / 同图多引用全库仅存一份（去重）；
 *   2. 引用解析：消息层只持有 hash 引用（imageRefs），本引擎负责
 *      hash → data URL（模型上下文用）与 hash → object URL（UI 展示用）的解析，
 *      上下文引擎与渲染层因此永远不接触二进制存储细节；
 *   3. 生命周期：按引用回收（由会话删除引擎判定「不再被任何消息引用」后调用
 *      deleteByHashes），同步撤销两层内存缓存与 object URL；
 *   4. 防御性：任意输入不抛错（坏 data URL → null 并告警）、缓存有界（LRU）、
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

/** data URL 解析（仅接受 base64 形态——截图与附件恒为 base64） */
const DATA_URL_PATTERN = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/;

/** 引用形态：内容哈希 hex（SHA-256 = 64 位；FNV 回退 = 32 位，见 hashBytes） */
const IMAGE_REF_PATTERN = /^[0-9a-f]{32,64}$/;

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

  // ──── 入库（内容寻址 + 去重） ────

  /**
   * 写入一张图片（data URL → 字节 → 内容哈希 → 独立图片库）。
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
      const record: StoredImage = {
        hash,
        blob: new Blob([parsed.bytes.slice()], { type: parsed.mime }),
        mime: parsed.mime,
        byteSize: parsed.bytes.length,
        createdAt: Date.now(),
      };
      // 幂等：同内容重复写入覆盖为同一条（内容寻址下 no-op），并刷新缓存
      await imageDatabase.put(record);
      this.dataUrlCache.set(hash, dataUrl);
      this.touchLru(this.dataUrlCache, hash, DATA_URL_CACHE_MAX);
      return hash;
    } catch (error) {
      console.warn('[ImageStore] 图片入库失败（降级为无引用）:', error);
      return null;
    }
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

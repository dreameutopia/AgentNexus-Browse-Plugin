/**
 * 字节估算与格式化 —— 备份引擎与存储统计共用的纯函数
 *
 * 设计要点：
 * - utf8Bytes 优先走 TextEncoder（原生实现，精确），不可用时回退逐码元估算
 *   （BMP 外字符按 3 字节近似，仅影响极端 emoji 场景的估算精度，绝不抛错）；
 * - jsonBytes 对循环引用等不可序列化值返回 -1（调用方据此显示「—」而非 0，
 *   避免「统计为 0」与「统计失败」两种语义混淆）；
 * - formatBytes 对非法输入返回占位符，保证 UI 永不渲染 NaN/undefined。
 */

/** TextEncoder 在扩展页 / Node 18+ 均可用；不可用时回退估算 */
const encoder: TextEncoder | null = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** 字符串的 UTF-8 字节数（永不抛错） */
export function utf8Bytes(text: string): number {
  if (!text) return 0;
  if (encoder) {
    try {
      return encoder.encode(text).length;
    } catch {
      /* 回落到估算路径 */
    }
  }
  // 回退：逐码元估算（<0x80 → 1，<0x800 → 2，其余 → 3；
  // 代理对会按两个码元各计 3 字节，略高估 4 字节字符，仅作显示用）
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return bytes;
}

/** 任意值 JSON 序列化后的 UTF-8 字节数；不可序列化（循环引用等）返回 -1 */
export function jsonBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? utf8Bytes(text) : -1;
  } catch {
    return -1;
  }
}

/**
 * 人类可读的字节格式（B / KB / MB / GB / TB）。
 * 非法输入（NaN / 负数 / Infinity）返回 '—'，由调用方展示为「统计失败」。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * 占比 → 百分比文本。
 * 0..1 之间：<1% 保留 1 位小数（否则全显示 0% 失去信息量），其余取整。
 */
export function percentText(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  if (share >= 1) return '100%';
  const percent = share * 100;
  return percent < 1 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

// ==================== 通用值体积估算 ====================

/**
 * 任意可结构化克隆值的字节估算（用于 IndexedDB 记录这类「没有 getBytesInUse
 * 可用」的存储面）。
 *
 * 与 jsonBytes 的区别：jsonBytes 走 JSON.stringify，遇到 Blob / ArrayBuffer
 * 只会算成 `{}`（≈2 字节），会把图片库这类二进制存储统计成接近 0——正是
 * 「统计缺数」的典型来源。本函数按真实载荷计量：
 *   - Blob        → size（真实字节）
 *   - ArrayBuffer → byteLength
 *   - TypedArray  → byteLength
 *   - string      → UTF-8 字节数
 *   - number/boolean → 8 字节（JS 标量在序列化层的近似开销）
 *   - 数组/对象  → 逐项累加（对象额外计入键名的 UTF-8 字节）
 *
 * 循环引用经 seen 集合截断（不会无限递归），代价是循环部分只计一次。
 */
export function estimateValueBytes(value: unknown, seen: Set<object> = new Set()): number {
  if (value === null || value === undefined) return 0;
  const type = typeof value;
  if (type === 'string') return utf8Bytes(value as string);
  if (type === 'number' || type === 'boolean' || type === 'bigint') return 8;
  if (type === 'function' || type === 'symbol') return 0;

  const obj = value as object;
  if (seen.has(obj)) return 0;
  seen.add(obj);

  try {
    // 注意用 obj（已是 object）做 instanceof —— unknown 不能直接做左操作数
    if (typeof Blob !== 'undefined' && obj instanceof Blob) return obj.size;
    if (obj instanceof ArrayBuffer) return obj.byteLength;
    if (ArrayBuffer.isView(obj)) return obj.byteLength;

    if (Array.isArray(obj)) {
      let total = 0;
      for (const item of obj) total += estimateValueBytes(item, seen);
      return total;
    }

    let total = 0;
    for (const [key, item] of Object.entries(obj as Record<string, unknown>)) {
      total += utf8Bytes(key) + estimateValueBytes(item, seen);
    }
    return total;
  } catch {
    // 不可枚举 / 抛错的 exotic 对象按 0 计，绝不让统计整体失败
    return 0;
  } finally {
    seen.delete(obj);
  }
}

// ==================== base64 编解码（二进制分区落盘用） ====================

/** 字节数组 → base64（分块规避超长参数栈溢出；无 btoa 时返回空串） */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== 'function') return '';
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  try {
    return btoa(binary);
  } catch {
    return '';
  }
}

/** base64 → 字节数组（非法输入返回 null，不抛错） */
export function base64ToBytes(base64: string): Uint8Array | null {
  if (typeof atob !== 'function') return null;
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

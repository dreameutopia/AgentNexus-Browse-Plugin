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

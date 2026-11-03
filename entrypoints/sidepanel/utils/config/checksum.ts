/**
 * 稳定序列化 + 校验和
 *
 * - stableStringify：键序无关的确定性序列化（校验和必须与键顺序无关，
 *   否则 chrome.storage 结构化克隆 / JSON 往返导致键序变化就会误报损坏）
 * - checksum：双路 FNV-1a 32 位（不同 offset basis + 不同 prime），输出 16 位十六进制。
 *   用途是「意外损坏检测」而非防篡改；防篡改请用文件级签名（不在本模块职责内）。
 *   按 16 位码元处理，中文等非 ASCII 文本同样参与运算。
 */

/** 把任意可 JSON 化的值序列化为键序稳定的字符串 */
export function stableStringify(value: unknown): string {
  return stringifyNode(value);
}

function stringifyNode(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') {
    return Number.isFinite(value as number) ? JSON.stringify(value) : 'null';
  }
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (type === 'undefined' || type === 'function' || type === 'symbol') return 'null';
  if (type === 'bigint') return JSON.stringify(String(value));
  if (Array.isArray(value)) {
    return '[' + value.map(item => stringifyNode(item)).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    parts.push(JSON.stringify(key) + ':' + stringifyNode(item));
  }
  return '{' + parts.join(',') + '}';
}

function fnv1a32(text: string, offsetBasis: number, prime: number): number {
  let hash = offsetBasis >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, prime);
  }
  return hash >>> 0;
}

/** 双路 FNV-1a 校验和，返回 16 位十六进制字符串 */
export function checksum(text: string): string {
  const a = fnv1a32(text, 0x811c9dc5, 0x01000193);
  const b = fnv1a32(text, 0x9dc5811c, 0x01000197);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** 对任意值做稳定序列化后计算校验和 */
export function checksumOf(value: unknown): string {
  return checksum(stableStringify(value));
}

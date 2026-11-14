/**
 * 插件域共享字节编解码。
 *
 * 宿主包校验、GitHub 下载校验、后台协议与 UI 导入共用同一实现，避免
 * base64 规则（规范编码、填充、长度）在不同入口出现漂移。
 */
import { invariant } from './contracts';

export function base32(bytes: Uint8Array): string {
  let bits = 0,
    value = 0,
    out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5)
      out += 'abcdefghijklmnopqrstuvwxyz234567'[(value >>> (bits -= 5)) & 31];
  }
  if (bits)
    out += 'abcdefghijklmnopqrstuvwxyz234567'[(value << (5 - bits)) & 31];
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
}

/** 只接受规范 base64（重新编码必须逐字节一致），拒绝 URL-safe 与缺填充变体 */
export function decode64(value: string): Uint8Array {
  invariant(
    /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0,
    'INVALID_BASE64',
  );
  const out = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  invariant(toBase64(out) === value, 'NONCANONICAL_BASE64');
  return out;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes as BufferSource),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

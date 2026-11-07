/**
 * 8 位资源短 id（跨存储共享的唯一实现）
 *
 * 两个内容库（图片库 image-store / 会话文件库 file-store）都用 8 位短 id
 * 作为对外引用键——模型可读、可复述、用户也看得懂，不把长哈希塞进对话。
 * 字母表与生成本前统一抽取，杜绝两处实现漂移（此前为「同构复制」）。
 *
 * 唯一性策略：40 bit 熵 + 存储层唯一约束兜底（各自库的主键/唯一索引），
 * 冲突时写入方换候选重试——生成函数只负责随机，不负责查重。
 */

/** 短 id 字母表：32 个字符（Crockford base32 去掉易混的 I/L/O/U） */
export const SHORT_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** 短 id 长度（8 位 × 5 bit = 40 bit 熵） */
export const SHORT_ID_LENGTH = 8;

/** 短 id 形态（渲染层 / 工具层据此判定引用是否合法） */
export const SHORT_ID_PATTERN = /^[0-9a-z]{8}$/;

/** 生成候选短 id（crypto 优先；不可用时退回 Math.random——熵略降，唯一性仍由存储层兜底） */
export function generateShortId(): string {
  let out = '';
  const globalCrypto = typeof crypto !== 'undefined' ? crypto : undefined;
  if (globalCrypto?.getRandomValues) {
    const bytes = new Uint8Array(SHORT_ID_LENGTH);
    globalCrypto.getRandomValues(bytes);
    for (const byte of bytes) out += SHORT_ID_ALPHABET[byte % 32];
    return out;
  }
  for (let index = 0; index < SHORT_ID_LENGTH; index++) {
    out += SHORT_ID_ALPHABET[Math.floor(Math.random() * 32)];
  }
  return out;
}

/** 判定是否为唯一索引冲突（写入短 id 主键/唯一索引时可能被拒的唯一预期原因） */
export function isShortIdConstraintError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'ConstraintError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ConstraintError/i.test(message);
}

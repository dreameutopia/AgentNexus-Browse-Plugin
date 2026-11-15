/**
 * 文本解码阶梯（DOM-free，service worker 可用）
 *
 * 与旧版附件解析器的解码口径完全一致，但去掉了 DOM 与 i18n 依赖——
 * file_util 在 background service worker 中执行，那里没有 DOM，也没有
 * 用户界面可承载本地化文案，因此错误以结构化信息（编码候选）向上抛出，
 * 由工具层翻译成面向模型的处置建议。
 *
 * 阶梯顺序（对任意输入不静默产出乱码）：
 *   1. BOM 识别（UTF-8 / UTF-16LE / UTF-16BE）→ 按 BOM 指定编码解码；
 *   2. 无 BOM：UTF-8 严格解码（非法字节序列抛错）；
 *   3. GBK 严格解码（中文 Windows 环境导出的 txt/csv 最常见编码）；
 *   4. 兜底 UTF-8 宽松解码（替换不可解码字符，绝无二次抛错）。
 *
 * 读取容错 vs 写入严格，是刻意的非对称：
 *   - 读取宽容（阶梯解码）——AI 要能看见用户上传的历史编码文件；
 *   - 写入严格（仅 UTF-8）——工作区引擎拒绝在非 UTF-8 文件上就地改写，
 *     避免拼出混合编码的损坏文件（见 workspace-files.decodeUtf8Text）。
 */

/** 解码结果：文本 + 实际生效的编码标签（供 UI/日志说明「按什么编码读的」） */
export interface DecodedText {
  text: string;
  /** 实际生效的编码标签（'utf-8' / 'utf-16le' / 'utf-16be' / 'gbk'） */
  encoding: string;
  /** 是否走了兜底宽松解码（true 表示原字节存在无法解码的序列） */
  lossy: boolean;
}

/** 解码失败（全部候选编码严格解码均不可行——实践中不可达，防御保留） */
export class TextDecodeError extends Error {
  readonly attempted: readonly string[];

  constructor(message: string, attempted: readonly string[]) {
    super(message);
    this.name = 'TextDecodeError';
    this.attempted = attempted;
  }
}

/** 单编码解码：fatal 控制严格/宽松模式；宽松模式不可达异常路径 */
function decodeWith(encoding: string, bytes: Uint8Array, fatal: boolean): string {
  try {
    return new TextDecoder(encoding, { fatal }).decode(bytes);
  } catch (error) {
    throw new TextDecodeError(
      `按 ${encoding} 解码失败：${error instanceof Error ? error.message : String(error)}`,
      [encoding],
    );
  }
}

/**
 * 文本解码阶梯入口。
 *
 * @param bytes 原始字节
 * @returns 文本、实际编码与是否发生了有损替换
 */
export function decodeTextBytes(bytes: Uint8Array): DecodedText {
  // BOM：UTF-8 (EF BB BF) / UTF-16LE (FF FE) / UTF-16BE (FE FF)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decodeWith('utf-8', bytes.subarray(3), false), encoding: 'utf-8', lossy: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeWith('utf-16le', bytes.subarray(2), false), encoding: 'utf-16le', lossy: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeWith('utf-16be', bytes.subarray(2), false), encoding: 'utf-16be', lossy: false };
  }

  // 无 BOM：UTF-8 严格 → GBK 严格 → UTF-8 宽松
  try {
    return { text: decodeWith('utf-8', bytes, true), encoding: 'utf-8', lossy: false };
  } catch {
    /* 落入下一档 */
  }
  try {
    return { text: decodeWith('gbk', bytes, true), encoding: 'gbk', lossy: false };
  } catch {
    /* 落入兜底 */
  }
  return { text: decodeWith('utf-8', bytes, false), encoding: 'utf-8', lossy: true };
}

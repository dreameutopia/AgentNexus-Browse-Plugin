/**
 * 图片压缩引擎（上传附件的统一图片处理层）
 *
 * 职责：把用户上传的图片整理成「主流多模态接口可直接消费、体积受控」的
 * data URL，全部在 sidepanel DOM 上下文内完成（canvas / createImageBitmap），
 * 不依赖任何外部服务。
 *
 * 触发条件（imageNeedsPreparation，上传策略单一判定口）：
 *   1. 原始体积 > IMAGE_COMPRESS_TARGET_BYTES（2MB）——压缩到目标之内；
 *   2. BMP / ICO——主流视觉接口（OpenAI / Claude）只接受
 *      JPEG / PNG / WebP / GIF，必须转码；
 *   3. 动画 GIF——两家接口均不接受动画帧序列，取首帧转静态图；
 *   4. 任一边超过 MAX_INLINE_DIMENSION（7680px）——Claude 侧硬上限
 *      8000×8000，超限直接拒收，必须降采样。
 * 其余（≤2MB 的 jpeg/png/webp/静态 gif）原样直传，零质量损失。
 *
 * 压缩策略（优先保证模型能看清，其次才是体积）：
 *   - 质量阶梯优先、分辨率阶梯兜底：先在**原始分辨率**上从 0.92 逐档降
 *     质量（WebP），全程达标就不动分辨率（文字/代码截图的清晰度主要取决于
 *     分辨率而非压缩质量）；
 *   - 质量阶梯走完仍超标才逐档缩分辨率（0.85 → 0.3），长边下限
 *     MIN_LONG_SIDE（768px）——低于该值模型分块读取细节已不可恢复；
 *   - 输出格式优先 WebP（同质量体积最小且保透明度；Chrome/Firefox 的
 *     canvas 编码器支持，Safari 会静默回退 PNG——必须校验产物 mime）；
 *     WebP 不可用时回退 JPEG（JPEG 无透明度，编码前先铺白底）；
 *   - BMP / ICO 这类无损位图先尝试 PNG（无损转码），超标再走有损阶梯。
 *
 * 防御性：
 *   - 解码三级阶梯：createImageBitmap(带 EXIF 方向) → createImageBitmap(裸)
 *     → HTMLImageElement（object URL，用后即 revoke）；
 *   - 巨幅防御：解码结果像素面积超过 MAX_DECODE_AREA（64MP）时先经
 *     createImageBitmap 的 resize 解码降采样，绝不直接绘制超限画布；
 *   - 编码产物 mime 与尺寸双重校验（toBlob 静默回退是不可依赖行为）；
 *   - 全路径失败抛 ImageCompressionError（用户可读），绝不返回半成品。
 *
 * DOM 依赖约定：本模块只在 sidepanel 页面上下文可用（background service
 * worker 无 DOM），不得被 background 引用（同 attachment-parser）。
 */

import { AttachmentParseError } from './attachment-parser';

// ==================== 策略常量 ====================

/** 压缩目标体积（字节）：≤2MB 对所有主流接口都在单图上限之内 */
export const IMAGE_COMPRESS_TARGET_BYTES = 2 * 1024 * 1024;

/**
 * 直传内联的边长上限（px）：Claude 硬上限 8000×8000，取 7680（<8000 且
 * 为 512 的倍数，兼顾分块计费口径）。任一边超过即需降采样。
 */
export const MAX_INLINE_DIMENSION = 7680;

/** 降采样的长边下限（px）：低于该值模型侧细节不可恢复，宁可保留体积 */
const MIN_LONG_SIDE = 768;

/** 巨幅图片的解码面积上限（像素总数）：超限先经 resize 解码降采样 */
const MAX_DECODE_AREA = 64e6; // 64MP

/** 质量阶梯（WebP / JPEG 共用；从高到低，首个达标即停） */
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.7, 0.62] as const;

/** 分辨率阶梯（质量阶梯在当前档全走完仍超标时才降档） */
const SCALE_STEPS = [1, 0.85, 0.72, 0.6, 0.5, 0.42, 0.35, 0.3] as const;

/** 无损优先的源格式（先试 PNG，超标再走有损阶梯） */
const LOSSLESS_PREFERRED_EXTS = new Set(['bmp', 'ico']);

/** 视觉接口直传安全格式（≤2MB 且尺寸合规时原样直传） */
const DIRECT_SAFE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

/**
 * 直传兜底 MIME（原始 file.type 为空串时按扩展名补齐——data URL 的 mime
 * 会被视觉接口校验，缺省或错标 png 会让 gif/webp 直传被拒）。
 */
const PASSTHROUGH_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** 直传路径的最终 MIME：原始声明优先，空缺按扩展名兜底，仍未知按 png */
function passthroughMime(mimeType: string, ext: string): string {
  if (mimeType && mimeType !== '') return mimeType;
  return PASSTHROUGH_MIME_BY_EXT[ext] ?? 'image/png';
}

// ==================== 错误类型 ====================

/** 压缩失败（用户可读消息；调用方据此弹窗提示） */
export class ImageCompressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageCompressionError';
  }
}

// ==================== 结果类型 ====================

/** 图片整理产物（无论直传还是压缩，统一形态） */
export interface PreparedImage {
  /** 最终 data URL（多模态 image_url 直传载荷） */
  dataUrl: string;
  /** 最终 MIME（直传 = 原始；压缩 = 输出格式） */
  mime: string;
  /** 最终体积（字节） */
  byteSize: number;
  /** 最终尺寸（px；直传时为解码实测尺寸，解码失败为 0） */
  width: number;
  height: number;
  /** 是否发生了重编码（true = 压缩 / 转码；false = 原样直传） */
  changed: boolean;
  /** 触发整理的原因（用户提示文案用；直传为 'passthrough'） */
  reason: 'oversize' | 'transcode' | 'animated' | 'dimension' | 'passthrough';
}

// ==================== 二进制探测（无解码） ====================

/** GIF 是否含多帧（动画）：块级状态机扫描，malformed 一律按单帧处理 */
export function isAnimatedGif(bytes: Uint8Array): boolean {
  if (bytes.length < 14) return false;
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return false; // 'GIF'
  let p = 13;
  const flags = bytes[10];
  if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1)); // 全局颜色表
  let images = 0;
  const n = bytes.length;
  while (p < n) {
    const block = bytes[p];
    if (block === 0x3b) return false; // Trailer：完整结束且仅 1 帧图像
    if (block === 0x21) {
      p += 2; // 0x21 + 扩展标签
      p = skipGifSubBlocks(bytes, p);
      continue;
    }
    if (block === 0x2c) {
      images += 1;
      if (images >= 2) return true;
      const packed = bytes[p + 9]; // left(2)+top(2)+w(2)+h(2)+packed(1)
      p += 10;
      if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1)); // 局部颜色表
      p += 1; // LZW 最小码长
      p = skipGifSubBlocks(bytes, p);
      continue;
    }
    return false; // 未知块：格式异常，按单帧处理（宁漏判不误判）
  }
  return false;
}

function skipGifSubBlocks(bytes: Uint8Array, p: number): number {
  const n = bytes.length;
  while (p < n) {
    const size = bytes[p];
    p += 1;
    if (size === 0) return p;
    p += size;
  }
  return p;
}

/**
 * 头部读取图片尺寸（无解码；读不出返回 null——调用方据此跳过尺寸判定，
 * 绝不把探测失败当错误阻断上传）。
 * 覆盖 PNG / JPEG / GIF / BMP / WebP（含 VP8L 无损与 VP8X 扩展）。
 */
export function readImageDimensions(
  bytes: Uint8Array,
  ext: string,
): { width: number; height: number } | null {
  try {
    if (ext === 'png' && bytes.length >= 24 && bytes[12] === 0x49 && bytes[13] === 0x48) {
      // IHDR：宽高各 4 字节大端，偏移 16 / 20
      return {
        width: readU32BE(bytes, 16),
        height: readU32BE(bytes, 20),
      };
    }
    if ((ext === 'jpg' || ext === 'jpeg') && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      return readJpegDimensions(bytes);
    }
    if (ext === 'gif' && bytes.length >= 10) {
      return {
        width: bytes[6] | (bytes[7] << 8),
        height: bytes[8] | (bytes[9] << 8),
      };
    }
    if (ext === 'bmp' && bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
      // BITMAPINFOHEADER：宽高有符号 4 字节小端，偏移 18 / 22
      return {
        width: Math.abs(readU32LE(bytes, 18)),
        height: Math.abs(readU32LE(bytes, 22)),
      };
    }
    if (ext === 'webp' && bytes.length >= 30 && bytes[12] === 0x56 && bytes[13] === 0x50) {
      return readWebpDimensions(bytes);
    }
  } catch {
    /* 探测失败按未知处理 */
  }
  return null;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
  ) >>> 0;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset + 3] << 24) | (bytes[offset + 2] << 16) | (bytes[offset + 1] << 8) | bytes[offset]
  ) >>> 0;
}

/** JPEG SOF 段扫描（含渐进式 SOF2；跳过熵编码数据的 0xFF 填充干扰） */
function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let p = 2;
  const n = bytes.length;
  while (p + 9 < n) {
    if (bytes[p] !== 0xff) {
      p += 1;
      continue;
    }
    const marker = bytes[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2; // 无长度段
      continue;
    }
    if (marker === 0xda) return null; // 进入熵编码数据仍未遇 SOF：放弃
    const length = (bytes[p + 2] << 8) | bytes[p + 3];
    // SOF0-SOF15（除 DHT/JPG/DAC 伪段）：高(2) 精度(1) 宽(2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[p + 5] << 8) | bytes[p + 6],
        width: (bytes[p + 7] << 8) | bytes[p + 8],
      };
    }
    p += 2 + length;
  }
  return null;
}

/** WebP 尺寸（RIFF：VP8X / VP8L / VP8 三种头部） */
function readWebpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const tag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (tag === 'VP8X') {
    // canvas width-1 / height-1 各 24bit 小端，偏移 24 起
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  if (tag === 'VP8 ' && bytes.length >= 30) {
    // 关键帧头：宽高各 2 字节小端，偏移 26 / 28
    return { width: bytes[26] | (bytes[27] << 8), height: bytes[28] | (bytes[29] << 8) };
  }
  if (tag === 'VP8L' && bytes.length >= 25) {
    // 无损头：14bit 宽 + 14bit 高打包在 4 字节里（自 20 偏移起）
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    const width = 1 + ((b1 & 0x3f) << 8 | b0);
    const height = 1 + ((b3 & 0x0f) << 10 | b2 << 2 | (b1 & 0xc0) >> 6);
    return { width, height };
  }
  return null;
}

// ==================== 整理策略判定 ====================

/**
 * 是否需要进压缩引擎（上传侧的单一判定口）。
 * @param ext 小写扩展名
 * @param byteSize 原始字节数
 * @param dims 头部探测出的尺寸（探测失败传 null：尺寸维度按合规处理）
 * @param animated GIF 是否多帧（非 GIF 传 false）
 */
export function imageNeedsPreparation(
  ext: string,
  byteSize: number,
  dims: { width: number; height: number } | null,
  animated: boolean,
): boolean {
  if (byteSize > IMAGE_COMPRESS_TARGET_BYTES) return true;
  if (!DIRECT_SAFE_EXTS.has(ext)) return true; // bmp / ico（及其它栅格形态）
  if (ext === 'gif' && animated) return true;
  if (dims && Math.max(dims.width, dims.height) > MAX_INLINE_DIMENSION) return true;
  return false;
}

// ==================== 解码（三级阶梯） ====================

/** 可绘制对象的统一抽象（ImageBitmap 与 HTMLImageElement 双形态） */
interface Drawable {
  width: number;
  height: number;
  source: CanvasImageSource;
}

async function decodeBlob(blob: Blob): Promise<Drawable> {
  // 1) createImageBitmap + EXIF 方向（老实现不识别该选项时落入下一档）
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return { width: bitmap.width, height: bitmap.height, source: bitmap };
  } catch {
    /* 落入下一档 */
  }
  // 2) createImageBitmap 裸调用
  try {
    const bitmap = await createImageBitmap(blob);
    return { width: bitmap.width, height: bitmap.height, source: bitmap };
  } catch {
    /* 落入下一档 */
  }
  // 3) HTMLImageElement（object URL；异步解码等待；用后即回收）
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('图片解码失败（格式损坏或不受支持）'));
      element.src = url;
    });
    if (typeof image.decode === 'function') await image.decode().catch(() => undefined);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('图片解码后无有效尺寸');
    return { width, height, source: image };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 巨幅图片的 resize 解码（面积超 MAX_DECODE_AREA 时先降采样再绘制） */
async function decodeWithinAreaBudget(blob: Blob): Promise<Drawable> {
  const drawable = await decodeBlob(blob);
  const area = drawable.width * drawable.height;
  if (area <= MAX_DECODE_AREA) return drawable;
  const factor = Math.sqrt(MAX_DECODE_AREA / area);
  const resizeWidth = Math.max(1, Math.round(drawable.width * factor));
  const resizeHeight = Math.max(1, Math.round(drawable.height * factor));
  closeDrawable(drawable);
  try {
    const bitmap = await createImageBitmap(blob, {
      resizeWidth,
      resizeHeight,
      resizeQuality: 'high',
      imageOrientation: 'from-image',
    });
    return { width: bitmap.width, height: bitmap.height, source: bitmap };
  } catch {
    /* resize 解码不可用：退回原图（后续绘制按阶梯缩放，画布仍在面积预算内） */
    return decodeBlob(blob);
  }
}

function closeDrawable(drawable: Drawable): void {
  const maybeBitmap = drawable.source as ImageBitmap | HTMLImageElement;
  if (typeof (maybeBitmap as ImageBitmap).close === 'function') {
    try {
      (maybeBitmap as ImageBitmap).close();
    } catch {
      /* 已关闭 */
    }
  }
}

// ==================== 绘制与编码 ====================

/** 绘制到画布（scale = 相对解码尺寸的缩放比；flattenWhite = JPEG 前铺白底） */
function drawScaled(
  drawable: Drawable,
  scale: number,
  flattenWhite: boolean,
): HTMLCanvasElement {
  const width = Math.max(1, Math.round(drawable.width * scale));
  const height = Math.max(1, Math.round(drawable.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: !flattenWhite });
  if (!ctx) throw new ImageCompressionError('画布创建失败（2D 上下文不可用）');
  if (flattenWhite) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(drawable.source, 0, 0, width, height);
  return canvas;
}

/** 画布编码（toBlob 的 Promise 包装；返回 null = 编码器拒绝该 mime） */
function encodeCanvas(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> {
  return new Promise(resolve => {
    try {
      if (quality === undefined) canvas.toBlob(blob => resolve(blob), mime);
      else canvas.toBlob(blob => resolve(blob), mime, quality);
    } catch {
      resolve(null);
    }
  });
}

/** WebP 编码能力探测（Safari 会静默回退 PNG：必须验产物 mime；结果缓存） */
let webpEncoderAvailable: boolean | null = null;
async function isWebpEncoderAvailable(): Promise<boolean> {
  if (webpEncoderAvailable !== null) return webpEncoderAvailable;
  try {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const blob = await encodeCanvas(probe, 'image/webp', 0.8);
    webpEncoderAvailable = !!blob && blob.type === 'image/webp' && blob.size > 0;
  } catch {
    webpEncoderAvailable = false;
  }
  return webpEncoderAvailable;
}

interface EncodeCandidate {
  blob: Blob;
  mime: string;
  canvas: HTMLCanvasElement;
}

/** 编码候选产物的有效性（mime 必须命中请求值——静默回退的产物不可用） */
function accepted(blob: Blob | null, mime: string): blob is Blob {
  return !!blob && blob.size > 0 && blob.type === mime;
}

// ==================== 主入口 ====================

/**
 * 整理一张上传图片（直传或压缩，统一产物形态）。
 *
 * @param buffer 原始文件字节
 * @param ext 小写扩展名
 * @param mimeType 原始 MIME（可能为空串）
 * @param probes 预探测结果（dims / animated；调用方已读字节时可传入避免重复扫描，
 *   缺省时内部现算）
 * @throws ImageCompressionError 解码失败（格式损坏 / 浏览器不支持）
 */
export async function prepareImageForUpload(
  buffer: ArrayBuffer,
  ext: string,
  mimeType: string,
  probes?: { dims: { width: number; height: number } | null; animated: boolean },
): Promise<PreparedImage> {
  const bytes = new Uint8Array(buffer);
  const dims = probes?.dims ?? readImageDimensions(bytes, ext);
  const animated = probes?.animated ?? (ext === 'gif' ? isAnimatedGif(bytes) : false);

  // ── 直传：无需整理的图片原样转 data URL（零质量损失） ──
  if (!imageNeedsPreparation(ext, bytes.length, dims, animated)) {
    const blob = new Blob([buffer.slice(0)], { type: passthroughMime(mimeType, ext) });
    const dataUrl = await blobToDataUrl(blob);
    return {
      dataUrl,
      mime: blob.type,
      byteSize: blob.size,
      width: dims?.width ?? 0,
      height: dims?.height ?? 0,
      changed: false,
      reason: 'passthrough',
    };
  }

  const reason: PreparedImage['reason'] =
    bytes.length > IMAGE_COMPRESS_TARGET_BYTES
      ? 'oversize'
      : ext === 'gif' && animated
        ? 'animated'
        : dims && Math.max(dims.width, dims.height) > MAX_INLINE_DIMENSION
          ? 'dimension'
          : 'transcode';

  // ── 压缩 / 转码 ──
  const sourceBlob = new Blob([buffer.slice(0)], { type: mimeType || 'image/png' });
  const drawable = await decodeWithinAreaBudget(sourceBlob);

  // 候选追踪（保留全局最小合规产物；理论不可达的防御性兜底）
  let best: EncodeCandidate | null = null;
  let bestCanvas: HTMLCanvasElement | null = null;
  /** 闭包写入后的读取口（绕开控制流分析对闭包变量的 null 窄化） */
  function currentBest(): EncodeCandidate | null {
    return best;
  }
  function trackBest(candidate: { blob: Blob | null; mime: string; canvas: HTMLCanvasElement }): void {
    if (!candidate.blob) return;
    if (!best || candidate.blob.size < best.blob.size) {
      // 淘汰旧 best 的画布（同画布连续质量档时不释放——它仍在本档阶梯中使用；
      // best.blob 已编码完成，画布仅剩尺寸信息，释放不影响产物正确性）
      if (bestCanvas && bestCanvas !== candidate.canvas) discardCanvas(bestCanvas);
      best = { blob: candidate.blob, mime: candidate.mime, canvas: candidate.canvas };
      bestCanvas = candidate.canvas;
    }
    // 候选更大：不接管也不释放其画布——该画布可能正是当前阶梯仍在用的那块，
    // 释放会破坏后续质量档的编码源（非 best 的离屏画布由 GC 回收即可）
  }

  try {
    const useWebp = await isWebpEncoderAvailable();
    const preferLossless = LOSSLESS_PREFERRED_EXTS.has(ext);

    // 有效缩放档：分辨率阶梯 + 长边下限钳制（原尺寸本就低于下限时不再缩）
    const originLong = Math.max(drawable.width, drawable.height);
    const scales: number[] = [];
    for (const step of SCALE_STEPS) {
      let effective: number = step;
      const scaledLong = originLong * step;
      if (scaledLong < MIN_LONG_SIDE && originLong > MIN_LONG_SIDE) {
        effective = MIN_LONG_SIDE / originLong; // 钳到下限
      }
      effective = Math.min(1, effective);
      if (!scales.some(seen => Math.abs(seen - effective) < 0.005)) scales.push(effective);
    }

    for (const scale of scales) {
      const isFullScale = scale >= 0.999;
      // 无损优先（BMP/ICO 的整幅档）：PNG 直接转码，达标即收；
      // 未达标不跳档——继续落入同档 WebP/JPEG 阶梯（无损不达标时有损兜底）
      if (preferLossless && isFullScale) {
        const canvas = drawScaled(drawable, 1, false);
        const png = await encodeCanvas(canvas, 'image/png');
        if (accepted(png, 'image/png') && png.size <= IMAGE_COMPRESS_TARGET_BYTES) {
          return candidateToResult(canvas, png, 'image/png', reason);
        }
        trackBest({ blob: png && accepted(png, 'image/png') ? png : null, mime: 'image/png', canvas });
      }

      // WebP 阶梯（质量优先，分辨率不动）
      if (useWebp) {
        const canvas = drawScaled(drawable, scale, false);
        let canvasUsed = false;
        for (const quality of QUALITY_STEPS) {
          const blob = await encodeCanvas(canvas, 'image/webp', quality);
          if (accepted(blob, 'image/webp') && blob.size <= IMAGE_COMPRESS_TARGET_BYTES) {
            return candidateToResult(canvas, blob, 'image/webp', reason);
          }
          if (blob && accepted(blob, 'image/webp')) {
            trackBest({ blob, mime: 'image/webp', canvas });
            canvasUsed = true;
          }
        }
        if (!canvasUsed && bestCanvas !== canvas) discardCanvas(canvas);
      }

      // JPEG 阶梯（铺白底；WebP 不可用或全档超标时的兜底）
      {
        const canvas = drawScaled(drawable, scale, true);
        let canvasUsed = false;
        for (const quality of QUALITY_STEPS) {
          const blob = await encodeCanvas(canvas, 'image/jpeg', quality);
          if (accepted(blob, 'image/jpeg') && blob.size <= IMAGE_COMPRESS_TARGET_BYTES) {
            return candidateToResult(canvas, blob, 'image/jpeg', reason);
          }
          if (blob && accepted(blob, 'image/jpeg')) {
            trackBest({ blob, mime: 'image/jpeg', canvas });
            canvasUsed = true;
          }
        }
        if (!canvasUsed && bestCanvas !== canvas) discardCanvas(canvas);
      }
    }

    // 理论不可达（768px 长边 × q0.62 WebP 远低于 2MB）；防御性兜底：
    // 取全程最小的合规编码产物（绝不返回 null 击穿调用链）。
    // 经 getter 读取：trackBest 在闭包内赋值，直接读会被控制流分析窄化为 null
    const fallback = currentBest();
    if (fallback && bestCanvas) {
      return candidateToResult(bestCanvas, fallback.blob, fallback.mime, reason);
    }
    throw new ImageCompressionError('图片压缩失败：本环境无可用的图片编码器');
  } finally {
    closeDrawable(drawable);
  }
}

/** 画布释放（显式置零宽高，尽快归还大画布内存） */
function discardCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/** 编码产物 → 统一结果形态（尺寸以编码画布为准） */
async function candidateToResult(
  canvas: HTMLCanvasElement,
  blob: Blob,
  mime: string,
  reason: PreparedImage['reason'],
): Promise<PreparedImage> {
  const dataUrl = await blobToDataUrl(blob);
  return {
    dataUrl,
    mime,
    byteSize: blob.size,
    width: canvas.width,
    height: canvas.height,
    changed: true,
    reason,
  };
}

/** Blob → data URL（FileReader；失败转可读错误） */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new ImageCompressionError('图片编码结果读取失败'));
    reader.readAsDataURL(blob);
  });
}

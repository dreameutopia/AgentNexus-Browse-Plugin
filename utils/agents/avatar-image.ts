/**
 * 头像图片处理（上传 → 智能裁剪 → 压缩 → data URL）。
 *
 * 流程：
 *   1. 解码用户选择的图片文件（createImageBitmap）；
 *   2. 智能裁剪为正方形：优先人脸检测（FaceDetector，扩展页面不可用时自动跳过），
 *      无人脸时按构图启发式取景——竖图重心偏上（人像主体通常在上三分之一），
 *      横图居中；
 *   3. 缩放到 AGENT_AVATAR_OUTPUT_SIZE（512px）并按质量阶梯编码，
 *      直到体积 ≤ 1MB 且 data URL 长度 ≤ 存储上限（AGENT_AVATAR_IMAGE_MAX_CHARS）。
 *
 * 输出为 data URL（{ type: 'image', src } 直接可存可渲染），
 * 与 utils/image-utils.compressImage 的区别：本模块专注头像场景——
 * 固定方形构图 + 1MB 硬上限，调用方无需再关心裁剪与体积。
 */

import { AGENT_AVATAR_IMAGE_MAX_CHARS } from './agent-types';

/** 头像体积硬上限：1MB（含 base64 编码前的原始字节） */
export const AGENT_AVATAR_MAX_BYTES = 1024 * 1024;

/** 头像输出边长（px）：头像展示尺寸远小于此值，512 足够清晰又天然远离体积上限 */
export const AGENT_AVATAR_OUTPUT_SIZE = 512;

/** 编码质量阶梯（从高到低依次尝试，命中即止） */
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.7, 0.62, 0.55, 0.5] as const;

/** 支持的编码格式（WebP 体积最优且支持透明；老实现回退 JPEG） */
const ENCODE_FORMATS = ['image/webp', 'image/jpeg'] as const;

/** 人脸检测结果（归一化到源图像素坐标） */
interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 取景窗口（源图像素坐标） */
interface CropWindow {
  x: number;
  y: number;
  side: number;
}

/** 图片无法作为头像使用时抛出的错误 message（UI 据此区分文案） */
export const AVATAR_ERR_NOT_IMAGE = 'avatar-not-image';
export const AVATAR_ERR_PROCESS_FAILED = 'avatar-process-failed';

/**
 * 处理用户上传的头像图片：智能裁剪为方形 + 压缩到 1MB 内，返回 data URL。
 *
 * @param file 用户选择的图片文件（accept="image/*" 已在 UI 层把关，这里再防御一次）
 * @returns 可直接写入 AgentConfig.avatar.src 的 data URL
 * @throws Error message 为 AVATAR_ERR_* 常量，供 UI 映射到 i18n 文案
 */
export async function processAvatarImage(file: Blob): Promise<string> {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error(AVATAR_ERR_NOT_IMAGE);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(AVATAR_ERR_PROCESS_FAILED);
  }

  try {
    if (!bitmap.width || !bitmap.height) throw new Error(AVATAR_ERR_PROCESS_FAILED);

    const face = await detectFace(bitmap);
    const crop = computeSmartCrop(bitmap.width, bitmap.height, face);

    const size = AGENT_AVATAR_OUTPUT_SIZE;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(AVATAR_ERR_PROCESS_FAILED);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, crop.x, crop.y, crop.side, crop.side, 0, 0, size, size);

    return await encodeWithinLimits(canvas);
  } catch (error) {
    if (error instanceof Error && error.message === AVATAR_ERR_PROCESS_FAILED) throw error;
    throw new Error(AVATAR_ERR_PROCESS_FAILED);
  } finally {
    bitmap.close();
  }
}

/**
 * 智能取景：把源图裁为正方形窗口。
 *
 * - 有人脸 → 以人脸为中心（垂直方向略偏下取眼神线），保证人脸完整入画；
 * - 无人脸 → 竖图重心偏上 38%（人像主体常见位置），横图居中；
 * - 窗口始终钳制在图像边界内。
 */
export function computeSmartCrop(width: number, height: number, face?: FaceBox): CropWindow {
  const side = Math.min(width, height);
  let centerX = width / 2;
  let centerY = height / 2;

  if (face && face.width > 0 && face.height > 0) {
    centerX = face.x + face.width / 2;
    // 眼睛大致位于人脸框上 45% 处，取景中心略压在眼线上，留出下巴与头顶呼吸感
    centerY = face.y + face.height * 0.45;
  } else if (height > width * 1.15) {
    // 竖图：主体（人像）通常偏上，取景中心上移到约 38% 高度
    centerY = height * 0.38;
  }

  const x = clamp(centerX - side / 2, 0, width - side);
  const y = clamp(centerY - side / 2, 0, height - side);
  return { x, y, side };
}

/**
 * 人脸检测：FaceDetector（Shape Detection API）在扩展页面通常不可用，
 * 不可用或检测失败时返回 undefined，由 computeSmartCrop 走构图启发式。
 */
async function detectFace(bitmap: ImageBitmap): Promise<FaceBox | undefined> {
  const Ctor = (globalThis as { FaceDetector?: new (options?: unknown) => { detect: (b: ImageBitmap) => Promise<{ boundingBox: DOMRectReadOnly }[]> } }).FaceDetector;
  if (typeof Ctor !== 'function') return undefined;
  try {
    const detector = new Ctor({ fastMode: true, maxDetectedFaces: 1 });
    const faces = await detector.detect(bitmap);
    const box = faces?.[0]?.boundingBox;
    if (!box) return undefined;
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  } catch {
    return undefined;
  }
}

/**
 * 按质量阶梯编码，命中「≤1MB 且 ≤ 存储字符上限」即返回。
 * 首轮不达标时把画布降采样到一半再走一轮（理论上 512px 不会触发，属兜底）。
 */
async function encodeWithinLimits(canvas: OffscreenCanvas): Promise<string> {
  const first = await encodeWithQualityLadder(canvas);
  if (first) return first;

  // 兜底：降采样到 256px 重新编码
  const size = Math.floor(AGENT_AVATAR_OUTPUT_SIZE / 2);
  const scaled = new OffscreenCanvas(size, size);
  const ctx = scaled.getContext('2d');
  if (!ctx) throw new Error(AVATAR_ERR_PROCESS_FAILED);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, size, size);
  const second = await encodeWithQualityLadder(scaled);
  if (second) return second;

  throw new Error(AVATAR_ERR_PROCESS_FAILED);
}

/** 质量阶梯 × 格式矩阵，返回首个同时满足体积与字符上限的 data URL */
async function encodeWithQualityLadder(canvas: OffscreenCanvas): Promise<string | undefined> {
  // 记录「格式回落」产生的实际 MIME：不支持的格式 convertToBlob 会静默回落 PNG，
  // 回落结果与质量无关，只需产出一次，避免同一 PNG 按质量重复尝试 N 次
  const fellBackTypes = new Set<string>();
  // JPEG 无 alpha 通道：透明区域会直接变黑，故编码前先铺白底（惰性构建一次）
  let jpegSource: OffscreenCanvas | undefined;

  for (const quality of QUALITY_STEPS) {
    for (const format of ENCODE_FORMATS) {
      let source = canvas;
      if (format === 'image/jpeg') {
        if (!jpegSource) jpegSource = flattenOntoWhite(canvas);
        source = jpegSource;
      }
      let blob: Blob;
      try {
        blob = await source.convertToBlob({ type: format, quality });
      } catch {
        continue;
      }
      // 请求格式未生效（回落到其它 MIME）且该 MIME 已产出过 → 跳过
      if (blob.type !== format) {
        if (fellBackTypes.has(blob.type)) continue;
        fellBackTypes.add(blob.type);
      }
      if (blob.size > AGENT_AVATAR_MAX_BYTES) continue;
      const dataUrl = await blobToDataURL(blob);
      if (dataUrl.length > AGENT_AVATAR_IMAGE_MAX_CHARS) continue;
      return dataUrl;
    }
  }
  return undefined;
}

/** 复制画布并铺不透明白底（供 JPEG 编码使用，避免透明区域渲染为黑色） */
function flattenOntoWhite(canvas: OffscreenCanvas): OffscreenCanvas {
  const flat = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = flat.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(canvas, 0, 0);
  }
  return flat;
}

/** Blob → data URL（OffscreenCanvas 环境无 FileReader 依赖的同步路径） */
function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(AVATAR_ERR_PROCESS_FAILED));
    reader.readAsDataURL(blob);
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

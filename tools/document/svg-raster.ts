/**
 * 栅格化工具：SVG → PNG 兜底、Word 认不出的位图格式 → PNG
 *
 * ==================== 为什么需要这一层 ====================
 *
 * docx@9 的 `docx/html` 只认 PNG / JPEG / GIF / BMP / SVG 五种格式：
 * 其余（WebP / AVIF / TIFF / ICO）会被判为 "unsupported-image" 而**整张丢弃**
 * （只有 warning，产物里就少了一张图）。而 SVG 虽然被接受，**没有 PNG 兜底时
 * 在旧版 Word / Pages / LibreOffice 里显示为空白**（docx 内部塞的是 1px 透明
 * 像素占位）。
 *
 * 因此两条产物管线都需要一层「统一的可显示格式」归一：
 * - 矢量图（mermaid 图表、远程 SVG）→ 额外产出 PNG 兜底，Word 新旧版本都能显示；
 * - 冷门位图格式（WebP/AVIF…）→ 栅格化成 PNG，PDF 与 Word 看到同一张图。
 *
 * ==================== 降级原则 ====================
 *
 * 栅格化**永远不抛错**：没有 DOM（Node 测试环境）就没有 canvas，返回 null，
 * 由调用方决定「无兜底」或「整图降级为替代文本」。SVG 的 PNG 兜底失败不阻断
 * 矢量图本身（新版 Word 仍能显示 SVG）。
 *
 * ==================== 尺寸护栏 ====================
 *
 * canvas 有硬上限（单边 16384px、总面积约 2.68 亿像素），超过就会得到空白图或
 * 直接抛错。这里统一收敛到「单边 ≤16000px、总面积 ≤6400 万像素」，超出时
 * 等比缩小而非拒绝——图还在，只是变小了。
 */

/** canvas 单边像素上限（留出余量，避开浏览器硬上限） */
const MAX_CANVAS_EDGE = 16_000;

/** canvas 总像素上限（约 8000×8000，兼顾内存与浏览器上限） */
const MAX_CANVAS_PIXELS = 64_000_000;

/** 图片解码超时（毫秒） */
const DEFAULT_DECODE_TIMEOUT_MS = 15_000;

/** 缺省画布尺寸（SVG 未给出尺寸时按此估算） */
const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;

/** 是否具备栅格化所需的 DOM 能力 */
function hasRasterSupport(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof Image !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  );
}

/**
 * 计算落在护栏内的画布尺寸：等比缩小，绝不放大。
 *
 * @param naturalWidth  原图宽（像素）
 * @param naturalHeight 原图高（像素）
 */
export function fitCanvasSize(
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number } {
  let width = Math.max(1, Math.round(naturalWidth) || DEFAULT_WIDTH);
  let height = Math.max(1, Math.round(naturalHeight) || DEFAULT_HEIGHT);
  const edge = Math.max(width, height);
  if (edge > MAX_CANVAS_EDGE) {
    const scale = MAX_CANVAS_EDGE / edge;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  const pixels = width * height;
  if (pixels > MAX_CANVAS_PIXELS) {
    const scale = Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  return { width, height };
}

/**
 * 加载图片元素（带解码超时守卫）。
 *
 * 超时/解码失败一律 reject，由调用方降级——绝不留下悬挂的 Promise。
 */
function loadImageElement(url: string, timeoutMs: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      image.src = '';
      finish(() => reject(new Error('图片解码超时')));
    }, timeoutMs);
    image.onload = () => finish(() => resolve(image));
    image.onerror = () => finish(() => reject(new Error('图片解码失败')));
    image.src = url;
  });
}

/**
 * 把已解码的图片元素画到白底 canvas 上并导出 PNG data URL。
 *
 * 白底是刻意的：SVG 透明背景直接转 PNG 会得到透明图，暗色查看器下不可读。
 */
function imageToPngDataUrl(image: HTMLImageElement): string | null {
  const width = image.naturalWidth || image.width || DEFAULT_WIDTH;
  const height = image.naturalHeight || image.height || DEFAULT_HEIGHT;
  const size = fitCanvasSize(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(image, 0, 0, size.width, size.height);
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.startsWith('data:image/png') ? dataUrl : null;
}

/**
 * SVG → PNG data URL（DOCX 的矢量图兜底）。
 *
 * @param svg SVG 原文
 * @returns PNG data URL；无 DOM / 解码失败 / 画布不可用时返回 null
 */
export async function svgToPngDataUrl(
  svg: string,
  timeoutMs: number = DEFAULT_DECODE_TIMEOUT_MS,
): Promise<string | null> {
  if (!hasRasterSupport() || typeof svg !== 'string' || !svg.trim()) return null;
  let url = '';
  try {
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    url = URL.createObjectURL(blob);
    const image = await loadImageElement(url, timeoutMs);
    return imageToPngDataUrl(image);
  } catch {
    return null;
  } finally {
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // 释放失败不影响产物
      }
    }
  }
}

/**
 * 任意位图 → PNG data URL（把 Word 认不出的格式归一成 PNG）。
 *
 * @param bytes 图片字节
 * @param mime  图片 MIME（决定浏览器的解码器）
 * @returns PNG data URL；无 DOM / 解码失败时返回 null
 */
export async function rasterizeToPngDataUrl(
  bytes: Uint8Array,
  mime: string,
  timeoutMs: number = DEFAULT_DECODE_TIMEOUT_MS,
): Promise<string | null> {
  if (!hasRasterSupport() || !bytes?.byteLength) return null;
  let url = '';
  try {
    // 精确拷贝字节区间：Uint8Array 视图的 buffer 可能更大，直接传会带上多余尾巴
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([buffer], { type: mime || 'application/octet-stream' });
    url = URL.createObjectURL(blob);
    const image = await loadImageElement(url, timeoutMs);
    return imageToPngDataUrl(image);
  } catch {
    return null;
  } finally {
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // 释放失败不影响产物
      }
    }
  }
}

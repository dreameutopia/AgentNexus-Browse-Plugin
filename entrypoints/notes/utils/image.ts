/**
 * 图片文件 → dataURL（插入富文本正文前的压缩与校验）
 *
 * 策略：
 * - gif / svg 原样读取（动画与矢量不重编码）；
 * - 其余位图仅在「最长边 > 1600px 或文件 > 800KB」时才走 canvas 重编码，
 *   png 保持 png（透明通道不丢），jpeg/webp 压为 jpeg；
 * - 超过 15MB 直接拒绝，防止正文体积失控。
 */

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const COMPRESS_EDGE = 1600;
const COMPRESS_SIZE_THRESHOLD = 800 * 1024;
const JPEG_QUALITY = 0.85;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

/**
 * 读取并（按需）压缩图片文件为 dataURL。
 * 失败抛出带可读中文原因的 Error，由调用方提示用户。
 */
export async function imageFileToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('所选文件不是图片');
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('图片超过 15MB 上限，请压缩后再插入');
  }

  const raw = await readFileAsDataUrl(file);

  // 动画 / 矢量原样保留
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') {
    return raw;
  }

  const img = await loadImage(raw);
  const maxEdge = Math.max(img.naturalWidth, img.naturalHeight);
  const needCompress = maxEdge > COMPRESS_EDGE || file.size > COMPRESS_SIZE_THRESHOLD;
  if (!needCompress) return raw;

  const scale = Math.min(1, COMPRESS_EDGE / maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return raw;

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  try {
    // png 保留透明通道；其余压为 jpeg
    return file.type === 'image/png'
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } catch {
    // canvas 导出失败（极少数编码器问题）：回退原始数据
    return raw;
  }
}

/** 过滤出图片类型的文件列表 */
export function pickImageFiles(files: Iterable<File> | FileList | null | undefined): File[] {
  if (!files) return [];
  return Array.from(files).filter((file) => file.type.startsWith('image/'));
}

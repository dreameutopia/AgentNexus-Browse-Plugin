/**
 * 导出文件落盘工具：文件名清洗 + Blob 下载
 */

/** 文件名非法字符（Windows / macOS / Linux 通用保留集）与 C0 控制字符 */
// eslint-disable-next-line no-control-regex -- 刻意匹配控制字符以从文件名中剔除
const INVALID_FILE_NAME_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

/**
 * 清洗导出文件名：剔除非法字符、折叠空白、限制长度；
 * 空结果回退为 "note"，保证下载文件名永远合法。
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(INVALID_FILE_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return (cleaned || 'note').slice(0, 80);
}

/** 触发浏览器下载（延时释放对象 URL，兼容 Safari） */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

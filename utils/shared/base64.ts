/**
 * ArrayBuffer → base64（跨层共享的唯一实现）
 *
 * 分块转换规避 String.fromCharCode 的超长参数栈溢出（单次 ≤ 0x8000 字节）。
 *
 * 使用方（此前各自内联同构实现，已收敛至此）：
 *   - tools/office/xlsx-tool.ts        Service Worker 下 data: URL 下载
 *   - utils/stream/vision.ts           Blob → data URL（视觉预处理）
 *   - sidepanel utils/chat/attachment-parser.ts  附件图片 → 多模态 data URL
 *
 * 纯函数、零依赖：sidepanel / hub / background（Service Worker）上下文皆可引用。
 */

/** ArrayBuffer / TypedArray → base64 字符串（不含 data: 前缀与 MIME） */
export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

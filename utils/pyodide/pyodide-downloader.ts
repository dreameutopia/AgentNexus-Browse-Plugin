/**
 * Pyodide 重型载荷下载器（流式进度 + 可取消 + 缓存直读）
 *
 * - 先查 IndexedDB 缓存，命中直接返回（零网络，UI 标记 fromCache）；
 * - 未命中则 fetch 流式读取，按 content-length 汇报进度（无 content-length
 *   时仅汇报已收字节数），支持 AbortController 取消；
 * - 下载成功即写入缓存（调用方负责失败时不落盘——本函数只在完整收完
 *   响应体后才 put，半截文件不会污染缓存）。
 */

import { PyodideCacheEntry, getFile, putFile } from './pyodide-cache';

export interface DownloadResult {
  buffer: ArrayBuffer;
  contentType: string;
  size: number;
  /** true = 命中本地缓存，未发生网络请求 */
  fromCache: boolean;
}

export interface DownloadOptions {
  /** 进度回调（received 已收字节；total 为 -1 表示未知） */
  onProgress?: (received: number, total: number) => void;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 缓存/响应内容类型提示（响应头缺失时回退） */
  contentTypeFallback?: string;
}

/** 从 URL 提取展示文件名 */
function urlToLabel(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last || url;
  } catch {
    return url;
  }
}

/**
 * 下载（或从缓存读取）一个文件。
 * @throws Error（含 "已取消" 字样时视为用户主动取消）
 */
export async function downloadPyodideFile(url: string, options: DownloadOptions = {}): Promise<DownloadResult> {
  const cached = await getFile(url);
  if (cached) {
    options.onProgress?.(cached.size, cached.size);
    return { buffer: cached.data, contentType: cached.contentType, size: cached.size, fromCache: true };
  }

  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status} ${urlToLabel(url)}`);
  }

  const contentType = response.headers.get('content-type')?.split(';')[0] || options.contentTypeFallback || 'application/octet-stream';
  const totalHeader = Number(response.headers.get('content-length'));
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : -1;

  let buffer: ArrayBuffer;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        options.onProgress?.(received, total);
      }
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    buffer = merged.buffer;
  } else {
    buffer = await response.arrayBuffer();
    options.onProgress?.(buffer.byteLength, total);
  }

  const entry: PyodideCacheEntry = {
    url,
    data: buffer,
    contentType,
    size: buffer.byteLength,
    storedAt: Date.now(),
  };
  await putFile(entry);

  return { buffer, contentType, size: buffer.byteLength, fromCache: false };
}

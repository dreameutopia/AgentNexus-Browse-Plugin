/**
 * Pyodide 重型载荷下载器（流式进度 + 可取消 + 缓存直读）
 *
 * - 先查 IndexedDB 缓存，命中直接返回（零网络，UI 标记 fromCache）；
 * - 未命中则 fetch 流式读取，按 content-length 汇报进度（无 content-length
 *   时仅汇报已收字节数），支持 AbortController 取消；
 * - 下载成功即写入缓存（调用方负责失败时不落盘——本函数只在完整收完
 *   响应体后才 put，半截文件不会污染缓存）。
 */

import { PyodideCacheEntry, deleteFile, getFile, putFile } from './pyodide-cache';
import { getPyodideEnvState, withPyodideEnvLock } from './pyodide-env';

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
  environmentId?: string;
  /** 缓存/响应内容类型提示（响应头缺失时回退） */
  contentTypeFallback?: string;
  /**
   * 期望的 sha256（hex，官方锁文件提供）。提供时在写缓存前校验：
   * 不匹配抛错且**不落盘**（防污染缓存）——缓存命中路径同样校验，
   * 因为缓存条目可能来自其它写入方。预下载通道必须传入。
   */
  expectedSha256?: string;
}

/** 计算 ArrayBuffer 的 sha256（hex 小写） */
async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
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
  const mutateCache = (mutation: () => Promise<void>) => {
    options.signal?.throwIfAborted();
    if (!options.environmentId) return mutation();
    return withPyodideEnvLock(async () => {
      const state = await getPyodideEnvState();
      if (state.environmentId !== options.environmentId || state.status === 'idle') {
        throw new Error('Python environment changed during the download');
      }
      options.signal?.throwIfAborted();
      await mutation();
    }, options.signal);
  };
  const verify = async (buffer: ArrayBuffer): Promise<void> => {
    if (!options.expectedSha256) return;
    const actual = await sha256Hex(buffer);
    if (actual !== options.expectedSha256.toLowerCase()) {
      throw new Error(`sha256 校验失败：${urlToLabel(url)}（期望 ${options.expectedSha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
    }
  };

  const cached = await getFile(url);
  if (cached) {
    let cacheValid = true;
    try {
      await verify(cached.data);
    } catch (error) {
      if ((error as Error).message.includes('已取消')) throw error;
      // 缓存条目损坏（校验不过）：删除自愈并回落网络重下，
      // 否则坏条目会让后续每次命中都抛错、永远无法恢复。
      cacheValid = false;
      await mutateCache(() => deleteFile(url).catch(() => undefined));
    }
    if (cacheValid) {
      options.signal?.throwIfAborted();
      options.onProgress?.(cached.size, cached.size);
      return { buffer: cached.data, contentType: cached.contentType, size: cached.size, fromCache: true };
    }
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

  // 先校验再落盘：校验不过的字节绝不进缓存（污染缓存会让后续所有命中都失败）
  await verify(buffer);

  const entry: PyodideCacheEntry = {
    url,
    data: buffer,
    contentType,
    size: buffer.byteLength,
    storedAt: Date.now(),
  };
  await mutateCache(() => putFile(entry));

  return { buffer, contentType, size: buffer.byteLength, fromCache: false };
}

// ==================== 批量预下载（管理中心「一键预下载」） ====================

/** 预下载条目：官方锁文件目录项（wheel URL + 期望 sha256） */
export interface PreloadItem {
  /** 展示名（失败报告用，如 "numpy"） */
  name: string;
  url: string;
  /** 官方锁文件提供的 sha256（必填——预下载通道强制校验） */
  sha256: string;
}

export interface PreloadProgress {
  /** 已完成（成功+失败）条数 */
  done: number;
  total: number;
  /** 累计写入/命中缓存的字节数 */
  bytes: number;
  /** 当前正在下载的条目名（idle 时为空串） */
  current: string;
}

export interface PreloadFailure {
  name: string;
  reason: string;
}

export interface PreloadResult {
  /** 成功总数（= cached + downloaded） */
  succeeded: number;
  /** 其中命中本地缓存的条数（零网络） */
  cached: number;
  /** 其中实际发生网络下载的条数 */
  downloaded: number;
  bytes: number;
  /** 逐条失败隔离：单个坏 wheel 不影响其余 */
  failures: PreloadFailure[];
  /** true = 用户取消（已完成部分保留） */
  cancelled: boolean;
}

export interface PreloadOptions {
  /** 并发上限（默认 4——CDN 友好且不至于拖垮主线程 IDB 写入） */
  concurrency?: number;
  signal?: AbortSignal;
  environmentId?: string;
  onProgress?: (progress: PreloadProgress) => void;
}

/**
 * 批量预下载 wheel 到本地缓存（仅缓存，**不**注册为已安装）。
 *
 * 设计要点：
 * - 并发受限的 worker-pool：比 Promise.all 全量并发温和（346 个 wheel 时
 *   不会瞬间打出上百个连接）；
 * - 逐条失败隔离：HTTP 失败 / sha256 不符只记入 failures，不中断批次；
 * - 取消语义：signal 触发后停止派发新任务，在途任务尽量跑完（其结果保留），
 *   返回 cancelled=true——已完成的缓存写入不回滚（幂等，下次续传即可）；
 * - 进度回调：done/total/bytes/current，UI 据此渲染进度条。
 */
export async function preloadWheels(
  items: readonly PreloadItem[],
  options: PreloadOptions = {},
): Promise<PreloadResult> {
  const total = items.length;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  const failures: PreloadFailure[] = [];
  let nextIndex = 0;
  let done = 0;
  let bytes = 0;
  let succeeded = 0;
  let cached = 0;
  let downloaded = 0;
  let cancelled = false;

  const report = (current: string) => {
    options.onProgress?.({ done, total, bytes, current });
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) {
        cancelled = true;
        return;
      }
      const index = nextIndex++;
      if (index >= total) return;
      const item = items[index];
      report(item.name);
      try {
        const result = await downloadPyodideFile(item.url, {
          expectedSha256: item.sha256,
          signal: options.signal,
          environmentId: options.environmentId,
          contentTypeFallback: 'application/octet-stream',
        });
        bytes += result.size;
        succeeded += 1;
        if (result.fromCache) cached += 1;
        else downloaded += 1;
        done += 1;
        report('');
      } catch (error) {
        // 取消导致的中止不算失败也不算完成（done 保持准确，UI 进度不虚高）
        if (options.signal?.aborted) {
          cancelled = true;
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ name: item.name, reason: message.slice(0, 300) });
        done += 1;
        report('');
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(total, 1)) }, () => worker()),
  );
  if (options.signal?.aborted) cancelled = true;

  return { succeeded, cached, downloaded, bytes, failures, cancelled };
}

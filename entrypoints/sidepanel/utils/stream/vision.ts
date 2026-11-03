/**
 * 视觉输入预处理 — 基于协议能力声明做统一规范化
 *
 * 规则（与 AdapterCapabilities 对应）：
 *   1. 请求不含图片 → 原样返回，零开销
 *   2. 协议不支持视觉 → 明确抛错（绝不静默丢图，否则模型会"看不见"却以为看得见）
 *   3. remoteImageUrl === 'native' → 远程 URL 原样透传（OpenAI/Claude/Responses）
 *   4. remoteImageUrl === 'base64' → 下载远程图片转成 data URL（Gemini inlineData / Ollama images 只接受 base64）
 *
 * 下载结果做小容量缓存，保证「重试不会重复下载」。
 */

import type { AdapterCapabilities, ProviderType, StreamRequestConfig } from './types';
import { ApiRequestError, PermanentRequestError } from './errors';
import { t } from '@/utils/i18n/core';
import { arrayBufferToBase64 } from '@/utils/shared/base64';

/** 远程图片下载上限：10MB */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 下载超时 */
const IMAGE_FETCH_TIMEOUT_MS = 20000;
/** data URL 缓存容量（URL → data URL） */
const MAX_CACHE_ENTRIES = 20;

/** 已下载图片缓存：重试 / 多轮对话复用 */
const remoteImageCache = new Map<string, string>();

/** 是否包含图片内容 */
function containsImage(config: StreamRequestConfig): boolean {
  return config.messages.some(
    msg => Array.isArray(msg.content) && msg.content.some(item => item?.type === 'image_url')
  );
}

/** 收集所有远程（非 data:）图片 URL，保序去重 */
function collectRemoteImageUrls(config: StreamRequestConfig): string[] {
  const urls: string[] = [];
  for (const msg of config.messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const item of msg.content) {
      const url = item?.type === 'image_url' ? item.image_url?.url : undefined;
      if (url && !url.startsWith('data:') && !urls.includes(url)) {
        urls.push(url);
      }
    }
  }
  return urls;
}

/** Blob → data URL（分块 base64 复用共享实现，Node 与浏览器通用，便于契约测试） */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const mime = blob.type || 'image/png';
  return `data:${mime};base64,${arrayBufferToBase64(buffer)}`;
}

/** 下载远程图片并转 data URL（带缓存） */
async function fetchAsDataUrl(url: string): Promise<string> {
  const cached = remoteImageCache.get(url);
  if (cached) return cached;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
  } catch (error: any) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    // 结构化错误（可分类展示 + 进入统一重试判定：超时/网络可重试）
    throw new ApiRequestError({
      url,
      timeoutMs: isTimeout ? IMAGE_FETCH_TIMEOUT_MS : undefined,
      summary: t('sidepanel.apiConfig.imageFetchNetwork', {
        url,
        reason: isTimeout
          ? t('sidepanel.apiConfig.apiRequestTimeout', {
              seconds: Math.round(IMAGE_FETCH_TIMEOUT_MS / 1000),
            })
          : error?.message || String(error),
      }),
      cause: error,
    });
  }
  if (!response.ok) {
    // 图片 4xx（过期签名/不存在）对同一 URL 是确定性失败 → 带状态码的结构化错误
    throw new ApiRequestError({
      url,
      status: response.status,
      statusText: response.statusText,
      summary: t('sidepanel.apiConfig.imageFetchHttp', { status: response.status, url }),
    });
  }

  // 大小预检：content-length 可信时先拒，避免先吃满内存再发现超限
  const declaredLength = Number(response.headers?.get?.('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw new PermanentRequestError(
      t('sidepanel.apiConfig.imageTooLarge', { max: MAX_IMAGE_BYTES / 1024 / 1024, url }),
    );
  }

  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_BYTES) {
    // 内容本身超限：同一图片重试必然同样超限 → 永久错误，不进重试
    throw new PermanentRequestError(
      t('sidepanel.apiConfig.imageTooLarge', { max: MAX_IMAGE_BYTES / 1024 / 1024, url }),
    );
  }

  const dataUrl = await blobToDataUrl(blob);

  // 简单 LRU：满了先删最早插入的
  if (remoteImageCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = remoteImageCache.keys().next().value;
    if (oldest !== undefined) remoteImageCache.delete(oldest);
  }
  remoteImageCache.set(url, dataUrl);
  return dataUrl;
}

/** 用替换表克隆消息内容（image_url.url 被替换为 data URL） */
function replaceImageUrls(
  config: StreamRequestConfig,
  replacements: Map<string, string>
): StreamRequestConfig {
  return {
    ...config,
    messages: config.messages.map(msg => {
      if (!Array.isArray(msg.content)) return msg;
      return {
        ...msg,
        content: msg.content.map(item => {
          if (item?.type !== 'image_url' || !item.image_url) return item;
          const mapped = replacements.get(item.image_url.url);
          if (!mapped) return item;
          return { ...item, image_url: { ...item.image_url, url: mapped } };
        }),
      };
    }),
  };
}

/** 仅供测试：清空下载缓存 */
export function clearVisionCache(): void {
  remoteImageCache.clear();
}

/**
 * 请求前的视觉内容规范化
 *
 * @throws 协议不支持图片 / 图片下载失败（含 URL 与原因，便于定位）
 */
export async function prepareVisionRequest(
  provider: ProviderType,
  capabilities: AdapterCapabilities,
  config: StreamRequestConfig
): Promise<StreamRequestConfig> {
  if (!containsImage(config)) {
    return config;
  }

  if (!capabilities.vision) {
    // 确定性能力失败：同一协议重试必然同样失败 → 永久错误（不进重试循环）
    throw new PermanentRequestError(t('sidepanel.apiConfig.visionUnsupported', { provider }));
  }

  const remoteUrls = collectRemoteImageUrls(config);
  if (remoteUrls.length === 0) {
    return config; // 全是 data URL，各家都能直接吃
  }

  if (capabilities.remoteImageUrl === 'native') {
    return config; // 原生支持远程 URL，透传
  }

  const replacements = new Map<string, string>();
  for (const url of remoteUrls) {
    replacements.set(url, await fetchAsDataUrl(url));
  }

  console.log(`[Vision] 已为协议 ${provider} 预处理 ${replacements.size} 张远程图片为 base64`);
  return replaceImageUrls(config, replacements);
}

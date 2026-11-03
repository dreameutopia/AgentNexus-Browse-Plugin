/**
 * Provider 端点工具 — 实际请求地址预览 + 模型列表自动获取
 *
 * 设计原则：
 * 1. 「实际请求地址」永远委托给现有 stream 适配器（OpenAI/Ollama/Gemini/Claude）计算，
 *    保证弹窗展示的地址与真正发起的对话请求逐字节一致，避免两套拼接逻辑漂移。
 * 2. 模型列表获取走各协议的官方只读端点：
 *    - OpenAI : GET {base}/models            （Bearer 认证，返回 {data:[{id}]}）
 *    - Ollama : GET {base}/api/tags          （无认证，返回 {models:[{name}]}）
 *    - Gemini : GET {base}/v1beta/models     （?key= 认证，返回 {models:[{name:"models/..."}]}，分页）
 *    - Claude : GET {base}/v1/models         （x-api-key + anthropic-version，返回 {data:[{id}]}，分页）
 * 3. 任何失败都抛出 ModelListError，携带「完整响应体」，由 UI 以弹窗形式渲染完整 JSON。
 */

import type { ProviderType } from '../stream/types';
import { streamClient } from '../stream/stream-client';
import { driverRegistry } from '../stream/driver-registry';
import { extractErrorSummary, prettyJson } from '../stream/errors';
import { t } from '@/utils/i18n/core';

// ==================== 实际请求地址 ====================

export interface EndpointQuery {
  provider: ProviderType;
  baseUrl: string;
  apiKey?: string;
  /** 当前生效模型（Gemini 端点会把模型名写进 URL） */
  model?: string;
}

/**
 * 计算对话真正会请求的 URL（与 StreamClient.resolveRequestUrl 同源：
 * 一律经适配器的 buildRequestUrl / getRequestUrl 分派，绝不 instanceof 协议）
 * 无法计算（未配置地址 / 协议未知）时返回空串，由 UI 隐藏该行。
 */
export function resolveActualRequestUrl(query: EndpointQuery): string {
  const baseUrl = (query.baseUrl || '').trim();
  if (!baseUrl) return '';
  try {
    new URL(baseUrl);
  } catch {
    return '';
  }
  try {
    const adapter = streamClient.getAdapter(query.provider);
    const apiKey = query.apiKey?.trim();
    if (adapter.buildRequestUrl) {
      return adapter.buildRequestUrl(baseUrl, apiKey, query.model);
    }
    return adapter.getRequestUrl(baseUrl, query.model);
  } catch (error) {
    console.warn('[ProviderEndpoint] 计算实际请求地址失败:', error);
    return '';
  }
}

// ==================== 模型列表获取 ====================

/** 携带完整响应体的获取失败异常 */
export class ModelListError extends Error {
  /** 完整响应内容（JSON 美化后的字符串或原始文本），用于弹窗完整渲染 */
  readonly detail: string;
  readonly status?: number;

  constructor(message: string, detail = '', status?: number) {
    super(message);
    this.name = 'ModelListError';
    this.detail = detail;
    this.status = status;
  }
}

export interface ModelListQuery {
  provider: ProviderType;
  baseUrl: string;
  apiKey?: string;
}

/** 单次请求超时 */
const MODEL_LIST_TIMEOUT_MS = 30000;
/** 分页拉取的最大页数保护（防止异常服务无限翻页） */
const MAX_PAGES = 10;
/** 分页大小 */
const PAGE_SIZE = 200;

/** 去除尾部斜杠 */
function trimBaseUrl(baseUrl: string): string {
  return (baseUrl || '').trim().replace(/\/+$/, '');
}

/** 美化 JSON（解析失败则原样返回文本）— 复用 stream 层共享实现，避免两套逻辑漂移 */
const prettyPrint = prettyJson;

/** 从各类错误响应体中提取可读摘要 — 复用 stream 层共享实现（含非 JSON 网关页降级） */
function extractErrorMessage(body: any): string | null {
  return extractErrorSummary(undefined, body);
}

/** 发起一次 JSON 请求，网络层失败也会转成 ModelListError */
async function requestJson(
  url: string,
  headers: Record<string, string>
): Promise<{ status: number; statusText: string; raw: string; body: any }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    });
  } catch (error: any) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ModelListError(t('sidepanel.apiConfig.fetchTimeout', { seconds: MODEL_LIST_TIMEOUT_MS / 1000 }));
    }
    throw new ModelListError(
      t('sidepanel.apiConfig.fetchNetworkError'),
      error?.stack || error?.message || String(error)
    );
  }

  const raw = await response.text();
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }

  return { status: response.status, statusText: response.statusText, raw, body };
}

/** 统一的失败抛出：message 给人看，detail 给弹窗渲染完整 JSON */
function fail(
  message: string,
  raw: string,
  status: number,
  body: any
): never {
  const summary = extractErrorMessage(body);
  throw new ModelListError(
    summary ? `${message}: ${summary}` : `${message} (HTTP ${status})`,
    prettyPrint(raw),
    status
  );
}

/** 从任意候选字段里收集模型名（不同网关返回结构略有差异） */
function collectNames(source: any, keys: string[]): string[] {
  if (!source || typeof source !== 'object') return [];
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      const names: string[] = [];
      for (const item of value) {
        if (typeof item === 'string') {
          names.push(item);
        } else if (item && typeof item === 'object') {
          const name = item.id ?? item.name ?? item.model ?? item.model_name;
          if (typeof name === 'string') names.push(name);
        }
      }
      if (names.length) return names;
    }
  }
  return [];
}

/** 拉取单页并校验 HTTP 状态 */
async function fetchPage(
  url: string,
  headers: Record<string, string>
): Promise<{ raw: string; body: any }> {
  const { status, statusText, raw, body } = await requestJson(url, headers);
  if (status < 200 || status >= 300) {
    fail(t('sidepanel.apiConfig.fetchHttpError', { status, statusText }), raw, status, body);
  }
  if (body === undefined) {
    throw new ModelListError(t('sidepanel.apiConfig.fetchInvalidJson'), raw, status);
  }
  return { raw, body };
}

/**
 * 按协议获取可用模型列表
 *
 * @throws {ModelListError} 失败时 message 为摘要、detail 为完整响应体
 */
export async function fetchModelList(query: ModelListQuery): Promise<string[]> {
  const baseUrl = trimBaseUrl(query.baseUrl);
  if (!baseUrl) {
    throw new ModelListError(t('sidepanel.apiConfig.fillServiceUrlFirst'));
  }
  try {
    new URL(baseUrl);
  } catch {
    throw new ModelListError(t('sidepanel.apiConfig.invalidServiceUrl'), baseUrl);
  }

  const apiKey = (query.apiKey || '').trim();
  // 密钥要求由协议驱动策略声明（driver-registry），与连通性探测同一事实源——
  // 新增免密钥协议时两处同时生效，不再各自硬编码协议白名单
  if (driverRegistry.requiresApiKey(query.provider) && !apiKey) {
    throw new ModelListError(t('sidepanel.apiConfig.fillApiKeyFirst'));
  }

  const names: string[] = [];

  switch (query.provider) {
    // OpenAI 与 Responses 共用同一份模型列表端点 /models
    case 'openai':
    case 'openai-responses': {
      const url = /\/models\/?$/.test(baseUrl) ? baseUrl : `${baseUrl}/models`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const { raw, body } = await fetchPage(url, headers);
      names.push(...collectNames(body, ['data', 'models', 'results']));
      if (!names.length) throw new ModelListError(t('sidepanel.apiConfig.fetchNoModels'), prettyPrint(raw));
      break;
    }

    case 'ollama': {
      let url: string;
      if (baseUrl.includes('/api/tags')) {
        url = baseUrl;
      } else if (baseUrl.includes('/chat/completions')) {
        url = baseUrl.replace('/chat/completions', '/api/tags');
      } else if (/\/v\d+[a-z]*$/i.test(baseUrl)) {
        // OpenAI 风格地址（如 http://host:11434/v1）→ 还原成 Ollama 原生根路径
        url = `${baseUrl.replace(/\/v\d+[a-z]*$/i, '')}/api/tags`;
      } else {
        url = `${baseUrl}/api/tags`;
      }
      const { raw, body } = await fetchPage(url, { 'Content-Type': 'application/json' });
      names.push(...collectNames(body, ['models', 'data']));
      if (!names.length) throw new ModelListError(t('sidepanel.apiConfig.fetchNoModelsOllama'), prettyPrint(raw));
      break;
    }

    case 'gemini': {
      let pageToken = '';
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams();
        if (apiKey) params.set('key', apiKey);
        params.set('pageSize', String(PAGE_SIZE));
        if (pageToken) params.set('pageToken', pageToken);
        const url = `${baseUrl}/v1beta/models?${params.toString()}`;
        const { raw, body } = await fetchPage(url, { 'Content-Type': 'application/json' });
        const list = Array.isArray(body?.models) ? body.models : [];
        for (const item of list) {
          if (!item || typeof item !== 'object') continue;
          // 过滤掉仅支持 embedContent 等非生成能力的模型（字段存在时才过滤）
          const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : null;
          if (methods && !methods.includes('generateContent') && !methods.includes('streamGenerateContent')) {
            continue;
          }
          const name = typeof item.name === 'string' ? item.name : '';
          if (name) names.push(name.replace(/^models\//, ''));
        }
        const next = typeof body?.nextPageToken === 'string' ? body.nextPageToken : '';
        if (!next) break;
        pageToken = next;
      }
      if (!names.length) {
        throw new ModelListError(t('sidepanel.apiConfig.fetchNoModels'));
      }
      break;
    }

    case 'claude': {
      let afterId = '';
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (afterId) params.set('after_id', afterId);
        const url = /\/v1\/models/.test(baseUrl)
          ? `${baseUrl}?${params.toString()}`
          : `${baseUrl}/v1/models?${params.toString()}`;
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': apiKey,
        };
        const { raw, body } = await fetchPage(url, headers);
        names.push(...collectNames(body, ['data', 'models']));
        if (body?.has_more !== true) break;
        const next = typeof body?.last_id === 'string' ? body.last_id : '';
        if (!next || next === afterId) break;
        afterId = next;
      }
      if (!names.length) throw new ModelListError(t('sidepanel.apiConfig.fetchNoModels'));
      break;
    }

    default:
      throw new ModelListError(t('sidepanel.apiConfig.unsupportedProtocol', { provider: query.provider }));
  }

  // 去重保序
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  if (!result.length) {
    throw new ModelListError(t('sidepanel.apiConfig.fetchNoModels'));
  }
  return result;
}

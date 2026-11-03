/**
 * 连通性探测（连接测试）—— 复用协议适配器
 *
 * 设计意图：
 *   API 配置弹窗的「测试可用性」原先在组件里手写了一整套 per-protocol 的
 *   URL / Header / Body 拼接（约 150 行），与 stream 适配器是**两份实现**，
 *   一旦适配器修了（例如 Ollama 的 /v1 前缀还原），测试逻辑就会漂移。
 *   现在统一走 `streamClient.getAdapter()`：
 *     - URL / Header / Body 全部由适配器产出 → 与真实对话请求同源
 *     - 仅把 `stream` 关掉（探测只要状态码与错误体，不解析 SSE）
 *     - Gemini 的非流式是另一个 method，单独走 getAuthenticatedUrlNonStream
 *
 * 错误处理：
 *   所有失败都抛 ApiRequestError（含 status + 完整原始响应 JSON + 单行摘要），
 *   由调用方直接展示，403 / 429 / 密钥失效等都能看到服务端原文。
 */

import { streamClient } from './stream-client';
import { driverRegistry } from './driver-registry';
import { ApiRequestError, parseJsonSafe } from './errors';
import { normalizeUsageFromBody } from './adapters/usage-normalize';
import { aiUsageMetrics, summarizeErrorForMetrics } from '../metrics/usage-metrics-engine';
import { t } from '@/utils/i18n/core';
import type { ProviderType, StreamRequestConfig } from './types';

export interface ProbeQuery {
  provider: ProviderType;
  baseUrl: string;
  apiKey?: string;
  /** 必填：要验证可用性的模型 */
  model: string;
  /** 超时（毫秒），默认 30s */
  timeoutMs?: number;
  /** 输出 token 上限，默认 5（最小化成本） */
  maxTokens?: number;
}

export interface ProbeSuccess {
  /** 从发起请求到读完响应体的耗时 */
  latencyMs: number;
  /** 原始响应文本 */
  raw: string;
  /** 解析后的 JSON；非 JSON 时为 undefined */
  parsed: any;
}

/** 探测默认超时 */
export const PROBE_TIMEOUT_MS = 30000;

/**
 * 发起一次最小化非流式请求，验证「地址 + 密钥 + 模型」是否可用
 *
 * @throws {ApiRequestError} HTTP 错误 / 200 但含 error 字段 / 超时 / 网络不可达
 * @throws {Error} 入参不合法（调用方通常已用 canTest 预先拦截）
 */
export async function probeConnection(query: ProbeQuery): Promise<ProbeSuccess> {
  const baseUrl = (query.baseUrl || '').trim();
  if (!baseUrl) throw new Error('probeConnection: baseUrl is required');
  try {
    new URL(baseUrl);
  } catch {
    throw new Error('probeConnection: invalid baseUrl');
  }

  const model = (query.model || '').trim();
  if (!model) throw new Error('probeConnection: model is required');

  const apiKey = (query.apiKey || '').trim();
  // 密钥要求由协议驱动策略声明（driver-registry），不再在探测层硬编码协议白名单
  if (driverRegistry.requiresApiKey(query.provider) && !apiKey) {
    throw new Error('probeConnection: apiKey is required');
  }

  const provider = query.provider;
  const adapter = streamClient.getAdapter(provider);
  const timeoutMs = query.timeoutMs ?? PROBE_TIMEOUT_MS;

  // 最小化请求：一句话 + 极小输出上限
  const requestConfig: StreamRequestConfig = {
    model,
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: query.maxTokens ?? 5,
  };

  const body = adapter.buildRequestBody(requestConfig);
  // 适配器为对话链路固定产出流式请求；探测只需状态码与错误体 → 关掉 stream。
  // OpenAI 请求体上的 stream_options 仅对流式有意义，非流式一并摘除，
  // 避免严格网关对「非流式 + stream_options」的组合返回 400。
  if (body && typeof body === 'object' && 'stream' in body) {
    body.stream = false;
    delete body.stream_options;
  }

  let url: string;
  if (adapter.buildProbeUrl) {
    // 流式/非流式是不同 method 的协议（Gemini）经可选接口分派；
    // 其余协议回落 getRequestUrl（探测只需状态码与错误体）
    url = adapter.buildProbeUrl(baseUrl, apiKey, model);
  } else {
    url = adapter.getRequestUrl(baseUrl, model);
  }

  const headers = adapter.getRequestHeaders(apiKey);

  // ---- 用量指标：探测也是真实 AI 请求（消耗少量 token），计入统计（kind='probe'） ----
  try {
    const startTime = Date.now();
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: any) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new ApiRequestError({ provider, url, timeoutMs, cause: error });
      }
      // 网络不可达（DNS / CORS / 服务未启动）
      throw new ApiRequestError({ provider, url, cause: error });
    }

    const latencyMs = Date.now() - startTime;
    const raw = await response.text().catch(() => '');

    if (!response.ok) {
      throw new ApiRequestError({
        provider,
        url,
        status: response.status,
        statusText: response.statusText,
        rawBody: raw,
      });
    }

    const parsed = parseJsonSafe(raw);

    // 200 但不是合法 JSON（地址指向网页 / 网关返回 HTML 登录页 / 空响应体）：
    // 绝不能判成「连接成功」——否则用户以为地址+密钥可用，正式对话才暴露问题
    if (parsed === undefined) {
      throw new ApiRequestError({
        provider,
        url,
        status: response.status,
        statusText: response.statusText,
        summary: t('sidepanel.apiConfig.nonApiResponseBody'),
        rawBody: raw,
      });
    }

    // 某些网关 HTTP 200 但 body 里带 error 字段 → 同样算失败，且必须展示原始 JSON
    if (parsed && typeof parsed === 'object' && (parsed.error || parsed.message?.error)) {
      throw new ApiRequestError({
        provider,
        url,
        status: response.status,
        statusText: response.statusText,
        rawBody: raw,
      });
    }

    aiUsageMetrics.record({
      provider,
      model,
      kind: 'probe',
      outcome: 'success',
      usage: normalizeUsageFromBody(provider, parsed),
    });
    return { latencyMs, raw, parsed };
  } catch (error) {
    aiUsageMetrics.record({
      provider,
      model,
      kind: 'probe',
      outcome: 'failed',
      errorSummary: summarizeErrorForMetrics(error),
    });
    throw error;
  }
}

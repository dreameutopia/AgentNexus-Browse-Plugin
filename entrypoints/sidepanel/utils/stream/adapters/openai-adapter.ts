/**
 * OpenAI 协议适配器
 * 
 * 适用于：
 * - OpenAI 官方 API (GPT-3.5/4/4o 等)
 * - 兼容 OpenAI 格式的服务（DeepSeek、Moonshot、通义千问等）
 * - Ollama 本地模型（原生兼容 OpenAI /v1/chat/completions 格式）
 * 
 * SSE 格式：
 *   data: {"choices":[{"delta":{"content":"xxx"},"finish_reason":null}]}
 *   data: [DONE]
 */

import { BaseAdapter, type StreamAccumulator } from './base-adapter';
import { ApiRequestError, createInBandError } from '../errors';
import { mergeUsageSafe, normalizeOpenAIUsage } from './usage-normalize';
import type {
  AdapterCapabilities,
  ProviderType,
  StreamRequestConfig,
  StreamCallbacks,
  UnifiedToolDefinition,
} from '../types';

export class OpenAIAdapter extends BaseAdapter {
  readonly providerType: ProviderType = 'openai';

  /** 能力：图片（url/data URL 均可）、工具、推理流（reasoning_content） */
  readonly capabilities: AdapterCapabilities = {
    vision: true,
    remoteImageUrl: 'native',
    tools: true,
    reasoning: true,
  };

  /**
   * OpenAI 格式的请求体 — 基本直接透传
   * Ollama 同样兼容此格式
   */
  buildRequestBody(config: StreamRequestConfig): any {
    const body: any = {
      model: config.model,
      messages: config.messages,
      stream: true,
    };

    // 流式 usage 上报：OpenAI 官方要求显式开启，末 chunk（choices 为空）才会带 usage。
    // 兼容性：个别旧网关不认识该参数会返回 400 —— StreamClient 层有自动降级
    // （去掉该参数立即重发一次，并按端点记忆），不影响既有可用性。
    if (body.stream) {
      body.stream_options = { include_usage: true };
    }

    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.promptCacheKey) body.prompt_cache_key = config.promptCacheKey;
    if (config.max_tokens !== undefined) body.max_tokens = config.max_tokens;
    if (config.top_p !== undefined) body.top_p = config.top_p;
    if (config.frequency_penalty !== undefined) body.frequency_penalty = config.frequency_penalty;
    if (config.presence_penalty !== undefined) body.presence_penalty = config.presence_penalty;

    // 工具定义
    if (config.tools && config.tools.length > 0) {
      body.tools = config.tools;
      body.tool_choice = config.tool_choice ?? 'auto';
    }

    return body;
  }

  /**
   * OpenAI 标准端点
   * Ollama: http://localhost:11434/v1/chat/completions
   * OpenAI: https://api.openai.com/v1/chat/completions
   */
  getRequestUrl(baseUrl: string): string {
    // 如果 baseUrl 已经包含完整路径，直接使用
    if (baseUrl.includes('/chat/completions')) {
      return baseUrl;
    }
    // 确保 URL 以 /chat/completions 结尾
    const base = baseUrl.replace(/\/$/, '');
    return `${base}/chat/completions`;
  }

  /**
   * OpenAI 标准 Bearer Token 认证
   * Ollama 不需要认证，apiKey 可为空
   */
  getRequestHeaders(
    apiKey?: string,
    customHeaders?: Record<string, string>
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    if (customHeaders) {
      Object.assign(headers, customHeaders);
    }
    return headers;
  }

  /**
   * 解析 OpenAI SSE 单行
   */
  protected parseSSELine(
    line: string,
    acc: StreamAccumulator,
    callbacks: StreamCallbacks
  ): boolean {
    const data = this.extractSSEData(line);
    if (data === null) return false;

    // OpenAI 流结束标记
    if (data === '[DONE]') {
      if (!acc.finishReason) acc.finishReason = 'stop';
      return true; // 流结束
    }

    try {
      const chunk = JSON.parse(data);

      // 某些网关在流内直接下发错误对象（HTTP 仍是 200）→ 必须先于空 choices 判定
      if (chunk.error) {
        const err = chunk.error;
        throw createInBandError({
          prefix: 'OpenAI API error',
          message: typeof err === 'string' ? err : err?.message,
          rawEvent: err,
          provider: this.providerType,
        });
      }

      // token 消耗：stream_options.include_usage 开启时，末 chunk 携带 usage 且 choices 为空，
      // 必须先于「空 choices 早退」解析，否则永远丢失。
      // 部分网关（DeepSeek / 某些 vLLM）会在每个 chunk 重复携带累计快照 — last-wins 合并天然正确。
      if (chunk.usage && typeof chunk.usage === 'object') {
        acc.usage = mergeUsageSafe(acc.usage, normalizeOpenAIUsage(chunk.usage));
      }

      // 某些提供商可能在某些 chunk 中返回空 choices
      if (!chunk.choices || chunk.choices.length === 0) {
        return false;
      }

      const choice = chunk.choices[0];
      const delta = choice.delta;

      // 结束原因
      if (choice.finish_reason) {
        acc.finishReason = choice.finish_reason;
      }

      // 推理/思考内容（如 DeepSeek 的 reasoning_content）
      if (delta?.reasoning_content) {
        this.handleReasoningToken(delta.reasoning_content, acc, callbacks);
      }

      // 普通文本内容
      if (delta?.content) {
        this.handleContentToken(delta.content, acc, callbacks);
      }

      // 工具调用（流式增量）
      if (delta?.tool_calls) {
        for (const toolCallDelta of delta.tool_calls) {
          // index 防御：网关可能下发字符串下标 / 缺失 / 非数字——
          // 一律收敛为非负整数，否则 Map 键混型会让组装排序退化为 NaN
          const rawIndex: unknown = toolCallDelta.index;
          const parsedIndex = typeof rawIndex === 'number' ? rawIndex : Number(rawIndex);
          const index = Number.isInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : 0;

          if (!acc.toolCallChunks.has(index)) {
            acc.toolCallChunks.set(index, { id: '', name: '', arguments: '' });
          }
          const chunk = acc.toolCallChunks.get(index)!;

          if (toolCallDelta.id) {
            chunk.id = toolCallDelta.id;
          }
          if (toolCallDelta.function?.name) {
            chunk.name += toolCallDelta.function.name;
          }
          if (toolCallDelta.function?.arguments) {
            chunk.arguments += toolCallDelta.function.arguments;
          }
        }
      }
    } catch (parseError) {
      // 流内 in-band 错误必须向上抛，否则会静默退化成空回复
      if (parseError instanceof ApiRequestError && parseError.kind === 'inband') {
        throw parseError;
      }
      // 单个坏 chunk 容错跳过，但计数留痕（全部行都坏 → 终态校验兜底成协议错误）
      this.recordParseFailure(acc, line);
      console.warn('[OpenAIAdapter] Failed to parse SSE chunk:', parseError, 'Line:', line.trim());
    }

    return false; // 继续读取
  }
}

/**
 * Ollama 协议适配器
 * 
 * 适用于：
 * - Ollama 本地模型服务
 * - 使用 Ollama 原生 API 格式 (/api/chat)
 * 
 * Ollama /api/chat 端点：
 *   请求格式与 OpenAI 类似但有差异
 *   SSE 格式：每行返回 JSON，{"message":{"content":"xxx"},"done":false}
 *   最终行：{"message":{"content":""},"done":true}
 * 
 * 注意：Ollama 也兼容 OpenAI 格式 (/v1/chat/completions)，
 * 但用户要求使用原生 /api/chat 端点
 */

import { BaseAdapter, type StreamAccumulator } from './base-adapter';
import { ApiRequestError, createInBandError } from '../errors';
import { mergeUsageSafe, normalizeOllamaUsage } from './usage-normalize';
import { nativeItems, setNativeItems } from './native-replay';
import type {
  AdapterCapabilities,
  ProviderType,
  StreamRequestConfig,
  StreamCallbacks,
  UnifiedToolDefinition,
} from '../types';

export class OllamaAdapter extends BaseAdapter {
  readonly providerType: ProviderType = 'ollama';

  /** 能力：图片（仅 base64，远程 URL 需预处理）、工具；无独立推理流 */
  readonly capabilities: AdapterCapabilities = {
    vision: true,
    remoteImageUrl: 'base64',
    tools: true,
    reasoning: true,
  };

  /**
   * Ollama 原生 /api/chat 请求体
   */
  buildRequestBody(config: StreamRequestConfig): any {
    // 转换消息格式：Ollama 多模态使用 images 数组而非嵌套 content
    const messages = config.messages.map(msg => {
      const thinking = nativeItems(msg, config, 'ollama')?.[0]?.thinking;
      const base = { role: msg.role, content: msg.content,
        ...(msg.name ? { name: msg.name } : {}), ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
        ...(msg.tool_calls ? { tool_calls: msg.tool_calls.map(({ geminiThoughtSignature: _signature, ...call }) => call) } : {}),
        ...(typeof thinking === 'string' ? { thinking } : {}),
      };
      if (typeof msg.content === 'string') {
        return base;
      }

      // 多模态内容 — 提取文本和图片
      if (Array.isArray(msg.content)) {
        const texts: string[] = [];
        const images: string[] = [];

        for (const item of msg.content) {
          if (item.type === 'text' && item.text) {
            texts.push(item.text);
          } else if (item.type === 'image_url' && item.image_url?.url) {
            const url = item.image_url.url;
            if (url.startsWith('data:')) {
              // data:image/png;base64,xxx → 提取纯 base64 部分
              const base64 = url.split(',')[1];
              if (base64) images.push(base64);
            } else {
              // 非 base64 URL — Ollama 不支持远程 URL 图片
              texts.push(`[Image URL: ${url}]`);
            }
          }
        }

        const converted: any = {
          ...base,
          content: texts.join('\n'),
        };
        if (images.length > 0) {
          converted.images = images;
        }
        // 保留工具相关字段
        if (msg.tool_calls) converted.tool_calls = msg.tool_calls.map(({ geminiThoughtSignature: _signature, ...call }) => call);
        if (msg.tool_call_id) converted.tool_call_id = msg.tool_call_id;
        if (msg.name) converted.name = msg.name;
        return converted;
      }

      return base;
    });

    const body: any = {
      model: config.model,
      messages,
      stream: true,
    };

    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.max_tokens !== undefined) {
      // Ollama 使用 num_predict 而非 max_tokens
      body.options = { ...(body.options || {}), num_predict: config.max_tokens };
    }
    if (config.top_p !== undefined) {
      body.options = { ...(body.options || {}), top_p: config.top_p };
    }
    if (config.frequency_penalty !== undefined) {
      body.options = { ...(body.options || {}), frequency_penalty: config.frequency_penalty };
    }
    if (config.presence_penalty !== undefined) {
      body.options = { ...(body.options || {}), presence_penalty: config.presence_penalty };
    }

    // Ollama 支持工具调用（较新版本）
    if (config.tools && config.tools.length > 0) {
      body.tools = config.tools;
    }

    return body;
  }

  /**
   * Ollama 原生端点
   * http://localhost:11434/api/chat
   */
  getRequestUrl(baseUrl: string): string {
    if (baseUrl.includes('/api/chat')) {
      return baseUrl;
    }
    let base = baseUrl.replace(/\/+$/, '');
    // 兼容 OpenAI 风格地址：先摘掉 /chat/completions 尾巴
    if (base.includes('/chat/completions')) {
      base = base.replace('/chat/completions', '');
    }
    // 再剥掉 /v1 之类的版本前缀（否则会拼出 /v1/api/chat）
    base = base.replace(/\/v\d+[a-z]*$/i, '');
    return `${base}/api/chat`;
  }

  /**
   * Ollama 通常不需要认证
   */
  getRequestHeaders(
    apiKey?: string,
    customHeaders?: Record<string, string>
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // Ollama 不需要 Authorization，但支持自定义 header
    if (customHeaders) {
      Object.assign(headers, customHeaders);
    }
    return headers;
  }

  /**
   * 解析 Ollama SSE 单行
   * 
   * Ollama 每行返回一个独立 JSON：
   *   {"model":"llama3","message":{"role":"assistant","content":"xxx"},"done":false}
   *   最后：{"model":"llama3","message":{"role":"assistant","content":""},"done":true}
   */
  protected parseSSELine(
    line: string,
    acc: StreamAccumulator,
    callbacks: StreamCallbacks
  ): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;

    try {
      const chunk = JSON.parse(trimmed);

      // 流内错误（HTTP 仍是 200 时 Ollama 也可能带出 error 字段）：
      // 必须先于 done/message 判定，否则模型加载失败等会静默退化成空回复
      if (chunk.error) {
        const err = chunk.error;
        throw createInBandError({
          prefix: 'Ollama API error',
          message: typeof err === 'string' ? err : err?.message,
          rawEvent: err,
          provider: this.providerType,
        });
      }

      // Ollama 流结束标记
      if (chunk.done) {
        // token 消耗：done=true 的末行携带 prompt_eval_count / eval_count，
        // 新版另有 prompt_eval_cached_count（提示缓存命中）
        acc.usage = mergeUsageSafe(acc.usage, normalizeOllamaUsage(chunk));
        // 统一语义：有工具调用时优先标记 tool_calls（与其它协议一致）
      }

      // 文本内容
      const message = chunk.message;
      if (typeof message?.thinking === 'string' && message.thinking) {
        const previous = acc.finalMessage.nativeReplay?.items[0]?.thinking ?? '';
        setNativeItems(acc.finalMessage, 'ollama', [{ thinking: previous + message.thinking }]);
        this.handleReasoningToken(message.thinking, acc, callbacks);
      }
      if (message && message.content) {
        this.handleContentToken(message.content, acc, callbacks);
      }

      // 工具调用（Ollama 新版本支持）：追加到末尾空位（键恒为 0..size-1 连续）
      // 而非按 chunk 内下标——网关把多个 tool_calls 拆到多行时，按下标 set 会让后行覆盖前行
      if (message && message.tool_calls && message.tool_calls.length > 0) {
        for (const tc of message.tool_calls) {
          acc.toolCallChunks.set(acc.toolCallChunks.size, this.parseToolCall(tc));
        }
      }

      if (chunk.done) {
        acc.finishReason = acc.toolCallChunks.size > 0 ? 'tool_calls' : acc.finishReason || 'stop';
        return true;
      }
      return false; // 继续处理
    } catch (parseError) {
      // 流内 in-band 错误必须向上抛；其余（非 JSON 行等）容错跳过并留痕
      if (parseError instanceof ApiRequestError && parseError.kind === 'inband') {
        throw parseError;
      }
      this.recordParseFailure(acc, line);
      console.warn('[OllamaAdapter] Failed to parse SSE line:', parseError, 'Line:', trimmed);
      return false;
    }
  }

  /**
   * 解析 Ollama 工具调用格式
   */
  private parseToolCall(tc: any): { id: string; name: string; arguments: string } {
    return {
      id: tc.id || `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: tc.function?.name || tc.name || '',
      arguments: typeof tc.function?.arguments === 'string'
        ? tc.function.arguments
        : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
    };
  }

  /**
   * 将统一工具定义转换为 Ollama 格式
   * Ollama 工具格式与 OpenAI 相同
   */
  protected convertTools(tools: UnifiedToolDefinition[]): any[] {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      },
    }));
  }
}

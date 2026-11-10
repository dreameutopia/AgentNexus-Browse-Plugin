/**
 * Gemini 协议适配器
 * 
 * 适用于 Google Gemini API (gemini-pro, gemini-1.5-pro 等)
 * 
 * Gemini 的 SSE 流格式与 OpenAI 不同：
 *   - 端点: /v1beta/models/{model}:streamGenerateContent?key=API_KEY
 *   - 格式: data: {"candidates":[{"content":{"parts":[{"text":"xxx"}]}}]}
 *   - 无 [DONE] 标记，流结束即完成
 *   - 工具调用格式: functionCall { name, args }
 * 
 * 参考: https://ai.google.dev/api/generate-content
 */

import { BaseAdapter, type StreamAccumulator } from './base-adapter';
import { ApiRequestError, createInBandError } from '../errors';
import { mergeUsageSafe, normalizeGeminiUsage } from './usage-normalize';
import { parseReplayArguments, parseReplayToolResponse } from './unified-normalize';
import { nativeItems, setNativeItems } from './native-replay';
import { splitLeadingCompactionProduct } from './compaction-product';
import type {
  AdapterCapabilities,
  ProviderType,
  StreamRequestConfig,
  StreamCallbacks,
  UnifiedChatMessage,
  UnifiedToolCall,
  UnifiedToolDefinition,
} from '../types';

export class GeminiAdapter extends BaseAdapter {
  readonly providerType: ProviderType = 'gemini';

  /** 能力：图片（仅 base64 inlineData，远程 URL 需预处理）、工具；无独立推理流 */
  readonly capabilities: AdapterCapabilities = {
    vision: true,
    remoteImageUrl: 'base64',
    tools: true,
    reasoning: true,
  };

  /**
   * 将统一消息格式转换为 Gemini generateContent 格式
   * 
   * Gemini 格式:
   * {
   *   contents: [{ role: "user"|"model", parts: [{ text: "..." }] }],
   *   systemInstruction: { parts: [{ text: "..." }] },
   *   tools: [{ functionDeclarations: [...] }]
   * }
   */
  buildRequestBody(config: StreamRequestConfig): any {
    const body: any = {};

    // 系统指令：全部 system 消息按出现顺序合并
    // （保证「压缩摘要记忆」等附加系统消息不会被静默丢弃）
    //
    // 首条压缩记忆（assistant 角色的上下文压缩消息）：并入系统指令——
    // Gemini 的 contents 必须以 user 角色开头（multiturn 校验），压缩记忆
    // 本就是系统级上下文；并入后 wire 形态与压缩前逐字一致。
    const { product, rest } = splitLeadingCompactionProduct(config.messages);
    const systemTexts = config.messages
      .filter(m => m.role === 'system')
      .map(m => this.plainTextOf(m.content))
      .filter(text => text.length > 0);
    if (product && rest.length > 0) {
      const productText = this.plainTextOf(product.content);
      if (productText.length > 0) systemTexts.push(productText);
    }
    if (systemTexts.length > 0) {
      body.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
    }

    // 退化情形（整段上下文只剩压缩记忆）：contents 不得为空且首条须为 user，
    // 此时把压缩记忆降为 user 轮承载（文本原样，wire 角色归一）
    const wireMessages: readonly UnifiedChatMessage[] =
      rest.length > 0 ? rest : product ? [{ ...product, role: 'user' as const }] : [];

    // tool_call_id → 工具名映射：Gemini 的 functionResponse 按「名称」配对（非 id），
    // 优先取消息自带 name，缺失时回查对应 assistant.tool_calls
    const toolNameById = new Map<string, string>();
    const nativeCallIds = new Set<string>();
    for (const msg of wireMessages) {
      if (msg.role !== 'assistant') continue;
      for (const part of nativeItems(msg, config, 'gemini') ?? []) {
        if (typeof part.functionCall?.id === 'string') nativeCallIds.add(part.functionCall.id);
      }
      for (const tc of msg.tool_calls ?? []) {
        if (tc.id) toolNameById.set(tc.id, tc.function.name);
      }
    }

    // 对话内容：折叠为 user/model 严格交替的 contents。
    // Gemini 对连续同角色 content 返回 400（"multiturn requests must alternate between
    // user and model"），并行工具调用的多条 tool 消息必须合入同一 user 轮的多个
    // functionResponse part —— 这是跨协议回放历史的硬约束。
    const contents: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
    const pushTurn = (role: 'user' | 'model', parts: any[]) => {
      if (parts.length === 0) return;
      const last = contents[contents.length - 1];
      if (last && last.role === role) {
        last.parts.push(...parts);
      } else {
        contents.push({ role, parts });
      }
    };

    for (const msg of wireMessages) {
      if (msg.role === 'system') continue;

      // 工具结果 → functionResponse（user 轮；响应体经防御性解析恒为对象）
      if (msg.role === 'tool') {
        const name = msg.name || toolNameById.get(msg.tool_call_id || '') || 'unknown_tool';
        pushTurn('user', [
          {
            functionResponse: {
              ...(msg.tool_call_id && nativeCallIds.has(msg.tool_call_id) ? { id: msg.tool_call_id } : {}),
              name,
              response: parseReplayToolResponse(msg.content),
            },
          },
        ]);
        continue;
      }

      // 助手消息 → 文本 + functionCall（参数经防御性解析，永不抛错）
      if (msg.role === 'assistant') {
        const native = nativeItems(msg, config, 'gemini');
        if (native?.length) { pushTurn('model', native); continue; }
        const parts: any[] = [];
        const text = this.plainTextOf(msg.content);
        if (text) parts.push({ text });
        for (const tc of msg.tool_calls ?? []) {
          parts.push({
            ...(!msg.nativeReplay && typeof tc.geminiThoughtSignature === 'string' && tc.geminiThoughtSignature ? { thoughtSignature: tc.geminiThoughtSignature } : {}),
            functionCall: {
              name: tc.function.name,
              args: parseReplayArguments(tc.function.arguments),
            },
          });
        }
        pushTurn('model', parts);
        continue;
      }

      // 用户消息：纯文本或多模态（text + inlineData）
      const parts: any[] = [];
      if (typeof msg.content === 'string') {
        if (msg.content) parts.push({ text: msg.content });
      } else {
        for (const item of msg.content) {
          if (item.type === 'text' && item.text) {
            parts.push({ text: item.text });
          } else if (item.type === 'image_url' && item.image_url) {
            const url = item.image_url.url;
            if (url.startsWith('data:')) {
              // Gemini 使用 inlineData 格式
              const [header, base64] = url.split(',');
              const mimeType = header.match(/data:(.*?);/)?.[1] || 'image/png';
              parts.push({ inlineData: { mimeType, data: base64 } });
            } else {
              // 远程 URL 由请求前的视觉预处理统一转 base64；此处兜底为文本占位
              parts.push({ text: `[Image URL: ${url}]` });
            }
          }
        }
      }
      pushTurn('user', parts);
    }
    body.contents = contents;

    // 生成配置：采样参数仅在显式指定时携带。
    // maxOutputTokens 不设兜底值——省略时 Gemini 按模型能力取最大输出，
    // 产品层不封装输出上限（见 StreamRequestConfig.max_tokens 契约注释）
    const generationConfig: Record<string, unknown> = {};
    if (config.temperature !== undefined) generationConfig.temperature = config.temperature;
    if (config.top_p !== undefined) generationConfig.topP = config.top_p;
    if (config.max_tokens !== undefined) generationConfig.maxOutputTokens = config.max_tokens;
    body.generationConfig = generationConfig;

    // 工具定义 — 转换为 Gemini functionDeclarations 格式
    if (config.tools && config.tools.length > 0) {
      body.tools = [{
        functionDeclarations: config.tools.map(tool => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      }];
    }

    return body;
  }

  /**
   * Gemini 端点格式
   * /v1beta/models/{model}:streamGenerateContent?alt=sse&key=API_KEY
   */
  getRequestUrl(baseUrl: string, model?: string): string {
    const base = baseUrl.replace(/\/$/, '');
    const modelName = model || 'gemini-pro';
    return `${base}/v1beta/models/${modelName}:streamGenerateContent?alt=sse`;
  }

  /**
   * Gemini 使用 URL 参数传递 API Key，不用 Header
   */
  getRequestHeaders(
    apiKey?: string,
    customHeaders?: Record<string, string>
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (customHeaders) {
      Object.assign(headers, customHeaders);
    }
    return headers;
  }

  /**
   * 重写 getRequestUrl 以支持在 URL 中嵌入 API Key
   */
  getAuthenticatedUrl(baseUrl: string, apiKey?: string, model?: string): string {
    const url = this.getRequestUrl(baseUrl, model);
    if (apiKey) {
      return `${url}&key=${apiKey}`;
    }
    return url;
  }

  /**
   * 非流式端点（连通性测试用）：/v1beta/models/{model}:generateContent
   * 流式与非流式是两个不同的 method，不能复用 getRequestUrl
   */
  getRequestUrlNonStream(baseUrl: string, model?: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    const modelName = model || 'gemini-pro';
    return `${base}/v1beta/models/${modelName}:generateContent`;
  }

  /** 非流式 + key（同样把 key 放 query） */
  getAuthenticatedUrlNonStream(baseUrl: string, apiKey?: string, model?: string): string {
    const url = this.getRequestUrlNonStream(baseUrl, model);
    return apiKey ? `${url}?key=${apiKey}` : url;
  }

  /**
   * 协议接口：流式请求 URL（key 嵌入 query 的协议在此统一实现）。
   * 消费方（StreamClient / 模型列表 / 连通性探测）经 ProtocolAdapter 可选方法
   * 分派，绝不各自 instanceof 具体适配器——驱动注册表是协议清单的唯一事实源。
   */
  buildRequestUrl(baseUrl: string, apiKey?: string, model?: string): string {
    return this.getAuthenticatedUrl(baseUrl, apiKey, model);
  }

  /** 协议接口：连通性探测（非流式）URL——Gemini 流式/非流式是不同 method */
  buildProbeUrl(baseUrl: string, apiKey?: string, model?: string): string {
    return apiKey
      ? this.getAuthenticatedUrlNonStream(baseUrl, apiKey, model)
      : this.getRequestUrlNonStream(baseUrl, model);
  }

  /**
   * 解析 Gemini SSE 单行
   * 
   * Gemini 格式示例:
   * data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}]}
   */
  protected parseSSELine(
    line: string,
    acc: StreamAccumulator,
    callbacks: StreamCallbacks
  ): boolean {
    const data = this.extractSSEData(line);
    if (data === null) return false;

    try {
      const chunk = JSON.parse(data);

      if (chunk.error) {
        const err = chunk.error;
        throw createInBandError({
          prefix: 'Gemini API error',
          message: typeof err === 'string' ? err : err?.message,
          rawEvent: err,
          provider: this.providerType,
        });
      }

      if (!chunk.candidates || chunk.candidates.length === 0) {
        // 无 candidates 的 chunk 也可能携带 usageMetadata（部分网关在末尾单独下发计数），
        // 先合并再早退
        if (chunk.usageMetadata) {
          acc.usage = mergeUsageSafe(acc.usage, normalizeGeminiUsage(chunk.usageMetadata));
        }
        return false;
      }

      // token 消耗：每个 chunk 都可能带 usageMetadata 快照，末 chunk 才完整（last-wins）
      if (chunk.usageMetadata) {
        acc.usage = mergeUsageSafe(acc.usage, normalizeGeminiUsage(chunk.usageMetadata));
      }

      const candidate = chunk.candidates[0];
      const parts = candidate.content?.parts || [];

      // 结束原因
      if (candidate.finishReason) {
        // Gemini: STOP, MAX_TOKENS, SAFETY, RECITATION, OTHER
        const reasonMap: Record<string, string> = {
          STOP: 'stop',
          MAX_TOKENS: 'length',
          SAFETY: 'content_filter',
          // RECITATION = 引用受限被拦截，语义上同属内容过滤——
          // 未映射会产出上层未知的 'recitation'，截断原因在下游丢失
          RECITATION: 'content_filter',
        };
        acc.finishReason = reasonMap[candidate.finishReason] || candidate.finishReason.toLowerCase();
      }

      for (const part of parts) {
        const items = acc.finalMessage.nativeReplay?.items ?? [];
        const previous = items[items.length - 1];
        // Coalesce only unsigned text deltas. Signed/empty parts keep their
        // exact boundaries, including a signature-only final streaming chunk.
        if (typeof part.text === 'string' && !part.thoughtSignature && previous && typeof previous.text === 'string' &&
            !previous.thoughtSignature && previous.thought === part.thought && !part.functionCall) previous.text += part.text;
        else items.push(structuredClone(part));
        setNativeItems(acc.finalMessage, 'gemini', items);
        // 文本内容
        if (part.text) {
          if (part.thought === true) this.handleReasoningToken(part.text, acc, callbacks);
          else this.handleContentToken(part.text, acc, callbacks);
        }

        // 函数/工具调用（回调统一在 finalizeAccumulator 流末尾补发，与其它协议同语义；
        // 流中发射会让同一调用在重试守卫/消费方两侧产生时序差异）
        if (part.functionCall) {
          const callId = typeof part.functionCall.id === 'string' ? part.functionCall.id : `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const toolCall: UnifiedToolCall = {
            ...(typeof part.thoughtSignature === 'string' ? { geminiThoughtSignature: part.thoughtSignature } : {}),
            id: callId,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {}),
            },
          };

          if (!acc.finalMessage.tool_calls) {
            acc.finalMessage.tool_calls = [];
          }
          acc.finalMessage.tool_calls.push(toolCall);
        }
      }

      // 统一语义：只要产生了工具调用，finishReason 就归一化为 tool_calls——
      // 但仅覆盖 null/stop：MAX_TOKENS/SAFETY/RECITATION 截断优先，绝不能把
      // 「参数被截断的残缺工具调用」冒充成完整 tool_calls（放 parts 处理之后，
      // 避免同 chunk 内的 STOP 覆盖工具语义）
      if (
        acc.finalMessage.tool_calls &&
        acc.finalMessage.tool_calls.length > 0 &&
        (acc.finishReason === null || acc.finishReason === 'stop')
      ) {
        acc.finishReason = 'tool_calls';
      }
    } catch (parseError) {
      // 流内 in-band 错误必须向上抛；其余坏行容错跳过并留痕
      if (parseError instanceof ApiRequestError && parseError.kind === 'inband') {
        throw parseError;
      }
      this.recordParseFailure(acc, line);
      console.warn('[GeminiAdapter] Failed to parse SSE chunk:', parseError, 'Line:', line.trim());
    }

    return false; // Gemini 没有 [DONE] 标记，依赖流结束 + 末 chunk 的 finishReason
  }
}

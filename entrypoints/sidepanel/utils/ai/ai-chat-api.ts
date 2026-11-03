/**
 * AI对话API — 多协议统一版
 *
 * 支持 OpenAI / Ollama / Gemini / Claude / OpenAI Responses 五种协议，
 * 通过 stream 适配器自动将请求/响应转换为对应协议格式。
 *
 * 工具调用（function calling）在所有协议下均可用：
 *   - OpenAI / Ollama：直接透传 OpenAI 工具格式
 *   - Gemini：自动转换为 functionDeclarations
 *   - Claude：自动转换为 input_schema 工具格式
 *
 * 端点解析规则（跨协议/跨渠道切换安全）：
 *   - 所有发送方法要求显式传入 ModelEndpoint 快照（ChatRequestOptions.endpoint），
 *     请求层绝不回读全局配置 —— 同一运行/任务内的请求端点完全一致；
 *   - 端点快照由 utils/channels/model-registry 按 ModelRef 解析产出；
 *     一次性调用方（工作流 AI 任务等）在任务开始时经
 *     modelRegistry.resolveActive() 取一份快照并在任务内复用。
 */

import {
  streamClient,
  type ModelEndpoint,
  type ProviderConfig,
  type StreamCallbacks,
  type UnifiedChatMessage as ChatMessage,
  type UnifiedToolCall as ToolCall,
  type VisionContent,
} from '../stream';
import { openaiToolsConverter } from '../tools/openai-tools-converter';
import { OpenAITool } from '@/common/openai-types';
// 注意：本模块不静态引入 ../chat/markdown-renderer —— 它是纯传输层，
// 被 background 的工具链（tools/automation 等）引用；而 markdown-renderer
// 连带 katex + highlight.js 整套渲染栈，一旦静态引入会被打进 Service Worker
// （background 是 IIFE 单文件、无法拆 chunk）。渲染入口见 MarkdownText /
// MessageItem 直接引用 markdownRenderer。

// 消息类型：与 stream 层 Unified* 结构完全一致 → 直接别名复用，
// 杜绝两份接口逐字段漂移（此前本地重定义 + 恒等映射函数是纯冗余）
export type { UnifiedChatMessage as ChatMessage, VisionContent, UnifiedToolCall as ToolCall } from '../stream';

// 重新导出渲染选项类型（type-only，不会把渲染栈打进本模块的引用图）
export type { RenderOptions } from '../chat/markdown-renderer';
// 重新导出端点快照类型（调用方与 ChatRequestOptions 共用同一契约）
export type { ModelEndpoint } from '../stream';

// ==================== 回调类型 ====================

export type StreamEventCallback = {
  onStart?: () => void;
  onToken?: (token: string) => void;
  onReasoning?: (reasoning: string) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  onComplete?: (message: ChatMessage) => void;
  onError?: (error: Error) => void;
  /** 自动重试触发（attempt 从 1 开始；上层可提示「正在重试」） */
  onRetry?: (attempt: number, delayMs: number) => void;
};

// ==================== 协议转换辅助 ====================

/**
 * StreamEventCallback → StreamCallbacks
 *
 * 消息与工具调用类型即 stream 层别名（结构同一），转换是直通透传——
 * 仅保留本层做「回调缺省补齐」的职责。
 * reasoning_content 处理策略：
 *  - reasoning token 通过独立的 onReasoning 回调实时流式传递给上层
 *  - 不混入 onToken 流（避免重复/标签问题）
 *  - 不再通过空 token 触发 thinking 移除（由上层 onToken/onReasoning/onToolCall 各自处理）
 */
function toStreamCallbacks(callbacks: StreamEventCallback): StreamCallbacks {
  return {
    onStart: callbacks.onStart,
    onToken: callbacks.onToken,
    onReasoning: callbacks.onReasoning,
    onToolCall: callbacks.onToolCall,
    onComplete: callbacks.onComplete,
    onError: callbacks.onError,
    onRetry: callbacks.onRetry,
  };
}

// ==================== 端点解析与请求上下文 ====================

/** 请求级选项：端点快照必填；采样参数可按请求覆盖端点默认值 */
export interface ChatRequestOptions {
  metrics?: import('../stream/types').RequestMetricsContext;
  /** 按 ID 解析的工具定义列表（经 openaiToolsConverter 转协议格式） */
  tools?: string[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * 模型端点快照（provider/baseUrl/apiKey/model/重试/采样默认值）。
   * 调用方保证其在运行/任务生命周期内不变：运行中用户切换协议或密钥
   * 不会在本次运行的请求之间产生混合配置。
   */
  endpoint: ModelEndpoint;
}

/** 单次请求的已解析上下文（端点 + 工具 + 重试参数；发送方法共用） */
interface RequestContext {
  providerConfig: ProviderConfig;
  tools?: OpenAITool[];
  /** 按请求显式指定的输出上限（机器结构化任务）；对话链路恒为 undefined */
  maxTokens?: number;
  retryCount: number;
  retryIntervalMs: number;
}

/** 由请求选项构建统一请求上下文：端点快照 → ProviderConfig + 工具定义 + 重试参数 */
function buildRequestContext(options: ChatRequestOptions): RequestContext {
  return {
    providerConfig: {
      provider: options.endpoint.provider,
      baseUrl: options.endpoint.baseUrl,
      apiKey: options.endpoint.apiKey,
      model: options.endpoint.model,
      temperature: options.temperature ?? options.endpoint.temperature,
      stream: true,
    },
    tools: options.tools ? openaiToolsConverter.getToolsByIds(options.tools) : undefined,
    maxTokens: options.maxTokens,
    retryCount: options.endpoint.retryCount,
    retryIntervalMs: options.endpoint.retryIntervalMs,
  };
}

export class AiChatApi {
  /**
   * 统一发送核心（sendStreamMessage / sendVisionMessage 唯一实现）。
   *
   * 两条公开方法曾各自内联同一段 streamClient 调用并已发生行为漂移
   *（流式方法有完成/失败日志与 try/catch，视觉方法没有）——收敛到此后，
   * 请求体构造、日志、错误透传三者永远同源，未来改动只落一处。
   *
   * 窗口保护契约：本层是纯传输——不裁剪、不计量。上下文窗口保护是调用方
   * （会话引擎 contextEngine.protect / 压缩器负载预算）的单一职责；此前本层
   * 内嵌的第二次 protect 使用「用户当前配置」而非运行快照阈值，运行中配置
   * 变更会产生两把不同口径的裁剪刀（且第二刀无裁剪注记）。裁剪必须单点执行。
   *
   * @param label 日志标签（区分文本/视觉两条调用链路，便于日志检索）
   */
  private async sendCore(
    label: 'sendStreamMessage' | 'sendVisionMessage',
    messages: ChatMessage[],
    callbacks: StreamEventCallback,
    options: ChatRequestOptions,
  ): Promise<{ finalMessage: ChatMessage; finishReason: string | null }> {
    const ctx = buildRequestContext(options);
    const startTime = Date.now();

    console.log(`[AiChatApi] ${label} 开始`, {
      provider: ctx.providerConfig.provider,
      baseUrl: ctx.providerConfig.baseUrl,
      model: ctx.providerConfig.model,
      messageCount: messages.length,
      toolCount: ctx.tools?.length ?? 0,
      toolNames: options.tools,
      temperature: ctx.providerConfig.temperature,
    });

    try {
      const result = await streamClient.chat(
        {
          metrics: {
            channelId: (options.endpoint as ModelEndpoint & { ref?: { channelId: string } }).ref?.channelId,
            modelId: (options.endpoint as ModelEndpoint & { ref?: { modelId: string } }).ref?.modelId,
            channelLabel: (options.endpoint as ModelEndpoint & { label?: string }).label,
            ...options.metrics,
          },
          promptCacheKey: /^https:\/\/api\.openai\.com(?:\/|$)/i.test(options.endpoint.baseUrl)
            ? `agentnexus:${options.metrics?.agentId || 'chat'}:v2` : undefined,
          model: ctx.providerConfig.model,
          // ChatMessage 即 UnifiedChatMessage 别名（结构同一），直通无需映射
          messages,
          tools: ctx.tools,
          tool_choice: ctx.tools && ctx.tools.length > 0 ? 'auto' : undefined,
          temperature: ctx.providerConfig.temperature,
          max_tokens: ctx.maxTokens,
          stream: true,
        },
        toStreamCallbacks(callbacks),
        {
          providerConfig: ctx.providerConfig,
          signal: options.signal,
          retryCount: ctx.retryCount,
          retryIntervalMs: ctx.retryIntervalMs,
        },
      );

      console.log(`[AiChatApi] ${label} 完成 (耗时: ${Date.now() - startTime}ms)`, {
        finishReason: result.finishReason,
        hasToolCalls: !!result.finalMessage.tool_calls?.length,
        contentLength:
          typeof result.finalMessage.content === 'string' ? result.finalMessage.content.length : 0,
      });

      return {
        finalMessage: result.finalMessage,
        finishReason: result.finishReason,
      };
    } catch (error) {
      // 失败只记日志并原样上抛：AbortError 必须透传（上层依赖 name 判定中止），
      // ApiRequestError 携带完整原始响应由调用方错误卡片呈现
      console.error(`[AiChatApi] ${label} 失败 (耗时: ${Date.now() - startTime}ms)`, error);
      throw error;
    }
  }

  /**
   * 发送流式聊天请求（窗口保护契约见 sendCore：纯传输不裁剪）
   */
  async sendStreamMessage(
    messages: ChatMessage[],
    callbacks: StreamEventCallback,
    options: ChatRequestOptions,
  ): Promise<{ finalMessage: ChatMessage; finishReason: string | null }> {
    return this.sendCore('sendStreamMessage', messages, callbacks, options);
  }

  /**
   * 发送包含图片的视觉消息（与 sendStreamMessage 同一传输核心；多模态部件
   * 随 messages 原样进入请求体，契约见 sendCore：纯传输不裁剪）
   */
  async sendVisionMessage(
    messages: ChatMessage[],
    callbacks: StreamEventCallback,
    options: ChatRequestOptions,
  ): Promise<{ finalMessage: ChatMessage; finishReason: string | null }> {
    return this.sendCore('sendVisionMessage', messages, callbacks, options);
  }
}

// 导出默认实例
export const aiChatApi = new AiChatApi();

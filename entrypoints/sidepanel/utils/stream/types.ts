/**
 * 多协议流式传输 - 统一类型定义
 * 
 * 所有协议适配器（OpenAI/Ollama/Gemini/Claude）共享这些类型，
 * 确保上层调用代码（App.vue 等）无需关心底层协议差异。
 */

// ==================== 协议提供商类型 ====================

/** 支持的协议提供商 */
export type ProviderType = 'openai' | 'ollama' | 'gemini' | 'claude' | 'openai-responses';

// ==================== 模型端点快照 ====================

/**
 * 模型端点快照 — 单次运行/任务开始时全量定值的协议与端点信息。
 *
 * 设计约束（跨协议切换安全的核心）：
 *   - 请求层只读快照、绝不回读全局用户配置：同一运行内的所有请求（含工具循环的
 *     后续轮次）使用完全一致的协议/端点/凭据，用户运行中途切换协议或密钥不会
 *     产生「新端点 + 旧模型名」之类的混合请求；
 *   - apiKey 只存在于内存（快照由运行装配层解析后传入），绝不落库、绝不写日志；
 *   - 端点不携带任何生成上限（max output tokens）：对话与压缩请求一律不封装
 *     输出上限，交由提供商按模型能力自行决定（协议要求的除外，见 claude 适配器）。
 *     仅机器结构化任务（自动化工具）与连通性探测可按请求显式传入
 *     StreamRequestConfig.max_tokens；
 *   - temperature 是该端点的采样默认值，单次请求可显式覆盖（如压缩低温度）。
 */
export interface ModelEndpoint {
  /** 提供商（协议）类型 */
  provider: ProviderType;
  /** API 服务基础 URL */
  baseUrl: string;
  /** 模型名 */
  model: string;
  /** API 密钥（仅内存，本地协议可为空串） */
  apiKey: string;
  /** 自动重试次数 */
  retryCount: number;
  /** 重试间隔基数（毫秒，指数退避） */
  retryIntervalMs: number;
  /** 采样温度默认值 */
  temperature: number;
}

// ==================== 协议能力声明 ====================

/**
 * 协议能力声明 — 每个适配器必须显式声明
 *
 * 用途：
 *   1. 请求前统一校验（如带图请求打到不支持视觉的协议 → 明确报错，而非静默丢图）
 *   2. 决定是否需要预处理（远程图片转 base64 等）
 *   3. 作为协议契约测试的断言基线
 */
export interface AdapterCapabilities {
  /** 是否支持图片输入（VisionContent） */
  vision: boolean;
  /**
   * 远程 http(s) 图片的处理方式：
   * - 'native': 协议原生支持远程 URL，直接透传
   * - 'base64': 协议只接受 base64 data URL，需预处理下载转换
   */
  remoteImageUrl: 'native' | 'base64';
  /** 是否支持 function calling（工具调用） */
  tools: boolean;
  /** 是否支持推理/思考内容独立流（reasoning） */
  reasoning: boolean;
}

// ==================== 消息类型（统一格式）====================

/** 统一的消息格式，上层代码统一使用此类型 */
export interface UnifiedChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | VisionContent[];
  name?: string;
  tool_calls?: UnifiedToolCall[];
  tool_call_id?: string;
}

/** 视觉内容（图片+文字混合） */
export interface VisionContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

/** 统一的工具调用格式 */
export interface UnifiedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ==================== 请求配置 ====================

/** 统一的请求配置 */
export interface StreamRequestConfig {
  /** Local diagnostics only; adapters must never serialize this field. */
  metrics?: RequestMetricsContext;
  /** Only set for endpoints that explicitly support this parameter. */
  promptCacheKey?: string;
  model: string;
  messages: UnifiedChatMessage[];
  tools?: UnifiedToolDefinition[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  /**
   * 单次请求输出 token 上限（可选）。仅两类调用方允许显式传入：
   *   - 机器结构化任务（自动化工具的 JSON 提取，输出体积可控是功能需求）；
   *   - 连通性探测（最小化探测成本）。
   * 对话与压缩链路一律不传——由提供商按模型能力决定输出上限，
   * 避免产品层硬编码截断长回复。未指定时适配器省略该字段
   * （Claude 协议必填，由其适配器自适应处理，见 claude-adapter）。
   */
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
}

export interface RequestMetricsContext {
  channelId?: string;
  modelId?: string;
  channelLabel?: string;
  agentId?: string;
  runId?: string;
  iteration?: number;
  kind?: 'chat' | 'compaction';
  compacted?: boolean;
  trimmed?: boolean;
  sharedPrefixMessages?: number;
  prefixChanged?: boolean;
}

/** 统一的工具定义格式 */
export interface UnifiedToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

// ==================== 流式回调 ====================

/** 流式事件回调 */
export interface StreamCallbacks {
  /** 流开始 */
  onStart?: () => void;
  /** 收到文本 token */
  onToken?: (token: string) => void;
  /** 收到推理/思考内容（如 DeepSeek 的 reasoning_content） */
  onReasoning?: (reasoning: string) => void;
  /** 检测到工具调用（流末尾 finalize 统一补发，参数已完整） */
  onToolCall?: (toolCall: UnifiedToolCall) => void;
  /** 流完成 */
  onComplete?: (message: UnifiedChatMessage) => void;
  /**
   * 流解析阶段错误（SSE 坏行 / 协议异常 / 流内 in-band 错误）。
   * 注意契约边界：HTTP 非 2xx、建连失败、视觉预处理失败走 Promise reject
   * （携带结构化 ApiRequestError），不经过本回调——消费方必须同时处理
   * 两条错误通道（本回调仅用于日志/埋点类旁路观察）。
   */
  onError?: (error: Error) => void;
  /** 自动重试触发（attempt 从 1 开始） */
  onRetry?: (attempt: number, delayMs: number) => void;
}

/** 协议异常错误的定位上下文（provider/url/model，透传给结构化错误） */
export interface StreamErrorContext {
  provider?: ProviderType;
  url?: string;
  model?: string;
}

// ==================== Token 消耗（统一口径）====================

/**
 * 单次请求的 token 消耗 — 跨协议统一口径（全部可选，协议未上报即留空）
 *
 * 字段语义（与各协议官方 usage 对齐，见 adapters/usage-normalize.ts）：
 *   - inputTokens      输入侧总量（OpenAI prompt_tokens / Claude input+cache_read+cache_creation /
 *                      Gemini promptTokenCount / Ollama prompt_eval_count），**含**缓存命中部分
 *   - outputTokens     输出侧总量（含推理 token，协议未拆分推理时推理计入此处）
 *   - totalTokens      总量；协议未上报时由合并器推导 input + output
 *   - cachedInputTokens 输入中命中提示缓存的部分；**undefined 表示协议/网关未上报**（与 0 严格区分，
 *                      缓存命中率只对上报了该字段的请求计算）
 *   - reasoningTokens  输出中推理/思考部分（OpenAI reasoning_tokens / Gemini thoughtsTokenCount 等）
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

// ==================== 响应类型 ====================

/** 流式请求的最终结果 */
export interface StreamResult {
  /** AI 最终构建的完整消息 */
  finalMessage: UnifiedChatMessage;
  /** 结束原因：stop / tool_calls / abort / length */
  finishReason: string | null;
  /**
   * 本次请求的 token 消耗（协议上报时才有值）。
   * 流式场景由各适配器从 SSE 事件中按 last-wins 语义合并得出；
   * 监控指标引擎据此计数，无值时仅计请求次数不计 token。
   */
  usage?: TokenUsage;
}

// ==================== 提供商配置 ====================

/** 提供商连接配置 */
export interface ProviderConfig {
  /** 提供商类型 */
  provider: ProviderType;
  /** API 基础 URL */
  baseUrl: string;
  /** API 密钥 */
  apiKey?: string;
  /** 默认模型 */
  model: string;
  /** 默认温度 */
  temperature?: number;
  /**
   * 是否流式。
   * ⚠️ 对话链路由适配器固定产出 `stream: true`（上层只解析 SSE），此字段仅作兼容保留；
   *    需要非流式请求（如连通性探测）请走 `utils/stream/probe.ts`，它会自行覆盖 body.stream。
   */
  stream?: boolean;
  /** 自定义请求头 */
  customHeaders?: Record<string, string>;
}

// ==================== 适配器接口 ====================

/**
 * 协议适配器抽象接口
 * 每种协议（OpenAI/Gemini/Claude/Ollama）实现此接口
 */
export interface ProtocolAdapter {
  /** 提供商类型标识 */
  readonly providerType: ProviderType;

  /** 协议能力声明（视觉/工具/推理），请求前统一校验与预处理依赖它 */
  readonly capabilities: AdapterCapabilities;

  /**
   * 将统一请求配置转换为该协议的原始请求体
   */
  buildRequestBody(config: StreamRequestConfig): any;

  /**
   * 获取该协议的请求 URL
   * @param model 协议把模型名写进 URL 时使用（Gemini）；其余协议忽略
   */
  getRequestUrl(baseUrl: string, model?: string): string;

  /**
   * 可选：构造携带认证信息的流式请求 URL。
   * key 放 query 的协议（Gemini）实现它，消费方（StreamClient / 模型列表）
   * 一律经此分派——绝不各自 instanceof 具体适配器（驱动注册表是协议清单唯一事实源）。
   * 缺省时消费方回落 getRequestUrl(baseUrl)。
   */
  buildRequestUrl?(baseUrl: string, apiKey?: string, model?: string): string;

  /**
   * 可选：构造连通性探测（非流式）URL。
   * 流式与非流式是不同 method 的协议（Gemini）实现它；
   * 缺省时消费方回落 buildRequestUrl / getRequestUrl。
   */
  buildProbeUrl?(baseUrl: string, apiKey?: string, model?: string): string;

  /**
   * 获取该协议的请求头
   */
  getRequestHeaders(apiKey?: string, customHeaders?: Record<string, string>): Record<string, string>;

  /**
   * 发送 HTTP 请求并返回 ReadableStream reader
   */
  fetchStream(
    url: string,
    headers: Record<string, string>,
    body: any,
    signal?: AbortSignal
  ): Promise<ReadableStreamDefaultReader<Uint8Array>>;

  /**
   * 解析流式 SSE 响应
   * @param reader - ReadableStreamDefaultReader
   * @param callbacks - 统一的流式回调
   * @param signal - 取消信号
   * @param context - 协议异常错误的定位上下文（provider/url/model）
   * @returns 最终结果
   */
  parseStreamResponse(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    context?: StreamErrorContext
  ): Promise<StreamResult>;
}

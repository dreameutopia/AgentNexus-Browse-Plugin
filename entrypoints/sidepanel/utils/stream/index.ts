/**
 * 多协议流式传输模块
 *
 * 统一入口，导出所有公开类型和客户端。
 *
 * 用法:
 *   import { streamClient, type StreamCallbacks, type ProviderConfig } from './stream';
 *
 * 支持的协议:
 *   - openai           : OpenAI API / 兼容服务 / Ollama
 *   - openai-responses : OpenAI Responses API（/v1/responses）
 *   - gemini           : Google Gemini API
 *   - claude           : Anthropic Claude API
 *   - ollama           : Ollama 原生 API（/api/chat）
 *
 * 协议清单的唯一事实源是 driver-registry——新增协议 = 实现适配器 +
 * 注册一条驱动，消费方（UI / 探测 / 校验 / 模型拉取）自动获得支持。
 */

// 客户端
export { streamClient, StreamClient } from './stream-client';

// 类型
export type {
  ProviderType,
  UnifiedChatMessage,
  VisionContent,
  UnifiedToolCall,
  StreamRequestConfig,
  UnifiedToolDefinition,
  StreamCallbacks,
  StreamErrorContext,
  StreamResult,
  ProviderConfig,
  ModelEndpoint,
  ProtocolAdapter,
  TokenUsage,
} from './types';

// 结构化错误（API 端错误分类 / 展示 / 日志脱敏的单一事实源）
export {
  ApiRequestError,
  PermanentRequestError,
  toApiErrorBlock,
  isAbortError,
  sanitizeUrlForLog,
} from './errors';

// 连通性探测（与对话请求同源的适配器复用）
export { probeConnection, PROBE_TIMEOUT_MS } from './probe';

// 协议驱动注册表（协议清单唯一事实源）
export { driverRegistry } from './driver-registry';

// token 用量归一化（跨协议统一口径；监控引擎 / 连通性探测 / 高级复用方使用）
export {
  mergeUsageSafe,
  normalizeOpenAIUsage,
  normalizeClaudeUsage,
  normalizeGeminiUsage,
  normalizeOllamaUsage,
  normalizeResponsesUsage,
  normalizeTranscriptionUsage,
  normalizeUsageFromBody,
} from './adapters/usage-normalize';

// 适配器（高级用法：自定义注册）
export { OpenAIAdapter } from './adapters/openai-adapter';
export { OllamaAdapter } from './adapters/ollama-adapter';
export { GeminiAdapter } from './adapters/gemini-adapter';
export { ClaudeAdapter } from './adapters/claude-adapter';
export { ResponsesAdapter } from './adapters/responses-adapter';

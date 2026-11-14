/**
 * Token usage 归一化器 — 各协议 usage 字段 → 统一 TokenUsage 口径的唯一事实源
 *
 * 设计原则：
 *   1. **last-wins 合并**：Claude message_delta 的 usage 是累计终值（官方文档明确）、
 *      Gemini 末 chunk 的 usageMetadata 才完整、OpenAI 只在末 chunk 下发 usage —
 *      所有官方协议的流内 usage 都是「快照」而非「增量」，因此同一字段后到者覆盖先到者，
 *      绝不能累加（累加会把 Claude 的输入 token 翻倍，见同类网关的已知踩坑）。
 *   2. **防御性解析**：所有字段经 toCount() 校验（有限、非负、整数化、字符串数字容忍、
 *      天文数字视为脏数据丢弃），任何畸形输入都静默降级为 undefined，永不抛错。
 *   3. **undefined 与 0 严格区分**：cachedInputTokens 为 undefined 表示协议未上报缓存信息
 *      （缓存命中率只统计上报了的请求），为 0 表示真实未命中。
 *
 * 各协议官方口径（实现依据）：
 *   - OpenAI Chat Completions（流式）：请求需带 stream_options.include_usage=true，
 *     末 chunk（choices 为空）携带 usage：
 *     { prompt_tokens, completion_tokens, total_tokens,
 *       prompt_tokens_details: { cached_tokens, audio_tokens, text_tokens },
 *       completion_tokens_details: { reasoning_tokens, ... } }
 *     DeepSeek 兼容字段：prompt_cache_hit_tokens / prompt_cache_miss_tokens（旧），
 *     亦支持 prompt_tokens_details.cached_tokens（新）。
 *   - Anthropic Claude（流式）：message_start.message.usage =
 *     { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens }，
 *     message_delta.usage = { output_tokens（累计终值）, ... }。
 *     计费口径：总输入 = input + cache_read + cache_creation；缓存命中 = cache_read。
 *   - Google Gemini：每 chunk usageMetadata，末 chunk 完整：
 *     { promptTokenCount（含缓存部分）, candidatesTokenCount（不含思考）,
 *       thoughtsTokenCount, toolUsePromptTokenCount, totalTokenCount,
 *       cachedContentTokenCount }。
 *     总输入 = promptTokenCount + toolUsePromptTokenCount（工具提示 token 计入
 *     totalTokenCount 却不计入 promptTokenCount）；输出总量 = candidates + thoughts。
 *   - Ollama /api/chat（流式）：done=true 的末行携带
 *     { prompt_eval_count, eval_count, prompt_eval_cached_count（新版缓存命中） }。
 *   - OpenAI Responses（流式）：response.completed 事件 response.usage =
 *     { input_tokens, output_tokens, total_tokens,
 *       input_tokens_details: { cached_tokens }, output_tokens_details: { reasoning_tokens } }。
 */

import type { TokenUsage } from '../types';

// ==================== 防御性数值解析 ====================

/** 视为脏数据丢弃的阈值（正常计数不可能达到，防网关返回畸形天文数字污染统计） */
const MAX_PLAUSIBLE_COUNT = 1e15;

/**
 * 任意输入 → 合法 token 计数；不合法返回 undefined。
 * 容忍字符串数字（部分网关会把数字序列化成字符串）；负数/NaN/Infinity/小数一律拒绝。
 */
function toCount(value: unknown): number | undefined {
  let num: number;
  if (typeof value === 'number') {
    num = value;
  } else if (typeof value === 'string' && value.trim() !== '' && /^[+-]?\d+(\.\d+)?$/.test(value.trim())) {
    num = Number(value.trim());
  } else {
    return undefined;
  }
  if (!Number.isFinite(num) || num < 0 || num > MAX_PLAUSIBLE_COUNT) return undefined;
  return Math.floor(num);
}

/** 深层取数字：obj.a.b.c 任意一层缺失/非对象都返回 undefined */
function countAt(source: any, path: string): number | undefined {
  let cursor: any = source;
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return toCount(cursor);
}

// ==================== last-wins 合并 ====================

/**
 * 将新到的 usage 快照合并进累积值（last-wins：同一字段后到者覆盖，仅覆盖有值字段）。
 * 输入输出都齐而 total 缺失时推导 total；脏数据在归一化阶段已被剔除，此处无需再防御。
 */
export function mergeUsage(base: TokenUsage | undefined, next: Partial<TokenUsage>): TokenUsage {
  const merged: TokenUsage = { ...base };
  if (next.inputTokens !== undefined) merged.inputTokens = next.inputTokens;
  if (next.outputTokens !== undefined) merged.outputTokens = next.outputTokens;
  if (next.cachedInputTokens !== undefined) merged.cachedInputTokens = next.cachedInputTokens;
  if (next.reasoningTokens !== undefined) merged.reasoningTokens = next.reasoningTokens;
  if (next.totalTokens !== undefined) {
    // 协议显式上报的 total 是权威值
    merged.totalTokens = next.totalTokens;
  } else if (merged.inputTokens !== undefined && merged.outputTokens !== undefined) {
    // 未上报 total 的协议（Claude / Ollama / 旧版 DeepSeek）：由最终 input+output 推导。
    // 总是重算 —— last-wins 覆盖 input/output 后，早前推导的 total 已过期。
    merged.totalTokens = merged.inputTokens + merged.outputTokens;
  }
  return merged;
}

/** 合并入口的守卫版：next 为空对象/畸形时原样返回 base，绝不抛错 */
export function mergeUsageSafe(base: TokenUsage | undefined, next: Partial<TokenUsage> | undefined | null): TokenUsage | undefined {
  if (!next || typeof next !== 'object') return base;
  const hasAnyField =
    next.inputTokens !== undefined ||
    next.outputTokens !== undefined ||
    next.totalTokens !== undefined ||
    next.cachedInputTokens !== undefined ||
    next.reasoningTokens !== undefined;
  if (!hasAnyField) return base;
  return mergeUsage(base, next);
}

// ==================== 各协议归一化 ====================

/**
 * OpenAI Chat Completions 的 usage 对象 → 统一口径
 * （DeepSeek 旧字段 prompt_cache_hit_tokens 作为缓存命中的兼容回退）
 */
export function normalizeOpenAIUsage(usage: any): Partial<TokenUsage> {
  if (!usage || typeof usage !== 'object') return {};
  const result: Partial<TokenUsage> = {};
  const input = countAt(usage, 'prompt_tokens');
  const output = countAt(usage, 'completion_tokens');
  const total = countAt(usage, 'total_tokens');
  if (input !== undefined) result.inputTokens = input;
  if (output !== undefined) result.outputTokens = output;
  if (total !== undefined) result.totalTokens = total;

  const cached =
    countAt(usage, 'prompt_tokens_details.cached_tokens') ??
    countAt(usage, 'prompt_cache_hit_tokens');
  if (cached !== undefined) result.cachedInputTokens = cached;

  const reasoning = countAt(usage, 'completion_tokens_details.reasoning_tokens');
  if (reasoning !== undefined) result.reasoningTokens = reasoning;

  return result;
}

/**
 * Anthropic Claude 的 usage 对象 → 统一口径
 * message_start（输入侧快照）与 message_delta（输出累计终值）都走这里。
 * 总输入 = input + cache_read + cache_creation（Anthropic 计费口径），
 * 缓存命中 = cache_read（cache_creation 是写缓存，不算命中）。
 */
export function normalizeClaudeUsage(usage: any): Partial<TokenUsage> {
  if (!usage || typeof usage !== 'object') return {};
  const result: Partial<TokenUsage> = {};
  const input = countAt(usage, 'input_tokens');
  const cacheRead = countAt(usage, 'cache_read_input_tokens');
  const cacheCreation = countAt(usage, 'cache_creation_input_tokens');
  const output = countAt(usage, 'output_tokens');

  const hasCacheInfo = cacheRead !== undefined || cacheCreation !== undefined;
  if (input !== undefined) {
    result.inputTokens = input + (cacheRead ?? 0) + (cacheCreation ?? 0);
  } else if (hasCacheInfo) {
    // 防御：畸形网关缺 input_tokens 但带缓存字段 → 缓存合计作为输入量下限，不丢缓存信息
    result.inputTokens = (cacheRead ?? 0) + (cacheCreation ?? 0);
  }
  // 上报过任一缓存字段即视为「协议上报了缓存信息」（0 也是有效信息，与未上报严格区分）
  if (hasCacheInfo) {
    result.cachedInputTokens = cacheRead ?? 0;
  }
  if (output !== undefined) result.outputTokens = output;
  return result;
}

/**
 * Google Gemini 的 usageMetadata → 统一口径
 * 输出总量 = candidatesTokenCount + thoughtsTokenCount（与 totalTokenCount 同口径）。
 */
export function normalizeGeminiUsage(meta: any): Partial<TokenUsage> {
  if (!meta || typeof meta !== 'object') return {};
  const result: Partial<TokenUsage> = {};
  const prompt = countAt(meta, 'promptTokenCount');
  const toolUsePrompt = countAt(meta, 'toolUsePromptTokenCount');
  const candidates = countAt(meta, 'candidatesTokenCount');
  const thoughts = countAt(meta, 'thoughtsTokenCount');
  const total = countAt(meta, 'totalTokenCount');

  if (prompt !== undefined) {
    // 官方 total 口径 = promptTokenCount + toolUsePromptTokenCount + thoughts + candidates：
    // 工具提示 token 计入 totalTokenCount 却不计入 promptTokenCount，
    // 不并入输入侧就会少算总输入（缓存命中率的分母随之偏小、命中率虚高）。
    result.inputTokens = prompt + (toolUsePrompt ?? 0);
    // Gemini 只要有 usageMetadata 就具备缓存上报能力（cachedContentTokenCount 缺失 = 0 命中）
    result.cachedInputTokens = countAt(meta, 'cachedContentTokenCount') ?? 0;
  }
  if (candidates !== undefined || thoughts !== undefined) {
    result.outputTokens = (candidates ?? 0) + (thoughts ?? 0);
  }
  if (thoughts !== undefined) result.reasoningTokens = thoughts;
  if (total !== undefined) result.totalTokens = total;
  return result;
}

/**
 * Ollama /api/chat 末行（done=true）的计数字段 → 统一口径
 * prompt_eval_count / eval_count / prompt_eval_cached_count（新版）
 */
export function normalizeOllamaUsage(finalChunk: any): Partial<TokenUsage> {
  if (!finalChunk || typeof finalChunk !== 'object') return {};
  const result: Partial<TokenUsage> = {};
  const input = countAt(finalChunk, 'prompt_eval_count');
  const output = countAt(finalChunk, 'eval_count');
  if (input !== undefined) {
    result.inputTokens = input;
    const cached = countAt(finalChunk, 'prompt_eval_cached_count');
    if (cached !== undefined) result.cachedInputTokens = cached;
  }
  if (output !== undefined) result.outputTokens = output;
  return result;
}

/** OpenAI Responses 的 usage 对象 → 统一口径（input_tokens / output_tokens 命名） */
export function normalizeResponsesUsage(usage: any): Partial<TokenUsage> {
  if (!usage || typeof usage !== 'object') return {};
  const result: Partial<TokenUsage> = {};
  const input = countAt(usage, 'input_tokens');
  const output = countAt(usage, 'output_tokens');
  const total = countAt(usage, 'total_tokens');
  if (input !== undefined) result.inputTokens = input;
  if (output !== undefined) result.outputTokens = output;
  if (total !== undefined) result.totalTokens = total;

  const cached = countAt(usage, 'input_tokens_details.cached_tokens');
  if (cached !== undefined) result.cachedInputTokens = cached;

  const reasoning = countAt(usage, 'output_tokens_details.reasoning_tokens');
  if (reasoning !== undefined) result.reasoningTokens = reasoning;

  return result;
}

/**
 * OpenAI 兼容转写（/audio/transcriptions）响应的 usage → 统一口径
 * gpt-4o-transcribe 系列官方返回 Responses 风格命名（input_tokens / output_tokens /
 * total_tokens / *_tokens_details），部分兼容网关沿用 Chat Completions 命名
 * （prompt_tokens / completion_tokens）—— 两种命名都解析，同名字段以 CC 命名优先；
 * 旧模型/网关无 usage 字段时返回空对象（仅计请求次数）。
 */
export function normalizeTranscriptionUsage(body: any): Partial<TokenUsage> {
  if (!body || typeof body !== 'object') return {};
  const responsesStyle = normalizeResponsesUsage(body.usage);
  const chatStyle = normalizeOpenAIUsage(body.usage);
  return { ...responsesStyle, ...chatStyle };
}

/**
 * 非流式响应体 → usage：按协议分派（连通性探测复用，保证流式/非流式计数同源）。
 * Gemini 非流式在顶层 usageMetadata；其余协议在顶层 usage；Ollama 在顶层计数字段。
 */
export function normalizeUsageFromBody(provider: string, body: any): Partial<TokenUsage> {
  if (!body || typeof body !== 'object') return {};
  switch (provider) {
    case 'openai':
      return normalizeOpenAIUsage(body.usage);
    case 'openai-responses':
      return normalizeResponsesUsage(body.usage);
    case 'claude':
      return normalizeClaudeUsage(body.usage);
    case 'gemini':
      return normalizeGeminiUsage(body.usageMetadata);
    case 'ollama':
      return normalizeOllamaUsage(body);
    default: {
      // 未知协议：尝试两种主流布局，取字段更全的一方（块级作用域隔离 case 内的词法声明）
      const a = normalizeOpenAIUsage(body.usage);
      const b = normalizeGeminiUsage(body.usageMetadata);
      return Object.keys(a).length >= Object.keys(b).length ? a : b;
    }
  }
}

/**
 * Claude 协议适配器
 * 
 * 适用于 Anthropic Claude API (claude-3-opus, claude-3.5-sonnet 等)
 * 
 * Claude 的流式格式与 OpenAI 有显著差异：
 *   - 端点: /v1/messages
 *   - Header: x-api-key (非 Bearer Token) + anthropic-version
 *   - SSE 事件类型多样: message_start, content_block_start, content_block_delta, message_delta, message_stop
 *   - 工具调用: content blocks with type="tool_use"
 *   - 流结束: event: message_stop
 * 
 * 参考: https://docs.anthropic.com/en/api/messages-streaming
 */

import { BaseAdapter, type StreamAccumulator } from './base-adapter';
import { ApiRequestError, createInBandError } from '../errors';
import { mergeUsageSafe, normalizeClaudeUsage } from './usage-normalize';
import { nativeItems, setNativeItems, nativePartIndex } from './native-replay';
import {
  SAFE_TOOL_ID_PATTERN,
  parseReplayArguments,
  sanitizeReplayToolId,
} from './unified-normalize';
import type {
  AdapterCapabilities,
  ProviderType,
  StreamRequestConfig,
  StreamCallbacks,
  UnifiedChatMessage,
} from '../types';

/** Claude SSE 事件中的 content_block 类型 */
interface ClaudeContentBlock {
  type: string;
  [key: string]: any;
  text?: string;
  id?: string;
  name?: string;
  input?: any;
}

// ==================== max_tokens 必填自适应（协议差异的唯一特判） ====================

/**
 * Anthropic Messages API 是本项目支持协议中唯一要求 max_tokens 必填的协议，
 * 且不同模型的合法上限差异巨大（4K ~ 64K），不存在跨模型安全的固定值。
 * 产品原则是「不封装输出上限」，因此采用免配置的自适应策略：
 *
 *   1. 首次请求按学习缓存或直接省略 max_tokens（宽容网关按模型默认处理）；
 *   2. 服务端 400 且错误体指向 max_tokens 时解析出合法上限并学习
 *      （按「请求 URL + 模型」缓存——同名模型经不同渠道/网关的上限可能不同，
 *        仅按模型名缓存会让多渠道配置互相污染）：
 *      - 「x > N, which is the maximum allowed」→ 直接学习 N；
 *      - 「field required / missing」→ 先探测 PROBE_START，超限错误再回落解析值；
 *   3. 以修正后的值重发（本机制与 stream-client 的可重试错误重试相互独立：
 *      这不是盲目重试，而是按服务端反馈修正请求体的定向重建，最多 3 次）。
 *
 * 学习缓存为内存级（sidepanel 会话内有效）：每个端点+模型最多付出 1~2 次 400
 * 快速失败的额外往返，之后整个会话内全部请求直接携带正确值。
 */
const learnedOutputCaps = new Map<string, number>();

/** 学习缓存键：请求 URL + 模型名（跨渠道同名模型互不污染） */
function learnedCapKey(url: string, model: string): string {
  return `${url} ${model}`;
}

/** 未指定输出上限时的探测起点（当前 Claude 模型系的最高输出上限） */
const MAX_TOKENS_PROBE_START = 64000;

/** 自适应尝试上限（省略 → 探测值 → 解析值，最多 3 次请求） */
const MAX_TOKENS_ADAPT_MAX_ATTEMPTS = 3;

/** 从 400 错误体解析 max_tokens 合法上限；无法解析时返回 null */
function parseMaxTokensCapFromError(rawBody: string): number | null {
  // Anthropic 官方错误形如：
  //   "max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens"
  const tooLarge = rawBody.match(/max_tokens[^\d]{0,80}?(\d+)\s*>\s*(\d+)/i);
  if (tooLarge) {
    const cap = Number.parseInt(tooLarge[2], 10);
    if (Number.isFinite(cap) && cap > 0) return cap;
  }
  // 字段缺失类错误（无上限信息）：交给调用方走探测值
  if (/max_tokens/i.test(rawBody) && /(required|missing|must\s+(be\s+)?provided|必填)/i.test(rawBody)) {
    return MAX_TOKENS_PROBE_START;
  }
  return null;
}

export class ClaudeAdapter extends BaseAdapter {
  readonly providerType: ProviderType = 'claude';

  /** 能力：图片（base64 + 远程 URL 均原生支持）、工具；无独立推理流（thinking 块未接） */
  readonly capabilities: AdapterCapabilities = {
    vision: true,
    remoteImageUrl: 'native',
    tools: true,
    reasoning: true,
  };

  /**
   * 将统一消息格式转换为 Claude Messages API 格式
   * 
   * Claude 格式:
   * {
   *   model: "claude-3-5-sonnet-20241022",
   *   max_tokens: <学习值或探测值——协议必填，由 fetchStream 自适应保证>,
   *   system: "system prompt",  // 注意: system 是顶级字段
   *   messages: [{ role: "user"|"assistant", content: string | ContentBlock[] }],
   *   tools: [{ name, description, input_schema }]
   * }
   */
  buildRequestBody(config: StreamRequestConfig): any {
    const body: any = {
      model: config.model,
      stream: true,
    };

    // 输出上限：仅显式指定（机器任务/探测）时携带。协议要求该字段必填——
    // 学习缓存的注入与缺失场景的兜底统一由下方 fetchStream 覆写处理，
    // 保证「非调用方指定的值」永远保有再自适应能力（不被误判为功能约束）
    if (config.max_tokens !== undefined) {
      body.max_tokens = config.max_tokens;
    }

    // system：Claude 的 system 是顶级字段。全部 system 消息按出现顺序合并，
    // 保证「压缩摘要记忆」等附加系统消息不会被静默丢弃（跨协议回放的关键约束）
    const systemTexts = config.messages
      .filter(m => m.role === 'system')
      .map(m => this.plainTextOf(m.content))
      .filter(text => text.length > 0);
    if (systemTexts.length > 0) {
      body.system = [{ type: 'text', text: systemTexts.join('\n\n'), cache_control: { type: 'ephemeral' } }];
    }

    // 其余消息折叠为合法轮次（连续同角色合并 + 并行 tool_result 同轮回放）
    body.messages = this.foldClaudeTurns(config.messages.filter(m => m.role !== 'system'), { ...config });
    // Automatic moving breakpoint for growing agent histories; the explicit
    // system checkpoint remains reusable after compaction or an image change.
    body.cache_control = { type: 'ephemeral' };
    // Explicit moving checkpoint also supports gateways predating automatic
    // top-level cache_control. Markers are transport metadata, not prompt text.
    const lastTurn = body.messages[body.messages.length - 1];
    const mark = (turn: any) => {
      const block = Array.isArray(turn?.content) ? [...turn.content].reverse().find(b => !['thinking', 'redacted_thinking'].includes(b.type)) : undefined;
      if (block) block.cache_control = { type: 'ephemeral' };
    };
    mark(lastTurn);
    const priorTurn = body.messages[body.messages.length - 3];
    mark(priorTurn);

    // 生成参数
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.top_p !== undefined) body.top_p = config.top_p;

    // 工具定义 — 转换为 Claude 格式
    if (config.tools && config.tools.length > 0) {
      body.tools = config.tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      }));
    }

    return body;
  }

  /**
   * fetchStream 覆写：max_tokens 必填自适应（详见文件头「max_tokens 必填自适应」）。
   * 仅拦截「400 且错误体指向 max_tokens」的失败按服务端反馈定向重建请求体，
   * 其余错误（网络/超时/鉴权/其它 4xx）原样上抛，交由统一错误体系处理。
   * 调用方显式指定的 max_tokens 是功能约束，绝不参与自适应改写；
   * 学习缓存的注入也在此完成（非调用方指定的值永远可再自适应）。
   */
  async fetchStream(
    url: string,
    headers: Record<string, string>,
    body: any,
    signal?: AbortSignal,
    connectTimeoutMs?: number,
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const model = typeof body?.model === 'string' ? body.model : '';
    const callerSpecified = typeof body?.max_tokens === 'number';
    const cacheKey = learnedCapKey(url, model);
    let currentBody = body;

    // 有该端点+模型的学习值且调用方未指定 → 预注入（省去探测往返）；
    // 学习值若已过时（模型更换），后续 400 仍会走自适应纠正
    if (!callerSpecified && model) {
      const learned = learnedOutputCaps.get(cacheKey);
      if (learned !== undefined) {
        currentBody = { ...currentBody, max_tokens: learned };
      }
    }

    for (let attempt = 1; ; attempt++) {
      try {
        return await super.fetchStream(url, headers, currentBody, signal, connectTimeoutMs);
      } catch (error) {
        if (
          callerSpecified ||
          !(error instanceof ApiRequestError) ||
          error.status !== 400 ||
          attempt >= MAX_TOKENS_ADAPT_MAX_ATTEMPTS
        ) {
          throw error;
        }

        const cap = parseMaxTokensCapFromError(error.rawBody);
        if (cap === null) throw error;

        // 学习缓存（省略后续同端点同模型请求的探测往返）
        if (model) learnedOutputCaps.set(cacheKey, cap);
        console.warn(
          `[ClaudeAdapter] max_tokens 必填/超限（模型 ${model || '未知'}），按服务端反馈自适应为 ${cap} 后重发（第 ${attempt + 1} 次）`,
        );
        currentBody = { ...currentBody, max_tokens: cap };
      }
    }
  }

  /**
   * 把统一消息序列折叠为 Claude 合法轮次：
   *   - 连续同角色消息（含 tool → user）合并为单条消息的多个 content block；
   *   - 并行工具调用的全部 tool_result 合入同一 user 轮（Anthropic 官方要求：
   *     「tool_result 必须紧跟对应 tool_use，且全部结果在同一条 user 消息中」）；
   *   - 单条纯文本轮保持字符串 content（Claude 两种形态等价，字符串可读性更好）；
   *   - 空轮次（无有效 block）直接跳过，避免空 content 消息被服务端拒绝。
   */
  private foldClaudeTurns(messages: UnifiedChatMessage[], config: StreamRequestConfig): Array<{ role: string; content: any }> {
    // 预扫描：全部 assistant.tool_calls 的原始 id 集合（用于识别孤儿 tool 结果）
    const knownCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      for (const tc of msg.tool_calls ?? []) {
        if (tc.id) knownCallIds.add(tc.id);
      }
    }

    // id 重写作用域：不满足协议字符集（^[a-zA-Z0-9_-]+$）的历史 id 统一重写，
    // 映射表保证同一次转换内 tool_use / tool_result 配对双方取到同一个新 id
    const idRewrites = new Map<string, string>();
    const usedIds = new Set<string>();
    const rewriteId = (raw: string, seed: string): string => {
      if (SAFE_TOOL_ID_PATTERN.test(raw)) return raw;
      let rewritten = idRewrites.get(raw);
      if (rewritten === undefined) {
        rewritten = sanitizeReplayToolId(raw, seed);
        while (usedIds.has(rewritten)) rewritten = `${rewritten}_`;
        usedIds.add(rewritten);
        idRewrites.set(raw, rewritten);
      }
      return rewritten;
    };

    const turns: Array<{ role: 'user' | 'assistant'; blocks: any[] }> = [];
    messages.forEach((msg, index) => {
      const blocks = this.messageToBlocks(msg, String(index), knownCallIds, rewriteId, config);
      if (blocks.length === 0) return;
      const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user';
      const last = turns[turns.length - 1];
      if (msg.role === 'user' && Array.isArray(msg.toolFeedbackFor) && msg.toolFeedbackFor.every(id => typeof id === 'string') && last?.role === 'user') {
        const ids = new Set(msg.toolFeedbackFor.map(id => rewriteId(id, `feedback_${index}`)));
        const result = [...last.blocks].reverse().find(block => block.type === 'tool_result' && ids.has(block.tool_use_id));
        if (result) {
          const existing = typeof result.content === 'string' ? [{ type: 'text', text: result.content }] : result.content;
          result.content = [...existing, { type: 'text', text: '以下为整批工具完成后的观察反馈；历史截图只作证据，坐标操作须使用最新有效截图。' }, ...blocks];
          return;
        }
      }
      if (last && last.role === role) {
        last.blocks.push(...blocks);
      } else {
        turns.push({ role, blocks });
      }
    });

    return turns.map(turn => ({ role: turn.role, content: turn.blocks }));
  }

  /**
   * 单条统一消息 → Claude content block 数组（永不抛错，脏数据降级为可读文本）
   */
  private messageToBlocks(
    msg: UnifiedChatMessage,
    seed: string,
    knownCallIds: Set<string>,
    rewriteId: (raw: string, seed: string) => string,
    config: StreamRequestConfig,
  ): any[] {
    // 工具结果消息 → tool_result block；
    // 缺失 id 或 id 不属于任何已回放的 tool_use（孤儿结果）时降级为文本，
    // 避免产生配对失败的 tool_result 被服务端 400 拒绝
    if (msg.role === 'tool') {
      const resultText =
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (!msg.tool_call_id || !knownCallIds.has(msg.tool_call_id)) {
        return [{ type: 'text', text: `[工具结果（无对应工具调用）] ${resultText}` }];
      }
      return [
        {
          type: 'tool_result',
          tool_use_id: rewriteId(msg.tool_call_id, seed),
          content: resultText,
        },
      ];
    }

    // 助手消息：文本 + 工具调用（tool_use；参数经防御性解析，永不抛错）
    if (msg.role === 'assistant') {
      const native = nativeItems(msg, config, 'claude');
      if (native?.length) return native.map((block, index) => block.type === 'tool_use'
        ? { ...block, id: rewriteId(block.id, `${seed}_u${index}`) } : block);
      const blocks: any[] = [];
      const text = this.plainTextOf(msg.content);
      if (text) blocks.push({ type: 'text', text });
      (msg.tool_calls ?? []).forEach((tc, callIndex) => {
        blocks.push({
          type: 'tool_use',
          id: rewriteId(tc.id, `${seed}_u${callIndex}`),
          name: tc.function.name,
          input: parseReplayArguments(tc.function.arguments),
        });
      });
      return blocks;
    }

    // 用户消息：纯文本或多模态（text + image）
    if (typeof msg.content === 'string') {
      return msg.content ? [{ type: 'text', text: msg.content }] : [];
    }
    const blocks: any[] = [];
    for (const item of msg.content) {
      if (item.type === 'text' && item.text) {
        blocks.push({ type: 'text', text: item.text });
      } else if (item.type === 'image_url' && item.image_url) {
        const url = item.image_url.url;
        if (url.startsWith('data:')) {
          const [header, base64] = url.split(',');
          const mediaType = header.match(/data:(.*?);/)?.[1] || 'image/png';
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          });
        } else {
          // 远程 URL：Claude 原生支持 url source
          blocks.push({ type: 'image', source: { type: 'url', url } });
        }
      }
    }
    return blocks;
  }

  /**
   * Claude Messages API 端点
   */
  getRequestUrl(baseUrl: string): string {
    const base = baseUrl.replace(/\/$/, '');
    return `${base}/v1/messages`;
  }

  /**
   * Claude 使用 x-api-key + anthropic-version 头
   */
  getRequestHeaders(
    apiKey?: string,
    customHeaders?: Record<string, string>
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }
    if (customHeaders) {
      Object.assign(headers, customHeaders);
    }
    return headers;
  }

  /**
   * 解析 Claude SSE 单行
   * 
   * Claude 流式事件格式:
   *   event: message_start
   *   data: {"type":"message_start","message":{"id":"msg_xxx","role":"assistant",...}}
   *   
   *   event: content_block_start
   *   data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
   *   
   *   event: content_block_delta
   *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
   *   
   *   event: content_block_stop
   *   data: {"type":"content_block_stop","index":0}
   *   
   *   event: message_delta
   *   data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{...}}
   *   
   *   event: message_stop
   *   data: {"type":"message_stop"}
   */
  protected parseSSELine(
    line: string,
    acc: StreamAccumulator,
    callbacks: StreamCallbacks
  ): boolean {
    // 只处理 data: 行（event: 行经 extractSSEData 统一跳过，事件类型以 data 中 type 为准）
    const data = this.extractSSEData(line);
    if (data === null) return false;

    try {
      const event = JSON.parse(data);
      const blockIndex = nativePartIndex(event.index);

      switch (event.type) {
        case 'message_start':
          // 消息开始：usage 携带输入侧计数（input_tokens + 缓存读/写字段），
          // 按 last-wins 合并进累积器（后续 message_delta 会覆盖输出侧终值）
          if (event.message?.usage) {
            acc.usage = mergeUsageSafe(acc.usage, normalizeClaudeUsage(event.message.usage));
          }
          break;

        case 'content_block_start': {
          // 内容块开始 — 如果是 tool_use，记录 id 和 name
          const block = event.content_block as ClaudeContentBlock;
          if (block && typeof block.type === 'string') {
            (acc.nativeBlocks ??= new Map()).set(blockIndex, structuredClone(block));
            if (block.type === 'text' && block.text) this.handleContentToken(block.text, acc, callbacks);
            if (block.type === 'thinking' && block.thinking) this.handleReasoningToken(block.thinking, acc, callbacks);
          }
          if (block?.type === 'tool_use' && block.id) {
            const index = blockIndex;
            acc.toolCallChunks.set(index, {
              id: block.id,
              name: block.name || '',
              arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '',
            });
          }
          break;
        }

        case 'content_block_delta': {
          const delta = event.delta;
          const block = acc.nativeBlocks?.get(blockIndex);
          if (block && delta?.type === 'text_delta' && typeof delta.text === 'string') block.text = (block.text ?? '') + delta.text;
          if (block && delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            block.thinking = (block.thinking ?? '') + delta.thinking;
            this.handleReasoningToken(delta.thinking, acc, callbacks);
          }
          if (block && delta?.type === 'signature_delta' && typeof delta.signature === 'string') block.signature = (block.signature ?? '') + delta.signature;

          // 文本增量
          if (delta?.type === 'text_delta' && delta.text) {
            this.handleContentToken(delta.text, acc, callbacks);
          }

          // 工具输入增量（JSON 片段）
          if (delta?.type === 'input_json_delta' && delta.partial_json) {
            const index = blockIndex;
            const chunk = acc.toolCallChunks.get(index);
            if (chunk) {
              chunk.arguments += delta.partial_json;
            }
          }
          break;
        }

        case 'content_block_stop': {
          const index = blockIndex;
          const block = acc.nativeBlocks?.get(index);
          if (block) {
            if (block.type === 'tool_use') block.input = parseReplayArguments(acc.toolCallChunks.get(index)?.arguments || '{}');
            const items = acc.finalMessage.nativeReplay?.items ?? [];
            items[index] = structuredClone(block);
            setNativeItems(acc.finalMessage, 'claude', items);
          }
          // 工具调用完成态由 acc.toolCallChunks 按 index 收敛（arguments 已随
          // input_json_delta 增量拼接完毕），此处无需额外处理
          break;
        }

        case 'message_delta': {
          // 消息级别 delta — 包含 stop_reason
          if (event.delta?.stop_reason) {
            const reasonMap: Record<string, string> = {
              end_turn: 'stop',
              max_tokens: 'length',
              stop_sequence: 'stop',
              tool_use: 'tool_calls',
            };
            acc.finishReason = reasonMap[event.delta.stop_reason] || event.delta.stop_reason;
          }
          // usage 为**累计终值**（官方文档明确），last-wins 覆盖输出侧计数；
          // 缓存/输入字段在 message_start 已合并，此处缺省不覆盖
          if (event.usage) {
            acc.usage = mergeUsageSafe(acc.usage, normalizeClaudeUsage(event.usage));
          }
          break;
        }

        case 'message_stop':
          // 流结束。正常时序下 message_delta 已带 stop_reason；宽容网关可能省略，
          // 与 OpenAI [DONE] 的兜底同语义——收到结束事件即视为正常停止，
          // 终态校验只拦截「连结束事件都没收到」的异常截断
          if (!acc.finishReason) acc.finishReason = 'stop';
          return true;

        case 'ping':
          // 心跳，忽略
          break;

        case 'error':
          throw createInBandError({
            prefix: 'Claude API error',
            message: event.error?.message,
            rawEvent: event.error,
            provider: this.providerType,
          });
      }
    } catch (parseError) {
      // 流内 in-band 错误必须向上抛；其余坏行容错跳过并留痕
      if (parseError instanceof ApiRequestError && parseError.kind === 'inband') {
        throw parseError;
      }
      this.recordParseFailure(acc, line);
      console.warn('[ClaudeAdapter] Failed to parse SSE chunk:', parseError, 'Line:', line.trim());
    }

    return false; // 继续读取
  }
}

/**
 * 协议适配器抽象基类
 * 提供通用的 SSE 流解析基础设施，子类只需实现协议特定的解析逻辑。
 */

import type {
  AdapterCapabilities,
  ProtocolAdapter,
  StreamCallbacks,
  StreamErrorContext,
  StreamRequestConfig,
  StreamResult,
  UnifiedChatMessage,
  UnifiedToolCall,
} from '../types';
import {
  ApiRequestError,
  isAbortError,
  parseRetryAfterMs,
  sanitizeUrlForLog,
} from '../errors';
import { t } from '@/utils/i18n/core';

/** SSE 解析过程中的累积状态 */
export interface StreamAccumulator {
  nativeBlocks?: Map<number, Record<string, any>>;
  /** 最终消息 */
  finalMessage: UnifiedChatMessage;
  /** 结束原因 */
  finishReason: string | null;
  /** 工具调用分块（index → 累积数据） */
  toolCallChunks: Map<number, { id: string; name: string; arguments: string }>;
  /**
   * 解析失败的 SSE 数据行数（坏 chunk 计数）。
   * 单行损坏被丢弃是容错，但「全部行都坏了」意味着协议根本没对上——
   * 终态校验与错误卡片诊断都读这个计数。
   */
  parseFailures: number;
  /** 首条解析失败的行预览（截断；进协议错误的 rawBody 供分析） */
  firstBadLine?: string;
  /**
   * token 消耗（协议上报时由子类在 parseSSELine 中按 last-wins 语义合并；
   * 未上报保持 undefined，监控引擎据此只计请求不计 token）
   */
  usage?: import('../types').TokenUsage;
}

/**
 * 创建初始累积器
 */
export function createAccumulator(): StreamAccumulator {
  return {
    finalMessage: { role: 'assistant', content: '' },
    finishReason: null,
    toolCallChunks: new Map(),
    parseFailures: 0,
  };
}

/**
 * 将累积的工具调用分块组装为完整的 UnifiedToolCall 数组
 *
 * 防御：个别网关/模型在流中不回传工具调用 id（或为空串）→ 合成唯一 id，
 * 保证后续工具结果消息总能配对（配对是协议硬约束，空 id 会被服务端拒绝）。
 * index 经 Number 归一：网关把下标下发为字符串时不会让排序退化为 NaN。
 */
export function assembleToolCalls(
  chunks: Map<number, { id: string; name: string; arguments: string }>
): UnifiedToolCall[] {
  return Array.from(chunks.entries())
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([index, chunk]) => ({
      id: chunk.id || `call_auto_${index}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function' as const,
      function: {
        name: chunk.name,
        arguments: chunk.arguments,
      },
    }));
}

/** readSSELines 的读取统计（终态校验的诊断数据） */
export interface SSEReadStats {
  /** 有效数据行数（不含空行与 SSE 注释） */
  lines: number;
  /** 读取的总字节数 */
  bytes: number;
  /** 首条数据行预览（截断 300 字符；非流式内容/HTML 页的直接证据） */
  firstDataLine?: string;
}

/**
 * 通用 SSE 行读取循环
 * 从 ReadableStream 中按行读取 SSE data，对每行调用 handler。
 * 自动处理：buffer 拼接、done 检测、AbortError 传播、空闲超时。
 *
 * @param idleTimeoutMs 连续无数据的超时毫秒数，默认 60 秒
 * @param errorContext 结构化错误的定位上下文（provider/url/model）
 * @returns 读取统计（行数/字节数/首行预览），供调用方做终态校验诊断
 */
export async function readSSELines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  lineHandler: (line: string, acc: StreamAccumulator, callbacks: StreamCallbacks) => boolean,
  callbacks: StreamCallbacks,
  acc: StreamAccumulator,
  idleTimeoutMs: number = 60000,
  errorContext?: StreamErrorContext
): Promise<SSEReadStats> {
  const decoder = new TextDecoder();
  let buffer = '';
  let totalLines = 0;
  let totalBytes = 0;
  let firstDataLine: string | undefined;
  const readStartTime = Date.now();

  console.log(`[readSSELines] 开始读取 SSE 流, 空闲超时: ${idleTimeoutMs / 1000}s`);

  /**
   * 处理一行：统一边界情况后再交给协议解析器
   * - CRLF：`\r\n` 可能在 chunk 边界被拆开，这里统一剥掉行尾 `\r`
   * - 网关 keepalive：连续空行直接忽略（不计入解析）
   * - SSE 注释行：以 `:` 开头（如 `: ping`）按规范忽略
   *
   * @returns true 表示解析器要求立即结束读取（`[DONE]` / `message_stop` / ollama `done:true`）
   */
  const handleLine = (rawLine: string): boolean => {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return false;
    totalLines++;
    if (firstDataLine === undefined) firstDataLine = trimmed.slice(0, 300);
    return lineHandler(line, acc, callbacks) === true;
  };

  try {
    while (true) {
      if (signal?.aborted) {
        console.log(`[readSSELines] 流被中止`);
        throw new DOMException('Request aborted', 'AbortError');
      }

      // 带空闲超时的 read：如果 idleTimeoutMs 内没有新数据，视为连接挂起
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const readPromise = reader.read();
      const timeoutPromise = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => {
          console.error(`[readSSELines] 空闲超时! ${idleTimeoutMs / 1000}s 内未收到数据`, {
            totalLines,
            totalBytes,
            elapsed: Date.now() - readStartTime,
          });
          // 真正断开底层连接：只 releaseLock 会让挂起的 fetch 保留到上下文卸载
          void reader.cancel().catch(() => undefined);
          // 归类为结构化超时错误：进入统一的重试判定（可重试）与用户展示体系
          reject(
            new ApiRequestError({
              ...errorContext,
              timeoutMs: idleTimeoutMs,
              summary: t('sidepanel.apiConfig.streamIdleTimeout', {
                seconds: idleTimeoutMs / 1000,
              }),
            })
          );
        }, idleTimeoutMs);
      });

      // signal 中止时也清理 timer
      const onAbort = () => { clearTimeout(idleTimer); };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const raceResult = await Promise.race([readPromise, timeoutPromise]);
        // readPromise 先 resolve → 清理 timer
        clearTimeout(idleTimer);
        signal?.removeEventListener('abort', onAbort);
        // 解构结果
        const { done, value } = raceResult as ReadableStreamReadResult<Uint8Array>;
        if (done) {
          // 1. 冲刷 TextDecoder 中残留的多字节字符（UTF-8 可能被 chunk 拆开）
          buffer += decoder.decode();
          // 2. 服务端最后一行可能不以 \n 结尾 → 必须冲刷，否则丢事件（如 `data: [DONE]`）
          if (buffer) {
            const tail = buffer;
            buffer = '';
            handleLine(tail);
          }
          console.log(`[readSSELines] 流结束 (共 ${totalLines} 行, ${totalBytes} 字节, 耗时 ${Date.now() - readStartTime}ms)`);
          break;
        }

        totalBytes += value.length;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let stopRequested = false;
        for (const line of lines) {
          if (handleLine(line)) {
            stopRequested = true;
            break;
          }
        }
        if (stopRequested) {
          // 网关可能在终态事件后继续保持连接，不等它关
          console.log(`[readSSELines] 解析器已收到终止事件，提前结束读取 (共 ${totalLines} 行)`);
          break;
        }
      } catch (raceError) {
        // 超时或 signal 中止 → 清理 timer
        clearTimeout(idleTimer);
        signal?.removeEventListener('abort', onAbort);
        throw raceError;
      }
    }
  } finally {
    // 无论正常结束/提前终止/异常，都真正关闭底层流（cancel 先于 releaseLock）：
    // 终态事件后网关可能仍保持连接，不 cancel 会把连接挂到上下文卸载
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      /* 流可能已关闭 */
    }
    reader.releaseLock();
    console.log(`[readSSELines] 完成, 共处理 ${totalLines} 行 SSE 数据, ${totalBytes} 字节`);
  }

  return { lines: totalLines, bytes: totalBytes, firstDataLine };
}

/**
 * 抽象基类 — 通用 HTTP POST + SSE 解析骨架
 * 子类需要实现:
 *   - buildRequestBody()
 *   - getRequestUrl()
 *   - getRequestHeaders()
 *   - parseSSELine()        — 单行 SSE 解析
 *   - finalizeAccumulator() — 循环结束后组装最终结果
 */
export abstract class BaseAdapter implements ProtocolAdapter {
  abstract readonly providerType: import('../types').ProviderType;

  /** 协议能力声明 — 子类必须显式提供（契约测试会断言） */
  abstract readonly capabilities: AdapterCapabilities;

  abstract buildRequestBody(config: StreamRequestConfig): any;
  abstract getRequestUrl(baseUrl: string): string;
  abstract getRequestHeaders(
    apiKey?: string,
    customHeaders?: Record<string, string>
  ): Record<string, string>;

  /**
   * 子类实现：解析单行 SSE 数据
   * @returns true 表示流结束（如收到 [DONE]），false 表示继续
   */
  protected abstract parseSSELine(
    line: string,
    acc: StreamAccumulator,
    callbacks: StreamCallbacks
  ): boolean;

  /**
   * 通用流式响应解析
   * 所有协议共享同一套 SSE 读取 + 累积器框架
   *
   * 终态校验（协议完整性）：连接正常读完但没收到协议结束事件
   * （[DONE] / message_stop / done:true / response.completed / finishReason）
   * 时抛 kind='protocol' 结构化错误——「零事件成功」会把网关 HTML 登录页、
   * 空响应、被代理截断的流静默变成空回复；「有内容无终态」则把半截回复
   * 冒充完整回复，正文剩余部分永久丢失且用户无感知。两种都必须显式失败。
   *
   * @param context 协议异常错误的定位上下文（provider/url/model）
   */
  async parseStreamResponse(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    context?: StreamErrorContext
  ): Promise<StreamResult> {
    const acc = createAccumulator();
    console.log(`[parseStreamResponse] 开始解析流`);
    callbacks.onStart?.();

    try {
      const stats = await readSSELines(
        reader,
        signal,
        this.parseSSELine.bind(this),
        callbacks,
        acc,
        60000,
        context,
      );

      // 坏行诊断：单行损坏被容错丢弃是允许的，但必须留下可分析的痕迹
      if (acc.parseFailures > 0) {
        console.warn(`[parseStreamResponse] ${acc.parseFailures} 行 SSE 数据解析失败（已跳过）`, {
          firstBadLine: acc.firstBadLine,
          provider: context?.provider ?? this.providerType,
        });
      }

      // ── 终态校验（详见方法注释） ──
      if (acc.finishReason === null) {
        const preview = stats.firstDataLine ?? acc.firstBadLine;
        throw new ApiRequestError({
          kind: 'protocol',
          provider: context?.provider ?? this.providerType,
          url: context?.url,
          model: context?.model,
          summary:
            stats.lines === 0
              ? t('sidepanel.apiConfig.streamEmpty')
              : t('sidepanel.apiConfig.streamIncomplete', {
                  lines: stats.lines,
                  bytes: stats.bytes,
                }),
          rawBody: preview ?? '',
        });
      }

      // 组装工具调用
      const assembled = assembleToolCalls(acc.toolCallChunks);
      if (assembled.length > 0) {
        acc.finalMessage.tool_calls = assembled;
      }

      // 子类后处理
      this.finalizeAccumulator(acc, callbacks);
      if (acc.finalMessage.nativeReplay && acc.usage?.reasoningTokens !== undefined) acc.finalMessage.nativeReplay.reasoningTokens = acc.usage.reasoningTokens;

      console.log(`[parseStreamResponse] 流解析完成`, {
        finishReason: acc.finishReason,
        contentLength: String(acc.finalMessage.content).length,
        toolCallCount: assembled.length,
        usage: acc.usage,
      });

      callbacks.onComplete?.(acc.finalMessage);
      return {
        finalMessage: acc.finalMessage,
        finishReason: acc.finishReason,
        usage: acc.usage,
      };
    } catch (error) {
      console.error(`[parseStreamResponse] 流解析出错`, error);
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.finalizeInterrupted(acc, callbacks);
        // 用户中止：已产生的部分 usage（如 Claude message_start 的输入侧计数）仍然有效
        return { finalMessage: acc.finalMessage, finishReason: 'abort', usage: acc.usage };
      }
      const apiError =
        error instanceof Error
          ? error
          : new Error(String(error));
      callbacks.onError?.(apiError);
      throw apiError;
    }
  }

  /**
   * 通用 fetch 发送 + 获取 ReadableStream reader
   *
   * 错误处理约定：
   *   - HTTP 非 2xx → ApiRequestError（携带 status + 完整原始响应，供 UI 展示 JSON）
   *   - 用户主动取消 → 保持 DOMException(AbortError) 原样抛出
   *   - 建连超时 → ApiRequestError(kind=timeout)，可重试
   *   - 网络不可达 → ApiRequestError(kind=network)，可重试
   *
   * @param connectTimeoutMs 建连+首包超时；流建立后由 readSSELines 的空闲超时接管
   */
  async fetchStream(
    url: string,
    headers: Record<string, string>,
    body: any,
    signal?: AbortSignal,
    connectTimeoutMs: number = 60000
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    console.log(`[BaseAdapter] fetchStream 开始`, {
      url: sanitizeUrlForLog(url).substring(0, 150),
      headerKeys: Object.keys(headers).join(', '),
      bodyModel: body?.model,
      bodyStream: body?.stream,
    });

    const fetchStartTime = Date.now();
    const controller = new AbortController();
    let timedOut = false;

    const timer =
      connectTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, connectTimeoutMs)
        : undefined;
    const forwardAbort = () => controller.abort();

    if (signal?.aborted) {
      if (timer) clearTimeout(timer);
      throw new DOMException('Request was aborted', 'AbortError');
    }
    signal?.addEventListener('abort', forwardAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (fetchError) {
      console.error(`[BaseAdapter] fetch 失败 (耗时: ${Date.now() - fetchStartTime}ms)`, fetchError);

      // 用户主动取消 → 必须保留 AbortError 语义（上层靠它结束流程且不重试）
      if (signal?.aborted || (!timedOut && isAbortError(fetchError))) {
        throw fetchError instanceof DOMException
          ? fetchError
          : new DOMException('Request was aborted', 'AbortError');
      }

      throw new ApiRequestError({
        provider: this.providerType,
        url,
        model: typeof body?.model === 'string' ? body.model : undefined,
        timeoutMs: timedOut ? connectTimeoutMs : undefined,
        summary: timedOut ? undefined : fetchError instanceof Error ? fetchError.message : String(fetchError),
        cause: fetchError,
      });
    } finally {
      // 只清理超时定时器；abort 转发监听保留到本次请求结束，
      // 这样「流建立之后用户点停止」仍能真正取消底层连接
      // （signal 每次对话新建，随请求一起被 GC，不会累积泄漏）
      if (timer) clearTimeout(timer);
    }

    console.log(`[BaseAdapter] fetch 响应收到 (耗时: ${Date.now() - fetchStartTime}ms)`, {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
    });

    if (!response.ok) {
      let errorText = '';
      try {
        errorText = await response.text();
      } catch (readError) {
        console.error(`[BaseAdapter] 读取错误响应体失败`, readError);
      }
      console.error(`[BaseAdapter] API 返回错误`, {
        status: response.status,
        statusText: response.statusText,
        body: errorText.substring(0, 500),
      });
      // 429/503 的 Retry-After 优先于指数退避作为重试等待（秒数形态才识别）
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      // 带上完整原始响应 → UI 可直接渲染 JSON（403 / 429 / 密钥失效等）
      throw new ApiRequestError({
        provider: this.providerType,
        url,
        model: typeof body?.model === 'string' ? body.model : undefined,
        status: response.status,
        statusText: response.statusText,
        rawBody: errorText,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }

    // 2xx 但返回 HTML（地址指向登录页/网关首页）：绝不能当 SSE 流读下去——
    // 读完只会得到零事件，被终态校验拦下时证据也更绕。此处直接带完整页体失败，
    // status=200 → kind=http → 不重试（登录页重试多少次都不会变成 API）。
    const contentType = response.headers.get('content-type') ?? '';
    if (/text\/html/i.test(contentType)) {
      let html = '';
      try {
        html = await response.text();
      } catch (readError) {
        console.error(`[BaseAdapter] 读取 HTML 响应体失败`, readError);
      }
      console.error(`[BaseAdapter] 端点返回 HTML 而非流式响应`, {
        url: sanitizeUrlForLog(url),
        contentType,
      });
      throw new ApiRequestError({
        provider: this.providerType,
        url,
        model: typeof body?.model === 'string' ? body.model : undefined,
        status: response.status,
        statusText: response.statusText,
        summary: t('sidepanel.apiConfig.nonApiResponseBody'),
        rawBody: html,
      });
    }

    const reader = response.body?.getReader();
    if (!reader) {
      console.error(`[BaseAdapter] 无法获取 response reader`, { status: response.status });
      throw new ApiRequestError({
        provider: this.providerType,
        url,
        model: typeof body?.model === 'string' ? body.model : undefined,
        status: response.status,
        statusText: response.statusText,
        summary: t('sidepanel.apiConfig.apiRequestEmptyBody', { status: response.status }),
      });
    }
    return reader;
  }

  // ==================== 通用文本/思考/工具回调触发器 ====================

  /** Keep completed native blocks and visible partial text, but never invent a
   * successful/complete tool invocation from a truncated argument stream. */
  private finalizeInterrupted(acc: StreamAccumulator, callbacks: StreamCallbacks): void {
    const native = acc.finalMessage.nativeReplay;
    const completedCalls = native?.provider === 'claude'
      ? new Set(native.items.filter(b => b?.type === 'tool_use').map(b => b.id))
      : native?.provider === 'openai-responses'
        ? new Set(native.items.filter(b => b?.type === 'function_call').map(b => b.call_id)) : undefined;
    for (const [index, call] of acc.toolCallChunks) {
      let complete = !!call.name && !!call.id && (!completedCalls || completedCalls.has(call.id));
      try { JSON.parse(call.arguments || '{}'); } catch { complete = false; }
      if (!complete) {
        acc.toolCallChunks.delete(index);
        if (call.name || call.arguments) acc.finalMessage.content += `\n[Interrupted tool call, not executed: ${call.name} ${call.arguments}]`;
      }
    }
    const calls = assembleToolCalls(acc.toolCallChunks);
    if (calls.length) acc.finalMessage.tool_calls = calls;
    if (native?.provider === 'claude' || native?.provider === 'openai-responses') {
      native.items = native.items.filter(Boolean);
      const seen = native.provider === 'claude'
        ? native.items.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
        : native.items.filter(b => b.type === 'message').flatMap(b => b.content ?? []).map(p => p.text ?? p.refusal ?? '').join('');
      const text = typeof acc.finalMessage.content === 'string' ? acc.finalMessage.content : '';
      if (text.startsWith(seen) && text.length > seen.length) {
        const tail = text.slice(seen.length);
        native.items.push(native.provider === 'claude' ? { type: 'text', text: tail }
          : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: tail, annotations: [] }] });
      }
    }
    this.finalizeAccumulator(acc, callbacks);
  }

  /** 处理普通文本 token */
  protected handleContentToken(
    token: string,
    acc: StreamAccumulator,
    callbacks: StreamCallbacks
  ): void {
    callbacks.onToken?.(token);
    acc.finalMessage.content += token;
  }

  /** 处理推理/思考内容 token（只走 onReasoning 通道，不混入正式正文） */
  protected handleReasoningToken(
    token: string,
    _acc: StreamAccumulator,
    callbacks: StreamCallbacks
  ): void {
    callbacks.onReasoning?.(token);
  }

  // ==================== 通用 SSE / 文本工具（子类共享） ====================

  /**
   * 提取一行中的 SSE data 载荷：
   * - `event:` 行 / 非 `data:` 行（Ollama 的裸 JSON 行不经此方法）→ null（跳过）
   * - `data:` 行 → 去前缀去空白后的载荷；空载荷 → null
   * 各协议适配器此前各自手写同一段前缀逻辑，收敛于此杜绝漂移。
   */
  protected extractSSEData(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;
    const data = trimmed.slice(5).trim();
    return data || null;
  }

  /** 提取消息的纯文本（字符串原样；多模态取 text part 拼接） */
  protected plainTextOf(content: UnifiedChatMessage['content']): string {
    if (typeof content === 'string') return content;
    return content
      .filter(part => part.type === 'text')
      .map(part => part.text || '')
      .join('\n');
  }

  /**
   * 记录一条解析失败的 SSE 行：单行损坏容错跳过，但计数 + 首行预览必须留痕
   * （全部行都坏 → 终态校验会把它兜成带证据的协议错误，而不是空回复）。
   */
  protected recordParseFailure(acc: StreamAccumulator, line: string): void {
    acc.parseFailures++;
    if (acc.firstBadLine === undefined) {
      const trimmed = line.trim();
      acc.firstBadLine = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
    }
  }

  /**
   * 循环结束后对累积器做后处理。
   * 默认实现统一在流末尾补发 onToolCall（与各协议「工具调用完整后才可知」
   * 的语义一致，发射去重单点化）；子类仅在语义不同时覆盖。
   */
  protected finalizeAccumulator(
    acc: StreamAccumulator,
    callbacks: StreamCallbacks
  ): void {
    if (acc.finalMessage.tool_calls) {
      for (const toolCall of acc.finalMessage.tool_calls) {
        callbacks.onToolCall?.(toolCall);
      }
    }
  }
}

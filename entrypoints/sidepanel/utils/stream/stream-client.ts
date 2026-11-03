/**
 * 多协议流式客户端 — 统一入口
 * 
 * 上层代码（App.vue / vision-chat.ts）只需调用此模块的 streamChat() 方法，
 * 无需关心底层使用的是 OpenAI / Ollama / Gemini / Claude 协议。
 * 
 * 用法：
 *   import { streamClient } from './stream/stream-client';
 *   const result = await streamClient.chat(config, callbacks, { signal });
 */

import type {
  ProviderType,
  ProviderConfig,
  StreamRequestConfig,
  StreamCallbacks,
  StreamResult,
  ProtocolAdapter,
} from './types';

import { driverRegistry } from './driver-registry';
import { prepareVisionRequest } from './vision';
import { ApiRequestError, PermanentRequestError, isAbortError, sanitizeUrlForLog } from './errors';
import { aiUsageMetrics, summarizeErrorForMetrics } from '../metrics/usage-metrics-engine';
import type { TokenUsage } from './types';

// ==================== StreamClient ====================

/**
 * 已确认不支持 stream_options 参数的端点集合（内存级，按请求 URL 记忆）。
 * 旧版 vLLM / 部分自建网关会对未知参数返回 400 —— 首次触发后按端点记忆，
 * 后续请求直接去掉该参数，保证既有可用性不受 usage 统计影响。
 */
const streamOptionsUnsupportedEndpoints = new Set<string>();

/** 判定某错误是否为「端点拒绝 stream_options 参数」导致的 400 */
function isStreamOptionsRejection(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.status === 400 &&
    /stream[_-]?options/i.test(error.rawBody || '')
  );
}

/**
 * 多协议流式客户端
 *
 * 协议驱动的注册与查询统一委托 driverRegistry（协议清单的单一事实源）；
 * 本类只负责「按请求配置选驱动 → 预处理 → 发请求 → 解析流 → 重试与指标」。
 */
export class StreamClient {
  /**
   * 发送流式聊天请求（支持自动重试 + 指数退避）
   * 
   * @param config - 请求配置（包含 messages, tools 等）
   * @param callbacks - 流式事件回调
   * @param options - 可选参数（signal、providerConfig、retryCount、retryIntervalMs 等）
   * @returns 流式结果
   */
  async chat(
    config: StreamRequestConfig,
    callbacks: StreamCallbacks,
    options: {
      signal?: AbortSignal;
      /**
       * 端点配置快照（provider/baseUrl/apiKey/model）。
       * 必填：请求层绝不回读全局配置，同一次运行内的全部请求
       * （含工具循环后续轮次）使用完全一致的协议/端点/凭据。
       */
      providerConfig?: ProviderConfig;
      retryCount?: number;
      /** 重试间隔基数（毫秒）：指数退避 + equal jitter 的基准值，默认 2000ms */
      retryIntervalMs?: number;
    } = {}
  ): Promise<StreamResult> {
    const providerConfig = options.providerConfig;
    if (!providerConfig) {
      throw new Error('StreamClient.chat: providerConfig is required (endpoint snapshot must be passed explicitly).');
    }

    const maxRetries = options.retryCount ?? 0;
    let lastError: Error | null = null;

    // 流中发射守卫：一旦已向调用方发射过任何内容（token / 推理 / 工具调用），
    // 重试会把同一内容从头再发射一遍——上层（会话引擎的转录累积、UI 流式渲染）
    // 无法去重，会造成正文重复。因此「已发射后失败」一律直接抛出，
    // 由调用方以错误卡片呈现（部分内容保留，不重复）。建连阶段失败
    // （未发射任何内容）不受影响，照常重试。
    let streamEmitted = false;
    const guardedCallbacks: StreamCallbacks = {
      ...callbacks,
      onToken: token => {
        streamEmitted = true;
        callbacks.onToken?.(token);
      },
      onReasoning: reasoning => {
        streamEmitted = true;
        callbacks.onReasoning?.(reasoning);
      },
      onToolCall: toolCall => {
        streamEmitted = true;
        callbacks.onToolCall?.(toolCall);
      },
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 检查是否已被取消
      if (options.signal?.aborted) {
        throw new DOMException('Request was aborted', 'AbortError');
      }

      try {
        if (attempt > 0) {
          // 服务端 Retry-After（429/503 携带）优先于本地退避——服务器比客户端
          // 更清楚何时解除限流；秒数形态才识别，封顶 60s 防异常头挂死重试节奏
          const serverDelayMs = lastError instanceof ApiRequestError ? lastError.retryAfterMs : undefined;
          // 指数退避 + equal jitter：exp = min(cap, base * 2^(attempt-1))，
          // delay = exp/2 + rand(0, exp/2)。纯指数退避（无抖动）在多客户端共享
          // 同一网关时会相位同步地重试（AWS 架构博客《Exponential Backoff And
          // Jitter》的结论：无抖动方案是最差选择）；equal jitter 在保留平均
          // 间隔的同时打散相位，兼顾单客户端的时延可预期性。
          // base 默认 2s；上限 max(30s, base*4)。
          const baseDelayMs = Math.max(100, options.retryIntervalMs ?? 2000);
          const maxDelayMs = Math.max(30000, baseDelayMs * 4);
          const exponentialMs = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
          const delayMs =
            serverDelayMs !== undefined
              ? Math.min(serverDelayMs, 60000)
              : Math.floor(exponentialMs / 2 + Math.random() * (exponentialMs / 2));
          console.warn(`[StreamClient] 第 ${attempt} 次重试，等待 ${delayMs / 1000}s 后重试...`);
          callbacks.onRetry?.(attempt, delayMs);
          await this.sleep(delayMs, options.signal);
        }

        if (attempt === 0) {
          console.log(`[StreamClient] 开始请求 (最大重试: ${maxRetries})`);
        }

        const result = await this.executeRequest(config, guardedCallbacks, providerConfig, options.signal);
        return result;
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // 不重试的错误类型
        if (this.isNonRetryableError(error)) {
          console.error(`[StreamClient] 不可重试错误，直接抛出`, error.message);
          throw lastError;
        }

        // 流中失败：已有内容发射，重试会导致内容重复——直接抛出
        if (streamEmitted) {
          console.error(
            `[StreamClient] 流中失败且已有内容发射，跳过重试以避免内容重复`,
            error.message
          );
          throw lastError;
        }

        // 最后一次重试也失败了，抛出错误
        if (attempt === maxRetries) {
          console.error(`[StreamClient] 所有重试耗尽 (${maxRetries + 1} 次)`, error.message);
          throw lastError;
        }

        console.warn(
          `[StreamClient] 请求失败 (第 ${attempt + 1}/${maxRetries + 1} 次)，准备重试:`,
          error.message || error
        );
      }
    }

    throw lastError || new Error('Unexpected retry loop exit');
  }

  /**
   * 执行单次请求（不含重试逻辑）
   *
   * 监控插桩：每个真实发出的 HTTP 尝试都计入用量指标（含自动重试的每次尝试）；
   * stream_options 兼容降级：OpenAI 协议为获取流式 usage 会带上
   * stream_options.include_usage，个别旧网关对其返回 400 —— 捕获后去掉该参数
   * 立即重发一次并按端点记忆，降级重发对指标不可见（整次 executeRequest 只计一次）。
   */
  private async executeRequest(
    config: StreamRequestConfig,
    callbacks: StreamCallbacks,
    providerConfig: ProviderConfig,
    signal?: AbortSignal
  ): Promise<StreamResult> {
    const adapter = this.getAdapter(providerConfig.provider);

    // 视觉内容预处理：能力校验（不支持视觉直接报错）+ 远程图片转 base64（按协议需要）
    const preparedConfig = await prepareVisionRequest(
      providerConfig.provider,
      adapter.capabilities,
      config
    );

    // 构建请求体
    const body = adapter.buildRequestBody(preparedConfig);

    // 获取请求 URL
    const url = this.resolveRequestUrl(adapter, providerConfig);

    // 获取请求头
    const headers = adapter.getRequestHeaders(providerConfig.apiKey, providerConfig.customHeaders);

    // 已知不兼容端点：直接去掉 stream_options（OpenAI 请求体才会有该字段）
    if (body?.stream_options && streamOptionsUnsupportedEndpoints.has(url)) {
      delete body.stream_options;
    }

    console.log(`[StreamClient] 发起请求`, {
      provider: providerConfig.provider,
      url: sanitizeUrlForLog(url).substring(0, 120),
      hasApiKey: !!providerConfig.apiKey,
      model: config.model,
      messageCount: config.messages.length,
      stream: config.stream,
      hasTools: !!(config.tools?.length),
    });

    const fetchStartTime = Date.now();

    // ---- 用量指标：本次尝试的结局在此统一判定 ----
    // 声明在 fetch 之前：建连失败 / HTTP 错误 / 流内错误 / 用户中止，全路径都会经过 finally 计数
    let outcome: 'success' | 'failed' | 'aborted' = 'success';
    let usage: TokenUsage | undefined;
    let errorSummary: string | undefined;

    try {
      // 发送请求，获取 reader（stream_options 400 → 自动降级重发一次）
      const reader = await this.fetchStreamWithCompatibilityFallback(
        adapter,
        url,
        headers,
        body,
        signal
      );

      console.log(`[StreamClient] 连接已建立，开始读取流 (耗时: ${Date.now() - fetchStartTime}ms)`);

      // 解析流式响应（context 供协议异常错误定位 provider/url/model）
      const result = await adapter.parseStreamResponse(reader, callbacks, signal, {
        provider: providerConfig.provider,
        url,
        model: config.model,
      });

      console.log(`[StreamClient] 流读取完成 (总耗时: ${Date.now() - fetchStartTime}ms)`, {
        finishReason: result.finishReason,
        contentLength: String(result.finalMessage.content).length,
        hasToolCalls: !!result.finalMessage.tool_calls?.length,
        usage: result.usage,
      });

      // 用户中止：流正常返回但带 abort 标记（部分 token 已消耗，照常计入）
      outcome = result.finishReason === 'abort' ? 'aborted' : 'success';
      usage = result.usage;
      return result;
    } catch (error) {
      if (isAbortError(error)) {
        outcome = 'aborted';
      } else {
        outcome = 'failed';
        errorSummary = summarizeErrorForMetrics(error);
      }
      throw error;
    } finally {
      // fire-and-forget 计数：永不抛错，绝不影响请求主流程
      aiUsageMetrics.record({
        ...config.metrics,
        provider: providerConfig.provider,
        model: config.model,
        kind: config.metrics?.kind ?? 'chat',
        outcome,
        usage,
        errorSummary,
      });
    }
  }

  /**
   * 发送请求并获取 reader；OpenAI 协议携带 stream_options 遇到 400 拒绝时，
   * 去掉该参数立即重发一次（并按端点记忆，后续请求不再携带）。
   */
  private async fetchStreamWithCompatibilityFallback(
    adapter: ProtocolAdapter,
    url: string,
    headers: Record<string, string>,
    body: any,
    signal?: AbortSignal
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    try {
      return await adapter.fetchStream(url, headers, body, signal);
    } catch (error) {
      if (!body?.stream_options || !isStreamOptionsRejection(error)) {
        throw error;
      }
      // 明确由 stream_options 引发的 400：降级重发（不计入失败指标，对调用方透明）
      console.warn(
        `[StreamClient] 端点拒绝 stream_options，去掉该参数重发 (url=${sanitizeUrlForLog(url)})`,
      );
      streamOptionsUnsupportedEndpoints.add(url);
      delete body.stream_options;
      return await adapter.fetchStream(url, headers, body, signal);
    }
  }

  /**
   * 判断是否为不可重试的错误
   *
   * 规则（与 ApiRequestError.isRetryable 同源）：
   *   - 用户主动取消 → 不重试
   *   - 永久性前置错误（协议能力不匹配等确定性失败）→ 不重试
   *   - 4xx 永久失败（401 密钥失效、403 无权限、404 地址错、400 参数错…）→ 不重试
   *   - 408 超时 / 429 限流 / 5xx 服务端错误 / 网络不可达 / 建连超时 → 重试
   *   - 协议异常 / 流内服务端错误 → 重试（可能瞬时恢复；已有内容发射时由
   *     发射守卫兜底不重试）
   */
  private isNonRetryableError(error: any): boolean {
    // 用户主动取消
    if (isAbortError(error)) return true;

    // 确定性前置失败（如协议不支持图片输入）：重试必然同样失败
    if (error instanceof PermanentRequestError) return true;

    // 结构化错误：直接使用其可重试判定
    if (error instanceof ApiRequestError) {
      return !error.isRetryable;
    }

    // 兼容非结构化错误：从 status / response.status 推断
    const status = error?.status ?? error?.response?.status;
    if (typeof status === 'number' && status >= 400 && status < 600) {
      if (status >= 500) return false; // 服务端错误 → 重试
      if (status === 408 || status === 429) return false; // 超时 / 限流 → 重试
      return true; // 其余 4xx → 永久失败
    }

    return false;
  }

  /**
   * 可中断的延迟（支持 AbortSignal）
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Request was aborted', 'AbortError'));
        return;
      }

      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Request was aborted during retry delay', 'AbortError'));
      };

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * 获取指定协议的适配器（经驱动注册表查询；未知协议抛带可用清单的可读错误）
   */
  getAdapter(providerType: ProviderType): ProtocolAdapter {
    return driverRegistry.get(providerType).adapter;
  }

  /**
   * 获取所有已注册的协议驱动 id
   */
  getAvailableProviders(): ProviderType[] {
    return driverRegistry.ids();
  }

  /**
   * 获取指定协议的能力声明（视觉/工具/推理）
   */
  getCapabilities(providerType: ProviderType) {
    return driverRegistry.get(providerType).adapter.capabilities;
  }

  /**
   * 解析请求 URL：协议经 buildRequestUrl（可选接口）统一分派——
   * key 放 query 的协议（Gemini）在此注入认证；其余协议回落 getRequestUrl。
   * 消费方绝不各自 instanceof 具体适配器（驱动注册表是协议清单唯一事实源）。
   */
  private resolveRequestUrl(adapter: ProtocolAdapter, config: ProviderConfig): string {
    if (adapter.buildRequestUrl) {
      return adapter.buildRequestUrl(config.baseUrl, config.apiKey, config.model);
    }
    return adapter.getRequestUrl(config.baseUrl, config.model);
  }
}

// 导出单例实例
export const streamClient = new StreamClient();

// 同时导出类，方便测试或多实例场景
export default streamClient;

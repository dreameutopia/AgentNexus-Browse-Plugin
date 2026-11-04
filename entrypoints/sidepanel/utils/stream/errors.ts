/**
 * 结构化 API 请求错误 —— 全链路错误处理的单一事实源
 *
 * 设计目标：
 *  1. 保留原始响应：rawBody（未裁剪的响应文本）+ json（解析结果），
 *     UI 可完整渲染「原始响应 JSON」（403 / 限流 / 密钥失效等场景都能看到服务端原文）
 *  2. Error.message 直接是「可展示 Markdown」：状态行 + 原因 + 原始响应代码块，
 *     因此任何 catch 点（App.vue 对话、vision-chat、API 配置弹窗）只要展示
 *     error.message 就能看到完整信息，无需各处重复格式化
 *  3. 重试决策可编程：isRetryable —— 4xx（408/429 除外）判定为永久失败不重试，
 *     5xx / 网络错误 / 超时 / 协议异常 / 流内服务端错误判定为可重试
 *     （后两类是「连接已建立但对端行为异常」，重试可能恢复；已有内容发射时
 *       由 StreamClient 的发射守卫兜底不重试，不会造成正文重复）
 *  4. 不吞 AbortError：用户主动取消必须原样抛出（上层依赖 name === 'AbortError'）
 *  5. 摘要提取兼容各协议错误体结构 + 非 JSON 的网关 HTML 页
 *  6. 日志与展示安全：url 一律经 sanitizeUrlForLog 脱敏（Gemini 把 key 放
 *     query，任何日志/卡片/指标都绝不能泄出密钥——与「apiKey 绝不写日志」同约）
 */

import { t } from '@/utils/i18n/core';
import { escapeXmlText } from '../xml-entities';
import type { ProviderType } from './types';

/** 展示用响应体最大长度（完整内容始终保留在 rawBody 字段中） */
const MAX_DISPLAY_BODY = 4000;
/** 非 JSON 响应的摘要截断长度 */
const MAX_SUMMARY_BODY = 200;
/** rawBody 入库上限：HTML 错误页可达 MB 级，超限截断防内存失控（展示层另有 4000 上限） */
const MAX_RAW_BODY = 1024 * 1024;
/** 单行预览长度（协议异常诊断：首行/坏行入 rawBody 供错误卡片分析） */
const MAX_LINE_PREVIEW = 300;
/** URL 中需要脱敏的 query 参数名（密钥类；命中即把值替换为 ***） */
const SECRET_QUERY_PATTERN =
  /([?&](?:key|token|api_key|apikey|access_token|auth|password|secret|sig|signature)=)[^&]*/gi;

/**
 * 日志/展示安全的 URL：把密钥类 query 参数值替换为 ***。
 * 所有控制台日志、错误卡片、指标摘要中的 url 都必须先经过它。
 */
export function sanitizeUrlForLog(url: string): string {
  if (typeof url !== 'string' || url === '') return url;
  return url.replace(SECRET_QUERY_PATTERN, '$1***');
}

/**
 * 解析 Retry-After 响应头（仅接受「秒数」形态；HTTP-date 形态返回 undefined
 * 由指数退避兜底——日期解析在跨时钟场景下反而不可靠）。
 */
export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (typeof header !== 'string') return undefined;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

/**
 * 按内容计算围栏长度（CommonMark：围栏必须长于内容中最长的连续反引号串）。
 * 固定 ``` 会被含 3+ 反引号的响应体破栏，导致错误卡片正文结构被注入破坏。
 */
export function fenceFor(text: string): string {
  const runs = text.match(/`+/g);
  let longest = 0;
  for (const run of runs ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

// ==================== 通用工具 ====================

/** 安全 JSON 解析：非法 / 空文本返回 undefined */
export function parseJsonSafe(text: string | undefined): any | undefined {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** 美化 JSON；非 JSON 原样返回 */
export function prettyJson(raw: string): string {
  const json = parseJsonSafe(raw);
  if (json === undefined) return raw;
  try {
    return JSON.stringify(json, null, 2);
  } catch {
    return raw;
  }
}

/**
 * 从任意协议的错误体中提取一行可读摘要
 * 兼容：OpenAI/Anthropic/Gemini `{error:{message}}`、Ollama `{error:"..."}`、
 *       FastAPI `{detail}`、以及非 JSON 的网关 HTML 页
 */
export function extractErrorSummary(raw?: string, parsed?: any): string | null {
  const body = parsed ?? parseJsonSafe(raw);

  if (body && typeof body === 'object') {
    const error = body.error;
    if (typeof error === 'string' && error.trim()) return error.trim();

    if (error && typeof error === 'object') {
      const candidate = error.message || error.msg || error.type || error.code;
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }

    const candidates = [
      typeof body.message === 'string' ? body.message : body.message?.error,
      typeof body.detail === 'string' ? body.detail : body.detail?.[0]?.msg,
      body.status_message,
      body.error_message,
      typeof body.error?.errors?.[0]?.message === 'string'
        ? body.error.errors[0].message
        : undefined,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }

  if (typeof raw === 'string' && raw.trim()) {
    // 非 JSON（HTML 网关页 / 纯文本）→ 去标签 + 压缩空白
    const flat = raw.replace(/\s+/g, ' ').trim();
    const text = flat.replace(/<[^>]*>/g, '').trim();
    return (text || flat).slice(0, MAX_SUMMARY_BODY);
  }

  return null;
}

/** 无摘要时按状态码兜底（保证用户永远能看到一句人话） */
function fallbackSummaryByStatus(status?: number): string {
  switch (status) {
    case 401:
    case 403:
      return t('sidepanel.apiConfig.authErrorFallback');
    case 404:
      return t('sidepanel.apiConfig.notFoundFallback');
    case 429:
      return t('sidepanel.apiConfig.rateLimitFallback');
    default:
      if (typeof status === 'number' && status >= 500) {
        return t('sidepanel.apiConfig.serverErrorFallback', { status });
      }
      // 其余 4xx（400/402/405/410/422…）：不能落回「连接失败」——
      // 标题已是 HTTP 状态行，原因必须解释「请求被拒绝」而非连不上
      if (typeof status === 'number' && status >= 400) {
        return t('sidepanel.apiConfig.clientErrorFallback', { status });
      }
      return '';
  }
}

function truncateForDisplay(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n' + t('sidepanel.apiConfig.responseTruncated');
}

// ==================== ApiRequestError ====================

export interface ApiRequestErrorInit {
  provider?: ProviderType;
  url?: string;
  /** 模型名（错误报告定位用；适配器从请求体自动提取） */
  model?: string;
  /** HTTP 状态码；网络层失败时缺省 */
  status?: number;
  statusText?: string;
  /** 原始响应文本（网络层失败时为空） */
  rawBody?: string;
  /** 单行摘要；缺省时按 rawBody → 状态码 自动推导 */
  summary?: string;
  /** 触发超时的时间（仅超时错误） */
  timeoutMs?: number;
  /**
   * 错误类别覆盖：不传时按 status/timeoutMs 自动推导
   * （http / timeout / network）；流协议异常与流内服务端错误必须显式指定
   * （它们没有 HTTP 状态码，但语义上既非网络故障也非超时）。
   */
  kind?: Extract<ApiRequestErrorKind, 'protocol' | 'inband'>;
  /** 服务端 Retry-After 头（毫秒；429/503 时优先于指数退避作为重试等待） */
  retryAfterMs?: number;
  cause?: unknown;
}

/** 错误类别：http（有状态码）/ timeout / network / protocol（流协议异常）/ inband（流内服务端错误） */
export type ApiRequestErrorKind = 'http' | 'timeout' | 'network' | 'protocol' | 'inband';

export class ApiRequestError extends Error {
  readonly name = 'ApiRequestError';
  readonly kind: ApiRequestErrorKind;
  readonly provider?: ProviderType;
  readonly url?: string;
  /** 模型名（错误报告定位用） */
  readonly model?: string;
  readonly status?: number;
  readonly statusText?: string;
  /** 完整原始响应（不裁剪；超长时构造期截断到 MAX_RAW_BODY） */
  readonly rawBody: string;
  /** 解析后的 JSON；非 JSON 时为 undefined */
  readonly json?: any;
  /** 单行可读摘要 */
  readonly summary: string;
  readonly timeoutMs?: number;
  /** 服务端 Retry-After（毫秒）；重试退避优先采用 */
  readonly retryAfterMs?: number;
  /** 错误发生时刻（ISO）：卡片与报告展示「何时」，重渲染不漂移 */
  readonly occurredAt: string;

  constructor(init: ApiRequestErrorInit) {
    const rawBody = (init.rawBody ?? '').slice(0, MAX_RAW_BODY);
    const json = parseJsonSafe(rawBody);
    const causeMessage = init.cause instanceof Error ? init.cause.message : '';
    const kind: ApiRequestErrorKind =
      init.kind ?? (typeof init.status === 'number' ? 'http' : init.timeoutMs ? 'timeout' : 'network');
    // 超时场景不透传 AbortError 原文（会与“请求超时”状态行矛盾）
    const summary =
      init.summary?.trim() ||
      extractErrorSummary(rawBody, json) ||
      fallbackSummaryByStatus(init.status) ||
      (kind === 'timeout'
        ? t('sidepanel.apiConfig.apiRequestTimeout', {
            seconds: Math.max(1, Math.round((init.timeoutMs ?? 60000) / 1000)),
          })
        : '') ||
      (kind === 'network' ? causeMessage : '');

    super(ApiRequestError.buildMessage(kind, init, summary, rawBody, json));

    this.kind = kind;
    this.provider = init.provider;
    // 入库前脱敏：Gemini 等把密钥放 query，原始 url 绝不进入日志/卡片/指标
    this.url = typeof init.url === 'string' && init.url ? sanitizeUrlForLog(init.url) : undefined;
    this.model = init.model;
    this.status = init.status;
    this.statusText = init.statusText;
    this.rawBody = rawBody;
    this.json = json;
    this.summary = summary || t('sidepanel.apiConfig.connectFailed');
    this.timeoutMs = init.timeoutMs;
    this.retryAfterMs = init.retryAfterMs;
    this.occurredAt = new Date().toISOString();

    if (init.cause !== undefined) {
      // 保留原始异常，便于控制台排查（Error.cause 为 ES2022，运行时 Chrome 均支持）
      try {
        (this as any).cause = init.cause;
      } catch {
        /* 老实现只读 cause，忽略即可 */
      }
    }
  }

  /** 组装「可直接展示」的 Markdown 文本 */
  private static buildMessage(
    kind: ApiRequestErrorKind,
    init: ApiRequestErrorInit,
    summary: string,
    rawBody: string,
    json: any
  ): string {
    let statusLine: string;
    if (typeof init.status === 'number') {
      statusLine = t('sidepanel.apiConfig.apiRequestStatus', {
        status: init.status,
        statusText: init.statusText || '',
      }).trim();
    } else if (init.timeoutMs) {
      statusLine = t('sidepanel.apiConfig.apiRequestTimeout', {
        seconds: Math.max(1, Math.round(init.timeoutMs / 1000)),
      });
    } else if (kind === 'inband') {
      statusLine = t('sidepanel.apiConfig.apiErrorInbandTitle');
    } else if (kind === 'protocol') {
      statusLine = t('sidepanel.apiConfig.apiErrorProtocolTitle');
    } else {
      statusLine = t('sidepanel.apiConfig.apiRequestNetwork');
    }

    const lines: string[] = [statusLine];

    if (summary) {
      lines.push(`**${t('sidepanel.apiConfig.errorReason')}**: ${summary}`);
    }

    const displayBody = truncateForDisplay(rawBody.trim(), MAX_DISPLAY_BODY);
    if (displayBody) {
      const fence = fenceFor(displayBody);
      lines.push(
        `**${t('sidepanel.apiConfig.rawResponseLabel')}**:\n${fence}${json !== undefined ? 'json' : 'text'}\n${displayBody}\n${fence}`
      );
    }

    return lines.join('\n\n');
  }

  /** 已是可展示文本，直接复用 message */
  toDisplayMessage(): string {
    return this.message;
  }

  /** 超时 */
  get isTimeout(): boolean {
    return this.kind === 'timeout';
  }

  /** 网络不可达（DNS / CORS / 服务未启动） */
  get isNetwork(): boolean {
    return this.kind === 'network';
  }

  /** 鉴权失败（密钥无效 / 过期 / 无权限） */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** 限流 */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /**
   * 是否值得重试：
   * - 网络错误 / 超时 / 5xx / 429 / 408 → 可重试
   * - 其余 4xx（401 密钥失效、403 无权限、404 地址错、400 参数错等）→ 永久失败，不重试
   */
  get isRetryable(): boolean {
    if (this.kind !== 'http') return true;
    const status = this.status as number;
    if (status >= 500) return true;
    if (status === 408 || status === 429) return true;
    return false;
  }

  /** 紧凑单行（日志 / 通知用，不含原始响应） */
  toSingleLine(): string {
    const status = typeof this.status === 'number' ? ` [${this.status}${this.statusText ? ' ' + this.statusText : ''}]` : '';
    return `${this.summary || t('sidepanel.apiConfig.connectFailed')}${status}`;
  }
}

/** 是否为用户主动取消 */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException || error instanceof Error) &&
    (error as Error).name === 'AbortError'
  );
}

// ==================== 对话流错误卡片（<api-error> XML）====================

/** 分类 → 徽章短标签（ localized，供卡片头部展示） */
function apiErrorBadgeLabel(error: ApiRequestError): string {
  if (error.isTimeout) return t('sidepanel.apiConfig.apiErrorBadgeTimeout');
  if (error.isNetwork) return t('sidepanel.apiConfig.apiErrorBadgeNetwork');
  // 流内服务端错误（HTTP 200 后对端下发 error 事件）与流协议异常：
  // 没有状态码，但绝不能落入「网络错误 / 请求被拒绝」的错误归类
  if (error.kind === 'inband') return t('sidepanel.apiConfig.apiErrorBadgeServer');
  if (error.kind === 'protocol') return t('sidepanel.apiConfig.apiErrorBadgeProtocol');
  const status = error.status;
  if (status === 401 || status === 403) return t('sidepanel.apiConfig.apiErrorBadgeAuth');
  if (status === 429) return t('sidepanel.apiConfig.apiErrorBadgeRateLimit');
  if (status === 404) return t('sidepanel.apiConfig.apiErrorBadgeNotFound');
  if (typeof status === 'number' && status >= 500) return t('sidepanel.apiConfig.apiErrorBadgeServer');
  return t('sidepanel.apiConfig.apiErrorBadgeClient');
}

/** 分类 → 卡片标题（状态行 / 超时时长 / 网络失败，与 ApiRequestError.message 首行同源） */
function apiErrorCardTitle(error: ApiRequestError): string {
  if (typeof error.status === 'number') {
    const suffix = error.statusText ? ` ${error.statusText}` : '';
    return `HTTP ${error.status}${suffix}`;
  }
  if (error.isTimeout) {
    return t('sidepanel.apiConfig.apiRequestTimeout', {
      seconds: Math.max(1, Math.round((error.timeoutMs ?? 0) / 1000)),
    });
  }
  if (error.kind === 'inband') return t('sidepanel.apiConfig.apiErrorInbandTitle');
  if (error.kind === 'protocol') return t('sidepanel.apiConfig.apiErrorProtocolTitle');
  return t('sidepanel.apiConfig.apiRequestNetwork');
}

/**
 * 任意错误 → 对话流错误卡片 XML（<api-error>）。
 *
 * - ApiRequestError：携带分类（kind）、状态码、provider、超时时长、
 *   单行摘要与完整原始响应（美化 JSON / 原文）；
 * - 其余错误（含流内 in-band 错误的完整 Markdown 原文）：归入 kind="error"，
 *   原始消息全文保留在 <raw> 中——满足「用户必须能看到最原始的原因」。
 *
 * 该 XML 由 markdown-renderer 识别并渲染为样式化错误卡片；
 * 属性中的文本均经 XML 转义，正文结构不会被响应内容注入破坏。
 */
export function toApiErrorBlock(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const attrs = [
      `kind="${error.kind}"`,
      typeof error.status === 'number' ? `status="${error.status}"` : '',
      `title="${escapeXmlText(apiErrorCardTitle(error))}"`,
      `label="${escapeXmlText(apiErrorBadgeLabel(error))}"`,
      error.provider ? `provider="${error.provider}"` : '',
      error.model ? `model="${escapeXmlText(error.model)}"` : '',
      // 端点定位（多渠道场景「哪个地址出错」）；构造期已脱敏，密钥不会入卡片
      error.url ? `url="${escapeXmlText(error.url)}"` : '',
      error.isTimeout ? `timeout="${error.timeoutMs ?? 0}"` : '',
      // 发生时间（ISO，取错误构造时刻）：错误报告定位「何时」；复制报告时原样携带
      `occurred-at="${error.occurredAt}"`,
    ]
      .filter(Boolean)
      .join(' ');

    const rawBody = error.rawBody.trim();
    const rawText = rawBody ? prettyJson(rawBody) : '';
    const summary = error.summary.trim();

    return (
      `<api-error ${attrs}>\n` +
      (summary ? `<summary>${escapeXmlText(summary)}</summary>\n` : '') +
      (rawText ? `<raw>\n${escapeXmlText(rawText)}\n</raw>\n` : '') +
      `</api-error>`
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split('\n')[0]?.trim() || t('sidepanel.apiConfig.apiErrorUnexpected');
  return (
    `<api-error kind="error" label="${escapeXmlText(t('sidepanel.apiConfig.apiErrorUnexpected'))}">\n` +
    `<summary>${escapeXmlText(firstLine)}</summary>\n` +
    (message.trim() !== firstLine ? `<raw>\n${escapeXmlText(message)}\n</raw>\n` : '') +
    `</api-error>`
  );
}

/**
 * 构造「流内错误事件」结构化错误（HTTP 已 200 建连，但流里带出
 * `error` / `response.failed` 等事件——典型：配额耗尽、模型无权限、
 * 上游限流、内容策略拦截）。
 *
 * 设计：
 *   - 走 ApiRequestError 体系（kind='inband'）：分类徽章、provider/model/url
 *     定位、指标单行摘要、原始事件 JSON 全部复用统一错误卡片，不再是无分类的裸 Error；
 *   - summary 保留协议前缀（`OpenAI API error: …`）：日志检索与「错误必须能
 *     一眼看出是哪个协议」都依赖它；
 *   - 无论服务端是否给 message，rawBody 恒携带**原始事件 JSON**，满足
 *     「错误必须能看到服务端原文」的要求；
 *   - message 可能是非字符串（网关把 error.message 下发为对象/数字），
 *     此处防御性归一，绝不因 .trim() 抛 TypeError 吞掉错误事件本身。
 *
 * 可重试性保持「可重试」（与旧裸 Error 行为一致）：流内 429/overloaded 类
 * 瞬时错误靠重试自愈；已发射内容后的重复风险由 StreamClient 发射守卫兜底。
 */
export function createInBandError(init: {
  /** 协议前缀，如 `OpenAI API error` */
  prefix: string;
  /** 服务端给的可读 message（类型不可信，任意值） */
  message?: unknown;
  /** 原始事件对象/文本 */
  rawEvent: unknown;
  provider?: ProviderType;
  url?: string;
  model?: string;
}): ApiRequestError {
  let rawText: string;
  try {
    rawText =
      typeof init.rawEvent === 'string'
        ? init.rawEvent
        : JSON.stringify(init.rawEvent, null, 2) ?? String(init.rawEvent);
  } catch {
    rawText = String(init.rawEvent);
  }

  const serverMessage =
    typeof init.message === 'string' && init.message.trim()
      ? init.message.trim()
      : extractErrorSummary(rawText, parseJsonSafe(rawText)) || t('sidepanel.apiConfig.apiErrorUnexpected');

  return new ApiRequestError({
    kind: 'inband',
    provider: init.provider,
    url: init.url,
    model: init.model,
    summary: `${init.prefix}: ${serverMessage}`,
    rawBody: rawText,
  });
}

/**
 * 永久性请求前置错误（协议能力不匹配等**确定性**失败）。
 *
 * 与 ApiRequestError 并行的轻量标记类：语义上「重试必然同样失败」，
 * StreamClient 据此跳过重试（否则视觉不支持这类确定性错误会白跑
 * retryCount 次往返）。展示层走通用错误分支，message 即完整可读文案。
 */
export class PermanentRequestError extends Error {
  readonly name = 'PermanentRequestError';
}

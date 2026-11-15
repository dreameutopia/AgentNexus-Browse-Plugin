/**
 * 页面上下文有界 HTTP 链（browser_page_http）
 *
 * 插件专用：只在目标页面的上下文里发起 GET 请求，继承页面 Cookie / Referer /
 * CORS 语义；请求列表由已签名的插件工具 JSON 固定，模型只能填充声明过的输入。
 * 无 pluginKey 时直接拒绝，避免内置智能体绕过插件能力边界。
 */
import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { executeScriptBounded } from '../common/frame-read';
import { resolveTabOrigin } from '../common/plugin-origin';
import { resolveWorkflowPath } from '@/utils/plugins/workflow';

const MAX_REQUESTS = 4;
const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_RESPONSE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 15_000;
/**
 * 单请求默认超时低于工作流单步预算（15s），确保「请求超时」作为业务失败
 * 返回给可选步骤，而不是与步骤硬超时同时触发被归为 WORKFLOW_TIMEOUT。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_TOTAL_TIMEOUT_MS = 45_000;

interface HttpRequest {
  url: string;
  credentials?: 'include' | 'omit';
  response?: 'json' | 'text';
  project?: string | string[] | Record<string, string>;
  optional?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

interface PageHttpArgs {
  location?: string;
  tabId?: number;
  requests?: HttpRequest[];
  totalTimeoutMs?: number;
}

interface PageHttpResponse {
  url: string;
  status: number;
  ok: boolean;
  data: unknown;
  bytes: number;
  truncated?: boolean;
  error?: string;
}

/**
 * 页面内执行函数（必须完全自包含）。
 * 只做顺序 fetch + 有界流式读取，不执行任何动态代码。
 */
async function fetchChainInPage(payloadJson: string): Promise<PageHttpResponse[]> {
  const payload = JSON.parse(payloadJson) as {
    requests: Array<{
      url: string;
      credentials: 'include' | 'omit';
      response: 'json' | 'text';
      timeoutMs: number;
      maxBytes: number;
    }>;
  };
  const results: PageHttpResponse[] = [];
  const decoder = new TextDecoder();
  for (const request of payload.requests) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: 'GET',
        credentials: request.credentials,
        redirect: 'error',
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let truncated = false;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          if (bytes + value.length > request.maxBytes) {
            const remain = request.maxBytes - bytes;
            if (remain > 0) chunks.push(value.slice(0, remain));
            bytes += Math.max(0, remain);
            truncated = true;
            await reader.cancel();
            break;
          }
          chunks.push(value);
          bytes += value.length;
        }
      }
      const text = decoder.decode(
        chunks.reduce((all, chunk) => {
          const next = new Uint8Array(all.length + chunk.length);
          next.set(all);
          next.set(chunk, all.length);
          return next;
        }, new Uint8Array()),
      );
      let data: unknown = text;
      let error: string | undefined;
      if (request.response === 'json') {
        if (!text.trim()) {
          data = null;
        } else if (truncated) {
          // 截断导致的解析失败要与“响应根本不是 JSON”区分开
          error = 'RESPONSE_TRUNCATED';
        } else {
          try {
            data = JSON.parse(text);
          } catch {
            error = 'RESPONSE_NOT_JSON';
          }
        }
      }
      results.push({
        url: request.url,
        status: response.status,
        ok: response.ok,
        data,
        bytes,
        truncated: truncated || undefined,
        error,
      });
    } catch (error) {
      results.push({
        url: request.url,
        status: 0,
        ok: false,
        data: undefined,
        bytes: 0,
        error: controller.signal.aborted
          ? 'REQUEST_TIMEOUT'
          : error instanceof Error
            ? error.message
            : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}

interface NormalizedRequest {
  url: string;
  credentials: 'include' | 'omit';
  response: 'json' | 'text';
  project?: string | string[] | Record<string, string>;
  optional: boolean;
  timeoutMs: number;
  maxBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectValue(value: unknown, project: HttpRequest['project']): unknown {
  if (!project) return value;
  if (typeof project === 'string') return resolveWorkflowPath(value, project);
  if (Array.isArray(project))
    return project.map((path) => resolveWorkflowPath(value, path));
  return Object.fromEntries(
    Object.entries(project).map(([key, path]) => [
      key,
      resolveWorkflowPath(value, path),
    ]),
  );
}

/** 投影路径清单：用于在取值缺失时给出“哪条路径没取到”的可读错误 */
function projectPaths(project: HttpRequest['project']): string[] {
  if (!project) return [];
  if (typeof project === 'string') return [project];
  if (Array.isArray(project)) return project;
  return Object.values(project);
}

/** 投影路径长度上限：与工具 schema 的声明保持一致 */
const MAX_PROJECT_PATH = 256;

/** 返回校验失败原因；null 表示合法 */
function pathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || !path.trim()) return '必须是非空字符串';
  if (path.length > MAX_PROJECT_PATH) return `长度不能超过 ${MAX_PROJECT_PATH}`;
  return null;
}

function projectProblem(project: unknown): string | null {
  if (project === undefined) return null;
  if (typeof project === 'string') {
    const problem = pathProblem(project);
    return problem ? `project 路径${problem}` : null;
  }
  if (Array.isArray(project)) {
    if (!project.length) return 'project 数组不能为空';
    for (const path of project) {
      const problem = pathProblem(path);
      if (problem) return `project 数组元素${problem}`;
    }
    return null;
  }
  if (isRecord(project)) {
    const entries = Object.entries(project);
    if (!entries.length) return 'project 对象不能为空';
    for (const [key, path] of entries) {
      if (!key) return 'project 的字段名不能为空';
      const problem = pathProblem(path);
      if (problem) return `project 字段 "${key}" ${problem}`;
    }
    return null;
  }
  return 'project 必须是字符串、字符串数组或 {字段:路径}';
}

/** 有界整数读取：显式传错类型时报错，而不是静默回落到默认值 */
function readBoundedInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

export class BrowserPageHttpTool extends BaseBrowserTool {
  name = 'browser_page_http';

  metadata: ToolMetadata = {
    name: 'browser_page_http',
    description:
      '在目标页面上下文发起有界 GET 请求链（插件专用，继承页面 Cookie / Referer）',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'http', 'plugin', 'network'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_page_http',
      description:
        '插件专用：在目标页面上下文按顺序发起最多 4 个 GET 请求，支持从当前 URL 正则提取与 JSON 路径投影。' +
        '请求 origin 必须命中插件 manifest 的 network 声明；无插件上下文时拒绝执行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          location: {
            type: 'string',
            description: '对当前页 URL 的正则（支持命名分组，如 /video/(?<bvid>BV[0-9A-Za-z]+)）',
          },
          requests: {
            type: 'array',
            maxItems: MAX_REQUESTS,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', maxLength: 4096 },
                credentials: {
                  type: 'string',
                  enum: ['include', 'omit'],
                  default: 'omit',
                },
                response: {
                  type: 'string',
                  enum: ['json', 'text'],
                  default: 'json',
                },
                project: {
                  description: 'JSON 路径投影：字符串、字符串数组或 {字段:路径}',
                  anyOf: [
                    { type: 'string', maxLength: MAX_PROJECT_PATH },
                    {
                      type: 'array',
                      maxItems: 20,
                      items: { type: 'string', maxLength: MAX_PROJECT_PATH },
                    },
                    {
                      type: 'object',
                      additionalProperties: {
                        type: 'string',
                        maxLength: MAX_PROJECT_PATH,
                      },
                    },
                  ],
                },
                optional: { type: 'boolean', default: false },
                timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_REQUEST_TIMEOUT_MS },
                maxBytes: { type: 'integer', minimum: 1, maximum: MAX_RESPONSE_BYTES },
              },
              required: ['url'],
            },
          },
          totalTimeoutMs: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_TOTAL_TIMEOUT_MS,
          },
          tabId: { type: 'integer' },
        },
      },
    },
  };

  async execute(
    args: PageHttpArgs,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    this.ensureBackgroundContext();
    if (!context?.pluginKey || !context.pluginOrigins?.length) {
      return this.createErrorResponse(
        'PLUGIN_ORIGIN_REQUIRED：browser_page_http 只允许在已声明 network 的插件调用中使用',
      );
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return this.createErrorResponse('INVALID_ARGUMENT：参数必须是 JSON 对象');
    }
    const requests = args.requests ?? [];
    if (!Array.isArray(requests)) {
      return this.createErrorResponse('INVALID_ARGUMENT：requests 必须是数组');
    }
    if (requests.length > MAX_REQUESTS) {
      return this.createErrorResponse(
        `INVALID_ARGUMENT：requests 最多 ${MAX_REQUESTS} 个`,
      );
    }
    if (!requests.length && !args.location) {
      return this.createErrorResponse(
        'INVALID_ARGUMENT：requests 为空时必须提供 location 用于 URL 提取',
      );
    }
    if (
      args.tabId !== undefined &&
      (typeof args.tabId !== 'number' ||
        !Number.isSafeInteger(args.tabId) ||
        args.tabId < 0)
    ) {
      return this.createErrorResponse('INVALID_ARGUMENT：tabId 必须是非负整数');
    }
    if (
      args.location !== undefined &&
      (typeof args.location !== 'string' ||
        !args.location.trim() ||
        args.location.length > 200)
    ) {
      return this.createErrorResponse(
        'INVALID_ARGUMENT：location 必须是非空且长度不超过 200 的正则',
      );
    }
    const totalTimeoutMs = readBoundedInt(
      args.totalTimeoutMs,
      1,
      MAX_TOTAL_TIMEOUT_MS,
      MAX_TOTAL_TIMEOUT_MS,
    );
    if (totalTimeoutMs === null) {
      return this.createErrorResponse(
        `INVALID_ARGUMENT：totalTimeoutMs 必须是 1–${MAX_TOTAL_TIMEOUT_MS} 的整数`,
      );
    }

    let target: Awaited<ReturnType<typeof resolveTabOrigin>>;
    try {
      target = await resolveTabOrigin(args.tabId, context);
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : String(error),
      );
    }

    let location: Record<string, string> | undefined;
    if (typeof args.location === 'string') {
      const pattern = args.location.trim();
      let match: RegExpExecArray | null;
      try {
        match = new RegExp(pattern, 'i').exec(target.url);
      } catch {
        return this.createErrorResponse('INVALID_ARGUMENT：location 不是合法正则');
      }
      if (!match) {
        return this.createErrorResponse(
          `LOCATION_NOT_MATCHED：当前页 ${target.url} 不匹配 location`,
        );
      }
      location = match.groups ? { ...match.groups } : {};
    }

    const declared = new Set(context.pluginOrigins);
    const normalized: NormalizedRequest[] = [];
    let totalBytes = 0;
    for (const [index, item] of requests.entries()) {
      if (!isRecord(item) || typeof item.url !== 'string') {
        return this.createErrorResponse(
          `INVALID_ARGUMENT：requests[${index}] 必须包含字符串 url`,
        );
      }
      // B 站字幕地址常为 //i0.hdslb.com/...，补全协议后再做 origin 校验
      const rawUrl = item.url.trim();
      const requestUrl = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
      if (
        !requestUrl ||
        requestUrl.length > 4096 ||
        /[\s\u0000-\u001f]/.test(requestUrl)
      ) {
        return this.createErrorResponse(
          `INVALID_ARGUMENT：requests[${index}].url 为空、过长或含非法字符`,
        );
      }
      let parsed: URL;
      try {
        parsed = new URL(requestUrl);
      } catch {
        return this.createErrorResponse(
          `INVALID_ARGUMENT：requests[${index}].url 不是合法 URL`,
        );
      }
      if (parsed.protocol !== 'https:') {
        return this.createErrorResponse(
          `PLUGIN_ORIGIN_DENIED：${parsed.protocol} 不被允许，插件只能访问 https`,
        );
      }
      if (parsed.username || parsed.password) {
        return this.createErrorResponse(
          `INVALID_ARGUMENT：requests[${index}].url 不能包含账号或密码`,
        );
      }
      if (!declared.has(parsed.origin)) {
        return this.createErrorResponse(
          `PLUGIN_ORIGIN_DENIED：${parsed.origin} 不在插件 ${context.pluginKey} 的 network 声明中`,
        );
      }
      const credentials = item.credentials ?? 'omit';
      if (credentials !== 'include' && credentials !== 'omit') {
        return this.createErrorResponse(
          `INVALID_ARGUMENT：requests[${index}].credentials 只能是 include 或 omit`,
        );
      }
      const response = item.response ?? 'json';
      if (response !== 'json' && response !== 'text') {
        return this.createErrorResponse(
          `INVALID_ARGUMENT：requests[${index}].response 只能是 json 或 text`,
        );
      }
      const optional = item.optional ?? false;
      if (typeof optional !== 'boolean') {
        return this.createErrorResponse(
          `INVALID_ARGUMENT：requests[${index}].optional 必须是布尔值`,
        );
      }
      const projectError = projectProblem(item.project);
      if (projectError) {
        return this.createErrorResponse(
          `INVALID_ARGUMENT：requests[${index}].${projectError}`,
        );
      }
      const timeoutMs = readBoundedInt(
        item.timeoutMs,
        1,
        MAX_REQUEST_TIMEOUT_MS,
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
      if (timeoutMs === null) {
        return this.createErrorResponse(
          `INVALID_ARGUMENT：requests[${index}].timeoutMs 必须是 1–${MAX_REQUEST_TIMEOUT_MS} 的整数`,
        );
      }
      const maxBytes = readBoundedInt(
        item.maxBytes,
        1,
        MAX_RESPONSE_BYTES,
        DEFAULT_RESPONSE_BYTES,
      );
      if (maxBytes === null) {
        return this.createErrorResponse(
          `INVALID_ARGUMENT：requests[${index}].maxBytes 必须是 1–${MAX_RESPONSE_BYTES} 的整数`,
        );
      }
      totalBytes += maxBytes;
      if (totalBytes > MAX_TOTAL_BYTES) {
        return this.createErrorResponse(
          `INVALID_ARGUMENT：requests 的 maxBytes 总和超过 ${MAX_TOTAL_BYTES}`,
        );
      }
      normalized.push({
        url: requestUrl,
        credentials,
        response,
        project: item.project as NormalizedRequest['project'],
        optional,
        timeoutMs,
        maxBytes,
      });
    }

    try {
      const injected = await executeScriptBounded<Promise<PageHttpResponse[]>>(
        {
          target: { tabId: target.tabId },
          func: fetchChainInPage,
          args: [
            JSON.stringify({
              requests: normalized.map(({ project: _project, optional: _optional, ...rest }) => rest),
            }),
          ],
        },
        totalTimeoutMs,
        context.signal,
      );
      const raw = injected[0]?.result;
      if (!Array.isArray(raw)) {
        return this.createErrorResponse(
          'INVALID_RESULT：页面没有返回 HTTP 链结果，请确认当前标签页可注入',
        );
      }
      if (raw.length !== normalized.length) {
        return this.createErrorResponse(
          `INVALID_RESULT：期望 ${normalized.length} 个响应，实际 ${raw.length} 个`,
        );
      }
      const responses: PageHttpResponse[] = [];
      for (const [index, item] of raw.entries()) {
        if (!isRecord(item)) {
          return this.createErrorResponse(
            `INVALID_RESULT：第 ${index + 1} 个响应不是对象`,
          );
        }
        const response = item as unknown as PageHttpResponse;
        const config = normalized[index];
        // 页面返回值来自注入脚本，按不可信输入归一化，避免脏字段污染后续投影。
        const status =
          typeof response.status === 'number' && Number.isFinite(response.status)
            ? response.status
            : 0;
        const bytes =
          typeof response.bytes === 'number' && Number.isFinite(response.bytes)
            ? response.bytes
            : 0;
        if ((response.ok !== true || response.error) && !config.optional) {
          return this.createErrorResponse(
            `HTTP_REQUEST_FAILED：${typeof response.url === 'string' ? response.url : config.url} — ${response.error ?? `status ${status}`}`,
          );
        }
        if (!config.optional) {
          if (response.data === undefined) {
            return this.createErrorResponse(
              `HTTP_PROJECTION_MISSING：${config.url} 没有可投影的响应数据`,
            );
          }
          const missing = projectPaths(config.project).filter(
            (path) => resolveWorkflowPath(response.data, path) === undefined,
          );
          if (missing.length) {
            return this.createErrorResponse(
              `HTTP_PROJECTION_MISSING：${config.url} 缺少 ${missing.slice(0, 5).join(', ')}` +
                (missing.length > 5 ? ` 等 ${missing.length} 条路径` : ''),
            );
          }
        }
        responses.push({
          ...response,
          url: typeof response.url === 'string' ? response.url : config.url,
          ok: response.ok === true,
          status,
          bytes,
          truncated: response.truncated === true || undefined,
          data: projectValue(response.data, config.project),
        });
      }
      return this.createSuccessResponse({
        tabId: target.tabId,
        url: target.url,
        location,
        responses,
      });
    } catch (error) {
      return this.createErrorResponse(
        'HTTP_REQUEST_FAILED',
        error instanceof Error ? error : String(error),
      );
    }
  }
}

export const browserPageHttpTool = new BrowserPageHttpTool();

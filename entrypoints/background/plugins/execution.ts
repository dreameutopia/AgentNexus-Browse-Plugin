import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { canonicalize } from 'json-canonicalize';
import { toolRegistry, type ToolExecutionContext } from '@/tools/registry';
import { executeWithBrowserScope } from '@/tools/browser/browser-scope';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import {
  invariant,
  LIMITS,
  ownerOf,
  PluginError,
  type PluginSnapshot,
  type PluginTool,
} from '@/utils/plugins/contracts';
import { checkSchema, validateArguments } from '@/utils/plugins/schema';
import { PUBLIC_HOST_TOOLS } from '@/utils/plugins/host-tools';
import { describeOperationError } from '@/utils/plugins/operations';
import { publicHttps } from '@/utils/plugins/network';
import { strictJson } from '@/utils/plugins/json';
import { runWorkflow, validateWorkflow } from '@/utils/plugins/workflow';
import type { PluginService } from '@/utils/plugins/service';

/** 单个插件同时执行的工具数上限，防止一个插件占满后台消息通道 */
const MAX_CONCURRENT_PER_PLUGIN = 4;

export class PluginExecutionGateway {
  private running = new Map<string, Set<AbortController>>();
  constructor(
    private service: PluginService,
    private secret: (key: string, slot: string) => Promise<string | undefined>,
  ) {}
  reconcile(snapshot: PluginSnapshot): void {
    for (const [key, running] of this.running) {
      const current = snapshot.packages.find((p) => p.key === key);
      if (!current?.enabled || current.blocked)
        for (const controller of running) controller.abort();
    }
  }
  async execute(
    ref: string,
    args: unknown,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const key = ownerOf(ref),
      controller = new AbortController(),
      running = this.running.get(key) ?? new Set<AbortController>();
    const abort = (reason: 'timeout' | 'revoked') => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const onContextAbort = () => abort('revoked');
    context?.signal?.addEventListener('abort', onContextAbort, { once: true });
    const timer = setTimeout(() => abort('timeout'), 60_000);
    try {
      invariant(
        context?.pluginApproved && context.pluginBindings?.[key],
        'PLUGIN_APPROVAL_REQUIRED',
      );
      invariant(!context.signal?.aborted, 'CAPABILITY_REVOKED');
      invariant(
        running.size < MAX_CONCURRENT_PER_PLUGIN,
        'PLUGIN_BUSY',
        `${running.size} tools already running for ${key}`,
      );
      const snapshot = await this.service.snapshot(),
        installed = snapshot.packages.find((p) => p.key === key),
        binding = context.pluginBindings[key];
      invariant(
        installed?.enabled &&
          !installed.blocked &&
          installed.epoch === binding.epoch,
        'CAPABILITY_REVOKED',
      );
      // Conservatively reject stale contracts. Existing runs stop rather than silently changing executor.
      invariant(
        installed.digest === binding.digest,
        'PLUGIN_VERSION_CHANGED',
        'Start a new run to use the updated plugin',
      );
      const tool = installed.tools.find((t) => t.ref === ref);
      invariant(tool, 'TOOL_NOT_FOUND');
      let argumentText: string;
      try {
        argumentText = JSON.stringify(args ?? {});
      } catch {
        invariant(false, 'INVALID_ARGUMENT', 'arguments are not JSON-serializable');
      }
      const argumentBytes = new TextEncoder().encode(argumentText).length;
      invariant(
        argumentBytes <= LIMITS.args,
        'ARGUMENT_LIMIT',
        `${argumentBytes} > ${LIMITS.args}`,
      );
      const cleanArgs = strictJson(argumentText);
      validateArguments(tool.inputSchema, cleanArgs);
      running.add(controller);
      this.running.set(key, running);
      // 准入检查与 add 之间隔着 await，必须在 add 后复检才能真正约束并发
      invariant(
        running.size <= MAX_CONCURRENT_PER_PLUGIN,
        'PLUGIN_BUSY',
        `${running.size} tools already running for ${key}`,
      );
      const pluginContext: ToolExecutionContext = {
        ...(context ?? {}),
        pluginKey: key,
        pluginOrigins: installed.manifest.capabilities.network,
        signal: controller.signal,
      };
      const operation = async () => {
        if (tool.executor.type === 'host-alias') {
          const target = tool.executor.target.slice('builtin/'.length);
          invariant(PUBLIC_HOST_TOOLS.has(target), 'HOST_TOOL_NOT_PUBLIC', target);
          // 防御性复检：篡改过的快照不能绕过 manifest 的能力声明
          invariant(
            installed.manifest.capabilities.hostTools.includes(
              tool.executor.target,
            ),
            'UNDECLARED_HOST_TOOL',
            tool.executor.target,
          );
          const host = toolRegistry.get(target);
          invariant(host && !host.metadata.plugin, 'HOST_TOOL_NOT_FOUND');
          return executeWithBrowserScope(pluginContext, scopedContext => host.execute(cleanArgs, scopedContext));
        }
        if (tool.executor.type === 'host-workflow') {
          validateWorkflow(installed.manifest, tool);
          if (!cleanArgs || typeof cleanArgs !== 'object' || Array.isArray(cleanArgs))
            invariant(false, 'INVALID_ARGUMENT', 'workflow input must be an object');
          return runWorkflow(
            tool,
            cleanArgs as Record<string, unknown>,
            pluginContext,
            async (stepTool, stepArgs, stepSignal) => {
              const target = stepTool.slice('builtin/'.length);
              invariant(
                PUBLIC_HOST_TOOLS.has(target),
                'HOST_TOOL_NOT_PUBLIC',
                stepTool,
              );
              const host = toolRegistry.get(target);
              invariant(host && !host.metadata.plugin, 'HOST_TOOL_NOT_FOUND');
              return executeWithBrowserScope({
                ...pluginContext,
                signal: stepSignal,
              }, scopedContext => host.execute(stepArgs, scopedContext));
            },
          );
        }
        return this.mcp(key, tool, cleanArgs, controller.signal);
      };
      let cancelListener: (() => void) | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        const rejectAborted = () => {
          const timedOut = controller.signal.reason === 'timeout';
          reject(
            new PluginError(
              timedOut ? 'PLUGIN_HOST_TIMEOUT' : 'CAPABILITY_REVOKED',
              timedOut
                ? 'Plugin tool execution exceeded 60s'
                : 'Plugin capability was revoked or the run was cancelled',
            ),
          );
        };
        cancelListener = rejectAborted;
        if (controller.signal.aborted) rejectAborted();
        else
          controller.signal.addEventListener('abort', rejectAborted, {
            once: true,
          });
      });
      let result: ToolResult;
      try {
        result = await Promise.race([operation(), cancelled]);
      } finally {
        // 正常完成时 abort 监听器不会触发，必须显式摘除，避免长生命周期
        // signal 上残留闭包（60s 定时器与大量调用叠加会造成可观泄漏）。
        if (cancelListener)
          controller.signal.removeEventListener('abort', cancelListener);
      }
      const latest = (await this.service.snapshot()).packages.find(
        (p) => p.key === key,
      );
      // 超时与撤销都会 abort，但两者的运营诊断与模型自纠路径完全不同：
      // 不能把超时误报成“能力被撤销”。
      invariant(
        !controller.signal.aborted,
        controller.signal.reason === 'timeout'
          ? 'PLUGIN_HOST_TIMEOUT'
          : 'CAPABILITY_REVOKED',
      );
      invariant(
        latest?.enabled && !latest.blocked && latest.epoch === binding.epoch,
        'CAPABILITY_REVOKED',
        latest
          ? `plugin ${key} was disabled or replaced`
          : `plugin ${key} was removed`,
      );
      invariant(
        result && typeof result === 'object' && !Array.isArray(result),
        'INVALID_TOOL_RESULT',
        'tool result must be an object',
      );
      let resultText = '';
      try {
        resultText = JSON.stringify(result);
      } catch {
        invariant(false, 'INVALID_TOOL_RESULT', 'tool result is not JSON-serializable');
      }
      const resultBytes = new TextEncoder().encode(resultText).length;
      invariant(
        resultBytes <= LIMITS.result,
        'RESULT_LIMIT',
        `${resultBytes} > ${LIMITS.result}`,
      );
      return {
        ...result,
        plugin: {
          key: installed.key,
          version: installed.manifest.version,
          digest: installed.digest,
          displayName: installed.manifest.displayName,
          publisher: installed.manifest.publisher.displayName,
        },
      };
    } catch (error) {
      const described = describeOperationError(error);
      return createErrorResponse(`${described.code}: ${described.detail}`);
    } finally {
      clearTimeout(timer);
      context?.signal?.removeEventListener('abort', onContextAbort);
      running.delete(controller);
      // 仅删除自己的条目：并发执行可能已把同一个 Set 重新登记回 map
      if (this.running.get(key) === running && !running.size)
        this.running.delete(key);
    }
  }
  private async mcp(
    key: string,
    tool: PluginTool,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    invariant(tool.executor.type === 'mcp', 'INVALID_EXECUTOR');
    const executor = tool.executor,
      origin = publicHttps(executor.url).origin;
    const raw = executor.secretSlot
      ? await this.secret(key, executor.secretSlot)
      : undefined;
    const token = typeof raw === 'string' && raw.length ? raw : undefined;
    if (executor.secretSlot)
      invariant(token, 'SECRET_REQUIRED', executor.secretSlot);
    const client = new Client(
      { name: 'AgentNexus', version: '1.0.0' },
      {
        jsonSchemaValidator: {
          getValidator<T>(schema: any) {
            checkSchema(schema);
            return (input) => {
              try {
                validateArguments(schema, input);
                return {
                  valid: true as const,
                  data: input as T,
                  errorMessage: undefined,
                };
              } catch {
                return {
                  valid: false as const,
                  data: undefined,
                  errorMessage: 'Invalid structured result',
                };
              }
            };
          },
        },
      },
    );
    // 流式读取超限的错误经 SDK 后未必保留原始类型，用本地标记兜底，
    // 避免被统一收敛成 MCP_FAILED（错误码是运营诊断的唯一稳定入口）。
    let responseLimitHit = false;
    const transport = new StreamableHTTPClientTransport(new URL(executor.url), {
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (input, init) => {
        // SDK 可能传 Request / URL / string：必须取真实 URL，不能 String(Request)
        const rawUrl =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : typeof (input as { url?: unknown }).url === 'string'
                ? (input as { url: string }).url
                : String(input);
        const url = publicHttps(rawUrl);
        invariant(url.origin === origin, 'MCP_ORIGIN_MISMATCH');
        // 若 SDK 把请求头放在 Request 上，init.headers 为空不能把它们覆盖掉
        const headers = new Headers(
          (input as { headers?: HeadersInit }).headers,
        );
        new Headers(init?.headers).forEach((value, key) =>
          headers.set(key, value),
        );
        if (token) headers.set('Authorization', `Bearer ${token}`);
        const response = await fetch(input, {
          ...init,
          headers,
          credentials: 'omit',
          redirect: 'error',
          signal: init?.signal
            ? AbortSignal.any([signal, init.signal])
            : signal,
        });
        if (!response.body) return response;
        const reader = response.body.getReader();
        let count = 0;
        const stream = new ReadableStream({
          async pull(c) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                c.close();
                return;
              }
              count += chunk.value.length;
              if (count > LIMITS.result) {
                responseLimitHit = true;
                await reader.cancel();
                c.error(
                  new PluginError(
                    'MCP_RESPONSE_LIMIT',
                    `MCP response exceeds ${LIMITS.result} bytes`,
                  ),
                );
                return;
              }
              c.enqueue(chunk.value);
            } catch (error) {
              await reader.cancel();
              c.error(error);
            }
          },
          cancel: (reason) => reader.cancel(reason),
        });
        return new Response(stream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    });
    const abort = () => {
      void client.close().catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await client.connect(transport, { signal, timeout: 20_000 });
      let cursor: string | undefined, remote: any;
      const seen = new Set<string>();
      for (let page = 0; page < 10; page++) {
        const list = await client.listTools(cursor ? { cursor } : undefined, {
          signal,
          timeout: 20_000,
        });
        remote = list.tools.find((t) => t.name === executor.remoteName);
        if (remote || !list.nextCursor) break;
        invariant(!seen.has(list.nextCursor), 'MCP_PAGINATION_LOOP');
        seen.add(list.nextCursor);
        cursor = list.nextCursor;
      }
      invariant(
        remote &&
          canonicalize(remote.inputSchema) === canonicalize(tool.inputSchema) &&
          canonicalize(remote.outputSchema ?? null) ===
            canonicalize(tool.outputSchema ?? null),
        'MCP_SCHEMA_CHANGED',
      );
      const result = await client.callTool(
        {
          name: executor.remoteName,
          arguments: args as Record<string, unknown>,
        },
        undefined,
        { signal, timeout: 30_000 },
      );
      return { ...result, success: !result.isError } as ToolResult;
    } catch (error) {
      // MCP SDK 的异常类型不稳定：统一收敛为稳定错误码，同时保留原始 message。
      if (error instanceof PluginError) throw error;
      if (responseLimitHit)
        throw new PluginError(
          'MCP_RESPONSE_LIMIT',
          `MCP response exceeds ${LIMITS.result} bytes`,
        );
      throw new PluginError(
        'MCP_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      signal.removeEventListener('abort', abort);
      await client.close().catch(() => undefined);
    }
  }
}

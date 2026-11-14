import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { canonicalize } from 'json-canonicalize';
import { toolRegistry, type ToolExecutionContext } from '@/tools/registry';
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
import type { PluginService } from '@/utils/plugins/service';

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
      invariant(
        !context.signal?.aborted && running.size < 4,
        'PLUGIN_BUSY_OR_CANCELLED',
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
      const argumentText = JSON.stringify(args ?? {});
      invariant(argumentText.length <= LIMITS.args, 'ARGUMENT_LIMIT');
      const cleanArgs = strictJson(argumentText);
      validateArguments(tool.inputSchema, cleanArgs);
      running.add(controller);
      this.running.set(key, running);
      const operation = async () => {
        if (tool.executor.type === 'host-alias') {
          const target = tool.executor.target.slice('builtin/'.length);
          invariant(PUBLIC_HOST_TOOLS.has(target), 'HOST_TOOL_NOT_PUBLIC', target);
          const host = toolRegistry.get(target);
          invariant(host && !host.metadata.plugin, 'HOST_TOOL_NOT_FOUND');
          return host.execute(cleanArgs, {
            ...context,
            signal: controller.signal,
          });
        }
        return this.mcp(key, tool, cleanArgs, controller.signal);
      };
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
        if (controller.signal.aborted) rejectAborted();
        else
          controller.signal.addEventListener('abort', rejectAborted, {
            once: true,
          });
      });
      const result = await Promise.race([operation(), cancelled]);
      const latest = (await this.service.snapshot()).packages.find(
        (p) => p.key === key,
      );
      invariant(
        !controller.signal.aborted &&
          latest?.enabled &&
          !latest.blocked &&
          latest.epoch === binding.epoch,
        'CAPABILITY_REVOKED',
      );
      invariant(
        result &&
          typeof result === 'object' &&
          !Array.isArray(result) &&
          JSON.stringify(result).length <= LIMITS.result,
        'INVALID_TOOL_RESULT',
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
      if (!running.size) this.running.delete(key);
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
    const transport = new StreamableHTTPClientTransport(new URL(executor.url), {
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (input, init) => {
        const url = publicHttps(String(input));
        invariant(url.origin === origin, 'MCP_ORIGIN_MISMATCH');
        const headers = new Headers(init?.headers);
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
              invariant(count <= LIMITS.result, 'MCP_RESPONSE_LIMIT');
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

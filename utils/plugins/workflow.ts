/**
 * 声明式插件工作流。
 *
 * 工作流只做“按顺序调用公开宿主工具 + 受限占位符取值”，不支持分支、循环、
 * 递归、跨插件调用，也不执行任何插件提供的脚本。B 站搜索、字幕链等需要多步
 * 协作的能力都通过这里编排，插件作者只能修改签名后的工具 JSON，模型只能填充
 * 工具 inputSchema 声明的输入。
 */
import type { ToolResult } from '@/common/tool-handler';
import type { ToolExecutionContext } from '@/tools/registry';
import {
  invariant,
  LIMITS,
  PluginError,
  type PluginManifest,
  type PluginTool,
} from './contracts';
import { PUBLIC_HOST_TOOLS } from './host-tools';

export const WORKFLOW_LIMITS = Object.freeze({
  steps: 8,
  args: 64 * 1024,
  stepResult: 64 * 1024,
  result: 1024 * 1024,
  stepMs: 15_000,
  totalMs: 45_000,
});

/** 工作流执行时，后续步骤可自动继承的标签页工具 */
const TAB_AWARE_TOOLS = new Set([
  'browser_navigation',
  'browser_extract_data',
  'browser_page_ops',
  'browser_page_http',
  'browser_media_control',
  'read_website',
]);

/** 单步结果摘要；只保留模型与后续占位符真正需要的字段 */
export interface WorkflowStepResult {
  id: string;
  tool: string;
  ok: boolean;
  optional?: boolean;
  data?: unknown;
  tabId?: number;
  durationMs: number;
  error?: string;
}

interface WorkflowScope {
  args: Record<string, unknown>;
  steps: Record<string, WorkflowStepResult>;
}

export type WorkflowInvoke = (
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<ToolResult>;

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** 模板/路径解析的最大嵌套深度：与 args 体积上限一起构成本地拒绝服务边界 */
const MAX_TEMPLATE_DEPTH = 32;
/** 数组下标只接受规范十进制（拒绝 1e2、0x1、+1、空格等 Number() 宽松形态） */
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

function fail(code: string, detail: string): never {
  throw new PluginError(code, detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeKeys(value: unknown, depth = 0): void {
  if (depth > 16) fail('WORKFLOW_ARGS_LIMIT', 'template nesting exceeds 16 levels');
  if (Array.isArray(value)) {
    for (const item of value) assertSafeKeys(item, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key))
      fail('WORKFLOW_ARGS_INVALID', `unsafe key "${key}"`);
    assertSafeKeys(item, depth + 1);
  }
}

function byteLength(value: unknown): number {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    fail('WORKFLOW_ARGS_INVALID', 'value is not JSON-serializable');
  }
  return new TextEncoder().encode(text).length;
}

function assertBounded(
  value: unknown,
  code: string,
  maxBytes: number,
  label: string,
): void {
  assertSafeKeys(value);
  const size = byteLength(value);
  if (size > maxBytes)
    fail(code, `${label} is ${size} bytes, limit ${maxBytes}`);
}

function splitPath(path: string): string[] {
  // 空段（a..b / .a / a.）是模板拼写错误，不能静默归一成 a.b
  const parts = path.split('.');
  if (!parts.length || parts.some((part) => !part))
    fail('WORKFLOW_PATH_INVALID', path);
  return parts;
}

export function resolveWorkflowPath(root: unknown, path: string): unknown {
  try {
    return resolvePath(root, path);
  } catch {
    return undefined;
  }
}

function resolvePath(root: unknown, path: string): unknown {
  return resolvePathParts(root, splitPath(path));
}

function resolvePathParts(root: unknown, parts: readonly string[]): unknown {
  let current: unknown = root;
  for (const part of parts) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(part)) return undefined;
      current = current[Number(part)];
      continue;
    }
    if (!isPlainObject(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

interface ParsedPlaceholder {
  source: 'args' | 'steps';
  path: string[];
  filter?: 'urlencode';
}

function parsePlaceholder(raw: string): ParsedPlaceholder {
  const chunks = raw.split('|').map((part) => part.trim());
  if (chunks.length > 2 || !chunks[0])
    fail('WORKFLOW_TEMPLATE_INVALID', raw);
  const filter = chunks[1];
  if (filter !== undefined && filter !== 'urlencode')
    fail('WORKFLOW_TEMPLATE_INVALID', `unsupported filter "${filter}"`);
  const [source, ...path] = splitPath(chunks[0]);
  if (source !== 'args' && source !== 'steps')
    fail(
      'WORKFLOW_TEMPLATE_INVALID',
      `${raw} — only args.* and steps.* are allowed`,
    );
  if (!path.length) fail('WORKFLOW_TEMPLATE_INVALID', raw);
  return { source, path, filter: filter as 'urlencode' | undefined };
}

function placeholderLabel(placeholder: ParsedPlaceholder): string {
  return `{{${placeholder.source}.${placeholder.path.join('.')}}}`;
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function placeholderText(value: unknown, placeholder: ParsedPlaceholder): string {
  if (value === undefined)
    fail('WORKFLOW_TEMPLATE_UNRESOLVED', placeholderLabel(placeholder));
  if (isScalar(value)) return String(value);
  fail(
    'WORKFLOW_TEMPLATE_INVALID',
    `${placeholderLabel(placeholder)} must be a scalar in a mixed string`,
  );
}

/** urlencode 只接受标量：对象/数组的 String() 会静默变成 "[object Object]" */
function encodePlaceholder(value: unknown, placeholder: ParsedPlaceholder): string {
  if (value === undefined)
    fail('WORKFLOW_TEMPLATE_UNRESOLVED', placeholderLabel(placeholder));
  if (isScalar(value)) return encodeURIComponent(String(value));
  fail(
    'WORKFLOW_TEMPLATE_INVALID',
    `${placeholderLabel(placeholder)} must be a scalar for |urlencode`,
  );
}

function readPlaceholder(scope: WorkflowScope, placeholder: ParsedPlaceholder): unknown {
  const root = placeholder.source === 'args' ? scope.args : scope.steps;
  // 已解析过的路径段直接复用，避免 join 后再 split 的往返
  return resolvePathParts(root, placeholder.path);
}

/** 解析单个模板值；整串占位可注入对象/数组，混排只允许标量 */
export function resolveTemplate(
  value: unknown,
  scope: WorkflowScope,
  depth = 0,
): unknown {
  if (depth > MAX_TEMPLATE_DEPTH)
    fail('WORKFLOW_ARGS_LIMIT', `template nesting exceeds ${MAX_TEMPLATE_DEPTH} levels`);
  if (typeof value === 'string') {
    const matches = [...value.matchAll(PLACEHOLDER)];
    if (!matches.length) return value;
    if (matches.length === 1 && matches[0][0] === value) {
      const parsed = parsePlaceholder(matches[0][1]);
      const resolved = readPlaceholder(scope, parsed);
      return parsed.filter === 'urlencode'
        ? encodePlaceholder(resolved, parsed)
        : resolved === undefined
          ? fail('WORKFLOW_TEMPLATE_UNRESOLVED', placeholderLabel(parsed))
          : resolved;
    }
    return value.replace(PLACEHOLDER, (_, raw: string) => {
      // 每个占位只解析一次：解析结果同时用于取值与错误标签，避免重复解析
      const parsed = parsePlaceholder(raw);
      const resolved = readPlaceholder(scope, parsed);
      return parsed.filter === 'urlencode'
        ? encodePlaceholder(resolved, parsed)
        : placeholderText(resolved, parsed);
    });
  }
  if (Array.isArray(value))
    return value.map((item) => resolveTemplate(item, scope, depth + 1));
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) fail('WORKFLOW_ARGS_INVALID', `unsafe key "${key}"`);
      result[key] = resolveTemplate(item, scope, depth + 1);
    }
    return result;
  }
  return value;
}

interface TemplateContext {
  allowedSteps: ReadonlySet<string>;
  inputProperties?: ReadonlySet<string>;
}

function validateTemplateString(value: string, context: TemplateContext): void {
  for (const match of value.matchAll(PLACEHOLDER)) {
    const parsed = parsePlaceholder(match[1]);
    if (parsed.source === 'args') {
      if (context.inputProperties && !context.inputProperties.has(parsed.path[0]))
        fail(
          'WORKFLOW_INPUT_UNKNOWN',
          `{{args.${parsed.path.join('.')}}} is not declared in inputSchema`,
        );
      continue;
    }
    const stepId = parsed.path[0];
    if (!context.allowedSteps.has(stepId))
      fail(
        'WORKFLOW_STEP_ORDER',
        `{{steps.${parsed.path.join('.')}}} can only reference a previous step`,
      );
    const field = parsed.path[1];
    if (!field || !['data', 'tabId', 'ok', 'error'].includes(field))
      fail(
        'WORKFLOW_TEMPLATE_INVALID',
        `{{steps.${parsed.path.join('.')}}} — use steps.<id>.data / tabId / ok / error`,
      );
  }
}

function validateTemplates(
  value: unknown,
  context: TemplateContext,
  depth = 0,
): void {
  if (depth > MAX_TEMPLATE_DEPTH)
    fail('WORKFLOW_ARGS_LIMIT', `template nesting exceeds ${MAX_TEMPLATE_DEPTH} levels`);
  if (typeof value === 'string') return validateTemplateString(value, context);
  if (Array.isArray(value)) {
    for (const item of value) validateTemplates(item, context, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const item of Object.values(value)) validateTemplates(item, context, depth + 1);
}

function inputPropertiesOf(
  inputSchema: Record<string, unknown>,
): ReadonlySet<string> | undefined {
  const properties = inputSchema.properties;
  if (!isPlainObject(properties)) return undefined;
  return new Set(Object.keys(properties));
}

/** 验包 / 启动对账共用的工作流静态校验 */
export function validateWorkflow(
  manifest: PluginManifest,
  tool: Pick<PluginTool, 'inputSchema' | 'executor'>,
): void {
  const executor = tool.executor;
  invariant(executor.type === 'host-workflow', 'INVALID_EXECUTOR');
  if (executor.steps.length > WORKFLOW_LIMITS.steps)
    fail(
      'WORKFLOW_STEP_LIMIT',
      `${executor.steps.length} steps, limit ${WORKFLOW_LIMITS.steps}`,
    );
  const declared = new Set(manifest.capabilities.hostTools);
  const allowedSteps = new Set<string>();
  const inputProperties = inputPropertiesOf(tool.inputSchema);
  for (const step of executor.steps) {
    if (allowedSteps.has(step.id))
      fail('WORKFLOW_DUPLICATE_STEP', step.id);
    if (!PUBLIC_HOST_TOOLS.has(step.tool.slice('builtin/'.length)))
      fail('HOST_TOOL_NOT_PUBLIC', step.tool);
    if (!declared.has(step.tool))
      fail('UNDECLARED_HOST_TOOL', step.tool);
    assertBounded(
      step.args,
      'WORKFLOW_ARGS_LIMIT',
      WORKFLOW_LIMITS.args,
      `step "${step.id}" args`,
    );
    validateTemplates(step.args, { allowedSteps, inputProperties });
    allowedSteps.add(step.id);
  }
  if (executor.output) {
    if (!allowedSteps.has(executor.output.from))
      fail('WORKFLOW_OUTPUT_STEP', executor.output.from);
    const outputStep = executor.steps.find((step) => step.id === executor.output!.from);
    if (outputStep?.optional)
      fail('WORKFLOW_OUTPUT_OPTIONAL', executor.output.from);
    // 路径语法在验包期就拒绝，避免运行到最后一个步骤才发现拼写错误
    if (executor.output.path) splitPath(executor.output.path);
  }
}

function tabIdOf(result: ToolResult): number | undefined {
  const data = isPlainObject(result.data) ? result.data : undefined;
  const candidate =
    data?.tabId ?? (result as unknown as { tabId?: unknown }).tabId;
  return Number.isInteger(candidate) ? (candidate as number) : undefined;
}

function isTabAware(tool: string): boolean {
  return TAB_AWARE_TOOLS.has(tool.slice('builtin/'.length));
}

function outputOf(
  tool: PluginTool,
  scope: WorkflowScope,
  steps: WorkflowStepResult[],
): unknown {
  const executor = tool.executor;
  invariant(executor.type === 'host-workflow', 'INVALID_EXECUTOR');
  const from = executor.output?.from ?? steps[steps.length - 1]?.id;
  const step = from ? scope.steps[from] : undefined;
  if (!step)
    fail(
      'WORKFLOW_OUTPUT_STEP',
      from ? String(from) : 'workflow has no steps to read output from',
    );
  // 可选步骤可能 ok=false：没有产物时必须明确失败，而不是返回“成功但 output 为空”
  if (!step.ok)
    fail(
      'WORKFLOW_OUTPUT_MISSING',
      `steps.${step.id} failed; point output.from at a successful step`,
    );
  if (!executor.output?.path) return step.data;
  // output.path 相对该步骤的 data，而不是整个步骤摘要；插件作者不必写 data. 前缀
  const value = resolvePath(step.data, executor.output.path);
  if (value === undefined)
    fail(
      'WORKFLOW_OUTPUT_MISSING',
      `steps.${step.id}.data.${executor.output.path}`,
    );
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 可选步骤只容忍“业务性失败”（元素没等到、接口没数据等）；
 * 安全拒绝、能力撤销与超时属于硬失败，必须中断整条工作流。
 */
const HARD_FAILURE_PREFIXES = [
  'PLUGIN_ORIGIN_DENIED',
  'PLUGIN_ACTION_DENIED',
  'PLUGIN_NAVIGATION_DENIED',
  'CAPABILITY_REVOKED',
  'NETWORK_TARGET_REJECTED',
  'MCP_ORIGIN_MISMATCH',
  'WORKFLOW_TIMEOUT',
  'WORKFLOW_STEP_RESULT_LIMIT',
  'WORKFLOW_ARGS_INVALID',
  'WORKFLOW_ARGS_LIMIT',
  'HOST_TOOL_NOT_PUBLIC',
  'HOST_TOOL_NOT_FOUND',
  'INVALID_EXECUTOR',
  'INVALID_ARGUMENT',
  'INVALID_REF',
];

function isHardFailure(message: string | undefined): boolean {
  if (!message) return false;
  const head = message.trimStart();
  return HARD_FAILURE_PREFIXES.some((code) => head.startsWith(code));
}

function abortCode(signal: AbortSignal): 'WORKFLOW_TIMEOUT' | 'CAPABILITY_REVOKED' {
  return signal.reason === 'timeout' ? 'WORKFLOW_TIMEOUT' : 'CAPABILITY_REVOKED';
}

function failure(
  code: string,
  detail: string,
  summaries: WorkflowStepResult[],
  step?: { id: string; tool: string },
): ToolResult {
  return {
    success: false,
    error: `${code}: ${step ? `step "${step.id}" (${step.tool}) — ` : ''}${detail}`,
    data: { steps: summaries },
  };
}

/**
 * 让单步调用具备硬性时限。
 *
 * 宿主工具即便不监听 signal，调用方仍然按时收敛；底层工作可能继续，但工作流
 * 不会因此挂住整个会话（网关侧另有 60s 总超时兜底）。
 */
function awaitStep<T>(
  work: Promise<T>,
  signal: AbortSignal,
  step: { id: string; tool: string },
): Promise<T> {
  if (signal.aborted)
    return Promise.reject(
      new PluginError(abortCode(signal), `workflow stopped before step "${step.id}"`),
    );
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(
        new PluginError(
          abortCode(signal),
          `workflow stopped during step "${step.id}" (${step.tool})`,
        ),
      );
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * 顺序执行工作流。
 *
 * 宿主工具调用由调用方注入（网关负责校验插件快照并把 pluginKey / network
 * 传入上下文），本模块只负责占位符、tabId 继承、预算与结果归一。
 *
 * 运行期错误一律收敛为带步骤摘要的 ToolResult（而不是抛异常），让模型与
 * 操作日志都能看到“哪一步、用了什么参数、失败原因是什么”。
 */
export async function runWorkflow(
  tool: PluginTool,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  invoke: WorkflowInvoke,
): Promise<ToolResult> {
  const executor = tool.executor;
  invariant(executor.type === 'host-workflow', 'INVALID_EXECUTOR');
  // 能力在工作流启动前已撤销：一步都不执行（addEventListener 不会补发已发生的事件）
  if (context.signal?.aborted)
    fail('CAPABILITY_REVOKED', 'plugin capability was revoked before the workflow started');
  const scope: WorkflowScope = { args, steps: {} };
  const summaries: WorkflowStepResult[] = [];
  const total = new AbortController();
  const onAbort = () => total.abort('revoked');
  context.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => total.abort('timeout'), WORKFLOW_LIMITS.totalMs);
  let inheritedTabId: number | undefined;
  try {
    for (const step of executor.steps) {
      if (total.signal.aborted)
        return failure(
          abortCode(total.signal),
          `workflow stopped before step "${step.id}"`,
          summaries,
          step,
        );
      const started = Date.now();
      let resolved: unknown;
      try {
        resolved = resolveTemplate(step.args, scope);
      } catch (error) {
        const code = error instanceof PluginError ? error.code : 'WORKFLOW_ARGS_INVALID';
        const detail = error instanceof PluginError ? error.detail : errorText(error);
        return failure(code, detail, summaries, step);
      }
      if (!isPlainObject(resolved))
        return failure(
          'WORKFLOW_ARGS_INVALID',
          'resolved arguments are not an object',
          summaries,
          step,
        );
      const stepArgs: Record<string, unknown> = { ...resolved };
      if (
        inheritedTabId !== undefined &&
        isTabAware(step.tool) &&
        stepArgs.tabId === undefined
      )
        stepArgs.tabId = inheritedTabId;
      // 静态模板在验包期已限长，但占位符会把模型输入放大进步骤参数；
      // 执行前按同一预算复检，避免单步请求体突破网关的假设。
      try {
        assertBounded(
          stepArgs,
          'WORKFLOW_ARGS_LIMIT',
          WORKFLOW_LIMITS.args,
          `step "${step.id}" resolved args`,
        );
      } catch (error) {
        const code =
          error instanceof PluginError ? error.code : 'WORKFLOW_ARGS_LIMIT';
        const detail =
          error instanceof PluginError ? error.detail : errorText(error);
        return failure(code, detail, summaries, step);
      }
      const controller = new AbortController();
      const stepTimer = setTimeout(
        () => controller.abort('timeout'),
        WORKFLOW_LIMITS.stepMs,
      );
      const signal = AbortSignal.any([total.signal, controller.signal]);
      let result: ToolResult;
      try {
        result = await awaitStep(invoke(step.tool, stepArgs, signal), signal, step);
      } catch (error) {
        const code =
          error instanceof PluginError
            ? error.code
            : signal.aborted
              ? abortCode(signal)
              : 'WORKFLOW_STEP_FAILED';
        const detail =
          error instanceof PluginError ? error.detail : errorText(error);
        const stepError = `${code}: ${detail}`;
        const failed: WorkflowStepResult = {
          id: step.id,
          tool: step.tool,
          ok: false,
          optional: step.optional || undefined,
          durationMs: Date.now() - started,
          error: stepError,
        };
        scope.steps[step.id] = failed;
        summaries.push(failed);
        if (step.optional && !signal.aborted && !isHardFailure(stepError))
          continue;
        return failure(code, detail, summaries, step);
      } finally {
        clearTimeout(stepTimer);
      }
      if (!result || typeof result !== 'object')
        return failure(
          'INVALID_TOOL_RESULT',
          'host tool returned no result',
          summaries,
          step,
        );
      const ok = result.success !== false;
      const tabId = tabIdOf(result);
      if (tabId !== undefined) inheritedTabId = tabId;
      const summary: WorkflowStepResult = {
        id: step.id,
        tool: step.tool,
        ok,
        optional: step.optional || undefined,
        data: result.data ?? (ok ? result : undefined),
        tabId,
        durationMs: Date.now() - started,
        error: ok ? undefined : result.error ?? 'step failed',
      };
      try {
        assertBounded(
          summary,
          'WORKFLOW_STEP_RESULT_LIMIT',
          WORKFLOW_LIMITS.stepResult,
          `step "${step.id}" result`,
        );
      } catch (error) {
        const code =
          error instanceof PluginError ? error.code : 'WORKFLOW_STEP_RESULT_LIMIT';
        const detail =
          error instanceof PluginError ? error.detail : errorText(error);
        return failure(code, detail, summaries, step);
      }
      scope.steps[step.id] = summary;
      summaries.push(summary);
      if (!ok && !(step.optional && !isHardFailure(summary.error))) {
        return failure(
          'WORKFLOW_STEP_FAILED',
          summary.error ?? 'step failed',
          summaries,
          step,
        );
      }
    }
    let output: unknown;
    try {
      output = outputOf(tool, scope, summaries);
    } catch (error) {
      const code =
        error instanceof PluginError ? error.code : 'WORKFLOW_OUTPUT_MISSING';
      const detail =
        error instanceof PluginError ? error.detail : errorText(error);
      return failure(code, detail, summaries);
    }
    const payload = { output, steps: summaries };
    try {
      assertBounded(
        payload,
        'WORKFLOW_RESULT_LIMIT',
        Math.min(WORKFLOW_LIMITS.result, LIMITS.result),
        'workflow result',
      );
    } catch (error) {
      const code =
        error instanceof PluginError ? error.code : 'WORKFLOW_RESULT_LIMIT';
      const detail =
        error instanceof PluginError ? error.detail : errorText(error);
      return failure(code, detail, summaries);
    }
    return { success: true, data: payload, primary: 'data' };
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener('abort', onAbort);
  }
}

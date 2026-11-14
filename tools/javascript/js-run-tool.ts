import { withGuiCancellation } from "../vision/gui-cancellation";
import { BaseBrowserTool } from "../base/browser-tool";
import { PageExecTool, type PageExecOutcome } from "../browser/page-exec-tool";
import {
  runCrawlBatch,
  CRAWL_DEFAULT_PACE_MAX_MS,
  CRAWL_DEFAULT_PACE_MIN_MS,
  CRAWL_DEFAULT_TARGET_TIMEOUT_MS,
  CRAWL_MAX_TARGETS,
  CRAWL_PACE_MAX_BOUND_MS,
  CRAWL_PACE_MIN_BOUND_MS,
  CRAWL_TARGET_TIMEOUT_MAX_MS,
  type CrawlTargetInput,
} from "../browser/crawl-runner";
import type {
  ToolExecutionContext,
  ToolMetadata,
  ToolSchemaOptions,
} from "../registry";
import type { OpenAITool } from "@/common/openai-types";
import type { ToolResult } from "@/common/tool-handler";
import {
  executeWorkspaceFileAction,
  WORKSPACE_EDIT_PROPERTIES,
} from "@/utils/python-workspace/file-action";
import {
  parseWorkspaceFilePath,
  readWorkspaceFilePage,
  readWorkspaceTextFile,
  WORKSPACE_READ_PAGE_CHARS,
} from "@/utils/python-workspace/workspace-files";
import { saveWorkspaceResultFile } from "@/utils/python-workspace/data-files";
import { analyzeValue } from "@/utils/data-ref-rows";
import { chatDatabase } from "@/entrypoints/sidepanel/core/context/chat-database";
import { requireWorkspaceChatId } from "@/utils/python-workspace/artifact-contract";
import { JS_RUN_TOOL_ID } from "./js-contract";
import { toolErrorDetails } from "@/utils/shared/error-details";
const actions = [
  "create",
  "edit",
  "delete",
  "read",
  "list",
  "run",
  "crawl",
] as const;
const runKeys = [
  "args",
  "world",
  "strategy",
  "awaitPromise",
  "timeout",
  "tabId",
  "frameId",
  "label",
  "confirm",
] as const;
/** crawl 专属参数：目标列表 + 批次节奏与预算（run 的页面参数在 crawl 里同样有效） */
const crawlKeys = [
  "targets",
  "paceMinMs",
  "paceMaxMs",
  "totalTimeout",
] as const;
const keys: Record<string, readonly string[]> = {
  create: ["path", "content"],
  edit: [
    "path",
    "content",
    "find",
    "replace",
    "replaceAll",
    "edits",
    "matchMode",
    "expectedHash",
  ],
  delete: ["path"],
  read: ["path", "index"],
  list: ["path", "offset", "limit"],
  run: ["path", "expectedHash", ...runKeys],
  crawl: ["path", "expectedHash", ...runKeys, ...crawlKeys],
};
/** Validate and snapshot JSON arguments before crossing the browser execution boundary. */
function jsonArguments(raw: unknown): unknown[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("args 必须是 JSON 参数数组");
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 100000 || depth > 64) throw new Error("args 过大或嵌套过深");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (
      !value ||
      typeof value !== "object" ||
      (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    )
      throw new Error(
        "args 只接受 JSON 值，不接受 undefined、函数、BigInt、非有限数字或自定义对象",
      );
    if (ancestors.has(value)) throw new Error("args 不接受循环引用");
    ancestors.add(value);
    for (const item of Array.isArray(value) ? value : Object.values(value))
      visit(item, depth + 1);
    ancestors.delete(value);
  };
  visit(raw, 0);
  const json = JSON.stringify(raw);
  if (json.length > 1000000) throw new Error("args 超过 1000000 字符");
  return JSON.parse(json);
}
/** Reuse the unchanged backend execution implementation, with file-backed session input. */
export class JsRunTool extends BaseBrowserTool {
  name = JS_RUN_TOOL_ID;
  metadata: ToolMetadata = {
    name: this.name,
    category: "code",
    version: "1.2.0",
    author: "AgentNexus",
    description:
      "会话工作区文本文件创建、按页读取、原子编辑、删除及已保存 JavaScript 页面脚本执行（含多页批量抓取）；执行结果自动持久化为工作区结果文件",
    tags: ["javascript", "workspace", "script", "cdp", "crawl", "results"],
    permissions: ["scripting", "debugger"],
    requiresConfirm: true,
    requiresConfirmActions: ["run", "crawl"],
  };
  private readonly calls = new Map<
    AbortController,
    { chatId?: string; signal?: AbortSignal; requestId?: string }
  >();
  openaiSchema: OpenAITool;
  constructor() {
    super();
    const page = new PageExecTool().openaiSchema.function.parameters
      .properties!;
    this.openaiSchema = {
      type: "function",
      function: {
        name: this.name,
        description:
          "当前会话工作区文件与 JavaScript 工具。create/edit/delete 适用于所有扩展名的 UTF-8 文本；read 按 path 分页读取任意工作区文本文件（index 指定页码，每页 ≤2000 字符，响应携带当前页码与总页数）；list 盘点文件。run 只接受已保存的 .js/.mjs/.cjs 相对路径，绝不接收内联 code；每次执行的完整结果自动保存为 results/ 下的独立 JSON 文件（≤10MB，跨浏览器重启持久），响应只回传前 2000 字符、超出部分用 read 续读。crawl 把同一个已保存脚本按 targets 列表跑遍多个页面：工具内部完成导航、等待就绪与逐页执行，页面间随机停顿防风控，每页独立失败并给出逐目标账本，结果合成一张带来源列的表并同样落盘为结果文件。页面执行策略、世界、frame、Promise 与超时完整保留；通过 $args 使用 args 数组动态传参（crawl 时 $args[0] 是本次目标信息）。操作顺序、复用、编辑和交付规则见全局脚本规范。",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: { type: "string", enum: [...actions] },
            path: {
              type: "string",
              description:
                "当前会话工作区相对路径，如 scripts/collect.js 或 results/run-….json。run/crawl 必填且指向 .js/.mjs/.cjs 脚本；read 必填且一次只读一个文件；list 可省略以列出根目录。",
            },
            content: {
              type: "string",
              description:
                "create 必填；edit 时全量重写，与 find/replace 和 edits 互斥。",
            },
            find: {
              type: "string",
              description:
                "edit 精确定位串，默认必须唯一命中；与 replace 成对。",
            },
            replace: {
              type: "string",
              description: "edit 替换文本，按字面处理，允许空串。",
            },
            replaceAll: {
              type: "boolean",
              description: "edit 是否替换全部命中，默认 false。",
            },
            ...WORKSPACE_EDIT_PROPERTIES,
            ...Object.fromEntries(
              runKeys
                .filter((key) => key !== "label")
                .map((key) => [key, page[key]]),
            ),
            label: {
              type: "string",
              description:
                "run/crawl 可选：结果文件名的语义后缀（如「第3页-商品列表」），便于 list 时辨识；省略则仅用时间戳命名。",
            },
            targets: {
              type: "array",
              description: `仅 crawl：目标页列表（1~${CRAWL_MAX_TARGETS} 个）。每项含 url（必填）与可选 label（语义标签，出现在结果行与账本里）、expectUrlIncludes（预期 URL 片段，不符即记 drifted）、expectTextIncludes（预期正文片段，不符即记 drifted——用于识别软 404）。`,
              items: {
                type: "object",
                properties: {
                  url: {
                    type: "string",
                    description: "目标页 URL（完整地址）",
                  },
                  label: {
                    type: "string",
                    description: "该目标的语义标签（如商品SKU）",
                  },
                  expectUrlIncludes: {
                    type: "string",
                    description:
                      "预期最终 URL 必须包含的片段——用于识别跳转与链接结构变更",
                  },
                  expectTextIncludes: {
                    type: "string",
                    description:
                      "预期页面内容必须包含的片段——用于识别软 404（URL 正常但内容是错误页）",
                  },
                },
                required: ["url"],
              },
            },
            paceMinMs: {
              type: "integer",
              minimum: CRAWL_PACE_MIN_BOUND_MS,
              maximum: CRAWL_PACE_MAX_BOUND_MS,
              description: `仅 crawl：目标间随机停顿的下限，毫秒（默认 ${CRAWL_DEFAULT_PACE_MIN_MS}）。停顿是**随机**的——固定间隔与突发流量一样容易被识别为自动化。设为 0 可关闭（仅在确认目标站无风控时）。`,
            },
            paceMaxMs: {
              type: "integer",
              minimum: CRAWL_PACE_MIN_BOUND_MS,
              maximum: CRAWL_PACE_MAX_BOUND_MS,
              description: `仅 crawl：目标间随机停顿的上限，毫秒（默认 ${CRAWL_DEFAULT_PACE_MAX_MS}）。不得小于 paceMinMs。`,
            },
            totalTimeout: {
              type: "integer",
              minimum: 1000,
              description: `仅 crawl：整批的总预算，毫秒（缺省按目标数与停顿估算）。预算耗尽时停止并交出已完成部分的账本——未执行的目标标为 skipped。`,
            },
            index: {
              type: "integer",
              minimum: 1,
              description: `仅 read：页码（1 起，默认 1）。每页最多 ${WORKSPACE_READ_PAGE_CHARS} 字符，响应携带 index/pageCount/hasMore/nextIndex；续读直接传 nextIndex。`,
            },
            offset: {
              type: "integer",
              minimum: 0,
              description: "仅 list：条目偏移，默认 0。",
            },
            limit: {
              type: "integer",
              minimum: 1,
              description:
                "仅 list：每页最多返回的条目数（默认 100、最多 200）。",
            },
          },
          anyOf: actions.map((action) => ({
            properties: { action: { type: "string", enum: [action] } },
            required:
              action === "create"
                ? ["action", "path", "content"]
                : ["edit", "delete", "run", "crawl"].includes(action)
                  ? ["action", "path"]
                  : ["action"],
          })),
        },
      },
    };
  }
  getSchema(options: ToolSchemaOptions): OpenAITool {
    if (options.toolPolicy !== "vision-assistant") return this.openaiSchema;
    const copy = structuredClone(this.openaiSchema);
    (
      copy.function.parameters.properties!.action as {
        enum: string[];
      }
    ).enum = actions.filter((action) => action !== "run" && action !== "crawl");
    copy.function.parameters.anyOf = (
      copy.function.parameters.anyOf as any[]
    ).filter(
      (branch) =>
        !branch.properties.action.enum.includes("run") &&
        !branch.properties.action.enum.includes("crawl"),
    );
    return copy;
  }
  async execute(
    raw: unknown,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    // Keep the browser forwarding signal outside catch. File editing needs no background or Python.
    if (
      raw &&
      typeof raw === "object" &&
      ((raw as any).action === "run" || (raw as any).action === "crawl")
    )
      this.ensureBackgroundContext();
    const controller = new AbortController();
    this.calls.set(controller, {
      chatId: context?.chatId,
      signal: context?.signal,
      requestId: context?.requestId,
    });
    const cancel = () => controller.abort(context?.signal?.reason);
    context?.signal?.addEventListener("abort", cancel, { once: true });
    if (context?.signal?.aborted) cancel();
    try {
      return await withGuiCancellation(
        context?.requestId,
        (signal) => this.executeChecked(raw, { ...context, signal }),
        controller.signal,
      );
    } catch (error) {
      return this.createErrorResponse(
        "[JS_EXEC_FAILED] " + toolErrorDetails(error, "JS"),
      );
    } finally {
      context?.signal?.removeEventListener("abort", cancel);
      this.calls.delete(controller);
    }
  }
  private async executeChecked(
    raw: unknown,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("参数必须是 JSON 对象");
      const args = raw as Record<string, unknown>,
        action = args.action;
      if (
        typeof action !== "string" ||
        !Object.prototype.hasOwnProperty.call(keys, action)
      )
        throw new Error("action 必须是 " + actions.join(" / "));
      const unexpected = Object.keys(args).filter(
        (key) => key !== "action" && !keys[action].includes(key),
      );
      if (unexpected.length)
        throw new Error(
          "action=" + action + " 不接受参数：" + unexpected.join(", "),
        );
      if (
        context?.toolPolicy === "vision-assistant" &&
        (action === "run" || action === "crawl")
      )
        throw new Error("TOOL_NOT_ALLOWED: 观察型助手不能执行页面脚本");
      const chatId = requireWorkspaceChatId(context?.chatId);
      context?.signal?.throwIfAborted();
      if (action === "create" || action === "edit" || action === "delete")
        return await executeWorkspaceFileAction(
          action,
          args,
          chatId,
          context?.signal,
        );
      if (action === "list") {
        const prefix =
          args.path === undefined || args.path === "."
            ? ""
            : parseWorkspaceFilePath(args.path) + "/";
        const offset = this.integer(args.offset, 0),
          limit = Math.min(this.integer(args.limit, 100, 1), 200);
        const snapshot = await chatDatabase.readWorkspace(
          chatId,
          context?.signal,
        );
        if (prefix) {
          const entry = snapshot?.entries.find(
            (item) => item.path === prefix.slice(0, -1),
          );
          if (!entry || entry.blob || entry.link)
            throw new Error("list 的 path 必须指向存在的普通目录");
        }
        const entries = (snapshot?.entries ?? [])
          .filter((item) => item.path.startsWith(prefix))
          .sort((a, b) => a.path.localeCompare(b.path));
        return this.createSuccessResponse({
          entries: entries.slice(offset, offset + limit).map((item) => ({
            path: item.path,
            kind: item.link ? "link" : item.blob ? "file" : "directory",
            bytes: item.blob?.size ?? 0,
          })),
          total: entries.length,
          nextOffset: Math.min(offset + limit, entries.length),
          hasMore: offset + limit < entries.length,
        });
      }
      if (action === "read") {
        if (args.path === undefined)
          throw new Error(
            "read 必须提供 path（一次只读一个文件；工作区任意 UTF-8 文本文件均可按页读取）",
          );
        const page = await readWorkspaceFilePage(
          chatId,
          args.path,
          args.index,
          context?.signal,
        );
        const shapeNote =
          page.pageCount > 1
            ? `共 ${page.pageCount} 页（${page.totalChars} 字符），${page.hasMore ? `续读传 index=${page.nextIndex}` : "已是最后一页"}`
            : page.pageCount === 1
              ? "全文一页返回"
              : "文件为空";
        return this.createSuccessResponse(
          { ...page },
          `已读取 ${page.path} 第 ${page.index}/${page.pageCount} 页（本页 ${page.content.length} 字符；${shapeNote}）。`,
        );
      }
      for (const key of ["confirm", "awaitPromise"])
        if (args[key] !== undefined && typeof args[key] !== "boolean")
          throw new Error(key + " 必须是布尔值");
      if (
        args.world !== undefined &&
        !["auto", "MAIN", "ISOLATED"].includes(args.world as string)
      )
        throw new Error("world 必须是 auto / MAIN / ISOLATED");
      if (
        args.strategy !== undefined &&
        !["auto", "cdp", "scripting"].includes(args.strategy as string)
      )
        throw new Error("strategy 必须是 auto / cdp / scripting");
      if (
        args.strategy === "cdp" &&
        (args.world === "ISOLATED" ||
          (args.frameId !== undefined && args.frameId !== 0))
      )
        throw new Error(
          "CDP 仅支持主 frame 的 MAIN 世界；隔离世界或子 frame 请用 scripting",
        );
      for (const key of ["tabId", "frameId"])
        if (
          args[key] !== undefined &&
          (!Number.isSafeInteger(args[key]) || (args[key] as number) < 0)
        )
          throw new Error(key + " 必须是非负安全整数");
      if (
        args.label !== undefined &&
        (typeof args.label !== "string" || args.label.length > 2000)
      )
        throw new Error("label 必须是不超过 2000 字符的字符串");
      if (
        args.expectedHash !== undefined &&
        (typeof args.expectedHash !== "string" ||
          !/^[a-f0-9]{64}$/i.test(args.expectedHash))
      )
        throw new Error("expectedHash 必须是 SHA-256");
      const path = parseWorkspaceFilePath(args.path);
      if (!/\.(?:js|mjs|cjs)$/i.test(path))
        throw new Error(
          "run/crawl 的 path 必须指向已保存的 .js/.mjs/.cjs 脚本（async 函数体，支持 await/return；不是 Node 或 ESM 模块加载器）",
        );
      const codeArgs = jsonArguments(args.args);
      const file = await readWorkspaceTextFile(chatId, path, context?.signal);
      if (
        args.expectedHash !== undefined &&
        String(args.expectedHash).toLowerCase() !== file.sha256
      )
        throw new Error("脚本已变化，expectedHash 不匹配，请重新 read");
      if (action === "crawl")
        return await this.executeCrawl(args, chatId, file, codeArgs, context);
      const outcome = await this.executeScriptCore(
        {
          code: file.content,
          args: codeArgs,
          world: args.world as "auto" | "MAIN" | "ISOLATED" | undefined,
          strategy: args.strategy as "auto" | "cdp" | "scripting" | undefined,
          awaitPromise: args.awaitPromise as boolean | undefined,
          timeout: args.timeout as number | undefined,
          tabId: args.tabId as number | undefined,
          frameId: args.frameId as number | undefined,
        },
        context,
      );
      if (!outcome.ok) return this.createErrorResponse(outcome.error);
      return await this.buildRunResponse(
        outcome,
        { path, sha256: file.sha256 },
        args.label,
        chatId,
        context,
      );
    } catch (error) {
      return this.createErrorResponse(
        context?.signal?.aborted
          ? "[JS_EXEC_CANCELLED] 操作已取消；已开始的页面副作用不保证撤销，请先检查页面现状"
          : toolErrorDetails(error, "JS"),
      );
    }
  }
  private integer(value: unknown, fallback: number, minimum = 0): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || (value as number) < minimum)
      throw new Error("offset/limit 必须是范围内的安全整数");
    return value as number;
  }
  /**
   * run 的结果封装：完整结果 JSON 落为工作区结果文件（results/，跨重启
   * 持久），响应正文恒为前 WORKSPACE_READ_PAGE_CHARS（2000）字符预览，
   * 超出部分引导用 read 从 index=2 按页续读——数据不重复进对话。
   * 持久化失败（超 10MB/配额触达）视为结果丢失风险，整单报错并保留
   * 预览与统计供模型缩小批次重跑。
   */
  private async buildRunResponse(
    outcome: Extract<PageExecOutcome, { ok: true }>,
    script: { path: string; sha256: string },
    label: unknown,
    chatId: string,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const warnings: string[] = [];
    const shape = analyzeValue(outcome.value);
    const shapeText =
      shape.kind === "records"
        ? `${shape.rowCount ?? 0} 行对象数组`
        : shape.kind === "matrix"
          ? `${shape.rowCount ?? 0} 行二维数组`
          : "单值";

    let resultFile: { path: string; bytes: number } | undefined;
    let saveError: string | undefined;
    if (outcome.fullJson !== undefined) {
      context?.signal?.throwIfAborted();
      try {
        resultFile = await saveWorkspaceResultFile(
          chatId,
          "run",
          label,
          outcome.fullJson,
          context?.signal,
        );
      } catch (error) {
        // 取消不是持久化失败：让外层以 JS_EXEC_CANCELLED 语义收尾，
        // 而不是把中止误报成「结果未落盘」
        if (context?.signal?.aborted) throw error;
        saveError = toolErrorDetails(error, "JS");
      }
    } else {
      warnings.push(
        `完整结果未能捕获：${outcome.captureNote ?? "未知原因"}——本响应仅含有限预览，超出部分不可再读取；需要完整数据请缩小结果体积后重跑`,
      );
    }
    if (outcome.errorShapeHint) warnings.push(outcome.errorShapeHint);

    const payload: Record<string, unknown> = {
      tabId: outcome.tabId,
      frameId: outcome.frameId,
      url: outcome.url,
      engine: outcome.engine,
      world: outcome.world,
      durationMs: outcome.durationMs,
      outcome: outcome.outcome,
      attempts: outcome.attempts,
      shape,
      script,
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    if (outcome.fullJson !== undefined) {
      const totalChars = outcome.fullJson.length;
      payload.result = outcome.fullJson.slice(0, WORKSPACE_READ_PAGE_CHARS);
      payload.resultType = "json-preview";
      payload.totalChars = totalChars;
      if (totalChars > WORKSPACE_READ_PAGE_CHARS)
        payload.resultTruncated = true;
      if (resultFile) payload.resultFile = resultFile;
    } else {
      // 捕获失败兜底：净化值直接返回，序列化超限时降级为有界文本预览
      let structuredText: string | undefined;
      try {
        structuredText =
          JSON.stringify(outcome.value === undefined ? null : outcome.value) ??
          undefined;
      } catch {
        structuredText = undefined;
      }
      if (
        structuredText !== undefined &&
        structuredText.length > WORKSPACE_READ_PAGE_CHARS
      ) {
        payload.result = structuredText.slice(0, WORKSPACE_READ_PAGE_CHARS);
        payload.resultType = "json-preview";
        payload.totalChars = structuredText.length;
        payload.resultTruncated = true;
      } else {
        payload.result = outcome.value;
        payload.resultType = outcome.type ?? typeof outcome.value;
      }
    }

    const truncated = payload.resultTruncated === true;
    let message =
      `执行成功（${outcome.engine ?? "auto"} / ${outcome.world ?? "MAIN"} 世界，${outcome.durationMs}ms，${shapeText}）。` +
      (resultFile
        ? `完整结果 ${payload.totalChars as number} 字符已保存为 ${resultFile.path}（${resultFile.bytes} 字节，随会话工作区持久保存）。`
        : "");
    if (resultFile && truncated) {
      message += `\n本响应仅含前 ${WORKSPACE_READ_PAGE_CHARS} 字符预览——其余部分用 js_run(action="read", path="${resultFile.path}", index=2) 起按页续读（每页 ${WORKSPACE_READ_PAGE_CHARS} 字符，read 响应携带总页数）。`;
    }
    if (resultFile) {
      message += `\n后续：data_ref_tool(action="info", file="${resultFile.path}") 查看字段结构；data_ref_tool(files=[...]) 合并/去重/投影；xlsx_tool(action="create_from_data", sheets:[{name, dataFiles:["${resultFile.path}"]}]) 直接导出。`;
    }
    if (saveError) {
      return {
        ...this.createSuccessResponse(
          payload,
          message +
            `\n⚠️ 结果未能持久化：${saveError}——超出预览的数据已丢失，请在脚本内筛选字段或限制条数后分批产出。`,
        ),
        success: false,
        isError: true,
        error: "[JS_RESULT_STORAGE] " + saveError,
      };
    }
    return this.createSuccessResponse(payload, message);
  }
  /**
   * crawl：把同一个已保存脚本按 targets 列表跑遍多个页面。
   *
   * 与 run 的分工：run 跑一页，crawl 跑一页列表。crawl 内部完成
   * **导航 / 等待就绪 / 逐页执行 / 节奏控制 / 失败隔离 / 账本**——
   * 模型只提供目标列表与脚本，不必自己编排跳转。
   *
   * 失败隔离：任一目标失败只影响该目标（账本里逐条记原因），其余继续；
   * 连续失败达阈值即熔断剩余目标（不空转撞墙）；命中风控页即停止并
   * 交由用户手动处理（绝不尝试绕过）。
   */
  private async executeCrawl(
    args: Record<string, unknown>,
    chatId: string,
    file: { content: string; sha256: string },
    codeArgs: unknown[],
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const targets = this.parseCrawlTargets(args.targets);
    const targetTimeoutMs = this.boundedInt(
      args.timeout,
      CRAWL_DEFAULT_TARGET_TIMEOUT_MS,
      1000,
      CRAWL_TARGET_TIMEOUT_MAX_MS,
      "timeout",
    );
    const paceMinMs = this.boundedInt(
      args.paceMinMs,
      CRAWL_DEFAULT_PACE_MIN_MS,
      CRAWL_PACE_MIN_BOUND_MS,
      CRAWL_PACE_MAX_BOUND_MS,
      "paceMinMs",
    );
    const paceMaxMs = this.boundedInt(
      args.paceMaxMs,
      CRAWL_DEFAULT_PACE_MAX_MS,
      CRAWL_PACE_MIN_BOUND_MS,
      CRAWL_PACE_MAX_BOUND_MS,
      "paceMaxMs",
    );
    if (paceMaxMs < paceMinMs)
      throw new Error(
        `paceMaxMs（${paceMaxMs}）不得小于 paceMinMs（${paceMinMs}）`,
      );
    const totalTimeoutMs = this.boundedInt(
      args.totalTimeout,
      this.estimateCrawlBudget(targets.length, targetTimeoutMs, paceMaxMs),
      1000,
      30 * 60_000,
      "totalTimeout",
    );

    const outcome = await runCrawlBatch({
      targets,
      code: file.content,
      args: codeArgs,
      targetTimeoutMs,
      totalTimeoutMs,
      paceMinMs,
      paceMaxMs,
      world: (args.world as "auto" | "MAIN" | "ISOLATED") ?? "auto",
      strategy: (args.strategy as "auto" | "cdp" | "scripting") ?? "auto",
      awaitPromise: args.awaitPromise !== false,
      ...(typeof args.tabId === "number" ? { tabId: args.tabId } : {}),
      ...(typeof args.frameId === "number" ? { frameId: args.frameId } : {}),
      onTabTarget: context?.onTabTarget,
      signal: context?.signal,
    });
    context?.signal?.throwIfAborted();

    // 结果落工作区结果文件（与 run 同一通道）：一次 crawl 产出一个独立
    // JSON 文件（无论行数多少），跨浏览器重启持久保存
    let resultFile: { path: string; bytes: number } | undefined;
    let saveError: string | undefined;
    const json = JSON.stringify(outcome.rows);
    try {
      resultFile = await saveWorkspaceResultFile(
        chatId,
        "crawl",
        args.label,
        json,
        context?.signal,
      );
    } catch (error) {
      // 取消不是持久化失败：让外层以 JS_EXEC_CANCELLED 语义收尾
      if (context?.signal?.aborted) throw error;
      saveError = toolErrorDetails(error, "JS");
    }

    const summary = outcome.summary;
    const message =
      `✅ 批量抓取完成：${summary.total} 个目标，` +
      `成功 ${summary.ok}、为空 ${summary.empty}、失败 ${summary.failed}、` +
      `超时 ${summary.timeout}、被风控 ${summary.blocked}、链接漂移 ${summary.drifted}、` +
      `未执行 ${summary.skipped}（耗时 ${(outcome.totalDurationMs / 1000).toFixed(1)}s）。` +
      (resultFile
        ? `\n结果已保存为 ${resultFile.path}（${outcome.rows.length} 行，含 _target/_url 等来源列，${resultFile.bytes} 字节）` +
          `\n可直接 xlsx_tool(action="create_from_data", sheets:[{name, dataFiles:["${resultFile.path}"]}]) 导出；多批合并/去重用 data_ref_tool(files=[...])。` +
          (json.length > WORKSPACE_READ_PAGE_CHARS
            ? `\n本响应仅含前 ${WORKSPACE_READ_PAGE_CHARS} 字符预览——其余部分用 js_run(action="read", path="${resultFile.path}", index=2) 起按页续读。`
            : "")
        : "") +
      (summary.blocked > 0
        ? "\n⚠️ 有目标命中风控/人机验证页：请在对应标签页手动完成验证后，用剩余目标重试（本工具不会尝试绕过风控）。"
        : "") +
      (summary.skipped > 0
        ? `\n⚠️ ${summary.skipped} 个目标未执行——账本里逐条列出了原因。`
        : "") +
      (saveError
        ? `\n⚠️ 结果未能持久化：${saveError}——请在脚本内筛选字段或限制条数后分批抓取。`
        : "");

    const response = this.createSuccessResponse(
      {
        summary,
        ledger: outcome.ledger,
        totalDurationMs: outcome.totalDurationMs,
        result: json.slice(0, WORKSPACE_READ_PAGE_CHARS),
        resultType: "json-preview",
        totalChars: json.length,
        ...(json.length > WORKSPACE_READ_PAGE_CHARS
          ? { resultTruncated: true }
          : {}),
        ...(resultFile ? { resultFile } : {}),
        ...(saveError ? { saveError } : {}),
        script: {
          path: parseWorkspaceFilePath(args.path),
          sha256: file.sha256,
        },
      },
      message,
    );
    return saveError
      ? {
          ...response,
          success: false,
          isError: true,
          error: "[JS_RESULT_STORAGE] " + saveError,
        }
      : response;
  }
  /** 解析并校验 targets（形状错误即时报，避免带着脏参数跑半个批次） */
  private parseCrawlTargets(raw: unknown): CrawlTargetInput[] {
    if (!Array.isArray(raw) || raw.length === 0)
      throw new Error("crawl 的 targets 必须是非空数组");
    if (raw.length > CRAWL_MAX_TARGETS)
      throw new Error(
        `crawl 的 targets 数量 ${raw.length} 超过上限 ${CRAWL_MAX_TARGETS}——请分批抓取（分批还能在中途检查结果）`,
      );
    const targets: CrawlTargetInput[] = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i] as Record<string, unknown> | null;
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).some(
          (key) =>
            ![
              "url",
              "label",
              "expectUrlIncludes",
              "expectTextIncludes",
            ].includes(key),
        )
      )
        throw new Error(`targets[${i}] 必须是对象（含 url 字段）`);
      const url = item.url;
      if (typeof url !== "string" || !url.trim())
        throw new Error(`targets[${i}].url 必须是非空字符串`);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`targets[${i}].url 不是有效 URL`);
      }
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        url.length > 8192
      )
        throw new Error(
          `targets[${i}].url 必须是 http/https 完整地址（收到 "${url.trim().slice(0, 60)}"）`,
        );
      const target: CrawlTargetInput = { url: url.trim() };
      if (item.label !== undefined && item.label !== null) {
        if (typeof item.label !== "string" || item.label.length > 2000)
          throw new Error(`targets[${i}].label 必须是字符串`);
        target.label = item.label;
      }
      for (const key of ["expectUrlIncludes", "expectTextIncludes"] as const) {
        const value = item[key];
        if (value !== undefined && value !== null) {
          if (typeof value !== "string" || !value.trim() || value.length > 4000)
            throw new Error(`targets[${i}].${key} 必须是非空字符串`);
          target[key] = value.trim();
        }
      }
      targets.push(target);
    }
    return targets;
  }
  /** 读取一个有界整数：非法值抛错（模型可控参数错误尽早暴露） */
  private boundedInt(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    name: string,
  ): number {
    if (value === undefined || value === null) return fallback;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value)
    )
      throw new Error(
        `${name} 必须是整数（毫秒），收到 ${JSON.stringify(value)}`,
      );
    if (value < min || value > max)
      throw new Error(`${name} 必须在 ${min}~${max} 毫秒之间（收到 ${value}）`);
    return value;
  }
  /** 整批预算的缺省估算：每目标超时 + 目标间停顿 */
  private estimateCrawlBudget(
    targetCount: number,
    perTargetMs: number,
    paceMaxMs: number,
  ): number {
    const estimate = targetCount * (perTargetMs + paceMaxMs) + 5_000;
    return Math.min(30 * 60_000, Math.max(30_000, estimate));
  }
  /** 执行内核调用（带取消联动）：结果持久化由调用方（buildRunResponse）决定 */
  private async executeScriptCore(
    args: {
      code: string;
      args?: unknown[];
      world?: "auto" | "MAIN" | "ISOLATED";
      strategy?: "auto" | "cdp" | "scripting";
      awaitPromise?: boolean;
      timeout?: number;
      tabId?: number;
      frameId?: number;
    },
    context?: ToolExecutionContext,
  ): Promise<PageExecOutcome> {
    const engine = new PageExecTool();
    const cancel = () => {
      void engine.kill(args, context).catch(() => undefined);
    };
    context?.signal?.addEventListener("abort", cancel, { once: true });
    try {
      context?.signal?.throwIfAborted();
      return await engine.executeScript(args, context);
    } finally {
      context?.signal?.removeEventListener("abort", cancel);
    }
  }
  async kill(_args?: unknown, context?: ToolExecutionContext): Promise<void> {
    for (const [controller, call] of this.calls) {
      if (context?.chatId && call.chatId !== context.chatId) continue;
      if (context?.signal && call.signal !== context.signal) continue;
      if (context?.requestId && call.requestId !== context.requestId) continue;
      controller.abort(
        new DOMException("JavaScript tool cancelled", "AbortError"),
      );
    }
  }
}
export const jsRunTool = new JsRunTool();

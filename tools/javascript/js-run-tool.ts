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
} from "../registry";
import type { OpenAITool } from "@/common/openai-types";
import type { ToolResult } from "@/common/tool-handler";
import {
  parseWorkspaceFilePath,
  readWorkspaceTextFile,
  WORKSPACE_READ_PAGE_CHARS,
} from "@/utils/python-workspace/workspace-files";
import { saveWorkspaceResultFile } from "@/utils/python-workspace/data-files";
import { analyzeValue } from "@/utils/data-ref-rows";
import {
  describeCompleteness,
  detectEnvelopeBaseline,
  resolveRelationTable,
  verifyCompleteness,
} from "@/utils/relation-table";
import { requireWorkspaceChatId } from "@/utils/python-workspace/artifact-contract";
import { JS_RUN_TOOL_ID } from "./js-contract";
import { toolErrorDetails } from "@/utils/shared/error-details";
const actions = ["run", "crawl"] as const;
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
/**
 * list 的目录盘点语义（缺失目录提示、文件/目录区分、分页口径）见
 * utils/python-workspace/workspace-listing —— 文件读写与盘点统一走 file_util，
 * js_run 只负责页面脚本执行与结果落盘。
 */

/** Reuse the unchanged backend execution implementation, with file-backed session input. */
export class JsRunTool extends BaseBrowserTool {
  name = JS_RUN_TOOL_ID;
  metadata: ToolMetadata = {
    name: this.name,
    category: "code",
    version: "1.3.0",
    author: "AgentNexus",
    description:
      "已保存 JavaScript 页面脚本执行（含多页批量抓取）；每次执行结果自动持久化为工作区结果文件（读取/编辑工作区文件请用 file_util）",
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
          '<js-run>\n' +
          '  <capability>已保存 JavaScript 页面脚本的执行工具。脚本文件本身用 file_util 创建/读取/编辑/删除。</capability>\n' +
          '  <actions>\n' +
          '    <action name="run">执行**已保存**的 .js/.mjs/.cjs 脚本——脚本文件的新建/读取/编辑/删除一律用 file_util（本工具不提供任何文件 CRUD action）。只接受工作区内相对路径，**绝不接收内联 code**。</action>\n' +
          '    <action name="crawl">把同一个脚本按 targets 列表跑遍多个页面：工具内部完成导航、等待就绪与逐页执行，页面间随机停顿防风控，每页独立失败并给出逐目标账本。</action>\n' +
          '  </actions>\n' +
          '  <result>每次执行的完整结果自动保存为 results/ 下的独立 JSON 文件（≤10MB，跨浏览器重启持久；results/ 由首次写入自动创建）。响应只回传前 2000 字符，超出部分用 file_util(action="read", path=结果文件路径, index=1) 按页续读（每页 3000 字符）。</result>\n' +
          '  <return-contract>脚本返回值就是产出的数据：直接 return 对象数组（每行一条记录）最省事；return 信封对象（如 {page,totalOnPage,rows:[…]}）同样可用——下游工具会按载荷路径契约定位行表（成员名 rows/items/data/records/list/results/content 优先），回执会告诉你行表路径与信封里的标量元数据。信封里的总量字段（totalOnPage/total/count 等）是核对「实抓行数 vs 页面宣称总数」的独立口径，请随结果一起返回：实抓行数与它不一致时工具会当场告警。**禁止只返回实抓行数而丢掉基准**——那样就只剩自证式对账，漏抓无从发现。</return-contract>\n' +
          '  <downstream>结果文件可直接交给 data_ref_tool(action="info", file=…) 查看字段结构、data_ref_tool(files=[…]) 合并/去重/投影、xlsx_tool(action="create_from_data", sheets:[{name, dataFiles:[结果文件路径]}]) 导出，无需再读内容。</downstream>\n' +
          '  <script-contract>脚本是目标页面内的 async 函数体：允许 await，必须 return 所需结果。通过 $args 使用 args 数组动态传参（crawl 时 $args[0] 是本次目标信息）。页面执行策略、世界、frame、Promise 与超时完整保留。</script-contract>\n' +
          '  <access-discipline>站点访问纪律「慢、少、撞墙即停」——适用于脚本内网络请求（fetch/XHR 循环翻页取数）、逐页连续 run（翻页按钮/页码 URL 场景）、多页抓取；无网络往返的本地只读探测不需要等待：\n' +
          '    ① 慢——相邻网络请求之间加约 ' +
          `${CRAWL_DEFAULT_PACE_MIN_MS / 1000}~${CRAWL_DEFAULT_PACE_MAX_MS / 1000}` +
          ' 秒随机等待，用随机而非固定间隔（固定节奏与突发流量一样容易被判定为自动化）；多页已知 URL 优先交给 crawl，它已内置页面间随机停顿与同源串行。\n' +
          '    ② 少——只请求达成目标所需的页数与字段，先小样本再全量；不对同一站点并发连发请求（如 Promise.all 批量 fetch）。含等待的循环要相应加大 timeout（默认 30000 毫秒）或缩小批次，避免等待本身耗尽超时预算。\n' +
          '    ③ 撞墙即停——收到 429/403 或疑似验证/风控响应时立即停止，把状态码与响应摘要作为结果返回，禁止循环重试轰炸；命中风控/人机验证页时停止并交用户手动完成，绝不尝试绕过。随机等待只管请求节奏，页面就绪请按条件判断，不用固定 sleep 猜时长。\n' +
          '  </access-discipline>\n' +
          '  <usage>操作顺序、复用、编辑和交付规则见全局脚本规范。</usage>\n' +
          '</js-run>',
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: {
              type: "string",
              enum: [...actions],
              description:
                "run=执行已保存的页面脚本；crawl=同一脚本按 targets 多页批量抓取（脚本文件的新建/读取/编辑/删除一律用 file_util）",
            },
            path: {
              type: "string",
              description:
                "当前会话工作区相对路径，如 scripts/collect.js。run/crawl 必填且指向已保存的 .js/.mjs/.cjs 脚本；脚本的新建/读取/编辑/删除请用 file_util。",
            },
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
          },
          anyOf: actions.map((action) => ({
            properties: { action: { type: "string", enum: [action] } },
            required: ["action", "path"],
          })),
        },
      },
    };
  }
  async execute(
    raw: unknown,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    // 页面执行需要后台上下文；工作区文件读写已统一到 file_util。
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
        throw new Error(
          `参数必须是 JSON 对象（收到 ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw}）`,
        );
      const args = raw as Record<string, unknown>,
        action = args.action;
      if (
        typeof action !== "string" ||
        !Object.prototype.hasOwnProperty.call(keys, action)
      )
        throw new Error(
          `action 必须是 ${actions.join(" / ")}（收到 ${JSON.stringify(action ?? null)}）`,
        );
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
        throw new Error("脚本已变化，expectedHash 不匹配，请用 file_util(action=\"read\") 重新读取后再执行");
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
  /**
   * run 的结果封装：完整结果 JSON 落为工作区结果文件（results/，跨重启
   * 持久），响应正文恒为前 WORKSPACE_READ_PAGE_CHARS（2000）字符预览，
   * 超出部分引导用 file_util(action="read", index=1) 按页（3000 字符/页）续读
   * ——预览已覆盖第 1 页大半，从第 1 页读起不会漏内容，数据不重复进对话。
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
    // 形态一律按**解析后的行表**描述，而不是原始返回值：脚本返回信封结构时，
    // 原始值是「单值」，但真正的产出是那 50 行——按原始值描述会让模型以为
    // 脚本没抓到东西（上一版正是如此：信封返回被回执报成「单值」）。
    const relation = resolveRelationTable(outcome.value);
    const tableShape = relation.ok
      ? analyzeValue(relation.rows)
      : analyzeValue(outcome.value);
    const shapeText = relation.ok
      ? relation.location.kind === 'envelope'
        ? `信封结构（行表在路径 "${relation.location.path}"）`
        : tableShape.kind === 'records'
          ? `${tableShape.rowCount ?? 0} 行对象数组`
          : tableShape.kind === 'matrix'
            ? `${tableShape.rowCount ?? 0} 行二维数组`
            : '单值'
      : tableShape.kind === 'records'
        ? `${tableShape.rowCount ?? 0} 行对象数组`
        : tableShape.kind === 'matrix'
          ? `${tableShape.rowCount ?? 0} 行二维数组`
          : '单值';
    // 完整性对账（生产端）：脚本自报的总量与实抓行数不符时立刻点破——
    // 「漏抓」要在采集当场被看见，而不是等到导出时才发现。
    const completeness = relation.ok
      ? (() => {
          const baseline = detectEnvelopeBaseline(relation.envelopeMeta);
          const verdict = verifyCompleteness(relation.rows.length, baseline);
          return verdict === 'matched' || verdict === 'unverified'
            ? null
            : describeCompleteness(relation.rows.length, baseline, verdict);
        })()
      : null;

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

    // 回执只保留「与本次结果消费直接相关」的字段：结果文件、预览、总字符、
    // 行数、截断与告警。执行台账（tabId/frameId/url/engine/world/durationMs/
    // outcome/attempts/script）对模型下一步决策没有增量价值，已移除；
    // 数据治理与导出的固定导航文案移到工具描述，避免每次调用重复数百字符。
    const payload: Record<string, unknown> = {
      ...(tableShape?.rowCount !== undefined ? { rows: tableShape.rowCount } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    // 信封结构：把行表路径与对账元数据一并回传（模型据此知道导出会取哪张表，
    // 以及有哪些独立的对照口径可用于「实抓 vs 宣称总数」核对）
    if (relation.ok && relation.location.kind === "envelope") {
      payload.relation = {
        path: relation.location.path,
        rows: relation.rows.length,
        matchKind: relation.matchKind,
        envelopeMeta: relation.envelopeMeta,
      };
    }
    // 对账未通过 → 计入 warnings（与其它告警同通道，模型不会漏看）
    if (completeness) {
      const existing = Array.isArray(warnings) ? warnings : [];
      existing.push(completeness);
      payload.warnings = existing;
    }

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
      `执行成功：${shapeText}。` +
      (resultFile
        ? `完整结果 ${payload.totalChars as number} 字符已保存为 ${resultFile.path}（${resultFile.bytes} 字节）。`
        : "");
    if (resultFile && truncated) {
      message += `\n本响应仅含前 ${WORKSPACE_READ_PAGE_CHARS} 字符预览——其余用 file_util(action="read", path="${resultFile.path}", index=1) 起按页续读（每页 3000 字符）。`;
    }
    // 信封结构：对账口径已在 payload.relation.envelopeMeta 里（结构化、可编程
    // 消费），正文不再复述一遍——同一份事实出现两次是纯上下文浪费。
    // 正文只补「结论」：对账通过与否（漏抓必须在这里就被看见）。
    if (completeness) {
      message += `\n⚠️ ${completeness}`;
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
    }, context);
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
      `批量抓取完成：${summary.total} 个目标，` +
      `成功 ${summary.ok}、为空 ${summary.empty}、失败 ${summary.failed}、` +
      `超时 ${summary.timeout}、被风控 ${summary.blocked}、链接漂移 ${summary.drifted}、` +
      `未执行 ${summary.skipped}。` +
      (resultFile
        ? `\n结果已保存为 ${resultFile.path}（${outcome.rows.length} 行，含 _target/_url 来源列，${resultFile.bytes} 字节）。` +
          (json.length > WORKSPACE_READ_PAGE_CHARS
            ? `\n本响应仅含前 ${WORKSPACE_READ_PAGE_CHARS} 字符预览——其余用 file_util(action="read", path="${resultFile.path}", index=1) 起按页续读（每页 3000 字符）。`
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
        result: json.slice(0, WORKSPACE_READ_PAGE_CHARS),
        resultType: "json-preview",
        totalChars: json.length,
        ...(json.length > WORKSPACE_READ_PAGE_CHARS
          ? { resultTruncated: true }
          : {}),
        ...(resultFile ? { resultFile } : {}),
        ...(saveError ? { saveError } : {}),
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
      void engine.kill(args, context, context).catch(() => undefined);
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

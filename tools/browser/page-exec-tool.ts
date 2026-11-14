/**
 * 统一页面执行引擎（browser_page_exec）
 *
 * 面向 AI Agent 的「最高权限」页面脚本执行通道，在当前激活标签页执行任意
 * JavaScript，并按能力分层自动选择执行引擎：
 *
 *   1. scripting + MAIN  —— chrome.scripting.executeScript 注入页面主世界，
 *      函数体本身不受页面 CSP 限制（等价 F12 控制台，可访问 window 全局对象）；
 *      但代码内部的 eval/new Function 会被严格 CSP 网站拒绝；
 *   2. CDP（chrome.debugger + Runtime.evaluate）—— 在页面主世界 V8 上下文直接
 *      求值，**完全绕过页面 CSP**（Puppeteer/Playwright page.evaluate 同款机制），
 *      是严格 CSP 站点上执行 eval 类代码的权威通道；会话由 cdp-session 统一
 *      复用并在闲置后自动脱离；
 *   3. scripting + ISOLATED —— 隔离世界兜底：仍可完整读写 DOM（选择器、抓取、
 *      填写、点击都可用），但访问不到页面 JS 全局变量。
 *
 * 引擎选择策略（strategy 参数）：
 *   - auto（默认）：先 MAIN 注入；仅当遇到 CSP 拒绝 eval 时升级到 CDP；
 *     CDP 执行失败时明确报错，不自动重放脚本；
 *   - cdp：强制走 CDP，适用于明确需要访问页面 JS 状态（如 window.__NUXT__、
 *     React Fiber 等已暴露状态）或要求无视一切 CSP 的场景；
 *   - scripting：只用 chrome.scripting，不碰调试器（不出现「正在被调试」提示条）。
 *
 * 安全性说明：动态执行用户/AI 提供的代码是本工具的核心功能（等价 F12 控制台），
 * 输入来源为 AI Agent 的工具调用参数，而非不可信页面内容。
 *
 * 数据输出契约（所有模式统一）：
 *   - 单次响应的数据正文最多 DATA_CHARS_LIMIT（2000）字符：总长 ≤2000 的结果全量返回；
 *   - 结果默认存入数据暂存区（saveResult 显式 false 时 ≤2000 的小结果跳过暂存；
 *     更长的结果无论如何都自动暂存——否则数据随 2000 字符截断丢失），
 *     响应仅保留前 2000 字符预览（result 字段，附 totalChars/resultTruncated）
 *     与 dataRef 引用（行数/字段统计），全量数据不进对话；
 *   - 暂存批次用 readRef + offset/limit 分页读取（每页 ≤2000 字符），
 *     读取模式不执行脚本、不依赖标签页——模型可按需核对任意片段。
 * 三处阈值刻意同值：模型在任何一次响应里可见的数据都有同一上界，契约不易误判。
 *
 * 超时契约（与引擎外层同源，见 tools/common/page-exec-timeout.ts）：
 *   - timeout 默认 30s、上限 300s，只约束「等待 return 结果」，不中断脚本；
 *   - 超时后最终结果被丢弃（无句柄可轮询、不进暂存区），脚本可能仍在跑；
 *     迟到输出的唯一回收通道 = 脚本先写 window 全局再发只读调用读回；
 *   - 引擎层单工具超时对本工具按 pageExecEngineTimeout 抬高，保证工具的
 *     精确超时文案先于引擎兜底到达模型。
 */

import { BaseBrowserTool } from "../base/browser-tool";
import { ToolMetadata } from "../registry";
import { OpenAITool } from "@/common/openai-types";
import { ToolResult } from "@/common/tool-handler";
import type { ToolExecutionContext } from "../registry";
import { TOOL_NAMES, isRestrictedUrl } from "@/common/constants";
import { cdpSession } from "./cdp-session";
import {
  pageConsoleEvaluate,
  runPageScript,
  type ExecStrategy,
  type ExecWorld,
  type EngineAttempt,
} from "./page-script-runner";
import {
  CONFIRM_GUIDANCE,
  CONFIRM_PARAMETER_DESCRIPTION,
} from "../confirmation-policy";
import {
  saveDataRefJson,
  getDataRef,
  listDataRefs,
  type DataRefMeta,
} from "@/utils/data-ref-store";
import { trimDanglingSurrogate } from "@/utils/text/truncate";
import {
  PAGE_EXEC_DEFAULT_TIMEOUT_MS,
  PAGE_EXEC_MAX_TIMEOUT_MS,
  normalizePageExecTimeout,
  validatePageExecTimeout,
} from "../common/page-exec-timeout";
/**
 * 数据通道统一阈值（字符）——三个用途共用同一数值：
 *   1. 单次响应可见数据正文的上限（超出即截为前缀预览）；
 *   2. 自动暂存阈值（全量 JSON 超过它即自动 saveResult，无论参数取值）；
 *   3. readRef 分页读取的单页上限与默认页大小。
 */
const DATA_CHARS_LIMIT = 2_000;
/** 全量 JSON 捕获的字符上限（防跨进程消息通道被撑爆；亦为自动暂存的物理上限） */
const MAX_CAPTURE_CHARS = 6_000_000;

/**
 * 错误对象形状关键词（中英）：命中任一即强烈提示「这是错误响应而非业务数据」。
 * 只用于提示判定，不影响脚本执行与结果封装。
 */
const HTTP_ERROR_SHAPE_KEYWORDS =
  /rate.?limit|too many requests|unauthorized|forbidden|not found|bad request|invalid|expired|quota|denied|exceed|timeout|失败|错误|超时|限流|无权限/i;

/** 错误提示中 message/error 文本的预览长度上限（字符） */
const ERROR_SHAPE_PREVIEW_CHARS = 120;

/**
 * 检测脚本返回值是否呈常见 HTTP/API 错误对象形态。
 *
 * 为什么需要：模型脚本里的 fetch 收到 4xx/5xx 时 .json() 不会抛错，错误体
 * （如 GitHub 限流的 {message:"API rate limit exceeded..."}）会被当作成功
 * 数据 return——执行层无法区分，但把可疑形态提示出来可以避免模型在错误
 * 路径上继续打转（实测案例：页内 fetch GitHub API 限流 → 空数组「成功」）。
 *
 * 刻意保守（宁可漏报不可误报）——命中需同时满足：
 *   1. 值为非数组对象，键数 ≤4（键多 = 正常业务数据概率高）；
 *   2. 含非空 message 或 error 字符串字段；且满足以下任一强信号：
 *      a) 文本命中错误关键词；b) status/code 为 4xx/5xx 数字；
 *      c) 含 documentation_url（GitHub 系错误体特征）；d) 整个对象只有这一个字段。
 *
 * @returns 提示文案（写入 payload.warnings）；不可疑返回 null。永不抛错。
 */
function detectHttpErrorShape(value: unknown): string | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0 || keys.length > 4) return null;
    const message =
      typeof record.message === "string" ? record.message.trim() : "";
    const errorText =
      typeof record.error === "string" ? record.error.trim() : "";
    if (!message && !errorText) return null;
    const statusRaw =
      typeof record.status === "number"
        ? record.status
        : typeof record.code === "number"
          ? record.code
          : NaN;
    const httpStatus =
      Number.isFinite(statusRaw) && statusRaw >= 400 && statusRaw < 600;
    const keywordHit =
      HTTP_ERROR_SHAPE_KEYWORDS.test(message) ||
      HTTP_ERROR_SHAPE_KEYWORDS.test(errorText);
    const documented = typeof record.documentation_url === "string";
    if (!(keywordHit || httpStatus || documented || keys.length === 1))
      return null;
    const preview = trimDanglingSurrogate(
      message || errorText,
      ERROR_SHAPE_PREVIEW_CHARS,
    );
    return (
      `返回值疑似错误响应（字段: ${keys.join(", ")}）："${preview}"——` +
      "脚本中的 fetch 可能收到了 4xx/5xx 而未检查 res.ok/status，请核对请求是否失败并处理，不要把错误体当业务数据使用"
    );
  } catch {
    // 检测器自身绝不允许影响工具主流程
    return null;
  }
}

interface PageExecParams {
  /**
   * 要执行的 async 函数体；用 return 返回结果，args 数组通过 $args 提供。
   * 与 readRef 互斥：分页读取暂存批次时不提供 code。
   */
  code?: string;
  /** 可选参数：提供后 code 作为函数体执行，参数经 $args 传入（code 内可直接 return） */
  args?: unknown[];
  /** 执行世界：MAIN（可访问页面全局对象）/ ISOLATED（隔离世界）/ auto（默认，优先 MAIN） */
  world?: ExecWorld;
  /** 执行策略：auto（默认，逐级升级）/ cdp（强制最高权限）/ scripting（不碰调试器） */
  strategy?: ExecStrategy;
  /** 是否等待返回的 Promise 完成（默认 true） */
  awaitPromise?: boolean;
  /** 超时时间（毫秒，默认 30000，上限 300000；见 page-exec-timeout.ts 契约） */
  timeout?: number;
  /** 目标标签页 ID（默认当前激活标签页） */
  tabId?: number;
  frameId?: number;
  /**
   * 是否把全量结果存入数据暂存区。默认 true（省略即暂存）：
   *   - true / 省略：全量结果（即使 ≤2000 字符）存入暂存区，响应携带 dataRef，
   *     便于后续 readRef 核对、merge 合并、xlsx 导出；
   *   - 显式 false：结果 ≤2000 字符时不暂存（小结果即用即弃，不占暂存区）；
   *     超过 2000 字符时仍会自动暂存（否则数据将随响应截断丢失）。
   */
  saveResult?: boolean;
  /** 暂存数据的语义标签（如「第1页-商品列表」），便于 data_ref_tool list 时辨识批次 */
  label?: string;
  /**
   * 分页读取暂存批次（与 code 互斥）：值为执行响应返回的 dataRef（8 位 ID）。
   * 提供时不执行脚本，按 offset/limit 返回全量 JSON 文本的字符切片。
   */
  readRef?: string;
  /** readRef 模式：起始字符偏移（默认 0，≥0 整数；越界收敛到末尾返回空页） */
  offset?: number;
  /** readRef 模式：本页字符数（默认 2000，上限 2000，超出自动收敛） */
  limit?: number;
  /**
   * 脚本涉及工具说明列出的资金/敏感操作时传 true，请求执行前用户审批。
   * 仅参与审批判定，不透传给页面。
   */
  confirm?: boolean;
}

/**
 * 错误提示中 message/error 文本的预览长度上限（字符）
 */
/** 判断 URL 是否为扩展无法注入脚本的受限页面（统一委托 common/constants 的单一口径） */
export function isRestrictedPageUrl(url: string | undefined): boolean {
  return isRestrictedUrl(url);
}

/**
 * 把任意值序列化为 JSON 文本（顶层 undefined 按 null 处理，与页面侧捕获口径一致）。
 * 不可序列化（循环引用等）或无 JSON 形态时返回 undefined——由调用方决定降级路径，
 * 绝不抛错。
 */
function stringifyJsonText(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value === undefined ? null : value);
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

/** 入参预览（错误信息用）：JSON 化失败时回落 String()，绝不因构造错误信息而抛错 */
function stringifyArgPreview(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string") return text;
  } catch {
    // 循环引用等：走 String() 兜底
  }
  return String(value);
}

/** 批次元数据 → 一行可读摘要（引用失效时的「现有批次」提示用；最多列 10 条防错误膨胀） */
function describeRefMeta(meta: {
  id: string;
  label?: string;
  rowCount?: number;
  bytes: number;
}): string {
  const label = meta.label ? `「${meta.label}」` : "";
  const rows =
    meta.rowCount !== undefined ? `${meta.rowCount} 行` : `${meta.bytes} 字节`;
  return `${meta.id}${label}（${rows}）`;
}

/**
 * 暂存成功后的引导文案：把「预览 → 分页核对 → 合并 → 导出」的后续通道
 * 一次说清，模型无需再猜字段该怎么用。
 */
function buildDataRefGuide(
  meta: { id: string; rowCount?: number },
  totalChars: number,
): string {
  const rows = meta.rowCount !== undefined ? `${meta.rowCount} 行、` : "";
  const shown = Math.min(totalChars, DATA_CHARS_LIMIT);
  return (
    `全量数据（${rows}${totalChars} 字符）已存入数据暂存区，引用 ID ${meta.id}（浏览器会话内有效、约 12 小时）；本响应 result 只是前 ${shown} 字符预览。` +
    `后续：data_ref_tool(action="info", ref=${meta.id}) 查看字段结构；` +
    `browser_page_exec(readRef=${meta.id}, offset=${DATA_CHARS_LIMIT}, limit=${DATA_CHARS_LIMIT}) 分页读取任意片段（每页 ≤${DATA_CHARS_LIMIT} 字符，用响应的 nextOffset 续读）；` +
    `xlsx_tool(action="create_from_data", sheets[].dataRef=${meta.id}) 直接生成 Excel；` +
    `多页批次先 data_ref_tool(action="merge") 合并（滚动增量出现重复行时先 action="dedupe" 去重）。切勿在对话中抄写数据行。`
  );
}

/**

/**
 * 脚本执行内核的产出（不携带任何持久化策略）：
 * 两条消费方各自决定结果去向——browser_page_exec 落数据暂存区（dataRef），
 * js_run 落会话工作区结果文件（results/）。fullJson 已按通道口径统一捕获。
 */
export type PageExecOutcome =
  | {
      ok: true;
      tabId: number;
      frameId: number;
      url: string | undefined;
      engine?: "scripting" | "cdp";
      world?: "MAIN" | "ISOLATED";
      /** 脚本返回值（净化后） */
      value: unknown;
      type: string | undefined;
      durationMs: number;
      outcome: "completed" | "dispatched";
      attempts: EngineAttempt[];
      /** 全量 JSON 文本（scripting=页面侧捕获；CDP=本地序列化；捕获失败为 undefined） */
      fullJson?: string;
      /** fullJson 缺失原因（捕获失败/无 JSON 形态/超限） */
      captureNote?: string;
      /** 返回值疑似 HTTP 错误对象的提示（仅提示，不改数据） */
      errorShapeHint: string | null;
    }
  | { ok: false; error: string };

/**
 * 统一页面执行引擎工具
 */
export class PageExecTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.PAGE_EXEC;

  /**
   * 本次求值的目标标签页（kill 钩子据此终止页面里的脚本）。
   * 工具实例在扩展内共享，故按「最近一次执行」记账：引擎的强制串行保证同一
   * 时刻至多有一次 page_exec 在跑，这个记账因此不会张冠李戴。
   */
  private activeTabId: number | null = null;
  /** 本次求值实际使用的通道（决定 kill 能否真正终止脚本） */
  private activeEngine: "scripting" | "cdp" | null = null;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.PAGE_EXEC,
    description:
      "高权限页面脚本执行引擎：在当前页面执行任意 JavaScript，自动在受限 CSP 站点升级到 CDP 通道；" +
      "timeout 默认 30s/上限 300s（只等结果不中断脚本，超时后结果丢弃、脚本可能仍在跑）；" +
      "结果默认存入数据暂存区（saveResult=false 可让 ≤2000 字符的小结果跳过暂存），" +
      "超 2000 字符只回传预览并附 dataRef 引用，支持 readRef 分页读取",
    category: "browser",
    version: "1.3.0",
    author: "AgentNexus",
    tags: ["browser", "script", "exec", "rpa", "cdp", "chrome"],
    displayName: "页面执行引擎",
    permissions: ["scripting", "debugger"],
    // 参数语义级人审门：本工具可执行任意 JS，脚本含资金/敏感操作时由模型
    // 显式 confirm=true 触发用户批准（code 不参与关键词扫描——抓取脚本里
    // 出现「提交/删除」等词属正常代码，扫描会大量误伤）
    requiresConfirm: true,
  };

  openaiSchema: OpenAITool = {
    type: "function",
    function: {
      name: TOOL_NAMES.BROWSER.PAGE_EXEC,
      description:
        "在指定页面/frame 执行 async JavaScript 函数体，用 return 返回精简对象或所需字段，不必 JSON.stringify。" +
        "自动分层执行：普通代码走页面主世界注入；遇到严格 CSP 拒绝 eval 时自动升级 CDP 通道（无视页面 CSP）；" +
        "只有用户代码尚未执行的权限探测失败才切换引擎；代码开始后不自动重放。CDP 失败明确报错。" +
        "适用：普通观察不足时读取结构化数据/组件状态，或专用工具无法完成的必要操作；常规点击/填写优先 browser_interact。合并独立只读检查，写操作逐次执行并核对业务回执，不用长循环反复滚动/点击/提交。" +
        '默认 auto 通常足够；只有确需调试器通道时才指定 strategy="cdp"。读取 DOM 可按需使用 world="ISOLATED"，不能假定隔离世界能读页面全局变量。' +
        // 超时与执行语义（模型必须知道的四条）：
        //   1. timeout 只管「等结果」，默认/上限由 page-exec-timeout.ts 契约渲染；
        //   2. 超时 ≠ 脚本停止——脚本可能仍在页面运行且本响应拿不到它的最终输出；
        //   3. 超时后唯一回收通道是脚本自己写页面全局（window）再发一次只读调用读取；
        //   4. 禁止盲目重放——先只读探针核对现状。
        `超时（必须理解）：timeout 默认 ${PAGE_EXEC_DEFAULT_TIMEOUT_MS}ms、上限 ${PAGE_EXEC_MAX_TIMEOUT_MS}ms，` +
        "只约束「等待 return 结果」的时间，不中断脚本执行。" +
        "超时返回的报错是「执行超时；代码可能仍在运行，先检查现状，不自动重试」——" +
        "此时最终结果已被丢弃（没有可轮询的句柄、不会进暂存区），要拿迟到的输出，" +
        "唯一办法是脚本设计时先把结果写入页面全局变量（如 window.__result__），" +
        "超时后再调一次本工具以只读方式读回它。" +
        "超时或不确定是否完成时，先发只读探针核对现状（读 window 全局/DOM），禁止直接重放写操作——" +
        "重放可能造成重复提交等副作用。同步死循环会让页面主线程卡住，只能等引擎层兜底超时。" +
        "数据输出契约：单次响应的数据正文最多 2000 字符——结果默认（saveResult 省略或 true）存入数据暂存区并携带 dataRef 引用，" +
        "≤2000 字符时 result 同步全量返回，超长时只保留前 2000 字符预览（附 totalChars/resultTruncated 与行数/字段统计）；" +
        "saveResult=false 仅当结果 ≤2000 字符时跳过暂存（超长结果仍会自动暂存，否则数据随截断丢失）。" +
        "要查看暂存数据的其它片段：传 readRef=引用ID（此时不要传 code），用 offset/limit 分页读取，每页最多 2000 字符。" +
        '批量抓取脚本 return 对象数组 [{...},{...}] 最佳（可直接 xlsx 导出），配 label 标注批次；多页批次先 data_ref_tool(action="merge") 合并再导出。' +
        "执行语义：同一页面的多次调用共享同一全局作用域（像同一个控制台连续敲命令，window/DOM 状态跨调用保留），" +
        "但每次调用的函数作用域相互独立、绝不并行发起；上一次超时残留的异步任务可能与新调用交错，跨调用传参用 $args 而非依赖残留全局。" +
        CONFIRM_GUIDANCE,
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "要执行的 JavaScript 代码（与 readRef 互斥）。代码统一为 async 函数体，必须用 return 返回结果，允许 await；" +
              "不会因运行时错误或无结果自动重放；可用 $args 读取 args 参数数组。",
          },
          args: {
            type: "array",
            description:
              "可选参数数组，通过 async 函数体内的 $args 读取；默认空数组。",
            items: {},
          },
          world: {
            type: "string",
            enum: ["auto", "MAIN", "ISOLATED"],
            description:
              "执行世界。MAIN=页面主世界（可访问 window 全局对象）；ISOLATED=隔离世界（DOM 可用、页面 JS 不可见）；auto=默认优先 MAIN",
            default: "auto",
          },
          strategy: {
            type: "string",
            enum: ["auto", "cdp", "scripting"],
            description:
              "执行策略。auto=默认逐级升级；cdp=强制最高权限（无视 CSP，可访问页面 JS 状态，会短暂附加调试器）；scripting=只用注入通道不碰调试器",
            default: "auto",
          },
          awaitPromise: {
            type: "boolean",
            description: "是否等待返回的 Promise 完成（默认 true）",
            default: true,
          },
          timeout: {
            type: "number",
            description:
              `超时时间（毫秒），默认 ${PAGE_EXEC_DEFAULT_TIMEOUT_MS}，上限 ${PAGE_EXEC_MAX_TIMEOUT_MS}；` +
              "只限制「等待返回结果」的时长，超时后脚本可能仍在页面里继续运行",
            default: PAGE_EXEC_DEFAULT_TIMEOUT_MS,
          },
          frameId: {
            type: "number",
            description:
              "Chrome FrameId，默认0；指定子 frame 只在该 frame 执行，不会静默回退主页面。严格 CSP 子 frame 请使用 ISOLATED 读 DOM。",
          },
          tabId: {
            type: "number",
            description: "目标标签页 ID（可选，默认当前激活标签页）",
          },
          saveResult: {
            type: "boolean",
            description:
              "默认 true：全量结果存入数据暂存区并返回 dataRef（引用 ID，浏览器会话内约 12 小时有效），" +
              '便于后续 readRef 分页核对、data_ref_tool(info/merge) 管理与 xlsx_tool(action="create_from_data", sheets[].dataRef=该ID) 直接导出；' +
              "显式 false 仅当结果 ≤2000 字符时跳过暂存（超长结果仍自动暂存防丢失）。批量抓取保持默认即可。",
            default: true,
          },
          label: {
            type: "string",
            description:
              '暂存数据的语义标签（如「第1页-商品列表」），便于 data_ref_tool(action="list") 时辨识批次（自动暂存时同样生效）',
          },
          readRef: {
            type: "string",
            description:
              "分页读取暂存批次（与 code 互斥：提供 readRef 时不执行脚本、不依赖标签页）。" +
              "值为本工具执行响应返回的 dataRef（8 位 ID）。" +
              "返回该批次全量 JSON 文本的字符切片 content，配合 offset（起始偏移）与 limit（本页字符数，≤2000）使用；" +
              "响应含 totalChars/hasMore/nextOffset，把 nextOffset 作为下一次的 offset 即可续读",
          },
          offset: {
            type: "number",
            description:
              "readRef 模式的起始字符偏移（默认 0，≥0 整数；越界自动收敛到末尾并返回空页，不报错）",
            default: 0,
          },
          limit: {
            type: "number",
            description: `readRef 模式本页最多读取的字符数（默认 ${DATA_CHARS_LIMIT}，上限 ${DATA_CHARS_LIMIT}，超出自动按上限处理）`,
            default: DATA_CHARS_LIMIT,
          },
          confirm: {
            type: "boolean",
            description: CONFIRM_PARAMETER_DESCRIPTION,
            default: false,
          },
        },
        // code 与 readRef 二选一（readRef 分页读取模式不执行脚本）：
        // 只能都不列为必填、由执行层做互斥与存在性校验——否则 readRef 调用
        // 会在部分供应商的 schema 校验处直接被拒，错误信息也无法由本工具定制
        required: [],
      },
    },
  };

  async execute(
    args: PageExecParams,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    this.ensureBackgroundContext();

    // 参数整体可能为 null/undefined（executeTool 对缺失参数直接透传）——归一后解构，
    // 让「缺少 code」走到下方精确校验，而不是在解构处抛 TypeError
    const {
      code,
      args: codeArgs,
      world = "auto",
      strategy = "auto",
      awaitPromise = true,
      timeout = PAGE_EXEC_DEFAULT_TIMEOUT_MS,
      tabId: requestedTabId,
      frameId = 0,
      saveResult: rawSaveResult,
      label,
      readRef,
      offset,
      limit,
    } = args || ({} as PageExecParams);
    if (rawSaveResult !== undefined && typeof rawSaveResult !== "boolean") {
      return this.createErrorResponse(
        `saveResult 必须是布尔值，实际收到 ${stringifyArgPreview(rawSaveResult)}`,
      );
    }
    // 默认 true 的语义经 rawSaveResult 直接表达（wantsStore 判定见暂存段）；
    // 显式 false 是唯一「小结果不暂存」的途径；超长结果无论如何都会自动暂存。

    // ── 模式分诊：readRef 分页读取（不执行脚本、不依赖标签页） vs code 脚本执行 ──
    // 先做 readRef 类型防御：非字符串若落到「缺 code」分支会给出误导性错误
    if (
      readRef !== undefined &&
      readRef !== null &&
      typeof readRef !== "string"
    ) {
      return this.createErrorResponse(
        `readRef 必须是字符串（暂存批次 ID），实际收到 ${Array.isArray(readRef) ? "array" : typeof readRef}`,
      );
    }
    const refId = typeof readRef === "string" ? readRef.trim() : "";
    const hasOffset = offset !== undefined && offset !== null;
    const hasLimit = limit !== undefined && limit !== null;
    if (refId) {
      if (typeof code === "string" && code.trim()) {
        return this.createErrorResponse(
          "readRef 与 code 互斥：分页读取暂存批次时不要同时提供 code（readRef 模式不会执行脚本）",
        );
      }
      return this.handleRead(refId, offset, limit);
    }
    // 执行模式下携带 offset/limit（测试面板会预填目录默认值、模型也可能回填
    // schema 默认值）：静默忽略而非报错——执行语义下这两个参数没有对应物，
    // 阻断正常执行得不偿失；仅留日志便于排查参数误用
    if (hasOffset || hasLimit) {
      this.log(
        "offset/limit provided without readRef in exec mode, ignored",
        "warn",
      );
    }
    if (!code || typeof code !== "string" || !code.trim()) {
      return this.createErrorResponse(
        "Parameter [code] is required and must be a non-empty string（或提供 readRef 分页读取暂存批次）",
      );
    }

    const outcome = await this.executeScript(
      {
        code,
        args: codeArgs,
        world,
        strategy,
        awaitPromise,
        timeout,
        tabId: requestedTabId,
        frameId,
      },
      context,
    );
    if (!outcome.ok) return this.createErrorResponse(outcome.error);

    try {
      // ── 1. 暂存判定：saveResult 默认开启；显式 false 仅当全量 ≤ 阈值时跳过，
      //       超长结果无论参数如何都强制暂存（否则数据随 2000 字符截断丢失）。
      //       wantsStore（意图）与 shouldStore（可执行）分离：显式/默认要暂存
      //       但捕获失败时，意图仍在——告警必须照发，不能静默吞掉。 ──
      const overLimit =
        outcome.fullJson !== undefined &&
        outcome.fullJson.length > DATA_CHARS_LIMIT;
      const wantsStore = rawSaveResult !== false || overLimit;
      const shouldStore = wantsStore && outcome.fullJson !== undefined;
      let storedMeta: DataRefMeta | undefined;
      let storeNote: string | undefined;
      if (shouldStore && outcome.fullJson !== undefined) {
        const saved = await saveDataRefJson(outcome.fullJson, label);
        if (saved.ok) storedMeta = saved.meta;
        else storeNote = saved.reason;
      }

      // ── 2. 结果封装：数据正文恒不超过 DATA_CHARS_LIMIT 字符 ──
      const payload: Record<string, unknown> = {
        tabId: outcome.tabId,
        frameId: outcome.frameId,
        url: outcome.url,
        engine: outcome.engine,
        world: outcome.world,
        result: outcome.value,
        resultType: outcome.type ?? typeof outcome.value,
        durationMs: outcome.durationMs,
        outcome: outcome.outcome,
        attempts: outcome.attempts,
      };

      if (storedMeta && outcome.fullJson !== undefined) {
        // 已暂存：正文 = 全量 JSON 的前缀（不足 DATA_CHARS_LIMIT 则全部封装）
        const totalChars = outcome.fullJson.length;
        payload.result = outcome.fullJson.slice(0, DATA_CHARS_LIMIT);
        payload.resultType = "json-preview";
        payload.totalChars = totalChars;
        if (totalChars > DATA_CHARS_LIMIT) payload.resultTruncated = true;
        payload.dataRef = storedMeta;
        // 三态：explicit=显式 true；default=省略（默认开启）；auto=显式 false 但超限强制
        payload.dataRefTrigger =
          rawSaveResult === true
            ? "explicit"
            : rawSaveResult === false
              ? "auto"
              : "default";
        payload.dataRefGuide = buildDataRefGuide(storedMeta, totalChars);
      } else {
        // 未暂存：净化结构化值直接返回；序列化后仍超限时降级为 JSON 文本前缀——
        // 覆盖「捕获失败的超大返回值」与「暂存失败但全量在手」两种情形，
        // 保证任何路径下输出的 data 正文都有界
        const structuredText = stringifyJsonText(outcome.value);
        const source = outcome.fullJson ?? structuredText;
        if (
          structuredText !== undefined &&
          structuredText.length > DATA_CHARS_LIMIT &&
          source !== undefined
        ) {
          payload.result = source.slice(0, DATA_CHARS_LIMIT);
          payload.resultType = "json-preview";
          payload.totalChars = source.length;
          if (source.length > DATA_CHARS_LIMIT) payload.resultTruncated = true;
        }
      }

      // ── 3. 暂存失败必须让模型感知 ──
      const warnings: string[] = [];
      if (!storedMeta && wantsStore) {
        // 显式要求暂存、或已判定超长却没存上（容量/序列化/捕获失败）
        warnings.push(
          `数据暂存失败：${storeNote ?? outcome.captureNote ?? "未知原因"}`,
        );
      } else if (
        !storedMeta &&
        outcome.captureNote &&
        payload.resultTruncated === true
      ) {
        // 未显式要求暂存，但捕获失败且可见输出已触顶：数据大概率超限且无法自动暂存
        warnings.push(`无法自动暂存数据：${outcome.captureNote}`);
      }
      if (outcome.errorShapeHint) warnings.push(outcome.errorShapeHint);
      if (warnings.length > 0) payload.warnings = warnings;

      const message =
        storedMeta && outcome.fullJson !== undefined
          ? `Script executed via ${outcome.engine} (${outcome.world} world); 全量 ${outcome.fullJson.length} 字符已暂存为 ${storedMeta.id}（响应含前 ${Math.min(outcome.fullJson.length, DATA_CHARS_LIMIT)} 字符预览）`
          : `Script executed via ${outcome.engine} (${outcome.world} world)`;
      return this.createSuccessResponse(payload, message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.createErrorResponse(`Script execution failed: ${message}`);
    }
  }

  /**
   * 执行内核：参数校验 → 标签页解析 → runPageScript → 全量 JSON 捕获。
   * 不做任何结果持久化（暂存区/结果文件由调用方决定），失败以 {ok:false}
   * 返回而非抛出；kill 记账（activeTabId/activeEngine）随执行生命周期维护。
   */
  async executeScript(
    args: {
      code: string;
      args?: unknown[];
      world?: ExecWorld;
      strategy?: ExecStrategy;
      awaitPromise?: boolean;
      timeout?: number;
      tabId?: number;
      frameId?: number;
    },
    context?: ToolExecutionContext,
  ): Promise<PageExecOutcome> {
    const {
      code,
      args: codeArgs,
      world = "auto",
      strategy = "auto",
      awaitPromise = true,
      timeout = PAGE_EXEC_DEFAULT_TIMEOUT_MS,
      tabId: requestedTabId,
      frameId = 0,
    } = args;

    if (
      !["auto", "MAIN", "ISOLATED"].includes(world) ||
      !["auto", "cdp", "scripting"].includes(strategy) ||
      typeof awaitPromise !== "boolean"
    )
      return { ok: false, error: "world/strategy/awaitPromise 参数无效" };
    const timeoutError = validatePageExecTimeout(timeout);
    if (timeoutError) return { ok: false, error: timeoutError };
    const timeoutMs = normalizePageExecTimeout(timeout);

    try {
      // 解析目标标签页：优先显式 tabId，否则当前激活标签页
      // （tabId 允许为 0——用真值判断会把合法的 0 当成「未提供」，故显式判空）
      if (
        requestedTabId !== undefined &&
        requestedTabId !== null &&
        (!Number.isInteger(requestedTabId) || requestedTabId < 0)
      ) {
        return {
          ok: false,
          error: `Parameter [tabId] must be a non-negative integer, received: ${String(requestedTabId)}`,
        };
      }
      const tab =
        requestedTabId !== undefined && requestedTabId !== null
          ? await chrome.tabs.get(requestedTabId)
          : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab || typeof tab.id !== "number") {
        return { ok: false, error: "No active tab found" };
      }
      const tabId = tab.id;
      // 记账本次求值的目标（kill 钩子据此终止页面里的脚本）
      this.activeTabId = tabId;
      this.activeEngine = null;

      // 受限页面（chrome:// 等）无法注入/调试，提前给出可操作的提示
      if (isRestrictedPageUrl(tab.url)) {
        return {
          ok: false,
          error:
            `Current page is a restricted URL (${tab.url}) where script execution is not permitted. ` +
            `Navigate to a normal web page first (e.g. call check_restricted_url).`,
        };
      }

      if (!Number.isSafeInteger(frameId) || frameId < 0)
        return { ok: false, error: "frameId 必须为非负整数" };
      if (requestedTabId != null) context?.onTabTarget?.(tabId);
      const startedAt = Date.now();
      const attempts: EngineAttempt[] = [];

      const run = await runPageScript({
        tabId,
        frameId,
        code,
        args: codeArgs,
        world,
        strategy,
        awaitPromise,
        timeoutMs,
        captureLimit: MAX_CAPTURE_CHARS,
        attempts,
        // 通道切换记账：kill 钩子据此决定能否真正终止（CDP 可终止，注入不可）
        onEngineChange: (engine) => {
          this.activeEngine = engine;
        },
      });

      const durationMs = Date.now() - startedAt;

      if (!run.ok) {
        return {
          ok: false,
          error: `Script execution failed on all engines: ${run.error}`,
        };
      }

      // ── 全量 JSON 捕获 ──
      // scripting 通道：页面侧已捕获未净化的全量 JSON（页面→background 通道有 6M 字符上限）；
      // CDP 通道：值已完整回到 background，在此序列化并施加同一上限，两条通道口径一致
      let fullJson: string | undefined;
      let captureNote: string | undefined;
      if (run.engine === "scripting") {
        if (typeof run.rawJson === "string") {
          fullJson = run.rawJson;
        } else {
          captureNote = run.rawJsonError ?? "全量数据捕获失败（未知原因）";
        }
      } else {
        const text = stringifyJsonText(run.value);
        if (text === undefined) {
          captureNote = "返回值没有可用的 JSON 形态";
        } else if (text.length > MAX_CAPTURE_CHARS) {
          captureNote = `数据量 ${text.length} 字符超过单次捕获上限 ${MAX_CAPTURE_CHARS}——请在脚本内先筛选字段或限制条数后分批保存`;
        } else {
          fullJson = text;
        }
      }

      return {
        ok: true,
        tabId,
        frameId,
        url: tab.url,
        engine: run.engine,
        world: run.world,
        value: run.value,
        type: run.type,
        durationMs,
        outcome: awaitPromise ? "completed" : "dispatched",
        attempts,
        ...(fullJson !== undefined ? { fullJson } : {}),
        ...(captureNote !== undefined ? { captureNote } : {}),
        errorShapeHint: detectHttpErrorShape(run.value),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // debugger 附加失败等同步错误直接透出原因，便于模型切换策略重试
      return { ok: false, error: `Script execution failed: ${message}` };
    } finally {
      // 清除求值记账：脚本已结束（或从未开始），此后不应再有 kill 请求打到
      // 这个标签页——否则一次过期中断会误杀页面上的无关脚本
      this.activeTabId = null;
      this.activeEngine = null;
    }
  }

  /**
   * 强制终止正在页面里运行的求值脚本（用户中断 / 单工具超时后由引擎调用）。
   *
   * 两条通道的能力差异（这是本工具的硬约束，必须如实告知调用方）：
   *   - **CDP 通道**：可真正终止。Runtime.terminateExecution 打断目标页当前
   *     正在执行的 JS，连同步死循环也杀得掉（注入通道对此无能为力）。
   *   - **注入通道**（chrome.scripting）：**无法从扩展侧终止**——脚本已在页面
   *     的同一个线程上跑起来，扩展没有「叫停页面 JS」的 API。此时只能放弃
   *     等待：引擎层面已结算为「中断」，页面脚本的残留副作用由模型按工具
   *     说明里的「先只读探针核对现状、禁止盲目重放」自行处理。
   *
   * 幂等：重复调用安全；目标已关闭 / 无调试会话 / 无正在执行的脚本时，
   * 全部按「已尽力终止」处理，不抛错。
   */
  async kill(_args: unknown, _context?: ToolExecutionContext): Promise<void> {
    const tabId = this.activeTabId;
    const engine = this.activeEngine;
    if (tabId === null || engine !== "cdp") return;
    await cdpSession.terminateExecution(tabId);
  }

  /**
   * readRef 分页读取：按字符偏移读取暂存批次的全量 JSON 文本切片。
   *
   * 设计要点：
   *   - 不执行脚本、不查标签页——数据在暂存区，读取与页面状态无关；
   *   - offset 越界不报错而是收敛到末尾返回空页：让模型的「续读到 hasMore=false」
   *     循环自然终止，不会因一次越界整轮失败；
   *   - limit 超上限收敛而非拒绝：越界值是良性误用，收敛 + 说明比报错少一轮往返；
   *   - 引用失效（过期/淘汰/清空）给出当前可用批次清单，模型可自助恢复。
   */
  private async handleRead(
    refId: string,
    rawOffset: unknown,
    rawLimit: unknown,
  ): Promise<ToolResult> {
    const notes: string[] = [];

    // offset：缺省 0；须为 ≥0 的有限数（数字字符串宽容接受，布尔/对象拒绝），非整数向下取整
    let offset = 0;
    if (rawOffset !== undefined && rawOffset !== null) {
      const parsed =
        typeof rawOffset === "number"
          ? rawOffset
          : typeof rawOffset === "string" && rawOffset.trim() !== ""
            ? Number(rawOffset)
            : NaN;
      if (!Number.isFinite(parsed) || parsed < 0) {
        return this.createErrorResponse(
          `offset 必须是 ≥0 的数字（字符偏移），实际收到 ${stringifyArgPreview(rawOffset)}`,
        );
      }
      offset = Math.floor(parsed);
    }

    // limit：缺省/上限 DATA_CHARS_LIMIT；非法（非数或 ≤0）拒绝，超上限收敛并说明
    let limit = DATA_CHARS_LIMIT;
    if (rawLimit !== undefined && rawLimit !== null) {
      const parsed =
        typeof rawLimit === "number"
          ? rawLimit
          : typeof rawLimit === "string" && rawLimit.trim() !== ""
            ? Number(rawLimit)
            : NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return this.createErrorResponse(
          `limit 必须是 1..${DATA_CHARS_LIMIT} 的数字（本页字符数），实际收到 ${stringifyArgPreview(rawLimit)}`,
        );
      }
      limit = Math.floor(parsed);
      if (limit < 1) limit = 1; // 0<x<1 向下取整为 0 后兜底为 1（parsed>0 已保证存在小数可能）
      if (limit > DATA_CHARS_LIMIT) {
        notes.push(
          `limit=${limit} 超出单页上限，已按 ${DATA_CHARS_LIMIT} 处理`,
        );
        limit = DATA_CHARS_LIMIT;
      }
    }

    const entry = await getDataRef(refId);
    if (!entry) {
      const existing = await listDataRefs();
      const hint =
        existing.length > 0
          ? `当前可用批次（最多列出 10 个）：\n${existing.slice(0, 10).map(describeRefMeta).join("\n")}`
          : "暂存区为空（数据可能已随浏览器会话过期，请重新抓取）。";
      return this.createErrorResponse(
        `readRef "${refId}" 不存在或已过期。${hint}`,
      );
    }

    const totalChars = entry.json.length;
    const start = Math.min(offset, totalChars);
    if (offset > totalChars) {
      notes.push(
        `offset=${offset} 超出数据末尾（共 ${totalChars} 字符），已收敛到末尾返回空页`,
      );
    }
    const content = entry.json.slice(start, start + limit);
    const end = start + content.length;
    const hasMore = end < totalChars;

    const payload = {
      ref: entry.id,
      offset: start,
      limit,
      totalChars,
      content,
      hasMore,
      nextOffset: end,
      meta: {
        ...(entry.label ? { label: entry.label } : {}),
        kind: entry.kind,
        ...(entry.rowCount !== undefined ? { rowCount: entry.rowCount } : {}),
        ...(entry.cols !== undefined ? { cols: entry.cols } : {}),
        bytes: entry.bytes,
      },
      ...(notes.length > 0 ? { note: notes.join("；") } : {}),
    };

    const message =
      `已读取 ${entry.id}${entry.label ? `「${entry.label}」` : ""} 的 [${start}, ${end}) 字符区间` +
      `（共 ${totalChars} 字符，${hasMore ? `还剩 ${totalChars - end} 字符，用 nextOffset 续读` : "已到末尾"}）`;
    return this.createSuccessResponse(payload, message);
  }
}

// 导出工具实例与页面求值函数（script.ts 的兼容工具复用同一实现）
export const pageExecTool = new PageExecTool();
export { pageConsoleEvaluate };

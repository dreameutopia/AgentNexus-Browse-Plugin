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
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES, isRestrictedUrl } from '@/common/constants';
import { cdpSession } from './cdp-session';
import { CONFIRM_GUIDANCE, CONFIRM_PARAMETER_DESCRIPTION } from '../confirmation-policy';
import {
  saveDataRefJson,
  getDataRef,
  listDataRefs,
  type DataRefMeta,
} from '@/utils/data-ref-store';
import { trimDanglingSurrogate } from '@/utils/text/truncate';

/** 页面内求值默认超时 */
const DEFAULT_EVAL_TIMEOUT_MS = 15_000;
/** 超时上限，避免工具调用长期挂起 */
const MAX_EVAL_TIMEOUT_MS = 120_000;
/**
 * 数据通道统一阈值（字符）——三个用途共用同一数值：
 *   1. 单次响应可见数据正文的上限（超出即截为前缀预览）；
 *   2. 自动暂存阈值（全量 JSON 超过它即自动 saveResult，无论参数取值）；
 *   3. readRef 分页读取的单页上限与默认页大小。
 */
const DATA_CHARS_LIMIT = 2_000;
/** 全量 JSON 捕获的字符上限（防跨进程消息通道被撑爆；亦为自动暂存的物理上限） */
const MAX_CAPTURE_CHARS = 6_000_000;

/** 执行策略 */
type ExecStrategy = 'auto' | 'scripting' | 'cdp';
/** 执行世界（auto = 优先 MAIN，失败后按策略回退） */
type ExecWorld = 'MAIN' | 'ISOLATED' | 'auto';

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
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0 || keys.length > 4) return null;
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    const errorText = typeof record.error === 'string' ? record.error.trim() : '';
    if (!message && !errorText) return null;
    const statusRaw = typeof record.status === 'number' ? record.status : typeof record.code === 'number' ? record.code : NaN;
    const httpStatus = Number.isFinite(statusRaw) && statusRaw >= 400 && statusRaw < 600;
    const keywordHit =
      HTTP_ERROR_SHAPE_KEYWORDS.test(message) || HTTP_ERROR_SHAPE_KEYWORDS.test(errorText);
    const documented = typeof record.documentation_url === 'string';
    if (!(keywordHit || httpStatus || documented || keys.length === 1)) return null;
    const preview = trimDanglingSurrogate(message || errorText, ERROR_SHAPE_PREVIEW_CHARS);
    return (
      `返回值疑似错误响应（字段: ${keys.join(', ')}）："${preview}"——` +
      '脚本中的 fetch 可能收到了 4xx/5xx 而未检查 res.ok/status，请核对请求是否失败并处理，不要把错误体当业务数据使用'
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
  /** 超时时间（毫秒，默认 15000，上限 120000） */
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

/** 单次引擎尝试的记录（可观测性：让模型了解降级原因） */
interface EngineAttempt {
  engine: 'scripting' | 'cdp';
  world: 'MAIN' | 'ISOLATED';
  ok: boolean;
  note?: string;
}

/** 页面内求值函数的返回形态 */
interface InPageEvalResult {
  success: boolean;
  safeFallback?: boolean;
  value?: unknown;
  type?: string;
  error?: string;
  stack?: string;
  /** 全量 JSON 文本（未经截断净化，供暂存判定与暂存区落盘；捕获恒开） */
  rawJson?: string;
  /** 全量捕获失败的原因（序列化失败/超上限），不阻断正常返回 */
  rawJsonError?: string;
}

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
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/** 入参预览（错误信息用）：JSON 化失败时回落 String()，绝不因构造错误信息而抛错 */
function stringifyArgPreview(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (typeof text === 'string') return text;
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
  const label = meta.label ? `「${meta.label}」` : '';
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
  totalChars: number
): string {
  const rows = meta.rowCount !== undefined ? `${meta.rowCount} 行、` : '';
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
 * 页面主世界内的求值函数（必须完全自包含：会作为参数被序列化进页面执行）
 *
 * 执行已构建的 async 函数表达式：
 * 1. 间接 eval 在页面全局作用域执行，保留表达式完成值；
 * 2. 返回 Promise 时等待 settle（带超时保护）；
 * 3. 返回值递归净化为可结构化克隆的安全形态（DOM 节点、函数、循环引用、
 *    超长字符串/数组均有界转换），保证跨进程回传不丢信息也不撑爆消息通道。
 */
async function pageConsoleEvaluate(
  codeStr: string,
  timeoutMs: number,
  awaitPromise: boolean,
  captureJson: boolean,
  captureLimit: number
): Promise<InPageEvalResult> {
  /** 单个字符串的最大回传长度 */
  const MAX_STRING_LEN = 10_000;
  /** 数组最大回传元素数 */
  const MAX_ARRAY_LEN = 200;
  /** 对象最大回传键数 */
  const MAX_KEYS = 100;
  /** 递归净化最大深度 */
  const MAX_DEPTH = 6;

  /** 递归净化任意返回值为可结构化克隆的安全形态 */
  const sanitize = (
    input: unknown,
    depth: number,
    seen: Set<unknown>
  ): unknown => {
    if (input === null) return null;
    const t = typeof input;
    if (t === 'number' || t === 'boolean') return input;
    if (t === 'undefined') return 'undefined';
    if (t === 'string') {
      const str = input as string;
      return str.length > MAX_STRING_LEN
        ? `${str.slice(0, MAX_STRING_LEN)}…[truncated ${str.length - MAX_STRING_LEN} chars]`
        : str;
    }
    if (t === 'bigint' || t === 'symbol' || t === 'function')
      return String(input);
    if (t !== 'object') return String(input);
    if (depth >= MAX_DEPTH) return '[MaxDepth]';

    const obj = input as object;
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);

    try {
      if (typeof Element !== 'undefined' && obj instanceof Element) {
        const id = obj.id ? ` id="${obj.id}"` : '';
        const cls =
          typeof obj.className === 'string' && obj.className
            ? ` class="${obj.className}"`
            : '';
        return `<${obj.tagName.toLowerCase()}${id}${cls}>`;
      }
      if (
        typeof NodeList !== 'undefined' &&
        (obj instanceof NodeList ||
          (typeof HTMLCollection !== 'undefined' &&
            obj instanceof HTMLCollection))
      ) {
        return `[${(obj as NodeList).length} element(s)]`;
      }
      if (obj instanceof Error) {
        return `${obj.name}: ${obj.message}`;
      }
      if (Array.isArray(obj)) {
        const items = obj
          .slice(0, MAX_ARRAY_LEN)
          .map((item) => sanitize(item, depth + 1, seen));
        if (obj.length > MAX_ARRAY_LEN) {
          items.push(`…[${obj.length - MAX_ARRAY_LEN} more items]`);
        }
        return items;
      }
      // 普通对象：遍历自有可枚举键
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const key of Object.keys(obj)) {
        if (count >= MAX_KEYS) {
          out['…'] = `[${Object.keys(obj).length - MAX_KEYS} more keys]`;
          break;
        }
        try {
          out[key] = sanitize(
            (obj as Record<string, unknown>)[key],
            depth + 1,
            seen
          );
        } catch {
          out[key] = '[unreadable]';
        }
        count++;
      }
      return out;
    } catch {
      return '[unserializable]';
    } finally {
      seen.delete(obj);
    }
  };

  // Probe compilation permission before any user code runs. A CSP error thrown
  // by the user's code itself must never trigger replay in another engine.
  try {
    (0, eval)('void 0');
  } catch (error) {
    return {
      success: false,
      safeFallback: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    // 间接 eval：在指定执行上下文运行已构建的函数表达式
    const raw: unknown = (0, eval)(codeStr);

    let value = raw;
    if (awaitPromise) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        value = await Promise.race([
          Promise.resolve(raw),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    '执行超时；代码可能仍在运行，先检查现状，不自动重试'
                  )
                ),
              timeoutMs
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // 全量 JSON 捕获（captureJson 恒为 true）：在页面侧对「未净化的原始值」做
    // 一次全量 JSON 序列化——自动暂存判定、2000 字符预览截取都依赖数据真实长度。
    // 净化值（value）仍有 200 元素/10k 字符等回传上限，只适合当结构化预览；
    // 全量数据必须在页面侧序列化后单独带回，才不会在跨进程通道上被截断。
    let rawJson: string | undefined;
    let rawJsonError: string | undefined;
    if (captureJson) {
      try {
        const text = JSON.stringify(value === undefined ? null : value);
        if (typeof text !== 'string') {
          rawJsonError = '返回值没有可用的 JSON 形态';
        } else if (text.length > captureLimit) {
          rawJsonError = `数据量 ${text.length} 字符超过单次暂存上限 ${captureLimit}——请在脚本内先筛选字段或限制条数后分批保存`;
        } else {
          rawJson = text;
        }
      } catch (captureError) {
        rawJsonError = `返回值无法序列化为 JSON：${(captureError as Error)?.message || String(captureError)}（常见原因：循环引用）`;
      }
    }

    return {
      success: true,
      value: sanitize(value, 0, new Set()),
      type: typeof value,
      ...(rawJson !== undefined ? { rawJson } : {}),
      ...(rawJsonError !== undefined ? { rawJsonError } : {}),
    };
  } catch (error) {
    const err = error as { message?: string; stack?: string };
    return {
      success: false,
      error: err?.message ?? String(error),
      ...(err?.stack ? { stack: err.stack } : {}),
    } as InPageEvalResult;
  }
}

/**
 * 统一页面执行引擎工具
 */
export class PageExecTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.PAGE_EXEC;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.PAGE_EXEC,
    description:
      '高权限页面脚本执行引擎：在当前页面执行任意 JavaScript，自动在受限 CSP 站点升级到 CDP 通道；' +
      '结果默认存入数据暂存区（saveResult=false 可让 ≤2000 字符的小结果跳过暂存），' +
      '超 2000 字符只回传预览并附 dataRef 引用，支持 readRef 分页读取',
    category: 'browser',
    version: '1.2.0',
    author: 'AgentNexus',
    tags: ['browser', 'script', 'exec', 'rpa', 'cdp', 'chrome'],
    displayName: '页面执行引擎',
    permissions: ['scripting', 'debugger'],
    // 参数语义级人审门：本工具可执行任意 JS，脚本含资金/敏感操作时由模型
    // 显式 confirm=true 触发用户批准（code 不参与关键词扫描——抓取脚本里
    // 出现「提交/删除」等词属正常代码，扫描会大量误伤）
    requiresConfirm: true,
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.PAGE_EXEC,
      description:
        '在指定页面/frame 执行 async JavaScript 函数体，用 return 返回精简对象或所需字段，不必 JSON.stringify。' +
        '自动分层执行：普通代码走页面主世界注入；遇到严格 CSP 拒绝 eval 时自动升级 CDP 通道（无视页面 CSP）；' +
        '只有用户代码尚未执行的权限探测失败才切换引擎；代码开始后不自动重放。CDP 失败明确报错。' +
        '适用：普通观察不足时读取结构化数据/组件状态，或专用工具无法完成的必要操作；常规点击/填写优先 browser_interact。合并独立只读检查，写操作逐次执行并核对业务回执，不用长循环反复滚动/点击/提交。' +
        '默认 auto 通常足够；只有确需调试器通道时才指定 strategy="cdp"。读取 DOM 可按需使用 world="ISOLATED"，不能假定隔离世界能读页面全局变量。超时不保证脚本已停止，先核对现状，不重放效果未知的操作。' +
        '数据输出契约：单次响应的数据正文最多 2000 字符——结果默认（saveResult 省略或 true）存入数据暂存区并携带 dataRef 引用，' +
        '≤2000 字符时 result 同步全量返回，超长时只保留前 2000 字符预览（附 totalChars/resultTruncated 与行数/字段统计）；' +
        'saveResult=false 仅当结果 ≤2000 字符时跳过暂存（超长结果仍会自动暂存，否则数据随截断丢失）。' +
        '要查看暂存数据的其它片段：传 readRef=引用ID（此时不要传 code），用 offset/limit 分页读取，每页最多 2000 字符。' +
        '批量抓取脚本 return 对象数组 [{...},{...}] 最佳（可直接 xlsx 导出），配 label 标注批次；多页批次先 data_ref_tool(action="merge") 合并再导出。' + CONFIRM_GUIDANCE,
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              '要执行的 JavaScript 代码（与 readRef 互斥）。代码统一为 async 函数体，必须用 return 返回结果，允许 await；' +
              '不会因运行时错误或无结果自动重放；可用 $args 读取 args 参数数组。',
          },
          args: {
            type: 'array',
            description:
              '可选参数数组，通过 async 函数体内的 $args 读取；默认空数组。',
            items: {},
          },
          world: {
            type: 'string',
            enum: ['auto', 'MAIN', 'ISOLATED'],
            description:
              '执行世界。MAIN=页面主世界（可访问 window 全局对象）；ISOLATED=隔离世界（DOM 可用、页面 JS 不可见）；auto=默认优先 MAIN',
            default: 'auto',
          },
          strategy: {
            type: 'string',
            enum: ['auto', 'cdp', 'scripting'],
            description:
              '执行策略。auto=默认逐级升级；cdp=强制最高权限（无视 CSP，可访问页面 JS 状态，会短暂附加调试器）；scripting=只用注入通道不碰调试器',
            default: 'auto',
          },
          awaitPromise: {
            type: 'boolean',
            description: '是否等待返回的 Promise 完成（默认 true）',
            default: true,
          },
          timeout: {
            type: 'number',
            description: '超时时间（毫秒），默认 15000，上限 120000',
            default: DEFAULT_EVAL_TIMEOUT_MS,
          },
          frameId: {
            type: 'number',
            description:
              'Chrome FrameId，默认0；指定子 frame 只在该 frame 执行，不会静默回退主页面。严格 CSP 子 frame 请使用 ISOLATED 读 DOM。',
          },
          tabId: {
            type: 'number',
            description: '目标标签页 ID（可选，默认当前激活标签页）',
          },
          saveResult: {
            type: 'boolean',
            description:
              '默认 true：全量结果存入数据暂存区并返回 dataRef（引用 ID，浏览器会话内约 12 小时有效），' +
              '便于后续 readRef 分页核对、data_ref_tool(info/merge) 管理与 xlsx_tool(action="create_from_data", sheets[].dataRef=该ID) 直接导出；' +
              '显式 false 仅当结果 ≤2000 字符时跳过暂存（超长结果仍自动暂存防丢失）。批量抓取保持默认即可。',
            default: true,
          },
          label: {
            type: 'string',
            description:
              '暂存数据的语义标签（如「第1页-商品列表」），便于 data_ref_tool(action="list") 时辨识批次（自动暂存时同样生效）',
          },
          readRef: {
            type: 'string',
            description:
              '分页读取暂存批次（与 code 互斥：提供 readRef 时不执行脚本、不依赖标签页）。' +
              '值为本工具执行响应返回的 dataRef（8 位 ID）。' +
              '返回该批次全量 JSON 文本的字符切片 content，配合 offset（起始偏移）与 limit（本页字符数，≤2000）使用；' +
              '响应含 totalChars/hasMore/nextOffset，把 nextOffset 作为下一次的 offset 即可续读',
          },
          offset: {
            type: 'number',
            description:
              'readRef 模式的起始字符偏移（默认 0，≥0 整数；越界自动收敛到末尾并返回空页，不报错）',
            default: 0,
          },
          limit: {
            type: 'number',
            description: `readRef 模式本页最多读取的字符数（默认 ${DATA_CHARS_LIMIT}，上限 ${DATA_CHARS_LIMIT}，超出自动按上限处理）`,
            default: DATA_CHARS_LIMIT,
          },
          confirm: {
            type: 'boolean',
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

  async execute(args: PageExecParams): Promise<ToolResult> {
    this.ensureBackgroundContext();

    // 参数整体可能为 null/undefined（executeTool 对缺失参数直接透传）——归一后解构，
    // 让「缺少 code」走到下方精确校验，而不是在解构处抛 TypeError
    const {
      code,
      args: codeArgs,
      world = 'auto',
      strategy = 'auto',
      awaitPromise = true,
      timeout = DEFAULT_EVAL_TIMEOUT_MS,
      tabId: requestedTabId,
      frameId = 0,
      saveResult: rawSaveResult,
      label,
      readRef,
      offset,
      limit,
    } = args || ({} as PageExecParams);
    if (
      rawSaveResult !== undefined &&
      typeof rawSaveResult !== 'boolean'
    ) {
      return this.createErrorResponse(
        `saveResult 必须是布尔值，实际收到 ${stringifyArgPreview(rawSaveResult)}`
      );
    }
    // 默认 true 的语义经 rawSaveResult 直接表达（wantsStore 判定见暂存段）；
    // 显式 false 是唯一「小结果不暂存」的途径；超长结果无论如何都会自动暂存。

    // ── 模式分诊：readRef 分页读取（不执行脚本、不依赖标签页） vs code 脚本执行 ──
    // 先做 readRef 类型防御：非字符串若落到「缺 code」分支会给出误导性错误
    if (
      readRef !== undefined &&
      readRef !== null &&
      typeof readRef !== 'string'
    ) {
      return this.createErrorResponse(
        `readRef 必须是字符串（暂存批次 ID），实际收到 ${Array.isArray(readRef) ? 'array' : typeof readRef}`
      );
    }
    const refId = typeof readRef === 'string' ? readRef.trim() : '';
    const hasOffset = offset !== undefined && offset !== null;
    const hasLimit = limit !== undefined && limit !== null;
    if (refId) {
      if (typeof code === 'string' && code.trim()) {
        return this.createErrorResponse(
          'readRef 与 code 互斥：分页读取暂存批次时不要同时提供 code（readRef 模式不会执行脚本）'
        );
      }
      return this.handleRead(refId, offset, limit);
    }
    // 执行模式下携带 offset/limit（测试面板会预填目录默认值、模型也可能回填
    // schema 默认值）：静默忽略而非报错——执行语义下这两个参数没有对应物，
    // 阻断正常执行得不偿失；仅留日志便于排查参数误用
    if (hasOffset || hasLimit) {
      this.log(
        'offset/limit provided without readRef in exec mode, ignored',
        'warn'
      );
    }
    if (!code || typeof code !== 'string' || !code.trim()) {
      return this.createErrorResponse(
        'Parameter [code] is required and must be a non-empty string（或提供 readRef 分页读取暂存批次）'
      );
    }

    if (
      !['auto', 'MAIN', 'ISOLATED'].includes(world) ||
      !['auto', 'cdp', 'scripting'].includes(strategy) ||
      typeof awaitPromise !== 'boolean'
    )
      return this.createErrorResponse('world/strategy/awaitPromise 参数无效');
    if (
      !Number.isFinite(timeout) ||
      timeout < 1000 ||
      timeout > MAX_EVAL_TIMEOUT_MS
    )
      return this.createErrorResponse('timeout 必须是1000..120000毫秒');
    const timeoutMs = timeout;

    try {
      // 解析目标标签页：优先显式 tabId，否则当前激活标签页
      // （tabId 允许为 0——用真值判断会把合法的 0 当成「未提供」，故显式判空）
      if (
        requestedTabId !== undefined &&
        requestedTabId !== null &&
        (!Number.isInteger(requestedTabId) || requestedTabId < 0)
      ) {
        return this.createErrorResponse(
          `Parameter [tabId] must be a non-negative integer, received: ${String(requestedTabId)}`
        );
      }
      const tab =
        requestedTabId !== undefined && requestedTabId !== null
          ? await chrome.tabs.get(requestedTabId)
          : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab || typeof tab.id !== 'number') {
        return this.createErrorResponse('No active tab found');
      }
      const tabId = tab.id;

      // 受限页面（chrome:// 等）无法注入/调试，提前给出可操作的提示
      if (isRestrictedPageUrl(tab.url)) {
        return this.createErrorResponse(
          `Current page is a restricted URL (${tab.url}) where script execution is not permitted. ` +
            `Navigate to a normal web page first (e.g. call check_restricted_url).`
        );
      }

      if (!Number.isSafeInteger(frameId) || frameId < 0)
        return this.createErrorResponse('frameId 必须为非负整数');
      const expression = this.buildExpression(code, codeArgs);
      const startedAt = Date.now();
      const attempts: EngineAttempt[] = [];
      // 全量 JSON 捕获恒开：自动暂存判定与 2000 字符预览都依赖数据的真实长度
      // （净化值有 200 元素/10k 字符截断，无法据此判断是否超阈值）
      const captureJson = true;

      const run = await this.runWithStrategy(
        tabId,
        expression,
        world,
        strategy,
        awaitPromise,
        timeoutMs,
        attempts,
        captureJson,
        frameId
      );

      const durationMs = Date.now() - startedAt;

      if (run.ok) {
        const warnings: string[] = [];

        // ── 1. 全量 JSON 捕获（始终尝试）──
        // scripting 通道：页面侧已捕获未净化的全量 JSON（页面→background 通道有 6M 字符上限）；
        // CDP 通道：值已完整回到 background，在此序列化并施加同一上限，两条通道口径一致
        let fullJson: string | undefined;
        let captureNote: string | undefined;
        if (run.engine === 'scripting') {
          if (typeof run.rawJson === 'string') {
            fullJson = run.rawJson;
          } else {
            captureNote = run.rawJsonError ?? '全量数据捕获失败（未知原因）';
          }
        } else {
          const text = stringifyJsonText(run.value);
          if (text === undefined) {
            captureNote = '返回值没有可用的 JSON 形态';
          } else if (text.length > MAX_CAPTURE_CHARS) {
            captureNote = `数据量 ${text.length} 字符超过单次暂存上限 ${MAX_CAPTURE_CHARS}——请在脚本内先筛选字段或限制条数后分批保存`;
          } else {
            fullJson = text;
          }
        }

        // ── 2. 暂存判定：saveResult 默认开启；显式 false 仅当全量 ≤ 阈值时跳过，
        //       超长结果无论参数如何都强制暂存（否则数据随 2000 字符截断丢失）。
        //       wantsStore（意图）与 shouldStore（可执行）分离：显式/默认要暂存
        //       但捕获失败时，意图仍在——告警必须照发，不能静默吞掉。 ──
        const overLimit =
          fullJson !== undefined && fullJson.length > DATA_CHARS_LIMIT;
        const wantsStore = rawSaveResult !== false || overLimit;
        const shouldStore = wantsStore && fullJson !== undefined;
        let storedMeta: DataRefMeta | undefined;
        let storeNote: string | undefined;
        if (shouldStore && fullJson !== undefined) {
          const saved = await saveDataRefJson(fullJson, label);
          if (saved.ok) storedMeta = saved.meta;
          else storeNote = saved.reason;
        }

        // ── 3. 结果封装：数据正文恒不超过 DATA_CHARS_LIMIT 字符 ──
        const payload: Record<string, unknown> = {
          tabId,
          frameId,
          url: tab.url,
          engine: run.engine,
          world: run.world,
          result: run.value,
          resultType: run.type ?? typeof run.value,
          durationMs,
          outcome: awaitPromise ? 'completed' : 'dispatched',
          attempts,
        };

        if (storedMeta && fullJson !== undefined) {
          // 已暂存：正文 = 全量 JSON 的前缀（不足 DATA_CHARS_LIMIT 则全部封装）
          const totalChars = fullJson.length;
          payload.result = fullJson.slice(0, DATA_CHARS_LIMIT);
          payload.resultType = 'json-preview';
          payload.totalChars = totalChars;
          if (totalChars > DATA_CHARS_LIMIT) payload.resultTruncated = true;
          payload.dataRef = storedMeta;
          // 三态：explicit=显式 true；default=省略（默认开启）；auto=显式 false 但超限强制
          payload.dataRefTrigger =
            rawSaveResult === true
              ? 'explicit'
              : rawSaveResult === false
                ? 'auto'
                : 'default';
          payload.dataRefGuide = buildDataRefGuide(storedMeta, totalChars);
        } else {
          // 未暂存：净化结构化值直接返回；序列化后仍超限时降级为 JSON 文本前缀——
          // 覆盖「捕获失败的超大返回值」与「暂存失败但全量在手」两种情形，
          // 保证任何路径下输出的 data 正文都有界
          const structuredText = stringifyJsonText(run.value);
          const source = fullJson ?? structuredText;
          if (
            structuredText !== undefined &&
            structuredText.length > DATA_CHARS_LIMIT &&
            source !== undefined
          ) {
            payload.result = source.slice(0, DATA_CHARS_LIMIT);
            payload.resultType = 'json-preview';
            payload.totalChars = source.length;
            if (source.length > DATA_CHARS_LIMIT)
              payload.resultTruncated = true;
          }
        }

        // ── 4. 暂存失败必须让模型感知 ──
        if (!storedMeta && wantsStore) {
          // 显式要求暂存、或已判定超长却没存上（容量/序列化/捕获失败）
          warnings.push(
            `数据暂存失败：${storeNote ?? captureNote ?? '未知原因'}`
          );
        } else if (
          !storedMeta &&
          captureNote &&
          payload.resultTruncated === true
        ) {
          // 未显式要求暂存，但捕获失败且可见输出已触顶：数据大概率超限且无法自动暂存
          warnings.push(`无法自动暂存数据：${captureNote}`);
        }

        // ── 5. 返回值疑似错误对象（fetch 未检查 res.ok 的常见形态）──
        // 仅提示不改动结果：数据原样封装，模型自行核实（见 detectHttpErrorShape 注释）
        const errorShapeHint = detectHttpErrorShape(run.value);
        if (errorShapeHint) warnings.push(errorShapeHint);
        if (warnings.length > 0) payload.warnings = warnings;

        const message =
          storedMeta && fullJson !== undefined
            ? `Script executed via ${run.engine} (${run.world} world); 全量 ${fullJson.length} 字符已暂存为 ${storedMeta.id}（响应含前 ${Math.min(fullJson.length, DATA_CHARS_LIMIT)} 字符预览）`
            : `Script executed via ${run.engine} (${run.world} world)`;
        return this.createSuccessResponse(payload, message);
      }

      return this.createErrorResponse(
        `Script execution failed on all engines: ${run.error}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // debugger 附加失败等同步错误直接透出原因，便于模型切换策略重试
      return this.createErrorResponse(`Script execution failed: ${message}`);
    }
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
    rawLimit: unknown
  ): Promise<ToolResult> {
    const notes: string[] = [];

    // offset：缺省 0；须为 ≥0 的有限数（数字字符串宽容接受，布尔/对象拒绝），非整数向下取整
    let offset = 0;
    if (rawOffset !== undefined && rawOffset !== null) {
      const parsed =
        typeof rawOffset === 'number'
          ? rawOffset
          : typeof rawOffset === 'string' && rawOffset.trim() !== ''
            ? Number(rawOffset)
            : NaN;
      if (!Number.isFinite(parsed) || parsed < 0) {
        return this.createErrorResponse(
          `offset 必须是 ≥0 的数字（字符偏移），实际收到 ${stringifyArgPreview(rawOffset)}`
        );
      }
      offset = Math.floor(parsed);
    }

    // limit：缺省/上限 DATA_CHARS_LIMIT；非法（非数或 ≤0）拒绝，超上限收敛并说明
    let limit = DATA_CHARS_LIMIT;
    if (rawLimit !== undefined && rawLimit !== null) {
      const parsed =
        typeof rawLimit === 'number'
          ? rawLimit
          : typeof rawLimit === 'string' && rawLimit.trim() !== ''
            ? Number(rawLimit)
            : NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return this.createErrorResponse(
          `limit 必须是 1..${DATA_CHARS_LIMIT} 的数字（本页字符数），实际收到 ${stringifyArgPreview(rawLimit)}`
        );
      }
      limit = Math.floor(parsed);
      if (limit < 1) limit = 1; // 0<x<1 向下取整为 0 后兜底为 1（parsed>0 已保证存在小数可能）
      if (limit > DATA_CHARS_LIMIT) {
        notes.push(
          `limit=${limit} 超出单页上限，已按 ${DATA_CHARS_LIMIT} 处理`
        );
        limit = DATA_CHARS_LIMIT;
      }
    }

    const entry = await getDataRef(refId);
    if (!entry) {
      const existing = await listDataRefs();
      const hint =
        existing.length > 0
          ? `当前可用批次（最多列出 10 个）：\n${existing.slice(0, 10).map(describeRefMeta).join('\n')}`
          : '暂存区为空（数据可能已随浏览器会话过期，请重新抓取）。';
      return this.createErrorResponse(
        `readRef "${refId}" 不存在或已过期。${hint}`
      );
    }

    const totalChars = entry.json.length;
    const start = Math.min(offset, totalChars);
    if (offset > totalChars) {
      notes.push(
        `offset=${offset} 超出数据末尾（共 ${totalChars} 字符），已收敛到末尾返回空页`
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
      ...(notes.length > 0 ? { note: notes.join('；') } : {}),
    };

    const message =
      `已读取 ${entry.id}${entry.label ? `「${entry.label}」` : ''} 的 [${start}, ${end}) 字符区间` +
      `（共 ${totalChars} 字符，${hasMore ? `还剩 ${totalChars - end} 字符，用 nextOffset 续读` : '已到末尾'}）`;
    return this.createSuccessResponse(payload, message);
  }

  /** One execution contract: async function body, explicit return, optional $args array. */
  private buildExpression(code: string, codeArgs?: unknown[]): string {
    if (codeArgs !== undefined && !Array.isArray(codeArgs))
      throw new Error('args 必须为数组');
    const argsJson = JSON.stringify(codeArgs ?? [])
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    return '(async function($args){\n' + code + '\n})(' + argsJson + ')';
  }

  /** 按策略逐级执行，收集每次尝试记录 */
  private async runWithStrategy(
    tabId: number,
    expression: string,
    world: ExecWorld,
    strategy: ExecStrategy,
    awaitPromise: boolean,
    timeoutMs: number,
    attempts: EngineAttempt[],
    captureJson: boolean,
    frameId = 0
  ): Promise<{
    ok: boolean;
    engine?: 'scripting' | 'cdp';
    world?: 'MAIN' | 'ISOLATED';
    value?: unknown;
    type?: string;
    error?: string;
    rawJson?: string;
    rawJsonError?: string;
  }> {
    // —— 策略：强制 CDP ——
    if (strategy === 'cdp') {
      return this.runCdp(
        tabId,
        expression,
        awaitPromise,
        timeoutMs,
        attempts,
        frameId
      );
    }

    // —— 策略：scripting（或 auto 的注入阶段）——
    const primaryWorld: 'MAIN' | 'ISOLATED' =
      world === 'ISOLATED' ? 'ISOLATED' : 'MAIN';
    const scriptingResult = await this.runScripting(
      tabId,
      expression,
      primaryWorld,
      awaitPromise,
      timeoutMs,
      attempts,
      captureJson,
      frameId
    );

    if (scriptingResult.ok) {
      return scriptingResult;
    }

    // No-result/transport failures may follow side effects. Never replay automatically.
    // 注入世界为 MAIN 且因 CSP 拒绝 eval 失败：
    // - auto 策略升级到 CDP 重试（最高权限，无视页面 CSP）；
    // - scripting 策略不碰调试器，直接回退到隔离世界（DOM 操作仍可用）。
    const cspBlocked = scriptingResult.cspBlocked === true;
    if (primaryWorld === 'MAIN' && cspBlocked) {
      if (frameId !== 0)
        return this.runScripting(
          tabId,
          expression,
          'ISOLATED',
          awaitPromise,
          timeoutMs,
          attempts,
          captureJson,
          frameId
        );
      if (strategy === 'auto') {
        this.log(
          'MAIN world eval blocked by page CSP, escalating to CDP channel',
          'warn'
        );
        const cdpResult = await this.runCdp(
          tabId,
          expression,
          awaitPromise,
          timeoutMs,
          attempts,
          frameId
        );
        if (cdpResult.ok) {
          return cdpResult;
        }
        return cdpResult; // Execution may have started; do not replay in another world.
      }
      this.log(
        'MAIN world eval blocked by page CSP, falling back to ISOLATED world (scripting strategy)',
        'warn'
      );
      return this.runScripting(
        tabId,
        expression,
        'ISOLATED',
        awaitPromise,
        timeoutMs,
        attempts,
        captureJson,
        frameId
      );
    }

    return scriptingResult;
  }

  /** scripting 通道执行（chrome.scripting.executeScript） */
  private async runScripting(
    tabId: number,
    expression: string,
    world: 'MAIN' | 'ISOLATED',
    awaitPromise: boolean,
    timeoutMs: number,
    attempts: EngineAttempt[],
    captureJson: boolean,
    frameId = 0
  ): Promise<{
    ok: boolean;
    engine: 'scripting';
    world: 'MAIN' | 'ISOLATED';
    value?: unknown;
    type?: string;
    error?: string;
    cspBlocked?: boolean;
    rawJson?: string;
    rawJsonError?: string;
  }> {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: pageConsoleEvaluate,
        args: [
          expression,
          timeoutMs,
          awaitPromise,
          captureJson,
          MAX_CAPTURE_CHARS,
        ],
        world,
      });

      const payload = results?.[0]?.result as InPageEvalResult | undefined;
      if (payload && payload.success) {
        attempts.push({ engine: 'scripting', world, ok: true });
        return {
          ok: true,
          engine: 'scripting',
          world,
          value: payload.value,
          type: payload.type,
          ...(payload.rawJson !== undefined
            ? { rawJson: payload.rawJson }
            : {}),
          ...(payload.rawJsonError !== undefined
            ? { rawJsonError: payload.rawJsonError }
            : {}),
        };
      }

      const errorMsg =
        payload?.error ?? 'No result returned from injected script';
      attempts.push({ engine: 'scripting', world, ok: false, note: errorMsg });
      return {
        ok: false,
        engine: 'scripting',
        world,
        error: errorMsg,
        cspBlocked: payload?.safeFallback === true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ engine: 'scripting', world, ok: false, note: message });
      return {
        ok: false,
        engine: 'scripting',
        world,
        error: message,
        cspBlocked: false,
      };
    }
  }

  /** CDP 通道执行（chrome.debugger + Runtime.evaluate，无视页面 CSP） */
  private async runCdp(
    tabId: number,
    expression: string,
    awaitPromise: boolean,
    timeoutMs: number,
    attempts: EngineAttempt[],
    frameId = 0
  ): Promise<{
    ok: boolean;
    engine: 'cdp';
    world: 'MAIN';
    value?: unknown;
    type?: string;
    error?: string;
  }> {
    if (frameId !== 0)
      return {
        ok: false,
        engine: 'cdp',
        world: 'MAIN',
        error:
          '指定子 frame 不支持顶层 CDP 求值；请用 world=ISOLATED、strategy=scripting，或使用纯文本辅助功能工具。',
      };
    if (!cdpSession.isSupported()) {
      const note = 'chrome.debugger 不可用（当前环境不支持）';
      attempts.push({ engine: 'cdp', world: 'MAIN', ok: false, note });
      return { ok: false, engine: 'cdp', world: 'MAIN', error: note };
    }

    const result = await cdpSession.evaluate(tabId, expression, {
      awaitPromise,
      timeoutMs,
    });

    if (result.ok) {
      attempts.push({ engine: 'cdp', world: 'MAIN', ok: true });
      return {
        ok: true,
        engine: 'cdp',
        world: 'MAIN',
        value: result.value,
        type: result.remoteType ?? typeof result.value,
      };
    }

    const errorMsg = result.error ?? 'Unknown CDP error';
    attempts.push({ engine: 'cdp', world: 'MAIN', ok: false, note: errorMsg });
    return { ok: false, engine: 'cdp', world: 'MAIN', error: errorMsg };
  }
}

// 导出工具实例与页面求值函数（script.ts 的兼容工具复用同一实现）
export const pageExecTool = new PageExecTool();
export { pageConsoleEvaluate };

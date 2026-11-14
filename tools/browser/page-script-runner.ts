/**
 * 页面脚本执行内核（共享实现）
 *
 * 从 browser_page_exec 抽出的**唯一一份**脚本求值实现，供两个工具共用：
 *   - browser_page_exec：单页执行（模型指定页面，跑一段脚本）
 *   - browser_crawl    ：批量执行（一段脚本跑遍 N 个目标页）
 *
 * 抽出来的原因：批量执行必须复用**完全相同**的引擎升级链路（MAIN → CDP）、
 * 净化规则与超时语义——两份实现必然漂移（引擎选错、CSP 行为不一致、
 * 净化阈值不同），而这些差异会直接表现为「批量结果与单页结果对不上」。
 *
 * 执行通道（见 browser_page_exec 的对外说明）：
 *   - scripting + MAIN  ：chrome.scripting.executeScript 注入页面主世界；
 *     函数体本身不受 CSP 限制，但代码内部的 eval/new Function 会被拒；
 *   - CDP               ：chrome.debugger + Runtime.evaluate，无视页面 CSP；
 *   - scripting + ISOLATED：隔离世界兜底（DOM 可读写，读不到页面 JS 全局）。
 *
 * 引擎升级策略（auto）：MAIN 注入成功即用；仅当**CSP 拒绝 eval** 时升级到
 * CDP；用户代码已经开始执行后**绝不**重放（重放会重复副作用）。
 */

/** 执行策略 */
export type ExecStrategy = 'auto' | 'scripting' | 'cdp';
/** 执行世界（auto = 优先 MAIN，失败后按策略回退） */
export type ExecWorld = 'auto' | 'MAIN' | 'ISOLATED';

/** 单次引擎尝试的记录（可观测性：让调用方了解降级原因） */
export interface EngineAttempt {
  engine: 'scripting' | 'cdp';
  world: 'MAIN' | 'ISOLATED';
  ok: boolean;
  note?: string;
}

/** 脚本求值结果 */
export interface PageScriptOutcome {
  ok: boolean;
  /** 净化后的返回值（结构化预览形态） */
  value?: unknown;
  /** 返回值类型 */
  type?: string;
  /** 页面侧捕获的全量 JSON 文本（未净化；自动暂存与预览截断的依据） */
  rawJson?: string;
  /** 全量捕获失败的原因（序列化失败 / 超上限） */
  rawJsonError?: string;
  /** 失败原因（引擎全部失败时） */
  error?: string;
  /** 实际使用的通道 */
  engine?: 'scripting' | 'cdp';
  /** 实际使用的世界 */
  world?: 'MAIN' | 'ISOLATED';
}

/** 页面内求值函数的返回形态 */
export interface InPageEvalResult {
  success: boolean;
  safeFallback?: boolean;
  value?: unknown;
  type?: string;
  error?: string;
  stack?: string;
  /** 全量 JSON 文本（未经截断净化，供暂存判定与暂存区落盘；捕获恒开） */
  rawJson?: string;
  /** 全量捕获失败的原因（序列化失败/超上限） */
  rawJsonError?: string;
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
export async function pageConsoleEvaluate(
  codeStr: string,
  timeoutMs: number,
  awaitPromise: boolean,
  captureJson: boolean,
  captureLimit: number,
): Promise<InPageEvalResult> {
  // This function is serialized into another JS world; all dependencies must be local.
  /** 单次字符串的最大回传长度 */
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
    // 一次全量 JSON 序列化——自动暂存判定、字符数预览截取都依赖数据真实长度。
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
        rawJsonError = `返回值无法序列化为 JSON：${(captureError as Error)?.message || String(captureError)}`;
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
    };
  }
}

/** 一次执行契约：async 函数体、显式 return、可选 $args 数组 */
export function buildPageScriptExpression(
  code: string,
  codeArgs?: unknown[],
): string {
  if (codeArgs !== undefined && !Array.isArray(codeArgs))
    throw new Error('args 必须为数组');
  const argsJson = JSON.stringify(codeArgs ?? [])
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return '(async function($args){\n' + code + '\n})(' + argsJson + ')';
}

/** 脚本执行请求 */
export interface PageScriptRequest {
  /** 目标标签页 */
  tabId: number;
  /** 目标 frame（缺省 0 = 主 frame） */
  frameId?: number;
  /** 脚本函数体 */
  code: string;
  /** 传给脚本的参数数组（$args） */
  args?: unknown[];
  /** 执行世界 */
  world: ExecWorld;
  /** 执行策略 */
  strategy: ExecStrategy;
  /** 是否等待返回的 Promise 完成 */
  awaitPromise: boolean;
  /** 超时时间（毫秒）——只约束「等待 return 结果」 */
  timeoutMs: number;
  /** 页面侧全量 JSON 的字符上限 */
  captureLimit: number;
  /** 通道切换回调（调用方据此记账 kill 目标，如 CDP 需要 terminateExecution） */
  onEngineChange?: (engine: 'scripting' | 'cdp' | null) => void;
  /**
   * 逐次尝试记录收集器（调用方传入空数组即可拿到可观测的降级轨迹）。
   *
   * 为什么不随结果返回：降级轨迹是**执行过程**的可观测数据，而结果是**执行
   * 结论**——两者生命周期不同（一次执行可能产生多条尝试记录，但只有一条结论）。
   */
  attempts?: EngineAttempt[];
}

/**
 * 按策略逐级执行，返回统一形态的结果。
 *
 * 失败语义：
 *   - MAIN 注入成功 → 直接返回（不重放）；
 *   - MAIN 因 CSP 被拒 → auto 策略升级 CDP；scripting 策略退回 ISOLATED；
 *   - CDP 失败 → 明确报错，**不**在另一个通道重放（代码可能已部分执行）。
 */
export async function runPageScript(
  req: PageScriptRequest,
): Promise<PageScriptOutcome> {
  const {
    tabId,
    frameId = 0,
    code,
    args,
    world,
    strategy,
    awaitPromise,
    timeoutMs,
    captureLimit,
    onEngineChange,
    attempts: collectedAttempts,
  } = req;

  const expression = buildPageScriptExpression(code, args);
  // 调用方传入的收集器（未传则本次执行的轨迹仅在本次调用内可见）
  const attempts: EngineAttempt[] = collectedAttempts ?? [];

  // —— 策略：强制 CDP ——
  if (strategy === 'cdp') {
    return runCdp({
      tabId,
      frameId,
      expression,
      awaitPromise,
      timeoutMs,
      attempts,
      onEngineChange,
    });
  }

  // —— 策略：scripting（或 auto 的注入阶段）——
  const primaryWorld: ExecWorld =
    world === 'ISOLATED' ? 'ISOLATED' : 'MAIN';
  const scriptingResult = await runScripting({
    tabId,
    frameId,
    expression,
    world: primaryWorld,
    awaitPromise,
    timeoutMs,
    captureLimit,
    attempts,
    onEngineChange,
  });

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
      return runScripting({
        tabId,
        frameId,
        expression,
        world: 'ISOLATED',
        awaitPromise,
        timeoutMs,
        captureLimit,
        attempts,
        onEngineChange,
      });
    if (strategy === 'auto') {
      const cdpResult = await runCdp({
        tabId,
        frameId,
        expression,
        awaitPromise,
        timeoutMs,
        attempts,
        onEngineChange,
      });
      if (cdpResult.ok) {
        return cdpResult;
      }
      return cdpResult; // Execution may have started; do not replay in another world.
    }
    const fallback = await runScripting({
      tabId,
      frameId,
      expression,
      world: 'ISOLATED',
      awaitPromise,
      timeoutMs,
      captureLimit,
      attempts,
      onEngineChange,
    });
    return fallback;
  }

  return scriptingResult;
}

/** scripting 通道内部结果（cspBlocked 为内部判定字段） */
interface ScriptingOutcome extends PageScriptOutcome {
  cspBlocked?: boolean;
}
/** scripting 通道执行（chrome.scripting.executeScript） */
async function runScripting(params: {
  tabId: number;
  frameId: number;
  expression: string;
  world: 'MAIN' | 'ISOLATED';
  awaitPromise: boolean;
  timeoutMs: number;
  captureLimit: number;
  attempts: EngineAttempt[];
  onEngineChange?: (engine: 'scripting' | 'cdp' | null) => void;
}): Promise<ScriptingOutcome> {
  const {
    tabId,
    frameId,
    expression,
    world,
    awaitPromise,
    timeoutMs,
    captureLimit,
    attempts,
    onEngineChange,
  } = params;
  try {
    onEngineChange?.('scripting');
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: pageConsoleEvaluate,
      args: [expression, timeoutMs, awaitPromise, true, captureLimit],
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
        ...(payload.rawJson !== undefined ? { rawJson: payload.rawJson } : {}),
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
async function runCdp(params: {
  tabId: number;
  frameId: number;
  expression: string;
  awaitPromise: boolean;
  timeoutMs: number;
  attempts: EngineAttempt[];
  onEngineChange?: (engine: 'scripting' | 'cdp' | null) => void;
}): Promise<PageScriptOutcome> {
  const {
    tabId,
    frameId,
    expression,
    awaitPromise,
    timeoutMs,
    attempts,
    onEngineChange,
  } = params;
  if (frameId !== 0) {
    return {
      ok: false,
      error:
        '指定子 frame 不支持顶层 CDP 求值；请用 world=ISOLATED、strategy=scripting，或使用纯文本辅助功能工具。',
    };
  }
  // CDP 会话由 cdp-session 统一复用（延迟脱离）——按需延迟引入，避免
  // 单页执行路径平白背上一个调试器依赖。
  const { cdpSession } = await import('./cdp-session');
  if (!cdpSession.isSupported()) {
    const note = 'chrome.debugger 不可用（当前环境不支持）';
    attempts.push({ engine: 'cdp', world: 'MAIN', ok: false, note });
    return { ok: false, error: note };
  }

  onEngineChange?.('cdp');
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
  return { ok: false, error: errorMsg };
}

/**
 * 注入安全层（跨域单一事实源）：chrome.scripting.executeScript 的参数净化与错误分类。
 *
 * 背景：Chrome 的注入参数走 JSON 语义序列化——顶层 undefined 会被直接拒绝
 * （"Error at index N: Value is unserializable."），对象属性里的 undefined 也
 * 依赖运行时的宽容行为。structuredClone 能接受 undefined，两者语义不同，
 * 因此任何依赖“Chrome 会宽容处理 undefined”的调用都是隐患。
 *
 * 本模块提供两件事：
 *   1. normalizeInjectionArgs —— 发给 Chrome 之前把参数收敛成纯 JSON 值，
 *      遇到真正不可序列化的值（函数/符号/BigInt/循环引用）立刻抛出带位置的错误，
 *      不让它们流到 Chrome 才炸成一句没有上下文的 INTERNAL_ERROR。
 *   2. classifyInjectionError —— 把 Chrome API 的失败翻译成稳定的分类码，
 *      让调用方（vision / browser 等域）映射到各自的错误体系。
 *
 * 本模块不依赖任何域类型，域侧只负责把 InjectionFailure 映射成自己的错误码。
 */

/** 注入失败的稳定分类。域侧据此映射自己的错误码与恢复提示。 */
export type InjectionFailureCode =
  /** 参数含不可序列化内容（函数/符号/BigInt/循环引用）——调用方改参数即可修复。 */
  | 'ARGUMENT_NOT_SERIALIZABLE'
  /** 页面/框架当前不可注入（尚未就绪、跨进程边界、上下文失效）。 */
  | 'PAGE_NOT_INJECTABLE'
  /** 注入期间目标框架被移除或导航走了。 */
  | 'FRAME_REMOVED'
  /** 标签页已关闭或不再存在。 */
  | 'TAB_GONE'
  /** 扩展没有该页面主机的注入权限。 */
  | 'PERMISSION_DENIED'
  /** 受保护页面（chrome://、扩展商店等）禁止注入。 */
  | 'RESTRICTED_PAGE'
  /** 注入函数在页面内抛异常。 */
  | 'INJECTION_FAILED'
  /** 注入完成但没有拿到任何结果帧。 */
  | 'NO_RESULT';

export interface InjectionFailure {
  code: InjectionFailureCode;
  /** 稳定的短原因标识，便于日志/统计聚合。 */
  reason: string;
  /** 面向模型的可读说明：发生了什么。 */
  message: string;
  /** 面向模型的下一步建议：怎么修。 */
  recovery: string;
  /** 结果是否不确定（可能已部分执行）。 */
  outcomeUncertain: boolean;
  /** 原始错误文本，便于深挖。 */
  raw?: string;
  /** 出错参数在 args 数组中的下标（可定位时）。 */
  argIndex?: number;
  /** 出错参数在结构中的路径（可定位时）。 */
  argPath?: string;
}

/** 参数净化阶段的失败：调用方补齐参数即可修复，不涉及页面状态。 */
export class InjectionArgumentError extends Error {
  constructor(
    message: string,
    readonly detail: {
      argIndex?: number;
      argPath?: string;
      kind: string;
    },
  ) {
    super(message);
    this.name = 'InjectionArgumentError';
  }
}

const MAX_DEPTH = 32;
const MAX_NODES = 20000;

/** 记录一次归一化替换，便于诊断（不进入用户可见载荷）。 */
interface NormalizeTrace {
  visitedNodes: number;
  replacedUndefined: number;
  droppedUndefinedProperties: number;
}

function describePath(path: readonly (string | number)[]): string {
  if (!path.length) return 'args';
  const [first, ...rest] = path;
  let rendered = `args[${first}]`;
  for (const segment of rest)
    rendered += typeof segment === 'number' ? `[${segment}]` : `.${segment}`;
  return rendered;
}

function normalizeValue(
  value: unknown,
  path: (string | number)[],
  seen: WeakSet<object>,
  trace: NormalizeTrace,
): unknown {
  if (++trace.visitedNodes > MAX_NODES) {
    throw new InjectionArgumentError(`Injection arguments exceed the ${MAX_NODES} value serialization budget at ${describePath(path)}. Split large inputs into bounded batches.`,
      { argIndex: typeof path[0] === 'number' ? path[0] : undefined, argPath: describePath(path), kind: 'size' });
  }
  if (value === undefined) {
    // 顶层 undefined 被 Chrome 直接拒绝；语义上等价于“没有值”。
    trace.replacedUndefined++;
    return null;
  }
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    // 与 JSON 语义一致：NaN/Infinity 不可表示，落为 null。
    return Number.isFinite(value as number) ? value : null;
  }
  if (type === 'function') {
    throw new InjectionArgumentError(
      `Injection argument ${describePath(path)} is a function; Chrome requires JSON-serializable values.`,
      { argIndex: typeof path[0] === 'number' ? path[0] : undefined, argPath: describePath(path), kind: 'function' },
    );
  }
  if (type === 'symbol') {
    throw new InjectionArgumentError(
      `Injection argument ${describePath(path)} is a symbol; Chrome requires JSON-serializable values.`,
      { argIndex: typeof path[0] === 'number' ? path[0] : undefined, argPath: describePath(path), kind: 'symbol' },
    );
  }
  if (type === 'bigint') {
    throw new InjectionArgumentError(
      `Injection argument ${describePath(path)} is a BigInt; Chrome requires JSON-serializable values.`,
      { argIndex: typeof path[0] === 'number' ? path[0] : undefined, argPath: describePath(path), kind: 'bigint' },
    );
  }
  if (type !== 'object') {
    throw new InjectionArgumentError(
      `Injection argument ${describePath(path)} has unsupported type ${type}.`,
      { argIndex: typeof path[0] === 'number' ? path[0] : undefined, argPath: describePath(path), kind: type },
    );
  }
  if (path.length > MAX_DEPTH) {
    throw new InjectionArgumentError(
      `Injection argument ${describePath(path)} nests deeper than ${MAX_DEPTH} levels.`,
      { argIndex: typeof path[0] === 'number' ? path[0] : undefined, argPath: describePath(path), kind: 'depth' },
    );
  }
  const object = value as object;
  if (seen.has(object)) {
    throw new InjectionArgumentError(
      `Injection argument ${describePath(path)} contains a circular reference.`,
      { argIndex: typeof path[0] === 'number' ? path[0] : undefined, argPath: describePath(path), kind: 'circular' },
    );
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return Array.from(object, (item, index) =>
        normalizeValue(item, [...path, index], seen, trace),
      );
    }
    // 保留原型语义的对象：Date/RegExp 等在 JSON 语义下退化为字符串。
    if (object instanceof Date) return object.toISOString();
    if (object instanceof RegExp) return String(object);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      let item: unknown;
      try { item = (object as Record<string, unknown>)[key]; }
      catch {
        throw new InjectionArgumentError(`Injection argument ${describePath([...path, key])} could not be read.`,
          { argIndex: typeof path[0] === 'number' ? path[0] : undefined, argPath: describePath([...path, key]), kind: 'property-access' });
      }
      if (item === undefined) {
        // 对象属性里的 undefined 在 JSON 语义下被丢弃——保留键会改变载荷形状。
        trace.droppedUndefinedProperties++;
        continue;
      }
      Object.defineProperty(output, key, {
        value: normalizeValue(item, [...path, key], seen, trace),
        enumerable: true, writable: true, configurable: true,
      });
    }
    return output;
  } finally {
    seen.delete(object);
  }
}

/**
 * 把注入参数收敛成纯 JSON 值：顶层 undefined → null，对象里的 undefined 属性直接丢弃，
 * 函数/符号/BigInt/循环引用/超深嵌套立即抛错并指明位置。
 * Chrome 的 JSON 序列化语义由本模块统一承担，调用方不再依赖运行时的宽容行为。
 */
export function normalizeInjectionArgs(
  args: readonly unknown[],
): unknown[] {
  const trace: NormalizeTrace = {
    visitedNodes: 0,
    replacedUndefined: 0,
    droppedUndefinedProperties: 0,
  };
  const seen = new WeakSet<object>();
  if (!Array.isArray(args)) throw new InjectionArgumentError('Injection args must be an array.', { kind: 'arguments-shape' });
  const output = Array.from(args, (value, index) => {
    try { return normalizeValue(value, [index], seen, trace); }
    catch (error) {
      let known = false;
      try { known = error instanceof InjectionArgumentError; } catch { /* Keep unknown errors bounded. */ }
      if (known) throw error;
      throw new InjectionArgumentError(`Injection argument args[${index}] could not be serialized: ${injectionErrorText(error)}`,
        { argIndex: index, argPath: `args[${index}]`, kind: 'serialization-failed' });
    }
  });
  return output;
}

/** Error values can be null, circular objects, DOMExceptions or hostile proxies. */
export function injectionErrorText(error: unknown): string {
  try {
    if (typeof error === 'string') return error.slice(0, 2000);
    if (error && typeof error === 'object') {
      try {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string' && message) return message.slice(0, 2000);
      } catch { /* A throwing message getter must not hide the original failure. */ }
      try {
        const json = JSON.stringify(error);
        if (typeof json === 'string' && json !== '{}') return json.slice(0, 2000);
      } catch { /* Circular values and BigInts fall back to a string. */ }
    }
    return String(error).slice(0, 2000);
  } catch {
    return 'Unserializable error value';
  }
}

/** Chrome 的注入错误文案 → 稳定分类。命中顺序即优先级，越具体越靠前。 */
interface InjectionPattern {
  test: RegExp;
  code: InjectionFailureCode;
  reason: string;
  message: string;
  recovery: string;
  outcomeUncertain?: boolean;
}
const INJECTION_PATTERNS: InjectionPattern[] = [
  {
    test: /INJECTION_TIMEOUT/i,
    code: 'PAGE_NOT_INJECTABLE',
    reason: 'injection-timeout',
    message: 'Timed out waiting for script injection or its result; the dispatched script may still be running.',
    recovery: 'Inspect current state before retrying. Never automatically replay an action after this timeout.',
    outcomeUncertain: true,
  },
  {
    test: /value is unserializable|not serializable|cannot be cloned/i,
    code: 'ARGUMENT_NOT_SERIALIZABLE',
    reason: 'argument-not-serializable',
    message:
      'Chrome rejected an injection argument because it is not JSON-serializable (undefined at the top level, function, symbol, BigInt or a circular reference).',
    recovery:
      'Send only JSON values. Omit absent optional values instead of passing undefined, and never pass functions or class instances.',
  },
  {
    test: /cannot access contents of the page|extension manifest must request permission|does not have permission/i,
    code: 'PERMISSION_DENIED',
    reason: 'permission-denied',
    message:
      'This extension is not allowed to inject into the current page host.',
    recovery:
      'Switch to a page the extension can script, or grant host permission for this site; do not retry the same injection unchanged.',
  },
  {
    test: /cannot access a chrome:\/\/ url|chrome web store|extensions gallery|cannot be scripted|restricted url/i,
    code: 'RESTRICTED_PAGE',
    reason: 'restricted-page',
    message:
      'The current page is protected by the browser and cannot receive injected scripts.',
    recovery:
      'Move to a normal http/https page; protected pages (chrome://, extension stores) are outside the reach of this tool.',
  },
  {
    test: /no tab with id|tab was closed|tab closed/i,
    code: 'TAB_GONE',
    reason: 'tab-gone',
    message: 'The target tab no longer exists.',
    recovery:
      'Re-query the active tab and capture a fresh screenshot before acting again.',
  },
  {
    test: /no frame with id|no document with id|frame with id .* was removed|frame was removed|navigat/i,
    code: 'FRAME_REMOVED',
    reason: 'frame-removed',
    message: 'The target frame was removed or navigated away during injection.',
    recovery:
      'Capture a fresh screenshot of the current document and re-derive the target from the new evidence.',
  },
  {
    test: /could not establish connection|receiving end does not exist|isolated world|injection/i,
    code: 'PAGE_NOT_INJECTABLE',
    reason: 'page-not-injectable',
    message:
      'The page could not be reached for injection — it may still be loading, mid-navigation, or blocked for this frame.',
    recovery:
      'Wait for the page to settle, capture a fresh screenshot, and retry once against the new document.',
  },
];

const FALLBACK: Omit<InjectionPattern, 'test'> = {
  code: 'INJECTION_FAILED',
  reason: 'injection-failed',
  message: 'The browser refused to run the injection.',
  recovery:
    'Capture a fresh screenshot and inspect the current state before deciding whether to retry.',
  outcomeUncertain: true,
};

/**
 * 把任意注入失败（Chrome API 抛出的错误）翻译成稳定的分类载荷。
 * 永远返回可读的原因与下一步，不把 Chrome 的原始文案直接丢给模型。
 */
export function classifyInjectionError(
  error: unknown,
  context: { operation: string; tabId?: number; frameIds?: number[] } = {
    operation: 'injection',
  },
): InjectionFailure {
  const raw = injectionErrorText(error);
  if (error instanceof InjectionArgumentError) {
    return {
      code: 'ARGUMENT_NOT_SERIALIZABLE', reason: 'argument-not-serializable',
      message: raw, recovery: 'Send only JSON values; remove unsupported or circular arguments.',
      outcomeUncertain: false, raw, ...error.detail,
    };
  }
  const indexMatch = /index\s+(\d+)/i.exec(raw);
  const argIndex = indexMatch ? Number(indexMatch[1]) : undefined;
  for (const pattern of INJECTION_PATTERNS) {
    if (!pattern.test.test(raw)) continue;
    return {
      code: pattern.code,
      reason: pattern.reason,
      message: pattern.message,
      recovery: pattern.recovery,
      outcomeUncertain: pattern.outcomeUncertain ?? false,
      raw,
      ...(argIndex !== undefined ? { argIndex } : {}),
    };
  }
  return {
    code: FALLBACK.code,
    reason: FALLBACK.reason,
    message: `${context.operation} failed: ${raw}`,
    recovery: FALLBACK.recovery,
    outcomeUncertain: FALLBACK.outcomeUncertain ?? false,
    raw,
    ...(argIndex !== undefined ? { argIndex } : {}),
  };
}

/**
 * 注入返回了结果帧，但注入的函数在页面内抛了异常。
 * 与 API 层失败区分开：这是页面代码的问题，通常来自 payload 对当前 DOM 的假设。
 */
export function classifyInjectedFunctionError(
  error: unknown,
  context: { operation: string } = { operation: 'injection' },
): InjectionFailure {
  const raw = injectionErrorText(error);
  return {
    code: 'INJECTION_FAILED',
    reason: 'injected-function-threw',
    message: `The injected ${context.operation} function threw inside the page: ${raw}`,
    recovery:
      'The page did not match what the payload assumed. Re-observe the page and adapt the request instead of repeating it unchanged.',
    outcomeUncertain: false,
    raw,
  };
}

/** 无结果帧：注入"成功"但没有产出任何数据。 */
export function noResultFailure(
  context: { operation: string; frameIds?: number[] },
): InjectionFailure {
  return {
    code: 'NO_RESULT',
    reason: 'no-result',
    message: `${context.operation} returned no result frame.`,
    recovery:
      'Confirm the target frame still exists (fresh screenshot), then retry against the new document.',
    outcomeUncertain: false,
  };
}

/** 供域侧拼装诊断载荷：统一的关键字，便于日志聚合。 */
export function injectionDiagnostic(
  failure: InjectionFailure,
  context: { operation: string; tabId?: number; frameIds?: number[] },
): Record<string, unknown> {
  return {
    injectionFailure: failure.code,
    reason: failure.reason,
    operation: context.operation,
    ...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
    ...(context.frameIds ? { frameIds: context.frameIds } : {}),
    ...(failure.argIndex !== undefined ? { argIndex: failure.argIndex } : {}),
    ...(failure.argPath ? { argPath: failure.argPath } : {}),
    outcomeUncertain: failure.outcomeUncertain,
    cause: failure.raw,
  };
}

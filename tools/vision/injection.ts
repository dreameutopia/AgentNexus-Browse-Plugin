/**
 * 视觉域的注入封装：把 common/script-injection 的通用能力接到 GuiError 体系上。
 *
 * 职责边界：
 *   - common/script-injection：参数净化 + 失败分类（与域无关）；
 *   - 本文件：把分类映射成视觉域的错误码/恢复提示，并统一"结果帧缺失/页面内抛错"的处理。
 *
 * 视觉域的既有约定：任何失败都必须让模型知道「发生了什么 + 下一步做什么」，
 * 并且绝不把可能被部分执行的动作标成可安全重试（outcomeUncertain）。
 */
import {
  classifyInjectionError,
  classifyInjectedFunctionError,
  injectionDiagnostic,
  normalizeInjectionArgs,
  noResultFailure,
  InjectionArgumentError,
  type InjectionFailure,
  type InjectionFailureCode,
} from '../common/script-injection';
import { bounded, GuiError, type GuiErrorCode } from './gui-errors';

const FAILURE_TO_GUI_CODE: Record<InjectionFailureCode, GuiErrorCode> = {
  ARGUMENT_NOT_SERIALIZABLE: 'INVALID_ARGUMENT',
  PERMISSION_DENIED: 'UNSUPPORTED_CONTEXT',
  RESTRICTED_PAGE: 'UNSUPPORTED_CONTEXT',
  TAB_GONE: 'TARGET_UNAVAILABLE',
  FRAME_REMOVED: 'STALE_SCREENSHOT',
  PAGE_NOT_INJECTABLE: 'TARGET_UNAVAILABLE',
  INJECTION_FAILED: 'INTERNAL_ERROR',
  NO_RESULT: 'TARGET_UNAVAILABLE',
};

/** 把通用失败分类翻译成视觉域错误：错误码 + 可执行的下一步。 */
export function injectionGuiError(
  failure: InjectionFailure,
  context: { operation: string; tabId?: number; frameIds?: number[] },
): GuiError {
  const code = FAILURE_TO_GUI_CODE[failure.code];
  const details = injectionDiagnostic(failure, context);
  return new GuiError(
    code,
    `${failure.message} ${failure.recovery}`,
    details,
    failure.recovery,
  );
}

export interface InjectionRequest {
  tabId: number;
  frameIds?: number[];
  allFrames?: boolean;
  world?: 'ISOLATED' | 'MAIN';
  func: (...args: any[]) => unknown;
  args?: readonly unknown[];
}

export interface InjectionOptions {
  /** 面向模型的短操作名，例如 "Check visual target"。 */
  operation: string;
  timeoutMs: number;
}

/**
 * 执行一次脚本注入并保证：
 *   1. 参数一定是纯 JSON 值（undefined 一律消除）；
 *   2. API 失败、页面内异常、结果帧缺失三种失败被区别对待并分类；
 *   3. 返回值一定是可用的结果数组，否则抛出带恢复建议的 GuiError。
 */
export async function injectScript(
  request: InjectionRequest,
  options: InjectionOptions,
): Promise<chrome.scripting.InjectionResult[]> {
  const context = {
    operation: options.operation,
    tabId: request.tabId,
    ...(request.frameIds ? { frameIds: request.frameIds } : {}),
  };
  let args: unknown[];
  try {
    args = normalizeInjectionArgs(request.args ?? []);
  } catch (error) {
    if (error instanceof InjectionArgumentError)
      throw new GuiError(
        'INVALID_ARGUMENT',
        `${error.message} Only plain JSON values may be injected.`,
        { ...error.detail, operation: options.operation },
        'Rewrite the arguments as plain JSON values and call the tool again.',
      );
    throw error;
  }
  let frames: chrome.scripting.InjectionResult[];
  try {
    const injection: Parameters<typeof chrome.scripting.executeScript>[0] = {
      target: {
        tabId: request.tabId,
        ...(request.frameIds ? { frameIds: request.frameIds } : {}),
        ...(request.allFrames ? { allFrames: true } : {}),
      },
      ...(request.world ? { world: request.world } : {}),
      func: request.func,
      args,
      injectImmediately: true,
    };
    frames = await bounded(
      chrome.scripting.executeScript(injection),
      options.timeoutMs,
      options.operation,
    );
  } catch (error) {
    if (error instanceof GuiError) throw error;
    throw injectionGuiError(classifyInjectionError(error, context), context);
  }
  if (!frames.length)
    throw injectionGuiError(noResultFailure(context), context);
  // 某些注入函数会在页面内抛错；结果帧的 error 字段在部分类型定义中缺失，防御性读取。
  const failing = frames.find(
    (frame) => (frame as { error?: unknown }).error !== undefined,
  ) as { error?: unknown } | undefined;
  const failure = failing?.error;
  if (failure !== undefined)
    throw injectionGuiError(
      classifyInjectedFunctionError(failure, context),
      context,
    );
  return frames;
}

/**
 * 单帧注入并取回结果值。缺失或未定义都视为"没有拿到证据"，
 * 抛出的错误明确区分"页面内抛错"与"结果为空"。
 */
export async function injectOnce<T>(
  request: InjectionRequest,
  options: InjectionOptions,
): Promise<T> {
  const frames = await injectScript(request, options);
  const result = frames[0]?.result;
  if (result === undefined || result === null)
    throw injectionGuiError(
      noResultFailure({ operation: options.operation }),
      { operation: options.operation, tabId: request.tabId },
    );
  return result as T;
}

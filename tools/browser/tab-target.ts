import { browserChrome } from '@/tools/browser/browser-scope';
import { BrowserScopeError, type BrowserScopeErrorCode } from './scope-errors';
/**
 * 浏览器工具统一「目标标签页」引擎
 *
 * 所有需要操作「某一标签页」的文本观察/交互/探索工具共用同一套解析规则，
 * 避免每个工具各写一份 active-tab 查询（口径漂移会让同一 tabId 在 A 工具
 * 可用、在 B 工具报「未知参数」）。
 *
 * 契约：
 * - tabId 一律**可选**：省略/null/空串 = 当前活动标签页，不切换；
 * - 显式 tabId 接受 number 或纯数字字符串（模型常把 ID 写成 "1792865371"，
 *   直接拒绝会让它多绕两轮），解析结果必须是 ≥0 的安全整数；
 * - 显式 tabId 必须先校验「存在 + 可注入 + 非受限页」，**再**切换激活，
 *   避免把用户眼前页面切到一个即将失败的标签页；
 * - 切换 = 激活该标签页并聚焦其窗口（窗口最小化/不可聚焦不阻断，只降级）。
 *
 * 错误一律返回可读中文 + 稳定错误码，便于模型自纠与日志分析。
 */

import { isRestrictedUrl } from '@/common/constants';
import type { ToolExecutionContext } from '../registry';
import { withDeadline, BrowserWaitError } from '../common/frame-read';
import { injectionErrorText } from '../common/script-injection';

export type TabTargetErrorCode =
  | BrowserScopeErrorCode
  | 'TAB_ID_INVALID'
  | 'NO_ACTIVE_TAB'
  | 'TAB_NOT_FOUND'
  | 'TAB_UNAVAILABLE'
  | 'RESTRICTED_PAGE'
  | 'TAB_ACTIVATION_FAILED' | 'TARGET_TIMEOUT' | 'ABORTED';

export type TabTargetResult =
  | {
      ok: true;
      tab: chrome.tabs.Tab & { id: number };
      tabId: number;
      url: string;
      /** 是否因显式 tabId 而切换了激活标签页 */
      activated: boolean;
    }
  | { ok: false; code: TabTargetErrorCode; error: string };

export interface TabTargetOptions {
  /** 目标标签页；省略/null = 当前活动标签页 */
  tabId?: unknown;
  /** 工具名（错误文案定位用） */
  tool: string;
  /** 是否允许 about:blank / 空白页（默认 false） */
  allowBlank?: boolean;
  /** 解析成功后回报目标（仅显式 tabId 时触发） */
  context?: ToolExecutionContext;
}

/** 标签页被丢弃（内存回收）后的恢复等待上限 */
const DISCARD_RECOVER_TIMEOUT_MS = 8_000;

function fail(code: TabTargetErrorCode, error: string): TabTargetResult {
  return { ok: false, code, error };
}

/** tabId 归一：number / 纯数字字符串 → 安全非负整数；其余返回 null */
export function normalizeTabId(raw: unknown): number | null | 'blank' {
  if (raw === undefined || raw === null) return 'blank';
  if (typeof raw === 'string' && raw.trim() === '') return 'blank';
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : NaN;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** 页面可注入性校验（受限页/空白页） */
function checkPage(
  tab: chrome.tabs.Tab,
  tool: string,
  allowBlank: boolean,
): { ok: true; url: string } | { ok: false; code: TabTargetErrorCode; error: string } {
  const url = tab.url ?? '';
  if (isRestrictedUrl(url)) {
    return {
      ok: false,
      code: 'RESTRICTED_PAGE',
      error: `RESTRICTED_PAGE：${tool} 不能操作浏览器默认页或受保护页面（${url || '无 URL'}）。请用 browser_tabs 切换到一个普通网页后重试。`,
    };
  }
  if (!allowBlank && (!url || url === 'about:blank')) {
    return {
      ok: false,
      code: 'TAB_UNAVAILABLE',
      error: `TAB_UNAVAILABLE：目标标签页是空白页（${url || 'about:blank'}），没有可操作内容。请先导航到目标网页。`,
    };
  }
  return { ok: true, url };
}

/** 丢弃标签页恢复：reload 后等待重新加载完成（有界；失败不抛，交由调用方判定） */
async function recoverDiscardedTab(tabId: number, signal?: AbortSignal, context?: ToolExecutionContext): Promise<chrome.tabs.Tab | null> {
  const deadline = performance.now() + DISCARD_RECOVER_TIMEOUT_MS;
  try {
    await withDeadline(() => browserChrome(context).tabs.reload(tabId), DISCARD_RECOVER_TIMEOUT_MS, 'Restore discarded tab', signal);
  } catch (error) {
    if (error instanceof BrowserScopeError) throw error;
    signal?.throwIfAborted();
    return null;
  }
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 150));
    signal?.throwIfAborted();
    try {
      const tab = await withDeadline(() => browserChrome(context).tabs.get(tabId), Math.max(1, deadline - performance.now()), 'Read restored tab', signal);
      if (tab && !tab.discarded && tab.status === 'complete') return tab;
    } catch (error) {
      if (error instanceof BrowserScopeError) throw error;
      signal?.throwIfAborted();
      return null; // 标签页在恢复期间被关闭
    }
  }
  return null;
}

/**
 * 解析目标标签页。
 *
 * 显式 tabId 的成功返回保证：标签页存在、非受限页、已切换为激活状态。
 * 省略 tabId 的成功返回保证：存在一个可操作的活动标签页（不主动切换）。
 */
export async function resolveTabTarget(options: TabTargetOptions): Promise<TabTargetResult> {
  const { tool, allowBlank = false, context } = options;
  const signal = context?.signal;
  if (signal?.aborted) return fail('ABORTED', 'ABORTED：目标解析前已取消，未切换或恢复标签页。');
  const apiFailure = (error: unknown, fallback: TabTargetErrorCode, message: string): TabTargetResult => {
    if (error instanceof BrowserScopeError) return fail(error.code, error.message);
    const code = signal?.aborted ? 'ABORTED' : error instanceof BrowserWaitError && error.code === 'INJECTION_TIMEOUT' ? 'TARGET_TIMEOUT' : fallback;
    return fail(code, `${code}：${message}：${injectionErrorText(error)}`);
  };
  const normalized = normalizeTabId(options.tabId);
  if (normalized === null) {
    return fail(
      'TAB_ID_INVALID',
      `TAB_ID_INVALID：tabId 必须是非负整数或纯数字字符串，实际收到 ${JSON.stringify(options.tabId)}。省略该参数表示操作当前活动标签页。`,
    );
  }

  if (normalized === 'blank') {
    let active: chrome.tabs.Tab | undefined;
    try {
      [active] = await withDeadline(() => browserChrome(context).tabs.query({ active: true, currentWindow: true }), 5000, 'Query active tab', signal);
    } catch (error) {
      return apiFailure(error, 'NO_ACTIVE_TAB', '读取当前活动标签页失败，可显式传 tabId 或用 browser_tabs 确认');
    }
    if (typeof active?.id !== 'number') {
      return fail('NO_ACTIVE_TAB', 'NO_ACTIVE_TAB：没有可用的活动标签页。请用 browser_tabs 打开或切换标签页。');
    }
    const page = checkPage(active, tool, allowBlank);
    if (!page.ok) return fail(page.code, page.error);
    return { ok: true, tab: active as chrome.tabs.Tab & { id: number }, tabId: active.id, url: page.url, activated: false };
  }

  const tabId = normalized;
  let tab: chrome.tabs.Tab;
  try {
    tab = await withDeadline(() => browserChrome(context).tabs.get(tabId), 5000, 'Read target tab', signal);
  } catch (error) {
    return apiFailure(error, 'TAB_NOT_FOUND', `无法读取标签页 ${tabId}，用 browser_tabs 查看可用标签页`);
  }
  if (!tab || tab.id !== tabId) return fail('TAB_NOT_FOUND', `TAB_NOT_FOUND：未返回标签页 ${tabId} 的有效信息。`);
  if (tab.discarded) {
    let recovered: chrome.tabs.Tab | null;
    try { recovered = await recoverDiscardedTab(tabId, signal, context); }
    catch (error) { return apiFailure(error, 'TAB_UNAVAILABLE', `无法恢复休眠标签页 ${tabId}`); }
    if (!recovered) {
      return fail(
        'TAB_UNAVAILABLE',
        `TAB_UNAVAILABLE：标签页 ${tabId} 处于休眠/丢弃状态且恢复失败（可能在恢复期间被关闭）。用 browser_tabs 切换到其它标签页，或重新打开目标网页。`,
      );
    }
    tab = recovered;
  }
  const page = checkPage(tab, tool, allowBlank);
  if (!page.ok) return fail(page.code, page.error);

  // 先校验后切换：不把用户眼前页面切到一个必然失败的标签页
  try {
    await withDeadline(() => browserChrome(context).tabs.update(tabId, { active: true }), 5000, 'Activate target tab', signal);
    try {
      await withDeadline(() => browserChrome(context).windows.update(tab.windowId, { focused: true }), 3000, 'Focus target window', signal);
    } catch {
      signal?.throwIfAborted();
      // 窗口最小化 / 无权限 / API 不可用：激活已生效，聚焦失败不阻断
    }
    // 切换后重新读取（拿到激活后的最新 url/status）；标签页恰好被关闭时
    // 单独给出 TAB_NOT_FOUND，避免误报成「切换失败」让模型重试切换
    try {
      tab = await withDeadline(() => browserChrome(context).tabs.get(tabId), 5000, 'Verify activated tab', signal);
      if (!tab || tab.id !== tabId) return fail('TAB_NOT_FOUND', `TAB_NOT_FOUND：标签页 ${tabId} 在切换后未返回有效信息。`);
    } catch (error) {
      return apiFailure(error, 'TAB_NOT_FOUND', `无法核验切换后的标签页 ${tabId}`);
    }
  } catch (error) {
    return apiFailure(error, 'TAB_ACTIVATION_FAILED', `标签页 ${tabId} 切换未确认；可能已激活，请先核对当前页面再决定是否重试`);
  }
  const currentPage = checkPage(tab, tool, allowBlank);
  if (!currentPage.ok) return fail(currentPage.code, currentPage.error);
  try { context?.onTabTarget?.(tabId); }
  catch (error) { console.warn('[tab-target] Target notification failed', injectionErrorText(error)); }
  return {
    ok: true,
    tab: tab as chrome.tabs.Tab & { id: number },
    tabId,
    url: currentPage.url,
    activated: true,
  };
}

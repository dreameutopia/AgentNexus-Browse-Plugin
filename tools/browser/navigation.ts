/**
 * 统一导航工具（browser_navigation）
 *
 * 原 browser_navigate / browser_go_back_or_forward / wait_page_load 三个工具
 * 已合并为本工具的五个 action（项目未发布，无兼容别名，旧名直接删除）：
 *   - open     打开 / 复用 URL（原 browser_navigate 的主路径 + refresh 分支）
 *   - refresh  刷新当前标签（原 navigate 的 refresh=true 分支）
 *   - back     历史后退（原 browser_go_back_or_forward(isForward=false)）
 *   - forward  历史前进（原 browser_go_back_or_forward(isForward=true)）
 *   - wait     等待页面加载就绪（原 wait_page_load，且参数真正生效）
 *
 * 合并时的健壮性修正（不缩小任何原有能力）：
 *   - back/forward 纳入全局导航锁（原独立工具游离在锁外，与 open 并发时互相
 *     踩踏）并默认等待就绪（原工具不等加载即返回，模型紧接着读页面会读到
 *     旧页 / 半页）；
 *   - wait 的 timeout / checkInterval / tabId 真正生效（原实现忽略全部参数、
 *     硬编码 10×1s、只能等活动标签页），就绪判定升级为与 open 同源的
 *     status + readyState 双检连续 2 次（见 ./page-load.ts 单一实现）；
 *   - 五 action 共用一套参数矩阵校验：未知参数、张冠李戴（如 wait 带 url）
 *     一律报可读错误，不静默失效。
 *
 * 就绪等待的实现唯一来源是 ./page-load.ts；本文件只保留导航编排
 * （导航锁、URL 复用/新建、历史跳转、结果组装）。
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';
import { existingNavigationWindowId } from './navigation-window';
import {
  checkActionMatrix,
  readBooleanField,
  readNonEmptyStringField,
  readNumberField,
} from './action-args';
import {
  PAGE_LOAD_DEFAULT_POLL_MS,
  PAGE_LOAD_DEFAULT_TIMEOUT_MS,
  PAGE_LOAD_TIMEOUT_MAX_MS,
  WAIT_INTERVAL_MAX_MS,
  WAIT_INTERVAL_MIN_MS,
  waitForTabReady,
} from './page-load';

/** 五个导航 action（schema 枚举与运行期校验同源） */
export const NAVIGATION_ACTIONS = ['open', 'refresh', 'back', 'forward', 'wait'] as const;
export type NavigationAction = (typeof NAVIGATION_ACTIONS)[number];

/** waitForPageLoad 的「标签页被关闭」错误标记（分类器据此区分 closed / timeout / 未知） */
const WAIT_CLOSED_MESSAGE = 'Tab was closed while waiting for page load';

/**
 * 每个 action 允许出现的参数（运行期矩阵）。
 * 拼写错误 / 张冠李戴（如 wait 带 url、refresh 带 newTab）在这里变成可读错误，
 * 不允许静默忽略——静默失效会让模型以为动作已生效。
 */
const ACTION_PARAMS: Record<NavigationAction, readonly string[]> = {
  open: ['url', 'newTab', 'waitForLoad', 'timeout'],
  refresh: ['waitForLoad', 'timeout'],
  back: ['waitForLoad', 'timeout'],
  forward: ['waitForLoad', 'timeout'],
  wait: ['tabId', 'timeout', 'checkInterval'],
};

interface NavigationArgs {
  action: NavigationAction;
  url?: string;
  newTab?: boolean;
  waitForLoad?: boolean;
  timeout?: number;
  checkInterval?: number;
  tabId?: number;
}

/** 校验结果：要么带错误，要么带归一化后的参数 */
type ValidationResult = { error: ToolResult; args?: never } | { error?: never; args: NavigationArgs };

/**
 * 导航互斥锁管理器
 * 确保同时只有一个导航操作（open/refresh/back/forward）在执行；
 * wait 是纯轮询只读，不参与锁——跨会话排队等待没有意义，还可能被
 * 持锁方的长导航拖住自身的等待预算。
 */
class NavigationLockManager {
  private queue: Array<() => void> = [];
  private isLocked = false;

  async acquire(): Promise<void> {
    if (!this.isLocked) {
      this.isLocked = true;
      return;
    }

    // 等待锁释放
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const nextResolve = this.queue.shift();
      nextResolve?.();
    } else {
      this.isLocked = false;
    }
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}

// 全局导航锁实例
const navigationLock = new NavigationLockManager();

/**
 * 统一导航工具：action 驱动的页面导航 + 加载等待
 */
export class BrowserNavigationTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.NAVIGATION;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.NAVIGATION,
    description: '统一页面导航：打开/复用 URL、刷新、历史前进后退、等待加载就绪（action 驱动）',
    category: 'browser',
    version: '3.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'navigation', 'chrome', 'wait'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.NAVIGATION,
      description:
        '统一页面导航，action 五选一：' +
        'open=打开 URL（默认 newTab=true，在现有窗口新建或复用相同完整URL标签；newTab=false 只导航当前标签、不会切换到另一个同URL标签；refresh=true 已移除，刷新请用 action="refresh"）；' +
        'refresh=刷新当前活动标签；' +
        'back/forward=历史后退/前进（默认 waitForLoad=true，等待新页面就绪再返回）；' +
        'wait=等待页面加载就绪——用于交互触发跳转/重渲染后、或上一次导航 loadStatus="timeout" 后补等（tabId 缺省为当前活动标签）。' +
        'waitForLoad（open/refresh/back/forward 默认 true）以 tab.status + document.readyState 连续两次完成判定，' +
        '超时按 loadStatus="timeout" 返回（navigationAction 照常表示导航已发起），此时可用 action="wait" 补等或按已渲染内容继续。' +
        'timeout 单位毫秒（默认 30000）；wait 的 checkInterval 单位毫秒（默认 500，50~10000）。' +
        '路径/查询大小写、尾斜杠与 hash 均可能有业务含义，不忽略。' +
        'newWindow 参数已删除：绝不创建浏览器窗口，无可用窗口时返回错误。' +
        '返回实际 tabId、navigationAction 与 loadStatus；成功只表示导航发起/页面就绪，业务结果仍需自行核验。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: [...NAVIGATION_ACTIONS],
            description:
              'open=打开/复用 URL；refresh=刷新当前标签；back=历史后退；forward=历史前进；wait=等待页面加载就绪',
          },
          url: {
            type: 'string',
            description: '仅 action="open"：要导航到的完整 URL（必填；不做模糊归一，原样导航）',
          },
          newTab: {
            type: 'boolean',
            default: true,
            description: '仅 action="open"：是否在现有窗口新建标签页，默认 true；false 只导航当前标签页',
          },
          waitForLoad: {
            type: 'boolean',
            default: true,
            description: '仅 open/refresh/back/forward：是否等待页面就绪再返回，默认 true；false 只发起导航（loadStatus="not_waited"）',
          },
          timeout: {
            type: 'number',
            description: `等待上限，毫秒（默认 30000，合法区间 1~${PAGE_LOAD_TIMEOUT_MAX_MS}；超上限报错）。所有 action 均可传：导航类约束 waitForLoad 的等待，wait 约束自身等待。需要分钟级等待请用 generic_wait({waitSeconds})`,
          },
          checkInterval: {
            type: 'number',
            description: '仅 action="wait"：轮询间隔，毫秒（默认 500，合法区间 50~10000）',
          },
          tabId: {
            type: 'number',
            description: '仅 action="wait"：要等待的标签页 ID（缺省为当前活动标签页）',
          },
        },
        required: ['action'],
      },
    },
  };

  async execute(rawArgs: unknown): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const validated = this.validate(rawArgs);
    if (validated.error) return validated.error;
    const args = validated.args;

    // wait 是只读轮询，不占导航锁；其余四个 action 串行化执行
    if (args.action === 'wait') {
      try {
        return await this.handleWait(args);
      } catch (error) {
        this.log(`Wait failed: ${error}`, 'error');
        return this.createErrorResponse('Failed to wait for page load', error);
      }
    }

    const queueLength = navigationLock.getQueueLength();
    if (queueLength > 0) {
      this.log(`Navigation queued, ${queueLength} requests waiting`);
    }
    // acquire 与 try 之间不留任何可抛语句：一旦持锁，释放路径必须无条件可达，
    // 否则一次意外（如日志实现变化）就会让锁永久悬挂、卡死全部会话的导航
    await navigationLock.acquire();
    try {
      this.log(`[LOCK ACQUIRED] action=${args.action} target=${args.url ?? args.action}`);
      switch (args.action) {
        case 'open':
          return await this.handleOpen(args);
        case 'refresh':
          return await this.handleRefresh(args);
        case 'back':
        case 'forward':
          return await this.handleHistory(args);
      }
    } catch (error) {
      this.log(`Navigation failed: ${error}`, 'error');
      return this.createErrorResponse(`Failed to ${args.action}`, error);
    } finally {
      navigationLock.release();
      this.log('[LOCK RELEASED] Navigation completed');
    }
  }

  // ──── 参数校验（共享矩阵 + 字段读取，见 ./action-args.ts） ────

  private validate(rawArgs: unknown): ValidationResult {
    const matrix = checkActionMatrix<NavigationAction>(rawArgs, {
      actions: NAVIGATION_ACTIONS,
      params: ACTION_PARAMS,
      // 已删除参数的迁移提示：出现在「未知参数」错误里，防模型沿用旧习惯
      unknownHint: 'newWindow 已删除，禁止创建浏览器窗口',
    });
    if (!matrix.ok) return { error: this.createErrorResponse(matrix.error) };
    const { action, input } = matrix;

    const args: NavigationArgs = { action };

    // url：仅 open 使用（矩阵已保证 key 对当前 action 合法）
    if (input.url !== undefined) {
      const url = readNonEmptyStringField(input, 'url');
      if (!url.ok) return { error: this.createErrorResponse(url.error) };
      args.url = url.value;
    }
    for (const key of ['newTab', 'waitForLoad'] as const) {
      const field = readBooleanField(input, key);
      if (!field.ok) return { error: this.createErrorResponse(field.error) };
      if (field.value !== undefined) args[key] = field.value;
    }
    const timeout = readNumberField(input, 'timeout', {
      min: 1,
      max: PAGE_LOAD_TIMEOUT_MAX_MS,
      hint: `毫秒；页面加载等待上限 ${PAGE_LOAD_TIMEOUT_MAX_MS}ms，更长的等待请改用 generic_wait({waitSeconds})`,
    });
    if (!timeout.ok) return { error: this.createErrorResponse(timeout.error) };
    if (timeout.value !== undefined) args.timeout = timeout.value;

    if (input.checkInterval !== undefined) {
      const interval = readNumberField(input, 'checkInterval', {
        min: WAIT_INTERVAL_MIN_MS,
        max: WAIT_INTERVAL_MAX_MS,
        hint: '毫秒',
      });
      if (!interval.ok) return { error: this.createErrorResponse(interval.error) };
      args.checkInterval = interval.value;
    }
    if (input.tabId !== undefined) {
      const tabId = readNumberField(input, 'tabId', { min: 0, integer: true });
      if (!tabId.ok) return { error: this.createErrorResponse(tabId.error) };
      args.tabId = tabId.value;
    }

    if (action === 'open' && args.url === undefined) {
      return { error: this.createErrorResponse('action="open" 需要 url 参数（完整目标地址）') };
    }
    return { args };
  }

  /**
   * 就绪等待错误分类：waitForPageLoad 只可能抛「closed / 超时」两类；
   * 其余任何错误都是**未知故障**——在这里原样上抛（由各 action 的外层
   * catch 封装为可分析错误），绝不静默降级成 loadStatus="timeout"
   * 掩盖真实问题。
   */
  private classifyWaitError(waitError: unknown): 'closed' | 'timeout' {
    const message = waitError instanceof Error ? waitError.message : String(waitError);
    if (message.includes('closed')) return 'closed';
    if (message.includes('超时')) return 'timeout';
    throw waitError;
  }

  // ──── 就绪等待（实例方法：open/refresh/back/forward 共用；wait 用结构化 outcome） ────

  /**
   * 等待页面加载完成（就绪判定委托 ./page-load.ts 单一实现）。
   * 超时 / 标签页关闭以抛错上抛，由各导航 action 转成 loadStatus 分支。
   */
  protected async waitForPageLoad(
    tabId: number,
    timeoutMs: number = PAGE_LOAD_DEFAULT_TIMEOUT_MS,
    pollIntervalMs: number = PAGE_LOAD_DEFAULT_POLL_MS,
  ): Promise<void> {
    this.log(`Starting to wait for page load on tab ${tabId}`);
    const outcome = await waitForTabReady(tabId, { timeoutMs, pollIntervalMs });
    if (outcome.ready) {
      this.log(`Page load complete after ${outcome.elapsedMs}ms`);
      return;
    }
    if (outcome.reason === 'closed') {
      throw new Error(WAIT_CLOSED_MESSAGE);
    }
    throw new Error(`等待页面加载超时 (${timeoutMs}ms)`);
  }

  /**
   * 等待 URL 变化：检测标签页 URL 是否从原始 URL 变化到其他 URL
   */
  private async waitForUrlChange(
    tabId: number,
    originalUrl: string,
    timeoutMs: number = 10000,
    pollIntervalMs: number = 100,
  ): Promise<{ changed: boolean; currentUrl: string }> {
    const start = Date.now();
    const normalizedOriginal = this.normalizeUrlForComparison(originalUrl);

    this.log(`Waiting for URL to change from: ${normalizedOriginal}`);

    while (Date.now() - start < timeoutMs) {
      try {
        const tab = await chrome.tabs.get(tabId);
        const currentUrl = tab.url || '';
        const normalizedCurrent = this.normalizeUrlForComparison(currentUrl);

        // 如果 URL 已经不同于原始 URL，说明导航开始了
        if (normalizedCurrent && normalizedCurrent !== normalizedOriginal) {
          this.log(`URL changed detected: ${normalizedOriginal} -> ${normalizedCurrent}`);
          return { changed: true, currentUrl };
        }

        // 检查标签页是否正在加载中（这也表示导航已开始）
        if (tab.status === 'loading') {
          this.log(`Tab is loading, navigation started`);
        }
      } catch (error) {
        // 标签页可能已关闭
        this.log(`Error checking tab: ${error}`, 'warn');
        throw new Error('Tab was closed during navigation');
      }

      await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, Math.max(1, timeoutMs - (Date.now() - start)))));
    }

    // 超时后再检查一次最终状态
    try {
      const tab = await chrome.tabs.get(tabId);
      const currentUrl = tab.url || '';
      const normalizedCurrent = this.normalizeUrlForComparison(currentUrl);

      if (normalizedCurrent !== normalizedOriginal) {
        return { changed: true, currentUrl };
      }
    } catch (error) {
      this.log(`Final check failed: ${error}`, 'warn');
    }

    return { changed: false, currentUrl: originalUrl };
  }

  /**
   * URL parser normalizes scheme/host without erasing application routing state.
   */
  private normalizeUrlForComparison(url: string | undefined): string {
    if (!url) return '';

    try {
      return new URL(url).href;
    } catch {
      return url;
    }
  }

  // ──── action 实现 ────

  /** open：复用/新建/当前标签导航（含 waitForUrlChange → waitForPageLoad 两段预算） */
  private async handleOpen(args: NavigationArgs): Promise<ToolResult> {
    const { newTab = true, url, waitForLoad = true, timeout = PAGE_LOAD_DEFAULT_TIMEOUT_MS } = args;

    if (!url) {
      // 校验阶段已强制要求（action="open" 缺 url 直接拒绝）；防御性兜底，
      // 不把 undefined 传给导航
      return this.createErrorResponse('action="open" 需要 url 参数（完整目标地址）');
    }

    this.log(`Executing navigation: open URL: ${url}`);

    // Explicit current-tab navigation must never activate another matching tab.
    if (!newTab) return await this.navigateInCurrentOrNewTab(url, waitForLoad, timeout);
    const existingTab = await this.findExistingTabWithUrl(url);
    if (existingTab) return await this.activateExistingTab(existingTab, waitForLoad, timeout);
    return await this.createNewTabWithUrl(url, waitForLoad, timeout);
  }

  /** refresh：刷新当前活动标签 */
  private async handleRefresh(args: NavigationArgs): Promise<ToolResult> {
    const { waitForLoad = true, timeout = PAGE_LOAD_DEFAULT_TIMEOUT_MS } = args;
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!activeTab || !activeTab.id) {
      return this.createErrorResponse('No active tab found to refresh');
    }

    const originalUrl = activeTab.url || '';
    this.log(`Refreshing tab ${activeTab.id}, current URL: ${originalUrl}`);

    // 刷新标签页
    await chrome.tabs.reload(activeTab.id);

    if (waitForLoad) {
      try {
        await this.waitForPageLoad(activeTab.id, timeout);
      } catch (waitError) {
        // 分类：未知错误上抛（外层 catch 封装）；closed / timeout 分别收口
        const kind = this.classifyWaitError(waitError);
        let latest: chrome.tabs.Tab | undefined;
        try {
          latest = (await chrome.tabs.get(activeTab.id)) ?? undefined;
        } catch {
          latest = undefined;
        }
        if (kind === 'closed' || !latest) {
          return this.createSuccessResponse(
            {
              navigationAction: 'refreshed',
              loadStatus: 'closed',
              tabId: activeTab.id,
              url: originalUrl,
              note: '刷新已发出，但标签页在等待期间被关闭',
            },
            'Refresh dispatched but the tab was closed while loading',
          );
        }
        this.log(`Refresh load wait timed out: ${waitError}`, 'warn');
        return this.createSuccessResponse({
          navigationAction: 'refreshed',
          loadStatus: 'timeout',
          tabId: latest.id,
          windowId: latest.windowId,
          url: latest.url,
          warning: '刷新已发出但页面未在超时内就绪，可用 action="wait" 补等或核验现状',
        }, 'Refresh dispatched; load not confirmed within timeout');
      }
    }

    let updatedTab: chrome.tabs.Tab | undefined;
    try {
      updatedTab = (await chrome.tabs.get(activeTab.id)) ?? undefined;
    } catch {
      updatedTab = undefined;
    }
    if (!updatedTab) {
      return this.createSuccessResponse(
        {
          navigationAction: 'refreshed',
          loadStatus: 'closed',
          tabId: activeTab.id,
          url: originalUrl,
          note: '刷新已发出，但标签页在返回结果前被关闭',
        },
        'Refresh dispatched but the tab was closed before the result was read',
      );
    }

    return this.createSuccessResponse({
      navigationAction: 'refreshed',
      loadStatus: waitForLoad ? 'complete' : 'not_waited',
      tabId: updatedTab.id,
      windowId: updatedTab.windowId,
      url: updatedTab.url,
    }, waitForLoad ? 'Successfully refreshed current tab and load complete' : 'Refresh dispatched; load not awaited');
  }

  /** back/forward：历史跳转 + 默认等待新页面就绪 */
  private async handleHistory(args: NavigationArgs): Promise<ToolResult> {
    const { action, waitForLoad = true, timeout = PAGE_LOAD_DEFAULT_TIMEOUT_MS } = args;
    const isForward = action === 'forward';

    this.log(`Navigating ${isForward ? 'forward' : 'back'} in browser history`);

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || !activeTab.id) {
      return this.createErrorResponse('No active tab found');
    }
    const tabId = activeTab.id;

    if (isForward) {
      await chrome.tabs.goForward(tabId);
    } else {
      await chrome.tabs.goBack(tabId);
    }

    let loadStatus: 'complete' | 'not_waited' | 'timeout' = 'not_waited';
    if (waitForLoad) {
      try {
        await this.waitForPageLoad(tabId, timeout);
        loadStatus = 'complete';
      } catch (waitError) {
        // 未知错误上抛（外层 catch 封装）；closed → 跳转已发出但标签页消失
        const kind = this.classifyWaitError(waitError);
        if (kind === 'closed') {
          return this.createSuccessResponse(
            {
              navigationAction: action,
              loadStatus: 'closed',
              tabId,
              note: '历史跳转已发出，但标签页在等待期间被关闭',
            },
            'History navigation issued but the tab was closed while loading',
          );
        }
        this.log(`History navigation load wait timed out: ${waitError}`, 'warn');
        loadStatus = 'timeout';
      }
    }

    let updatedTab: chrome.tabs.Tab | undefined;
    try {
      updatedTab = await chrome.tabs.get(tabId);
    } catch {
      updatedTab = undefined;
    }
    if (!updatedTab) {
      return this.createSuccessResponse(
        {
          navigationAction: action,
          loadStatus: 'closed',
          tabId,
          note: '历史跳转已发出，但标签页在返回结果前被关闭',
        },
        'History navigation issued but the tab was closed before the result was read',
      );
    }

    return this.createSuccessResponse(
      {
        navigationAction: action,
        loadStatus,
        tabId: updatedTab.id,
        windowId: updatedTab.windowId,
        url: updatedTab.url,
        ...(loadStatus === 'timeout'
          ? { warning: '历史跳转已发出但页面未在超时内就绪，可用 action="wait" 补等或核验现状' }
          : {}),
      },
      loadStatus === 'complete'
        ? `Successfully navigated ${isForward ? 'forward' : 'back'} in browser history and load complete`
        : `History navigated ${isForward ? 'forward' : 'back'}; ${loadStatus === 'timeout' ? 'load unconfirmed, verify current page state' : 'load not awaited'}`,
    );
  }

  /** wait：等待标签页就绪（参数真正生效的独立等待入口） */
  private async handleWait(args: NavigationArgs): Promise<ToolResult> {
    const {
      timeout = PAGE_LOAD_DEFAULT_TIMEOUT_MS,
      checkInterval = PAGE_LOAD_DEFAULT_POLL_MS,
    } = args;

    // 解析目标标签页：显式 tabId 优先，缺省为当前活动标签
    let tab: chrome.tabs.Tab | undefined;
    if (args.tabId !== undefined) {
      try {
        tab = await chrome.tabs.get(args.tabId);
      } catch {
        tab = undefined;
      }
      if (!tab) {
        return this.createErrorResponse(`标签页 ${args.tabId} 不存在（可能已关闭），请用 browser_tabs(action="list") 核对`);
      }
    } else {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab || activeTab.id === undefined) {
        return this.createErrorResponse('No active tab found to wait on');
      }
      tab = activeTab;
    }
    if (!tab || typeof tab.id !== 'number') {
      return this.createErrorResponse('目标标签页没有有效 id，无法等待');
    }
    const tabId = tab.id;

    this.log(`Waiting for tab ${tabId} to become ready (timeout=${timeout}ms, interval=${checkInterval}ms)`);
    const outcome = await waitForTabReady(tabId, { timeoutMs: timeout, pollIntervalMs: checkInterval });

    if (outcome.ready) {
      // 就绪后回读一次最新标签信息（等待期间可能又被导航）
      let latest: chrome.tabs.Tab = tab;
      try {
        latest = await chrome.tabs.get(tabId);
      } catch {
        return this.createSuccessResponse(
          {
            tabId,
            status: 'complete',
            loading: false,
            elapsedMs: outcome.elapsedMs,
            readyStateConfirmed: outcome.readyStateConfirmed,
            note: '标签页在就绪后立即被关闭/变更',
          },
          `页面已完全加载（${outcome.elapsedMs}ms），但标签页随后被关闭`,
        );
      }
      return this.createSuccessResponse(
        {
          tabId,
          windowId: latest.windowId,
          url: latest.url,
          title: latest.title,
          status: 'complete',
          loading: false,
          elapsedMs: outcome.elapsedMs,
          readyStateConfirmed: outcome.readyStateConfirmed,
        },
        `页面已完全加载（等待 ${outcome.elapsedMs}ms，连续 ${outcome.consecutive} 次完成确认）`,
      );
    }

    // 失败结果统一构造：错误文案只写一次（error 与 content 同源，杜绝两份漂移）
    const failWith = (message: string, data: Record<string, unknown>): ToolResult => ({
      success: false,
      error: message,
      content: [{ type: 'text', text: message }],
      data,
    });

    if (outcome.reason === 'closed') {
      return failWith(`标签页 ${tabId} 在等待期间被关闭，无法继续等待加载`, {
        tabId,
        elapsedMs: outcome.elapsedMs,
        ready: false,
      });
    }

    // 超时诊断取**最新**标签状态（等待期间可能已发生跳转）；读取失败或返回
    // 空值（桩/异常实现）一律退回等待前快照，绝不把 undefined 读出 TypeError
    let latest: chrome.tabs.Tab = tab;
    try {
      latest = (await chrome.tabs.get(tabId)) ?? tab;
    } catch {
      latest = tab;
    }
    const detail = `当前 status=${outcome.status ?? 'unknown'}${outcome.consecutive ? `（就绪连续计数 ${outcome.consecutive}/2）` : ''}`;
    return failWith(
      `页面在 ${timeout}ms 内未完成加载：${detail}。可加大 timeout 重试（上限 ${PAGE_LOAD_TIMEOUT_MAX_MS}ms），或按已渲染内容继续（如 browser_get_page_text）`,
      {
        tabId,
        url: latest.url,
        title: latest.title,
        status: outcome.status ?? 'unknown',
        elapsedMs: outcome.elapsedMs,
        ready: false,
      },
    );
  }

  // ──── open 的三条子路径（复用 / 当前标签 / 新建） ────

  /**
   * 查找已打开的相同 URL 的标签页
   */
  private async findExistingTabWithUrl(url: string): Promise<chrome.tabs.Tab | null> {
    const allTabs = await chrome.tabs.query({ currentWindow: true });
    const normalizedTargetUrl = this.normalizeUrlForComparison(url);

    for (const tab of allTabs) {
      const normalizedTabUrl = this.normalizeUrlForComparison(tab.url);
      if (normalizedTabUrl === normalizedTargetUrl) {
        return tab;
      }
    }

    return null;
  }

  /**
   * 激活已存在的标签页
   */
  private async activateExistingTab(
    tab: chrome.tabs.Tab,
    waitForLoad: boolean,
    timeout: number,
  ): Promise<ToolResult> {
    this.log(`Activating existing tab ${tab.id} with URL: ${tab.url}`);

    if (tab.id === undefined) {
      return this.createErrorResponse('Invalid tab ID');
    }

    // 激活标签页
    await chrome.tabs.update(tab.id, { active: true });

    // 聚焦窗口
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }

    // 等待页面加载（如果需要）。等待失败按三态收口：
    //   closed   → 激活已发出但标签页消失 → loadStatus="closed"（导航动作已发生，
    //              按结果数据返回，模型据此改用 browser_tabs 重新定位）；
    //   timeout  → 与新建/当前标签路径一致 loadStatus="timeout" + 补等指引；
    //   未知错误 → classifyWaitError 原样上抛，由外层 catch 封装为可分析错误。
    // 任何分支都不得在等待失败时声称 ready。
    let loadStatus: 'complete' | 'timeout' = 'complete';
    if (waitForLoad) {
      try {
        await this.waitForPageLoad(tab.id, timeout);
      } catch (waitError) {
        const kind = this.classifyWaitError(waitError);
        if (kind === 'closed') {
          return this.createSuccessResponse(
            {
              navigationAction: 'reused',
              loadStatus: 'closed',
              tabId: tab.id,
              windowId: tab.windowId,
              url: tab.url,
              note: '标签页已激活，但在等待就绪期间被关闭',
            },
            'Activated existing tab but it was closed while loading',
          );
        }
        this.log(`Wait for load failed on reused tab: ${waitError}`, 'warn');
        loadStatus = 'timeout';
      }
    }

    let updatedTab: chrome.tabs.Tab | undefined;
    try {
      updatedTab = await chrome.tabs.get(tab.id);
    } catch {
      updatedTab = undefined;
    }
    if (!updatedTab) {
      return this.createSuccessResponse(
        {
          navigationAction: 'reused',
          loadStatus: 'closed',
          tabId: tab.id,
          windowId: tab.windowId,
          url: tab.url,
          note: '标签页已激活，但在返回结果前被关闭',
        },
        'Activated existing tab but it was closed before the result was read',
      );
    }

    return this.createSuccessResponse(
      {
        navigationAction: 'reused',
        loadStatus,
        tabId: updatedTab.id,
        windowId: updatedTab.windowId,
        url: updatedTab.url,
        ...(loadStatus === 'timeout'
          ? { warning: '加载未确认，可用 action="wait" 补等或核验当前页面状态' }
          : {}),
      },
      loadStatus === 'complete'
        ? 'Activated existing tab with target URL and load complete'
        : 'Activated existing tab; page load unconfirmed, verify current page state',
    );
  }

  /**
   * 在当前标签页或新标签页中导航
   */
  private async navigateInCurrentOrNewTab(
    url: string,
    waitForLoad: boolean,
    timeout: number,
  ): Promise<ToolResult> {
    // 尝试获取当前活动标签页
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (activeTab && activeTab.id !== undefined) {
      // 在当前活动标签页中导航
      return await this.navigateInTab(activeTab.id, url, waitForLoad, timeout, activeTab.url);
    } else {
      // 没有活动标签页，创建新标签页
      return await this.createNewTabWithUrl(url, waitForLoad, timeout);
    }
  }

  /**
   * 在指定标签页中导航：URL 变化检测 + 就绪等待共用同一超时预算
   */
  private async navigateInTab(
    tabId: number,
    targetUrl: string,
    waitForLoad: boolean,
    timeout: number,
    currentUrl?: string,
  ): Promise<ToolResult> {
    this.log(`Navigating tab ${tabId} to: ${targetUrl}, current URL: ${currentUrl || 'unknown'}`);
    const startedAt = Date.now();

    // 记录导航前的 URL（回读失败/空值时退回已知 currentUrl，不让空值读出
    // TypeError 污染错误面——真正的标签页缺失会在后续 tabs.update 处以
    // 底层可读错误暴露）
    const originalUrl = currentUrl || (await chrome.tabs.get(tabId).catch(() => undefined))?.url || '';
    const normalizedOriginalUrl = this.normalizeUrlForComparison(originalUrl);
    const normalizedTargetUrl = this.normalizeUrlForComparison(targetUrl);

    // 如果目标 URL 和当前 URL 相同，直接返回
    if (normalizedOriginalUrl === normalizedTargetUrl) {
      this.log(`URL unchanged, skipping navigation: ${targetUrl}`);

      if (waitForLoad) {
        await this.waitForPageLoad(tabId, timeout);
      }

      let tab: chrome.tabs.Tab | undefined;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        tab = undefined;
      }
      if (!tab) {
        return this.createErrorResponse(`标签页 ${tabId} 在确认期间被关闭，未能完成导航确认`);
      }
      return this.createSuccessResponse({
        navigationAction: 'unchanged',
        loadStatus: waitForLoad ? 'complete' : 'not_waited',
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url,
      }, 'Tab already at target URL');
    }

    // 发起导航
    this.log(`Issuing navigation command for tab ${tabId}`);
    await chrome.tabs.update(tabId, { url: targetUrl });

    if (!waitForLoad) {
      // 不等待加载，直接返回
      let tab: chrome.tabs.Tab | undefined;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        tab = undefined;
      }
      if (!tab) {
        return this.createErrorResponse(`标签页 ${tabId} 在发起导航后被关闭，无法回读状态`);
      }
      return this.createSuccessResponse({
        navigationAction: 'navigated',
        loadStatus: 'not_waited',
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url,
      }, 'Navigation initiated (not waiting for load)');
    }

    // 关键步骤：先等待 URL 变化
    this.log(`Waiting for URL to change from: ${normalizedOriginalUrl}`);
    const urlChangeResult = await this.waitForUrlChange(
      tabId,
      originalUrl,
      Math.min(10000, timeout), // URL 变化超时：最多 10 秒
    );

    if (!urlChangeResult.changed) {
      // URL 没有变化，导航可能失败
      this.log(`URL did not change after navigation attempt`, 'warn');

      // 检查标签页状态
      try {
        const tab = await chrome.tabs.get(tabId);
        return this.createSuccessResponse({
          navigationAction: 'navigated',
          loadStatus: 'unknown',
          tabId: tab.id,
          windowId: tab.windowId,
          url: tab.url,
          warning: 'URL did not change, navigation may have failed',
        }, 'Navigation completed but URL unchanged');
      } catch (error) {
        return this.createErrorResponse('Tab was closed during navigation');
      }
    }

    this.log(`URL changed successfully to: ${urlChangeResult.currentUrl}`);

    // URL 已变化，现在等待页面加载完成（与 URL 变化共用同一超时预算）
    const remainingTimeout = Math.max(0, timeout - (Date.now() - startedAt));
    let loadStatus: 'complete' | 'timeout' | 'closed' = 'timeout';
    if (remainingTimeout > 0) {
      try {
        await this.waitForPageLoad(tabId, remainingTimeout);
        loadStatus = 'complete';
      } catch (loadError) {
        // 未知错误上抛（外层 catch 封装）；closed → 跳转已发出但标签页消失
        const kind = this.classifyWaitError(loadError);
        if (kind === 'closed') {
          return this.createSuccessResponse(
            {
              navigationAction: 'navigated',
              loadStatus: 'closed',
              tabId,
              note: 'URL 已跳转，但标签页在加载等待期间被关闭',
            },
            'Navigation issued but the tab was closed while loading',
          );
        }
        this.log(`Page load timeout after URL changed: ${loadError}`, 'warn');
      }
    }

    let finalTab: chrome.tabs.Tab | undefined;
    try {
      finalTab = await chrome.tabs.get(tabId);
    } catch {
      finalTab = undefined;
    }
    if (!finalTab) {
      return this.createSuccessResponse(
        {
          navigationAction: 'navigated',
          loadStatus: 'closed',
          tabId,
          note: 'URL 已跳转，但标签页在返回结果前被关闭',
        },
        'Navigation issued but the tab was closed before the result was read',
      );
    }

    return this.createSuccessResponse(
      {
        navigationAction: 'navigated',
        loadStatus,
        tabId: finalTab.id,
        windowId: finalTab.windowId,
        url: finalTab.url,
        ...(loadStatus === 'timeout'
          ? { warning: '加载未确认，可用 action="wait" 补等或核验当前页面状态' }
          : {}),
      },
      loadStatus === 'complete'
        ? 'Navigated to URL in current tab and load complete'
        : 'URL changed; page load unconfirmed, verify current page state',
    );
  }

  /**
   * 创建新标签页并导航（绑定现有窗口，绝不隐式新建窗口）
   */
  private async createNewTabWithUrl(
    url: string,
    waitForLoad: boolean,
    timeout: number,
  ): Promise<ToolResult> {
    this.log(`Creating new tab with URL: ${url}`);

    let windowId: number;
    try {
      windowId = await existingNavigationWindowId();
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : '没有可用的现有浏览器窗口',
      );
    }

    // 在已存在的窗口中创建新标签页
    const newTab = await chrome.tabs.create({
      url: url,
      windowId: windowId,
      active: true,
    });

    if (!newTab.id) {
      return this.createErrorResponse('Failed to create new tab');
    }

    // 初值随 waitForLoad 决定：不等待时必须如实报 not_waited，绝不能是 complete
    let loadStatus: 'complete' | 'timeout' | 'not_waited' = waitForLoad ? 'complete' : 'not_waited';
    if (waitForLoad) {
      try {
        await this.waitForPageLoad(newTab.id, timeout);
      } catch (waitError) {
        const kind = this.classifyWaitError(waitError);
        if (kind === 'closed') {
          return this.createSuccessResponse(
            {
              navigationAction: 'created',
              loadStatus: 'closed',
              tabId: newTab.id,
              windowId,
              url,
              note: '新标签页已创建并打开 URL，但在加载等待期间被关闭',
            },
            'Opened URL in new tab but the tab was closed while loading',
          );
        }
        this.log(`Wait for load failed: ${waitError}`, 'warn');
        loadStatus = 'timeout';
      }
    }

    await chrome.windows.update(windowId, { focused: true });

    let finalTab: chrome.tabs.Tab | undefined;
    try {
      finalTab = await chrome.tabs.get(newTab.id);
    } catch {
      finalTab = undefined;
    }
    if (!finalTab) {
      return this.createSuccessResponse(
        {
          navigationAction: 'created',
          loadStatus: 'closed',
          tabId: newTab.id,
          windowId,
          url,
          note: '新标签页已创建并打开 URL，但在返回结果前被关闭',
        },
        'Opened URL in new tab but the tab was closed before the result was read',
      );
    }

    return this.createSuccessResponse(
      {
        navigationAction: 'created',
        loadStatus,
        tabId: finalTab.id,
        windowId: windowId,
        url: finalTab.url,
        ...(loadStatus === 'timeout'
          ? { warning: '加载未确认，可用 action="wait" 补等或核验当前页面状态' }
          : {}),
      },
      loadStatus === 'complete' ? 'Opened URL in new tab and load complete' : 'Opened URL in new tab; load unconfirmed',
    );
  }
}

// 导出工具实例
export const browserNavigationTool = new BrowserNavigationTool();

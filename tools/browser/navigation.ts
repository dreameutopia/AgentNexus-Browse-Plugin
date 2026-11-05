/**
 * 导航相关工具
 * 提供页面导航、标签页关闭、历史记录前进后退等功能
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';
import { existingNavigationWindowId } from './navigation-window';

/**
 * 导航互斥锁管理器
 * 确保同时只有一个导航操作在执行
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

  isCurrentlyLocked(): boolean {
    return this.isLocked;
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}

// 全局导航锁实例
const navigationLock = new NavigationLockManager();

/**
 * 导航工具 - 只在现有窗口内导航，默认使用新标签页
 */
export class NavigateTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.NAVIGATE;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.NAVIGATE,
    description: '在现有浏览器窗口的标签页中导航；默认新标签页，不创建浏览器窗口',
    category: 'browser',
    version: '2.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'navigation', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      description: '仅在现有浏览器窗口内打开 URL。默认 newTab=true，新建或复用相同完整URL标签；路径/查询大小写、尾斜杠与hash均可能有业务含义，不忽略。newTab=false 只导航当前标签，不切换到另一个同URL标签；没有当前标签时在现有窗口新建。refresh=true 刷新当前标签。返回实际 tabId、navigationAction 和加载状态，后续用业务反馈确认成功。绝不新建窗口，无可用窗口时返回错误。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: {
            type: 'string',
            description: '要导航到的完整 URL'
          },
          newTab: {
            type: 'boolean',
            default: true,
            description: '是否在现有窗口新建标签页，默认 true；false 使用当前标签页'
          },
          refresh: {
            type: 'boolean',
            description: '是否刷新当前标签页'
          },
          waitForLoad: {
            type: 'boolean',
            description: '是否等待页面加载完成'
          },
          timeout: {
            type: 'number',
            description: '等待超时时间（毫秒）'
          }
        },
        required: []
      }
    }
  };

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

  /**
   * 等待 URL 变化
   * 检测标签页 URL 是否从原始 URL 变化到其他 URL
   */
  private async waitForUrlChange(
    tabId: number, 
    originalUrl: string, 
    timeoutMs: number = 10000,
    pollIntervalMs: number = 100
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

      await new Promise((r) => setTimeout(r, pollIntervalMs));
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
   * 等待页面加载完成
   * 结合 document.readyState 和 tab.status 的双重检查
   */
  private async waitForPageLoad(
    tabId: number, 
    timeoutMs: number = 30000, 
    pollIntervalMs: number = 500
  ): Promise<void> {
    const start = Date.now();
    let consecutiveCompleteChecks = 0;
    const requiredConsecutiveChecks = 2; // 需要连续2次检查都是 complete

    this.log(`Starting to wait for page load on tab ${tabId}`);

    while (Date.now() - start < timeoutMs) {
      try {
        // 首先检查 tab 状态
        const tab = await chrome.tabs.get(tabId);
        
        // 如果标签页还在 loading，重置计数器
        if (tab.status === 'loading') {
          consecutiveCompleteChecks = 0;
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          continue;
        }

        // 尝试执行脚本检查 document.readyState
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => document.readyState,
          });
          
          const state = results?.[0]?.result as DocumentReadyState;
          
          if (state === 'complete' && tab.status === 'complete') {
            consecutiveCompleteChecks++;
            
            if (consecutiveCompleteChecks >= requiredConsecutiveChecks) {
              this.log(`Page load complete after ${Date.now() - start}ms`);
              return;
            }
          } else {
            consecutiveCompleteChecks = 0;
          }
        } catch (scriptError) {
          // 脚本注入失败（可能是特殊页面），仅依赖 tab.status
          if (tab.status === 'complete') {
            consecutiveCompleteChecks++;
            
            if (consecutiveCompleteChecks >= requiredConsecutiveChecks) {
              this.log(`Page load complete (script check failed) after ${Date.now() - start}ms`);
              return;
            }
          } else {
            consecutiveCompleteChecks = 0;
          }
        }
      } catch (error) {
        // 标签页可能已关闭
        this.log(`Error during page load wait: ${error}`, 'warn');
        throw new Error('Tab was closed while waiting for page load');
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(`等待页面加载超时 (${timeoutMs}ms)`);
  }

  async execute(args: {
    url?: string;
    newTab?: boolean;
    refresh?: boolean;
    waitForLoad?: boolean;
    timeout?: number;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    if (!args || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).some(key => !['url','newTab','refresh','waitForLoad','timeout'].includes(key)))
      return createErrorResponse('仅接受 url/newTab/refresh/waitForLoad/timeout；newWindow 已删除，本工具禁止创建浏览器窗口。');
    for (const key of ['newTab','refresh','waitForLoad'] as const)
      if (args[key] !== undefined && typeof args[key] !== 'boolean') return createErrorResponse(`${key} 必须是布尔值`);
    if (args.url !== undefined && (typeof args.url !== 'string' || !args.url.trim())) return createErrorResponse('url 必须是非空字符串');
    if (args.timeout !== undefined && (typeof args.timeout !== 'number' || !Number.isFinite(args.timeout) || args.timeout <= 0)) return createErrorResponse('timeout 必须是大于 0 的有限数字');
    const parameters = structuredClone(args);
    const { url, refresh = false } = parameters;
    
    // 获取锁状态用于日志
    const queueLength = navigationLock.getQueueLength();
    if (queueLength > 0) {
      this.log(`Navigation queued, ${queueLength} requests waiting`);
    }

    // 获取导航锁
    await navigationLock.acquire();
    
    this.log(`[LOCK ACQUIRED] Starting navigation: ${refresh ? 'refresh' : url}`);

    try {
      // 执行实际的导航逻辑
      const result = await this.executeNavigationLocked(parameters);
      return result;
    } finally {
      // 确保始终释放锁
      navigationLock.release();
      this.log(`[LOCK RELEASED] Navigation completed`);
    }
  }

  /**
   * 在持有锁的情况下执行导航
   * 这是实际的导航逻辑实现
   */
  private async executeNavigationLocked(args: {
    url?: string;
    newTab?: boolean;
    refresh?: boolean;
    waitForLoad?: boolean;
    timeout?: number;
  }): Promise<ToolResult> {
    const { newTab = true, url, refresh = false, waitForLoad = true, timeout = 30000 } = args;
    const startTime = Date.now();

    this.log(`Executing navigation: ${refresh ? 'refresh' : `open URL: ${url}`}`);

    try {
      // 处理刷新选项
      if (refresh) {
        return await this.handleRefresh(waitForLoad, timeout);
      }

      if (!url) {
        return createErrorResponse('URL parameter is required when refresh is not true');
      }

      // Explicit current-tab navigation must never activate another matching tab.
      if (!newTab) return await this.navigateInCurrentOrNewTab(url, waitForLoad, timeout, startTime);
      const existingTab = await this.findExistingTabWithUrl(url);
      if (existingTab) return await this.activateExistingTab(existingTab, waitForLoad, timeout);
      return await this.createNewTabWithUrl(url, waitForLoad, timeout);
    } catch (error) {
      this.log(`Navigation failed: ${error}`, 'error');
      return this.createErrorResponse('Failed to navigate', error);
    }
  }

  /**
   * 处理刷新当前标签页
   */
  private async handleRefresh(waitForLoad: boolean, timeout: number): Promise<ToolResult> {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!activeTab || !activeTab.id) {
      return createErrorResponse('No active tab found to refresh');
    }

    const originalUrl = activeTab.url || '';
    this.log(`Refreshing tab ${activeTab.id}, current URL: ${originalUrl}`);

    // 刷新标签页
    await chrome.tabs.reload(activeTab.id);

    if (waitForLoad) {
      // 等待页面重新加载
      await this.waitForPageLoad(activeTab.id, timeout);
    }

    const updatedTab = await chrome.tabs.get(activeTab.id);

    return this.createSuccessResponse({
      navigationAction: 'refreshed',
      loadStatus: waitForLoad ? 'complete' : 'not_waited',
      tabId: updatedTab.id,
      windowId: updatedTab.windowId,
      url: updatedTab.url,
    }, waitForLoad ? 'Successfully refreshed current tab and load complete' : 'Refresh dispatched; load not awaited');
  }

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
    timeout: number
  ): Promise<ToolResult> {
    this.log(`Activating existing tab ${tab.id} with URL: ${tab.url}`);

    if (tab.id === undefined) {
      return createErrorResponse('Invalid tab ID');
    }

    // 激活标签页
    await chrome.tabs.update(tab.id, { active: true });

    // 聚焦窗口
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }

    // 等待页面加载（如果需要）
    if (waitForLoad) {
      await this.waitForPageLoad(tab.id, timeout);
    }

    const updatedTab = await chrome.tabs.get(tab.id);

    return this.createSuccessResponse({
      navigationAction: 'reused',
      loadStatus: waitForLoad ? 'complete' : 'not_waited',
      tabId: updatedTab.id,
      windowId: updatedTab.windowId,
      url: updatedTab.url,
    }, 'Activated existing tab with target URL');
  }

  /**
   * 在当前标签页或新标签页中导航
   */
  private async navigateInCurrentOrNewTab(
    url: string, 
    waitForLoad: boolean, 
    timeout: number,
    startTime: number
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
   * 在指定标签页中导航
   * 这是核心的导航逻辑，包含 URL 变化检测
   */
  private async navigateInTab(
    tabId: number,
    targetUrl: string,
    waitForLoad: boolean,
    timeout: number,
    currentUrl?: string
  ): Promise<ToolResult> {
    this.log(`Navigating tab ${tabId} to: ${targetUrl}, current URL: ${currentUrl || 'unknown'}`);
    const startedAt = Date.now();

    // 记录导航前的 URL
    const originalUrl = currentUrl || (await chrome.tabs.get(tabId)).url || '';
    const normalizedOriginalUrl = this.normalizeUrlForComparison(originalUrl);
    const normalizedTargetUrl = this.normalizeUrlForComparison(targetUrl);

    // 如果目标 URL 和当前 URL 相同，直接返回
    if (normalizedOriginalUrl === normalizedTargetUrl) {
      this.log(`URL unchanged, skipping navigation: ${targetUrl}`);
      
      if (waitForLoad) {
        await this.waitForPageLoad(tabId, timeout);
      }

      const tab = await chrome.tabs.get(tabId);
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
      const tab = await chrome.tabs.get(tabId);
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
      Math.min(10000, timeout) // URL 变化超时：最多 10 秒
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
          warning: 'URL did not change, navigation may have failed'
        }, 'Navigation completed but URL unchanged');
      } catch (error) {
        return createErrorResponse('Tab was closed during navigation');
      }
    }

    this.log(`URL changed successfully to: ${urlChangeResult.currentUrl}`);

    // URL 已变化，现在等待页面加载完成
    const remainingTimeout = Math.max(0, timeout - (Date.now() - startedAt));
    let loadStatus = 'timeout';
    if (remainingTimeout > 0) {
      try { await this.waitForPageLoad(tabId, remainingTimeout); loadStatus = 'complete'; }
      catch (loadError) { this.log(`Page load timeout after URL changed: ${loadError}`, 'warn'); }
    }

    const finalTab = await chrome.tabs.get(tabId);

    return this.createSuccessResponse({
      navigationAction: 'navigated',
      loadStatus,
      tabId: finalTab.id,
      windowId: finalTab.windowId,
      url: finalTab.url,
    }, loadStatus === 'complete' ? 'Navigated to URL in current tab and load complete' : 'URL changed; page load unconfirmed, verify current page state');
  }

  /**
   * 创建新标签页并导航
   */
  private async createNewTabWithUrl(
    url: string, 
    waitForLoad: boolean, 
    timeout: number
  ): Promise<ToolResult> {
    this.log(`Creating new tab with URL: ${url}`);

    const windowId = await existingNavigationWindowId();

    // 在已存在的窗口中创建新标签页
    const newTab = await chrome.tabs.create({
      url: url,
      windowId: windowId,
      active: true,
    });

    if (!newTab.id) {
      return createErrorResponse('Failed to create new tab');
    }

    let loadStatus = 'not_waited';
    if (waitForLoad) {
      try {
        await this.waitForPageLoad(newTab.id, timeout);
        loadStatus = 'complete';
      } catch (waitError) {
        loadStatus = 'timeout';
        this.log(`Wait for load failed: ${waitError}`, 'warn');
      }
    }

    await chrome.windows.update(windowId, { focused: true });

    const finalTab = await chrome.tabs.get(newTab.id);

    return this.createSuccessResponse({
      navigationAction: 'created',
      loadStatus,
      tabId: finalTab.id,
      windowId: windowId,
      url: finalTab.url,
    }, 'Opened URL in new tab');
  }
}

/**
 * 关闭标签页工具
 */
export class CloseTabsTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.CLOSE_TABS;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.CLOSE_TABS,
    description: '关闭指定的浏览器标签页',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'tabs', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.CLOSE_TABS,
      description: '关闭指定的浏览器标签页',
      parameters: {
        type: 'object',
        properties: {
          tabIds: {
            type: 'array',
            items: { type: 'number' },
            description: '要关闭的标签页 ID 列表'
          },
          url: {
            type: 'string',
            description: '关闭匹配此 URL 的所有标签页'
          }
        },
        required: []
      }
    }
  };

  async execute(args: {
    tabIds?: number[];
    url?: string;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const { tabIds, url } = args;
    let urlPattern = url;

    this.log(`Attempting to close tabs with tabIds: ${tabIds}, url: ${url}`);

    try {
      // Close tabs by URL
      if (urlPattern) {
        if (!urlPattern.endsWith('/')) {
          urlPattern += '/*';
        }
        const tabs = await chrome.tabs.query({ url: urlPattern });

        if (!tabs || tabs.length === 0) {
          return this.createSuccessResponse({
            closedCount: 0,
          }, `No tabs found with URL: ${url}`);
        }

        const tabIdsToClose = tabs
          .map((tab) => tab.id)
          .filter((id): id is number => id !== undefined);

        if (tabIdsToClose.length === 0) {
          return createErrorResponse('Found tabs but could not get their IDs');
        }

        await chrome.tabs.remove(tabIdsToClose);

        return this.createSuccessResponse({
          closedCount: tabIdsToClose.length,
          closedTabIds: tabIdsToClose,
        }, `Closed ${tabIdsToClose.length} tabs with URL: ${url}`);
      }

      // Close tabs by IDs
      if (tabIds && tabIds.length > 0) {
        const existingTabs = await Promise.all(
          tabIds.map(async (tabId) => {
            try {
              return await chrome.tabs.get(tabId);
            } catch (error) {
              this.log(`Tab with ID ${tabId} not found`, 'warn');
              return null;
            }
          }),
        );

        const validTabIds = existingTabs
          .filter((tab): tab is chrome.tabs.Tab => tab !== null)
          .map((tab) => tab.id)
          .filter((id): id is number => id !== undefined);

        if (validTabIds.length === 0) {
          return this.createSuccessResponse({
            closedCount: 0,
          }, 'None of the provided tab IDs exist');
        }

        await chrome.tabs.remove(validTabIds);

        return this.createSuccessResponse({
          closedCount: validTabIds.length,
          closedTabIds: validTabIds,
          invalidTabIds: tabIds.filter((id) => !validTabIds.includes(id)),
        }, `Closed ${validTabIds.length} tabs`);
      }

      // Close current active tab
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!activeTab || !activeTab.id) {
        return createErrorResponse('No active tab found');
      }

      await chrome.tabs.remove(activeTab.id);

      return this.createSuccessResponse({
        closedCount: 1,
        closedTabIds: [activeTab.id],
      }, 'Closed active tab');
    } catch (error) {
      return this.createErrorResponse('Failed to close tabs', error);
    }
  }
}

/**
 * 浏览器历史记录前进/后退工具
 */
export class GoBackOrForwardTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.GO_BACK_OR_FORWARD;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.GO_BACK_OR_FORWARD,
    description: '在浏览器历史记录中前进或后退',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'history', 'navigation', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.GO_BACK_OR_FORWARD,
      description: '在浏览器历史记录中前进或后退',
      parameters: {
        type: 'object',
        properties: {
          isForward: {
            type: 'boolean',
            description: '是否前进（true）或后退（false）'
          }
        },
        required: []
      }
    }
  };

  async execute(args: {
    isForward?: boolean;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const { isForward = false } = args;

    this.log(`Navigating ${isForward ? 'forward' : 'back'} in browser history`);

    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!activeTab || !activeTab.id) {
        return createErrorResponse('No active tab found');
      }

      if (isForward) {
        await chrome.tabs.goForward(activeTab.id);
      } else {
        await chrome.tabs.goBack(activeTab.id);
      }

      const updatedTab = await chrome.tabs.get(activeTab.id);

      return this.createSuccessResponse({
        tabId: updatedTab.id,
        windowId: updatedTab.windowId,
        url: updatedTab.url,
      }, `Successfully navigated ${isForward ? 'forward' : 'back'} in browser history`);
    } catch (error) {
      return this.createErrorResponse(`Failed to navigate ${isForward ? 'forward' : 'back'}`, error);
    }
  }
}

// 导出工具实例
export const navigateTool = new NavigateTool();
export const closeTabsTool = new CloseTabsTool();
export const goBackOrForwardTool = new GoBackOrForwardTool();

/**
 * 浏览器工具基类
 * 继承自 BaseTool，并集成 BaseBrowserToolExecutor 的核心功能
 * 专为需要直接访问 Chrome API 的工具设计
 */

import { BaseTool } from '../base-tool';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { existingNavigationWindowId } from '../browser/navigation-window';

const PING_TIMEOUT_MS = 300;

/**
 * 检测是否在 background 环境中
 */
function isBackgroundContext(): boolean {
  return typeof chrome !== 'undefined' && 
    chrome.runtime && 
    typeof chrome.runtime.getManifest === 'function' &&
    typeof globalThis.document === 'undefined';
}

/**
 * 浏览器工具抽象基类
 * 提供 Chrome API 访问能力和内容脚本注入功能
 */
export abstract class BaseBrowserTool extends BaseTool {
  /**
   * 确保工具在 background 环境中运行
   */
  protected ensureBackgroundContext(): void {
    if (!isBackgroundContext()) {
      throw new Error(`[${this.name}] This tool can only run in background context`);
    }
  }

  /**
   * 注入内容脚本到标签页
   */
  protected async injectContentScript(
    tabId: number,
    files: string[],
    injectImmediately = false,
    world: 'MAIN' | 'ISOLATED' = 'ISOLATED',
  ): Promise<void> {
    this.log(`Injecting ${files.join(', ')} into tab ${tabId}`);

    // 检查脚本是否已经注入
    try {
      const response = await Promise.race([
        chrome.tabs.sendMessage(tabId, { action: `${this.name}_ping` }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`${this.name} Ping action to tab ${tabId} timed out`)),
            PING_TIMEOUT_MS,
          ),
        ),
      ]);

      if (response && (response as any).status === 'pong') {
        this.log(
          `pong received for action '${this.name}' in tab ${tabId}. Assuming script is active.`,
        );
        return;
      } else {
        this.log(`Unexpected ping response in tab ${tabId}`, 'warn');
      }
    } catch (error) {
      this.log(
        `ping content script failed: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }

    // 注入脚本
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files,
        injectImmediately,
        world,
      });
      this.log(`'${files.join(', ')}' injection successful for tab ${tabId}`);
    } catch (injectionError) {
      const errorMessage =
        injectionError instanceof Error ? injectionError.message : String(injectionError);
      this.log(
        `Content script '${files.join(', ')}' injection failed for tab ${tabId}: ${errorMessage}`,
        'error'
      );
      throw new Error(
        `${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: Failed to inject content script in tab ${tabId}: ${errorMessage}`,
      );
    }
  }

  /**
   * 向标签页发送消息
   */
  protected async sendMessageToTab(tabId: number, message: any): Promise<any> {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);

      if (response && response.error) {
        throw new Error(String(response.error));
      }

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(
        `Error sending message to tab ${tabId} for action ${message?.action || 'unknown'}: ${errorMessage}`,
        'error'
      );

      if (error instanceof Error) {
        throw error;
      }
      throw new Error(errorMessage);
    }
  }

  /**
   * 获取当前活动标签页
   */
  protected async getActiveTab(): Promise<chrome.tabs.Tab> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error('No active tab found');
    }
    return tab;
  }

  /**
   * 等待标签页加载完成
   */
  protected async waitForTabComplete(tabId: number, timeout: number = 30000): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    throw new Error(`Tab ${tabId} did not complete loading within ${timeout}ms`);
  }

  /**
   * 创建新标签页
   */
  protected async createTab(url: string, active: boolean = true): Promise<chrome.tabs.Tab> {
    const tab = await chrome.tabs.create({ url, active, windowId: await existingNavigationWindowId() });
    if (!tab || !tab.id) {
      throw new Error('Failed to create tab');
    }
    return tab;
  }

  /**
   * 更新标签页 URL
   */
  protected async updateTab(tabId: number, url: string): Promise<chrome.tabs.Tab> {
    const tab = await chrome.tabs.update(tabId, { url });
    if (!tab) {
      throw new Error(`Failed to update tab ${tabId}`);
    }
    return tab;
  }

  /**
   * 关闭标签页
   */
  protected async closeTab(tabId: number): Promise<void> {
    await chrome.tabs.remove(tabId);
  }

  /**
   * 查询标签页
   */
  protected async queryTabs(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
    return await chrome.tabs.query(queryInfo);
  }

  /**
   * 获取标签页信息
   */
  protected async getTab(tabId: number): Promise<chrome.tabs.Tab> {
    return await chrome.tabs.get(tabId);
  }
}

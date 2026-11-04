/**
 * 控制台工具
 * 捕获浏览器控制台日志（原「截图工具 browser_screenshot」已下线：
 * 视觉截图统一由 tools/vision/screenshot-tool.ts 的 screenshot 提供）
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';

/**
 * 控制台工具 - 捕获浏览器控制台输出
 */
export class ConsoleTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.CONSOLE;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.CONSOLE,
    description: '捕获浏览器控制台输出和异常信息',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'console', 'debug', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.CONSOLE,
      description: '捕获浏览器控制台输出和异常信息',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要监控的 URL（可选，默认当前标签页）'
          },
          includeExceptions: {
            type: 'boolean',
            description: '是否包含异常信息'
          },
          maxMessages: {
            type: 'number',
            description: '最大消息数量'
          }
        },
        required: []
      }
    }
  };

  async execute(args: {
    url?: string;
    includeExceptions?: boolean;
    maxMessages?: number;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const { url, includeExceptions = true, maxMessages = 100 } = args;

    this.log(`Capturing console output`);

    try {
      let targetTab: chrome.tabs.Tab;

      if (url) {
        targetTab = await this.navigateToUrl(url, { waitForLoad: true });
      } else {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab?.id) {
          return createErrorResponse('No active tab found');
        }
        targetTab = activeTab;
      }

      if (!targetTab?.id) {
        return createErrorResponse('Failed to identify target tab');
      }

      const tabId = targetTab.id;
      const captureStartTime = Date.now();
      const messages: any[] = [];
      const exceptions: any[] = [];

      // 附加调试器
      await chrome.debugger.attach({ tabId }, '1.3');

      try {
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
        await chrome.debugger.sendCommand({ tabId }, 'Log.enable');

        // 监听控制台消息
        const listener = (source: chrome.debugger.Debuggee, method: string, params?: any) => {
          if (source.tabId === tabId) {
            if (method === 'Runtime.consoleAPICalled') {
              messages.push({
                timestamp: Date.now(),
                level: params.type,
                text: params.args?.map((arg: any) => arg.value || String(arg)).join(' ') || '',
              });
            } else if (method === 'Runtime.exceptionThrown' && includeExceptions) {
              exceptions.push({
                timestamp: Date.now(),
                text: params.exceptionDetails?.text || 'Unknown exception',
              });
            }
          }
        };

        chrome.debugger.onEvent.addListener(listener);

        // 等待一段时间收集消息
        await new Promise((resolve) => setTimeout(resolve, 2000));

        chrome.debugger.onEvent.removeListener(listener);

        await chrome.debugger.sendCommand({ tabId }, 'Runtime.disable');
        await chrome.debugger.sendCommand({ tabId }, 'Log.disable');
      } finally {
        await chrome.debugger.detach({ tabId });
      }

      const captureEndTime = Date.now();

      return this.createSuccessResponse({
        tabId,
        tabUrl: targetTab.url,
        tabTitle: targetTab.title,
        captureStartTime,
        captureEndTime,
        totalDurationMs: captureEndTime - captureStartTime,
        messages: messages.slice(0, maxMessages),
        exceptions: exceptions.slice(0, maxMessages),
        messageCount: messages.length,
        exceptionCount: exceptions.length,
        messageLimitReached: messages.length > maxMessages,
      }, `Captured ${messages.length} console messages and ${exceptions.length} exceptions`);
    } catch (error) {
      return this.createErrorResponse('Console capture failed', error);
    }
  }

  private async navigateToUrl(url: string, options?: { waitForLoad?: boolean }): Promise<chrome.tabs.Tab> {
    const existingTabs = await chrome.tabs.query({ url });

    if (existingTabs.length > 0 && existingTabs[0]?.id) {
      const tab = existingTabs[0];
      await chrome.tabs.update(tab.id!, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return tab;
    } else {
      const newTab = await chrome.tabs.create({ url, active: true });
      if (options?.waitForLoad && newTab.id) {
        await this.waitForTabComplete(newTab.id);
      }
      return newTab;
    }
  }
}

// 导出工具实例
export const consoleTool = new ConsoleTool();

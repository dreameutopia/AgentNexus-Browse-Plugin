/**
 * 截图和控制台工具
 * 提供截图捕获和控制台日志捕获功能
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';

/**
 * 截图工具 - 捕获网页截图
 */
export class ScreenshotTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.SCREENSHOT;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.SCREENSHOT,
    description: '捕获网页截图（可见区域、全页面或特定元素）',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'screenshot', 'capture', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.SCREENSHOT,
      description: '捕获网页截图（可见区域、全页面或特定元素）',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '截图文件名'
          },
          selector: {
            type: 'string',
            description: 'CSS 选择器，用于捕获特定元素'
          },
          width: {
            type: 'number',
            description: '截图宽度'
          },
          height: {
            type: 'number',
            description: '截图高度'
          },
          storeBase64: {
            type: 'boolean',
            description: '是否返回 base64 编码的图片数据'
          },
          fullPage: {
            type: 'boolean',
            description: '是否捕获整个页面'
          },
          savePng: {
            type: 'boolean',
            description: '是否保存为 PNG 文件'
          },
          maxHeight: {
            type: 'number',
            description: '最大捕获高度（像素）'
          }
        },
        required: ['name']
      }
    }
  };

  async execute(args: {
    name: string;
    selector?: string;
    width?: number;
    height?: number;
    storeBase64?: boolean;
    fullPage?: boolean;
    savePng?: boolean;
    maxHeight?: number;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const {
      name = 'screenshot',
      selector,
      storeBase64 = false,
      fullPage = false,
      savePng = true,
    } = args;

    this.log(`Starting screenshot: ${name}`);

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        return createErrorResponse('No active tab found');
      }
      const tab = tabs[0];

      if (
        tab.url?.startsWith('chrome://') ||
        tab.url?.startsWith('edge://') ||
        tab.url?.startsWith('https://chrome.google.com/webstore')
      ) {
        return createErrorResponse('Cannot capture special browser pages due to security restrictions.');
      }

      await this.injectContentScript(tab.id!, ['inject-scripts/vision/screenshot-helper.js']);
      await new Promise((resolve) => setTimeout(resolve, 200));

      await this.sendMessageToTab(tab.id!, {
        action: TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE,
        options: { fullPage },
      });

      let imageDataUrl: string;

      if (fullPage) {
        // 简化实现：仅捕获可见区域
        imageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      } else if (selector) {
        // 捕获特定元素
        const result = await this.sendMessageToTab(tab.id!, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_GET_ELEMENT_DETAILS,
          selector,
        });
        imageDataUrl = result.dataUrl || await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      } else {
        // 可见区域
        imageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      }

      if (storeBase64) {
        const base64Data = imageDataUrl.replace(/^data:image\/[^;]+;base64,/, '');
        return this.createSuccessResponse({
          base64Data,
          mimeType: 'image/png',
        }, 'Screenshot captured as base64');
      }

      if (savePng) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${name.replace(/[^a-z0-9_-]/gi, '_')}_${timestamp}.png`;

        const downloadId = await chrome.downloads.download({
          url: imageDataUrl,
          filename: filename,
          saveAs: false,
        });

        return this.createSuccessResponse({
          downloadId,
          filename,
        }, `Screenshot saved as ${filename}`);
      }

      return this.createSuccessResponse({
        dataUrl: imageDataUrl,
      }, 'Screenshot captured successfully');
    } catch (error) {
      return this.createErrorResponse('Screenshot capture failed', error);
    }
  }
}

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
export const screenshotTool = new ScreenshotTool();
export const consoleTool = new ConsoleTool();

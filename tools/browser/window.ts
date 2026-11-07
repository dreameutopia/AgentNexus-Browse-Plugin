/**
 * 窗口管理工具
 * 提供浏览器窗口和标签页信息获取功能
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';

/**
 * 窗口工具 - 获取所有窗口和标签页信息
 */
export class WindowTool extends BaseBrowserTool {
  name = 'browser_window';

  metadata: ToolMetadata = {
    name: 'browser_window',
    description: '获取所有浏览器窗口和标签页信息',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'window', 'tabs', 'chrome'],
    // 纯读（chrome.windows.getAll 枚举）：不改变窗口/视口状态，视觉循环无需重拍
    noVisionRecapture: true
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_window',
      description: '获取所有浏览器窗口和标签页信息',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  };

  async execute(): Promise<ToolResult> {
    this.ensureBackgroundContext();

    try {
      const windows = await chrome.windows.getAll({ populate: true });
      let tabCount = 0;

      const structuredWindows = windows.map((window) => {
        const tabs =
          window.tabs?.map((tab) => {
            tabCount++;
            return {
              tabId: tab.id || 0,
              url: tab.url || '',
              title: tab.title || '',
              active: tab.active || false,
            };
          }) || [];

        return {
          windowId: window.id || 0,
          tabs: tabs,
        };
      });

      return this.createSuccessResponse({
        windowCount: windows.length,
        tabCount: tabCount,
        windows: structuredWindows,
      }, `Found ${windows.length} windows with ${tabCount} tabs`);
    } catch (error) {
      return this.createErrorResponse('Failed to get windows and tabs information', error);
    }
  }
}

// 导出工具实例
export const windowTool = new WindowTool();

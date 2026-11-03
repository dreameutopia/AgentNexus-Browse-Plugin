/**
 * 标签页管理工具
 * 提供标签页切换、关闭、创建等功能
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { existingNavigationWindowId } from './navigation-window';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';

/**
 * 切换标签页工具
 */
export class SwitchToTabTool extends BaseBrowserTool {
  name = 'browser_switch_tab';

  metadata: ToolMetadata = {
    name: 'browser_switch_tab',
    description: '切换到指定的标签页',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'tab', 'switch']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_switch_tab',
      description: '切换到指定的标签页',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '要切换到的标签页 ID'
          }
        },
        required: ['tabId']
      }
    }
  };

  async execute(args: { tabId: number }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    try {
      this.validateArgs(args, ['tabId']);

      const tab = await chrome.tabs.get(args.tabId);
      
      if (!tab) {
        return this.createErrorResponse('Tab not found');
      }

      await chrome.tabs.update(args.tabId, { active: true });

      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }

      return this.createSuccessResponse({
        tabId: args.tabId,
        url: tab.url,
        title: tab.title,
        windowId: tab.windowId
      }, 'Successfully switched to tab');
    } catch (error) {
      return this.createErrorResponse('Failed to switch tab', error);
    }
  }
}

/**
 * 关闭标签页工具
 */
export class CloseTabTool extends BaseBrowserTool {
  name = 'browser_close_tab';

  metadata: ToolMetadata = {
    name: 'browser_close_tab',
    description: '关闭指定的标签页',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'tab', 'close']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_close_tab',
      description: '关闭指定的标签页',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '要关闭的标签页 ID'
          }
        },
        required: ['tabId']
      }
    }
  };

  async execute(args: { tabId: number }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    try {
      this.validateArgs(args, ['tabId']);

      await chrome.tabs.remove(args.tabId);

      return this.createSuccessResponse({
        tabId: args.tabId
      }, 'Tab closed successfully');
    } catch (error) {
      return this.createErrorResponse('Failed to close tab', error);
    }
  }
}

/**
 * 创建标签页工具
 */
export class CreateTabTool extends BaseBrowserTool {
  name = 'browser_create_tab';

  metadata: ToolMetadata = {
    name: 'browser_create_tab',
    description: '创建新标签页',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'tab', 'create']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_create_tab',
      description: '创建新标签页',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '新标签页要打开的 URL（可选）'
          },
          active: {
            type: 'boolean',
            description: '是否激活新标签页（可选，默认 true）'
          }
        },
        required: []
      }
    }
  };

  async execute(args: { url?: string; active?: boolean }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    try {
      const tab = await chrome.tabs.create({
        windowId: await existingNavigationWindowId(),
        url: args.url,
        active: args.active !== false
      });

      return this.createSuccessResponse({
        tabId: tab.id,
        url: tab.url,
        windowId: tab.windowId
      }, 'Tab created successfully');
    } catch (error) {
      return this.createErrorResponse('Failed to create tab', error);
    }
  }
}

// 导出工具实例
export const switchToTabTool = new SwitchToTabTool();
export const closeTabTool = new CloseTabTool();
export const createTabTool = new CreateTabTool();

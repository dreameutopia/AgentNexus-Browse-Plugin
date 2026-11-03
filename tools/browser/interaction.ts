/**
 * 交互相关工具
 * 提供点击、填充表单、键盘输入等页面交互功能
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';
import { TOOL_NAMES, TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';

// 点击/填充已由 enhance_click / enhance_fill（内联 payload、frameId 精确定向 iframe）承担，
// browser_click / browser_fill（content-script 消息通道）已下线。

/**
 * 键盘输入工具 - 模拟键盘输入
 */
export class KeyboardTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.KEYBOARD;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.KEYBOARD,
    description: '模拟键盘输入',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'interaction', 'keyboard', 'input', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.KEYBOARD,
      description: '模拟键盘输入',
      parameters: {
        type: 'object',
        properties: {
          keys: {
            type: 'string',
            description: '要模拟的按键或按键组合（如 "Enter", "Ctrl+C"）'
          },
          selector: {
            type: 'string',
            description: '目标元素的 CSS 选择器（可选）'
          },
          delay: {
            type: 'number',
            description: '按键之间的延迟（毫秒）'
          }
        },
        required: ['keys']
      }
    }
  };

  async execute(args: {
    keys: string;
    selector?: string;
    delay?: number;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const { keys, selector, delay = TIMEOUTS.KEYBOARD_DELAY } = args;

    this.log(`Starting keyboard operation with keys: ${keys}`);

    if (!keys) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Keys parameter must be provided',
      );
    }

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND);
      }

      const tab = tabs[0];
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      await this.injectContentScript(tab.id, ['inject-scripts/interaction/keyboard-helper.js']);

      const result = await this.sendMessageToTab(tab.id, {
        action: TOOL_MESSAGE_TYPES.SIMULATE_KEYBOARD,
        keys,
        selector,
        delay,
      });

      if (result.error) {
        return createErrorResponse(result.error);
      }

      return this.createSuccessResponse({
        targetElement: result.targetElement,
        results: result.results,
      }, result.message || 'Keyboard operation successful');
    } catch (error) {
      return this.createErrorResponse('Keyboard operation failed', error);
    }
  }
}

// 导出工具实例
export const keyboardTool = new KeyboardTool();

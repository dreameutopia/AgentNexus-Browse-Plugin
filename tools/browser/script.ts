/**
 * 脚本注入和执行工具
 * 提供脚本注入、执行、命令发送等功能
 *
 * 注意：browser_inject_script 的执行能力已统一收敛到「页面执行引擎」
 * （browser_page_exec，见 page-exec-tool.ts）。本工具保留原有名称与
 * 返回形态以兼容既有调用方（prompt 预设、UI 工具列表等），执行时委托
 * 引擎从而自动获得：严格 CSP 站点的 CDP 通道升级、隔离世界回退、
 * 有界序列化等增强能力。
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';
import { pageExecTool } from './page-exec-tool';

/**
 * 脚本注入工具（浏览器执行引擎兼容入口）
 */
export class InjectScriptTool extends BaseBrowserTool {
  name = 'browser_inject_script';

  metadata: ToolMetadata = {
    name: 'browser_inject_script',
    description: '向页面注入自定义脚本',
    category: 'browser',
    version: '1.2.0',
    author: 'AgentNexus',
    tags: ['browser', 'script', 'inject', 'chrome'],
    displayName: '脚本注入（兼容入口）',
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_inject_script',
      description:
        '在当前页面注入并执行 JavaScript 代码，等同于在 F12 控制台中运行代码（返回 Promise 的表达式会等待其完成，最长 10 秒）。' +
        '在严格 CSP 网站上 eval 被拒时会自动升级到 CDP 通道重试。需要参数传递/强制最高权限时请改用 browser_page_exec。',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: '要执行的 JavaScript 代码'
          }
        },
        required: ['code']
      }
    }
  };

  async execute(args: {
    code: string;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const { code } = args;

    if (!code || typeof code !== 'string' || !code.trim()) {
      return createErrorResponse('Parameter [code] is required and must be a non-empty string');
    }

    this.log(`Executing script in current tab`);

    // 委托统一页面执行引擎（MAIN 世界优先 + CSP 严格站点自动升级 CDP + ISOLATED 兜底）
    const result = await pageExecTool.execute({
      code,
      world: 'MAIN',
      strategy: 'auto',
    });

    if (!result.success) {
      return result;
    }

    // 保持历史返回形态：{ tabId, result, type, code }
    const data = result.data || {};
    return this.createSuccessResponse(
      {
        tabId: data.tabId,
        result: data.result,
        type: data.resultType,
        code,
      },
      'Script executed successfully',
    );
  }
}

/**
 * 发送命令到已注入脚本
 */
export class SendCommandToInjectScriptTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.SEND_COMMAND_TO_INJECT_SCRIPT;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.SEND_COMMAND_TO_INJECT_SCRIPT,
    description: '向已注入的脚本发送命令',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'script', 'command', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.SEND_COMMAND_TO_INJECT_SCRIPT,
      description: '向已注入的脚本发送命令',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '标签页 ID（可选，默认当前标签页）'
          },
          eventName: {
            type: 'string',
            description: '事件名称'
          },
          payload: {
            type: 'string',
            description: '命令载荷（JSON 字符串）'
          }
        },
        required: ['eventName']
      }
    }
  };

  async execute(args: {
    tabId?: number;
    eventName: string;
    payload?: string;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const { tabId, eventName, payload } = args;

    if (!eventName || typeof eventName !== 'string') {
      return createErrorResponse('Parameter [eventName] is required and must be a non-empty string');
    }

    this.log(`Sending command ${eventName} to injected script`);

    try {
      // 防御性解析：无效 JSON 直接给出可定位的错误，而非笼统的发送失败
      let parsedPayload: unknown;
      if (payload) {
        try {
          parsedPayload = JSON.parse(payload);
        } catch {
          return createErrorResponse(`Parameter [payload] is not valid JSON: ${payload.slice(0, 200)}`);
        }
      }

      const targetTabId = tabId ?? (await this.getActiveTab()).id!;

      const result = await this.sendMessageToTab(targetTabId, {
        action: eventName,
        payload: parsedPayload,
      });

      return this.createSuccessResponse({
        tabId: targetTabId,
        eventName,
        result,
      }, 'Command sent successfully');
    } catch (error) {
      return this.createErrorResponse('Failed to send command', error);
    }
  }
}

// 导出工具实例
export const injectScriptTool = new InjectScriptTool();
export const sendCommandToInjectScriptTool = new SendCommandToInjectScriptTool();

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';

/** 向内容脚本发送命令，与页面脚本求值不同。 */
export class SendCommandToInjectScriptTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.SEND_COMMAND_TO_INJECT_SCRIPT;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.SEND_COMMAND_TO_INJECT_SCRIPT,
    description: '向已注入的脚本发送命令',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'script', 'command', 'chrome'],
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
            description: '标签页 ID（可选，默认当前标签页）',
          },
          eventName: {
            type: 'string',
            description: '事件名称',
          },
          payload: {
            type: 'string',
            description: '命令载荷（JSON 字符串）',
          },
        },
        required: ['eventName'],
      },
    },
  };

  async execute(args: {
    tabId?: number;
    eventName: string;
    payload?: string;
  }, context?: ToolExecutionContext): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const { tabId, eventName, payload } = args;

    if (!eventName || typeof eventName !== 'string') {
      return createErrorResponse(
        'Parameter [eventName] is required and must be a non-empty string'
      );
    }

    this.log(`Sending command ${eventName} to injected script`);

    try {
      // 防御性解析：无效 JSON 直接给出可定位的错误，而非笼统的发送失败
      let parsedPayload: unknown;
      if (payload) {
        try {
          parsedPayload = JSON.parse(payload);
        } catch {
          return createErrorResponse(
            `Parameter [payload] is not valid JSON: ${payload.slice(0, 200)}`
          );
        }
      }

      const targetTabId = tabId ?? (await this.getActiveTab()).id!;

      if (tabId !== undefined) context?.onTabTarget?.(targetTabId);
      const result = await this.sendMessageToTab(targetTabId, {
        action: eventName,
        payload: parsedPayload,
      });

      return this.createSuccessResponse(
        {
          tabId: targetTabId,
          eventName,
          result,
        },
        'Command sent successfully'
      );
    } catch (error) {
      return this.createErrorResponse('Failed to send command', error);
    }
  }
}

// 导出工具实例

export const sendCommandToInjectScriptTool =
  new SendCommandToInjectScriptTool();

/**
 * 网络请求工具
 * 提供网络请求、网络捕获等功能
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';
import { CONFIRM_GUIDANCE, CONFIRM_PARAMETER_DESCRIPTION } from '../confirmation-policy';

/**
 * 网络请求工具 - 发送 HTTP 请求
 */
export class NetworkRequestTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.NETWORK_REQUEST;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.NETWORK_REQUEST,
    description: '发送 HTTP 网络请求（GET/POST 等）',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    requiresConfirm: true,
    tags: ['browser', 'network', 'http', 'request', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.NETWORK_REQUEST,
      description: '发送 HTTP 网络请求（GET/POST 等）。公开 API 和普通数据读取不需要确认；HTTP 方法本身不决定风险。' + CONFIRM_GUIDANCE,
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '请求的 URL'
          },
          method: {
            type: 'string',
            description: 'HTTP 方法（GET, POST, PUT, DELETE 等）'
          },
          headers: {
            type: 'object',
            description: '请求头'
          },
          body: {
            type: 'string',
            description: '请求体（对于 POST/PUT 请求）'
          },
          description: {
            type: 'string',
            description: '本次请求的目标和实际用途，不含密钥、Token 等明文凭据',
          },
          confirm: {
            type: 'boolean',
            description: CONFIRM_PARAMETER_DESCRIPTION,
          }
        },
        required: ['url']
      }
    }
  };

  async execute(args: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    description?: string;
    confirm?: boolean;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const { url, method = 'GET', headers = {}, body } = args;

    this.log(`Sending ${method} request to ${url}`);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? body : undefined,
      });

      const responseText = await response.text();

      return this.createSuccessResponse({
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseText,
      }, `Request to ${url} completed with status ${response.status}`);
    } catch (error) {
      return this.createErrorResponse('Network request failed', error);
    }
  }
}

export const networkRequestTool = new NetworkRequestTool();

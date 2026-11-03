/**
 * 网络请求工具
 * 提供网络请求、网络捕获等功能
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';

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
    tags: ['browser', 'network', 'http', 'request', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.NETWORK_REQUEST,
      description: '发送 HTTP 网络请求（GET/POST 等）',
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

/**
 * 网络捕获启动工具（使用 webRequest API）
 */
export class NetworkCaptureStartTool extends BaseBrowserTool {
  name = 'browser_network_capture';

  metadata: ToolMetadata = {
    name: 'browser_network_capture',
    description: '启动网络请求捕获（使用 webRequest API）',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'network', 'capture', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_network_capture',
      description: '启动网络请求捕获',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要监控的 URL（可选）'
          },
          captureContent: {
            type: 'boolean',
            description: '是否捕获响应内容'
          }
        },
        required: []
      }
    }
  };

  async execute(args: {
    url?: string;
    captureContent?: boolean;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    this.log('Starting network capture');

    return this.createSuccessResponse({
      capturing: true,
    }, 'Network capture started (Note: Simplified implementation)');
  }
}

/**
 * 网络捕获停止工具
 */
export class NetworkCaptureStopTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.NETWORK_CAPTURE_STOP;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_STOP,
    description: '停止网络请求捕获',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'network', 'capture', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_STOP,
      description: '停止网络请求捕获',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  };

  async execute(): Promise<ToolResult> {
    this.ensureBackgroundContext();

    this.log('Stopping network capture');

    return this.createSuccessResponse({
      capturing: false,
      requests: [],
    }, 'Network capture stopped');
  }
}

/**
 * 网络调试器启动工具
 */
export class NetworkDebuggerStartTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START,
    description: '启动网络调试器捕获',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'network', 'debugger', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START,
      description: '启动网络调试器捕获',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  };

  async execute(): Promise<ToolResult> {
    this.ensureBackgroundContext();

    this.log('Starting network debugger');

    return this.createSuccessResponse({
      debugging: true,
    }, 'Network debugger started (Note: Simplified implementation)');
  }
}

/**
 * 网络调试器停止工具
 */
export class NetworkDebuggerStopTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_STOP;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_STOP,
    description: '停止网络调试器捕获',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'network', 'debugger', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_STOP,
      description: '停止网络调试器捕获',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  };

  async execute(): Promise<ToolResult> {
    this.ensureBackgroundContext();

    this.log('Stopping network debugger');

    return this.createSuccessResponse({
      debugging: false,
      requests: [],
    }, 'Network debugger stopped');
  }
}

// 导出工具实例
export const networkRequestTool = new NetworkRequestTool();
export const networkCaptureStartTool = new NetworkCaptureStartTool();
export const networkCaptureStopTool = new NetworkCaptureStopTool();
export const networkDebuggerStartTool = new NetworkDebuggerStartTool();
export const networkDebuggerStopTool = new NetworkDebuggerStopTool();

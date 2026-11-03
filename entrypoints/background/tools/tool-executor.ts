/**
 * 工具执行处理器
 * 负责处理来自服务器的工具执行请求，并返回执行结果
 */

import {
  WebSocketMessage,
  MessageType,
  ToolExecutionPayload,
  ToolExecutionResponsePayload,
} from '../ws/websocket-types';
import { WebSocketClient } from '../ws/websocket-client';
import { toolRegistry } from './tool-registry';
import { handleCallTool } from '.';

/**
 * 工具执行器类
 */
export class ToolExecutor {
  private client: WebSocketClient;

  constructor(client: WebSocketClient) {
    this.client = client;
  }

  /**
   * 处理工具执行请求
   */
  public async handleToolExecutionRequest(
    message: WebSocketMessage<ToolExecutionPayload>
  ): Promise<void> {
    const { correlationId, payload } = message;
    const { toolName, arguments: args } = payload;

    console.log(`[ToolExecutor] 收到工具执行请求: ${toolName}`, args);

    try {
      // 检查工具是否存在
      if (!toolRegistry.hasTool(toolName)) {
        throw new Error(`工具不存在: ${toolName}`);
      }

      // 执行工具
      const result = await handleCallTool({
        name: toolName,
        args: args,
      });

      console.log(`[ToolExecutor] 工具执行成功: ${toolName}`, result);

      // 发送成功响应
      this.sendResponse(correlationId!, {
        success: true,
        result: this.formatToolResult(result),
      });
    } catch (error) {
      console.error(`[ToolExecutor] 工具执行失败: ${toolName}`, error);

      // 发送失败响应
      this.sendResponse(correlationId!, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 格式化工具执行结果
   */
  private formatToolResult(result: any): any {
    // 如果结果包含 content 数组（MCP 格式）
    if (result.content && Array.isArray(result.content)) {
      // 提取文本内容
      const textContent = result.content
        .filter((item: any) => item.type === 'text')
        .map((item: any) => item.text)
        .join('\n');

      // 尝试解析为 JSON
      try {
        return JSON.parse(textContent);
      } catch {
        return { text: textContent };
      }
    }

    // 如果结果是错误
    if (result.isError || result.error) {
      throw new Error(result.error || '工具执行失败');
    }

    // 直接返回结果
    return result;
  }

  /**
   * 发送工具执行响应
   */
  private sendResponse(correlationId: string, payload: ToolExecutionResponsePayload): void {
    const responseMessage: WebSocketMessage<ToolExecutionResponsePayload> = {
      type: MessageType.TOOL_EXECUTION_RESPONSE,
      correlationId,
      payload,
    };

    this.client.send(responseMessage);
  }
}

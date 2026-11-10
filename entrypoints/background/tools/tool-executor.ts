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
import { projectToolPayload, type ToolResult } from '@/common/tool-handler';

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
   * 格式化工具执行结果（外部调用方拿到的最终载荷）
   *
   * 投影规则集中在 common/tool-handler.projectToolPayload（与工具面板同一口径）：
   * 哪条通道是正题由生产者显式声明（ToolResult.primary），消费方只取一份——
   * 同一份事实不在外部响应里出现两次，也不会有任何一侧丢信息。
   */
  private formatToolResult(result: any): any {
    const projection = projectToolPayload(result as ToolResult);
    if (projection.kind === 'error') {
      throw new Error(projection.error);
    }
    return projection.value;
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

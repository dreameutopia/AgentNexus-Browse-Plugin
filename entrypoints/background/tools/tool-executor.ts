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
  private readonly running = new Map<string,AbortController>();
  private readonly completed = new Map<string,ToolExecutionResponsePayload>();
  cancel(id: string): void { this.running.get(id)?.abort('cancelled'); }

  constructor(client: WebSocketClient) {
    this.client = client;
  }

  /**
   * 处理工具执行请求
   */
  public async handleToolExecutionRequest(
    message: WebSocketMessage<ToolExecutionPayload>
  ): Promise<void> {
    const { correlationId, payload } = message ?? {};
    if (typeof correlationId!=='string' || !correlationId || correlationId.length > 128) return;
    const cached = this.completed.get(correlationId);
    if (cached) { this.sendResponse(correlationId,cached); return; }
    if (this.running.has(correlationId)) return;
    if(!payload || typeof payload.toolName!=='string' || !payload.toolName || payload.toolName.length>128 || (payload.arguments!==undefined && (payload.arguments===null || typeof payload.arguments!=='object' || Array.isArray(payload.arguments)))) {
      this.sendResponse(correlationId,{success:false,error:'工具请求格式无效：需要工具名称和对象类型参数'});return;
    }
    const { toolName, arguments: args } = payload;
    if (this.running.size >= 4) { this.sendResponse(correlationId,{success:false,error:'浏览器执行队列已满'}); return; }
    const controller = new AbortController();
    this.running.set(correlationId,controller);
    const timeout = setTimeout(() => controller.abort('deadline'),600_000);

    console.log(`[ToolExecutor] 收到工具执行请求: ${toolName}`);

    try {
      if (toolName === '__connector_list_tools') {
        const current = await chrome.windows.getLastFocused({windowTypes:['normal']});
        if (!Number.isSafeInteger(current.id) || current.id!<0) throw new Error('请先打开需要操作的浏览器窗口');
        controller.signal.throwIfAborted();
        const tools = toolRegistry.getToolDefinitions().filter(t => !t.source && t.name.startsWith('browser_')).map(t => ({name:t.name,description:t.description,inputSchema:t.inputSchema}));
        this.sendResponse(correlationId,{success:true,result:{tools,boundWindowId:current.id}});
        return;
      }
      if (payload.connectorId !== undefined) {
        if (!Number.isSafeInteger(payload.connectorId) || payload.connectorId <= 0 || !toolName.startsWith('browser_') || toolRegistry.getTool(toolName)?.metadata.plugin)
          throw new Error('本地浏览器连接器不允许执行此工具');
        if (!Number.isSafeInteger(payload.connectorWindowId) || payload.connectorWindowId! < 0) throw new Error('请重新安装并检查连接器，以绑定浏览器窗口');
      }
      // 检查工具是否存在
      if (!toolRegistry.hasTool(toolName)) {
        throw new Error(`工具不存在: ${toolName}`);
      }

      // 执行工具
      const result = await handleCallTool({
        name: toolName,
        args: args,
        context: {signal:controller.signal,requestId:correlationId,
          ...(payload.connectorId !== undefined ? {browserScope:{mode:'bound-window' as const,windowId:payload.connectorWindowId!}} : {})},
      });

      if(controller.signal.aborted) throw new Error("浏览器操作已取消，结果可能未知");
      console.log(`[ToolExecutor] 工具执行完成: ${toolName}`);

      // 发送成功响应
      this.sendResponse(correlationId!, {
        success: true,
        result: this.formatToolResult(result),
      });
    } catch (error) {
      console.error(`[ToolExecutor] 工具执行未成功: ${toolName}`);

      // 发送失败响应
      this.sendResponse(correlationId!, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally { clearTimeout(timeout);this.running.delete(correlationId); }
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
    this.completed.set(correlationId,payload);
    if(this.completed.size>64)this.completed.delete(this.completed.keys().next().value!);
    const responseMessage: WebSocketMessage<ToolExecutionResponsePayload> = {
      type: MessageType.TOOL_EXECUTION_RESPONSE,
      correlationId,
      payload,
    };

    this.client.send(responseMessage);
  }
}

/**
 * 文件路径请求处理器
 * 处理从后端拉取本地文件的请求
 */

import {
  MessageType,
  WebSocketMessage,
  FilePathRequestPayload,
  FileMetadataPayload,
  FileSendErrorPayload,
} from '../ws/websocket-types';
import { WebSocketClient } from '../ws/websocket-client';

/**
 * 文件路径请求处理器类
 */
export class FilePathHandler {
  private wsClient: WebSocketClient;
  private pendingRequests: Map<string, { path: string; timestamp: number }> = new Map();

  constructor(wsClient: WebSocketClient) {
    this.wsClient = wsClient;
    console.log('[FilePathHandler] 初始化完成');
  }

  /**
   * 请求后端发送指定路径的文件
   * @param absolutePath 文件的绝对路径
   * @param correlationId 关联ID（可选，自动生成）
   * @returns 返回 correlationId
   */
  public requestFile(absolutePath: string, correlationId?: string): string | null {
    if (!this.wsClient.isConnected()) {
      console.error('[FilePathHandler] WebSocket 未连接，无法请求文件');
      return null;
    }

    const cid = correlationId || this.generateCorrelationId();

    // 发送文件路径请求
    const message: WebSocketMessage<FilePathRequestPayload> = {
      type: MessageType.FILE_PATH_REQUEST,
      correlationId: cid,
      payload: {
        absolutePath,
      },
    };

    const success = this.wsClient.send(message);
    if (!success) {
      console.error('[FilePathHandler] 发送文件请求失败');
      return null;
    }

    // 记录待处理请求
    this.pendingRequests.set(cid, {
      path: absolutePath,
      timestamp: Date.now(),
    });

    console.log(`[FilePathHandler] 已请求文件: ${absolutePath}, correlationId: ${cid}`);
    return cid;
  }

  /**
   * 处理文件元数据消息（来自后端）
   */
  public handleFileMetadata(message: WebSocketMessage<FileMetadataPayload>): void {
    const { correlationId, payload } = message;
    
    if (!correlationId) {
      console.error('[FilePathHandler] FILE_METADATA 缺少 correlationId');
      return;
    }

    const request = this.pendingRequests.get(correlationId);
    if (!request) {
      console.warn('[FilePathHandler] 收到未知的 FILE_METADATA:', correlationId);
      return;
    }

    console.log(
      `[FilePathHandler] 收到文件元数据: ${payload.fileName}, 大小: ${payload.fileSize} bytes, correlationId: ${correlationId}`
    );

    // 元数据已收到，等待后续二进制帧
    // 注意：实际文件内容会在下一个二进制消息中到达
  }

  /**
   * 处理文件发送错误消息（来自后端）
   */
  public handleFileSendError(message: WebSocketMessage<FileSendErrorPayload>): void {
    const { correlationId, payload } = message;

    if (!correlationId) {
      console.error('[FilePathHandler] FILE_SEND_ERROR 缺少 correlationId');
      return;
    }

    const request = this.pendingRequests.get(correlationId);
    if (request) {
      console.error(
        `[FilePathHandler] 文件发送失败: ${request.path}, 错误: ${payload.error}, correlationId: ${correlationId}`
      );
      this.pendingRequests.delete(correlationId);
    } else {
      console.error(`[FilePathHandler] FILE_SEND_ERROR (未知请求): ${payload.error}, correlationId: ${correlationId}`);
    }
  }

  /**
   * 检查是否有待处理的文件请求
   */
  public hasPendingRequest(correlationId: string): boolean {
    return this.pendingRequests.has(correlationId);
  }

  /**
   * 获取待处理请求的文件路径
   */
  public getPendingRequestPath(correlationId: string): string | undefined {
    return this.pendingRequests.get(correlationId)?.path;
  }

  /**
   * 完成文件请求（接收到完整文件后调用）
   */
  public completeRequest(correlationId: string): void {
    const request = this.pendingRequests.get(correlationId);
    if (request) {
      console.log(`[FilePathHandler] 文件请求完成: ${request.path}, correlationId: ${correlationId}`);
      this.pendingRequests.delete(correlationId);
    }
  }

  /**
   * 清理超时的请求（可选）
   */
  public cleanupTimeoutRequests(timeoutMs: number = 60000): void {
    const now = Date.now();
    const timeoutIds: string[] = [];

    this.pendingRequests.forEach((request, cid) => {
      if (now - request.timestamp > timeoutMs) {
        timeoutIds.push(cid);
      }
    });

    timeoutIds.forEach((cid) => {
      console.warn(`[FilePathHandler] 请求超时，清理: ${cid}`);
      this.pendingRequests.delete(cid);
    });
  }

  /**
   * 生成关联ID
   */
  private generateCorrelationId(): string {
    return `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 销毁处理器
   */
  public destroy(): void {
    this.pendingRequests.clear();
    console.log('[FilePathHandler] 已销毁');
  }
}

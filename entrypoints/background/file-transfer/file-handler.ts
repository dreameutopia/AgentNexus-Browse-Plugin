/**
 * 文件传输处理器
 * 负责处理文件元数据发送和二进制文件传输
 */

import {
  WebSocketMessage,
  MessageType,
  FileMetadataPayload,
  FilePathRequestPayload,
  FileSendErrorPayload,
  WebSocketEventType,
} from '../ws/websocket-types';
import { WebSocketClient } from '../ws/websocket-client';

/**
 * 文件传输处理器类
 */
export class FileHandler {
  private client: WebSocketClient;
  private pendingFiles: Map<string, { file: File; correlationId: string }> = new Map();
  
  // 用于存储文件请求的回调
  private pendingFileRequests: Map<string, {
    resolve: (data: { fileName: string; data: ArrayBuffer }) => void;
    reject: (error: Error) => void;
    timeout: number;
  }> = new Map();
  
  // 临时存储接收到的元数据，等待二进制数据
  private pendingBinaryMetadata: Map<string, { fileName: string; fileSize: number }> = new Map();

  constructor(client: WebSocketClient) {
    this.client = client;
    this.setupEventListeners();
  }

  /**
   * 设置事件监听
   */
  private setupEventListeners(): void {
    // 监听消息接收事件，处理 FILE_METADATA 和 FILE_SEND_ERROR
    this.client.on(WebSocketEventType.MESSAGE_RECEIVED, (message: WebSocketMessage) => {
      if (message.type === MessageType.FILE_METADATA && message.correlationId) {
        this.handleFileMetadataFromBackend(message);
      } else if (message.type === MessageType.FILE_SEND_ERROR && message.correlationId) {
        this.handleFileSendError(message);
      }
    });
    
    // 监听二进制数据接收事件
    this.client.on(WebSocketEventType.BINARY_RECEIVED, (data: ArrayBuffer) => {
      this.handleBinaryDataFromBackend(data);
    });
  }

  /**
   * 处理从后端接收的文件元数据
   */
  private handleFileMetadataFromBackend(message: WebSocketMessage<FileMetadataPayload>): void {
    const correlationId = message.correlationId!;
    const { fileName, fileSize } = message.payload;
    
    console.log(`[FileHandler] 收到后端文件元数据: ${fileName}, 大小: ${fileSize}, correlationId: ${correlationId}`);
    
    // 存储元数据，等待二进制数据
    this.pendingBinaryMetadata.set(correlationId, { fileName, fileSize });
  }

  /**
   * 处理从后端接收的二进制数据
   */
  private handleBinaryDataFromBackend(data: ArrayBuffer): void {
    console.log(`[FileHandler] 收到后端二进制数据: ${data.byteLength} 字节`);
    
    // 查找匹配的元数据（使用最近的一个）
    const entries = Array.from(this.pendingBinaryMetadata.entries());
    if (entries.length === 0) {
      console.warn('[FileHandler] 收到二进制数据但没有对应的元数据');
      return;
    }
    
    // 取最新的一个元数据
    const [correlationId, metadata] = entries[entries.length - 1];
    this.pendingBinaryMetadata.delete(correlationId);
    
    console.log(`[FileHandler] 匹配元数据: ${metadata.fileName}, correlationId: ${correlationId}`);
    
    // 找到对应的请求回调
    const request = this.pendingFileRequests.get(correlationId);
    if (request) {
      clearTimeout(request.timeout);
      this.pendingFileRequests.delete(correlationId);
      request.resolve({ fileName: metadata.fileName, data });
    } else {
      console.warn(`[FileHandler] 未找到对应的文件请求: ${correlationId}`);
    }
  }

  /**
   * 处理文件发送错误
   */
  private handleFileSendError(message: WebSocketMessage<FileSendErrorPayload>): void {
    const correlationId = message.correlationId!;
    const { error, absolutePath } = message.payload;
    
    console.error(`[FileHandler] 后端发送文件失败: ${error}, 路径: ${absolutePath}`);
    
    // 找到对应的请求回调
    const request = this.pendingFileRequests.get(correlationId);
    if (request) {
      clearTimeout(request.timeout);
      this.pendingFileRequests.delete(correlationId);
      request.reject(new Error(error));
    }
    
    // 清理可能的待处理元数据
    this.pendingBinaryMetadata.delete(correlationId);
  }

  /**
   * 请求后端发送文件
   * @param absolutePath 文件的绝对路径
   * @param timeoutMs 超时时间（毫秒）
   * @returns Promise<{ fileName: string; data: ArrayBuffer }>
   */
  public async requestFileFromBackend(
    absolutePath: string,
    timeoutMs: number = 30000
  ): Promise<{ fileName: string; data: ArrayBuffer }> {
    console.log(`[FileHandler] 请求后端文件: ${absolutePath}`);
    
    return new Promise((resolve, reject) => {
      // 生成唯一的 correlationId
      const correlationId = `file_request_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // 设置超时
      const timeout = setTimeout(() => {
        this.pendingFileRequests.delete(correlationId);
        this.pendingBinaryMetadata.delete(correlationId);
        reject(new Error(`请求文件超时: ${absolutePath}`));
      }, timeoutMs) as unknown as number;
      
      // 存储请求回调
      this.pendingFileRequests.set(correlationId, { resolve, reject, timeout });
      
      // 发送文件路径请求
      const message: WebSocketMessage<FilePathRequestPayload> = {
        type: MessageType.FILE_PATH_REQUEST,
        correlationId,
        payload: { absolutePath }
      };
      
      const sent = this.client.send(message);
      if (!sent) {
        clearTimeout(timeout);
        this.pendingFileRequests.delete(correlationId);
        reject(new Error('发送文件请求失败'));
      }
    });
  }

  /**
   * 发送文件
   * @param file 要发送的文件对象
   * @param correlationId 关联 ID（通常来自服务器的文件请求命令）
   */
  public async sendFile(file: File, correlationId: string): Promise<boolean> {
    console.log(`[FileHandler] 准备发送文件: ${file.name}, 大小: ${file.size} 字节`);

    try {
      // 第1步: 发送文件元数据
      const metadataMessage: WebSocketMessage<FileMetadataPayload> = {
        type: MessageType.FILE_METADATA,
        correlationId,
        payload: {
          fileName: file.name,
          fileSize: file.size,
        },
      };

      const metadataSent = this.client.send(metadataMessage);
      if (!metadataSent) {
        throw new Error('发送文件元数据失败');
      }

      console.log(`[FileHandler] 文件元数据已发送: ${file.name}`);

      // 第2步: 读取文件为 ArrayBuffer
      const arrayBuffer = await this.readFileAsArrayBuffer(file);

      // 第3步: 发送二进制数据
      // 添加短暂延迟，确保服务器先处理元数据
      await new Promise((resolve) => setTimeout(resolve, 100));

      const binarySent = this.client.sendBinary(arrayBuffer);
      if (!binarySent) {
        throw new Error('发送文件二进制数据失败');
      }

      console.log(`[FileHandler] 文件已发送: ${file.name}`);
      return true;
    } catch (error) {
      console.error(`[FileHandler] 发送文件失败: ${file.name}`, error);
      return false;
    }
  }

  /**
   * 批量发送文件
   */
  public async sendMultipleFiles(files: File[], correlationId: string): Promise<boolean[]> {
    const results: boolean[] = [];

    for (const file of files) {
      const result = await this.sendFile(file, correlationId);
      results.push(result);

      // 在文件之间添加延迟，避免服务器处理不过来
      if (files.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    return results;
  }

  /**
   * 将文件读取为 ArrayBuffer
   */
  private readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(reader.result);
        } else {
          reject(new Error('读取文件失败：结果不是 ArrayBuffer'));
        }
      };

      reader.onerror = () => {
        reject(new Error(`读取文件失败: ${reader.error?.message}`));
      };

      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * 从 base64 字符串创建文件并发送
   */
  public async sendBase64File(
    base64Data: string,
    fileName: string,
    mimeType: string,
    correlationId: string
  ): Promise<boolean> {
    try {
      // 移除 base64 前缀（如果有）
      const base64String = base64Data.replace(/^data:[^;]+;base64,/, '');

      // 将 base64 转换为 Blob
      const binaryString = atob(base64String);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mimeType });

      // 创建 File 对象
      const file = new File([blob], fileName, { type: mimeType });

      // 发送文件
      return await this.sendFile(file, correlationId);
    } catch (error) {
      console.error('[FileHandler] 发送 base64 文件失败:', error);
      return false;
    }
  }

  /**
   * 从 data URL 创建文件并发送
   */
  public async sendDataUrlFile(
    dataUrl: string,
    fileName: string,
    correlationId: string
  ): Promise<boolean> {
    try {
      // 提取 MIME 类型
      const mimeMatch = dataUrl.match(/^data:([^;]+);/);
      const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';

      // 提取 base64 数据
      const base64Match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
      if (!base64Match) {
        throw new Error('无效的 data URL');
      }

      return await this.sendBase64File(base64Match[1], fileName, mimeType, correlationId);
    } catch (error) {
      console.error('[FileHandler] 发送 data URL 文件失败:', error);
      return false;
    }
  }

  /**
   * 发送截屏文件（专门为视觉操作设计）
   * @param base64Screenshot Base64 格式的截屏数据
   * @param correlationId 关联 ID
   * @param fileName 文件名（默认为 screenshot.png）
   * @returns 是否发送成功
   */
  public async sendScreenshotFile(
    base64Screenshot: string,
    correlationId: string,
    fileName: string = 'screenshot.png'
  ): Promise<boolean> {
    console.log(`[FileHandler] 准备发送截屏文件: ${fileName}, correlationId: ${correlationId}`);

    try {
      // 移除 base64 前缀
      const base64WithoutPrefix = base64Screenshot.replace(/^data:image\/\w+;base64,/, '');
      
      // 转换为二进制数据
      const binaryString = atob(base64WithoutPrefix);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // 步骤 1: 发送文件元数据
      const metadataMessage: WebSocketMessage<FileMetadataPayload> = {
        type: MessageType.FILE_METADATA,
        correlationId,
        payload: {
          fileName,
          fileSize: bytes.length,
        },
      };

      const metadataSent = this.client.send(metadataMessage);
      if (!metadataSent) {
        throw new Error('发送截屏元数据失败');
      }

      console.log(`[FileHandler] 截屏元数据已发送: ${fileName}, 大小: ${bytes.length} 字节`);

      // 步骤 2: 短暂延迟，确保服务器处理元数据
      await new Promise((resolve) => setTimeout(resolve, 150));

      // 步骤 3: 发送二进制数据
      const binarySent = this.client.sendBinary(bytes.buffer);
      if (!binarySent) {
        throw new Error('发送截屏二进制数据失败');
      }

      console.log(`[FileHandler] 截屏文件已成功发送: ${fileName}`);
      return true;

    } catch (error) {
      console.error(`[FileHandler] 发送截屏文件失败:`, error);
      return false;
    }
  }
}

/**
 * WebSocket 客户端核心类
 * 负责建立连接、发送接收消息、心跳管理
 */

import {
  WebSocketMessage,
  ConnectionStatus,
  WebSocketConfig,
  DEFAULT_WEBSOCKET_CONFIG,
  WebSocketEventType,
  RELAY_DOWNLINK_FRAME,
  RELAY_REQUEST_REREGISTER,
} from './websocket-types';

type EventListener = (data: any) => void;

/**
 * 构建带有客户端标识参数的 WebSocket URL
 * 将版本号和客户端ID作为查询参数附加到基础URL上
 */
/**
 * 构建带有客户端标识参数的 WebSocket URL。
 * 中转模式（relay 配置存在）不拼 query——身份经 PLUGIN_HELLO 上报，避免双重标识。
 */
function buildConnectUrl(baseUrl: string, relayMode: boolean): string {
  if (relayMode) {
    return baseUrl;
  }

  const params = new URLSearchParams();

  if (__APP_VERSION__) {
    params.set('version', __APP_VERSION__);
  }

  if (__BROWSER_UUID__) {
    params.set('browserUuid', __BROWSER_UUID__);
  }

  const queryString = params.toString();
  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private config: WebSocketConfig;
  private status: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private eventListeners: Map<WebSocketEventType, Set<EventListener>> = new Map();

  constructor(config?: Partial<WebSocketConfig>) {
    this.config = { ...DEFAULT_WEBSOCKET_CONFIG, ...config };
    console.log('[WebSocketClient] 初始化完成', this.config);
  }

  /**
   * 连接到 WebSocket 服务器
   */
  public async connect(): Promise<boolean> {
    if (this.status === ConnectionStatus.CONNECTED || this.status === ConnectionStatus.CONNECTING) {
      console.log('[WebSocketClient] 已经连接或正在连接中');
      return true;
    }

    this.updateStatus(ConnectionStatus.CONNECTING);
    const connectUrl = buildConnectUrl(this.config.url, Boolean(this.config.relay));
    console.log(`[WebSocketClient] 连接到: ${connectUrl}`);

    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(connectUrl);

        this.ws.onopen = () => {
          console.log('[WebSocketClient] 连接成功');
          this.updateStatus(ConnectionStatus.CONNECTED);
          this.reconnectAttempts = 0;
          // 前端中转模式：先上报身份（前端 local-server 按此注册插件连接）
          this.sendPluginHello();
          this.startHeartbeat();
          this.emit(WebSocketEventType.CONNECTED, {});
          resolve(true);
        };

        this.ws.onmessage = (event) => {
          try {
            this.handleMessage(event);
          } catch (error) {
            console.log('[WebSocketClient] 处理消息时出错:', error);
          }
        };

        this.ws.onerror = (error) => {
          console.log('[WebSocketClient] 连接错误（正常情况，后端可能未启动）:', error);
          this.emit(WebSocketEventType.ERROR, { error });
          resolve(false);
        };

        this.ws.onclose = (event) => {
          console.log('[WebSocketClient] 连接关闭', { code: event.code, reason: event.reason, wasClean: event.wasClean });
          try {
            this.handleDisconnect();
          } catch (error) {
            console.log('[WebSocketClient] 处理断开连接时出错:', error);
          }
        };

        // 连接超时处理
        setTimeout(() => {
          if (this.status === ConnectionStatus.CONNECTING) {
            console.log('[WebSocketClient] 连接超时（后端可能未启动）');
            try {
              this.ws?.close();
            } catch (e) {
              console.log('[WebSocketClient] 关闭超时连接时出错:', e);
            }
            resolve(false);
          }
        }, 10000);
      } catch (error) {
        console.log('[WebSocketClient] 连接失败（后端可能未启动）:', error);
        this.updateStatus(ConnectionStatus.ERROR);
        resolve(false);
      }
    });
  }

  /**
   * 断开连接
   */
  public disconnect(): void {
    console.log('[WebSocketClient] 主动断开连接');
    this.stopReconnect();
    this.stopHeartbeat();
    
    try {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
    } catch (error) {
      console.log('[WebSocketClient] 关闭连接时出错:', error);
      this.ws = null;
    }
    
    this.updateStatus(ConnectionStatus.DISCONNECTED);
  }

  /**
   * 更新连接目标 URL（前端中转模式端口切换用；下次 connect 生效）
   */
  public updateUrl(url: string): void {
    if (this.config.url !== url) {
      console.log(`[WebSocketClient] 连接目标变更: ${this.config.url} -> ${url}`);
      this.config.url = url;
    }
  }

  /**
   * 发送消息
   */
  public send<T>(message: WebSocketMessage<T>): boolean {
    if (!this.isConnected()) {
      console.log('[WebSocketClient] 未连接，无法发送消息');
      return false;
    }

    try {
      const jsonString = JSON.stringify(message);
      this.ws!.send(jsonString);
      console.log('[WebSocketClient] 发送消息:', message.type, message.correlationId);
      this.emit(WebSocketEventType.MESSAGE_SENT, message);
      return true;
    } catch (error) {
      console.error('[WebSocketClient] 发送消息失败:', error);
      return false;
    }
  }

  /**
   * 发送二进制数据（文件）
   */
  public sendBinary(data: ArrayBuffer): boolean {
    if (!this.isConnected()) {
      console.log('[WebSocketClient] 未连接，无法发送二进制数据');
      return false;
    }

    try {
      this.ws!.send(data);
      console.log('[WebSocketClient] 发送二进制数据，大小:', data.byteLength);
      return true;
    } catch (error) {
      console.error('[WebSocketClient] 发送二进制数据失败:', error);
      return false;
    }
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(event: MessageEvent): void {
    // 处理二进制消息
    if (event.data instanceof Blob) {
      console.log('[WebSocketClient] 收到二进制消息 (Blob):', event.data.size);
      // 转换为 ArrayBuffer
      event.data.arrayBuffer().then(buffer => {
        this.emit(WebSocketEventType.BINARY_RECEIVED, buffer);
      }).catch(error => {
        console.log('[WebSocketClient] 转换 Blob 到 ArrayBuffer 失败:', error);
      });
      return;
    }
    
    if (event.data instanceof ArrayBuffer) {
      console.log('[WebSocketClient] 收到二进制消息 (ArrayBuffer):', event.data.byteLength);
      this.emit(WebSocketEventType.BINARY_RECEIVED, event.data);
      return;
    }

    // 处理 JSON 消息
    try {
      const message: WebSocketMessage = JSON.parse(event.data);

      // 前端中转模式：解包下行帧与重注册指令
      if (this.config.relay) {
        if (message.type === RELAY_DOWNLINK_FRAME) {
          const envelope = message as unknown as { payload?: { inner?: unknown } };
          const inner = envelope.payload?.inner;
          if (inner === undefined || inner === null) {
            console.warn('[WebSocketClient] 中转下行帧缺 inner，忽略');
            return;
          }
          const innerMessage = (typeof inner === 'string' ? JSON.parse(inner) : inner) as WebSocketMessage;
          console.log('[WebSocketClient] 中转下行帧:', innerMessage.type, innerMessage.correlationId);
          this.emit(WebSocketEventType.MESSAGE_RECEIVED, innerMessage);
          return;
        }
        if (message.type === RELAY_REQUEST_REREGISTER) {
          console.log('[WebSocketClient] 收到中转重注册指令');
          this.emit(WebSocketEventType.REREGISTER_REQUESTED, {});
          return;
        }
      }

      console.log('[WebSocketClient] 收到消息:', message.type, message.correlationId);
      this.emit(WebSocketEventType.MESSAGE_RECEIVED, message);
    } catch (error) {
      console.log('[WebSocketClient] 解析消息失败:', error, event.data);
    }
  }

  /**
   * 前端中转模式：上报插件身份（连接后与心跳周期共用）
   */
  private sendPluginHello(): void {
    if (!this.config.relay || !this.ws) {
      return;
    }
    try {
      const hello = {
        type: 'PLUGIN_HELLO',
        payload: {
          browserUuid: this.config.relay.browserUuid,
          pluginVersion: this.config.relay.pluginVersion,
          userAgent: navigator.userAgent,
          platform: navigator.platform || '',
        },
      };
      this.ws.send(JSON.stringify(hello));
    } catch (error) {
      console.log('[WebSocketClient] 发送 PLUGIN_HELLO 失败:', error);
    }
  }

  /**
   * 处理断开连接
   */
  private handleDisconnect(): void {
    console.log('[WebSocketClient] handleDisconnect 被调用');
    
    try {
      this.stopHeartbeat();
      this.updateStatus(ConnectionStatus.DISCONNECTED);
      this.emit(WebSocketEventType.DISCONNECTED, {});

      // 尝试重连
      if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
        this.scheduleReconnect();
      } else {
        console.log('[WebSocketClient] 达到最大重连次数，停止重连');
      }
    } catch (error) {
      console.log('[WebSocketClient] 处理断开连接时出错:', error);
    }
  }

  /**
   * 计划重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectAttempts++;
    this.updateStatus(ConnectionStatus.RECONNECTING);
    
    console.log(
      `[WebSocketClient] 将在 ${this.config.reconnectInterval}ms 后进行第 ${this.reconnectAttempts} 次重连`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(error => {
        console.log('[WebSocketClient] 重连失败:', error);
      });
    }, this.config.reconnectInterval) as unknown as number;
  }

  /**
   * 停止重连
   */
  private stopReconnect(): void {
    try {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectAttempts = 0;
    } catch (error) {
      console.log('[WebSocketClient] 停止重连时出错:', error);
    }
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    // 主动发送心跳消息，确保双向通信
    // 这对于 Edge 浏览器尤其重要，可以防止连接被提前断开
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected()) {
        console.log('[WebSocketClient] 心跳检测: 连接已断开');
        this.stopHeartbeat();
        return;
      }
      
      try {
        if (this.config.relay) {
          // 前端中转模式：以 PLUGIN_HELLO 保活（前端幂等刷新插件视图），
          // 不发 HEARTBEAT（前端 Server 不处理，会被当未知上行转发造成噪音）
          this.sendPluginHello();
        } else {
          // 发送一个轻量级的心跳消息（无业务载荷）
          const heartbeatMessage: WebSocketMessage<Record<string, never>> = {
            type: 'HEARTBEAT',
            correlationId: `heartbeat_${Date.now()}`,
            payload: {}
          };
          this.ws!.send(JSON.stringify(heartbeatMessage));
          console.log('[WebSocketClient] 发送心跳');
        }
      } catch (error) {
        console.log('[WebSocketClient] 发送心跳失败，连接可能已断开:', error);
        this.stopHeartbeat();
      }
    }, this.config.heartbeatInterval) as unknown as number;
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    try {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    } catch (error) {
      console.log('[WebSocketClient] 停止心跳时出错:', error);
    }
  }

  /**
   * 更新连接状态
   */
  private updateStatus(status: ConnectionStatus): void {
    const oldStatus = this.status;
    this.status = status;
    console.log(`[WebSocketClient] 状态变化: ${oldStatus} -> ${status}`);
  }

  /**
   * 触发事件
   */
  private emit(event: WebSocketEventType, data: any): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach((listener) => listener(data));
    }
  }

  /**
   * 添加事件监听器
   */
  public on(event: WebSocketEventType, listener: EventListener): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);
  }

  /**
   * 移除事件监听器
   */
  public off(event: WebSocketEventType, listener: EventListener): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * 获取连接状态
   */
  public getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * 检查是否已连接
   */
  public isConnected(): boolean {
    try {
      return this.status === ConnectionStatus.CONNECTED && this.ws?.readyState === WebSocket.OPEN;
    } catch (error) {
      console.log('[WebSocketClient] 检查连接状态时出错:', error);
      return false;
    }
  }

  /**
   * 更新配置
   */
  public updateConfig(newConfig: Partial<WebSocketConfig>): void {
    this.config = { ...this.config, ...newConfig };
    console.log('[WebSocketClient] 配置已更新:', this.config);
  }

  /**
   * 获取当前配置
   */
  public getConfig(): WebSocketConfig {
    return { ...this.config };
  }
}

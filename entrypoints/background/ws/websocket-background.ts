import { onPluginsChange } from '@/utils/plugins/catalog';
/**
 * Background WebSocket 管理器
 * 基于 Java 后端 WebSocket API 文档实现
 * 负责：
 * 1. 建立 WebSocket 连接
 * 2. 注册所有可用工具
 * 3. 处理服务器发送的命令和工具执行请求
 * 4. 处理文件传输
 */

import { WebSocketClient } from './websocket-client';
import { resolveBrowserUuid, isDockerMode } from './browser-identity';
import { ToolExecutor } from '../tools/tool-executor';
import { FileHandler } from '../file-transfer/file-handler';
import { VisionActionHandler } from '../vision/vision-action-handler';
import { ScreenShareSignalHandler } from '../screen-share/signal-handler';
import { WebRTCSignalType } from '../screen-share/types';
import { toolRegistry } from '../tools/tool-registry';
import {
  WebSocketMessage,
  WebSocketConfig,
  MessageType,
  ToolRegistrationPayload,
  CommandPayload,
  CommandResponsePayload,
  ToolExecutionPayload,
  VisionActionPayload,
  WebSocketEventType,
  ConnectionStatus,
  DEFAULT_WEBSOCKET_CONFIG,
  DEFAULT_FRONTEND_RELAY_PORT,
} from './websocket-types';

class BackgroundWebSocket {
  private client!: WebSocketClient;
  private toolExecutor!: ToolExecutor;
  private fileHandler!: FileHandler;
  private visionActionHandler!: VisionActionHandler;
  private screenShareHandler!: ScreenShareSignalHandler;
  private isRegistered = false;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    console.log('[BackgroundWebSocket] 初始化 WebSocket 管理器');
    onPluginsChange(() => { if (this.initialized && this.isRegistered) { this.isRegistered = false; this.registerTools(); } });
    // MV3 service worker：异步初始化（用户浏览器场景 uuid 需读 chrome.storage），
    // 外部调 tryConnect/getStatus 等方法前会先经各方法内的守卫等待初始化完成
    void this.ensureInitialized().catch((err) => {
      console.error('[BackgroundWebSocket] 初始化失败:', err);
    });
  }

  /**
   * 异步初始化（幂等 + 可重试）：判定模式 → 装配组件 → 连接。
   *
   * <p>失败不缓存：chrome.storage 读失败等瞬时异常会在下次调用（如 sidepanel
   * 触发 tryConnect / 插件重连）时重新初始化，避免 rejected promise 被永久缓存
   * 导致插件在整个浏览器生命周期内不可用。</p>
   *
   * 双模式（V2026.09.24）：
   * - docker（构建期 BROWSER_UUID 非空）：直连后端 ws://localhost:52725/api/automation（原行为）；
   * - 用户浏览器：运行时 uuid（chrome.storage 持久化）+ 前端中转 ws://localhost:52715。
   */
  private ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return Promise.resolve();
    }
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((err) => {
        // 失败清除缓存句柄：允许后续重试
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    let relayConfig: WebSocketConfig['relay'] | undefined;
    let url = DEFAULT_WEBSOCKET_CONFIG.url;

    if (isDockerMode()) {
      console.log('[BackgroundWebSocket] docker 模式：直连后端');
    } else {
      const browserUuid = await resolveBrowserUuid();
      url = `ws://localhost:${DEFAULT_FRONTEND_RELAY_PORT}`;
      relayConfig = { browserUuid, pluginVersion: __APP_VERSION__ || '0.0.0' };
      console.log(`[BackgroundWebSocket] 前端中转模式: uuid=${browserUuid}`);
    }

    // 创建 WebSocket 客户端
    this.client = new WebSocketClient({ url, relay: relayConfig });

    // 创建工具执行器
    this.toolExecutor = new ToolExecutor(this.client);

    // 创建文件处理器
    this.fileHandler = new FileHandler(this.client);

    // 创建视觉操作处理器
    this.visionActionHandler = new VisionActionHandler(this.client);

    // 将文件处理器注入到视觉操作处理器中
    this.visionActionHandler.setFileHandler(this.fileHandler);

    // 创建屏幕共享信令处理器
    this.screenShareHandler = new ScreenShareSignalHandler(this.client);

    // 设置事件监听
    this.setupEventListeners();

    this.initialized = true;

    // 开始连接
    await this.connect();
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    // 监听连接成功事件
    this.client.on(WebSocketEventType.CONNECTED, () => {
      console.log('[BackgroundWebSocket] WebSocket 已连接');
      this.onConnected();
      // 通知 sidepanel 连接状态变化
      this.notifyStatusChange(ConnectionStatus.CONNECTED);
    });

    // 监听断开连接事件
    this.client.on(WebSocketEventType.DISCONNECTED, () => {
      console.log('[BackgroundWebSocket] WebSocket 已断开');
      console.warn('[BackgroundWebSocket] ⚠️ 连接断开事件触发');
      console.trace('[BackgroundWebSocket] 断开连接调用堆栈');
      this.isRegistered = false;
      // 通知 sidepanel 连接状态变化
      this.notifyStatusChange(ConnectionStatus.DISCONNECTED);
    });

    // 监听错误事件
    this.client.on(WebSocketEventType.ERROR, (event) => {
      console.log('[BackgroundWebSocket] WebSocket 错误:', event.error);
      // 通知 sidepanel 连接状态变化
      this.notifyStatusChange(ConnectionStatus.ERROR);
    });

    // 监听消息接收事件
    this.client.on(WebSocketEventType.MESSAGE_RECEIVED, (message: WebSocketMessage) => {
      this.handleMessage(message);
    });

    // 前端中转模式：中转重建后重发工具注册（后端 relay 断链已清注册表）
    this.client.on(WebSocketEventType.REREGISTER_REQUESTED, () => {
      console.log('[BackgroundWebSocket] 中转要求重注册');
      this.isRegistered = false;
      this.registerTools();
    });
  }

  /**
   * 通知 sidepanel 连接状态变化
   */
  private notifyStatusChange(status: ConnectionStatus): void {
    chrome.runtime.sendMessage({
      type: 'WEBSOCKET_STATUS_CHANGED',
      status: status
    }).catch(() => {
      // sidepanel 可能未打开，忽略错误
    });
  }

  /**
   * 连接到 WebSocket 服务器
   */
  private async connect(): Promise<void> {
    console.log('[BackgroundWebSocket] 尝试连接到 WebSocket 服务器');

    try {
      const success = await this.client.connect();
      if (!success) {
        console.log('[BackgroundWebSocket] 连接失败');
      }
    } catch (error) {
      console.error('[BackgroundWebSocket] 连接异常:', error);
    }
  }

  /**
   * 连接成功后的处理
   */
  private onConnected(): void {
    console.log('[BackgroundWebSocket] 连接成功，准备注册工具');

    // 立即发送工具注册消息
    this.registerTools();
  }

  /**
   * 注册所有工具
   */
  private registerTools(): void {
    if (this.isRegistered) {
      console.log('[BackgroundWebSocket] 工具已注册，跳过');
      return;
    }

    console.log('[BackgroundWebSocket] 开始注册工具');

    // 获取所有工具定义
    const tools = toolRegistry.getToolDefinitions();

    // 构建注册消息
    const registrationMessage: WebSocketMessage<ToolRegistrationPayload> = {
      type: MessageType.TOOL_REGISTRATION,
      correlationId: `tool-reg-${Date.now()}`,
      payload: {
        tools,
      },
    };

    // 发送注册消息
    const sent = this.client.send(registrationMessage);

    if (sent) {
      console.log(`[BackgroundWebSocket] 工具注册消息已发送，共 ${tools.length} 个工具`);
      this.isRegistered = true;
    } else {
      console.error('[BackgroundWebSocket] 发送工具注册消息失败');
    }
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(message: WebSocketMessage): void {
    console.log(`[BackgroundWebSocket] 收到消息类型: ${message.type}`);

    switch (message.type) {
      case MessageType.COMMAND:
        this.handleCommandMessage(message as WebSocketMessage<CommandPayload>);
        break;

      case MessageType.TOOL_EXECUTION_REQUEST:
        this.handleToolExecutionRequest(message as WebSocketMessage<ToolExecutionPayload>);
        break;

      case MessageType.VISION_ACTION:
        this.handleVisionActionRequest(message as WebSocketMessage<VisionActionPayload>);
        break;

      // WebRTC 屏幕共享信令（后端 → 插件）
      case WebRTCSignalType.START_BROADCAST_REQUEST:
      case WebRTCSignalType.START_BROADCAST:
      case WebRTCSignalType.VIEWER_JOINED:
      case WebRTCSignalType.VIEWER_LEFT:
      case WebRTCSignalType.ANSWER:
      case WebRTCSignalType.ICE_FROM_VIEWER:
      case WebRTCSignalType.ROOM_CLOSED:
        this.screenShareHandler.handleWebSocketSignal(message.type, message.payload);
        break;

      default:
        console.warn(`[BackgroundWebSocket] 未知消息类型: ${message.type}`);
    }
  }

  /**
   * 处理命令消息
   */
  private async handleCommandMessage(message: WebSocketMessage<CommandPayload>): Promise<void> {
    const { correlationId, payload } = message;
    const { agentIds, command } = payload;

    console.log(`[BackgroundWebSocket] 收到命令:`, { agentIds, command });
    console.warn(`[BackgroundWebSocket] ⚠️ 命令详细信息 - agentIds: ${JSON.stringify(agentIds)}, command: ${JSON.stringify(command)}`);

    try {
      // 检查是否是关闭浏览器的危险命令
      const commandStr = typeof command === 'string' ? command.toLowerCase() : JSON.stringify(command).toLowerCase();
      const dangerousKeywords = ['close', 'exit', 'quit', 'shutdown', '关闭', '退出'];
      
      if (dangerousKeywords.some(keyword => commandStr.includes(keyword))) {
        console.error(`[BackgroundWebSocket] ⛔ 检测到潜在的危险命令，已拦截: ${command}`);
        
        const responseMessage: WebSocketMessage<CommandResponsePayload> = {
          type: 'COMMAND_RESPONSE' as any,
          correlationId,
          payload: {
            success: false,
            error: '检测到潜在危险命令，已被安全拦截',
          },
        };
        
        this.client.send(responseMessage);
        return;
      }

      // 这里可以根据命令内容执行相应操作
      // 目前文档中没有定义具体的命令格式，所以暂时只记录
      console.log(`[BackgroundWebSocket] 命令内容: ${command}`);

      // 发送命令响应
      const responseMessage: WebSocketMessage<CommandResponsePayload> = {
        type: 'COMMAND_RESPONSE' as any, // 文档中没有明确定义，但按照对称性应该有
        correlationId,
        payload: {
          success: true,
          result: '命令已接收',
        },
      };

      this.client.send(responseMessage);
    } catch (error) {
      console.error('[BackgroundWebSocket] 处理命令失败:', error);

      // 发送错误响应
      const errorMessage: WebSocketMessage<CommandResponsePayload> = {
        type: 'COMMAND_RESPONSE' as any,
        correlationId,
        payload: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };

      this.client.send(errorMessage);
    }
  }

  /**
   * 处理工具执行请求
   */
  private async handleToolExecutionRequest(
    message: WebSocketMessage<ToolExecutionPayload>
  ): Promise<void> {
    await this.toolExecutor.handleToolExecutionRequest(message);
  }

  /**
   * 处理视觉操作请求
   */
  private async handleVisionActionRequest(
    message: WebSocketMessage<VisionActionPayload>
  ): Promise<void> {
    console.log('[BackgroundWebSocket] 处理视觉操作请求:', message.payload.action);
    
    try {
      // 处理视觉操作（包括截屏文件发送）
      await this.visionActionHandler.handleVisionAction(message);
    } catch (error) {
      console.error('[BackgroundWebSocket] 处理视觉操作失败:', error);
    }
  }

  /**
   * 前端中转模式：应用 trigger 页嗅探到的 relayPort（若与当前不同则重连）。
   * docker 模式下为 no-op。
   */
  public async applyRelayPort(port: number): Promise<void> {
    await this.ensureInitialized();
    if (isDockerMode() || !this.client) {
      return;
    }
    const targetUrl = `ws://localhost:${port}`;
    if (this.client.getConfig().url === targetUrl) {
      // 已是目标端口：确保连接中
      void this.tryConnect();
      return;
    }
    console.log(`[BackgroundWebSocket] 应用 relayPort=${port}，切换中转目标`);
    this.client.updateUrl(targetUrl);
    this.isRegistered = false;
    this.client.disconnect();
    await this.connect();
  }

  /**
   * 获取连接状态
   */
  public getStatus(): ConnectionStatus {
    if (!this.initialized) {
      return ConnectionStatus.CONNECTING;
    }
    return this.client.getStatus();
  }

  /**
   * 检查是否已连接
   */
  public isConnected(): boolean {
    if (!this.initialized) {
      return false;
    }
    return this.client.isConnected();
  }

  /**
   * 检查是否正在连接
   */
  public isConnecting(): boolean {
    if (!this.initialized) {
      return true;
    }
    return this.client.getStatus() === ConnectionStatus.CONNECTING;
  }

  /**
   * 尝试连接（如果未连接且未正在连接）
   * 返回 true 表示成功触发连接，false 表示已经连接或正在连接
   */
  public async tryConnect(): Promise<boolean> {
    await this.ensureInitialized();
    // 如果已经连接或正在连接，不重复连接
    if (this.isConnected()) {
      console.log('[BackgroundWebSocket] 已经连接，无需重新连接');
      return false;
    }

    if (this.isConnecting()) {
      console.log('[BackgroundWebSocket] 正在连接中，无需重复触发');
      return false;
    }

    console.log('[BackgroundWebSocket] 触发连接');
    // 通知 sidepanel 连接中状态
    this.notifyStatusChange(ConnectionStatus.CONNECTING);
    await this.connect();
    return true;
  }

  /**
   * 断开连接
   */
  public disconnect(): void {
    if (!this.initialized) {
      return;
    }
    this.client.disconnect();
  }

  /**
   * 获取文件处理器（供其他模块使用）
   */
  public getFileHandler(): FileHandler {
    return this.fileHandler;
  }
  /**
   * 获取屏幕共享信令处理器（供 background index.ts 调用）
   */
  public getScreenShareHandler(): ScreenShareSignalHandler {
    return this.screenShareHandler;
  }

  /**
   * 请求后端发送文件
   * @param absolutePath 文件的绝对路径
   * @param timeoutMs 超时时间（毫秒）
   */
  public async requestFileFromBackend(
    absolutePath: string,
    timeoutMs?: number
  ): Promise<{ fileName: string; data: ArrayBuffer }> {
    await this.ensureInitialized();
    return this.fileHandler.requestFileFromBackend(absolutePath, timeoutMs);
  }
}

// 创建并导出单例实例
export const backgroundWebSocket = new BackgroundWebSocket();

// 也导出类，以便需要时可以创建新实例
export { BackgroundWebSocket };
/**
 * WebSocket 消息类型定义
 * 基于 Java 后端 WebSocket API 文档
 */

// ============ 消息类型枚举 ============
export enum MessageType {
  // 客户端 -> 服务器
  TOOL_REGISTRATION = 'TOOL_REGISTRATION',
  TOOL_EXECUTION_RESPONSE = 'TOOL_EXECUTION_RESPONSE',
  FILE_METADATA = 'FILE_METADATA',
  VISION_ACTION_RESPONSE = 'VISION_ACTION_RESPONSE',
  FILE_PATH_REQUEST = 'FILE_PATH_REQUEST',
  
  // 服务器 -> 客户端
  COMMAND = 'COMMAND',
  TOOL_EXECUTION_REQUEST = 'TOOL_EXECUTION_REQUEST',
  VISION_ACTION = 'VISION_ACTION',
  FILE_SEND_ERROR = 'FILE_SEND_ERROR',
}

// ============ 通用消息结构 ============
export interface WebSocketMessage<T = any> {
  type: MessageType | string;
  correlationId?: string;
  payload: T;
}

// ============ 工具参数定义 ============
export interface DynamicToolParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

// ============ 工具定义 ============
export interface DynamicToolDefinition {
  name: string;
  description: string;
  parameters: DynamicToolParameter[];
}

// ============ Payload 定义 ============

/**
 * 工具注册 Payload (客户端 -> 服务器)
 */
export interface ToolRegistrationPayload {
  tools: DynamicToolDefinition[];
}

/**
 * 命令 Payload (服务器 -> 客户端)
 */
export interface CommandPayload {
  agentIds: string[];
  command: string;
}

/**
 * 命令响应 Payload (客户端 -> 服务器)
 */
export interface CommandResponsePayload {
  success: boolean;
  result?: string;
  error?: string;
}

/**
 * 工具执行请求 Payload (服务器 -> 客户端)
 */
export interface ToolExecutionPayload {
  toolName: string;
  arguments: Record<string, any>;
}

/**
 * 工具执行响应 Payload (客户端 -> 服务器)
 */
export interface ToolExecutionResponsePayload {
  success: boolean;
  result?: any;
  error?: string;
}

/**
 * 文件元数据 Payload (客户端 -> 服务器)
 */
export interface FileMetadataPayload {
  fileName: string;
  fileSize: number;
}

/**
 * 文件路径请求 Payload (客户端 -> 服务器)
 * 请求后端发送指定路径的文件
 */
export interface FilePathRequestPayload {
  absolutePath: string;
}

/**
 * 文件发送错误 Payload (服务器 -> 客户端)
 */
export interface FileSendErrorPayload {
  error: string;
  absolutePath?: string;
}

/**
 * 视觉操作请求 Payload (服务器 -> 客户端)
 */
export type VisionActionPayload =
  | { action: 'screenshot'; parameters?: Record<string, never> }
  | { action: 'zoom'; parameters: import('@/tools/vision/observation-tools').ZoomArgs }
  | { action: 'check'; parameters: import('@/tools/vision/observation-tools').CheckArgs }
  | { action: import('@/tools/vision/gui-driver').GuiAction; parameters: import('@/tools/vision/gui-driver').GuiParameters };

/**
 * 视觉操作响应 Payload (客户端 -> 服务器)
 */
export interface VisionActionResponsePayload {
  success: boolean;
  message?: string;
  error?: string;
  data?: {
    elementsCount?: number;     // 高级截屏返回的元素数量
    screenshotSent?: boolean;   // 是否发送了截屏文件
    actionCompleted?: boolean;  // 操作是否完成
    viewportHeight?: number;    // 视口高度（像素）
    viewportWidth?: number;     // 视口宽度（像素）
    [key: string]: any;         // 其他扩展数据
  };
}

// ============ 事件类型 ============
export enum WebSocketEventType {
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  ERROR = 'ERROR',
  MESSAGE_RECEIVED = 'MESSAGE_RECEIVED',
  MESSAGE_SENT = 'MESSAGE_SENT',
  BINARY_RECEIVED = 'BINARY_RECEIVED',
  /** 中转模式下前端要求重发工具注册（RELAY_REQUEST_REREGISTER） */
  REREGISTER_REQUESTED = 'REREGISTER_REQUESTED',
}

// ============ 连接状态 ============
export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  ERROR = 'ERROR',
}

// ============ 配置 ============
export interface WebSocketConfig {
  url: string;
  reconnectInterval: number;
  maxReconnectAttempts: number;
  heartbeatInterval: number;
  /**
   * 前端中转模式（V2026.09.24 用户浏览器场景）：
   * 连接桌面端 :52715 而非后端；连接后发 PLUGIN_HELLO；
   * 下行 RELAY_DOWNLINK_FRAME 解包 inner 后按原逻辑分发。
   */
  relay?: {
    browserUuid: string;
    pluginVersion: string;
  };
}

export const DEFAULT_WEBSOCKET_CONFIG: WebSocketConfig = {
  url: 'ws://localhost:52725/api/automation',
  reconnectInterval: 5000,
  maxReconnectAttempts: 10,
  heartbeatInterval: 30000,
};

/** 前端中转默认端口（Electron app.config.browserProxyPort） */
export const DEFAULT_FRONTEND_RELAY_PORT = 52715;

/** 中转下行消息类型 */
export const RELAY_DOWNLINK_FRAME = 'RELAY_DOWNLINK_FRAME';
export const RELAY_REQUEST_REREGISTER = 'RELAY_REQUEST_REREGISTER';

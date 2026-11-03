/**
 * WebRTC 屏幕共享类型定义
 *
 * 消息流向：
 *   插件 Offscreen ←→ Background SW ←→ [WebSocket] ←→ Java 后端 ←→ LAN Viewer
 */

// ============ WebSocket 信令类型（与 Java 后端约定） ============

export enum WebRTCSignalType {
  // 插件 → 后端：请求开播（由后端分配 roomId）
  START_BROADCAST_REQUEST = 'WEBRTC_START_BROADCAST_REQUEST',

  // 后端 → 插件：确认开播并下发 roomId
  START_BROADCAST = 'WEBRTC_START_BROADCAST',

  // 插件 → 后端：停止广播
  STOP_BROADCAST  = 'WEBRTC_STOP_BROADCAST',

  // 插件 → 后端 → 观看者：SDP 协商
  OFFER           = 'WEBRTC_OFFER',
  ICE_CANDIDATE   = 'WEBRTC_ICE_CANDIDATE',

  // 后端 → 插件：观看者事件
  VIEWER_JOINED   = 'WEBRTC_VIEWER_JOINED',
  VIEWER_LEFT     = 'WEBRTC_VIEWER_LEFT',
  ROOM_CLOSED     = 'WEBRTC_ROOM_CLOSED',

  // 后端 → 插件（来自观看者）：SDP Answer 和 ICE
  ANSWER          = 'WEBRTC_ANSWER',
  ICE_FROM_VIEWER = 'WEBRTC_ICE_FROM_VIEWER',

  // 插件 → 后端：统一错误上报
  PLUGIN_ERROR_REPORT = 'PLUGIN_ERROR_REPORT',
}

// ── WebSocket Payload 类型 ────────────────────────────────────────

export interface StartBroadcastPayload {
  roomId: string;
  /** 后端返回的局域网观看链接，如 http://192.168.x.x:52725/viewer?room=xxx */
  viewerUrl?: string;
}

export interface StartBroadcastRequestPayload {
  requestedBy: 'plugin';
}

export interface StopBroadcastPayload {
  roomId: string;
}

export interface OfferPayload {
  roomId: string;
  targetViewerId: string;
  sdp: RTCSessionDescriptionInit;
}

export interface AnswerPayload {
  roomId: string;
  viewerId?: string;
  targetViewerId?: string;
  sdp?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  description?: RTCSessionDescriptionInit;
}

export interface IceCandidatePayload {
  roomId: string;
  /** viewer → broadcaster 时携带；broadcaster → viewer 时由 targetViewerId 确定 */
  viewerId?: string;
  targetViewerId?: string;
  candidate: RTCIceCandidateInit;
}

export interface ViewerEventPayload {
  roomId: string;
  viewerId: string;
}

export interface RoomClosedPayload {
  roomId: string;
  reason?: string;
}

export interface PluginErrorReportPayload {
  timestamp: string;
  module: 'background' | 'offscreen' | 'webrtc';
  stage: string;
  message: string;
  roomId?: string;
  viewerId?: string;
  correlationId?: string;
  stack?: string;
  details?: Record<string, any>;
}

// ============ Offscreen ↔ Background Service Worker 内部消息类型 ============

export enum OffscreenMsgType {
  // Background → Offscreen（命令）
  START           = 'SS_OFFSCREEN_START',
  STOP            = 'SS_OFFSCREEN_STOP',
  NEW_VIEWER      = 'SS_OFFSCREEN_NEW_VIEWER',
  REMOTE_ANSWER   = 'SS_OFFSCREEN_REMOTE_ANSWER',
  ICE_FROM_VIEWER = 'SS_OFFSCREEN_ICE_FROM_VIEWER',
  VIEWER_LEFT     = 'SS_OFFSCREEN_VIEWER_LEFT',

  // Background → Offscreen（captureVisibleTab 轮询回退）
  START_POLLING   = 'SS_OFFSCREEN_START_POLLING',
  CAPTURE_FRAME   = 'SS_OFFSCREEN_CAPTURE_FRAME',

  // Offscreen → Background（事件）
  STARTED         = 'SS_OFFSCREEN_STARTED',
  START_FAILED    = 'SS_OFFSCREEN_START_FAILED',
  SEND_OFFER      = 'SS_OFFSCREEN_SEND_OFFER',
  ICE_TO_VIEWER   = 'SS_OFFSCREEN_ICE_TO_VIEWER',
  STREAM_ENDED    = 'SS_OFFSCREEN_STREAM_ENDED',
  ERROR_REPORT    = 'SS_OFFSCREEN_ERROR_REPORT',
}

// ============ 广播状态（对外暴露给 SidePanel 等 UI） ============

export interface ScreenShareStatus {
  isActive: boolean;
  roomId: string | null;
  viewerCount: number;
  viewerUrl: string | null;
}

// ============ Background → SidePanel 状态通知消息 ============

export const SCREEN_SHARE_STATUS_MSG = 'SCREEN_SHARE_STATUS_CHANGED';

// ============ SidePanel / 外部 → Background 控制消息类型 ============

export const SCREEN_SHARE_MSG = {
  START:      'SCREEN_SHARE_START',
  STOP:       'SCREEN_SHARE_STOP',
  GET_STATUS: 'SCREEN_SHARE_GET_STATUS',
} as const;

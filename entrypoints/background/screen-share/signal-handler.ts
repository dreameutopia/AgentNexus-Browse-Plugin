/**
 * 屏幕共享信令处理器（稳定版）
 *
 * 策略：
 * - 仅使用 getDisplayMedia 采集（不走 tabCapture）
 * - 保持现有后端协议不变
 * - 所有异常统一通过 PLUGIN_ERROR_REPORT 上报
 */

import { WebSocketClient } from '../ws/websocket-client';
import { WebSocketMessage } from '../ws/websocket-types';
import { offscreenBridge } from './offscreen-bridge';
import {
  WebRTCSignalType,
  OffscreenMsgType,
  ScreenShareStatus,
  SCREEN_SHARE_STATUS_MSG,
  StartBroadcastRequestPayload,
  StartBroadcastPayload,
  StopBroadcastPayload,
  OfferPayload,
  AnswerPayload,
  IceCandidatePayload,
  ViewerEventPayload,
  RoomClosedPayload,
  PluginErrorReportPayload,
} from './types';

export class ScreenShareSignalHandler {
  private wsClient: WebSocketClient;
  private isStartRequested = false;
  private capturePollingTimer: ReturnType<typeof setInterval> | null = null;

  private status: ScreenShareStatus = {
    isActive: false,
    roomId: null,
    viewerCount: 0,
    viewerUrl: null,
  };

  constructor(wsClient: WebSocketClient) {
    this.wsClient = wsClient;
  }

  getStatus(): ScreenShareStatus {
    return { ...this.status };
  }

  async startBroadcast(): Promise<{ success: boolean; error?: string }> {
    if (this.status.isActive) {
      return { success: false, error: '已经在广播中，请先停止当前广播' };
    }

    if (this.isStartRequested) {
      return { success: false, error: '已发送开播请求，请等待后端下发 roomId' };
    }

    if (!this.wsClient.isConnected()) {
      return { success: false, error: 'WebSocket 未连接，无法发起开播请求' };
    }

    try {
      this.sendSignalToBackend<StartBroadcastRequestPayload>(
        WebRTCSignalType.START_BROADCAST_REQUEST,
        { requestedBy: 'plugin' },
      );

      this.isStartRequested = true;
      return { success: true };
    } catch (e) {
      this.reportError({
        module: 'background',
        stage: 'start_broadcast_request',
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      this.isStartRequested = false;
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async stopBroadcast(): Promise<void> {
    if (!this.status.isActive) {
      this.isStartRequested = false;
      return;
    }

    await this.stopBroadcastInternal(true);
  }

  private async stopBroadcastInternal(sendStopSignal: boolean): Promise<void> {
    if (!this.status.isActive) {
      this.isStartRequested = false;
      return;
    }

    const roomId = this.status.roomId;

    this.stopCapturePolling();
    await offscreenBridge.sendToOffscreen({ type: OffscreenMsgType.STOP });

    if (sendStopSignal && roomId) {
      this.sendSignalToBackend<StopBroadcastPayload>(
        WebRTCSignalType.STOP_BROADCAST,
        { roomId },
      );
    }

    this.status = { isActive: false, roomId: null, viewerCount: 0, viewerUrl: null };
    this.isStartRequested = false;
    this.notifyStatus();
  }

  handleWebSocketSignal(msgType: string, payload: unknown): void {
    switch (msgType) {
      case WebRTCSignalType.START_BROADCAST_REQUEST: {
        this.isStartRequested = true;
        break;
      }

      case WebRTCSignalType.START_BROADCAST: {
        const p = payload as StartBroadcastPayload;
        this.beginBroadcastWithAssignedRoom(p).catch((error) => {
          this.reportError({
            module: 'background',
            stage: 'begin_broadcast_with_assigned_room',
            roomId: p.roomId,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        });
        break;
      }

      case WebRTCSignalType.VIEWER_JOINED: {
        const p = payload as ViewerEventPayload;
        this.status.viewerCount = (this.status.viewerCount ?? 0) + 1;
        offscreenBridge.sendToOffscreen({
          type: OffscreenMsgType.NEW_VIEWER,
          viewerId: p.viewerId,
        });
        this.notifyStatus();
        break;
      }

      case WebRTCSignalType.VIEWER_LEFT: {
        const p = payload as ViewerEventPayload;
        this.status.viewerCount = Math.max(0, (this.status.viewerCount ?? 1) - 1);
        offscreenBridge.sendToOffscreen({
          type: OffscreenMsgType.VIEWER_LEFT,
          viewerId: p.viewerId,
        });
        this.notifyStatus();
        break;
      }

      case WebRTCSignalType.ANSWER: {
        const p = payload as AnswerPayload;
        const viewerId = this.resolveViewerId(p);
        const answer = this.resolveAnswerDescription(p);
        if (!viewerId || !answer) {
          this.reportError({
            module: 'webrtc',
            stage: 'answer_payload_invalid',
            roomId: p.roomId,
            message: 'ANSWER 消息缺少必要字段',
            details: { payload: p as any },
          });
          break;
        }

        offscreenBridge.sendToOffscreen({
          type: OffscreenMsgType.REMOTE_ANSWER,
          viewerId,
          sdp: answer,
        });
        break;
      }

      case WebRTCSignalType.ICE_FROM_VIEWER: {
        const p = payload as IceCandidatePayload;
        const viewerId = this.resolveViewerId(p);
        if (!viewerId || !p.candidate) {
          this.reportError({
            module: 'webrtc',
            stage: 'ice_from_viewer_payload_invalid',
            roomId: p.roomId,
            message: 'ICE_FROM_VIEWER 缺少必要字段',
            details: { payload: p as any },
          });
          break;
        }

        offscreenBridge.sendToOffscreen({
          type: OffscreenMsgType.ICE_FROM_VIEWER,
          viewerId,
          candidate: p.candidate,
        });
        break;
      }

      case WebRTCSignalType.ROOM_CLOSED: {
        const p = payload as RoomClosedPayload;
        this.stopBroadcastInternal(false).catch((error) => {
          this.reportError({
            module: 'background',
            stage: 'room_closed_cleanup_failed',
            roomId: p.roomId,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        });
        break;
      }
    }
  }

  private async beginBroadcastWithAssignedRoom(payload: StartBroadcastPayload): Promise<void> {
    const roomId = payload.roomId;
    if (!roomId) {
      throw new Error('后端未下发 roomId，无法开始广播');
    }

    if (this.status.isActive && this.status.roomId === roomId) {
      return;
    }

    if (this.status.isActive && this.status.roomId !== roomId) {
      await this.stopBroadcast();
    }

    await offscreenBridge.ensureDocument();

    // 优先尝试 tabCapture（在 Docker/无头环境中 getDisplayMedia 不可用）
    let tabCaptureStreamId: string | undefined;
    try {
      // Step 1: 确保存在焦点窗口（Docker/Xvfb 中可能没有）
      const allWindows = await chrome.windows.getAll();
      if (allWindows.length > 0) {
        const focusedWin = allWindows.find(w => w.focused);
        if (!focusedWin) {
          await chrome.windows.update(allWindows[0].id!, { focused: true });
          // 等待焦点生效
          await new Promise(r => setTimeout(r, 200));
        }
      }

      // Step 2: 查找可捕获的标签页
      let targetTab: chrome.tabs.Tab | undefined;

      // 优先找活跃标签
      const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      targetTab = activeTabs.find(t => t.id != null);

      // 回退：任意非扩展页标签
      if (!targetTab) {
        const allTabs = await chrome.tabs.query({});
        targetTab = allTabs.find(t =>
          t.id != null &&
          !t.url?.startsWith('chrome-extension://') &&
          !t.url?.startsWith('chrome://'),
        );
        // 最终回退：任意有 id 的标签
        if (!targetTab) {
          targetTab = allTabs.find(t => t.id != null);
        }
      }

      if (targetTab?.id != null) {
        const tabUrl = targetTab.url ?? '';
        const isCapturableUrl = tabUrl.startsWith('http://') || tabUrl.startsWith('https://');

        // tabCapture 需要目标标签在 http/https URL 上（about:blank、chrome:// 不匹配 host_permissions）
        if (!isCapturableUrl) {
          this.reportError({
            module: 'background',
            stage: 'tab_capture_navigating',
            roomId,
            message: `Tab URL (${tabUrl}) 不可捕获，正在导航到 HTTP 页面...`,
          });

          // 导航到 Docker 容器内部的 Flask 健康端点（保证可达，无需外网）
          await chrome.tabs.update(targetTab.id, { url: 'http://localhost:8080/health' });

          // 等待页面加载完成（最长 8 秒）
          await new Promise<void>((resolve) => {
            const tabId = targetTab!.id!;
            const onUpdated = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
              if (updatedTabId === tabId && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(onUpdated);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(onUpdated);
            setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }, 8000);
          });

          await new Promise(r => setTimeout(r, 300));
        }

        // 重新查询 tab 获取导航后的最新 URL
        const freshTab = await chrome.tabs.get(targetTab.id);

        // 在目标页面执行脚本以 "invoke" 扩展（激活 activeTab 权限）
        try {
          await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            func: () => { /* noop - 仅用于激活 activeTab */ },
          });
        } catch (scriptErr) {
          this.reportError({
            module: 'background',
            stage: 'tab_capture_activate_script_failed',
            roomId,
            message: `executeScript 激活失败: ${scriptErr instanceof Error ? scriptErr.message : String(scriptErr)}`,
          });
        }

        this.reportError({
          module: 'background',
          stage: 'tab_capture_attempting',
          roomId,
          message: `尝试 tabCapture, tabId=${targetTab.id}, url=${freshTab.url ?? 'N/A'}`,
        });

        tabCaptureStreamId = await new Promise<string>((resolve, reject) => {
          chrome.tabCapture.getMediaStreamId({ targetTabId: targetTab!.id! }, (streamId) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(streamId);
            }
          });
        });
        this.reportError({
          module: 'background',
          stage: 'tab_capture_stream_id_obtained',
          roomId,
          message: `tabCapture.getMediaStreamId 成功, tabId=${targetTab.id}, streamId 长度=${tabCaptureStreamId?.length ?? 0}`,
        });
      } else {
        this.reportError({
          module: 'background',
          stage: 'tab_capture_no_tab_found',
          roomId,
          message: `未找到可捕获的标签页，windows=${allWindows.length}，将回退到 getDisplayMedia`,
        });
      }
    } catch (e) {
      this.reportError({
        module: 'background',
        stage: 'tab_capture_get_stream_id_failed',
        roomId,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
    }

    const result = await offscreenBridge.sendToOffscreen({
      type: OffscreenMsgType.START,
      roomId,
      streamId: tabCaptureStreamId,
    });

    if (result && result.ok === false) {
      // tabCapture streamId + getDisplayMedia 均失败，尝试 captureVisibleTab 轮询回退
      this.reportError({
        module: 'background',
        stage: 'fallback_to_capture_visible_tab',
        roomId,
        message: '前置采集方式均失败，尝试 captureVisibleTab 轮询回退...',
      });

      const pollingOk = await this.startCaptureVisibleTabPolling(roomId);
      if (!pollingOk) {
        this.isStartRequested = false;
        await offscreenBridge.sendToOffscreen({ type: OffscreenMsgType.STOP });
        throw new Error(result.error ?? '屏幕采集启动失败（所有方式均失败，含 captureVisibleTab）');
      }
    }

    this.status = {
      isActive: true,
      roomId,
      viewerCount: 0,
      viewerUrl: payload.viewerUrl ?? null,
    };
    this.isStartRequested = false;
    this.notifyStatus();
  }

  /**
   * captureVisibleTab 轮询回退：
   * 利用 chrome.tabs.captureVisibleTab（只需 <all_urls> host_permissions，不需要 activeTab 激活）
   * 将截图帧持续发送给 offscreen document，offscreen 通过 canvas.captureStream 生成 MediaStream。
   */
  private async startCaptureVisibleTabPolling(roomId: string): Promise<boolean> {
    try {
      const windows = await chrome.windows.getAll();
      const windowId = windows[0]?.id;
      if (!windowId) {
        this.reportError({
          module: 'background',
          stage: 'capture_visible_tab_no_window',
          roomId,
          message: '没有可用的窗口',
        });
        return false;
      }

      // 告诉 offscreen 进入轮询 canvas 模式
      const initResult = await offscreenBridge.sendToOffscreen({
        type: OffscreenMsgType.START_POLLING,
        roomId,
      });

      if (initResult && initResult.ok === false) {
        this.reportError({
          module: 'background',
          stage: 'capture_visible_tab_init_failed',
          roomId,
          message: initResult.error ?? 'offscreen 初始化 canvas 模式失败',
        });
        return false;
      }

      // 开始 10 FPS 轮询
      const FPS = 10;
      this.capturePollingTimer = setInterval(async () => {
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
            format: 'jpeg',
            quality: 60,
          });
          // 发送帧到 offscreen（不等待响应，fire-and-forget）
          offscreenBridge.sendToOffscreen({
            type: OffscreenMsgType.CAPTURE_FRAME,
            dataUrl,
          }).catch(() => {});
        } catch {
          // 单帧失败忽略（例如窗口最小化、标签切换等）
        }
      }, 1000 / FPS);

      this.reportError({
        module: 'background',
        stage: 'capture_visible_tab_polling_started',
        roomId,
        message: `captureVisibleTab 轮询已启动, windowId=${windowId}, FPS=${FPS}`,
      });

      return true;
    } catch (e) {
      this.reportError({
        module: 'background',
        stage: 'capture_visible_tab_start_failed',
        roomId,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      return false;
    }
  }

  private stopCapturePolling(): void {
    if (this.capturePollingTimer !== null) {
      clearInterval(this.capturePollingTimer);
      this.capturePollingTimer = null;
    }
  }

  private resolveViewerId(payload: { viewerId?: string; targetViewerId?: string }): string | undefined {
    return payload.viewerId || payload.targetViewerId;
  }

  private resolveAnswerDescription(payload: AnswerPayload): RTCSessionDescriptionInit | undefined {
    const raw = payload.sdp || payload.answer || payload.description;
    if (!raw) return undefined;

    if (typeof raw === 'string') {
      return { type: 'answer', sdp: raw };
    }

    if (!raw.type && raw.sdp) {
      return { type: 'answer', sdp: raw.sdp };
    }

    return raw;
  }

  handleOffscreenMessage(msg: Record<string, unknown>): void {
    switch (msg.type as OffscreenMsgType) {
      case OffscreenMsgType.SEND_OFFER:
        this.sendSignalToBackend<OfferPayload>(WebRTCSignalType.OFFER, {
          roomId: msg.roomId as string,
          targetViewerId: msg.viewerId as string,
          sdp: msg.sdp as RTCSessionDescriptionInit,
        });
        break;

      case OffscreenMsgType.ICE_TO_VIEWER:
        this.sendSignalToBackend<IceCandidatePayload>(WebRTCSignalType.ICE_CANDIDATE, {
          roomId: msg.roomId as string,
          viewerId: msg.viewerId as string,
          candidate: msg.candidate as RTCIceCandidateInit,
        });
        break;

      case OffscreenMsgType.STREAM_ENDED:
        this.stopBroadcast();
        break;

      case OffscreenMsgType.ERROR_REPORT:
        this.reportError({
          module: 'offscreen',
          stage: String(msg.stage || 'offscreen_runtime_error'),
          message: String(msg.message || 'offscreen runtime error'),
          roomId: typeof msg.roomId === 'string' ? msg.roomId : undefined,
          viewerId: typeof msg.viewerId === 'string' ? msg.viewerId : undefined,
          stack: typeof msg.stack === 'string' ? msg.stack : undefined,
          details: (msg.details && typeof msg.details === 'object') ? msg.details as Record<string, any> : undefined,
        });
        break;
    }
  }

  private sendSignalToBackend<T>(type: WebRTCSignalType, payload: T): void {
    const message: WebSocketMessage<T> = {
      type,
      correlationId: `webrtc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      payload,
    };

    const sent = this.wsClient.send(message);
    if (!sent) {
      console.warn(`[ScreenShare] WebSocket 未连接，信令 ${type} 发送失败`);
    }
  }

  private reportError(input: Omit<PluginErrorReportPayload, 'timestamp'>): void {
    const payload: PluginErrorReportPayload = {
      timestamp: new Date().toISOString(),
      ...input,
    };

    const message: WebSocketMessage<PluginErrorReportPayload> = {
      type: WebRTCSignalType.PLUGIN_ERROR_REPORT,
      correlationId: `plugin-error-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      payload,
    };

    const sent = this.wsClient.send(message);
    if (!sent) {
      console.warn('[ScreenShare] 错误上报发送失败（WebSocket 未连接）:', payload);
    }
  }

  private notifyStatus(): void {
    chrome.runtime.sendMessage({
      type: SCREEN_SHARE_STATUS_MSG,
      status: this.getStatus(),
    }).catch(() => {});
  }
}

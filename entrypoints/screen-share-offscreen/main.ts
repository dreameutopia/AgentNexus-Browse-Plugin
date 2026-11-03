import { OffscreenMsgType } from '../background/screen-share/types';

type ErrorDetails = Record<string, unknown>;
type DisplayMediaConstraints = {
  video: boolean | MediaTrackConstraints;
  audio?: boolean | MediaTrackConstraints;
};

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 4,
};

let localStream: MediaStream | null = null;
const peers = new Map<string, RTCPeerConnection>();
const pendingViewers = new Set<string>();
let currentRoomId: string | null = null;

// captureVisibleTab 轮询模式状态
let pollingCanvas: HTMLCanvasElement | null = null;
let pollingCtx: CanvasRenderingContext2D | null = null;
let isPollingMode = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const { type } = msg as { type: OffscreenMsgType };

  switch (type) {
    case OffscreenMsgType.START:
      handleStart(msg.roomId as string, msg.streamId as string | undefined)
        .then(() => sendResponse({ ok: true }))
        .catch((e: Error) => sendResponse({ ok: false, error: e.message }));
      return true;

    case OffscreenMsgType.STOP:
      handleStop();
      sendResponse({ ok: true });
      break;

    case OffscreenMsgType.NEW_VIEWER:
      handleNewViewer(msg.viewerId as string).catch((error) => {
        reportError('new_viewer_failed', error, {
          viewerId: msg.viewerId as string,
          roomId: currentRoomId,
        });
      });
      break;

    case OffscreenMsgType.REMOTE_ANSWER:
      handleRemoteAnswer(
        msg.viewerId as string,
        msg.sdp as RTCSessionDescriptionInit,
      ).catch((error) => {
        reportError('set_remote_answer_failed', error, {
          viewerId: msg.viewerId as string,
          roomId: currentRoomId,
        });
      });
      break;

    case OffscreenMsgType.ICE_FROM_VIEWER:
      handleIceFromViewer(
        msg.viewerId as string,
        msg.candidate as RTCIceCandidateInit,
      ).catch((error) => {
        reportError('add_ice_from_viewer_failed', error, {
          viewerId: msg.viewerId as string,
          roomId: currentRoomId,
        });
      });
      break;

    case OffscreenMsgType.VIEWER_LEFT:
      closePeer(msg.viewerId as string);
      break;

    case OffscreenMsgType.START_POLLING:
      handleStartPolling(msg.roomId as string)
        .then(() => sendResponse({ ok: true }))
        .catch((e: Error) => sendResponse({ ok: false, error: e.message }));
      return true;

    case OffscreenMsgType.CAPTURE_FRAME:
      handleCaptureFrame(msg.dataUrl as string);
      break;
  }
});

async function handleStart(roomId: string, streamId?: string): Promise<void> {
  if (localStream) {
    handleStop();
  }

  currentRoomId = roomId;

  // 优先使用 tabCapture 路径（Docker/无头环境可靠），回退到 getDisplayMedia
  if (streamId) {
    try {
      localStream = await getStreamFromTabCapture(streamId, roomId);
    } catch (tabCaptureError) {
      reportError('tab_capture_failed_fallback_to_display_media', tabCaptureError, { roomId });
      localStream = await tryGetDisplayMediaWithFallback(roomId);
    }
  } else {
    localStream = await tryGetDisplayMediaWithFallback(roomId);
  }

  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.addEventListener('ended', () => {
      handleStop();
      chrome.runtime.sendMessage({
        type: OffscreenMsgType.STREAM_ENDED,
        roomId: currentRoomId,
      }).catch(() => {});
    });
  }

  if (pendingViewers.size > 0) {
    const waiting = Array.from(pendingViewers);
    pendingViewers.clear();
    for (const viewerId of waiting) {
      await handleNewViewer(viewerId);
    }
  }
}

/**
 * 通过 tabCapture streamId 获取媒体流（在 Docker/无头环境中可靠）
 */
async function getStreamFromTabCapture(streamId: string, roomId: string): Promise<MediaStream> {
  console.log('[ScreenShareOffscreen] 尝试 tabCapture getUserMedia, streamId:', streamId.substring(0, 20) + '...');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      } as any,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxFrameRate: 30,
        },
      } as any,
    });
    console.log(`[ScreenShareOffscreen] tabCapture getUserMedia 成功, tracks: video=${stream.getVideoTracks().length}, audio=${stream.getAudioTracks().length}`);
    return stream;
  } catch (error) {
    reportError('tab_capture_get_user_media_failed', error, { roomId });
    throw error;
  }
}

async function tryGetDisplayMediaWithFallback(roomId: string): Promise<MediaStream> {
  const attempts: Array<{ label: string; constraints: DisplayMediaConstraints }> = [
    {
      label: 'preferred-video-no-audio',
      constraints: {
        video: {
          frameRate: { ideal: 30, max: 30 },
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
        },
        audio: false,
      },
    },
    {
      label: 'basic-video-no-audio',
      constraints: { video: true, audio: false },
    },
    {
      label: 'basic-video-with-audio',
      constraints: { video: true, audio: true },
    },
  ];

  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(attempt.constraints);
      console.log(`[ScreenShareOffscreen] getDisplayMedia 成功: ${attempt.label}`);
      return stream;
    } catch (error) {
      lastError = error;
      reportError('get_display_media_attempt_failed', error, {
        roomId,
        attempt: attempt.label,
      });
    }
  }

  reportError('get_display_media_failed', lastError ?? 'unknown_error', { roomId });
  throw new Error('getDisplayMedia 采集失败（所有策略均失败）');
}

function handleStop(): void {
  localStream?.getTracks().forEach(track => track.stop());
  localStream = null;

  // 清理轮询模式状态
  pollingCanvas = null;
  pollingCtx = null;
  isPollingMode = false;

  peers.forEach((pc) => pc.close());
  peers.clear();
  pendingViewers.clear();

  currentRoomId = null;
}

/**
 * captureVisibleTab 轮询模式：创建 canvas + captureStream 作为 MediaStream 源。
 * Background 会持续发送 CAPTURE_FRAME 消息，offscreen 绘制到 canvas 生成视频帧。
 */
async function handleStartPolling(roomId: string): Promise<void> {
  if (localStream) {
    handleStop();
  }

  currentRoomId = roomId;
  isPollingMode = true;

  pollingCanvas = document.createElement('canvas');
  pollingCanvas.width = 1920;
  pollingCanvas.height = 1080;
  pollingCtx = pollingCanvas.getContext('2d')!;

  // captureStream(0) = 仅在 requestFrame() 时推送帧，避免空帧占带宽
  localStream = pollingCanvas.captureStream(0);

  console.log('[ScreenShareOffscreen] captureVisibleTab 轮询模式已启动, canvas 1920x1080');

  // 处理等待中的观看者
  if (pendingViewers.size > 0) {
    const waiting = Array.from(pendingViewers);
    pendingViewers.clear();
    for (const viewerId of waiting) {
      await handleNewViewer(viewerId);
    }
  }
}

/**
 * 接收来自 background 的 captureVisibleTab 截图帧，绘制到 canvas 并推送视频帧。
 */
function handleCaptureFrame(dataUrl: string): void {
  if (!pollingCanvas || !pollingCtx || !localStream) return;

  const img = new Image();
  img.onload = () => {
    pollingCtx!.drawImage(img, 0, 0, pollingCanvas!.width, pollingCanvas!.height);
    // 通知 captureStream 推送新帧
    const videoTrack = localStream?.getVideoTracks()[0];
    if (videoTrack && 'requestFrame' in videoTrack) {
      (videoTrack as any).requestFrame();
    }
  };
  img.src = dataUrl;
}

async function handleNewViewer(viewerId: string): Promise<void> {
  if (!localStream) {
    pendingViewers.add(viewerId);
    reportError('no_local_stream_for_viewer', 'localStream is null when viewer joined', {
      roomId: currentRoomId,
      viewerId,
    });
    return;
  }

  if (peers.has(viewerId)) {
    closePeer(viewerId);
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peers.set(viewerId, pc);

  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream!);
  });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      chrome.runtime.sendMessage({
        type: OffscreenMsgType.ICE_TO_VIEWER,
        roomId: currentRoomId,
        viewerId,
        candidate: candidate.toJSON(),
      }).catch(() => {});
    }
  };

  pc.oniceconnectionstatechange = () => {
    reportError('ice_connection_state_changed', `state=${pc.iceConnectionState}`, {
      roomId: currentRoomId,
      viewerId,
    });
  };

  pc.onicegatheringstatechange = () => {
    reportError('ice_gathering_state_changed', `state=${pc.iceGatheringState}`, {
      roomId: currentRoomId,
      viewerId,
    });
  };

  pc.onicecandidateerror = (event) => {
    reportError('ice_candidate_error', `errorCode=${event.errorCode}, errorText=${event.errorText}`, {
      roomId: currentRoomId,
      viewerId,
      address: event.address,
      port: event.port,
      url: event.url,
    });
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    reportError('peer_connection_state_changed', `state=${state}`, {
      roomId: currentRoomId,
      viewerId,
    });

    // disconnected 可能是网络瞬断，先不立即关闭
    if (state === 'failed' || state === 'closed') {
      closePeer(viewerId);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  chrome.runtime.sendMessage({
    type: OffscreenMsgType.SEND_OFFER,
    roomId: currentRoomId,
    viewerId,
    sdp: pc.localDescription,
  }).catch((error) => {
    reportError('send_offer_message_failed', error, {
      roomId: currentRoomId,
      viewerId,
    });
  });
}

async function handleRemoteAnswer(
  viewerId: string,
  sdp: RTCSessionDescriptionInit,
): Promise<void> {
  const pc = peers.get(viewerId);
  if (!pc) {
    return;
  }

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function handleIceFromViewer(
  viewerId: string,
  candidate: RTCIceCandidateInit,
): Promise<void> {
  const pc = peers.get(viewerId);
  if (!pc) {
    return;
  }

  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    reportError('add_ice_candidate_failed', e, {
      roomId: currentRoomId,
      viewerId,
    });
  }
}

function closePeer(viewerId: string): void {
  const pc = peers.get(viewerId);
  if (pc) {
    pc.close();
    peers.delete(viewerId);
  }
  pendingViewers.delete(viewerId);
}

/**
 * 上报 offscreen 运行时错误到 background，再由 background 统一转发后端。
 */
function reportError(stage: string, error: unknown, details?: ErrorDetails): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  console.error(`[ScreenShareOffscreen][${stage}]`, error);

  chrome.runtime.sendMessage({
    type: OffscreenMsgType.ERROR_REPORT,
    stage,
    message,
    stack,
    roomId: currentRoomId,
    details,
  }).catch(() => {
    // 避免错误上报失败导致递归
  });
}

window.addEventListener('error', (event) => {
  reportError('window_error', event.error || event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  reportError('unhandled_rejection', event.reason, {});
});

console.log('[ScreenShareOffscreen] Offscreen document 已加载，等待命令');

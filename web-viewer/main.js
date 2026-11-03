const wsUrlInput = document.getElementById('wsUrl');
const roomIdInput = document.getElementById('roomId');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusEl = document.getElementById('status');
const videoEl = document.getElementById('video');

let ws = null;
let pc = null;
let joinedRoom = null;

const SIGNAL = {
  JOIN_ROOM: 'WEBRTC_JOIN_ROOM',
  OFFER: 'WEBRTC_OFFER',
  ANSWER: 'WEBRTC_ANSWER',
  ICE_CANDIDATE: 'WEBRTC_ICE_CANDIDATE',
  ROOM_CLOSED: 'WEBRTC_ROOM_CLOSED',
};

function setStatus(text) {
  statusEl.textContent = text;
}

function buildWsMessage(type, payload) {
  return JSON.stringify({
    type,
    correlationId: `viewer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    payload,
  });
}

function getRtcConfig() {
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
    iceCandidatePoolSize: 4,
  };
}

function resetPeer() {
  if (pc) {
    pc.close();
    pc = null;
  }
  videoEl.srcObject = null;
}

async function handleOffer(payload) {
  if (!pc) {
    pc = new RTCPeerConnection(getRtcConfig());

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        videoEl.srcObject = event.streams[0];
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || !ws || ws.readyState !== WebSocket.OPEN || !joinedRoom) {
        return;
      }

      ws.send(
        buildWsMessage(SIGNAL.ICE_CANDIDATE, {
          roomId: joinedRoom,
          candidate: candidate.toJSON(),
        }),
      );
    };

    pc.onconnectionstatechange = () => {
      setStatus(`PeerConnection 状态: ${pc.connectionState}`);
    };
  }

  await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  ws.send(
    buildWsMessage(SIGNAL.ANSWER, {
      roomId: joinedRoom,
      sdp: pc.localDescription,
    }),
  );

  setStatus('已发送 Answer，等待 ICE 完成...');
}

async function handleIceCandidate(payload) {
  if (!pc || !payload?.candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
  } catch (err) {
    console.warn('添加 ICE candidate 失败:', err);
  }
}

function connect() {
  const wsUrl = wsUrlInput.value.trim();
  const roomId = roomIdInput.value.trim();

  if (!wsUrl || !roomId) {
    setStatus('请填写 WebSocket 地址和 Room ID');
    return;
  }

  joinedRoom = roomId;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setStatus('WebSocket 已连接，正在加入房间...');
    ws.send(buildWsMessage(SIGNAL.JOIN_ROOM, { roomId }));
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
  };

  ws.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      const { type, payload } = message;

      if (type === SIGNAL.OFFER) {
        await handleOffer(payload);
      } else if (type === SIGNAL.ICE_CANDIDATE) {
        await handleIceCandidate(payload);
      } else if (type === SIGNAL.ROOM_CLOSED) {
        setStatus('房间已关闭');
        disconnect();
      }
    } catch (error) {
      console.error('处理消息失败:', error);
      setStatus('处理信令消息失败');
    }
  };

  ws.onerror = () => {
    setStatus('WebSocket 连接错误');
  };

  ws.onclose = () => {
    setStatus('WebSocket 已断开');
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    resetPeer();
    ws = null;
  };
}

function disconnect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  resetPeer();
  ws = null;
  joinedRoom = null;
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  setStatus('未连接');
}

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);

setStatus('未连接');

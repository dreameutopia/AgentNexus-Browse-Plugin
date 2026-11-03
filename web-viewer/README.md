# AgentNexus Web Viewer (MVP)

一个最小化网页端观看器，用于在局域网设备上实时观看插件推送的 WebRTC 屏幕流。

## 目录

- `index.html` 页面入口
- `main.js` WebSocket + WebRTC 逻辑
- `style.css` 简单样式

## 快速使用

1. 启动后端，并确保已实现 WebRTC 信令中继。
2. 在扩展端触发 `SCREEN_SHARE_START` 开播。
3. 打开本目录下的 `index.html`（或由后端托管成静态资源）。
4. 填入：
   - WebSocket：`ws://<后端IP>:52725/api/automation?role=viewer`
   - Room ID：扩展开播后生成的 `room-...`
5. 点击“连接并观看”。

## 与后端信令约定（viewer 侧）

### viewer -> backend

- `WEBRTC_JOIN_ROOM` payload: `{ roomId }`
- `WEBRTC_ANSWER` payload: `{ roomId, sdp }`
- `WEBRTC_ICE_CANDIDATE` payload: `{ roomId, candidate }`

### backend -> viewer

- `WEBRTC_OFFER` payload: `{ roomId, sdp }`
- `WEBRTC_ICE_CANDIDATE` payload: `{ roomId, candidate }`
- `WEBRTC_ROOM_CLOSED` payload: `{ roomId }` (可选)

## 说明

- 本项目为纯静态页面，无构建步骤。
- 生产环境建议通过后端同源托管并启用 HTTPS。

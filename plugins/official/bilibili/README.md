# Bilibili 搜索助手

Bilibili 站内视频检索、字幕提取与时间点跳转的官方插件。

## 能力

- `search`：导航到 Bilibili 搜索结果页，等待视频卡片渲染，按卡片结构提取标题、链接、UP 主、日期与时长。
- `subtitle`：在视频播放页提取字幕分段（页面上下文请求，继承登录态）。
- `jump`：读取播放状态、跳转时间点、播放/暂停、倍速与音量。
- 智能体 `Bilibili 搜索助手`：绑定以上 3 个工具与 `bilibili-video-summary` 技能。

## 权限说明

- 网络：`www.bilibili.com`、`search.bilibili.com`、`api.bilibili.com`，以及字幕 CDN `aisubtitle.hdslb.com`、`i0.hdslb.com`、`s1.hdslb.com`。
- 宿主工具：`browser_navigation`、`browser_extract_data`、`browser_page_ops`、`browser_page_http`、`browser_media_control`、`read_website`。
- 不申请密钥槽，不上传任何凭据。
- 搜索与字幕为只读；跳转只操作当前页面的媒体元素。

## 开发与发布

开发源位于宿主仓库 `plugins/official/bilibili/`。发布前必须使用官方发布者私钥重新打包；当前 `plugin.json` 中的发布者 ID 是开发密钥，不能用于官方目录上架。

```bash
npm run plugin:sdk -- pack plugins/official/bilibili --key <private-jwk-file> --out bilibili.anplugin
npm run plugin:sdk -- validate bilibili.anplugin
```

私钥必须放在插件目录之外，离线备份，且不要提交到仓库。

## 降级说明

- 无字幕、登录受限、API 412 / -352：`subtitle` 会返回明确错误，智能体应降级为标题/简介总结，不编造视频内容。
- Bilibili 改版导致选择器失效：更新 `search.json` 中的选择器并发布插件补丁，无需等待宿主版本。

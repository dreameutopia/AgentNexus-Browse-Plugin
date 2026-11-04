<p align="center">
  <img src="public/logo.png" alt="AgentNexus Browse Helper" width="128" height="128">
</p>

<h1 align="center">AgentNexus Browse Helper</h1>

<p align="center">
  <strong>🤖 强大且可扩展的浏览器自动化插件，将浏览器能力暴露给 AI 智能体</strong>
</p>

<p align="center">
  简体中文 | <a href="./README.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.1-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-green.svg" alt="License">
  <img src="https://img.shields.io/badge/Chrome-114%2B-brightgreen.svg" alt="Chrome">
  <img src="https://img.shields.io/badge/WXT-MV3-orange.svg" alt="WXT">
</p>

---

## ✨ 项目简介

**AgentNexus Browse Helper** 是一款基于 WXT / MV3 的 Chrome 浏览器扩展，可将浏览器转化为可编程的 AI 自动化平台。它提供了一套遵循 OpenAI 函数调用标准的丰富工具集，使 LLM 驱动的智能体能够与网页交互、搜索内容、采集资源并执行复杂的自动化工作流。

插件支持两种使用方式：

1. **配合 [AgentNexus](https://github.com/your-org/AgentNexus) 主程序**（推荐）：通过 WebSocket 自动化通道接受主程序调度，适合复杂的多步骤自动化工作流。
2. **独立使用**：在侧边栏聊天模式中配置自己的模型 API（OpenAI / Claude / Gemini / Ollama 等），即可脱离主程序直接对话并调用全部工具。

## 🔥 核心特性

### 🧰 丰富的工具体系
内置 **17 大类、70+ 工具**，覆盖不同抽象层次：标签页 / 窗口 / 导航管理、页面点击填充与滚动、截图与全页截图、网络请求捕获（CDP 调试器）、页面源码 / 正文提取、页面净化（去广告去追踪）、资源嗅探与下载、集成搜索、历史与书签管理、文本压缩、XLSX 读写、Excalidraw 画布绘制、Bilibili 字幕获取、代码执行等。

### 🔌 多协议模型接入
原生支持 **OpenAI、OpenAI Responses、Claude、Gemini、Ollama** 五种流式协议适配器，统一归一化为内部消息流；配套 SSE 协议契约测试（`tests/protocol-contract`），保证各厂商协议解析的准确性。

### 🧠 上下文与会话引擎
自研上下文引擎（上下文计量、转录引擎、上下文窗口守护）自动裁剪与压缩历史消息，配合会话数据库实现聊天记录持久化，长对话不溢出、可回溯。

### 🤖 智能体系统
内置 8 个预置智能体：深度搜索（Deep Search）、文本通用助手（General Text Assistant）、视觉助手（Vision Assistant）、视觉通用助手（General Vision Assistant）、搜索智能体（Search Agent）、数据收割机（Data Harvester）、Bilibili 智能体、思维导图助手；预置智能体的名称、描述、分类与标签随界面语言切换；支持在管理中心自定义智能体（模型、提示词、工具集、技能挂载）。

### 📚 技能系统
支持技能（Skill）加载与资源读取，内置 3 个技能：Bilibili 视频总结、网页调研报告、XLSX 创建；支持技能导入导出与可用性管理（设计理念详见下文「技能设计」）。

### 🗂️ 管理中心（Hub）
独立管理页面，集中管理智能体、技能与配置备份 / 恢复。

### 📝 内置工作笔记
基于 Tiptap 的富文本笔记应用，智能体可通过笔记工具直接创建、读取、更新、追加、删除笔记。

### 👁️ 视觉与语音
支持图片附件输入（视觉模型）、Tesseract.js 本地 OCR、OpenAI 兼容的语音识别（SiliconFlow / OpenAI / Groq / 自定义端点）。

### 🖼️ 富媒体消息渲染
Markdown 渲染支持 Mermaid 图表、KaTeX 公式、PlantUML、代码高亮与一键复制。

### 📊 用量统计
按提供商 / 模型维度统计 Token 用量与请求数，语音识别等真实 AI 请求同样计入。

### 🌐 双语界面
界面支持简体中文与 English，一键切换并全局持久化。

### 🛡️ 安全守护
受限 URL 保护、危险操作确认栏（Guard Confirm）、声明式网络请求规则。

## 🧭 技能（Skill）设计

### 设计定位
浏览器内的智能体**当前阶段没有 Bash 工具**，无法执行技能自带的任何脚本。因此本项目的技能不采用「可执行脚本」路线，而是定位为**可复用的经验文档**：用一份结构化的 `SKILL.md` 教会智能体如何组合现有工具完成一类任务。格式遵循 Agent Skills 开放规范（agentskills.io）的浏览器扩展适配版——规范中的 `scripts/` 目录在本环境中不会被执行，仅作为文字参考保留。

### 适合沉淀为技能的内容
- **工作流经验**：一套完整的方法论，如网络调研报告的「拆解问题 → 多源检索 → 交叉验证 → 过程留痕 → 汇总产出」；
- **场景解决方案**：特定任务的工具编排与参数要点，如创建 XLSX 表格时各字段的填写规则；
- **网站使用指导**：针对指定站点的操作手册，如 Bilibili 视频总结——页面特征识别、前置条件（已登录等）、专用工具的调用时机与降级策略。

换言之，技能沉淀的是「怎么做这件事的经验」，而不是「替你执行的代码」。

### 技能格式
一个技能 = 一个 `SKILL.md`（YAML frontmatter + Markdown 正文）+ 可选资源文件（如 `references/*.md`）。frontmatter 关键字段：

| 字段 | 说明 |
|---|---|
| `name` | 技能名（小写字母 / 数字 / 连字符）。**允许重名**——唯一性由下方标识承担 |
| `description` | 做什么 + 何时使用——模型据此自动匹配任务，用户据此选择启用 |
| `allowed-tools` | 预授权工具 ID 列表（空格分隔），技能激活后可直接调用 |
| `compatibility` | 环境要求说明（可选），如「需要已登录 Bilibili」 |

### 渐进式披露（控制上下文占用）
1. **发现**：系统提示词常驻 `<available-skills>` 清单，每项为技能标识 + 一行描述；
2. **激活**：用 `/` 预选的技能会在发送时自动封装成一轮 `load_skill` 调用注入上下文；未预选时由模型判定任务相关后自行调用 `load_skill`，注入完整指令（优先级约定 + SKILL.md 正文，软上限 15,000 字符）；
3. **深入**：需要更多背景时调用 `read_skill_file` 按路径读取资源文件（单文件上限 100,000 字符）。

### 上手参考
内置的三个技能（`skills/web-research-report`、`skills/bilibili-video-summary`、`skills/xlsx-creator`）即为官方模板，可直接阅读仿写；技能的启用 / 停用、导入 / 导出均可在管理中心完成。

## 📦 实现阶段

### ✅ 已实现
- 完备的工具集（17 大类、70+ 工具）与 8 个预置智能体
- 与 AgentNexus 主程序的 WebSocket 通信及工具调度
- OpenAI / OpenAI Responses / Claude / Gemini / Ollama 协议的正式接入（含契约测试）
- 独立使用能力：智能体引擎、上下文引擎与会话持久化
- 技能系统（加载 / 导入导出 / 可用性管理）与管理中心
- 内置笔记、语音识别、用量统计、双语界面

### 🔄 TODO
- 远程查看等高级功能
- 更多场景化工具与技能

## 🚀 快速开始

```bash
# 安装依赖
npm install

# 开发模式（Chromium）
npm run dev

# 生产构建
npm run build

# 运行测试
npm run test:contract   # SSE 协议契约测试
npm run test:engine     # 配置引擎测试

# 类型检查
npm run compile
```

构建产物位于 `.output/chromium-mv3`，在 `chrome://extensions` 开启「开发者模式」后通过「加载已解压的扩展程序」导入。

## ⚙️ 配置与打包

- **CHROME_EXTENSION_KEY（可选）**：在项目根目录创建 `.env` 文件并添加 `CHROME_EXTENSION_KEY=你的私钥`。只有在需要固定扩展 ID、或使用已有私钥打包时才需要填写；开发时通常无需填写。`wxt.config.ts` 会在构建时检测该值，只有在非占位且看起来合法时才会把它写入 manifest 的 `key` 字段。

- **version（必填，用于 WS 连接）**：在 `package.json` 中修改 `version` 字段为语义化版本号（例如 `1.0.0`）。构建时 `wxt.config.ts` 会读取该值并注入到 WebSocket 连接的 `version` 查询参数中，用于后端记录与兼容性判断。

- **BROWSER_UUID（推荐固定，用于后端识别浏览器实例）**：如果后端需要稳定的浏览器标识，请在 `.env` 中添加 `BROWSER_UUID=your-uuid`。我们在构建时会把该值注入到客户端（作为 `browserUuid` 查询参数）。如需生成 UUID，可使用 PowerShell 的 `[guid]::NewGuid().ToString()` 或访问 https://www.uuidgenerator.net/。

快速示例：

1. 在项目根目录创建 `.env`：

```
CHROME_EXTENSION_KEY=YOUR_PRIVATE_KEY_HERE
BROWSER_UUID=37e07350-f2ca-46d1-9408-acd8c3d86294
```

2. 修改 `package.json` 中的 `version`：

```json
"version": "1.0.0"
```

3. 本地运行或打包：

```bash
npm run dev
npm run build
```

构建后，WebSocket 连接将使用如下格式：

```
ws://{host}:{port}/api/automation?browserUuid={browserUuid}&version={x.x.x}
```

## 🤝 参与贡献

### ✅ 欢迎提交
- 按规范提交更多的工具实现

### ❌ 暂不接受
- 系统设计架构正在重构中，其他类型的贡献暂时请勿提交

## 📄 许可证

本项目基于 **GNU Affero General Public License v3.0** 许可证开源 — 详见 [LICENSE](./LICENSE) 文件。

### 🏢 商业授权

如果您希望在无法兼容 AGPL-3.0 许可条款的专有软件或商业产品中使用本项目，可以获取**商业授权**。请联系我们了解授权方案和价格。

## 🙏 致谢

- [mcp-chrome](https://github.com/hangwin/mcp-chrome) —— 本项目部分代码复用了其实现（MIT 协议，作者 hangye），感谢原作者的开源贡献。

## 📮 联系与链接

- 🐛 [问题反馈](https://github.com/your-org/AgentNexus-Browse-Plugin/issues)
- 💬 [讨论区](https://github.com/your-org/AgentNexus-Browse-Plugin/discussions)

---

<p align="center">
  由 <strong>AgentNexus</strong> 团队用 ❤️ 构建
</p>


### 视觉通用助手 GUI 自动化

视觉助手负责“看懂并教我”：支持可见区域文字与控件状态读取、四向组件滚动、原图局部放大和等待重拍，由用户执行点击、填写与提交。运行时限制技能与附加工具不能越过观察边界；任意 JavaScript 执行不在其工具范围内。适用场景、工具及已知限制见 [视觉助手设计](tools/vision/VISION_ASSISTANT.md)。

视觉通用助手 使用 0–1000 的视口相对坐标和 CDP 输入，支持点击、拖拽、滚动、输入、悬停、键盘与按需 DOM 打标分析。厂商协议、工具参数、支持范围与迁移说明见 [视觉驱动说明](tools/vision/README.md)。

## 第三方插件开发

插件开发、签名打包、GitHub 发布、兼容边界与维护说明见 [插件开发指南](docs/plugin-developer-guide.zh-CN.md)。运行 `npm run test:plugins` 和 `npm run test:plugins:ui` 验证插件内核与界面交互。

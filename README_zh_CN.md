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

1. **配合 [AgentNexus](https://github.com/dreameutopia/AgentNexus) 主程序**（推荐）：通过 WebSocket 自动化通道接受主程序调度，适合复杂的多步骤自动化工作流。
2. **独立使用**：在侧边栏聊天模式中配置自己的模型 API（OpenAI / Claude / Gemini / Ollama 等），即可脱离主程序直接对话并调用全部工具。

它的目标很明确：**接手生产环境里重复且耗时的工作，让人不再把工时耗在这上面**——详见下文的[设计理念](#-设计理念)。

## 🧭 设计理念

### 刻意保持简单，不追求复杂设计
本插件**有意不引入过多复杂的设计**。我们不打算在扩展内部再造一个通用工作流引擎、一个插件市场平台，或一层层层叠叠的编排系统。这里的每一项能力都必须先回答一个问题：它是浏览器扩展能**做好**的事情——读页面、操作页面、抓取页面、再把控制权交还回去。

复杂度放在它该在的地方：即将发布的 **AgentNexus 应用**。本插件被定位为**该应用与浏览器之间交互的重要途径**——向应用暴露一层稳定、边界清晰的工具接口，由应用通过 WebSocket 自动化通道调度。扩展本身越薄、行为越可预期，它作为该应用可靠依赖的价值就越高。

### 为生产环境里真正重复、真正耗时的事情而建
本项目后续的重点**不是**「为了更多而更多地堆工具」，而是**完成那些在生产中真正具有重复性、真正耗时的任务**，从而把人从重复劳动里解放出来。

具体来说，插件瞄准的是这类工作：

| 现实中的痛点 | 插件对应的能力 |
|---|---|
| 在几十个页面或系统之间来回搬运数据 | 数据采集、表格提取、XLSX 读写 |
| 反复核对同一份信息、逐个来源比对 | 多源检索、交叉验证的调研流程 |
| 重复执行固定的填写、点击、提交流程 | 可排期、可复用的工具工作流 |
| 把原始调研材料整理成可交付的产出物 | 调研报告技能、工作笔记、思维导图、图表渲染 |
| 在杂乱的页面里翻找某个资源或字幕 | 资源嗅探与下载、字幕获取 |

**每省下一小时的人工操作时间，就是这个项目存在的意义。** 凡是达不到这个标准的功能，都被有意排除在范围之外。

## 🔥 核心特性

### 🧰 丰富的工具体系
内置 **17 大类、70+ 工具**，覆盖不同抽象层次：标签页 / 窗口 / 导航管理、页面点击填充与滚动、截图与全页截图、网络请求捕获（CDP 调试器）、页面源码 / 正文提取、页面净化（去广告去追踪）、资源嗅探与下载、集成搜索、历史与书签管理、文本压缩、XLSX 读写、Excalidraw 画布绘制、Bilibili 字幕获取、代码执行等。

### 🔌 多协议模型接入
原生支持 **OpenAI、OpenAI Responses、Claude、Gemini、Ollama** 五种流式协议适配器，统一归一化为内部消息流；配套 SSE 协议契约测试（`tests/protocol-contract`），保证各厂商协议解析的准确性。

### 🧠 上下文与会话引擎
自研上下文引擎（上下文计量、转录引擎、上下文窗口守护）自动裁剪与压缩历史消息，配合会话数据库实现聊天记录持久化，长对话不溢出、可回溯。

### 🤖 智能体系统
内置 7 个预置智能体：深度搜索（Deep Search）、文本通用助手（General Text Assistant）、视觉助手（Vision Assistant）、视觉通用助手（General Vision Assistant）、数据采集助手（Data Collection Assistant）、Bilibili 搜索助手、思维导图助手；预置智能体的名称、描述、分类与标签随界面语言切换；支持在管理中心自定义智能体（模型、提示词、工具集、技能挂载）。

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

### 会话工作区与文件交付

所有工具生成或获取的交付文件（Excel、Mermaid PNG、下载资源及 Python 产物）统一保存在当前会话工作区 `outputs/`。工作区按需创建，独立于 Python 安装；原始附件位于 `inputs/`。工具返回 `<workspace-file path="outputs/文件名" />` 标记，AI 在回复正文中原样输出后渲染为可点击下载的卡片。同名新产物自动编号，仅保留这一种产物卡片协议。

## 🧭 技能（Skill）设计

### 设计定位
技能用 `SKILL.md` 描述可复用的工作流程，并可携带脚本、模板、字体、数据集等资源。浏览器通过 Pyodide 运行兼容的 Python 脚本，产物保存在当前会话工作区。

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
2. **激活**。用 `/` 预选的技能会在发送时自动加载。智能体也可以通过 `skill_tool` 的 `load` 操作加载任务相关的技能指令。
3. **读取资源**。用 `skill_tool` 的 `read` 操作按技能相对路径分页读取文本。

### 运行 Python 脚本

每个会话默认注入 `skill_tool`，提供 `load/read/copy/create/edit/delete`。资源复制不依赖 Python。调用时只传十进制 `skill_id` 与精确的 `paths`（`["."]` 表示整个技能），保留字节与相对目录；已有文件绝不覆盖，冲突时放入 `<skill_id>/`，再冲突则创建编号副本目录。后续必须使用返回的实际路径。仅执行 Python 时需要安装 Python 运行时。

用 `python_run(action="create", path="scripts/report.py", content=...)` 把脚本写入会话工作区，再用 `action="run"` 执行（path 必须是工作区内已存在的相对路径 `.py`）；`action="edit"` 修改文件（全量重写，或 `find`+`replace` 唯一命中替换），`action="delete"` 删除文件。所有 path 都相对工作区根目录，绝对路径、盘符与 `..` 一律拒绝。上面复制出的技能脚本从其复制根目录用同样的方式运行。`AGENTNEXUS_WORKSPACE` 指向会话工作区，上传文件在 `inputs/`，交付物写到 `outputs/`。用 `argv`、`stdin` 和 `env` 分别传入参数、输入和非敏感配置。包内入口可额外传入点分隔的 `module`。回复中用 `<workspace-file path="outputs/report.csv" />` 引用已保存的产物。

先用 `preflight: true` 检查静态导入、PEP 723 元数据、`requirements.txt` 或静态 `pyproject.toml` 声明，以及环境变量引用。默认使用 Pyodide 官方包目录和显式指定的本地 wheel。通过会话审批后才会解析公开 PyPI wheel。依赖 Bash、子进程、系统程序或缺少兼容 wheel 的技能，需要改用等效 Python 实现或其他可用工具。

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
- **操作录屏与远程操作**已进入规划与设计阶段，但**预计会在已有功能稳定之后才开始实现**——让录制 / 远程控制这条路建在已经稳定的基础之上，而不是建在一个仍在变动的基础上。
- **插件系统正在完善中**：打包、签名、分发与生命周期契约正在收敛，第三方插件的完整链路尚未落地。
- 更多场景化工具与技能，优先级按「在生产环境中能省下多少重复人工操作」来排。

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

- **BROWSER_UUID（可选，用于后端识别浏览器实例）**：普通用户浏览器场景无需任何配置 —— 扩展会在首次运行时生成唯一的 `b-<时间戳>-<随机串>` 标识并存入 `chrome.storage.local`，因此每个浏览器实例上报的标识都互不相同。只有在自建后端 / docker 场景下才需要在 `.env` 中固定该值：此时它会在构建时被注入（作为 `browserUuid` 查询参数），需在多次构建之间保持稳定。如需生成 UUID，可使用 PowerShell 的 `[guid]::NewGuid().ToString()` 或访问 https://www.uuidgenerator.net/。

快速示例：

1. 在项目根目录创建 `.env`：

```
CHROME_EXTENSION_KEY=YOUR_PRIVATE_KEY_HERE
# 仅自建后端 / docker 场景需要固定；普通用户浏览器留空即可自动生成
BROWSER_UUID=
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

## 📦 发布

日常提交只跑 CI（类型检查 + 测试 + 双浏览器构建），**不会**产生 Release。只有显式指定版本时才会发布：

```bash
# 1. 先把 package.json 的 version 改成目标版本并提交
# 2. 打同名 tag 推送，触发构建并创建 Release
git tag v0.1.0
git push origin v0.1.0
```

也可以在 Actions 里手动触发 `Release extension` 指定版本号，或把 `publish` 设为 `false` 只构建不发版。
完整说明见 [docs/release-process.md](./docs/release-process.md)。

## 🤝 参与贡献

### ✅ 欢迎提交
- 按规范提交更多的工具实现

### ❌ 暂不接受
- 系统设计架构正在重构中，其他类型的贡献暂时请勿提交

## 📄 许可证

本项目基于 **GNU Affero General Public License v3.0** 许可证开源 — 详见 [LICENSE](./LICENSE) 文件。

### 🏢 商业授权

如果您希望在无法兼容 AGPL-3.0 许可条款的专有软件或商业产品中使用本项目，可以获取**商业授权**。请通过 `13077995107@163.com` 联系我们了解授权方案和价格。

## 🙏 致谢

- [mcp-chrome](https://github.com/hangwin/mcp-chrome) —— 本项目部分代码复用了其实现（MIT 协议，作者 hangye），感谢原作者的开源贡献。

## 📮 联系与链接

- 🐛 [问题反馈](https://github.com/dreameutopia/AgentNexus-Browse-Plugin/issues)
- 💬 [讨论区](https://github.com/dreameutopia/AgentNexus-Browse-Plugin/discussions)

---

<p align="center">
  由 <strong>AgentNexus</strong> 团队用 ❤️ 构建
</p>


### 视觉通用助手 GUI 自动化

视觉助手负责“看懂并教我”：支持可见区域文字与控件状态读取、四向组件滚动、原图局部放大和等待重拍，由用户执行点击、填写与提交。运行时限制技能与附加工具不能越过观察边界；任意 JavaScript 执行不在其工具范围内。适用场景、工具及已知限制见 [视觉助手设计](tools/vision/VISION_ASSISTANT.md)。

视觉通用助手 使用 0–1000 的视口相对坐标和 CDP 输入，支持点击、拖拽、滚动、输入、悬停、键盘与按需 DOM 打标分析。厂商协议、工具参数、支持范围与迁移说明见 [视觉驱动说明](tools/vision/README.md)。

## 第三方插件开发

插件开发、签名打包、GitHub 发布、兼容边界与维护说明见 [插件开发指南](docs/plugin-developer-guide.zh-CN.md)。运行 `npm run test:plugins` 和 `npm run test:plugins:ui` 验证插件内核与界面交互。

会话 JavaScript 统一使用全局默认 `js_run`：先 create 保存 `scripts/*.js`，再 run 传相对路径与 JSON `args`（脚本通过 `$args` 读取）。文本编辑与 Python 共用引擎，支持精确/显式缩进匹配、原子 `edits` 及可选 SHA-256 冲突检查；`read` 按页读取任意工作区文本文件（每页 2000 字符并携带页码账目）。每次 run/crawl 的执行结果自动持久化为会话工作区 `results/` 目录下的独立 JSON 文件（单文件上限 10MB、跨浏览器重启可用），响应只回传前 2000 字符，data_ref_tool 与 xlsx_tool 直接消费这些结果文件。原内联页面执行工具实现保持不变，仅供 backend；两个脚本入口均不出现在智能体工具组中。

技能生命周期、数字 ID 与插件待批准更新规范见 [Skill 生命周期](docs/skill-lifecycle.md)。

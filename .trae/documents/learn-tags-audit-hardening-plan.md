# 会话标签 + 网站任务学习：全面审计与彻底修复方案

## Context

本次改动包含三块新能力：会话多标签、内置 `website-task-learn` 技能、独立学习页。代码已能编译、测试与构建，但逐链路模拟后发现若干**会静默失败或产生歧义**的问题，主要集中在：

1. 学习页与侧边栏的跨窗口消息协议在 START 路径上没有真正按窗口隔离；
2. 预选学习技能在「视觉助手 / 插件工具天花板」下会被运行时**静默丢弃**，会话照常启动但技能未加载；
3. 学习启动依赖模块级可变状态 `pendingSessionTags`，存在竞态与泄漏面；
4. 标签编辑器在中文输入法、焦点管理、脏数据展示等边缘场景不完整；
5. 旧学习域删除后遗留了若干通用能力与注释，需要确认后清理。

用户明确要求：**不能靠拒绝智能体来规避问题**。`website-task-learn` 必须做到「任意已启用智能体 + 任意可用工具组合」都能进入学习流程，技能自身要按可用能力自适应学习方式。因此本方案不引入「智能体不兼容」拒绝码，而是修正运行时对显式预选技能的处理，并重写技能的能力自适应策略。

## 审计结论（按优先级）

### P0 — 会导致功能静默失败或串窗口

1. **START 的跨窗口过滤失效**
   - [App.vue](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/entrypoints/sidepanel/views/App.vue) 的 `handleLearnBridgeMessage` 只读取顶层 `raw.windowId`；
   - [learn-launch-bridge.ts](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/utils/sessions/learn-launch-bridge.ts) 的 `startLearnSession` 把 `windowId` 放在 `payload` 内；
   - 结果：START 时所有窗口的侧边栏都可能应答，先应答者抢到通道。

2. **显式预选技能被运行时静默丢弃**
   - [runtime-builder.ts](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/entrypoints/sidepanel/core/runtime/runtime-builder.ts) 对 `input.skillNames` 仍执行 `allowsSkillDependency`；视觉助手只允许 `isVisionAssistantTool`，插件天花板也会过滤；
   - 技能被跳过 → `selectedSkills` 为空 → 激活轮为空，但用户消息仍要求「使用 website-task-learn」，模型无技能可用；
   - 这与「用户预选技能显式授权」的既有设计注释相矛盾（注释称预选技能不受可用性限制，代码却在限制）。

3. **学习启动标签使用模块级可变状态**
   - `pendingSessionTags` 在 `handleLearnStart` 设置、`goHome` 与 `executeSend` 的 `finally` 清理；
   - 若 `executeSend` 因 `sendInFlight` 在入口早退，`finally` 不执行，标签会泄漏到下一次普通发送；
   - 多入口（重试 / 继续 / 技能沉淀捕获）共用同一变量，语义靠注释维持，易漂移。

4. **附件解析在途时 START 仍返回成功**
   - `handleLearnStart` 只检查 `isActiveSessionRunning()`；`sendMessageInner` 还会因 `attachmentManager.isAdding` 提前返回；
   - 学习页收到 `{ ok: true }` 并展示「已启动」，实际没有创建会话。

5. **输入区残留会污染学习请求**
   - `goHome` 未清理已确认的网页引用（`confirmedQuote`）；学习启动复用了发送链路，旧引用可能被作为 `<page_quote>` 注入学习会话；
   - 需要确认引用/附件的清理 API，并在学习启动时显式复位。

### P1 — 边缘场景与可维护性

6. **来源标签页可指向不可学习页面**
   - `rememberLearnOrigin` 只排除 `chrome-extension://`；`chrome://newtab`、`about:blank`、devtools 等会被记录为目标页；
   - `resolveLiveLearnOrigin` 不校验当前 URL，标签页被导航到设置页后仍会被当作目标。

7. **标签编辑器输入法 / 焦点 / 脏数据**
   - `@keydown.enter.prevent` 会在中文输入法确认候选词时误添加标签；
   - Esc 在组合输入中会误关闭编辑器；
   - 保存/取消后焦点丢到 body；删除按钮仅有 `title`，缺少 `aria-label`；
   - 历史列表加载时未归一化 `tags`，异常数据直接进模板；
   - 保存中仍可点取消/关闭抽屉，状态靠 `finally` 兜底但语义不清。

8. **协议错误码重复定义**
   - `LearnBridgeFailureCode` 联合类型与 `normalizeResponse` 的 `allowed` 数组各维护一份，新增错误码容易漏改。

9. **注释漂移**
   - `types.ts`、`conversation-engine.ts`、`channel-types.ts`、`part-grouping.ts`、`MessageItem.vue`、`session-bridge.ts`、`tools/vision/README.md` 等仍以「学习/验证」描述通用长任务能力。

### P2 — 旧域残留（确认无调用后删除）

10. `limitsOverride` / `RuntimeLimits.maxDurationMs`；
11. `RuntimeBuildInput.disableSkillDiscovery`；
12. `SIDEPANEL_LOCAL_RUNNING_KEY` / `setLocalRunningChat` / `readSidepanelLocalRunningChats`（若已无写入方）；
13. `.preview/build-hub-sessions.mjs` 的 `learnDraftsPurged` 残留字段；
14. `.trae/documents/learn-mode-refactor-completion.md` 的过时现状描述。

## 实施步骤

### 1. 运行时：显式预选技能不再静默丢弃（核心）

文件：[runtime-builder.ts](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/entrypoints/sidepanel/core/runtime/runtime-builder.ts)

- 保留 `availableSkills`（技能发现）路径的严格 `allowedTools ⊆ 会话工具面` 不变量，不做改动。
- 重写 `input.skillNames`（显式预选）分支：
  - 只要求技能存在且 `enabled !== false`；
  - 不再因 `allowsSkillDependency` 跳过技能；
  - 仍由 `buildActivationRound` 生成激活轮，最终 `toolIds` 继续经 `allowsSessionTool` 过滤（视觉边界、插件天花板、Python 就绪度仍在交付面生效，不会越权）。
- 计算 `selectedSkillUnavailableTools`：显式预选技能中存在、但被 `allowsSessionTool` 或注册表过滤掉的工具。
- 当集合非空时注入通用 `<capability-boundary>` 分区（替换现有仅针对插件天花板的提示）：
  - 说明本轮部分技能工具不可用；
  - 要求模型按**当前真实可用工具**调整学习方式，不得声称使用了不存在的工具；
  - 不向模型暴露内部实现细节或安全策略。
- 同步更新相关注释，去掉「预选技能不受限」与代码不一致的表述。

### 2. 技能：改为能力自适应（核心）

文件：[SKILL.md](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/skills/website-task-learn/SKILL.md)

- 新增「阶段 0.1 能力自检」：
  - 列出本轮真实可用工具；
  - 判定学习模式：
    1. **自主操作模式**：具备浏览器交互/导航工具 → AI 亲自执行；
    2. **用户协作模式**：只具备观察/读取工具（如视觉助手）→ 用 `interact` 逐步请用户操作，AI 负责观察、校验、记录、纠错；
    3. **观察记录模式**：交互与观察工具都受限 → 用 `read_website` / `screenshot` / `vision_gui(read)` 与 `interact` 引导用户，明确标注未由 AI 直接验证的步骤。
  - 三种模式都以「可复用的学习结论 + 技能沉淀」为交付，不因工具受限而拒绝开始。
- 调整阶段 0/1/2 的措辞：把「必须真实操作」改为「按可用能力获取可验证证据；无法自主操作时，由用户操作、AI 观察并复核」。
- `allowed-tools` 保持完整浏览器能力清单（文本类智能体会被激活授权），但正文明确「以运行时实际可用工具为准」。
- 阶段 3/4（skill-create、验证询问）保持不变。

### 3. 桥接：窗口隔离、错误码单一来源、可学习页面校验

文件：[learn-launch-bridge.ts](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/utils/sessions/learn-launch-bridge.ts)

- 新增 `isLearnableUrl()`：仅接受 `http:` / `https:` / `file:`，排除扩展页、`chrome:`、`about:`、devtools 等。
- `rememberLearnOrigin`：候选标签页改用 `isLearnableUrl`；找不到返回 `null`。
- `readLearnOrigin`：存量记录 URL 不可学习时返回 `null`。
- `resolveLiveLearnOrigin`：当前 URL 不可学习时返回 `null`。
- 把失败码收敛为 `const LEARN_FAILURE_CODES = [...] as const`，由它派生类型与 `normalizeResponse` 的允许集合，避免两处漂移。

### 4. 侧边栏：消息路由与启动参数显式化

文件：[App.vue](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/entrypoints/sidepanel/views/App.vue)

- 新增 `readLearnMessageWindowId(raw)`：先读顶层 `windowId`，再读 `raw.payload.windowId`；仅当本侧边栏窗口已知且不匹配时忽略消息。
- 删除模块级 `pendingSessionTags`、`goHome` 中的清理、`executeSend` 的 `finally` 清理。
- `executeSend` / `sendMessageInner` 增加可选参数 `launchTags?: readonly ConversationTag[]`：
  - 仅 `!isResume && !capture` 时写入 `createSession({ tags })`；
  - 其他入口保持不传，标签天然单次生效，无泄漏面。
- `handleLearnStart`：
  - 启动前增加附录解析在途检查（`attachmentManager.isAdding` → `busy`）；
  - 显式复位输入区残留（已确认引用等，确认 API 后调用既有清除函数）；
  - 用 `void executeSend(undefined, undefined, undefined, [...LEARN_LAUNCH_TAGS])` 启动；
  - 保持 `learnLaunchInFlight` 互斥与 try/finally。
- 更新 goHome / 发送入口的过时「学习编排」注释。

### 5. 标签编辑器与历史列表

文件：[ChatHistoryDrawer.vue](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/entrypoints/sidepanel/components/chat/ChatHistoryDrawer.vue)、[chat-history-drawer.css](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/entrypoints/sidepanel/components/chat/chat-history-drawer.css)

- 新增 `isComposing(event)` 守卫：Enter 在输入法组合中不添加标签；Esc 在组合中不关闭编辑器。
- `startRename` 复用 `cancelTagEdit()`，并在 `tagSaving` 时拒绝切换。
- `saveTags` 成功后说明并恢复焦点到该行标签按钮（组件根节点 + `data-tag-edit` 定位）；取消同理。
- 保存中禁用取消按钮；抽屉关闭仍安全兜底。
- 删除按钮、添加按钮补 `aria-label`；错误提示保持 `role="alert"`。
- `loadSessions` 对每条 `session.tags` 执行 `normalizeConversationTags`，脏数据不直接渲染。
- CSS 仅做必要补充（focus-visible 可见性），不改变现有视觉语言。

### 6. 学习页

文件：[App.vue（learn）](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/entrypoints/learn/App.vue)

- 保持「任意已启用智能体」可选，不做兼容性过滤或拒绝。
- 启动前只做输入校验与 origin 复核；错误码映射沿用桥接层。
- 若 `skillEngine.get(WEBSITE_TASK_LEARN_SKILL_ID)` 缺失/被禁用，展示可读警告（不改变可选智能体）。
- 复核所有 `learnPage.*` 键在 zh/en 完整存在；不新增无用键。

### 7. 旧域死代码清理（确认后执行）

- 全局检索 `limitsOverride`、`maxDurationMs`、`disableSkillDiscovery`、`setLocalRunningChat`、`SIDEPANEL_LOCAL_RUNNING_KEY` 的调用方：
  - 无调用方 → 删除字段、分支、存储键、相关测试断言与注释；
  - 仍有通用调用方 → 保留并修正注释。
- 删除 `.preview/build-hub-sessions.mjs` 的 `learnDraftsPurged` 残留。
- 删除过时的 `.trae/documents/learn-mode-refactor-completion.md`。
- 更新 P1 第 9 条列出的漂移注释。

## 验证

1. `npm run compile` 通过。
2. `npm run test:all` 全绿（重点：runtime/contract/tools/chat-ui；死代码删除后同步修正断言）。
3. `npm run build` 成功且产出 `learn.html`。
4. 手工链路清单（构建后加载扩展）：
   - 文本智能体：打开目标页 → 学习页填写 → 启动 → 侧边栏新建会话、带「学习」标签、技能已激活；
   - 视觉助手：同样可启动，会话内技能按可用工具进入用户协作模式（不静默缺失）；
   - 双窗口同时打开侧边栏：只有目标窗口应答 START；
   - 侧边栏关闭 / 当前会话运行中 / 附件解析中：分别得到可执行的提示；
   - 目标标签页关闭或被拖到另一窗口：预检与启动给出准确结果；
   - 标签编辑：中文输入法回车不误加、重复/上限/超长有提示、保存失败有提示、Esc/取消/重命名互斥正常；
   - 清除全部标签后会话元信息不残留空数组字段。

## 风险与约束

- 运行时「显式预选技能」策略调整会影响所有预选技能，需用现有 contract 测试覆盖；不可用工具仍由 `allowsSessionTool` 在交付面拦截，安全边界不放松。
- 技能从「固定工具假设」改为「能力自适应」，需保证三种模式的成功判据都可验证，不能把未验证步骤写成已验证。
- 全程只用编辑工具逐文件修改；命令行仅用于重命名/移动/建目录。

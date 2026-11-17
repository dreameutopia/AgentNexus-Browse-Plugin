# 用户消息气泡 / 单轮技能快照 全面复审与修复计划

## Context

上一轮已实现三项设计：用户消息气泡固定宽度（80%）、气泡顶部逐行展示本轮技能快照、气泡底部左侧展示 `@智能体`，并把技能从「会话级持久化」改为「随用户消息落库、单轮生效」。实现已通过 compile 与 test:all。

本计划针对这批改动做一次端到端复审（UI 渲染 → 记录映射 → 运行时装配 → 落库 → 会话切换 → 事件时序 → 重试/继续 → 脏数据/并发/窄面板/语言切换），只修复确认存在的问题与冗余，不简化任何既有功能；所有内容修改均使用编辑工具逐文件完成，不使用命令行改代码。

## 复审结论（要修复的问题）

1. **运行时技能快照未去重 / 名称未收敛**
   [runtime-builder.ts](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/entrypoints/sidepanel/core/runtime/runtime-builder.ts) 在 `input.skillNames.filter(...)` 的回调里以副作用方式 `push` 快照。若调用方传入重复 id，`runtime.selectedSkills` 会带重复项；`skill.name` 为空时气泡会渲染空行。落库侧虽有归一化，但运行期快照本身应满足「干净、可直接展示」的契约。

2. **隐藏续跑轮携带技能快照语义不清**
   [conversation-engine.ts](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/entrypoints/sidepanel/core/conversation/conversation-engine.ts) 的 `appendUserMessage` 对 synthetic（守卫停止后的「继续」）隐藏轮也写入 `skills`。该轮不是用户发起、气泡也不渲染，写入会让「这条记录用了哪些技能」产生歧义。

3. **读取侧缺少脏数据防御**
   [App.vue](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/entrypoints/sidepanel/views/App.vue) 的 `recordToUiMessage` 直接透传 `agentId` / `agentName` / `skills`。字段类型异常（非字符串、非数组、重复 id、空 name）会一路传到渲染层。

4. **气泡组件对 props 的防御不足**
   [UserMessageBubble.vue](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/entrypoints/sidepanel/components/chat/UserMessageBubble.vue) 的 `skills` 直接 `props.skills ?? []`：脏数据可能产生重复 `:key` 或空白技能行。

5. **`@智能体` 可能渲染为空标识**
   [MessageItem.vue](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/entrypoints/sidepanel/components/chat/MessageItem.vue) 的 `userAgentLabel` 在「智能体被解析到但展示名为空」时返回 `''`，模板仍会渲染 `@`；同时 `agentId?.trim()` 假定入参一定是字符串。

6. **重复样式**
   [chat-message-list.css](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/entrypoints/sidepanel/components/chat/chat-message-list.css) 中 `.message.user .message-content` 的灰底/内边距/圆角已被 `.user-bubble` 与 `.user-bubble .message-content` 完全接管，属于重复且易漂移的样式源。

## 实施步骤

### 1. runtime-builder.ts —— 技能快照收集去副作用 + 归一
- 用显式循环替代 `filter` 内的 `push`：
  - 仅接受 `skillEngine.get(ref)` 命中、`enabled`、`allowedTools.every(allowsSkillDependency)` 的技能；
  - 以 `Set<string>` 按 id 去重（保持选中顺序）；
  - `name` 做 `trim()`，空串回落 `id`；
  - 合法 id 同步进入 `selectedSkillNames`（供 `buildActivationRound`）。
- 保持 `capability-boundary` 的计数逻辑（用 `selectedSkillNames.length !== input.skillNames.length`）不变，语义仍是「有技能被跳过」。
- 显式预选技能不参与技能发现的可承载性过滤（后续审计已调整）。

### 2. conversation-engine.ts —— 隐藏轮不写技能快照
- `appendUserMessage` 的 options 中把 `skills` 改为 `runtime.hiddenUserInput ? undefined : runtime.selectedSkills`。
- `agentId` / `agentName` 保持不变（隐藏轮仍是该智能体运行的一部分，且不渲染）。

### 3. App.vue `recordToUiMessage` —— 读取侧统一归一
- 新增一个局部小函数（或内联）收敛 `agentId` / `agentName` / `skills`：
  - `agentId` / `agentName`：仅接受字符串、`trim()` 后非空才写入；
  - `skills`：仅接受数组，逐项要求对象 + 非空字符串 id，按 id 去重，`name` 为空回落 id，仅非空数组写入。
- 明确注释：写入侧归一化在 `transcript-engine.normalizeSkillSnapshot`，读取侧做二次防御，保证任何来源的记录都能安全渲染。
- 不改动 `user-message` 事件里的技能清空逻辑（时序与 synthetic 判定已正确）。

### 4. UserMessageBubble.vue —— 渲染期防御
- 将 `skills` computed 改为归一化实现：非数组 → `[]`；逐项校验 `id`；按 id 去重；`name` 空回落 id。
- 其余测量、折叠、复制、展开逻辑保持不动。

### 5. MessageItem.vue —— `@智能体` 标签健壮化
- `userAgentLabel`：
  - 用 `typeof ... === 'string'` 判定后 `trim()`；
  - 解析成功时取 `displayNameOf(agent) || agent.name` 首个非空值；
  - 解析失败回落落库 `agentName || agentId`；
  - 最终为空则不渲染（模板已有 `v-if`）。

### 6. chat-message-list.css —— 删除重复样式
- 删除 `.message.user .message-content` 规则块（灰底/内边距/圆角）。用户气泡的底色、内边距、圆角统一由 `user-message-bubble.css` 的 `.user-bubble` 与 `.message.user .user-bubble .message-content` 承担。
- 保留 `.message-content` 基础排版（字号/行高/换行）与助手消息样式。

### 7. 测试
- [tests/user-bubble/run.mjs](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/tests/user-bubble/run.mjs)
  - 新增一组「脏技能快照」用例：`[{id:'a',name:'技能A'},{id:'a',name:'重复'},{id:'b',name:'   '}]` → 只渲染两行，第二行名称为 `b`，不出现重复行；
  - 保留现有固定宽度、单行技能、`@智能体` 断言。
- [tests/chat-ui/vision-timeline.test.mjs](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/tests/chat-ui/vision-timeline.test.mjs)
  - 若现有断言覆盖 synthetic 记录字段，补充「隐藏轮不写 skills」期望；否则保持不动。
- 不改动其它测试口径。

## 验证

1. `npm run compile`（类型检查 + 构建）；
2. `npm run test:all`（含 user-bubble / message-collapse / chat-ui 等）；
3. 若可用，运行 [.preview/user-bubble-preview.ts](file:///d:/WorkSpace/AgentNexus/AgentNexus-Browse-Plugin/.preview/user-bubble-preview.ts) 对应预览，人工确认：
   - 短消息气泡仍为固定 80% 宽；
   - 技能清单逐行展示、长名省略、无重复；
   - 底部 `@智能体` 靠左、复制按钮靠右；
   - 窄面板（<360px）引用来源隐藏、技能行不溢出；
   - 发送后输入区技能选中立即清空，历史气泡快照仍可见。

## 约束

- 所有代码内容修改使用 Edit 工具逐文件进行，不使用命令行批量替换；
- 不删除或简化既有功能（技能激活轮、发现清单、capability-boundary、压缩、重试/继续均保持不变）；
- 无需兼容/迁移旧数据，但读取侧对脏字段保持防御。

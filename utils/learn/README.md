# 网站学习：运行链路与产出契约

## 原有问题

- 编排只按 strategy 选择学习工具，视觉目标和文本目标的视觉辅助共用同一工具组。
- 视觉学习继承 GUI 工具，没有 `browser_observe`、`browser_interact`、`browser_page_exec`，无法沿用文本观察与交互。
- 文本目标使用视觉策略时，提示词强制 `vision_gui(action="mark") → vision_gui(action="inspect")`，将 DOM 取证不必要地绑定到截图标注。
- `browser_observe` 能枚举和过滤，却缺少通过当前节点引用读取指定元素完整属性与 XPath 的入口。
- 技能只要求笼统的“工作流”，没有独立完成计划及逐项对应的具体操作讲解；原因、双线索、隐藏入口等未形成统一规范。
- 提交工具仅检查正文非空与长度，未知工具还会被静默剔除，可能留下无法执行的技能。
- 重新学习清空验收报告，学习者看不到上一版失败在哪里。

## 运行链路

`SiteLearnModal.vue` 收集目标站点、自然语言目标、目标操作模式、学习策略、模型和自动验证选项。

`learn-validate.ts` 校验配置：视觉目标固定使用视觉策略；凡需要图片的组合，模型声明与协议都必须支持图片。

`use-learn-session.ts` 创建专用会话，学习段按 `getSiteLearnScenario`（目标模式 × 学习策略）、验证段按 `getSiteValidateScenario`（只看目标模式）选择工具，用 `buildLearnPrompt` / `buildValidatePrompt` 装配指令。两段装配都传 `disableSkillDiscovery`：不注入技能发现清单与 `load_skill`（固定分区的技能目录句子同步切换为「本会话不提供技能目录」），既有技能不能污染试错过程、不能破坏盲测，也不能经技能携带工具把 `vision_gui` 注入文本目标。
提交回执先经 `asSkillDraft` / `asValidationReport` 形态守卫，再由 `reconcileSkillDraft` 与目标模式对账：mode / 模式标签不一致就地纠正，文本目标混入的视觉工具与学习内部工具被剥离，剥离后无可用工具则按无产出处理——模型的偏差不会落成错误模式的技能。
学习者使用计划推进、笔记留证，最终成功调用 `submit_skill` 才正常结束学习阶段。错误提交返回可读问题，供下一轮修正。

启用自动验证时，以空历史开始第二段运行，只给最终技能和验收目标，通过 `submit_validation` 返回报告。
验证从技能的起始条件重新执行，检查步骤、原因、定位证据、文本兜底、视觉描述及完整范围。
用户选择重新学习时，报告的问题清单会注入下一次学习；验证本身始终不带学习过程。

草稿交给 `learn-draft-store.ts` 一次性暂存，再打开管理中心 `#new-skill`，预填名称和正文供确认创建。
新结构只约束学习工具的新提交，不迁移或拒绝已有手写/导入技能。

## 学习工具与专属引导

工具清单与 prompt 都是学习域**自有**配置：`tool-presets` 的学习/验证场景不展开 `AUTOMATION_TOOLS` / `VISION_AGENT_TOOLS`，`learn-prompts` 不 import 两个动作智能体的 SOP（`ELEMENT_INTERACTION_SOP` / `VISION_ACTION_SOP`）。文本通用助手与视觉通用助手的配置、提示词演进不会影响网站学习，反之亦然。

| 目标模式 | 学习策略 | 场景 | 工具与引导 |
| --- | --- | --- | --- |
| 文本 | 文本 | `siteLearnText` | 完整文本观察/交互与页面脚本，不启动截图循环；验证仅靠文本线索能重定位 |
| 文本 | 视觉 | `siteLearnVisionForText` | 文本全套 + `screenshot`（自动截图**仅用于帮助理解屏幕元素**）；**不提供 vision_gui**，操作与取证一律走 DOM 文本通道，截图不得成为执行前提 |
| 视觉 | 视觉 | `siteLearnVision` | 文本全套 + `vision_gui` 手势 + `screenshot` + `browser_window`；按需 mark→inspect 核对，额外记录位置、外观、组件形式、周围锚点和交互反馈 |

共同文本工具（`SITE_LEARN_DOM_TOOLS`，学习域自有清单）：

- `browser_observe`：`controls/buttons/inputs` 枚举；`element` 查询指定节点属性；`structure/accessibility` 处理复杂页面。
- `browser_interact`：点击、填充、聚焦、键盘、输入和容器滚动。
- `browser_page_exec`：常规观察不足时探测页面结构或组件作用域。
- `browser_get_page_text`（核心注入）、`browser_get_page_info`、`browser_navigate`、`wait_page_load`、`browser_go_back_or_forward`。
- `browser_get_all_tabs`、`browser_switch_tab`、`browser_network_capture`、`bing_search`、`generic_wait`。
- `plan_tool` 与交互征询工具（核心注入）、`note_tool`、学习终止工具 `submit_skill`。

视觉目标组合额外具备：`vision_gui`（10 个 action，参数由 schema 与学习域自有的 `<vision-gui-tool>` 分区描述）、`screenshot`、`browser_window`；文本目标×视觉策略仅额外具备 `screenshot`。

`<vision-gui-tool>` 分区是 runtime-builder 的协议标记：学习提示词携带该分区时，引擎不再追加视觉通用助手的 `VISION_ACTION_SOP`。视觉目标在该分区放学习域自有的手势契约（含按需 mark/inspect）；文本目标放「本阶段没有视觉 GUI 工具」的禁用分区，同时显式禁止模型激活技能清单中的视觉工具。

视觉目标允许按需使用 `vision_gui` 的 mark/inspect action：先看原图和 DOM，仅在无文字图标、同名控件或视觉区域难以对应节点时打标；下一张截图出现数字框后再 inspect，数字不用于点击。

验证工具将 `submit_skill` 换成 `submit_validation`，视觉能力只按目标模式分叉（`getSiteValidateScenario`）。验证 prompt 同样只用学习域自有的工具契约块，不引用动作智能体 SOP。

## 元素取证与执行

先 `browser_observe(view="buttons"/"inputs"/"controls")` 枚举，再传该行 `elementId` 和 `frameId` 到 `view="element"`。
指定属性查询返回 XPath、文字、属性、关联 label、值与状态、选项、frame URL、frame 内矩形和外观，不返回密码值。
读取复用文本工具的节点注册、有效期与 frame 路由；过期/替换/导航后必须重采。Shadow 内返回作用域及局部路径，不冒充可直接查询的文档 XPath。

执行优先用 XPath，核对 `Hit`、文字与上下文。未命中时必须去掉 XPath，再单独按文本/属性 regex 搜索；两者同时传入为 AND，不是 OR。
过滤结果会包含未命中候选，不能把第一行或任意返回行当作匹配。XPath 是重新定位线索，不是可直接传入交互工具的节点引用。

技能保存至少两条独立可重采线索，优先 XPath 与文本。无文本如实说明，改用 placeholder、aria-label、name、role、区域等。
视觉目标在此基础上加位置/外观；Canvas 等无 DOM 时注明限制和视觉替代。文本目标无法覆盖必要步骤时不能假称可执行。
固定 elementId、frameId、snapshotId、screenshotId、数字标签或坐标不应成为长期定位依据。

## 最终产出

`name` 为“平台-任务简短概述”，兼容当前技能库的小写英文 kebab-case，例如 `pinduoduo-search-products`。
`body` 为无 frontmatter 的 Markdown：

1. `## 目标`
2. `## 前置条件`
3. `## 完成计划`：按 `1.`、`2.` 拆成未来执行者可逐步推进的细致单元。
4. `## 具体操作讲解`：按 `### 1.`、`### 2.` 与计划逐项对应，每步说明动作、原因、目标线索、操作方式、成功判据与注意/恢复。
5. `## 分支与坑点`
6. `## 完成判定`
7. `## 边界`

输入关键词、条件等参数化，元素文案与 XPath 保留真实证据。“全部”目标必须说明分页/无限滚动、去重、终止和实际覆盖范围。
隐藏内容写触发顺序，滚动写方向及容器，避免用“继续操作”等泛化描述代替实际步骤。

`learn-output-contract.ts` 与提示词、提交工具共用小节定义。提交校验标题、非空、顺序、计划/讲解连续编号及数量一致；拒绝未知工具、阶段提交工具和文本技能依赖的视觉工具，移除冲突模式标签。
静态校验不能证明 XPath 真实、描述正确或网站流程可用，语义与业务结果仍由实际探索及可选盲测检验。

## 回归检查

- `npm run test:tools`：工具注册、工具矩阵、三种提示词、提交失败自纠、结构校验和真实序列化 DOM 属性读取等；`site-learning` 用例额外断言学习/验证的隔离契约（文本目标无 `vision_gui`、prompt 不内嵌动作智能体 SOP、`<vision-gui-tool>` 协议分区按目标模式分叉）。
- `npm run test:skills`：技能存储/指令装配等兼容性。
- `npm run test:vision`：截图、坐标、标注和 GUI 交互契约。
- `npm run compile`、`npm run build`：类型检查与扩展构建。

测试使用 DOM fixture 和模拟扩展 API；不等价于真实站点登录态下的端到端学习效果评测。

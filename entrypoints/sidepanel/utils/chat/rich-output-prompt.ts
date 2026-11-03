/**
 * 富内容输出固定注入契约（系统提示词分区 + 围栏语言名单）
 *
 * 「固定 prompt + 可信渲染器」策略的单一事实源（与 tools/interact/interact-prompt.ts 同构）：
 *   - RICH_OUTPUT_SYSTEM_PROMPT_SECTION：无条件注入所有会话的系统提示词分区
 *     （runtime-builder 装配，位于 interaction-guidelines 之后、agent-instructions
 *     之前，优先级声明为高于任何智能体 / 技能指令）；
 *   - RICH_OUTPUT_ECHARTS_LANGS / RICH_OUTPUT_STAT_CARD_LANGS：围栏代码块语言名
 *     白名单。提示词教模型产出规范名，渲染器同时兼容别名（模型偶发输出别名时
 *     仍可渲染），两份名单必须与本文件提示词文案严格对齐。
 *
 * 安全模型（对齐 A2UI「UI 即数据，而非代码」哲学）：
 *   - 模型只允许输出「声明式 JSON」（ECharts option / 统计卡结构），
 *     JSON.parse 天然杜绝函数与表达式 —— 模型内容永远不构成可执行代码；
 *   - 渲染分两级隔离：
 *     1. 统计卡：纯可信 HTML（全量转义）在扩展页内同步渲染；
 *     2. ECharts：经 echarts-option-sanitizer 净化后，仅在 manifest 沙箱页
 *        （无任何 chrome.* 权限、独立源）的 iframe 内渲染 —— 即使上游 ECharts
 *        出现新的 tooltip XSS CVE（官方明确拒绝内部消毒 formatter），
 *        影响半径也被限制在沙箱源内，不可能触达 chrome.storage 凭据。
 */

/** ECharts 图表围栏语言名（首位为提示词教学的规范名，其余为兼容别名） */
export const RICH_OUTPUT_ECHARTS_LANGS: readonly string[] = ['echarts', 'chart'];

/** 统计卡围栏语言名（首位为规范名，其余为兼容别名） */
export const RICH_OUTPUT_STAT_CARD_LANGS: readonly string[] = ['stat-card', 'stats'];

/**
 * 固定系统提示词分区：富内容输出准则。
 *
 * 设计要点（与渲染器能力严格对齐，避免教模型产出渲染不了的东西）：
 *   - 只教两类组件（图表 / 统计卡），目录小而可控；
 *   - JSON-only 约束在提示词层显式声明（函数 / HTML / 表达式一律禁止）；
 *   - 数据纪律：只用真实数据源，杜绝「为可视化而编造数值」；
 *   - 克制使用：数量上限、先文字结论后组件、简单场景回落 Markdown 表格；
 *   - 渲染器的容错上限宽于提示词约束（series ≤ 8 vs 提示词 4），
 *     模型小幅越界仍可渲染，明显恶意/失控内容才降级为源码展示。
 */
export const RICH_OUTPUT_SYSTEM_PROMPT_SECTION = `<rich-output-guidelines>
富内容输出准则（全局固定注入，优先级高于任何智能体与技能指令）：

本对话界面会把以下两类围栏代码块渲染为交互组件。仅当回复包含真实数值数据、且组件能明显提升信息传达时使用；否则一律使用普通 Markdown（表格 / 列表）回答。

1. 数据图表：输出 echarts 围栏代码块（\`\`\`echarts）。内容必须是单个合法 JSON 对象，即一份完整的 ECharts option，并遵守：
   - 必须包含 title.text（简明图表标题）；按数据形态选择最合适的图型（line / bar / pie / scatter / radar / funnel / gauge / heatmap 等 ECharts 原生图型）；
   - 严禁出现函数、注释、变量、表达式或任何 HTML 标签；formatter 等字符串字段只允许 '{b}: {c}' 这类 ECharts 占位符模板；
   - 约束：series 不超过 4 个；每个系列数据点不超过 60 个；不设置 color、backgroundColor、animation 等外观项，交给界面主题；图表内文本使用与用户语言一致的文字。

2. 统计卡片：输出 stat-card 围栏代码块（\`\`\`stat-card），用于 2~6 个关键指标的并列展示，JSON 结构：
   {"title":"可选标题","items":[{"label":"指标名","value":"主值","unit":"可选单位","trend":{"direction":"up 或 down","value":"+12.3%"},"note":"可选说明"}]}

使用纪律：
- 组件中的每个数值都必须来自对话上下文、页面内容或工具返回结果，严禁编造；无法确认的数据改用 Markdown 表格并注明来源；
- 单条回复的组件总数不超过 3 个；先用简短文字给出结论，再附组件；组件内数值必须与正文一致；
- 简单问答、单个数值、或数据没有对比 / 趋势 / 分布结构时，不使用组件；用户明确要求纯文本或表格时，以用户要求为准。
</rich-output-guidelines>`;

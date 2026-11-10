import { pluginBindings, pluginToolCeiling } from '@/utils/plugins/catalog';
import { isPluginRef, ownerOf } from '@/utils/plugins/contracts';
import { startPluginClient, refresh as refreshPluginCatalog } from '@/utils/plugins/client';
/**
 * 运行时装配引擎
 *
 * 职责：把「用户选择（智能体 + 技能 + 模型）」装配为一次性不可变的 ConversationRuntime：
 *   - systemPrompt：XML 分区隔离（environment / 固定准则分区（交互征询 · 任务
 *     计划 · 工作笔记 · 富内容输出 · history-and-tools）/ agent-instructions /
 *     supplementary-context / available-skills）
 *   - toolIds：多来源合并 + Set 去重（智能体预设 → 技能预授权 → 会话附加 → 技能承载工具）
 *   - model：经模型注册表按引用解析为端点快照（协议驱动/URL/密钥/阈值），密钥只进内存
 *   - initialContext：从用户面转录派生的 AI 面初始上下文
 *   - activationContext：用户预选技能合成的一轮 load_skill 调用（不进 system prompt）
 *
 * 本层不做请求类副作用（不执行工具、不发请求）；图片引用解析可能回读图片库
 * （缓存命中时为纯内存读），装配失败抛带原因的错误。
 */

import { modelRegistry, appSettingsStore, FAILED_TOOL_ROUNDS_DEFAULT, MAX_ITERATIONS_DEFAULT, TOOL_TIMEOUT_DEFAULT_MINUTES, type ModelRef } from '../../utils/channels';
import { agentEngine, DEFAULT_AGENT_SYSTEM_PROMPT } from '../registry/agent-engine';
import { skillEngine, SKILL_TOOL_IDS } from '../registry/skill-engine';
import { contextEngine } from '../context/context-engine';
import { prepareProtocolHistory } from '../context/protocol-history';
import { collectPriorViewportRefs } from '../context/viewport-ref-collector';
import { imageStore, normalizeImageRefs } from '../images/image-store';
import { INTERACT_SYSTEM_PROMPT_SECTION } from '@/tools/interact/interact-prompt';
import { PLAN_SYSTEM_PROMPT_SECTION } from '@/tools/plan/plan-prompt';
import { NOTE_SYSTEM_PROMPT_SECTION } from '@/tools/note/note-prompt';
import { UPLOAD_FILE_SYSTEM_PROMPT_SECTION } from '@/tools/upload-file/upload-file-prompt';
import { CORE_SESSION_TOOL_IDS } from '@/utils/tools/tool-presets';
import { VISION_GUI_TOOL_ID } from '@/tools/vision/gui-contract';
import { filterVisionAssistantTools, isVisionAssistantTool } from '@/utils/agents/vision-assistant-policy';
import { collectPromptInjections } from './prompt-hooks';
import { toolRegistry } from '@/tools/registry';
import { buildRichOutputSystemPrompt } from '../../utils/chat/rich-components';
import type {
  ChatMessageRecord,
  ConversationRuntime,
  ResolvedModelConfig,
  RuntimeLimits,
  VisionRuntimeConfig,
} from '../types';
import type { ChatMessage } from '../../utils/ai/ai-chat-api';

export interface RuntimeBuildInput {
  chatId: string;
  /** 本轮用户输入 */
  userInput: string;
  /** 本轮用户上传图片（data URL 列表；进入多模态用户消息，不落转录） */
  userImages?: string[];
  /** 附件文本块（已格式化；拼入 LLM 用户消息，不落转录，空串 = 无附件） */
  attachmentPrompt?: string;
  /** 已选智能体名（null/'' = 不使用智能体） */
  agentName: string | null;
  /** 已选技能名列表（多选） */
  skillNames: string[];
  /** 会话内模型覆盖引用（引用失效时经注册表回落链自动降级，不阻断装配） */
  modelRef?: ModelRef | null;
  /** 会话附加工具（如 Deep Search 按已开启站点动态注入的搜索工具） */
  extraToolIds?: string[];
  /** 系统提示词追加段（如 Deep Search 自动建笔记后的笔记信息） */
  systemPromptSuffix?: string;
  /**
   * `<agent-instructions>` 分区的整体替换（不走 supplementary-context 追加）。
   *
   * 给「动态装配方」用：网站学习等场景需要一份与任何已存智能体都不同、
   * 且含运行期参数（URL / 目标 / 模式）的主体指令。传入非空字符串即完全
   * 取代 agent.system（无智能体时取代默认指令）；缺省或空串 = 不覆盖。
   * 注意：技能分区、固定分区（交互准则 / 计划准则 / 富输出）仍照常注入，
   * 覆盖的只是「智能体指令」这一个分区。
   */
  agentSystemOverride?: string;
  /**
   * 禁用技能发现（动态装配场景专用，如网站学习的两个阶段）。
   *
   * true：不解析可用技能清单——发现分区不注入、load_skill/read_skill_file
   * 承载工具不注入、技能携带的工具（如 vision_gui）不参与 offersGui 判定。
   * 目的：
   *   - 学习不得被既有技能污染（照抄技能而不是试错探索）；
   *   - 盲测验证不得借助技能清单获取技能正文之外的知识；
   *   - 封死「技能携带视觉工具混入文本目标学习」的注入路径。
   * 缺省 false = 既有行为（无智能体回落全部启用技能），其它调用方不受影响。
   * 与 skillNames 独立：本标志只关发现清单；调用方仍须自行传空 skillNames。
   */
  disableSkillDiscovery?: boolean;
  /**
   * 循环限制覆盖（学习等长任务的高上限）。
   * 与既有「按 vision 取默认 + 应用设置」的基线做浅合并：只覆盖给出的字段，
   * 未给出的保持基线值。缺省 = 完全沿用基线（行为与改动前一致）。
   */
  limitsOverride?: Partial<RuntimeLimits>;
  /**
   * vision 运行配置覆盖。
   * - 缺省（undefined）：沿用 agent 声明的 vision（既有行为）；
   * - 传对象：启用/替换视觉循环；
   * - 传 null：显式禁用视觉循环（即使智能体声明了 vision）。
   * 三态用 undefined / null / 对象区分，调用方不能用 ?? 归一。
   */
  visionOverride?: VisionRuntimeConfig | null;
  /** 用户面历史记录（派生 AI 面初始上下文；已压缩部分应剔除并改传 contextSummary） */
  priorRecords: ChatMessageRecord[];
  /** 会话压缩摘要（LLM 摘要式压缩产物；作为系统级记忆消息置于初始上下文最前） */
  contextSummary?: string;
  /** 压缩摘要生成时间（毫秒时间戳；缺省取当前时间） */
  contextSummaryAt?: number;
}

/** 对话循环限制的固定部分（轮次上限与连续失败阈值来自应用设置，见 build 内读取） */
const DEFAULT_LIMITS: RuntimeLimits = {
  maxIterations: MAX_ITERATIONS_DEFAULT,
  maxDurationMs: 10 * 60 * 1000,
  // 单工具最长执行时间的**兜底**值（真实值取应用设置「单工具最长执行时间」，
  // 默认 30 分钟）。此处不再是 2 分钟——那个值只反映旧实现里「工具超时」与
  // 「用户交互超时」被混为一谈的年代。
  toolTimeoutMs: TOOL_TIMEOUT_DEFAULT_MINUTES * 60_000,
  maxConsecutiveFailedToolRounds: FAILED_TOOL_ROUNDS_DEFAULT,
};

/**
 * 工具集交付前终态归一化（runtime 交付的最后防线）。
 *
 * 多来源合并（核心层 / 智能体预设 / 激活技能 allowedTools / 会话附加 /
 * 技能承载工具）在正常路径上已由 Set 保证唯一，此处仍显式收敛——
 * 防御性编程要求「交付物正确性」不依赖上游每条路径永不出错：
 *   - 过滤空串与非字符串项（技能 frontmatter 与外部存储的脏数据入口）；
 *   - 再次去重保序（防御未来合并路径改动引入的回归）；
 *   - 剔除未注册的工具 ID 并集中告警一次：请求侧 getToolsByIds 同样会
 *     跳过它们，但这里的告警能直接定位「哪个装配声明了不存在的工具」
 *     （拼错的工具名、已下线工具的残留引用），而不是静默少工具难排查。
 */
function finalizeToolIds(
  toolIds: readonly string[],
  unknownSink?: Set<string>,
): string[] {
  const registered = new Set(toolRegistry.getAllTools().map(tool => tool.name));
  const seen = new Set<string>();
  const result: string[] = [];
  const unknown: string[] = [];
  for (const raw of toolIds) {
    if (typeof raw !== 'string') continue;
    const toolId = raw.trim();
    if (!toolId || seen.has(toolId)) continue;
    seen.add(toolId);
    if (!registered.has(toolId)) {
      unknown.push(toolId);
      continue;
    }
    result.push(toolId);
  }
  // 未注册 ID 汇入共享收集器：advertisedToolIds 与 toolIds 两条路径共享
  // 同一份告警（同一死链 ID 只报一次，不因两条归一化路径重复刷屏）
  if (unknown.length > 0 && unknownSink) {
    for (const id of unknown) unknownSink.add(id);
  }
  return result;
}

/**
 * 视觉操作开关 → 智能体工具面归一（注入时序第 1 步的纯函数核心）。
 *
 * 不变量：「vision_gui ∈ 智能体声明工具面 ⇔ 视觉操作开关（AgentConfig.vision）开启」。
 *   - 开启：注入 vision_gui（Set 去重，已存在则幂等）；
 *   - 关闭：剔除 vision_gui 残留并上报 strippedResidue 供装配层告警。
 *
 * 分层：自定义智能体记录已在数据层收敛（normalizeAgentConfig 写入/恢复即剔除），
 * 本函数是装配边界的兜底——覆盖不经过该归一化的来源（插件智能体、预置表、
 * 未来新增的装配入口），保证交付面在任何来源下都满足不变量。
 * 只作用于智能体声明面：extraToolIds（动态场景自带工具）与技能携带工具不经此通道。
 *
 * @param resolvedToolIds 智能体解析出的有序去重工具列表（agentEngine.resolve 产物）
 * @param visionDeclared 是否声明了视觉操作（agent.vision 存在）
 */
export function applyVisionToggleToolSurface(
  resolvedToolIds: readonly string[],
  visionDeclared: boolean,
): { toolIds: string[]; strippedResidue: boolean } {
  if (visionDeclared) {
    return { toolIds: [...new Set([...resolvedToolIds, VISION_GUI_TOOL_ID])], strippedResidue: false };
  }
  const strippedResidue = resolvedToolIds.includes(VISION_GUI_TOOL_ID);
  return {
    toolIds: resolvedToolIds.filter(id => id !== VISION_GUI_TOOL_ID),
    strippedResidue,
  };
}

class RuntimeBuilder {
  /**
   * 装配运行时（异步：AI 面初始上下文需解析图片引用——记录加载点已预载，
   * 此处仍以 await 统一走 imageStore 的缓存/回读路径，保证派生恒定）。
   * 系统提示词分区顺序：环境声明 → 固定交互准则 → 任务计划准则 → 笔记准则 →
   * 上传文件准则 → 富内容输出准则 → history-and-tools → 智能体指令 →
   * 补充上下文 → 发现清单（可用技能 − 已激活）。
   * 预选技能不进 system prompt：其正文由 activationContext 承载（合成
   * load_skill 轮），由会话引擎追加在本轮用户消息之后。工具合并顺序保证
   * 可预期：核心交互工具（无条件注入，任何智能体不可裁剪）→ 智能体
   * （先经「视觉操作开关注入」归一 vision_gui，见 build 内注释）→
   * 技能预授权 → 会话附加 → 技能承载工具（承载工具按「存在可用技能」判定
   * 注入，与发现清单的存在条件严格一致）。vision_gui 进入工具面后，
   * prompt 钩子（collectPromptInjections）检测到它即注入 vision_gui 规程——
   * 「开关注入工具 → 检测工具 → 注入规程」三步以同一份归一工具面传递。
   * 循环轮次上限与连续失败阈值取应用设置（高级设置：对话轮次上限（文本与
   * 视觉策略统一）、连续工具失败停止阈值）。
   */
  async build(input: RuntimeBuildInput): Promise<ConversationRuntime> {
    if (typeof document !== 'undefined') { await startPluginClient(); await refreshPluginCatalog(); }
    // 单次解析：agent 本体 + 去重工具列表（避免 get/resolve 双重查找造成的不一致窗口）
    const { agent, toolIds: resolvedAgentToolIds } = agentEngine.resolve(input.agentName);
    const pluginCeiling = pluginToolCeiling(agent?.plugin?.key);
    const allowedByPlugin = (id: string) => !pluginCeiling || pluginCeiling.includes(id) || CORE_SESSION_TOOL_IDS.includes(id) || SKILL_TOOL_IDS.includes(id);
    const isVisionGuide = agent?.id === 'Vision-Assistant';
    if (input.agentName && !agent) {
      throw new Error(`智能体 "${input.agentName}" 不存在`);
    }

    // ── 视觉操作开关注入（注入时序第 1 步：开关 → 工具面 → 提示词钩子）──
    // hub 编辑器「视觉操作」开关 = AgentConfig.vision 声明，它是智能体工具面
    // 携带 vision_gui 的**唯一**入口（工具组不提供勾选，见 tool-presets 的
    // VISION_TOOLS_GROUP）。归一规则与分层见 applyVisionToggleToolSurface：
    // 数据层（normalizeAgentConfig）已剔除自定义记录的残留，此处是装配边界
    // 兜底并完成「开关开启 → 注入」；归一后「vision_gui ∈ 智能体声明工具面
    // ⇔ 开关开启」恒成立，下游 sessionToolIds（技能可用性 + 提示词钩子检测）
    // 与 toolIdSet（最终交付）同源继承该事实，第 2 步的 prompt 钩子据此注入
    // 规程（见下方 collectPromptInjections）。注入不受 normalizeToolIds 上限
    // 约束（与无条件注入的核心工具同级：开关能力不算用户勾选配额）。
    const visionDeclared = !!agent?.vision;
    const { toolIds: agentToolIds, strippedResidue } = applyVisionToggleToolSurface(
      resolvedAgentToolIds,
      visionDeclared,
    );
    if (strippedResidue) {
      console.warn(
        `[RuntimeBuilder] 智能体 "${agent?.name ?? input.agentName ?? '(无智能体)'}" 未开启视觉操作，已剔除其工具面中的 vision_gui 残留（该工具仅经「视觉操作」开关注入；自定义记录的数据层归一见 normalizeAgentConfig）`,
      );
    }

    // ── 可用技能（三通道并经承载校验：显式关联 ∪ 工具映射兜底 ∪ 自定义自适应；
    // 无智能体的默认对话走映射兜底 ∪ 自定义自适应，不再回落全部启用——清单技能
    // 的 allowedTools 恒 ⊆ 会话工具面，advertised ⊆ toolIds 不变量由此保证） ──
    // 工具口径 = 无条件注入的核心工具 ∪ 智能体工具 ∪ 会话附加工具（如 Deep Search
    // 按站点动态注入的搜索工具）——「工具在哪技能在哪」对核心工具与动态工具同样
    // 成立。漏掉核心工具会让 allowed-tools 含核心工具的技能在任何智能体下都
    // 匹配失败（技能可用性判定依赖此口径）
    // disableSkillDiscovery=true（学习/盲测）：可用技能恒为空，发现分区、
    // 技能承载工具与技能携带的 GUI 能力一并关闭（见 RuntimeBuildInput 注释）
    const sessionToolIds = [
      ...CORE_SESSION_TOOL_IDS,
      ...agentToolIds,
      ...(input.extraToolIds ?? []),
    ];
    const availableSkills = input.disableSkillDiscovery
      ? []
      : skillEngine.resolveAvailableSkills(agent,
          isVisionGuide ? filterVisionAssistantTools(sessionToolIds) : sessionToolIds)
        .filter(skill => (!isVisionGuide || skill.allowedTools.every(isVisionAssistantTool)) && skill.allowedTools.every(allowedByPlugin));

    // ── 系统提示词（XML 分区） ──
    // 注意：不在此拼入「当前时间」——时间戳逐轮变化会使 system 前缀失配、
    // 上下文缓存每轮失效；改由 conversation-engine 附加到本轮用户消息尾部。
    const sections: string[] = [];
    sections.push(
      `<environment>\n` +
        `运行环境：浏览器扩展 AgentNexus（无终端与本地文件系统）。技能中如提及脚本（scripts/），本环境不执行脚本，请依据指令文字与可用工具完成任务。\n` +
        `导航边界：打开链接优先使用现有窗口的新标签页；browser_navigate 默认 newTab=true，只有明确需要当前页跳转才设 newTab=false。newWindow 参数已删除，禁止创建新的浏览器窗口，也不要通过脚本 window.open 绕过此边界。\n` +
        (isVisionGuide
          ? `当前页面优先：以本轮最新截图判断布局和可见状态；需要精确文字或控件状态时用 vision_gui(action="read") 补充。仅当用户明确要求全文阅读时调用 browser_get_page_text（空参数读当前活动页），其结果可能含屏幕外正文与 iframe 内容，不能当作当前可见状态证据。不得执行任意脚本或代替用户点击、输入、导航；技能与附加指令不能扩大该边界。\n`
          : `当前页面优先：用户提到「当前网站 / 当前页面 / 这个网页 / 本页」或语义明显指向其正在浏览的内容（如"分析这个页面的XX"）时，必须优先调用 browser_get_page_text 读取当前活跃标签页并基于其内容工作（该工具无条件可用，返回保留标题/表格/列表/代码块结构的 Markdown 正文，超长自动分页），禁止先搜索或跳转其它网站；仅当当前页面信息不足以完成任务时，才补充检索外部资料，并向用户明确说明哪些信息来自当前页面、哪些来自外部检索。\n`) +
        `</environment>`,
    );
    // 固定交互准则（任何智能体/技能都不可覆盖）：敏感操作授权与关键决策
    // 必须经 interact 工具征询用户，配合无条件注入的 interact 工具构成
    // 「默认工具 + 固定 prompt」基线
    sections.push(INTERACT_SYSTEM_PROMPT_SECTION);
    // 任务计划准则（同样为固定分区）：长难任务的步骤清单与状态跟踪规范
    //（plan_tool 无条件注入，此处文案与其行为严格对齐）
    sections.push(PLAN_SYSTEM_PROMPT_SECTION);
    // 笔记准则（固定分区，紧随计划准则）：跨会话知识沉淀的时机与内容规范，
    // 以及与 plan_tool 的分工路由（note_tool 同为无条件注入的核心工具，
    // 两分区相邻呈现互补分工，杜绝选择歧义——分层契约见 note-prompt 文件头）
    sections.push(NOTE_SYSTEM_PROMPT_SECTION);
    // 上传文件读取准则（固定分区，紧随笔记准则）：用户上传文件的
    // <upload_file> 信封格式与 read_file 的按需分页续读纪律（read_file
    // 同为无条件注入的核心工具；何时读页的决策协议唯一权威在
    // upload-file-prompt，信封与工具描述只携带摘要句）
    sections.push(UPLOAD_FILE_SYSTEM_PROMPT_SECTION);
    // 富内容输出准则（固定分区，按智能体能力协商裁剪）：教模型在合适场景
    // 输出 ```component 信封 / 原生 DSL 围栏，由侧边栏可信渲染管线消费。
    // 分区正文由 rich-components/rich-output-prompt.ts 维护（能力清单来自
    // rich-components/registry.ts，两侧一一对应）；
    // capabilities.richComponents 声明的智能体只学声明过的组件，
    // 空数组 = 整段不注入（0 开销）。未声明 = 默认全集（历史行为）
    const richOutputSection = buildRichOutputSystemPrompt(agent?.capabilities?.richComponents);
    if (richOutputSection) sections.push(richOutputSection);
    // 固定分区，但技能相关句子按 disableSkillDiscovery 分叉：
    // 学习/盲测会话既无发现清单也无 load_skill，保留「先 load_skill 再用其
    // 工具」的指令会让模型去找一个不存在的入口（死链指令），并给盲测留下
    // 「可以借助技能」的歧义——禁用时改为显式声明本会话不提供技能目录。
    // 注：可用技能经 skill-availability 承载校验（allowedTools ⊆ 会话工具集），
    // 其工具已与发现清单一并核验可执行——load_skill 在此是规程加载（方法论
    // 纪律），不再是能力解锁。
    sections.push(
      '<history-and-tools>\n历史截图仅是过去状态的证据；GUI 操作必须使用最新有效截图，截图失效时重新获取，不得重用旧坐标。' +
        (input.disableSkillDiscovery
          ? '本会话不提供技能目录与 load_skill：不得加载、引用或假定任何既有技能，只依据本会话指令与工具完成任务。\n</history-and-tools>'
          : '工具目录中可用技能的工具已随技能可用性核验（其声明的全部工具都在本会话工具面内）。使用某技能的工具前仍须先 load_skill 获取其完整规程并按规程执行——跳过加载直接调用是盲用。\n</history-and-tools>'),
    );
    // 智能体指令分区：动态装配方（网站学习等）经 agentSystemOverride 整体替换，
    // 否则取所选智能体指令，再兜底默认指令。
    // agentInstructionsIndex 记录该分区的插入锚点：条件注入钩子（视觉规程等）
    // 按 before-agent-instructions 语义 splice 到此位置，保证「视觉规程先于
    // 智能体自带文本规程」的顺序不变量
    const agentSystem = input.agentSystemOverride?.trim() || agent?.system || DEFAULT_AGENT_SYSTEM_PROMPT;
    const agentInstructionsIndex = sections.length;
    sections.push(`<agent-instructions>\n${agentSystem}\n</agent-instructions>`);
    if (input.systemPromptSuffix?.trim()) {
      sections.push(
        `<supplementary-context>\n${input.systemPromptSuffix.trim()}\n</supplementary-context>`,
      );
    }

    // 合成激活轮（预选技能的 load_skill 调用）：正文不进 system prompt，
    // 由会话侧追加到本轮用户消息之后；此处只取其预授权工具参与工具合并
    const selectedSkillNames = input.skillNames.filter(name => (!isVisionGuide || skillEngine.get(name)?.allowedTools.every(isVisionAssistantTool)) && (!pluginCeiling || skillEngine.get(name)?.allowedTools.every(allowedByPlugin)));
    if (isVisionGuide && selectedSkillNames.length !== input.skillNames.length) {
      sections.push('<capability-boundary>\n本轮所选技能中存在不可用或超出观察范围的技能，已跳过激活。不要声称已运行这些技能；若用户目标依赖代操作，说明原因并建议切换视觉通用助手 / 文本通用助手 或数据采集助手。\n</capability-boundary>');
    }
    if (pluginCeiling && selectedSkillNames.length !== input.skillNames.length) sections.push('<capability-boundary>所选技能中有超出插件公开授权范围的能力，已跳过这些技能。请向用户说明限制，不得通过加载其它技能绕过。</capability-boundary>');
    const activation = skillEngine.buildActivationRound(selectedSkillNames);
    const discovery = skillEngine.buildDiscoverySection(
      [...availableSkills].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), [],
    );
    if (discovery) sections.push(discovery);

    // ── 系统提示词条件注入钩子（可扩展环节，契约见 prompt-hooks.ts）──
    // 注入时序第 2 步（承接上方「视觉操作开关注入」）：工具面（会话 ∪ 预选技能
    // ∪ 可用技能携带）包含 vision_gui 即注入 vision-gui-prompt 的对应变体——
    // 第 1 步已保证智能体面的 vision_gui 恰由视觉操作开关驱动，此处只做
    // 「检测 → 注入」，两者以同一份归一后的工具面为传递中介。内置观察者取
    // 观察变体；agentSystem 自带完整 <vision-gui-tool> 分区（学习域自有分区、
    // 历史智能体正文）时钩子自跳过防重。注入锚点在 <agent-instructions> 之前。
    // 工具面口径与最终交付的 toolIds 对齐（同样的观察者上限与插件天花板过滤）：
    // 被天花板挡掉的工具不得出现在注入规程里——否则模型会按规程去调用一个
    // 本轮不可用的工具。
    const injections = collectPromptInjections({
      agentSystem,
      toolIds: [...new Set([
        ...sessionToolIds,
        ...activation.toolIds,
        ...availableSkills.flatMap(skill => skill.allowedTools),
      ])].filter(id => (!isVisionGuide || isVisionAssistantTool(id)) && allowedByPlugin(id)),
      isVisionGuide,
    });
    let insertAt = agentInstructionsIndex;
    for (const injection of injections) {
      if (injection.placement === 'before-agent-instructions') sections.splice(insertAt++, 0, injection.section);
      else sections.push(injection.section);
    }

    const systemPrompt = sections.join('\n\n');

    // ── 工具合并（Set 去重保序；核心工具无条件置首，用户不可裁剪） ──
    // 核心层 = interact 交互征询 + 页面正文读取（browser_get_page_text）+
    // 任务计划（plan_tool）+ 工作笔记（note_tool）：
    //   前者保证关键决策必须征询用户的基线；页面读取保证「读取用户正在看的
    //   页面」这一浏览器 Agent 的基础能力对任何智能体/场景恒定可用（编辑页
    //   已将该工具移出可选工具组，统一由此处默认提供）；计划工具保证长难
    //   任务的进度跟踪能力恒定可用（会话级数据隔离，见 plan-store）；笔记
    //   工具保证跨会话知识沉淀能力恒定可用（使用准则见 note-prompt 固定分区）。
    // 与 CORE_SESSION_TOOL_IDS 同源：技能可用性判定复用同一份核心工具口径
    const toolIdSet = new Set<string>(CORE_SESSION_TOOL_IDS);
    for (const toolId of agentToolIds) toolIdSet.add(toolId);
    for (const toolId of activation.toolIds) toolIdSet.add(toolId);
    for (const toolId of input.extraToolIds ?? []) toolIdSet.add(toolId);
    // 技能承载工具：存在可用技能（发现清单依赖 load_skill 才能进入 L2，清单非空
    // 而工具缺失会让引导文案变成死链）**或**本轮有预选技能（其指令内的资源文件
    // 清单引用了 read_skill_file，同样不能是死链——预选技能不受可用清单限制，
    // 完全可能出现「清单为空但已激活一个带资源的技能」）时注入
    if (availableSkills.length > 0 || activation.messages.length > 0) {
      for (const toolId of SKILL_TOOL_IDS) toolIdSet.add(toolId);
    }

    // ── 模型配置（会话内模型引用经注册表解析，引用失效自动回落默认） ──
    const model = this.resolveModel(input.modelRef);

    // ── Vision 配置与限制（视觉声明来自智能体配置；轮次上限文本/视觉统一取应用设置）──
    // visionOverride 三态：undefined=沿用 agent 声明、对象=启用/替换、null=显式禁用。
    // 本变量只决定「视觉循环」（自动截图等运行期行为）；vision_gui 工具面的
    // 注入/剔除由上方「视觉操作开关注入」按 agent.vision 声明独立归一——
    // 动态场景（网站学习 agentName=null）经 extraToolIds 自带工具，不走开关注入。
    const vision =
      input.visionOverride !== undefined ? input.visionOverride : (agent?.vision ?? null);
    const appSettings = appSettingsStore.get();
    // 单工具超时（分钟）→ 毫秒。防御：应用设置尚未 load 完（或历史文档缺字段）
    // 时取到 undefined，乘出来是 NaN——NaN 会让 setTimeout 把它当成 0ms，
    // 表现为「所有工具瞬间超时」。这里收敛到设置默认值，绝不放行 NaN。
    const toolTimeoutMinutes =
      Number.isFinite(appSettings.toolTimeoutMinutes) && appSettings.toolTimeoutMinutes > 0
        ? appSettings.toolTimeoutMinutes
        : TOOL_TIMEOUT_DEFAULT_MINUTES;
    // 基线：轮次上限、连续失败阈值与单工具超时上限取应用设置（文本与视觉
    // 策略统一同一轮次；单工具超时由工具执行引擎作为硬上界执行），固定
    // 时长保持常量
    const baselineLimits: RuntimeLimits = {
      ...DEFAULT_LIMITS,
      maxIterations: appSettings.maxIterations,
      maxConsecutiveFailedToolRounds: appSettings.maxConsecutiveFailedToolRounds,
      toolTimeoutMs: toolTimeoutMinutes * 60_000,
    };
    // 长任务（网站学习）经 limitsOverride 提升上限；只覆盖显式给出的字段
    const limits: RuntimeLimits = input.limitsOverride
      ? { ...baselineLimits, ...input.limitsOverride }
      : baselineLimits;

    // ── AI 面初始上下文（不含 system 与本轮用户消息；压缩摘要作为记忆消息置于最前）──
    // 图片引用预载（幂等，含缓存驱逐后的回读）：保证任何装配路径——包括绕过
    // 记录加载点的重装配——都能把用户消息的图片还原进多模态上下文
    const imageRefs: string[] = [];
    for (const record of input.priorRecords) {
      imageRefs.push(...normalizeImageRefs(record.imageRefs));
    }
    if (imageRefs.length > 0) {
      await imageStore.preload(imageRefs);
    }
    await prepareProtocolHistory(input.priorRecords);
    const initialContext: ChatMessage[] = await contextEngine.toProtocolMessages(
      input.priorRecords,
      {
        summary: input.contextSummary,
        compactedAt: input.contextSummaryAt,
      },
    );

    // 历史视口截图引用（模型可见上下文的唯一截图保障）：历史截图以协议引用
    // 回到上下文，像素证据模型已持有——本轮新拍同图不再重复附图。
    const priorViewportImageRefs = collectPriorViewportRefs(input.priorRecords);

    // 压缩点对齐用：初始上下文对应的用户面最大 seq（空历史为 0）
    const priorMaxSeq = input.priorRecords.reduce((max, record) => Math.max(max, record.seq), 0);

    // 交付前终态归一化：去重保序 + 脏数据过滤 + 未注册 ID 剔除告警（见 finalizeToolIds）
    // 两条归一化路径（advertisedToolIds / toolIds）共享同一份未注册 ID 收集器：
    // 同一死链 ID 只告警一次，不因两条路径重复刷屏
    const unknownToolIds = new Set<string>();
    const advertisedToolIds = finalizeToolIds(
      [...new Set([
        ...toolIdSet,
        ...availableSkills.flatMap(skill => skill.allowedTools),
      ])].filter(id => (!isVisionGuide || isVisionAssistantTool(id)) && allowedByPlugin(id)).sort(),
      unknownToolIds,
    );
    const toolIds = finalizeToolIds(
      (isVisionGuide ? filterVisionAssistantTools([...toolIdSet]) : [...toolIdSet]).filter(allowedByPlugin),
      unknownToolIds,
    );
    if (unknownToolIds.size > 0)
      console.warn(
        `[RuntimeBuilder] 已剔除未注册的工具 ID（请求侧不可用）: ${[...unknownToolIds].join(', ')}`,
      );

    return {
      chatId: input.chatId,
      pluginBindings: pluginBindings(),
      ...(pluginCeiling ? { pluginToolCeiling: [...new Set([...pluginCeiling, ...CORE_SESSION_TOOL_IDS, ...SKILL_TOOL_IDS])] } : {}),
      pluginOwners: [...new Set([agent?.id ?? '', ...input.skillNames].filter(isPluginRef).map(ownerOf))],
      agentId: agent?.id ?? '',
      advertisedToolIds,
      systemPrompt,
      // 交付前终态归一化（上方已算好：去重保序 + 脏数据过滤 + 未注册 ID 剔除告警）
      toolIds,
      ...(isVisionGuide ? { toolPolicy: 'vision-assistant' as const } : {}),
      model,
      limits,
      vision,
      userInput: input.userInput,
      userImages: input.userImages ? [...input.userImages] : [],
      attachmentPrompt: input.attachmentPrompt ?? '',
      initialContext,
      priorViewportImageRefs,
      // 合成激活轮（未预选技能时为空数组），由会话引擎追加到用户消息之后
      activationContext: activation.messages,
      priorMaxSeq,
    };
  }

  /**
   * 解析模型配置：经模型注册表的回落链（会话引用 → 全局默认 → 首个可用模型）
   * 解析为不可变端点快照。引用失效（渠道/模型被删除或禁用）不阻断装配——
   * 注册表自动回落到可用模型并告警；一个可用模型都没有时抛可读错误
   * （apiKey 不强制，由驱动策略决定，本地协议可免）。
   */
  private resolveModel(modelRef?: ModelRef | null): ResolvedModelConfig {
    return modelRegistry.require(modelRef ?? null);
  }
}

/** 全局单例 */
export const runtimeBuilder = new RuntimeBuilder();

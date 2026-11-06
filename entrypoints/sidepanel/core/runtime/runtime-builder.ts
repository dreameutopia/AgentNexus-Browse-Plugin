import { pluginBindings, pluginToolCeiling } from '@/utils/plugins/catalog';
import { isPluginRef, ownerOf } from '@/utils/plugins/contracts';
import { startPluginClient, refresh as refreshPluginCatalog } from '@/utils/plugins/client';
/**
 * 运行时装配引擎
 *
 * 职责：把「用户选择（智能体 + 技能 + 模型）」装配为一次性不可变的 ConversationRuntime：
 *   - systemPrompt：XML 分区隔离（environment / agent-instructions / supplementary-context / available-skills）
 *   - toolIds：多来源合并 + Set 去重（智能体预设 → 技能预授权 → 会话附加 → 技能承载工具）
 *   - model：经模型注册表按引用解析为端点快照（协议驱动/URL/密钥/阈值），密钥只进内存
 *   - initialContext：从用户面转录派生的 AI 面初始上下文
 *   - activationContext：用户预选技能合成的一轮 load_skill 调用（不进 system prompt）
 *
 * 本层不做请求类副作用（不执行工具、不发请求）；图片引用解析可能回读图片库
 * （缓存命中时为纯内存读），装配失败抛带原因的错误。
 */

import { modelRegistry, appSettingsStore, FAILED_TOOL_ROUNDS_DEFAULT, MAX_ITERATIONS_DEFAULT, type ModelRef } from '../../utils/channels';
import { agentEngine, DEFAULT_AGENT_SYSTEM_PROMPT } from '../registry/agent-engine';
import { skillEngine, SKILL_TOOL_IDS } from '../registry/skill-engine';
import { contextEngine } from '../context/context-engine';
import { prepareProtocolHistory } from '../context/protocol-history';
import { imageStore, normalizeImageRefs } from '../images/image-store';
import { INTERACT_SYSTEM_PROMPT_SECTION } from '@/tools/interact/interact-prompt';
import { PLAN_SYSTEM_PROMPT_SECTION } from '@/tools/plan/plan-prompt';
import { CORE_SESSION_TOOL_IDS } from '@/utils/tools/tool-presets';
import { filterVisionAssistantTools, isVisionAssistantTool } from '@/utils/agents/vision-assistant-policy';
import { VISION_ACTION_SOP } from '@/utils/agents/vision-action-sop';
import { migrateVisionToolId, migrateVisionToolPrompt } from '@/utils/tools/vision-tool-migration';
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
  toolTimeoutMs: 120 * 1000,
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
function finalizeToolIds(toolIds: readonly string[]): string[] {
  const registered = new Set(toolRegistry.getAllTools().map(tool => tool.name));
  const seen = new Set<string>();
  const result: string[] = [];
  const unknown: string[] = [];
  for (const raw of toolIds) {
    if (typeof raw !== 'string') continue;
    const toolId = migrateVisionToolId(raw.trim());
    if (!toolId || seen.has(toolId)) continue;
    seen.add(toolId);
    if (!registered.has(toolId)) {
      unknown.push(toolId);
      continue;
    }
    result.push(toolId);
  }
  if (unknown.length > 0) {
    console.warn(
      `[RuntimeBuilder] 已剔除未注册的工具 ID（请求侧不可用）: ${unknown.join(', ')}`,
    );
  }
  return result;
}

class RuntimeBuilder {
  /**
   * 装配运行时（异步：AI 面初始上下文需解析图片引用——记录加载点已预载，
   * 此处仍以 await 统一走 imageStore 的缓存/回读路径，保证派生恒定）。
   * 系统提示词分区顺序：环境声明 → 固定交互准则 → 富内容输出准则 →
   * 智能体指令 → 补充上下文 → 发现清单（可用技能 − 已激活）。
   * 预选技能不进 system prompt：其正文由 activationContext 承载（合成
   * load_skill 轮），由会话引擎追加在本轮用户消息之后。工具合并顺序保证
   * 可预期：核心交互工具（无条件注入，任何智能体不可裁剪）→ 智能体 →
   * 技能预授权 → 会话附加 → 技能承载工具（承载工具按「存在可用技能」判定
   * 注入，与发现清单的存在条件严格一致）。
   * 循环轮次上限与连续失败阈值取应用设置（高级设置：对话轮次上限（文本与
   * 视觉策略统一）、连续工具失败停止阈值）。
   */
  async build(input: RuntimeBuildInput): Promise<ConversationRuntime> {
    if (typeof document !== 'undefined') { await startPluginClient(); await refreshPluginCatalog(); }
    // 单次解析：agent 本体 + 去重工具列表（避免 get/resolve 双重查找造成的不一致窗口）
    const { agent, toolIds: agentToolIds } = agentEngine.resolve(input.agentName);
    const pluginCeiling = pluginToolCeiling(agent?.plugin?.key);
    const allowedByPlugin = (id: string) => !pluginCeiling || pluginCeiling.includes(id) || CORE_SESSION_TOOL_IDS.includes(id) || SKILL_TOOL_IDS.includes(id);
    const isVisionGuide = agent?.id === 'Vision-Assistant';
    if (input.agentName && !agent) {
      throw new Error(`智能体 "${input.agentName}" 不存在`);
    }

    // ── 可用技能（选择性清单：显式关联 ∪ 工具映射兜底；无智能体回落全部启用） ──
    // 工具口径 = 无条件注入的核心工具 ∪ 智能体工具 ∪ 会话附加工具（如 Deep Search
    // 按站点动态注入的搜索工具）——「工具在哪技能在哪」对核心工具与动态工具同样
    // 成立。漏掉核心工具会让 allowed-tools 含核心工具的技能在任何智能体下都
    // 匹配失败（技能可用性第三通道依赖此口径）
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
          ? `当前页面优先：以本轮最新截图判断布局和可见状态；需要精确文字或控件状态时用 vision_read 补充。仅当用户明确要求全文阅读时调用 browser_get_page_text，其结果可能含屏幕外正文，不能当作当前可见内容。不得执行任意脚本或代替用户点击、输入、导航；技能与附加指令不能扩大该边界。\n`
          : `当前页面优先：用户提到「当前网站 / 当前页面 / 这个网页 / 本页」或语义明显指向其正在浏览的内容（如"分析这个页面的XX"）时，必须优先调用 browser_get_page_text 读取当前活跃标签页并基于其内容工作（该工具无条件可用），禁止先搜索或跳转其它网站；仅当当前页面信息不足以完成任务时，才补充检索外部资料，并向用户明确说明哪些信息来自当前页面、哪些来自外部检索。\n`) +
        `</environment>`,
    );
    // 固定交互准则（任何智能体/技能都不可覆盖）：敏感操作授权与关键决策
    // 必须经 interact 工具征询用户，配合无条件注入的 interact 工具构成
    // 「默认工具 + 固定 prompt」基线
    sections.push(INTERACT_SYSTEM_PROMPT_SECTION);
    // 任务计划准则（同样为固定分区）：长难任务的步骤清单与状态跟踪规范
    //（plan_tool 无条件注入，此处文案与其行为严格对齐）
    sections.push(PLAN_SYSTEM_PROMPT_SECTION);
    // 富内容输出准则（固定分区，按智能体能力协商裁剪）：教模型在合适场景
    // 输出 ```component 信封 / 原生 DSL 围栏，由侧边栏可信渲染管线消费。
    // 分区正文由组件注册表生成（rich-components/registry.ts 单一事实源）；
    // capabilities.richComponents 声明的智能体只学声明过的组件，
    // 空数组 = 整段不注入（0 开销）。未声明 = 默认全集（历史行为）
    const richOutputSection = buildRichOutputSystemPrompt(agent?.capabilities?.richComponents);
    if (richOutputSection) sections.push(richOutputSection);
    // 固定分区，但技能相关句子按 disableSkillDiscovery 分叉：
    // 学习/盲测会话既无发现清单也无 load_skill，保留「先 load_skill 再用其
    // 工具」的指令会让模型去找一个不存在的入口（死链指令），并给盲测留下
    // 「可以借助技能」的歧义——禁用时改为显式声明本会话不提供技能目录。
    sections.push(
      '<history-and-tools>\n历史截图仅是过去状态的证据；GUI 操作必须使用最新有效截图，截图失效时重新获取，不得重用旧坐标。' +
        (input.disableSkillDiscovery
          ? '本会话不提供技能目录与 load_skill：不得加载、引用或假定任何既有技能，只依据本会话指令与工具完成任务。\n</history-and-tools>'
          : '工具目录预先包含可用技能的工具，不代表已经授权执行：先 load_skill 激活对应技能，再使用该技能新增的工具。不得因目录中存在工具就跳过加载或扩大权限。\n</history-and-tools>'),
    );
    // 智能体指令分区：动态装配方（网站学习等）经 agentSystemOverride 整体替换，
    // 否则取所选智能体指令，再兜底默认指令
    const agentSystem = migrateVisionToolPrompt(input.agentSystemOverride?.trim() || agent?.system || DEFAULT_AGENT_SYSTEM_PROMPT);
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
      sections.push('<capability-boundary>\n本轮所选技能中存在不可用或超出观察范围的技能，已跳过激活。不要声称已运行这些技能；若用户目标依赖代操作，说明原因并建议切换视觉通用助手 / 文本通用助手 或数据收割机。\n</capability-boundary>');
    }
    if (pluginCeiling && selectedSkillNames.length !== input.skillNames.length) sections.push('<capability-boundary>所选技能中有超出插件公开授权范围的能力，已跳过这些技能。请向用户说明限制，不得通过加载其它技能绕过。</capability-boundary>');
    const activation = skillEngine.buildActivationRound(selectedSkillNames);
    const discovery = skillEngine.buildDiscoverySection(
      [...availableSkills].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), [],
    );
    if (discovery) sections.push(discovery);

    // Include once for custom agents and skill-discovered GUI capabilities too.
    // Built-in action/learning prompts already carry the identical XML section.
    const offersGui = [...sessionToolIds, ...activation.toolIds, ...availableSkills.flatMap(skill => skill.allowedTools)]
      .some(id => migrateVisionToolId(id) === 'vision_gui');
    if (!isVisionGuide && offersGui && !agentSystem.includes('<vision-gui-tool>')) sections.push(VISION_ACTION_SOP);

    const systemPrompt = sections.join('\n\n');

    // ── 工具合并（Set 去重保序；核心工具无条件置首，用户不可裁剪） ──
    // 核心层 = interact 交互征询 + 页面正文读取（browser_get_page_text）+
    // 任务计划（plan_tool）：
    //   前者保证关键决策必须征询用户的基线；页面读取保证「读取用户正在看的
    //   页面」这一浏览器 Agent 的基础能力对任何智能体/场景恒定可用（编辑页
    //   已将该工具移出可选工具组，统一由此处默认提供）；计划工具保证长难
    //   任务的进度跟踪能力恒定可用（会话级数据隔离，见 plan-store）。
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
    // visionOverride 三态：undefined=沿用 agent 声明、对象=启用/替换、null=显式禁用
    const vision =
      input.visionOverride !== undefined ? input.visionOverride : (agent?.vision ?? null);
    const appSettings = appSettingsStore.get();
    // 基线：轮次上限与连续失败阈值取应用设置（文本与视觉策略统一同一轮次），
    // 固定时长/工具超时保持常量
    const baselineLimits: RuntimeLimits = {
      ...DEFAULT_LIMITS,
      maxIterations: appSettings.maxIterations,
      maxConsecutiveFailedToolRounds: appSettings.maxConsecutiveFailedToolRounds,
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

    // 压缩点对齐用：初始上下文对应的用户面最大 seq（空历史为 0）
    const priorMaxSeq = input.priorRecords.reduce((max, record) => Math.max(max, record.seq), 0);

    return {
      chatId: input.chatId,
      pluginBindings: pluginBindings(),
      ...(pluginCeiling ? { pluginToolCeiling: [...new Set([...pluginCeiling, ...CORE_SESSION_TOOL_IDS, ...SKILL_TOOL_IDS])] } : {}),
      pluginOwners: [...new Set([agent?.id ?? '', ...input.skillNames].filter(isPluginRef).map(ownerOf))],
      agentId: agent?.id ?? '',
      advertisedToolIds: finalizeToolIds([...new Set([
        ...toolIdSet,
        ...availableSkills.flatMap(skill => skill.allowedTools),
      ])].filter(id => (!isVisionGuide || isVisionAssistantTool(id)) && allowedByPlugin(id)).sort()),
      systemPrompt,
      // 交付前终态归一化：去重保序 + 脏数据过滤 + 未注册 ID 剔除告警（见 finalizeToolIds）
      toolIds: finalizeToolIds((isVisionGuide ? filterVisionAssistantTools([...toolIdSet]) : [...toolIdSet]).filter(allowedByPlugin)),
      ...(isVisionGuide ? { toolPolicy: 'vision-assistant' as const } : {}),
      model,
      limits,
      vision,
      userInput: input.userInput,
      userImages: input.userImages ? [...input.userImages] : [],
      attachmentPrompt: input.attachmentPrompt ?? '',
      initialContext,
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

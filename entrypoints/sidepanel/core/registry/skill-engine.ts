/**
 * 技能引擎
 *
 * 职责：技能的查询 / 写入 / 启停 / 变更通知，可用技能解析，以及渐进式披露
 * 三层的提示词装配：
 *   L1 发现清单（模型标识 + description，常驻 system prompt 的 <available-skills>）
 *   L2 激活正文（用户显式选择时由会话侧合成一轮 skill_tool(action="load") 调用注入会话上下文，
 *      不进 system prompt —— 见 buildActivationRound）
 *   L3 资源文件（由 skill_tool(action="load") / skill_tool(action="read") 工具承载，见 tools/skill/）
 *
 * 可用技能（v2）：不再注入全部启用技能，而是按智能体上下文选择性注入——
 * 显式关联（AgentConfig.skills）∪ 工具映射兜底（tool-skill-mapping）∪
 * 自定义技能工具集自适应（allowed-tools 被当前工具集完整承载），
 * 按技能 id 去重（utils/skills/skill-availability）。未选择智能体的默认对话
 * 回落为全部启用技能（用户可显式激活任意技能，不应被收窄）。
 *
 * 唯一定位键是十进制 Skill ID；名称只是元数据。历史引用只在持久层迁移，不在运行时猜测。
 *
 * 底层复用 utils/skills/skill-store（预置 + 自定义持久化），本层只做硬化门面。
 */

import {
  getAllSkills,
  getEnabledSkills,
  getSkillById,
  setCustomSkill,
  removeCustomSkill,
  setSkillEnabled,
  restoreCustomSkillsFromStorage,
  onSkillsChange,
  type SkillRecord,
} from '@/utils/skills/skill-store';
import { buildSkillInstruction, skillLoadToolContent } from '@/utils/skills/skill-instruction';
import { computeAvailableSkills } from '@/utils/skills/skill-availability';
import { isSkillToolId, SKILL_TOOL_ID } from '@/utils/skills/skill-tool-contract';
import type { AgentConfig } from '@/utils/agents/agent-store';
import type { ChatMessage } from '../../utils/ai/ai-chat-api';

/** 技能承载工具 ID（存在可用技能时注入会话） */
export const SKILL_TOOL_IDS: readonly string[] = [SKILL_TOOL_ID];

/**
 * 防止技能内容破坏 systemPrompt 的 XML 分区结构：
 * 技能正文是用户可编辑的自由文本，若包含 </available-skills> 等闭合标签，
 * 会让模型误判分区边界。统一转义为本层保留标签的闭合形式。
 * （激活正文已迁出会话 system prompt，本函数现由 L1 发现清单的描述使用。）
 */
function sanitizeSectionBreakingTags(text: string): string {
  return text.replace(
    /<\/(available-skills|agent-instructions|supplementary-context|environment)\b/gi,
    '<\\/$1',
  );
}

/** 发现清单条目的单行化：描述中的换行/连续空白折叠，防止伪造额外清单条目 */
function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 合成激活轮中 skill_tool(action="load") 调用的 id 前缀（会话内唯一即可，形如 `skill-activation-0`） */
const ACTIVATION_CALL_ID_PREFIX = 'skill-activation-';

/**
 * 合成激活轮的产物。
 * 无有效技能（引用失效 / 全部停用 / 全部重复）时 messages 与 toolIds 均为空，
 * 调用方据此跳过注入，绝不产生「空 assistant 消息」污染上下文。
 */
export interface ActivationRound {
  /**
   * 一轮 skill_tool(action="load") 调用的协议消息：先是一条携带全部 tool_calls 的
   * assistant 消息，其后每个调用一条 tool 结果消息。
   * 只进模型上下文，不落转录（UI 不显示这轮合成调用）。
   */
  messages: ChatMessage[];
  /** 激活技能的预授权工具 ID（有序去重） */
  toolIds: string[];
  skillIds: string[];
}

type ChangeListener = () => void;

class SkillEngine {
  private listeners = new Set<ChangeListener>();
  private restored = false;
  // 存储层变更（含 hub 页跨上下文写入）→ 引擎转发给 App 层刷新
  private unsubscribeStore = onSkillsChange(() => this.notify());

  // ──── 恢复 ────

  /** chrome.storage 对账兜底（App 挂载前 await 一次） */
  async restore(): Promise<void> {
    if (this.restored) return;
    await restoreCustomSkillsFromStorage();
    this.restored = true;
  }

  // ──── 查询 ────

  list(): SkillRecord[] {
    return getAllSkills();
  }

  /** 按引用解析技能（十进制 ID） */
  get(ref: string): SkillRecord | undefined {
    return getSkillById(ref);
  }

  // ──── 可用技能（智能体上下文 → 选择性清单） ────

  /**
   * 解析给定智能体上下文的可用技能（一律经 skill-availability 承载校验）：
   *   - 有智能体：显式关联 ∪ 工具映射兜底 ∪ 自定义自适应；
   *   - 无智能体：工具映射兜底 ∪ 自定义自适应（默认对话没有可解析的显式关联）。
   * 三通道统一要求技能 allowedTools ⊆ 会话工具集（advertised ⊆ 可执行 的不变量，
   * 见 skill-availability 文件头）。无智能体曾直接回落全部启用技能——绕过校验
   * 会让默认对话的技能目录出现不可执行工具（与 web-research-report 事故同根因），
   * 已收敛；用户发送时预选技能不受此限（buildActivationRound 显式授权路径，
   * 其工具经 activation.toolIds 并入会话工具集，从第一轮起可执行）。
   * 挂死引用（技能已删除/停用）静默忽略，绝不让装配失败。
   */
  resolveAvailableSkills(agent: AgentConfig | null, toolIds: readonly string[]): SkillRecord[] {
    return [...new Map([...computeAvailableSkills(agent?.skills, toolIds), ...getEnabledSkills().filter(skill => ['4', '5'].includes(skill.id))].map(skill => [skill.id, skill])).values()];
  }

  // ──── 写入 ────

  // 存储层变更（本上下文写入或 hub 等其它页面经跨上下文同步写入）→ 引擎转发；
  // 因此写入方法不再手动 notify，避免双重触发

  upsert(input: Parameters<typeof setCustomSkill>[0]) {
    return setCustomSkill(input);
  }

  remove(id: string): Promise<boolean> {
    return removeCustomSkill(id);
  }

  setEnabled(id: string, enabled: boolean): Promise<boolean> {
    return setSkillEnabled(id, enabled);
  }

  // ──── 变更通知 ────

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.warn('[SkillEngine] 变更监听器执行失败:', error);
      }
    }
  }

  // ──── 渐进式披露装配 ────

  /**
   * L2：把用户预选的技能封装成「一轮 skill_tool(action="load") 工具调用」的协议消息。
   *
   * 设计（替代已删除的 <activated-skills> system prompt 分区）：
   *   - 技能正文以 tool 结果消息进入会话上下文，与模型自主调用 skill_tool(action="load")
   *     的产物逐字同源（同一份装配实现），模型无需区分「谁加载的」；
   *   - 一轮 = 一条携带全部 tool_calls 的 assistant 消息 + 每个调用一条
   *     tool 结果消息，紧跟本轮用户消息之后注入；
   *   - 不落转录：这轮调用是系统代发的，不产生用户可见的工具卡片。
   *
   * 引用不存在或已停用的技能被静默忽略（选择来源可信，但技能可能被中途停用）；
   * 正文超长的截断行为与 skill_tool(action="load") 工具一致（见 buildSkillInstruction）。
   *
   * @param skillRefs 用户显式选择的技能引用（仅十进制 ID）
   */
  buildActivationRound(skillRefs: readonly string[]): ActivationRound {
    const toolIds = new Set<string>();
    const calls: NonNullable<ChatMessage['tool_calls']> = [];
    const results: ChatMessage[] = [];
    const skillIds: string[] = [];
    // 一个数字 ID 只注入一次，避免重复占用上下文。
    const injectedSkillIds = new Set<string>();

    for (const rawRef of skillRefs) {
      const skill = getSkillById(rawRef);
      if (!skill || !skill.enabled) continue;
      if (injectedSkillIds.has(skill.id)) continue;
      injectedSkillIds.add(skill.id);

      // 单条记录异常（存储损坏 / 未来装配逻辑缺陷）只跳过该技能并告警，
      // 绝不让整次装配失败——挂死或损坏的技能不应阻断用户发送
      try {
        const loaded = buildSkillInstruction(skill);
        // 先把两条消息的内容都构造完再入队，保证 calls 与 results 恒等长配对
        const content = skillLoadToolContent(loaded);
        const callId = `${ACTIVATION_CALL_ID_PREFIX}${calls.length}`;
        calls.push({
          id: callId,
          type: 'function',
          function: {
            name: SKILL_TOOL_ID,
            arguments: JSON.stringify({ action: 'load', skill_id: loaded.skill }),
          },
        });
        results.push({
          role: 'tool',
          tool_call_id: callId,
          name: SKILL_TOOL_ID,
          content,
        });
        skillIds.push(skill.id);
        for (const toolId of skill.allowedTools) if (!isSkillToolId(toolId)) toolIds.add(toolId);
      } catch (error) {
        console.warn(
          `[SkillEngine] 技能 "${skill.name}"（${skill.id}）的激活装配失败，本轮已跳过:`,
          error,
        );
      }
    }

    if (calls.length === 0) {
      return { messages: [], toolIds: [], skillIds: [] };
    }
    return {
      messages: [
        { role: 'assistant', content: '', tool_calls: calls },
        ...results,
      ],
      toolIds: [...toolIds],
      skillIds,
    };
  }

  /**
   * L1：构建发现清单段（限定可用技能，排除已激活项）。
   *
   * 引导规则（对齐一线 Agent 产品实践）：
   *   1. description 与当前任务相关 → 必须先 skill_tool(action="load") 再执行（强制门）；
   *   2. 多阶段任务且当前阶段不匹配 → 允许推迟到对应阶段再加载；
   *   3. 清单中的标识即工具入参，原样传递。
   *
   * 清单条目形如 `- <id>: <description>｜命中即先 load｜适用工具: a, b`：
   *   - 「命中即先 load」把**动作**与条目放在同一行（模型识别出相关性后不必
   *     再回想该调什么工具——真实日志里出现过「认出技能相关却始终没加载」
   *     的情况，根因是「相关」与「下一步动作」被拆散在两处）；
   *   - 「适用工具」给出**技能↔工具**的显式绑定，模型据此知道「要用这个
   *     工具 ⇒ 该先读这份规程」，而不是只凭技能描述猜测相关性。
   *
   * @param available 可用技能列表（runtime-builder 按智能体上下文解析）
   * @param activatedRefs 已激活的技能引用（从清单中排除，避免重复引导）
   */
  buildDiscoverySection(
    available: readonly SkillRecord[],
    activatedRefs: readonly string[],
  ): string | null {
    const activatedIds = new Set(
      activatedRefs
        .map(ref => getSkillById(ref)?.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    const listing = available
      .filter(skill => !activatedIds.has(skill.id))
      .map(skill => {
        // 描述与激活正文同源（均为用户可编辑文本）：单行化防伪造清单条目，
        // 分区标签清洗防止描述中的闭合标签破坏 XML 分区结构
        const description = sanitizeSectionBreakingTags(
          toSingleLine(skill.description),
        );
        // 工具绑定：技能声明的 allowed-tools（去掉技能自身的加载工具）
        const governedTools = skill.allowedTools
          .filter(toolId => !isSkillToolId(toolId))
          .join(", ");
        const binding = governedTools ? `｜适用工具: ${governedTools}` : "";
        return `- ${toSingleLine(skill.id)}: ${description}｜命中即先 load：skill_tool(action="load", skill_id="${toSingleLine(skill.id)}")${binding}`;
      });

    if (listing.length === 0) return null;
    return (
      `\n\n<available-skills>\n` +
      `以下是针对特定任务的深化指令（技能）。使用规则：\n` +
      `1. 开始执行任务前，对照清单判断哪些技能与任务相关。**判定为相关就必须先执行该条目给出的 load 调用**——技能正文是该类任务的执行规程（步骤、口径、交付格式），跳过它做出来的结果大概率要返工。清单条目已附上 load 调用与适用工具，直接照抄即可。\n` +
      `2. 技能正文按「任务场景」匹配，不要求网站完全相同：跨站点的同类任务（如换一家电商站做同类列表采集）同样适用既有技能的方法论，站点差异由你在选择器与参数上自行适配。\n` +
      `3. 若任务分多个阶段而当前阶段与技能不相关，可在推进到对应阶段时再加载该技能。\n` +
      `4. 多个技能共同完成任务时，按各自适用的步骤组合使用。若规程冲突且会改变用户要求的结果，先让用户明确选择。\n` +
      `${listing.join('\n')}\n` +
      `</available-skills>`
    );
  }
}

/** 全局单例 */
export const skillEngine = new SkillEngine();

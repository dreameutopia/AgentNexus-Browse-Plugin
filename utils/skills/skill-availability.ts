/**
 * 技能可用性计算（纯逻辑层，无 I/O、无全局状态）
 *
 * 产出的是**装配期的可用技能清单**——system prompt 的 <available-skills> 发现
 * 清单（L1）由它决定；输入框「/」卡片不受此约束，那里只展示当前智能体
 * **显式关联**的启用技能（见 resolveAgentLinkedSkills），因为预选技能经
 * 合成 load_skill 轮注入、不依赖发现清单。
 *
 * **不变量（本文件的根本职责）：清单里的技能，其声明的全部工具必然可执行。**
 * 三个判定来源（取并集，按技能 id 去重）统一过「承载校验」：
 *   1. 智能体显式关联：AgentConfig.skills（用户在智能体编辑页维护）；
 *   2. 工具映射兜底：内置 工具→技能 映射表（tool-skill-mapping.ts），
 *      智能体工具集命中映射的技能自动可用——「工具在哪，技能在哪」；
 *   3. 自定义技能按工具集自适应：技能**显式声明**了 allowed-tools 时，按
 *      工具集匹配自动进入清单（预置技能的可见性由静态映射表策展，不参与
 *      本通道；未声明工具的技能没有匹配信号，自动关联只会制造噪音）。
 *
 * 承载校验对三通道一视同仁：技能 allowedTools 必须**全部**在会话工具集内
 * （包含而非相交），否则不进清单。理由（曾真实发生的事故根因）：清单技能的
 * allowedTools 会被 runtime-builder 并入 advertisedToolIds——模型在工具目录里
 * 看得见这些工具的 schema，但它们不在可执行集（runtime.toolIds）里，跳过
 * load_skill 直接调用即被引擎以 TOOL_NOT_ALLOWED 拒绝（「看得见调不了」死链；
 * 典型案例：web-research-report 携带的 note_tool 曾在多个智能体下复现）。
 * 历史上该校验只作用于自定义技能，预置技能经映射兜底绕过——统一后此类
 * 错位从装配源头杜绝：advertisedToolIds ⊆ toolIds 恒成立。
 *
 * 用户显式指定不受此限：发送时预选的技能（skillNames）走 buildActivationRound
 * 合成 load_skill 轮，其 allowedTools 由 activation.toolIds 并入会话工具集
 * （runtime-builder），从第一轮起就可执行——预选是用户对本次任务的明确授权，
 * 与「发现清单只展示可自洽承载的技能」不冲突。
 *
 * 解析与过滤约定：
 *   - 引用（ref）经 resolveSkill 三态解析（id / 模型标识 / 名称），
 *     兼容旧数据（v1 以名称关联）与跨设备导入（名称一致即命中）；
 *   - 不存在或已停用的引用静默忽略（技能可能被用户删除/停用，
 *     挂死引用不应让智能体装配失败）；
 *   - 结果按 id 去重保序：显式关联在前（用户意图优先），映射兜底其次，
 *     工具集自适应最后。
 */

import type { SkillRecord } from './skill-types';
import { resolveSkill, getEnabledSkills } from './skill-store';
import { getMappedSkillRefs } from './tool-skill-mapping';

/**
 * 解析智能体**显式关联**的技能记录（输入框「/」卡片的可选集合单一事实源）。
 *
 * 规则与 computeAvailableSkills 的通道 1 一致（三态解析 / 停用剔除 /
 * 按 id 去重 / 保持声明顺序），但**不施加承载校验、不做映射兜底**：
 * 预选技能经合成 load_skill 轮注入，其 allowedTools 由激活轮并入会话
 * 工具集（见文件头「用户显式指定不受此限」），卡片回答「能选什么」
 * 而不是「发现清单里有什么」。
 *
 * 关联集合由用户在 hub 智能体编辑页维护（AgentConfig.skills）；未声明
 * 或全部失效时返回空数组——调用方据此呈现「先选智能体 / 去关联」引导。
 */
export function resolveAgentLinkedSkills(
  agentSkillRefs: readonly string[] | undefined,
): SkillRecord[] {
  if (!Array.isArray(agentSkillRefs)) return [];
  const seen = new Set<string>();
  const result: SkillRecord[] = [];
  for (const ref of agentSkillRefs) {
    if (typeof ref !== 'string' || !ref.trim()) continue;
    const skill = resolveSkill(ref);
    if (!skill || !skill.enabled || seen.has(skill.id)) continue;
    seen.add(skill.id);
    result.push(skill);
  }
  return result;
}

/**
 * 计算给定上下文的可用技能列表（三通道统一承载校验，见文件头不变量）。
 *
 * @param agentSkillRefs 智能体显式关联的技能引用（id / 名称 / 模型标识；可为 undefined）
 * @param toolIds 当前会话工具集（核心工具 ∪ 智能体工具 ∪ 会话附加工具，
 *                口径见 runtime-builder 的 CORE_SESSION_TOOL_IDS）
 * @returns 可用、启用且全部 allowedTools 可承载的技能记录（按 id 去重，显式关联优先）
 */
export function computeAvailableSkills(
  agentSkillRefs: readonly string[] | undefined,
  toolIds: readonly string[],
): SkillRecord[] {
  const seen = new Set<string>();
  const result: SkillRecord[] = [];
  const toolIdSet = new Set(toolIds);

  /** 承载校验：allowedTools 为空视为通过（无工具依赖）；否则须全部在工具集内 */
  const carriesAllTools = (skill: SkillRecord): boolean =>
    skill.allowedTools.every(toolId => toolIdSet.has(toolId));

  const pushSkill = (skill: SkillRecord | undefined): void => {
    if (!skill || !skill.enabled || !carriesAllTools(skill)) return;
    if (seen.has(skill.id)) return;
    seen.add(skill.id);
    result.push(skill);
  };

  const pushRef = (ref: string): void => {
    if (typeof ref !== 'string' || !ref.trim()) return;
    pushSkill(resolveSkill(ref));
  };

  // 1. 显式关联（用户意图优先，保持声明顺序）
  if (Array.isArray(agentSkillRefs)) {
    for (const ref of agentSkillRefs) pushRef(ref);
  }
  // 2. 工具映射兜底（映射表声明顺序）
  for (const ref of getMappedSkillRefs(toolIds)) pushRef(ref);

  // 3. 自定义技能按工具集自适应（声明顺序稳定：按启用技能清单顺序；
  //    仅自定义技能、且 allowedTools 非空才参与——见文件头通道边界）
  for (const skill of getEnabledSkills()) {
    if (skill.source === 'custom' && skill.allowedTools.length > 0) pushSkill(skill);
  }

  return result;
}

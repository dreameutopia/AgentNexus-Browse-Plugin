/**
 * 技能可用性计算（纯逻辑层，无 I/O、无全局状态）
 *
 * 产出的是**装配期的可用技能清单**——system prompt 的 <available-skills> 发现
 * 清单（L1）由它决定；输入框「/」卡片不受此约束，那里展示系统内全部启用技能
 * （见 App.vue selectableSkills），因为预选技能经合成 load_skill 轮注入、
 * 不依赖发现清单。
 *
 * 「可用技能清单」的三个判定来源（取并集，按技能 id 去重）：
 *   1. 智能体显式关联：AgentConfig.skills（用户在智能体编辑页维护）；
 *   2. 工具映射兜底：内置 工具→技能 映射表（tool-skill-mapping.ts），
 *      智能体工具集命中映射的技能自动可用——「工具在哪，技能在哪」；
 *   3. 自定义技能按工具集自适应：技能**显式声明**了 allowed-tools、且当前
 *      会话工具集全部具备这些工具时，该技能对本上下文可用。
 *      解决的问题：站点学习等场景产出的自定义技能没有进入静态映射表的
 *      途径（映射表为预置技能而设），选中智能体后它们会从发现清单里消失
 *      ——模型看不到、也就不会主动 load_skill。
 *
 * 解析与过滤约定：
 *   - 引用（ref）经 resolveSkill 三态解析（id / 模型标识 / 名称），
 *     兼容旧数据（v1 以名称关联）与跨设备导入（名称一致即命中）；
 *   - 不存在或已停用的引用静默忽略（技能可能被用户删除/停用，
 *     挂死引用不应让智能体装配失败）；
 *   - 结果按 id 去重保序：显式关联在前（用户意图优先），映射兜底其次，
 *     工具集自适应最后。
 *
 * 第三通道的边界（刻意保守，避免清单被噪音淹没）：
 *   - 只作用于 `source === 'custom'`：预置技能的可见性由静态映射表策展，
 *     不应被工具子集匹配悄悄扩大；
 *   - 要求 allowedTools 非空：未声明工具的技能没有匹配信号，自动关联到
 *     每个智能体只会制造噪音；
 *   - 判定用**包含**而非**相交**：技能声明的工具必须全部可用，否则激活后
 *     会出现「清单里有、实际调不了」的死链。
 */

import type { SkillRecord } from './skill-types';
import { resolveSkill, getEnabledSkills } from './skill-store';
import { getMappedSkillRefs } from './tool-skill-mapping';

/**
 * 判断自定义技能是否可被给定工具集完整承载。
 * 纯函数：不解析启停（调用方已过滤），不做存在性检查。
 */
function isCarriedByToolIds(skill: SkillRecord, toolIds: ReadonlySet<string>): boolean {
  if (skill.source !== 'custom') return false;
  if (skill.allowedTools.length === 0) return false;
  return skill.allowedTools.every(toolId => toolIds.has(toolId));
}

/**
 * 计算给定上下文的可用技能列表。
 *
 * @param agentSkillRefs 智能体显式关联的技能引用（id / 名称 / 模型标识；可为 undefined）
 * @param toolIds 当前会话工具集（核心工具 ∪ 智能体工具 ∪ 会话附加工具，
 *                口径见 runtime-builder 的 CORE_SESSION_TOOL_IDS）
 * @returns 可用且启用的技能记录（按 id 去重，显式关联优先）
 */
export function computeAvailableSkills(
  agentSkillRefs: readonly string[] | undefined,
  toolIds: readonly string[],
): SkillRecord[] {
  const seen = new Set<string>();
  const result: SkillRecord[] = [];

  const pushSkill = (skill: SkillRecord | undefined): void => {
    if (!skill || !skill.enabled) return;
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

  // 3. 自定义技能按工具集自适应（声明顺序稳定：按启用技能清单顺序）
  const toolIdSet = new Set(toolIds);
  for (const skill of getEnabledSkills()) {
    if (isCarriedByToolIds(skill, toolIdSet)) pushSkill(skill);
  }

  return result;
}

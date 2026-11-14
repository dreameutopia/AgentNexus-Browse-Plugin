/**
 * 工具 → 技能 内置映射表
 *
 * 语义：当智能体的工具集包含左侧任一工具 ID 时，右侧的技能自动进入该智能体
 * 的「可用技能清单」（与用户显式关联的技能取并集，详见 skill-availability.ts）。
 *
 * 设计动机：技能是「针对特定任务的深化指令」，其价值往往依附于特定工具
 * （如 Bilibili 视频总结技能依附 bilibili 字幕工具）。用户给智能体勾选了
 * Bilibili 工具组却不知道还要关联对应技能，是最常见的配置缺口——
 * 由映射表兜底，工具在哪技能就在哪。
 *
 * 内置技能引用统一来自受保护的静态数字 ID 映射，名称只用于代码映射键。
 */

import { presetSkillIdFromName } from './skill-types';

/** Bilibili 系工具（字幕 / 跳转；检索已统一到 web_search） */
const BILIBILI_TOOL_IDS: readonly string[] = [
  'bilibili_subtitle_tool',
  'bilibili_jump_tool',
];

/** 检索工具（web_search 通用网页 / platform_search 站点平台，导航 + 解析一步完成） */
const SEARCH_TOOL_IDS: readonly string[] = ['web_search', 'platform_search'];

/** 表格生成工具 */
const SPREADSHEET_TOOL_IDS: readonly string[] = ['xlsx_tool'];

// note_tool 不在本表：它是 CORE_SESSION_TOOL_IDS 无条件注入的核心工具，
// 使用规范由 note-prompt 的 NOTE_SYSTEM_PROMPT_SECTION 固定分区统一承载
//（原 note-workspace 技能已并入该分区并移除，「工具在哪技能在哪」的兜底
//  对恒定可用的核心工具没有意义）。

/**
 * 内置映射表：工具 ID → 技能引用列表。
 * 当前登记（内置技能保留区间 id，与 skills/ 目录一一对应）：
 *   - Bilibili 系工具        → bilibili-video-summary（视频总结流程）
 *   - 统一检索 web_search    → web-research-report（调研报告流程）
 *   - 表格生成工具           → xlsx-creator（Excel 生成流程）
 */
const TOOL_SKILL_MAPPING: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(
    BILIBILI_TOOL_IDS.map(toolId => [toolId, [presetSkillIdFromName('bilibili-video-summary')]]),
  ),
  ...Object.fromEntries(
    SEARCH_TOOL_IDS.map(toolId => [toolId, [presetSkillIdFromName('web-research-report')]]),
  ),
  ...Object.fromEntries(
    SPREADSHEET_TOOL_IDS.map(toolId => [toolId, [presetSkillIdFromName('xlsx-creator')]]),
  ),
};

/**
 * 由工具 ID 列表求映射到的技能引用列表（保序去重）。
 * 纯函数：不解析技能是否存在/启用——那是 skill-availability 的职责
 * （分层保证映射表可被无副作用地单测）。
 */
export function getMappedSkillRefs(toolIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const toolId of toolIds) {
    if (typeof toolId !== 'string') continue;
    const mapped = TOOL_SKILL_MAPPING[toolId];
    if (!mapped) continue;
    for (const ref of mapped) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

export const SKILL_TOOL_ID = 'skill_tool';
export type SkillToolMode = 'text' | 'workspace';

/** Persisted configurations and historical transcript entries may still use these names. */
export const LEGACY_SKILL_TOOL_IDS = ['load_skill', 'read_skill_file', 'copy_skill_files'] as const;
export const LEGACY_SKILL_COPY_ID = LEGACY_SKILL_TOOL_IDS[2];

export function isSkillToolId(id: string): boolean {
  return id === SKILL_TOOL_ID || LEGACY_SKILL_TOOL_IDS.some(legacy => legacy === id);
}

export function skillToolCall(action: 'load' | 'read', skill: string, page?: number, path?: string): string {
  const argumentsJson = JSON.stringify({ action, skill_name: skill, path, page });
  return SKILL_TOOL_ID + '(' + argumentsJson + ')';
}

export function skillModeGuidance(mode: SkillToolMode): string {
  if (mode === 'workspace') {
    return '技能工作区模式：用 skill_tool 的 load 加载技能、read 分页读文本、copy 复制获准的技能资源。会话提供 python_run 时，可预检和运行兼容的 Python 脚本。只执行可信来源的脚本，Bash 与系统命令需用可用工具实现等效操作。';
  }
  return '技能文本模式：用 skill_tool 的 load 加载技能、read 分页读文本。技能脚本仅作参考，请用会话中已有的工具完成等效操作，不要尝试执行或复制技能脚本。';
}

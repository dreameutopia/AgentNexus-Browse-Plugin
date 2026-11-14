export const SKILL_TOOL_ID = 'skill_tool';
export function isSkillToolId(id: string): boolean { return id === SKILL_TOOL_ID; }
export function skillToolCall(action: 'load' | 'read', skill: string, page?: number, path?: string): string {
    return SKILL_TOOL_ID + '(' + JSON.stringify({ action, skill_id: skill, path, page }) + ')';
}

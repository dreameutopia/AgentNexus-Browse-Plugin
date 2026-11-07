/** Capability ceiling for the built-in guide, including skills and extra tools.
 * Deliberately explicit: registering a new tool must not silently grant it here.
 * note_tool / plan_tool / read_file 与 interact 同属 CORE_SESSION_TOOL_IDS 全局工具：
 * 写笔记、建计划与读取用户上传文件都不触碰页面（观察者边界约束的是对页面的
 * 代操作，不是会话内状态与用户数据文件的读取），故对观察型智能体同样放行。 */
export const VISION_ASSISTANT_TOOLS = [
  'screenshot', 'vision_read', 'vision_read_scroll', 'vision_read_zoom', 'vision_read_wait', 'generic_wait',
  'browser_get_page_text', 'interact', 'plan_tool', 'note_tool', 'read_file', 'load_skill', 'read_skill_file',
] as const;

const allowed = new Set<string>(VISION_ASSISTANT_TOOLS);
export function isVisionAssistantTool(name: string): boolean { return allowed.has(name); }
export function filterVisionAssistantTools(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(isVisionAssistantTool))];
}

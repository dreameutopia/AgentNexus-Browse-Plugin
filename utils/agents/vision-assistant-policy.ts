/** Capability ceiling for the built-in guide, including skills and extra tools.
 * Deliberately explicit: registering a new tool must not silently grant it here.
 */
export const VISION_ASSISTANT_TOOLS = [
  'screenshot', 'vision_read', 'vision_read_scroll', 'vision_read_zoom', 'vision_read_wait', 'generic_wait',
  'browser_get_page_text', 'interact', 'plan_tool', 'load_skill', 'read_skill_file',
] as const;

const allowed = new Set<string>(VISION_ASSISTANT_TOOLS);
export function isVisionAssistantTool(name: string): boolean { return allowed.has(name); }
export function filterVisionAssistantTools(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(isVisionAssistantTool))];
}

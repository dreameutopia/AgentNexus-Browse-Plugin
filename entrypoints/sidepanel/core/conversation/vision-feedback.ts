import type { ToolResult } from '@/common/tool-handler';
export const VISION_TOOL_SETTLE_DELAY_MS = 3000;

export interface VisionToolImage { callIndex: number; image: string; description: string; kind: 'viewport' | 'region' }
/** Keep image bytes in the multimodal channel, not JSON tool text. */
export function takeVisionToolImage(result: ToolResult, callIndex: number, sourceName?:string): VisionToolImage | null {
  // Arbitrary page/tool JSON must not impersonate an actionable viewport image.
  const producers=['screenshot','vision_read_wait','vision_read_zoom','vision_zoom'];
  if(sourceName!==undefined && !producers.includes(sourceName)) return null;
  const data = result.data;
  if (result.success !== true || !data || typeof data.screenshot !== 'string' ||
      !data.screenshot.startsWith('data:image/png;base64,') || typeof data.text !== 'string') return null;
  const region=sourceName==='vision_zoom' || sourceName==='vision_read_zoom' || data.imageKind==='region';
  return { callIndex, image: data.screenshot, description: data.text, kind: region ? 'region' : 'viewport' };
}
export function withoutVisionImage(result: ToolResult): ToolResult {
  if (!result.data || typeof result.data.screenshot !== 'string') return result;
  const { screenshot: _image, ...data } = result.data;
  return { ...result, data };
}
const noRefreshTools = new Set(['browser_get_page_text', 'browser_get_page_info', 'plan_tool', 'interact',
  'load_skill', 'read_skill_file', 'note_tool', 'data_ref_tool', 'vision_inspect',
  'vision_read', 'vision_read_zoom']);

/** A viewport image is reusable only if no later tool could change the page.
 * Unknown tools and failed screenshot/wait calls conservatively force recovery.
 */
export function needsVisionRefresh(names: string[], images: VisionToolImage[], policy: (name: string) => 'none' | 'after' | undefined): boolean {
  let refresh = false;
  names.forEach((name, index) => {
    if (images.some(image => image.callIndex === index && image.kind === 'viewport')) refresh = false;
    else if (name === 'screenshot' || name === 'vision_read_wait') refresh = true;
    else if (policy(name) === 'after' || (policy(name) !== 'none' && !noRefreshTools.has(name))) refresh = true;
  });
  return refresh;
}

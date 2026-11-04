import type { ToolResult } from '@/common/tool-handler';
import { visionGuiAction, visionGuiRefresh } from '@/tools/vision/gui-contract';
export const VISION_TOOL_SETTLE_DELAY_MS = 3000;

export interface VisionToolImage {
  callIndex: number;
  image: string;
  description: string;
  kind: 'viewport' | 'region';
  /** 已归档的内容哈希引用（视口截图落库后回填；续拍复用，避免重复写库） */
  imageRef?: string;
  /** 已归档图片的 8 位短 id（回答中用 <agent-image id="..." /> 引用） */
  shortId?: string;
}
/** Keep image bytes in the multimodal channel, not JSON tool text. */
export function takeVisionToolImage(result: ToolResult, callIndex: number, sourceName?:string, args?:unknown): VisionToolImage | null {
  // Arbitrary page/tool JSON must not impersonate an actionable viewport image.
  const producers=['screenshot','vision_read_wait','vision_read_zoom'];
  const guiZoom=sourceName==='vision_gui' && visionGuiAction(args)==='zoom';
  if(sourceName!==undefined && !producers.includes(sourceName) && !guiZoom) return null;
  const data = result.data;
  if (result.success !== true || !data || typeof data.screenshot !== 'string' ||
      !data.screenshot.startsWith('data:image/png;base64,') || typeof data.text !== 'string') return null;
  const region=guiZoom || sourceName==='vision_read_zoom' || data.imageKind==='region';
  return { callIndex, image: data.screenshot, description: data.text, kind: region ? 'region' : 'viewport' };
}
export function withoutVisionImage(result: ToolResult): ToolResult {
  if (!result.data || typeof result.data.screenshot !== 'string') return result;
  const { screenshot: _image, ...data } = result.data;
  return { ...result, data };
}
const noRefreshTools = new Set(['browser_get_page_text', 'browser_get_page_info', 'plan_tool', 'interact',
  'load_skill', 'read_skill_file', 'note_tool', 'data_ref_tool',
  'vision_read', 'vision_read_zoom']);

/** A viewport image is reusable only if no later tool could change the page.
 * Unknown tools and failed screenshot/wait calls conservatively force recovery.
 */
type VisionCall = string | { function: { name: string; arguments?: string } };
export function needsVisionRefresh(calls: VisionCall[], images: VisionToolImage[], policy: (name: string) => 'none' | 'after' | undefined): boolean {
  let refresh = false;
  calls.forEach((call, index) => {
    const name=typeof call==='string'?call:call.function.name;
    let args:unknown;
    if(typeof call!=='string') { try { args=JSON.parse(call.function.arguments??''); } catch { /* Recover conservatively. */ } }
    if (images.some(image => image.callIndex === index && image.kind === 'viewport')) refresh = false;
    else if (name === 'screenshot' || name === 'vision_read_wait') refresh = true;
    else if (name === 'vision_gui') { if(visionGuiRefresh(args)==='after') refresh=true; }
    else if (policy(name) === 'after' || (policy(name) !== 'none' && !noRefreshTools.has(name))) refresh = true;
  });
  return refresh;
}

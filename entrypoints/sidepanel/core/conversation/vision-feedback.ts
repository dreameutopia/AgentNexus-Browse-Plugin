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
/**
 * 视觉循环重拍判定（策略单一事实源：ToolMetadata.noVisionRecapture，见 registry.ts）。
 *
 * 判定顺序（每调用顺序扫描，后者可覆盖前者——批次末态即返回值）：
 *   1. 本调用产出了可复用视口图（screenshot / vision_read_wait 成功）→ 复用，
 *      不追加拍摄；
 *   2. screenshot / vision_read_wait 未产出视口图（失败/降级）→ 保守触发
 *      恢复性重拍；
 *   3. vision_gui 按动作判定（gui-contract）：手势与 mark 消耗截图 → 重拍；
 *      inspect/zoom/check 保留源图 → 不重拍；
 *   4. 其余工具由 noRecapture 回调判定：true（纯读豁免）不改变批次状态，
 *      false / 未声明（含未知与插件工具）一律保守重拍。
 *
 * 返回 false 且批次无图片产出时，视觉循环不合成续拍消息——工具结果按文本
 * 执行循环原样回传，截图身份继续有效（纯读不消耗驱动层 snapshot）。
 */
type VisionCall = string | { function: { name: string; arguments?: string } };
export function needsVisionRefresh(calls: VisionCall[], images: VisionToolImage[], noRecapture: (name: string) => boolean | undefined): boolean {
  let refresh = false;
  calls.forEach((call, index) => {
    const name=typeof call==='string'?call:call.function.name;
    let args:unknown;
    if(typeof call!=='string') { try { args=JSON.parse(call.function.arguments??''); } catch { /* Recover conservatively. */ } }
    if (images.some(image => image.callIndex === index && image.kind === 'viewport')) refresh = false;
    else if (name === 'screenshot' || name === 'vision_read_wait') refresh = true;
    else if (name === 'vision_gui') { if(visionGuiRefresh(args)==='after') refresh=true; }
    else if (!noRecapture(name)) refresh = true;
  });
  return refresh;
}

export { captureGuiScreenshot } from '../../tools/vision/gui-driver';
export { cdpSession } from '../../tools/browser/cdp-session';
import { VisionGuiTool } from '../../tools/vision/gui-tool';
import { GuiError } from '../../tools/vision/gui-errors';
import type { GuiAction, GuiParameters } from '../../tools/vision/gui-driver';
export { VisionGuiTool };
const gui = new VisionGuiTool();
export async function executeGui(action:GuiAction,parameters:GuiParameters,signal?:AbortSignal):Promise<any> {
  const result=await gui.execute({action,...parameters},{signal});
  if(!result.success) {
    const d=result.data!.diagnostic;
    throw new GuiError(d.code,d.message,d.details,d.recovery);
  }
  return result.data;
}
export { renderPngCrop } from '../../tools/vision/image-region';
export { planCrop,registerView,mapViewPoint } from '../../tools/vision/observation-model';
// 只读观察已并入 vision_gui（action=read/read_scroll），不再有独立工具可导出

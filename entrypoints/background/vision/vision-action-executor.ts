import { captureGuiScreenshot, executeGui, type GuiAction, type GuiParameters } from '@/tools/vision/gui-driver';
import { GuiError, type GuiErrorCode } from '@/tools/vision/gui-errors';
import { VisionZoomTool, VisionCheckTool, type CheckArgs, type ZoomArgs } from '@/tools/vision/observation-tools';
export class VisionActionExecutor {
  async execute(action: 'screenshot' | 'zoom' | 'check' | GuiAction, parameters?: GuiParameters | CheckArgs | ZoomArgs | Record<string, never>) {
    if (action === 'screenshot') {
      if (parameters !== undefined && (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || Object.keys(parameters).length))
        throw new GuiError('INVALID_ARGUMENT', 'screenshot parameters must be an empty object');
      return captureGuiScreenshot();
    }
    if(action==='zoom' || action==='check') {
      const result=action==='zoom'?await new VisionZoomTool().execute(parameters as ZoomArgs):await new VisionCheckTool().execute(parameters as CheckArgs);
      if(!result.success) {
        const diagnostic=result.data?.diagnostic;
        throw new GuiError((diagnostic?.code??'INTERNAL_ERROR') as GuiErrorCode,diagnostic?.message??result.error??'Observation failed',diagnostic?.details??{},diagnostic?.recovery);
      }
      return result.data;
    }
    if (!parameters || typeof parameters.screenshotId !== 'string') throw new GuiError('INVALID_ARGUMENT', 'screenshotId is required');
    return executeGui(action, parameters as GuiParameters);
  }
}

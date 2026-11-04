import { captureGuiScreenshot, type GuiAction, type GuiParameters } from '@/tools/vision/gui-driver';
import { GuiError, type GuiErrorCode } from '@/tools/vision/gui-errors';
import type { CheckArgs, ZoomArgs } from '@/tools/vision/observation-actions';
import { VisionGuiTool } from '@/tools/vision/gui-tool';
export class VisionActionExecutor {
  private gui = new VisionGuiTool();
  async execute(action: 'screenshot' | 'zoom' | 'check' | GuiAction, parameters?: GuiParameters | CheckArgs | ZoomArgs | Record<string, never>) {
    if (action === 'screenshot') {
      if (parameters !== undefined && (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || Object.keys(parameters).length))
        throw new GuiError('INVALID_ARGUMENT', 'screenshot parameters must be an empty object');
      return captureGuiScreenshot();
    }
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || Object.hasOwn(parameters, 'action'))
      throw new GuiError('INVALID_ARGUMENT', 'parameters must be an object without a nested action');
    const result = await this.gui.execute({action,...parameters});
    if (!result.success) {
      const diagnostic = result.data?.diagnostic;
      throw new GuiError((diagnostic?.code??'INTERNAL_ERROR') as GuiErrorCode,diagnostic?.message??result.error??'GUI action failed',diagnostic?.details??{},diagnostic?.recovery);
    }
    return result.data;
  }
}

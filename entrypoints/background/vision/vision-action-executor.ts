import { captureGuiScreenshot, executeGui, type GuiAction, type GuiParameters } from '@/tools/vision/gui-driver';
import { GuiError } from '@/tools/vision/gui-errors';
export class VisionActionExecutor {
  async execute(action: 'screenshot' | GuiAction, parameters?: GuiParameters | Record<string, never>) {
    if (action === 'screenshot') {
      if (parameters !== undefined && (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || Object.keys(parameters).length))
        throw new GuiError('INVALID_ARGUMENT', 'screenshot parameters must be an empty object');
      return captureGuiScreenshot();
    }
    if (!parameters || typeof parameters.screenshotId !== 'string') throw new GuiError('INVALID_ARGUMENT', 'screenshotId is required');
    return executeGui(action, parameters as GuiParameters);
  }
}

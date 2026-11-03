import { BaseTool } from '../base-tool';
import type { OpenAITool } from '@/common/openai-types';
import type { ToolMetadata, ToolExecutionContext } from '../registry';
import { captureGuiScreenshot } from './gui-driver';
import { guiFailure, GuiError } from './gui-errors';
import { withGuiCancellation } from './gui-cancellation';
export class ScreenshotTool extends BaseTool {
  name = 'screenshot';
  metadata: ToolMetadata = { name: this.name, description: 'Capture unmodified viewport with screenshotId and relative coordinate metadata', category: 'vision', version: '3.0.0', permissions: ['debugger'] };
  openaiSchema: OpenAITool = { type: 'function', function: { name: this.name, description: this.metadata.description, parameters: { type: 'object', properties: {}, required: [] } } };
  async execute(_parameters: Record<string, unknown> = {}, context?: ToolExecutionContext) {
    try {
      if (!_parameters || typeof _parameters !== 'object' || Array.isArray(_parameters) || Object.keys(_parameters).length)
        throw new GuiError('INVALID_ARGUMENT', 'screenshot accepts an empty parameter object');
      const data = await withGuiCancellation(context?.requestId, signal => captureGuiScreenshot(signal), context?.signal);
      const { screenshot: _image, ...metadata } = data;
      // PNG stays in the image channel; never duplicate megabytes of base64 in text content.
      return { success: true, data, content: [{ type: 'text' as const, text: JSON.stringify(metadata) }] };
    }
    catch (error) {
      if (error instanceof Error && error.message.includes('background context')) throw error;
      return guiFailure(error, { action: 'screenshot' });
    }
  }
}
export const screenshotTool = new ScreenshotTool();

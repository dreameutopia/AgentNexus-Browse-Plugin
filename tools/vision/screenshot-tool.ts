import { BaseTool } from '../base-tool';
import type { OpenAITool } from '@/common/openai-types';
import type { ToolMetadata, ToolExecutionContext } from '../registry';
import { captureGuiScreenshot } from './gui-driver';
import { guiFailure, GuiError } from './gui-errors';
import { withGuiCancellation } from './gui-cancellation';
export class ScreenshotTool extends BaseTool {
  name = 'screenshot';
  metadata: ToolMetadata = { name: this.name, description: 'Capture viewport: action (default) uses a retained debugger session; observe uses visible-tab capture without attaching debugger and cannot authorize input.', category: 'vision', version: '3.1.0', permissions: ['scripting'], visionRefresh: 'none' };
  openaiSchema: OpenAITool = { type: 'function', function: { name: this.name, description: this.metadata.description, parameters: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', enum: ['action','observe'], default: 'action' } }, required: [] } } };
  async execute(_parameters: Record<string, unknown> = {}, context?: ToolExecutionContext) {
    try {
      if (!_parameters || typeof _parameters !== 'object' || Array.isArray(_parameters) ||
          Object.keys(_parameters).some(key => key !== 'mode') ||
          (_parameters.mode !== undefined && !['action','observe'].includes(_parameters.mode as string)))
        throw new GuiError('INVALID_ARGUMENT', 'screenshot accepts only optional mode=action|observe');
      const mode = _parameters.mode === 'observe' ? 'observe' : 'action';
      const data = await withGuiCancellation(context?.requestId, signal => captureGuiScreenshot(signal, mode), context?.signal);
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

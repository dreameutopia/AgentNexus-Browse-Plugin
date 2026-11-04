import { BaseTool } from '../base-tool';
import type { OpenAITool } from '@/common/openai-types';
import type { ToolMetadata, ToolExecutionContext } from '../registry';
import { captureGuiScreenshot } from './gui-driver';
import { guiFailure, GuiError } from './gui-errors';
import { withGuiCancellation } from './gui-cancellation';
export class ScreenshotTool extends BaseTool {
  name = 'screenshot';
  metadata: ToolMetadata = {
    name: this.name,
    description:
      'Capture the viewport and archive it. action (default) uses a retained debugger session; observe uses visible-tab capture without attaching debugger and cannot authorize input. The capture is stored with the session and comes back with an 8-char imageId (e.g. a1b2c3d4): to show that exact screenshot to the user inside your final answer write <agent-image id="a1b2c3d4" alt="caption" />, replacing the id with the one this tool returned — the renderer turns it back into the image. Use it when the user should see a specific screen state (final result, error dialog, verification outcome); do not archive every step.',
    category: 'vision',
    version: '4.0.0',
    permissions: ['scripting'],
    visionRefresh: 'none',
  };
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

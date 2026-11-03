import { BaseTool } from '../base-tool';
import type { OpenAITool } from '@/common/openai-types';
import type { ToolMetadata, ToolExecutionContext } from '../registry';
import { executeGui, GUI_ACTIONS, type GuiAction, type GuiParameters } from './gui-driver';
import { guiFailure } from './gui-errors';
import { withGuiCancellation } from './gui-cancellation';

const point = { type: 'object', additionalProperties: false, properties: {
  x: { type: 'number', minimum: 0, maximum: 1000 }, y: { type: 'number', minimum: 0, maximum: 1000 },
}, required: ['x', 'y'], description: 'Point relative to entire latest screenshot, x from left, y from top; 0..1000, NOT pixels.' };
const definitions: Record<GuiAction, { description: string; properties: Record<string, any>; required: string[] }> = {
  click: { description: 'Browser input click: left/right single/double/triple click.', properties: {
    point, button: { type: 'string', enum: ['left', 'right'], default: 'left' }, count: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
  }, required: ['point'] },
  drag: { description: 'Drag precise relative start to end with held-button pauses and humanlike nonuniform trajectory.', properties: { from: point, to: point }, required: ['from', 'to'] },
  scroll: { description: 'Move cursor to optional point (recommended: inside target component), then smooth wheel input. Percent uses viewport height/width, not document size. Browser routes wheel to hovered component. Omitted point uses viewport center.', properties: {
    point, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, percent: { type: 'number', minimum: 1, maximum: 300 },
  }, required: ['direction', 'percent'] },
  input: { description: 'Type Unicode text at relative input point with humanlike timing. Optionally click first and clear focused input. Does not submit automatically.', properties: {
    point, text: { type: 'string', maxLength: 10000 }, clickFirst: { type: 'boolean', default: true }, clear: { type: 'boolean', default: false },
  }, required: ['point', 'text'] },
  hover: { description: 'Hover relative point to expose menus/tooltips; durationMs controls dwell.', properties: { point }, required: ['point'] },
  keyboard: { description: 'Press/release key chord: Control, Shift, Alt, Meta, Enter, Tab, Escape, Backspace, Delete, ArrowLeft/Up/Right/Down, Home, End, PageUp/PageDown, Space, a-z, 0-9. Example ["Control","a"].', properties: {
    keys: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
  }, required: ['keys'] },
  mark: { description: 'Queue DOM numbered boxes for NEXT automatic screenshot only. Use new screenshotId and vision_inspect for selector/XPath/attributes. Canvas pixels may have no DOM marks.', properties: {}, required: [] },
  inspect: { description: 'Read numbered element: frameId, scoped CSS selector/XPath, shadow hosts, attributes, text, rect, editable/disabled/checked state, select options, ancestry. IDs are inspection-only; interact using coordinates.', properties: {
    id: { type: 'integer', minimum: 1 },
  }, required: ['id'] },
};
export class GuiTool extends BaseTool {
  name: string;
  metadata: ToolMetadata;
  openaiSchema: OpenAITool;
  constructor(private action: GuiAction) {
    super();
    const d = definitions[action]; this.name = `vision_${action}`;
    this.metadata = { name: this.name, description: d.description, category: 'vision', version: '3.0.0', permissions: ['debugger', 'scripting'], requiresConfirm: !['mark', 'inspect', 'hover'].includes(action) };
    this.openaiSchema = { type: 'function', function: { name: this.name,
      description: d.description + ' Use latest screenshotId. For irreversible actions set confirm=true and describe intent.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        screenshotId: { type: 'string', description: 'Exact latest screenshotId. One screenshot per gesture; never reuse after action.' },
        ...d.properties,
        ...(['drag', 'hover', 'scroll'].includes(action) ? { durationMs: { type: 'number', minimum: 200, maximum: 3000 } } : {}),
        description: { type: 'string', maxLength: 2000 }, confirm: { type: 'boolean', default: false },
      }, required: ['screenshotId', ...d.required] } } };
  }
  async execute(params: GuiParameters, context?: ToolExecutionContext) {
    try { return this.createSuccessResponse(await withGuiCancellation(context?.requestId,
      signal => executeGui(this.action, params, signal), context?.signal)); }
    catch (error) {
      if (error instanceof Error && error.message.includes('background context')) throw error;
      return guiFailure(error, { action: this.action, screenshotId: params?.screenshotId });
    }
  }
}
export { GUI_ACTIONS };
export function createGuiTools() { return GUI_ACTIONS.map(action => new GuiTool(action)); }

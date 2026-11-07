import { BaseTool } from '../base-tool';
import type { ToolMetadata, ToolExecutionContext } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { withReadSnapshot, captureGuiScreenshot } from './gui-driver';
import { relativePoint, toViewport, finiteRange, type RelativePoint } from './coordinates';
import { bounded, GuiError, guiFailure } from './gui-errors';
import { withGuiCancellation } from './gui-cancellation';
import { visionReadPayload } from './read-payload';
import { cropOriginalImage } from './image-region';

type Region = { x: number; y: number; width: number; height: number };
type ReadArgs = { screenshotId?: string; point?: RelativePoint; region?: Region; direction?: 'up'|'down'|'left'|'right'; percent?: number; timeoutMs?: number; scale?: number };
const pointSchema = { type: 'object', additionalProperties: false, properties: {
  x: { type: 'number', minimum: 0, maximum: 1000 }, y: { type: 'number', minimum: 0, maximum: 1000 },
}, required: ['x', 'y'], description: 'Position in the entire original viewport screenshot, x/y 0..1000; never use zoom-image coordinates.' };
const regionSchema = { type: 'object', additionalProperties: false, properties: {
  x: { type: 'number', minimum: 0, maximum: 1000 }, y: { type: 'number', minimum: 0, maximum: 1000 },
  width: { type: 'number', exclusiveMinimum: 0, maximum: 1000 }, height: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
}, required: ['x', 'y', 'width', 'height'], description: 'Rectangle in original full screenshot coordinates 0..1000; x+width and y+height must be <=1000.' };

export function validateReadArgs(action: string, raw: unknown): ReadArgs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GuiError('INVALID_ARGUMENT', 'Arguments must be an object');
  const args = raw as ReadArgs;
  const keys: Record<string, string[]> = {
    read: ['screenshotId','point','region'], scroll: ['screenshotId','point','direction','percent'],
    zoom: ['screenshotId','region','scale'], wait: ['timeoutMs'],
  };
  if (!Object.hasOwn(keys, action) || Object.keys(raw).some(k => !keys[action].includes(k))) throw new GuiError('INVALID_ARGUMENT', 'Unsupported observation argument; scripts, clicks, modifiers and tab selection are not supported');
  if (action !== 'wait' && (typeof args.screenshotId !== 'string' || !args.screenshotId || args.screenshotId.length > 128)) throw new GuiError('INVALID_ARGUMENT', 'Latest screenshotId is required');
  if (args.point !== undefined) relativePoint(args.point);
  if (args.region !== undefined) {
    const r = args.region;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['x','y','width','height'].includes(k))) throw new GuiError('INVALID_ARGUMENT', 'Invalid region');
    finiteRange(r.x, 'region.x', 0, 1000); finiteRange(r.y, 'region.y', 0, 1000);
    finiteRange(r.width, 'region.width', 0.1, 1000); finiteRange(r.height, 'region.height', 0.1, 1000);
    if (r.x + r.width > 1000 || r.y + r.height > 1000) throw new GuiError('INVALID_ARGUMENT', 'Region extends outside original viewport');
  }
  if (args.point && args.region) throw new GuiError('INVALID_ARGUMENT', 'Choose point OR region');
  if (action === 'scroll') {
    if (!['up','down','left','right'].includes(args.direction!)) throw new GuiError('INVALID_ARGUMENT', 'Invalid scroll direction');
    if (args.percent !== undefined) finiteRange(args.percent, 'percent', 1, 100);
  }
  if (action === 'zoom' && !args.region) throw new GuiError('INVALID_ARGUMENT', 'Zoom requires region');
  if (args.scale !== undefined) finiteRange(args.scale, 'scale', 1, 3);
  if (args.timeoutMs !== undefined) finiteRange(args.timeoutMs, 'timeoutMs', 300, 5000);
  return structuredClone(args);
}

const definitions = {
  read: { name: 'vision_read', description: 'Read bounded visible DOM text and control states from current screenshot scope. Optional region or point (point reads target plus up to 4 ancestors). No values, script execution or actions. DOM is supplementary evidence, may differ from image; iframe interiors/Canvas/closed shadow DOM and occlusion have incomplete coverage.',
    properties: { point: pointSchema, region: regionSchema } },
  scroll: { name: 'vision_read_scroll', description: 'Scroll for reading only, without clicking/focusing/hovering or sending keys/wheel. Optional point targets the nearest scrollable component (same-origin iframe supported); omit to scroll document. Four directions, percent 1..100 of target container. Reports actual displacement. Source screenshot is consumed even on failure; observe next automatic screenshot. At container edge it never scrolls a parent instead.',
    properties: { point: pointSchema, direction: { type: 'string', enum: ['up','down','left','right'] }, percent: { type: 'number', minimum: 1, maximum: 100, default: 75 } } },
  zoom: { name: 'vision_read_zoom', description: 'Crop and enlarge a region of the ORIGINAL latest screenshot, without changing browser zoom/layout. Zoom image is reading evidence only, is NOT a new actionable screenshot and must never supply GUI coordinates. Cannot restore detail missing from source.',
    properties: { region: regionSchema, scale: { type: 'number', minimum: 1, maximum: 3, default: 2 } } },
  wait: { name: 'vision_read_wait', description: 'Wait up to timeoutMs (300..5000), sample document readiness and viewport/scroll dimensions, then return a fresh full screenshot. Stops if active tab/document changes. Stable geometry does NOT guarantee content/network/animations are finished. Use after user action/loading; do not poll indefinitely.',
    properties: { timeoutMs: { type: 'number', minimum: 300, maximum: 5000, default: 1500 } } },
} as const;

export class VisionReadTool extends BaseTool {
  name: string;
  metadata: ToolMetadata;
  openaiSchema: OpenAITool;
  constructor(private action: keyof typeof definitions) {
    super();
    const d = definitions[action]; this.name = d.name;
    this.metadata = { name: this.name, description: d.description, category: 'vision', version: '1.0.0',
      permissions: ['debugger','scripting'],
      // read/zoom 纯读不消耗源截图（zoom 产出区域图仅作阅读证据）；
      // scroll 滚动改视口必须重拍；wait 走名单特例（成功复用产出图/失败恢复重拍）
      noVisionRecapture: action === 'read' || action === 'zoom' };
    this.openaiSchema = { type: 'function', function: { name: this.name, description: d.description,
      parameters: { type: 'object', additionalProperties: false, properties: {
        ...(action !== 'wait' ? { screenshotId: { type: 'string', maxLength: 128 } } : {}), ...d.properties,
      }, required: [...(action !== 'wait' ? ['screenshotId'] : []), ...(action === 'scroll' ? ['direction'] : action === 'zoom' ? ['region'] : [])] } } };
  }
  async execute(raw: ReadArgs = {}, context?: ToolExecutionContext) {
    try {
      const args = validateReadArgs(this.action, raw);
      const data = await withGuiCancellation(context?.requestId, async signal => {
        if (this.action === 'wait') return this.wait(args.timeoutMs ?? 1500, signal);
        return withReadSnapshot(args.screenshotId, this.action === 'scroll', signal, async (s, image) => {
          if (this.action === 'zoom') {
            const cropped = await cropOriginalImage(image, args.region!, args.scale ?? 2);
            return { ...cropped, sourceScreenshotId: s.id, imageKind: 'region', requestedRegion: args.region,
              text: `Reading-only zoom from screenshotId=${s.id}. Actual pixel-aligned region=${JSON.stringify(cropped.region)} in ORIGINAL 0..1000 coordinates. This cropped image has no actionable screenshotId. Do not use crop coordinates for tools.` };
          }
          const r = args.region;
          const results = await bounded(chrome.scripting.executeScript({ target: { tabId: s.tabId, frameIds: [0] }, world: 'ISOLATED',
            func: visionReadPayload, args: [this.action === 'scroll' ? 'scroll' : 'read', { point: args.point ? toViewport(args.point, s.viewport) : undefined,
              region: r ? { x: r.x / 1000 * s.viewport.width, y: r.y / 1000 * s.viewport.height, width: r.width / 1000 * s.viewport.width, height: r.height / 1000 * s.viewport.height } : undefined,
              direction: args.direction, percent: args.percent }] }), 2500, 'Read-only page observation');
          if (!results[0]?.result) throw new GuiError('TARGET_UNAVAILABLE', 'Observation returned no data');
          return { ...results[0].result, sourceScreenshotId: s.id, observedAt: Date.now() };
        });
      }, context?.signal);
      const { screenshot: _image, ...metadata } = data as typeof data & { screenshot?: string };
      return { success: true, data, content: [{ type: 'text' as const, text: JSON.stringify(metadata) }] };
    } catch (error) {
      if (error instanceof Error && error.message.includes('background context')) throw error;
      return guiFailure(error, { action: this.name, screenshotId: raw?.screenshotId });
    }
  }
  private async wait(timeoutMs: number, signal?: AbortSignal) {
    const initial = await captureGuiScreenshot(signal, 'observe');
    const start = Date.now();
    let previous = '', stable = 0;
    // Serialize readiness samples, but do not capture inside the same lock.
    // Consuming the initial ID also permits user scrolling during the wait.
    await withReadSnapshot(initial.screenshotId, true, signal, async (s, _image, guard) => {
      while (Date.now() - start < timeoutMs) {
        await guard();
        const rows = await bounded(chrome.scripting.executeScript({ target: { tabId: s.tabId, frameIds: [0] }, world: 'ISOLATED', func: visionReadPayload, args: ['probe', {}] }), 1000, 'Observe readiness');
        const sample = rows[0]?.result;
        if (!sample || !('readyState' in sample)) throw new GuiError('TARGET_UNAVAILABLE', 'Readiness sample unavailable');
        const key = JSON.stringify(sample);
        stable = sample.readyState === 'complete' && key === previous ? stable + 1 : 0;
        previous = key;
        if (stable >= 2) break;
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, Math.max(0, Math.min(150, timeoutMs - (Date.now() - start))));
          signal?.addEventListener('abort', finish, { once: true });
          if (signal?.aborted) finish();
        });
      }
    });
    const fresh = await captureGuiScreenshot(signal, 'observe');
    if (fresh.tabId !== initial.tabId || fresh.url !== initial.url || fresh.documentId !== initial.documentId)
      throw new GuiError('STALE_SCREENSHOT', 'Target changed while waiting; capture again');
    return { ...fresh, imageKind: 'viewport', geometryStable: stable >= 2, waitedMs: Date.now() - start,
      waitBudgetMs: timeoutMs, hint: 'Wait budget excludes browser transport and screenshots. Geometry stability is not content or network stability.' };
  }
}

export function createVisionReadTools() { return (Object.keys(definitions) as (keyof typeof definitions)[]).map(action => new VisionReadTool(action)); }

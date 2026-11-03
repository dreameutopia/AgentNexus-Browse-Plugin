import { cdpSession } from '../browser/cdp-session';
import { finiteRange, motionPath, relativePoint, toViewport, pngDimensions, verifyScreenshotGeometry, sameViewport, type RelativePoint, type Viewport } from './coordinates';
import { annotationPayload, focusedEditablePayload } from './dom-inspection';
import { bounded, GuiError, withGuiCleanup } from './gui-errors';

export type GuiAction = 'click' | 'drag' | 'scroll' | 'input' | 'hover' | 'keyboard' | 'mark' | 'inspect';
export const GUI_ACTIONS: readonly GuiAction[] = ['click', 'drag', 'scroll', 'input', 'hover', 'keyboard', 'mark', 'inspect'];
export interface GuiParameters {
  screenshotId: string;
  point?: RelativePoint;
  from?: RelativePoint;
  to?: RelativePoint;
  button?: 'left' | 'right';
  count?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  percent?: number;
  text?: string;
  clickFirst?: boolean;
  clear?: boolean;
  keys?: string[];
  durationMs?: number;
  id?: number;
  confirm?: boolean;
  description?: string;
}
interface Snapshot {
  id: string; tabId: number; url: string; documentId: string; debuggerEpoch: number; viewport: Viewport; time: number;
  marks: { id: number; frameId: number; index: number }[];
}
const snapshots = new Map<number, Snapshot>();
const pendingMarks = new Map<number, Snapshot>();
const quarantinedTabs = new Set<number>();
// Serialize entire gestures and captures, including separate chats and WebSocket callers.
let tail: Promise<unknown> = Promise.resolve();
export function exclusiveGui<T>(work: () => Promise<T>): Promise<T> {
  const enqueued = Date.now();
  const execute = () => {
    if (Date.now() - enqueued > 30000) throw new GuiError('TIMEOUT', 'GUI request expired in the execution queue', { phase: 'queue' });
    return work();
  };
  const result = tail.then(execute, execute);
  tail = result.catch(() => undefined);
  return result;
}
const pause = (min: number, max = min) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
async function activeTab() {
  if (typeof document !== 'undefined' || typeof chrome === 'undefined' || !chrome.debugger) throw new GuiError('UNSUPPORTED_CONTEXT', 'GUI tools require background context with chrome.debugger');
  const [tab] = await bounded(chrome.tabs.query({ active: true, currentWindow: true }), 5000, 'Query active tab');
  if (!Number.isInteger(tab?.id) || !tab.url || !/^(https?:|file:)/.test(tab.url)) throw new GuiError('TARGET_UNAVAILABLE', 'Select a supported http/https/file tab');
  return tab as chrome.tabs.Tab & { id: number; url: string };
}
async function command<T = any>(tabId: number, method: string, params: object = {}): Promise<T> {
  try {
    if (method.startsWith('Input.')) {
      if (!cdpSession.hasSession(tabId)) throw new GuiError('STALE_SCREENSHOT', 'Debugger detached before input; capture again');
    } else await bounded(cdpSession.attach(tabId), 5000, 'Attach debugger');
    return await bounded(chrome.debugger.sendCommand({ tabId }, method, params), 8000, method) as T;
  } catch (error) {
    if (error instanceof GuiError) {
      if (error.code === 'TIMEOUT') { quarantinedTabs.add(tabId); snapshots.delete(tabId); }
      throw error;
    }
    throw new GuiError('TRANSPORT_ERROR', `${method}: ${error instanceof Error ? error.message : String(error)}`, { method, tabId, outcomeUncertain: method.startsWith('Input.') });
  }
}
async function viewport(tabId: number): Promise<Viewport> {
  const result = await command(tabId, 'Page.getLayoutMetrics');
  const v = result.cssVisualViewport;
  if (!v || !Number.isFinite(v.clientWidth) || !Number.isFinite(v.clientHeight) || !Number.isFinite(v.scale)) throw new GuiError('GEOMETRY_CHANGED', 'CSS viewport metrics unavailable');
  // Pinch zoom offsets require a separate device adapter. Fail rather than click a wrong target.
  if (Math.abs(v.scale - 1) > 0.001 || v.offsetX || v.offsetY) throw new GuiError('GEOMETRY_CHANGED', 'Reset pinch zoom before GUI automation', { visualViewport: v });
  const frames = await bounded(chrome.scripting.executeScript({ target: { tabId, frameIds: [0] },
    func: () => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio,
      pageX: window.scrollX, pageY: window.scrollY }) }), 5000, 'Read full viewport');
  const full = frames[0]?.result;
  if (!full) throw new GuiError('GEOMETRY_CHANGED', 'Full viewport measurement unavailable');
  for (const key of ['width', 'height', 'devicePixelRatio', 'pageX', 'pageY'] as const)
    if (!Number.isFinite(full[key])) throw new GuiError('GEOMETRY_CHANGED', `Invalid viewport ${key}`);
  finiteRange(full.width, 'viewport width', 1, 32768); finiteRange(full.height, 'viewport height', 1, 32768);
  finiteRange(full.devicePixelRatio, 'devicePixelRatio', 0.1, 16);
  if (Math.abs(full.pageX - v.pageX) > 0.1 || Math.abs(full.pageY - v.pageY) > 0.1)
    throw new GuiError('GEOMETRY_CHANGED', 'Page scrolled while measuring the viewport');
  return { ...full, scale: v.scale, contentWidth: v.clientWidth, contentHeight: v.clientHeight, zoom: v.zoom ?? 1 };
}
async function ensureEditable(tabId: number, token: string, remember = false) {
  const frames = await bounded(chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: focusedEditablePayload, args: [token, remember] }), 5000, 'Check input focus');
  if (!frames.some(f => f.result === true)) throw new GuiError('FOCUS_CHANGED', 'No editable focused target; input stopped');
}
async function checkedSnapshot(id: unknown): Promise<Snapshot> {
  if (typeof id !== 'string' || !id || id.length > 128) throw new GuiError('INVALID_ARGUMENT', 'screenshotId is required; use the latest screenshot');
  const tab = await activeTab(), s = snapshots.get(tab.id);
  if (!s || s.id !== id || s.url !== tab.url || Date.now() - s.time > 120000) throw new GuiError('STALE_SCREENSHOT', 'Screenshot expired or tab changed; capture again', { tabId: tab.id, screenshotId: id });
  const v = await viewport(tab.id);
  if (cdpSession.getEpoch(tab.id) !== s.debuggerEpoch) throw new GuiError('STALE_SCREENSHOT', 'Debugger session changed; capture again');
  const tree = await command(tab.id, 'Page.getFrameTree');
  if (tree?.frameTree?.frame?.loaderId !== s.documentId) throw new GuiError('STALE_SCREENSHOT', 'Document reloaded; capture again');
  if (!sameViewport(v, s.viewport)) throw new GuiError('GEOMETRY_CHANGED', 'Viewport/scroll changed; capture again', { captured: s.viewport, current: v });
  return s;
}
function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GuiError('CANCELLED', 'GUI request cancelled; no further input will be dispatched', { outcomeUncertain: true });
}
export async function captureGuiScreenshot(signal?: AbortSignal) {
  return exclusiveGui(async () => {
    checkCancellation(signal);
    const captureDeadline = Date.now() + 15000;
    const checkCapture = () => {
      checkCancellation(signal);
      if (Date.now() > captureDeadline) throw new GuiError('TIMEOUT', 'Screenshot transaction exceeded 15 seconds', { phase: 'capture' });
    };
    const tab = await activeTab();
    snapshots.delete(tab.id);
    if (quarantinedTabs.has(tab.id)) {
      await bounded(cdpSession.detach(tab.id), 5000, 'Reset uncertain debugger session');
      quarantinedTabs.delete(tab.id);
    }
    const before = await viewport(tab.id);
    const documentId = (await command(tab.id, 'Page.getFrameTree'))?.frameTree?.frame?.loaderId;
    if (typeof documentId !== 'string' || !documentId) throw new GuiError('TARGET_UNAVAILABLE', 'Main frame document ID unavailable');
    const id = crypto.randomUUID();
    const marks: Snapshot['marks'] = [];
    const requested = pendingMarks.get(tab.id);
    if (requested && (requested.url !== tab.url || requested.documentId !== documentId || !sameViewport(requested.viewport, before))) {
      pendingMarks.delete(tab.id);
      throw new GuiError('ANNOTATION_ERROR', 'Page changed after annotation request; capture again and request marks');
    }
    return withGuiCleanup(async () => {
      if (requested) {
        const frames = await bounded(chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: annotationPayload, args: ['collect', id] }), 5000, 'Collect annotations');
        for (const frame of frames) {
          checkCapture();
          const count = frame.result;
          if (!Number.isInteger(count) || count < 0 || count > 500 || marks.length + count > 10000) throw new GuiError('ANNOTATION_ERROR', 'Invalid or excessive annotation result', { frameId: frame.frameId, count });
          const ids = Array.from({ length: count }, (_, index) => {
            const mark = { id: marks.length + 1, frameId: frame.frameId, index };
            marks.push(mark); return mark.id;
          });
          await bounded(chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frame.frameId] }, func: annotationPayload, args: ['draw', id, ids] }), 5000, 'Draw annotations');
        }
        await pause(80);
      }
      checkCapture();
      const image = await command(tab.id, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      const after = await viewport(tab.id), current = await activeTab();
      if (current.id !== tab.id || current.url !== tab.url || !sameViewport(before, after) ||
        (await command(tab.id, 'Page.getFrameTree'))?.frameTree?.frame?.loaderId !== documentId) throw new GuiError('GEOMETRY_CHANGED', 'Page moved during capture; retry', { before, after });
      const imageSize = pngDimensions(image?.data);
      verifyScreenshotGeometry(imageSize, after);
      checkCapture();
      const snapshot: Snapshot = { id, tabId: tab.id, url: tab.url, documentId, debuggerEpoch: cdpSession.getEpoch(tab.id), viewport: after, time: Date.now(), marks };
      snapshots.set(tab.id, snapshot);
      if (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value!);
      if (requested) pendingMarks.delete(tab.id);
      return { screenshot: `data:image/png;base64,${image.data}`, screenshotId: id, tabId: tab.id,
        viewport: after, imageSize, coordinateSystem: 'full screenshot x/y 0..1000', elementsCount: marks.length,
        text: `screenshotId=${id}; coordinates: x/y 0..1000 relative to this ENTIRE uncropped image INCLUDING scrollbar gutters; CSS viewport ${after.width}×${after.height}, PNG ${imageSize.width}×${imageSize.height}, DPR=${after.devicePixelRatio}. Do not add page scroll offsets or multiply by DPR. ${requested ? `${marks.length} numbered marks; use vision_inspect(screenshotId,id) to inspect, coordinates to act.` : 'No element marks.'}` };
    }, async () => {
      if (requested) {
        try { await bounded(chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: annotationPayload, args: ['clear', id] }), 5000, 'Remove annotations'); }
        catch (error) {
          snapshots.delete(tab.id); pendingMarks.delete(tab.id);
          throw new GuiError('CLEANUP_FAILED', 'Annotation removal failed; screenshot was not published as usable', { cause: error instanceof Error ? error.message : String(error), tabId: tab.id });
        }
      }
    });
  });
}

function validate(action: GuiAction, p: GuiParameters) {
  if (!GUI_ACTIONS.includes(action)) throw new GuiError('INVALID_ARGUMENT', `Unsupported GUI action: ${String(action)}`);
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Parameters must be an object');
  const specific: Record<GuiAction, string[]> = {
    click: ['point','button','count'], drag: ['from','to','durationMs'], scroll: ['point','direction','percent','durationMs'],
    input: ['point','text','clickFirst','clear'], hover: ['point','durationMs'], keyboard: ['keys'], mark: [], inspect: ['id'],
  };
  const allowed = new Set(['screenshotId','confirm','description', ...specific[action]]);
  const unknown = Object.keys(p).filter(k => !allowed.has(k));
  if (unknown.length) throw new GuiError('INVALID_ARGUMENT', `Unexpected parameters for ${action}: ${unknown.join(', ')}`, { fields: unknown });
  if (typeof p.screenshotId !== 'string' || !p.screenshotId || p.screenshotId.length > 128) throw new GuiError('INVALID_ARGUMENT', 'screenshotId must be a nonempty string of at most 128 characters');
  if (p.description !== undefined && (typeof p.description !== 'string' || p.description.length > 2000)) throw new GuiError('INVALID_ARGUMENT', 'description must be a string of at most 2000 characters');
  for (const key of ['clickFirst', 'clear', 'confirm'] as const) if (p[key] !== undefined && typeof p[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  if (['click', 'input', 'hover'].includes(action)) relativePoint(p.point);
  if (action === 'drag') { relativePoint(p.from); relativePoint(p.to); }
  if (p.point !== undefined) relativePoint(p.point);
  if (p.durationMs !== undefined) finiteRange(p.durationMs, 'durationMs', 200, 3000);
  if (action === 'click') {
    if (p.count === null || p.button === null) throw new GuiError('INVALID_ARGUMENT', 'count/button cannot be null');
    if (p.button !== undefined && !['left', 'right'].includes(p.button)) throw new Error('button must be left or right');
    if (!Number.isInteger(p.count ?? 1)) throw new Error('count must be integer');
    finiteRange(p.count ?? 1, 'count', 1, 3);
  }
  if (action === 'scroll') {
    if (!['up', 'down', 'left', 'right'].includes(p.direction!)) throw new Error('direction is required');
    finiteRange(p.percent, 'percent', 1, 300);
  }
  if (action === 'input' && (typeof p.text !== 'string' || p.text.length > 10000)) throw new Error('text requires a string of at most 10000 UTF-16 units');
  if (action === 'inspect' && (!Number.isSafeInteger(p.id) || p.id! < 1)) throw new Error('id must be a positive integer');
  if (action === 'keyboard') parseKeys(p.keys);
}
const keyMap: Record<string, [string, string, number]> = {
  Enter: ['Enter', 'Enter', 13], Tab: ['Tab', 'Tab', 9], Escape: ['Escape', 'Escape', 27],
  Backspace: ['Backspace', 'Backspace', 8], Delete: ['Delete', 'Delete', 46],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowRight: ['ArrowRight', 'ArrowRight', 39], ArrowDown: ['ArrowDown', 'ArrowDown', 40],
  Home: ['Home', 'Home', 36], End: ['End', 'End', 35], PageUp: ['PageUp', 'PageUp', 33], PageDown: ['PageDown', 'PageDown', 34], Space: [' ', 'Space', 32],
  Control: ['Control', 'ControlLeft', 17], Shift: ['Shift', 'ShiftLeft', 16], Alt: ['Alt', 'AltLeft', 18], Meta: ['Meta', 'MetaLeft', 91],
};
function parseKeys(keys: unknown): { key: string; code: string; windowsVirtualKeyCode: number; modifier: number }[] {
  if (!Array.isArray(keys) || !keys.length || keys.length > 5 || keys.some(k => typeof k !== 'string')) throw new Error('keys requires 1..5 key names');
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate key');
  return keys.map(k => {
    const v = (Object.hasOwn(keyMap, k) ? keyMap[k] : undefined) ?? (/^[a-z0-9]$/i.test(k) ? [k, /[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : `Digit${k}`, k.toUpperCase().charCodeAt(0)] : undefined);
    if (!v) throw new Error(`Unsupported key: ${k}`);
    return { key: v[0] as string, code: v[1] as string, windowsVirtualKeyCode: v[2] as number,
      modifier: ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 } as Record<string, number>)[k] ?? 0 };
  }).sort((a, b) => Number(!!b.modifier) - Number(!!a.modifier));
}
async function keyboard(tabId: number, keys: string[], guard: () => Promise<void>) {
  const parsed = parseKeys(keys), held: typeof parsed = [];
  let modifiers = 0;
  return withGuiCleanup(async () => {
    for (const k of parsed) {
      await guard();
      modifiers |= k.modifier; held.push(k);
      const text = k.key.length === 1 && !(modifiers & ~8) ? ((modifiers & 8) ? k.key.toUpperCase() : k.key) : k.key === 'Enter' && !(modifiers & ~8) ? '\r' : undefined;
      await command(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: text?.length === 1 && k.key.length === 1 ? text : k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, modifiers,
        ...(text !== undefined ? { text, unmodifiedText: k.key } : {}) });
    }
    await pause(40, 90);
  }, async () => {
    const failed: string[] = [];
    for (const k of held.reverse()) {
      modifiers &= ~k.modifier;
      try { await bounded(chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, modifiers }), 3000, 'Release key'); }
      catch { failed.push(k.code); }
    }
    if (failed.length) {
      quarantinedTabs.add(tabId);
      throw new GuiError('CLEANUP_FAILED', 'Could not confirm keyboard release', { tabId, keys: failed, outcomeUncertain: true });
    }
  });
}
export async function executeGui(action: GuiAction, p: GuiParameters, signal?: AbortSignal) {
  try { validate(action, p); }
  catch (error) { if (error instanceof GuiError) throw error; throw new GuiError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error), { action }); }
  // A caller must not mutate queued coordinates/text after validation.
  p = structuredClone(p);
  return exclusiveGui(async () => {
    checkCancellation(signal);
    const s = await checkedSnapshot(p.screenshotId), tabId = s.tabId;
    checkCancellation(signal);
    if (action === 'mark') {
      pendingMarks.set(tabId, s);
      if (pendingMarks.size > 32) pendingMarks.delete(pendingMarks.keys().next().value!);
      return { text: 'Numbered marks queued for the next automatic screenshot. Inspect them using that new screenshotId.' };
    }
    if (action === 'inspect') {
      const mark = s.marks.find(m => m.id === p.id);
      if (!mark) throw new GuiError('ANNOTATION_ERROR', 'ID is absent from this screenshot; request vision_mark first', { id: p.id });
      const result = await bounded(chrome.scripting.executeScript({ target: { tabId, frameIds: [mark.frameId] }, func: annotationPayload, args: ['inspect', s.id, [], mark.index] }), 5000, 'Inspect marked element');
      if (!result[0]?.result) throw new GuiError('ANNOTATION_ERROR', 'Frame or element disappeared');
      return { ...result[0].result, frameId: mark.frameId, screenshotId: s.id };
    }
    // Consume before side effects: a failed gesture may have partially changed the page.
    snapshots.delete(tabId);
    const deadline = Date.now() + 20000;
    let lastCheck = 0;
    let inputStarted = false;
    const progress = { completedClicks: 0, insertedUtf16Units: 0, scrollDeltaX: 0, scrollDeltaY: 0, dragPhase: 'not-started' };
    const ensureTarget = async (force = false) => {
      checkCancellation(signal);
      if (Date.now() > deadline) throw new GuiError('TIMEOUT', 'Gesture time budget exceeded; action may be partial, inspect screenshot', { action, outcomeUncertain: true });
      if (!force && Date.now() - lastCheck < 200) return;
      lastCheck = Date.now();
      const tab = await activeTab();
      if (!cdpSession.hasSession(tabId) || cdpSession.getEpoch(tabId) !== s.debuggerEpoch)
        throw new GuiError('STALE_SCREENSHOT', 'Debugger session detached or changed during gesture');
      if (tab.id !== tabId || tab.url !== s.url || (await command(tabId, 'Page.getFrameTree'))?.frameTree?.frame?.loaderId !== s.documentId)
        throw new GuiError('STALE_SCREENSHOT', 'Target changed during gesture; stopped', { action, outcomeUncertain: true });
      // Resize/zoom must stop ongoing gestures too; intentional wheel/drag scrolling may change pageX/Y.
      const current = await viewport(tabId);
      if (!sameViewport({ ...current, pageX: s.viewport.pageX, pageY: s.viewport.pageY }, s.viewport))
        throw new GuiError('GEOMETRY_CHANGED', 'Viewport resized or zoom changed during gesture', { captured: s.viewport, current });
      if (inputStarted) await ensureEditable(tabId, s.id);
    };
    let heldButton: 'left' | 'right' | undefined;
    let location: RelativePoint = p.point ? toViewport(p.point, s.viewport) : { x: s.viewport.width / 2, y: s.viewport.height / 2 };
    const mouse = (type: string, point: RelativePoint, extra: object = {}) => command(tabId, 'Input.dispatchMouseEvent', { type, ...point, ...extra });
    const move = async (from: RelativePoint, to: RelativePoint, buttons = 0) => {
      const duration = p.durationMs ?? 450 + Math.random() * 300, steps = Math.ceil(duration / 20);
      for (const pos of motionPath(from, to, steps, (Math.random() - 0.5) * 4)) {
        await ensureTarget();
        location = { x: Math.max(0, Math.min(s.viewport.width - 0.5, pos.x)), y: Math.max(0, Math.min(s.viewport.height - 0.5, pos.y)) };
        await mouse('mouseMoved', location, { buttons, button: heldButton ?? 'none' }); await pause(duration / steps * 0.8, duration / steps * 1.2);
      }
    };
    const click = async (button: 'left' | 'right', count: number) => {
      await mouse('mouseMoved', location); await pause(70, 140);
      for (let i = 1; i <= count; i++) {
        await ensureTarget(true);
        heldButton = button;
        await mouse('mousePressed', location, { button, buttons: button === 'left' ? 1 : 2, clickCount: i });
        await pause(45, 90);
        await mouse('mouseReleased', location, { button, buttons: 0, clickCount: i }); heldButton = undefined;
        progress.completedClicks++;
        if (i < count) await pause(60, 110);
      }
    };
    return withGuiCleanup(async () => {
    try {
      await ensureTarget(true);
      if (action === 'click') await click(p.button ?? 'left', p.count ?? 1);
      if (action === 'hover') { await mouse('mouseMoved', location); await pause(p.durationMs ?? 500); }
      if (action === 'drag') {
        const from = toViewport(p.from, s.viewport), to = toViewport(p.to, s.viewport);
        location = from; await mouse('mouseMoved', from); await pause(100, 200);
        await ensureTarget(true);
        heldButton = 'left'; await mouse('mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 });
        progress.dragPhase = 'pressed';
        await pause(140, 260); await move(from, to, 1); await pause(140, 260);
        await ensureTarget(true);
        await mouse('mouseReleased', to, { button: 'left', buttons: 0, clickCount: 1 }); heldButton = undefined;
        progress.dragPhase = 'released';
      }
      if (action === 'scroll') {
        await mouse('mouseMoved', location); await pause(100, 180);
        const horizontal = p.direction === 'left' || p.direction === 'right';
        const amount = (horizontal ? s.viewport.width : s.viewport.height) * p.percent! / 100 * (p.direction === 'up' || p.direction === 'left' ? -1 : 1);
        const steps = 20, duration = p.durationMs ?? 600;
        let prior = 0;
        for (let i = 1; i <= steps; i++) {
          await ensureTarget();
          const t = i / steps, next = amount * (t * t * (3 - 2 * t));
          await mouse('mouseWheel', location, { deltaX: horizontal ? next - prior : 0, deltaY: horizontal ? 0 : next - prior });
          if (horizontal) progress.scrollDeltaX += next - prior; else progress.scrollDeltaY += next - prior;
          prior = next; await pause(duration / steps * 0.8, duration / steps * 1.2);
        }
        await pause(150, 250);
      }
      if (action === 'input') {
        if (p.clickFirst !== false) await click('left', 1);
        await ensureEditable(tabId, s.id, true);
        inputStarted = true;
        if (p.clear) {
          const platform = await bounded(chrome.runtime.getPlatformInfo(), 5000, 'Read keyboard platform');
          await ensureTarget(true); await keyboard(tabId, [platform.os === 'mac' ? 'Meta' : 'Control', 'a'], () => ensureTarget(true));
          await ensureTarget(true); await keyboard(tabId, ['Backspace'], () => ensureTarget(true));
        }
        const segments = typeof Intl.Segmenter === 'function' ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(p.text!), s => s.segment) : Array.from(p.text!);
        const delay = Math.min(65, 10000 / Math.max(1, segments.length));
        for (const text of segments) {
          await ensureTarget(); await ensureEditable(tabId, s.id);
          await command(tabId, 'Input.insertText', { text }); progress.insertedUtf16Units += text.length;
          await pause(delay * 0.6, delay * 1.4);
        }
      }
      if (action === 'keyboard') await keyboard(tabId, p.keys!, () => ensureTarget(true));
      return { text: `${action} dispatched; verify the resulting screenshot.`, tabId,
        screenshotId: s.id, progress, coordinateDiagnostics: { viewport: s.viewport, lastCssPoint: location } };
    } catch (error) {
      const cause = error instanceof GuiError ? error : new GuiError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
      throw new GuiError(cause.code, cause.message, { ...cause.details, action, tabId, screenshotId: s.id,
        outcomeUncertain: true, lastCssPoint: location, progress }, cause.recovery);
    }
    }, async () => {
      if (heldButton) {
        try {
          // Cleanup never reattaches a debugger the user detached, and does not replay a press.
          await bounded(chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', ...location, button: heldButton, buttons: 0, clickCount: 1 }), 3000, 'Release held mouse button');
        } catch (error) {
          quarantinedTabs.add(tabId);
          throw new GuiError('CLEANUP_FAILED', 'Could not confirm mouse release', { action, tabId, screenshotId: s.id, outcomeUncertain: true, progress, cause: error instanceof Error ? error.message : String(error) });
        }
      }
    });
  });
}

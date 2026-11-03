import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { toViewport, relativePoint, motionPath, pngDimensions, verifyScreenshotGeometry } from '../../tools/vision/coordinates';
import { annotationPayload, focusedEditablePayload } from '../../tools/vision/dom-inspection';

const v = { width: 1440, height: 900, pageX: 0, pageY: 0, scale: 1 };
assert.deepEqual(toViewport({ x: 500, y: 500 }, v), { x: 720, y: 450 });
assert.deepEqual(toViewport({ x: 1000, y: 1000 }, v), { x: 1439.5, y: 899.5 });
for (const p of [null, [1, 2], { x: NaN, y: 1 }, { x: Infinity, y: 2 }, { x: '50', y: 2 }, { x: -1, y: 1 }, { x: 1, y: 1001 }]) assert.throws(() => relativePoint(p));
const path = motionPath({ x: 10, y: 10 }, { x: 900, y: 600 }, 40, 3);
assert.deepEqual(path.at(-1), { x: 900, y: 600 });
assert.ok(Math.hypot(path[1].x - path[0].x, path[1].y - path[0].y) < Math.hypot(path[20].x - path[19].x, path[20].y - path[19].y));

// Evaluate the payload in a separate realm, as chrome.scripting serializes it.
const dom = new JSDOM('<button id="go" aria-label="Go" style="opacity:1">Go</button><input type="password" value="private" />', { runScripts: 'outside-only' } as any);
const w = dom.window as any;
w.CSS = { escape: (s: string) => s };
w.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 10, y: 10, left: 10, top: 10, right: 100, bottom: 50, width: 90, height: 40 });
w.document.elementFromPoint = () => w.document.querySelector('button');
const payload = w.eval(`(${annotationPayload.toString()})`);
assert.equal(payload('collect', 'a'), 1);
payload('draw', 'a', [5]);
assert.equal(w.document.documentElement.lastElementChild.tagName, 'DIV');
payload('clear', 'a');
const info = payload('inspect', 'a', [], 0);
assert.equal(info.selector, '#go');
assert.equal(w.document.evaluate(info.xpath, w.document, null, 9, null).singleNodeValue, w.document.querySelector('button'));
assert.throws(() => payload('inspect', 'old', [], 0));
w.document.querySelector('button').remove();
assert.throws(() => payload('inspect', 'a', [], 0));
const focusPayload = w.eval(`(${focusedEditablePayload.toString()})`);
const password = w.document.querySelector('input');
password.focus();
assert.equal(focusPayload('focus1', true), true);
assert.equal(focusPayload('focus1'), true);
assert.equal(focusPayload('other'), false);
password.disabled = true;
assert.equal(focusPayload('focus1'), false);

// Host/CDP contract: real orchestration with mocked browser transport, no synthetic DOM fallback.
const events: { method: string; p: any }[] = [];
function pngHeader(width: number, height: number): string {
  const bytes = Buffer.alloc(33); bytes.set([137,80,78,71,13,10,26,10]); bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12); bytes.writeUInt32BE(width,16); bytes.writeUInt32BE(height,20); return bytes.toString('base64');
}
assert.deepEqual(pngDimensions(pngHeader(2880,1800)), { width:2880, height:1800 });
assert.throws(() => pngDimensions('aW1hZ2U='));
assert.throws(() => verifyScreenshotGeometry({ width:1000, height:700 }, { ...v, width:985, height:685, devicePixelRatio:1 }), /PNG bounds/);
verifyScreenshotGeometry({ width:1250, height:875 }, { ...v, width:1000, height:700, devicePixelRatio:1.25 });
let tabId = 1, loader = 'doc1', failMove = false, scale = 1, pageY = 0, marks = 0, failCapture = false, failKey = false;
let focusOkay = true, stealFocus = false, cancelOnPress: AbortController | undefined;
let failMouseRelease = false, failAnnotationClear = false;
const scripts: string[] = [];
(globalThis as any).chrome = {
  runtime: { getPlatformInfo: async () => ({ os:'win' }) },
  tabs: { query: async () => [{ id: tabId, windowId: 1, url: 'https://example.test/' }] },
  scripting: { executeScript: async ({ args, func }: any) => {
    if (func.name === 'focusedEditablePayload') return [{ frameId: 9, result: focusOkay }];
    if (!args) return [{ frameId:0, result:{ width:1440,height:900,devicePixelRatio:1,pageX:0,pageY } }];
    scripts.push(args[0]);
    if (args[0] === 'clear' && failAnnotationClear) throw new Error('Clear interrupted');
    if (args[0] === 'collect') return [{ frameId: 0, result: 1 }, { frameId: 9, result: 1 }];
    if (args[0] === 'draw') { marks++; return [{ frameId: 0 }]; }
    if (args[0] === 'inspect') return [{ result: { selector: '#go' } }];
    return [];
  } },
  debugger: {
    onDetach: { addListener() {} }, attach: async () => {}, detach: async () => {},
    sendCommand: async (_target: any, method: string, p: any) => {
      events.push({ method, p });
      if (failMouseRelease && method === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased') throw new Error('Release interrupted');
      if (method === 'Input.dispatchMouseEvent' && p.type === 'mousePressed' && cancelOnPress) cancelOnPress.abort();
      if (method === 'Input.insertText' && stealFocus) focusOkay = false;
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1425, clientHeight: 885, pageX: 0, pageY, scale } };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { loaderId: loader } } };
      if (method === 'Page.captureScreenshot') { if (failCapture) { failCapture = false; throw new Error('Capture interrupted'); } return { data: pngHeader(1440,900) }; }
      if (failKey && method === 'Input.dispatchKeyEvent' && p.type === 'keyDown' && p.key === 'a') { failKey = false; throw new Error('Key interrupted'); }
      if (method === 'Runtime.evaluate') return { result: { type: 'boolean', value: true } };
      if (failMove && method === 'Input.dispatchMouseEvent' && p.type === 'mouseMoved' && p.buttons === 1) { failMove = false; throw new Error('Interrupted'); }
      return {};
    },
  },
};
const originalTimer = globalThis.setTimeout;
(globalThis as any).setTimeout = (fn: () => void, ms: number) => ms < 3001 ? originalTimer(fn, 0) : originalTimer(fn, ms);
const { executeGui, captureGuiScreenshot } = await import('../../tools/vision/gui-driver');
const { cdpSession } = await import('../../tools/browser/cdp-session');
const snap = () => captureGuiScreenshot();
let s = await snap();
const point = { x: 250, y: 500 };
await executeGui('click', { screenshotId: s.screenshotId, point, button: 'right', count: 3 });
const presses = events.filter(e => e.p?.type === 'mousePressed');
assert.deepEqual(presses.map(e => e.p.clickCount), [1, 2, 3]);
assert.ok(presses.every(e => e.p.x === 360 && e.p.y === 450 && e.p.button === 'right'));
await assert.rejects(executeGui('click', { screenshotId: s.screenshotId, point }), /expired/i);
s = await snap(); loader = 'doc2';
await assert.rejects(executeGui('hover', { screenshotId: s.screenshotId, point }), /reloaded/i);
s = await snap(); pageY = 50;
await assert.rejects(executeGui('hover', { screenshotId: s.screenshotId, point }), /Viewport/);
pageY = 0; s = await snap(); tabId = 2;
await assert.rejects(executeGui('hover', { screenshotId: s.screenshotId, point }), /expired/i);
tabId = 1; scale = 1.5;
await assert.rejects(snap(), /pinch/); scale = 1;
s = await snap(); failMove = true;
await assert.rejects(executeGui('drag', { screenshotId: s.screenshotId, from: point, to: { x: 900, y: 900 } }), /Interrupted/);
assert.equal(events.at(-1)?.p.type, 'mouseReleased');
assert.equal(events.at(-1)?.p.buttons, 0);
s = await snap();
await executeGui('scroll', { screenshotId: s.screenshotId, direction: 'down', percent: 75, point });
const wheels = events.filter(e => e.p?.type === 'mouseWheel');
assert.ok(Math.abs(wheels.reduce((sum, e) => sum + e.p.deltaY, 0) - 675) < 1e-8);
assert.ok(wheels.every(e => e.p.x === 360 && e.p.y === 450));
s = await snap();
await executeGui('input', { screenshotId: s.screenshotId, point, text: '你好👩‍💻', clear: true });
assert.deepEqual(events.filter(e => e.method === 'Input.insertText').map(e => e.p.text), ['你', '好', '👩‍💻']);
assert.equal(events.filter(e => e.method === 'Input.dispatchKeyEvent' && e.p.type === 'keyUp').length, 3);
s = await snap();
await executeGui('mark', { screenshotId: s.screenshotId });
assert.equal(marks, 0);
s = await snap();
assert.equal(s.elementsCount, 2); assert.equal(marks, 2); assert.equal(scripts.at(-1), 'clear');
assert.equal((await executeGui('inspect', { screenshotId: s.screenshotId, id: 2 })).frameId, 9);
await assert.rejects(executeGui('inspect', { screenshotId: s.screenshotId, id: 3 }), /absent/);
await assert.rejects(executeGui('click', { screenshotId: s.screenshotId, point, count: 1.5 }), /integer/);
await assert.rejects(executeGui('scroll', { screenshotId: s.screenshotId, percent: NaN, direction: 'down' }), /finite/);
const next = await snap(); assert.equal(next.elementsCount, 0);
await executeGui('mark', { screenshotId: next.screenshotId });
failCapture = true;
await assert.rejects(snap(), /Capture interrupted/);
assert.equal(scripts.at(-1), 'clear');
s = await snap(); assert.equal(s.elementsCount, 2);
failKey = true;
await assert.rejects(executeGui('keyboard', { screenshotId: s.screenshotId, keys: ['Control', 'a'] }), /Key interrupted/);
assert.equal(events.at(-1)?.p.type, 'keyUp');
assert.equal(events.at(-1)?.p.key, 'Control');
s = await snap();
const competing = await Promise.allSettled([
  executeGui('click', { screenshotId: s.screenshotId, point }),
  executeGui('click', { screenshotId: s.screenshotId, point }),
]);
assert.deepEqual(competing.map(r => r.status), ['fulfilled', 'rejected']);
await assert.rejects(executeGui('keyboard', { screenshotId:s.screenshotId, keys:['constructor'] }), /Unsupported key/);
await assert.rejects(executeGui('click', { screenshotId:s.screenshotId, point, clear:true } as any), /Unexpected parameters/);
await assert.rejects(executeGui('unknown' as any, { screenshotId:s.screenshotId }), /Unsupported GUI action/);
s = await snap();
const queuedPoint = { x:250,y:500 };
const queued = executeGui('click', { screenshotId:s.screenshotId,point:queuedPoint });
queuedPoint.x = 999;
const immutable = await queued;
assert.equal(immutable.coordinateDiagnostics.lastCssPoint.x,360);
s = await snap(); cancelOnPress = new AbortController();
await assert.rejects(executeGui('drag', { screenshotId:s.screenshotId,from:point,to:{x:900,y:900} }, cancelOnPress.signal), (error: any) => error.code === 'CANCELLED');
assert.equal(events.at(-1)?.p.type,'mouseReleased'); cancelOnPress = undefined;
s = await snap(); stealFocus = true;
const beforeText = events.filter(e => e.method === 'Input.insertText').length;
await assert.rejects(executeGui('input', { screenshotId:s.screenshotId,point,text:'abc' }), (error: any) => error.code === 'FOCUS_CHANGED' && error.details.progress.insertedUtf16Units === 1);
assert.equal(events.filter(e => e.method === 'Input.insertText').length,beforeText + 1);
stealFocus = false; focusOkay = true;
const { cancelGuiRequest, withGuiCancellation } = await import('../../tools/vision/gui-cancellation');
cancelGuiRequest('early');
assert.equal(await withGuiCancellation('early', async signal => signal?.aborted),true);
const { GuiTool } = await import('../../tools/vision/gui-tools');
const failure = await new GuiTool('click').execute({ screenshotId:'invalid',point:{x:NaN,y:5} });
assert.equal(failure.data.diagnostic.code,'INVALID_ARGUMENT');
assert.equal(failure.data.diagnostic.retryAutomatically,false);
s = await snap(); failMove = true; failMouseRelease = true;
await assert.rejects(executeGui('drag', { screenshotId:s.screenshotId,from:point,to:{x:800,y:800} }),
  (error: any) => error.code === 'CLEANUP_FAILED' && error.details.primaryFailure.code === 'TRANSPORT_ERROR');
failMouseRelease = false;
s = await snap();
await executeGui('mark', { screenshotId:s.screenshotId }); failAnnotationClear = true;
await assert.rejects(snap(), (error: any) => error.code === 'CLEANUP_FAILED');
failAnnotationClear = false;
s = await snap();
assert.equal(s.elementsCount,0);
const { VisionActionHandler } = await import('../../entrypoints/background/vision/vision-action-handler');
const responses: any[] = [];
const handler = new VisionActionHandler({ send: (message: any) => { responses.push(message); return true; } } as any);
await handler.handleVisionAction({ correlationId:'bad-request',payload:{ action:'click',parameters:{ screenshotId:s.screenshotId,point:{x:-5,y:50} } } } as any);
assert.equal(responses.at(-1).payload.success,false);
assert.equal(responses.at(-1).payload.data.diagnostic.code,'INVALID_ARGUMENT');
assert.equal(responses.at(-1).payload.data.diagnostic.correlationId,'bad-request');
await handler.handleVisionAction({ correlationId:'old-protocol',payload:{ action:'screenshot',screenshotMode:'simple' } } as any);
assert.equal(responses.at(-1).payload.data.diagnostic.code,'INVALID_ARGUMENT');
assert.equal(events.find(e => e.method === 'Page.captureScreenshot')?.p.captureBeyondViewport, false);
await cdpSession.detachAll();
globalThis.setTimeout = originalTimer;
console.log('[vision] coordinate, payload, gesture, stale snapshot and annotation contracts passed');

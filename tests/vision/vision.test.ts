import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { toViewport, relativePoint, motionPath, pngDimensions, verifyScreenshotGeometry } from '../../tools/vision/coordinates';
import { annotationPayload, focusedEditablePayload } from '../../tools/vision/dom-inspection';
import { checkPagePayload } from '../../tools/vision/check-payload';
import { planCrop,registerView,mapViewPoint,registerTargetGuard } from '../../tools/vision/observation-model';
import { validateCheckArgs } from '../../tools/vision/observation-actions';
import { VisionGuiTool, validateVisionGuiArgs } from '../../tools/vision/gui-tool';
import { GuiError } from '../../tools/vision/gui-errors';
import { takeVisionToolImage,needsVisionRefresh } from '../../entrypoints/sidepanel/core/conversation/vision-feedback';

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
w.crypto.randomUUID=()=>crypto.randomUUID();
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
const checkDom=new JSDOM('<button id="safe" aria-label="Save">Save</button><input id="value" value="done"><input id="secret" type="password" value="private">',{runScripts:'outside-only'});
const cw=checkDom.window as any; cw.crypto.randomUUID=()=>crypto.randomUUID();
cw.HTMLElement.prototype.getBoundingClientRect=()=>({x:10,y:10,left:10,top:10,right:90,bottom:40,width:80,height:30});
cw.document.elementFromPoint=()=>cw.document.querySelector('#safe');
const checkFn=cw.eval(`(${checkPagePayload.toString()})`);
const checkedDom=checkFn({x:40,y:20},{enabled:true,nameIncludes:'Save'});
assert.ok(checkedDom.checks.every((c:any)=>c.status==='passed'));
assert.equal(checkFn({x:40,y:20}).target.signature,checkedDom.target.signature);
cw.document.querySelector('#safe').disabled=true;
assert.notEqual(checkFn({x:40,y:20}).target.signature,checkedDom.target.signature);
cw.document.elementFromPoint=()=>cw.document.querySelector('#value');
assert.equal(checkFn({x:40,y:20},{valueEquals:'done'}).checks[0].status,'passed');
cw.document.elementFromPoint=()=>cw.document.querySelector('#secret');
assert.equal(checkFn({x:40,y:20},{valueEquals:'private'}).checks[0].status,'unknown');
const cropPlan=planCrop({width:999,height:701},{x:100.1,y:20,width:100.2,height:80.4},3);
assert.equal(cropPlan.x,99); assert.equal(cropPlan.width,102);
assert.ok(cropPlan.region.x<=100.1 && cropPlan.region.x+cropPlan.region.width>=200.3);
const view=registerView('parent',cropPlan.region);
assert.deepEqual(mapViewPoint('parent',view,{x:0,y:0}),{x:cropPlan.region.x,y:cropPlan.region.y});
assert.throws(()=>mapViewPoint('other',view,{x:50,y:50}),/stale/);
assert.throws(()=>planCrop({width:100,height:100},{x:999,y:0,width:2,height:1}),/beyond/);
assert.ok(planCrop({width:10000,height:10000},{x:0,y:0,width:1000,height:1000},4).outputWidth<=2048);
const fakeImage={success:true,data:{screenshot:'data:image/png;base64,cG5n',text:'not a real viewport',screenshotId:'s'}};
assert.equal(takeVisionToolImage(fakeImage,0,'browser_page_exec'),null);
const zoomImage=takeVisionToolImage(fakeImage,0,'vision_gui',{action:'zoom'})!;
assert.equal(zoomImage.kind,'region');
assert.equal(needsVisionRefresh([{function:{name:'vision_gui',arguments:'{"action":"zoom"}'}}],[zoomImage],()=> true),false);
for(const args of [null,{screenshotId:'s',expect:{enabled:'true'}},{screenshotId:'s',expect:{valueEquals:'x'}},{screenshotId:'s',point:{x:1,y:2},expect:{script:'alert(1)'}},{screenshotId:'s',timeoutMs:Infinity}]) assert.throws(()=>validateCheckArgs(args));

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
let observedSignature='target-v1';
let measuredHeight=900, changeHeightOnCapture=false, visibleCaptureCount=0;
const scripts: string[] = [];
(globalThis as any).chrome = {
  runtime: { getPlatformInfo: async () => ({ os:'win' }) },
  tabs: { query: async () => [{ id: tabId, windowId: 1, url: 'https://example.test/' }],
    captureVisibleTab: async () => { visibleCaptureCount++; if(changeHeightOnCapture){measuredHeight=864;changeHeightOnCapture=false;} return `data:image/png;base64,${pngHeader(1440,measuredHeight)}`; } },
  scripting: { executeScript: async ({ args, func }: any) => {
    if (func.name === 'focusedEditablePayload') return [{ frameId: 9, result: focusOkay }];
    if (func.name === 'observationViewportPayload') return [{frameId:0,result:{documentId:loader,width:1440,height:measuredHeight,devicePixelRatio:1,pageX:0,pageY,scale,contentWidth:1425,contentHeight:measuredHeight-15,zoom:1}}];
    if (func.name === 'checkPagePayload') return [{frameId:0,result:{target:{signature:observedSignature,identity:'target',tag:'button',name:'Save',opaqueFrame:false,rect:{x:1,y:1,width:20,height:10}},checks:[{kind:'enabled',status:'passed'}],page:{readyState:'complete'},loading:{ariaBusyCount:0},dialogs:[]}}];
    if (!args) return [{ frameId:0, result:{ width:1440,height:measuredHeight,devicePixelRatio:1,pageX:0,pageY } }];
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
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1425, clientHeight: measuredHeight-15, pageX: 0, pageY, scale } };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { loaderId: loader } } };
      if (method === 'Page.captureScreenshot') { if (failCapture) { failCapture = false; throw new Error('Capture interrupted'); } if(changeHeightOnCapture){measuredHeight=864;changeHeightOnCapture=false;} return { data: pngHeader(1440,measuredHeight) }; }
      if (failKey && method === 'Input.dispatchKeyEvent' && p.type === 'keyDown' && p.key === 'a') { failKey = false; throw new Error('Key interrupted'); }
      if (method === 'Runtime.evaluate') return { result: { type: 'boolean', value: true } };
      if (failMove && method === 'Input.dispatchMouseEvent' && p.type === 'mouseMoved' && p.buttons === 1) { failMove = false; throw new Error('Interrupted'); }
      return {};
    },
  },
};
const originalTimer = globalThis.setTimeout;
const gestureDelays: {eventCount:number;ms:number}[] = [];
let onGestureDelay: ((ms:number)=>void) | undefined;
(globalThis as any).setTimeout = (fn: () => void, ms: number) => {
  if(ms < 3001) { gestureDelays.push({eventCount:events.length,ms}); onGestureDelay?.(ms); }
  return ms < 3001 ? originalTimer(fn, 0) : originalTimer(fn, ms);
};
const { captureGuiScreenshot } = await import('../../tools/vision/gui-driver');
const gui = new VisionGuiTool();
// Exercise the public dispatcher for every existing gesture regression, preserving diagnostics.
async function executeGui(action: string, parameters: any, signal?: AbortSignal): Promise<any> {
  const result = await gui.execute({action,...parameters},{signal});
  if (!result.success) {
    const d=result.data!.diagnostic;
    throw new GuiError(d.code,d.message,d.details,d.recovery);
  }
  return result.data;
}
const { resolveKeys } = await import('../../tools/vision/key-definitions');
assert.equal(resolveKeys(['F12'])[0].windowsVirtualKeyCode,123);
assert.equal(resolveKeys(['!'])[0].key,'Shift');
assert.equal(resolveKeys(['Shift','1'])[1].shifted,'!');
assert.equal(resolveKeys(['F24'])[0].windowsVirtualKeyCode,135);
assert.deepEqual(resolveKeys(['Ctrl','Esc']).map(k=>k.key),['Control','Escape']);
assert.equal(resolveKeys(['Command','c'])[0].key,'Meta');
assert.equal(resolveKeys(['Option','Left'])[1].key,'ArrowLeft');
assert.equal(resolveKeys(['ControlRight'])[0].location,2);
assert.equal(resolveKeys(['MetaRight'])[0].windowsVirtualKeyCode,92);
assert.equal(resolveKeys(['Numpad9'])[0].windowsVirtualKeyCode,105);
assert.equal(resolveKeys(['NumpadEnter'])[0].isKeypad,true);
assert.equal(resolveKeys(['NumpadAdd'])[0].key,'+');
assert.throws(()=>resolveKeys(['Ctrl','ControlLeft']),/Duplicate physical key/);
assert.throws(()=>resolveKeys(['Space',' ']),/Duplicate physical key/);
assert.throws(()=>resolveKeys(['a','A']),/Duplicate physical key/);
for (const invalid of ['F25','Numpad10','constructor','__proto__','Control+S','']) assert.throws(()=>resolveKeys([invalid]),/Unsupported key/);
const { cdpSession } = await import('../../tools/browser/cdp-session');
const snap = () => captureGuiScreenshot();
let s = await snap();
const point = { x: 250, y: 500 };
// Native crop rendering is covered by browser-probe; here exercise dispatcher,
// image-only transport and parent identity without requiring Node canvas APIs.
const cropGlobals = { canvas: globalThis.OffscreenCanvas, bitmap: globalThis.createImageBitmap };
(globalThis as any).createImageBitmap = async () => ({ close() {} });
(globalThis as any).OffscreenCanvas = class {
  constructor(public width:number,public height:number) {}
  getContext() { return { drawImage() {}, imageSmoothingEnabled:false }; }
  async convertToBlob() { return new Blob([Buffer.from(pngHeader(this.width,this.height),'base64')],{type:'image/png'}); }
};
try {
  const zoom = await gui.execute({action:'zoom',screenshotId:s.screenshotId,region:{x:200,y:100,width:400,height:200},scale:2});
  assert.equal(zoom.success,true);
  assert.equal(zoom.data!.screenshotId,s.screenshotId);
  assert.ok(zoom.data!.viewId);
  assert.equal(zoom.data!.imageKind,'region');
  assert.equal(JSON.stringify(zoom.content).includes('base64'),false);
  const hover=await gui.execute({action:'hover',screenshotId:s.screenshotId,viewId:zoom.data!.viewId,point:{x:500,y:500},durationMs:200});
  assert.equal(hover.success,true,'zoom preserves actionable parent screenshot');
  assert.equal(hover.data!.coordinateDiagnostics.lastCssPoint.x,576);
} finally {
  globalThis.OffscreenCanvas=cropGlobals.canvas;
  globalThis.createImageBitmap=cropGlobals.bitmap;
}
s = await snap();
await executeGui('click', { screenshotId: s.screenshotId, point, button: 'right', count: 3 });
const presses = events.filter(e => e.p?.type === 'mousePressed');
assert.deepEqual(presses.map(e => e.p.clickCount), [1, 2, 3]);
assert.ok(presses.every(e => e.p.x === 360 && e.p.y === 450 && e.p.button === 'right'));
await assert.rejects(executeGui('click', { screenshotId: s.screenshotId, point }), /expired/i);
// Inspect actual dispatch order and scheduled dwell, without real multi-second sleeps.
for (const explicit of [false,true]) {
  s=await snap();
  const eventStart=events.length, delayStart=gestureDelays.length;
  const from={x:100,y:200}, to={x:850,y:800};
  await executeGui('drag',{screenshotId:s.screenshotId,from,to,durationMs:400,...(explicit?{holdBeforeMs:0,holdAfterMs:75}:{})});
  const press=events.findIndex((e,i)=>i>=eventStart && e.p?.type==='mousePressed');
  const release=events.findIndex((e,i)=>i>=eventStart && e.p?.type==='mouseReleased');
  const atStart=gestureDelays.slice(delayStart).filter(d=>d.eventCount===press+1);
  const lastMove=events.findLastIndex((e,i)=>i>press && i<release && e.p?.type==='mouseMoved');
  const atEnd=gestureDelays.slice(delayStart).filter(d=>d.eventCount===lastMove+1);
  assert.equal(atStart.length,1); assert.equal(atEnd.length,1);
  if(explicit) { assert.equal(atStart[0].ms,0);assert.equal(atEnd[0].ms,75); }
  else for(const dwell of [atStart[0],atEnd[0]]) assert.ok(dwell.ms>=500 && dwell.ms<=1500,'Default held dwell is 0.5–1.5s');
  const moves=events.slice(press+1,release).filter(e=>e.p?.type==='mouseMoved' && e.p.buttons===1).map(e=>e.p);
  const a=toViewport(from,s.viewport), b=toViewport(to,s.viewport);
  for(const pos of moves) assert.ok(Math.abs((pos.x-a.x)*(b.y-a.y)-(pos.y-a.y)*(b.x-a.x))<1e-6,'Default drag stays on the straight segment');
  assert.deepEqual({x:moves.at(-1).x,y:moves.at(-1).y},b);
  const distances=moves.map((pos,i)=>Math.hypot(pos.x-(i?moves[i-1].x:a.x),pos.y-(i?moves[i-1].y:a.y))).filter(d=>d>0);
  assert.ok(distances[0]<distances[Math.floor(distances.length/2)] && distances.at(-1)!<distances[Math.floor(distances.length/2)],'Movement accelerates then decelerates');
}
for(const phase of ['start','end']) {
  s=await snap(); const cancellation=new AbortController(), before=events.length;
  onGestureDelay=ms=>{
    const last=events.at(-1)?.p;
    if(ms>=500 && ms<=1500 && (phase==='start'?last?.type==='mousePressed':last?.type==='mouseMoved' && last.buttons===1)) {
      onGestureDelay=undefined;
      originalTimer(()=>cancellation.abort(),0);
    }
  };
  try {
    await assert.rejects(executeGui('drag',{screenshotId:s.screenshotId,from:point,to:{x:700,y:700},...(phase==='end'?{holdBeforeMs:0}:{})},cancellation.signal), (e:any)=>e.code==='CANCELLED');
    assert.equal(events.slice(before).filter(e=>e.p?.type==='mousePressed').length,1);
    assert.equal(events.slice(before).filter(e=>e.p?.type==='mouseReleased').length,1,'Cancellation during either dwell releases held mouse exactly once');
    assert.equal(events.at(-1)?.p.type,'mouseReleased');
  } finally { onGestureDelay=undefined; }
}
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
await assert.rejects(executeGui('click', { screenshotId:s.screenshotId, point, clear:true } as any), /Unexpected parameter/);
await assert.rejects(executeGui('unknown' as any, { screenshotId:s.screenshotId }), /supported action/);
s = await snap();
let chordStart=events.length;
await executeGui('keyboard',{screenshotId:s.screenshotId,keys:['Ctrl','ShiftRight','a']});
let chordEvents=events.slice(chordStart).filter(e=>e.method==='Input.dispatchKeyEvent');
assert.equal(chordEvents.find(e=>e.p.code==='KeyA' && e.p.type==='keyDown')?.p.key,'A');
assert.equal(chordEvents.find(e=>e.p.code==='KeyA' && e.p.type==='keyDown')?.p.text,undefined);
assert.equal(chordEvents.find(e=>e.p.code==='ShiftRight' && e.p.type==='keyUp')?.p.location,2);
s=await snap();chordStart=events.length;
await executeGui('keyboard',{screenshotId:s.screenshotId,keys:['ControlLeft','ControlRight','NumpadEnter']});
chordEvents=events.slice(chordStart).filter(e=>e.method==='Input.dispatchKeyEvent');
assert.equal(chordEvents.find(e=>e.p.code==='NumpadEnter' && e.p.type==='keyDown')?.p.isKeypad,true);
assert.equal(chordEvents.find(e=>e.p.code==='ControlRight' && e.p.type==='keyUp')?.p.modifiers,2);
assert.equal(chordEvents.at(-1)?.p.modifiers,0);
s=await snap();chordStart=events.length;
await executeGui('keyboard',{screenshotId:s.screenshotId,keys:['Enter']});
chordEvents=events.slice(chordStart).filter(e=>e.method==='Input.dispatchKeyEvent');
assert.equal(chordEvents[0].p.unmodifiedText,'\r');
assert.equal(chordEvents[0].p.text,'\r');
s=await snap();
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
const failure = await gui.execute({ action:'click', screenshotId:'invalid',point:{x:NaN,y:5} });
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
s = await snap();
const checkResult=await gui.execute({action:'check',screenshotId:s.screenshotId,point:{x:250,y:500},expect:{enabled:true},stableMs:0,timeoutMs:50});
assert.equal(checkResult.success,true); assert.equal(checkResult.data.status,'passed');
const guardId=registerTargetGuard(s.screenshotId,{x:250,y:500},observedSignature);
observedSignature='target-v2';
const beforeGuardPress=events.filter(e=>e.p?.type==='mousePressed').length;
await assert.rejects(executeGui('click',{screenshotId:s.screenshotId,point:{x:250,y:500},guardId}), (e:any)=>e.code==='TARGET_CHANGED');
assert.equal(events.filter(e=>e.p?.type==='mousePressed').length,beforeGuardPress);
s = await snap();
const actionView=registerView(s.screenshotId,{x:200,y:100,width:400,height:200});
const viewAction=await executeGui('click',{screenshotId:s.screenshotId,viewId:actionView,point:{x:500,y:500}});
assert.equal(viewAction.coordinateDiagnostics.lastCssPoint.x,576);
assert.equal(viewAction.coordinateDiagnostics.lastCssPoint.y,180);
s=await snap();
const mappedView=registerView(s.screenshotId,{x:200,y:100,width:400,height:200});
const mappedCheck=await gui.execute({action:'check',screenshotId:s.screenshotId,viewId:mappedView,point:{x:500,y:500},stableMs:0});
assert.deepEqual(mappedCheck.data.actionPoint,{x:400,y:200});
s = await snap();
await executeGui('click',{screenshotId:s.screenshotId,point,button:'middle',modifiers:['Shift']});
const middlePress = events.filter(e => e.p?.type === 'mousePressed').at(-1)!;
assert.equal(middlePress.p.buttons,4); assert.equal(middlePress.p.modifiers,8);
assert.equal(events.at(-1)?.p.key,'Shift'); assert.equal(events.at(-1)?.p.type,'keyUp');
s = await snap();
const start = events.length;
await executeGui('drag',{screenshotId:s.screenshotId,from:point,to:{x:700,y:700},waypoints:[{x:500,y:100}],button:'right',modifiers:['Alt'],durationMs:200});
assert.ok(events.slice(start).some(e => e.p?.type === 'mouseMoved' && e.p.x === 720 && e.p.y === 90 && e.p.buttons === 2 && e.p.modifiers === 1));
s = await snap();
const wheelStart = events.length;
await executeGui('scroll',{screenshotId:s.screenshotId,deltaX:1.5,deltaY:-2,point});
const preciseWheels = events.slice(wheelStart).filter(e => e.p?.type === 'mouseWheel');
assert.ok(Math.abs(preciseWheels.reduce((sum,e) => sum+e.p.deltaX,0)-1.5)<1e-8);
assert.ok(Math.abs(preciseWheels.reduce((sum,e) => sum+e.p.deltaY,0)+2)<1e-8);
await assert.rejects(executeGui('scroll',{screenshotId:s.screenshotId,deltaY:1,direction:'down',percent:5}),/not both/);
await assert.rejects(executeGui('input',{screenshotId:s.screenshotId,point,text:'中文',inputMode:'keys'}),/ASCII/);
assert.equal(responses.at(-1).payload.data.diagnostic.correlationId,'bad-request');
await handler.handleVisionAction({ correlationId:'old-protocol',payload:{ action:'screenshot',screenshotMode:'simple' } } as any);
assert.equal(responses.at(-1).payload.data.diagnostic.code,'INVALID_ARGUMENT');
assert.equal(events.find(e => e.method === 'Page.captureScreenshot')?.p.captureBeyondViewport, false);
await cdpSession.detachAll();

// A read-only screenshot must not attach/issue ANY debugger command. Geometry
// transitions during capture are retried once, never "corrected" by a 36px guess.
const beforeObservation=events.length;
changeHeightOnCapture=true;
const observedShot=await captureGuiScreenshot(undefined,'observe');
assert.equal(observedShot.viewport.height,864);assert.equal(observedShot.imageSize.height,864);
assert.equal(observedShot.timings.attempts,2);assert.equal(visibleCaptureCount,2);
// 截图描述必须携带 grounding 指令（贴图提示：先陈述所见再行动/作答）——
// 这是治「忽略看到了啥」的每图强化锚点，静默丢失会让视觉优先退化
assert.ok(observedShot.text.includes('Before answering'), 'observe-mode capture text carries the grounding directive');
assert.equal(events.length,beforeObservation);
const {withReadSnapshot}=await import('../../tools/vision/gui-driver');
await withReadSnapshot(observedShot.screenshotId,false,undefined,async s=>assert.equal(s.mode,'observe'));
assert.equal(events.length,beforeObservation);
await assert.rejects(executeGui('click',{screenshotId:observedShot.screenshotId,point}),/Observation-only/);
assert.equal(events.length,beforeObservation);
loader='observed-reload';
await assert.rejects(withReadSnapshot(observedShot.screenshotId,false,undefined,async()=>{}),/reloaded/);
measuredHeight=900;changeHeightOnCapture=true;
const resizedAction=await captureGuiScreenshot();
assert.equal(resizedAction.timings.attempts,2);assert.equal(resizedAction.viewport.height,864);
assert.ok(resizedAction.text.includes('Before acting'), 'action-mode capture text carries the grounding directive');
assert.ok((cdpSession as any).retainedUntil.get(tabId)>=resizedAction.expiresAt,'Session survives the entire screenshot validity window');
const bottomHit=await executeGui('click',{screenshotId:resizedAction.screenshotId,point:{x:500,y:990}});
assert.ok(Math.abs(bottomHit.coordinateDiagnostics.lastCssPoint.y-864*0.99)<1e-8,'Bottom-edge input uses actual settled viewport height');
const beforeDetachShot=await captureGuiScreenshot();
await cdpSession.detachAll();
const beforeStaleInput=events.length;
await assert.rejects(executeGui('click',{screenshotId:beforeDetachShot.screenshotId,point}),/Debugger detached/);
assert.equal(events.length,beforeStaleInput,'Checking a stale action ID must not reattach or resize');
measuredHeight=900;
globalThis.setTimeout = originalTimer;
console.log('[vision] coordinate, payload, gesture, stale snapshot and annotation contracts passed');

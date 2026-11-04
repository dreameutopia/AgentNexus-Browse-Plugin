/** Independent Chromium experiment: compare screenshot pixels, CSS viewport and actual CDP hit. */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const bundle = path.resolve('node_modules/.cache/vision-browser-driver.mjs');
await build({ entryPoints: ['tests/vision/browser-entry.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'es2022' });

const executable = [process.env.VISION_CHROMIUM_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => p && existsSync(p));
if (!executable) throw new Error('Set VISION_CHROMIUM_PATH to a Chromium executable');
const profile = mkdtempSync(path.join(tmpdir(), 'agentnexus-vision-probe-'));
const child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true });
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><style>body{margin:0;width:2500px;height:3500px}#target{position:fixed;right:35px;bottom:35px;width:1px;height:1px;min-width:0;padding:0;border:0;box-sizing:border-box;background:red}</style><button id="target"></button><script>window.hits=[];addEventListener("pointerdown",e=>hits.push({x:e.clientX,y:e.clientY,id:e.target.id}));</script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let socket;
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium startup timeout')), 15000);
    child.once('error', reject);
    child.stderr.on('data', chunk => { const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('exit', code => reject(new Error(`Chromium exited: ${code}`)));
  });
  const base = String(url).replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '');
  const target = await (await fetch(`${base}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}`)}`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 8000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` });
  await evaluate('new Promise(r=>document.readyState==="complete"?r():addEventListener("load",r,{once:true}))');
  const detachListeners = [];
  let extensionDebuggerCalls=0;
  globalThis.chrome = {
    tabs: { query: async () => [{ id:1, windowId:1, url:`http://127.0.0.1:${server.address().port}` }],
      // CDP is only the test harness transport; production observation capture
      // uses chrome.tabs.captureVisibleTab and never calls chrome.debugger.
      captureVisibleTab: async () => { const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true});return `data:image/png;base64,${result.data}`; } },
    runtime: { getPlatformInfo: async () => ({ os: process.platform === 'darwin' ? 'mac' : 'win' }) },
    debugger: { attach: async () => {extensionDebuggerCalls++;}, detach: async () => { detachListeners.forEach(f => f({ tabId:1 })); },
      onDetach: { addListener: f => detachListeners.push(f) }, sendCommand: (_target, method, params) => {extensionDebuggerCalls++;return send(method, params);} },
    scripting: { executeScript: async ({ func, args = [], target: scope }) => {
      const tree = await send('Page.getFrameTree');
      const frames = [];
      const visit = node => { frames.push(node.frame); node.childFrames?.forEach(visit); }; visit(tree.frameTree);
      const output = [];
      for (const [frameId, frame] of frames.entries()) {
        if (!scope.allFrames && !(scope.frameIds ?? [0]).includes(frameId)) continue;
        const isolated = await send('Page.createIsolatedWorld', { frameId:frame.id, worldName:'agentnexus-vision-test' });
        const result = await send('Runtime.evaluate', { expression:`(${func.toString()})(...${JSON.stringify(args)})`, contextId:isolated.executionContextId, returnByValue:true, awaitPromise:true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        output.push({ frameId, result:result.result.value });
      }
      return output;
    } },
  };
  const driver = await import(pathToFileURL(bundle).href);
  try {
  for (const scenario of [{ dpr:1,width:1000,height:700 },{ dpr:1.25,width:1000,height:700 },{ dpr:2,width:1000,height:700 },
    { dpr:1.25,width:999,height:701 }, { dpr:2,width:1000,height:700,noGutters:true }]) {
    const { dpr,width,height,noGutters } = scenario;
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
    await evaluate(`document.documentElement.style.overflow=${JSON.stringify(noGutters ? 'hidden' : '')}`);
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const metrics = await send('Page.getLayoutMetrics');
    const geometry = await evaluate('({innerWidth,innerHeight,dpr:devicePixelRatio,vv:{width:visualViewport.width,height:visualViewport.height},rect:(()=>{const r=document.querySelector("#target").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}})()})');
    assert.equal(geometry.rect.width,1); assert.equal(geometry.rect.height,1);
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    const png = Buffer.from(shot.data, 'base64');
    const image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    const relative = { x: geometry.rect.x / geometry.innerWidth * 1000, y: geometry.rect.y / geometry.innerHeight * 1000 };
    const old = { x: relative.x / 1000 * metrics.cssVisualViewport.clientWidth, y: relative.y / 1000 * metrics.cssVisualViewport.clientHeight };
    for (const pos of [old, {x:geometry.rect.x,y:geometry.rect.y}]) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pos, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pos, button: 'left', clickCount: 1 });
    }
    const hits = await evaluate('hits.splice(0)');
    assert.equal(hits.at(-1).id, 'target');
    if (!noGutters) assert.notEqual(hits[0].id, 'target', 'Small target must reproduce the old scrollbar offset');
    const snapshot = await driver.captureGuiScreenshot();
    assert.equal(snapshot.viewport.width, geometry.innerWidth);
    assert.equal(snapshot.imageSize.width, image.width);
    const clicked = await driver.executeGui('click', { screenshotId:snapshot.screenshotId, point:relative });
    assert.ok(Math.abs(clicked.coordinateDiagnostics.lastCssPoint.x - geometry.rect.x) < 1e-8);
    const fixedHits = await evaluate('hits.splice(0)');
    assert.equal(fixedHits.length,1); assert.equal(fixedHits[0].id,'target');
    assert.ok(Math.abs(fixedHits[0].x - geometry.rect.x) < 0.01);
    await evaluate('scrollTo(321,432)');
    const scrolled = await driver.captureGuiScreenshot();
    await driver.executeGui('click', { screenshotId:scrolled.screenshotId, point:relative });
    assert.equal((await evaluate('hits.splice(0)'))[0].id,'target');
    await evaluate('scrollTo(0,0)');
    console.log(JSON.stringify({ dpr, image, geometry, cssVisualViewport: metrics.cssVisualViewport, old, hits }));
  }
  const field = await evaluate(`(() => {
    const el=document.createElement('input');el.id='field';el.value='old';el.style='position:fixed;left:40px;top:40px;width:200px';document.body.append(el);
    const r=el.getBoundingClientRect();return {x:(r.x+r.width/2)/innerWidth*1000,y:(r.y+r.height/2)/innerHeight*1000};})()`);
  const inputShot = await driver.captureGuiScreenshot();
  await driver.executeGui('input', { screenshotId:inputShot.screenshotId,point:field,text:'你好👩‍💻',clear:true });
  assert.equal(await evaluate('document.querySelector("#field").value'),'你好👩‍💻');
  const keyShot = await driver.captureGuiScreenshot();
  await driver.executeGui('keyboard', { screenshotId:keyShot.screenshotId,keys:['Shift','a'] });
  assert.equal(await evaluate('document.querySelector("#field").value'),'你好👩‍💻A');
  const typedShot = await driver.captureGuiScreenshot();
  await evaluate('window.keyCounts=0;document.querySelector("#field").addEventListener("keydown",()=>keyCounts++)');
  await driver.executeGui('input',{screenshotId:typedShot.screenshotId,point:field,text:'Aa!?[]{}123',clear:true,inputMode:'keys'});
  assert.equal(await evaluate('document.querySelector("#field").value'),'Aa!?[]{}123');
  assert.ok(await evaluate('keyCounts >= 10'));
  {
    await evaluate(`window.shortcutEvents=[];document.querySelector('#field').addEventListener('keydown',e=>{shortcutEvents.push({key:e.key,code:e.code,location:e.location,ctrl:e.ctrlKey,shift:e.shiftKey});if(e.ctrlKey||e.code.startsWith('Numpad')||e.code==='F24')e.preventDefault();})`);
    for (const keys of [['Ctrl','ShiftRight','a'],['NumpadEnter'],['NumpadAdd'],['Enter'],['F24']]) {
      const shortcutShot=await driver.captureGuiScreenshot();
      await driver.executeGui('keyboard',{screenshotId:shortcutShot.screenshotId,keys});
    }
    const shortcuts=await evaluate('shortcutEvents');
    assert.ok(shortcuts.some(e=>e.code==='KeyA'&&e.key==='A'&&e.ctrl&&e.shift));
    assert.ok(shortcuts.some(e=>e.code==='ShiftRight'&&e.location===2));
    assert.ok(shortcuts.some(e=>e.code==='NumpadEnter'&&e.key==='Enter'&&e.location===3));
    assert.ok(shortcuts.some(e=>e.code==='NumpadAdd'&&e.key==='+'&&e.location===3));
    assert.ok(shortcuts.some(e=>e.code==='Enter'&&e.key==='Enter'&&e.location===0));
    assert.ok(shortcuts.some(e=>e.code==='F24'&&e.key==='F24'));
  }
  const clickShot = await driver.captureGuiScreenshot();
  await evaluate('window.shiftClick=false;document.querySelector("#field").addEventListener("click",e=>shiftClick=e.shiftKey)');
  await driver.executeGui('click',{screenshotId:clickShot.screenshotId,point:field,modifiers:['Shift']});
  assert.equal(await evaluate('shiftClick'),true);
  const scrollerPoint = await evaluate(`(() => {
    const el=document.createElement('div');el.id='scroller';el.tabIndex=0;el.style='position:fixed;left:300px;top:100px;width:200px;height:180px;overflow:auto';
    el.innerHTML='<div style="height:1500px">Scroll content</div>';document.body.append(el);
    const r=el.getBoundingClientRect();return {x:(r.x+80)/innerWidth*1000,y:(r.y+80)/innerHeight*1000};})()`);
  const scrollShot = await driver.captureGuiScreenshot();
  await driver.executeGui('scroll', { screenshotId:scrollShot.screenshotId,point:scrollerPoint,direction:'down',percent:50 });
  assert.ok(await evaluate('document.querySelector("#scroller").scrollTop > 100'));
  assert.equal(await evaluate('scrollY'),0);
  const dragFrom = await evaluate(`(() => {
    const el=document.createElement('div');el.id='dragger';el.setAttribute('role','button');el.style='position:fixed;left:40px;top:160px;width:40px;height:40px;background:blue';document.body.append(el);
    window.dragPoints=[];el.onpointerdown=e=>{el.setPointerCapture(e.pointerId);e.preventDefault();};el.onpointermove=e=>{if(e.buttons)dragPoints.push({x:e.clientX,y:e.clientY});};
    const r=el.getBoundingClientRect();return {x:(r.x+20)/innerWidth*1000,y:(r.y+20)/innerHeight*1000};})()`);
  const dragShot = await driver.captureGuiScreenshot();
  const dragTo = { x:dragFrom.x + 120,y:dragFrom.y + 80 };
  const via = {x:dragFrom.x+60,y:dragFrom.y-80};
  await driver.executeGui('drag', { screenshotId:dragShot.screenshotId,from:dragFrom,to:dragTo,waypoints:[via],durationMs:300 });
  const dragged = await evaluate('dragPoints.at(-1)');
  assert.ok(Math.abs(dragged.x - dragTo.x / 1000 * 1000) < 0.01);
  assert.ok(Math.abs(dragged.y - dragTo.y / 1000 * 700) < 0.01);
  assert.ok(await evaluate(`dragPoints.some(p=>Math.abs(p.x-${via.x})<0.01&&Math.abs(p.y-${via.y/1000*700})<0.01)`));
  const nativeDrag = await evaluate(`(() => {
    const source=document.createElement('div'),drop=document.createElement('div');source.draggable=true;source.id='nativeSource';drop.id='nativeDrop';
    source.textContent='Drag';drop.textContent='Drop';source.style='position:fixed;left:40px;top:400px;width:70px;height:40px;background:green';drop.style='position:fixed;left:300px;top:400px;width:120px;height:70px;background:yellow';
    window.dropped=null;source.ondragstart=e=>e.dataTransfer.setData('text/plain','native-payload');drop.ondragover=e=>e.preventDefault();drop.ondrop=e=>{e.preventDefault();dropped=e.dataTransfer.getData('text/plain');};
    document.body.append(source,drop);const point=e=>{const r=e.getBoundingClientRect();return {x:(r.x+r.width/2)/innerWidth*1000,y:(r.y+r.height/2)/innerHeight*1000};};return {from:point(source),to:point(drop)};
  })()`);
  const nativeShot=await driver.captureGuiScreenshot();
  await driver.executeGui('drag',{screenshotId:nativeShot.screenshotId,...nativeDrag,durationMs:350});
  assert.equal(await evaluate('dropped'),'native-payload');
  const framedPoint = await evaluate(`new Promise(resolve => {
    const el=document.createElement('iframe');el.id='frame';el.style='position:fixed;left:600px;top:300px;width:180px;height:100px';
    el.onload=()=>{el.contentWindow.hit=false;const b=el.contentDocument.querySelector('button');b.onclick=()=>el.contentWindow.hit=true;
      const f=el.getBoundingClientRect(),r=b.getBoundingClientRect();resolve({x:(f.x+el.clientLeft+r.x+r.width/2)/innerWidth*1000,y:(f.y+el.clientTop+r.y+r.height/2)/innerHeight*1000});};
    el.srcdoc='<button id="inside">Inside frame</button>';document.body.append(el);
  })`);
  const frameShot = await driver.captureGuiScreenshot();
  await driver.executeGui('click',{ screenshotId:frameShot.screenshotId,point:framedPoint });
  assert.equal(await evaluate('document.querySelector("#frame").contentWindow.hit'),true);
  const markShot = await driver.captureGuiScreenshot();
  await driver.executeGui('mark',{ screenshotId:markShot.screenshotId });
  const marked = await driver.captureGuiScreenshot();
  assert.ok(marked.elementsCount >= 5);
  let foundFrame = false;
  for (let id=1;id<=marked.elementsCount;id++) {
    const info = await driver.executeGui('inspect',{ screenshotId:marked.screenshotId,id });
    if (info.selector === '#inside') { assert.equal(info.frameId,1); foundFrame=true; }
  }
  assert.ok(foundFrame,'Numbered inspections must retain frame identity');
  { // Action observation/crop checks use a separate fixture scope.
  const guardPoint=await evaluate(`(() => {
    const b=document.createElement('button');b.id='guard-target';b.textContent='Guard Save';b.style='position:fixed;left:800px;top:100px;width:130px;height:35px';window.guardClicks=0;b.onclick=()=>guardClicks++;document.body.append(b);
    const r=b.getBoundingClientRect();return {x:(r.x+r.width/2)/innerWidth*1000,y:(r.y+r.height/2)/innerHeight*1000};})()`);
  const guardShot=await driver.captureGuiScreenshot();
  const guardCheck=await new driver.VisionGuiTool().execute({action:'check',screenshotId:guardShot.screenshotId,point:guardPoint,expect:{enabled:true,nameIncludes:'Guard Save'},stableMs:20,timeoutMs:500});
  assert.equal(guardCheck.success,true);assert.equal(guardCheck.data.status,'passed');assert.ok(guardCheck.data.guardId);
  await evaluate('document.querySelector("#guard-target").disabled=true');
  await assert.rejects(driver.executeGui('click',{screenshotId:guardShot.screenshotId,point:guardPoint,guardId:guardCheck.data.guardId}),e=>e.code==='TARGET_CHANGED');
  assert.equal(await evaluate('guardClicks'),0);
  await evaluate('document.querySelector("#guard-target").disabled=false');
  const allowedShot=await driver.captureGuiScreenshot();
  const allowedCheck=await new driver.VisionGuiTool().execute({action:'check',screenshotId:allowedShot.screenshotId,point:guardPoint,expect:{enabled:true},stableMs:20,timeoutMs:500});
  await driver.executeGui('click',{screenshotId:allowedShot.screenshotId,point:guardPoint,guardId:allowedCheck.data.guardId});
  assert.equal(await evaluate('guardClicks'),1);
  const zoomShot=await driver.captureGuiScreenshot();
  const cropPlan=driver.planCrop(zoomShot.imageSize,{x:900.1,y:800.1,width:99.9,height:199.9},3);
  const rendered=await evaluate(`(${driver.renderPngCrop.toString()})(${JSON.stringify(zoomShot.screenshot.split(',')[1])},${JSON.stringify(cropPlan)})`);
  assert.equal(rendered.imageSize.width,cropPlan.outputWidth);assert.ok(rendered.screenshot.startsWith('data:image/png;base64,'));
  const cropBytes=Buffer.from(rendered.screenshot.split(',')[1],'base64');
  assert.equal(cropBytes.readUInt32BE(16),cropPlan.outputWidth);
  const viewId=driver.registerView(zoomShot.screenshotId,cropPlan.region);
  const fullPoint=await evaluate('(()=>{const r=document.querySelector("#target").getBoundingClientRect();return {x:(r.x+r.width/2)/innerWidth*1000,y:(r.y+r.height/2)/innerHeight*1000};})()');
  const cropPoint={x:(fullPoint.x-cropPlan.region.x)/cropPlan.region.width*1000,y:(fullPoint.y-cropPlan.region.y)/cropPlan.region.height*1000};
  await evaluate('hits.splice(0)');
  await driver.executeGui('click',{screenshotId:zoomShot.screenshotId,viewId,point:cropPoint});
  assert.equal((await evaluate('hits.splice(0)'))[0].id,'target');
  await assert.rejects(driver.executeGui('click',{screenshotId:zoomShot.screenshotId,viewId,point:cropPoint}),e=>e.code==='STALE_SCREENSHOT');
  const verifyShot=await driver.captureGuiScreenshot();
  const verified=await new driver.VisionGuiTool().execute({action:'check',screenshotId:verifyShot.screenshotId,point:field,expect:{valueEquals:'Aa!?[]{}123'},stableMs:0});
  assert.equal(verified.data.status,'passed');
  const unknown=await new driver.VisionGuiTool().execute({action:'check',screenshotId:verifyShot.screenshotId,expect:{textIncludes:'text-that-is-not-rendered'},stableMs:0});
  assert.equal(unknown.data.status,'unknown');
  const canvasPoint=await evaluate(`(() => {
    const proof=document.createElement('div');proof.textContent='Verification complete';proof.style='position:fixed;left:800px;top:180px;width:190px';
    const clipped=document.createElement('div');clipped.textContent='Hidden clipped verification';clipped.style='position:fixed;left:800px;top:220px;width:190px;height:1px;overflow:hidden';
    const canvas=document.createElement('canvas');canvas.style='position:fixed;left:800px;top:270px;width:80px;height:40px';document.body.append(proof,clipped,canvas);
    return {x:840/innerWidth*1000,y:290/innerHeight*1000};})()`);
  const evidenceShot=await driver.captureGuiScreenshot();
  const visibleProof=await new driver.VisionGuiTool().execute({action:'check',screenshotId:evidenceShot.screenshotId,expect:{textIncludes:'Verification complete'},stableMs:0});
  assert.equal(visibleProof.data.status,'passed');
  const clippedProof=await new driver.VisionGuiTool().execute({action:'check',screenshotId:evidenceShot.screenshotId,expect:{textIncludes:'Hidden clipped verification'},stableMs:0});
  assert.equal(clippedProof.data.status,'unknown');
  const canvasProof=await new driver.VisionGuiTool().execute({action:'check',screenshotId:evidenceShot.screenshotId,point:canvasPoint,stableMs:20,timeoutMs:500});
  assert.equal(canvasProof.data.target.opaqueContent,true);assert.equal(canvasProof.data.guardId,undefined);
  }
  // Guide observations use production driver/transport and isolated payloads.
  {
  const beforeGuideDebuggerCalls=extensionDebuggerCalls;
  await send('Emulation.setDeviceMetricsOverride', { width:1000,height:700,deviceScaleFactor:1,mobile:false });
  const guide = Object.fromEntries(driver.createVisionReadTools().map(tool=>[tool.name,tool]));
  const fixture = await evaluate(`(() => {
    document.body.innerHTML='<button id="danger" disabled>Delete account</button><input id="pw" type="password" value="never-return-this"><div id="readPane" style="position:fixed;left:250px;top:100px;width:200px;height:180px;overflow:auto"><div style="width:900px;height:1600px">READABLE TEXT</div></div><iframe id="readFrame" style="position:fixed;left:500px;top:100px;width:250px;height:200px"></iframe>';
    document.documentElement.style.overflow='';scrollTo(0,0);
    window.guideClicks=0;window.guideFocus=0;window.guideWheels=0;
    document.addEventListener('click',()=>guideClicks++);document.addEventListener('focusin',()=>guideFocus++);document.addEventListener('wheel',()=>guideWheels++);
    const point=el=>{const r=el.getBoundingClientRect();return {x:(r.x+30)/innerWidth*1000,y:(r.y+30)/innerHeight*1000}};
    return {pane:point(document.querySelector('#readPane')),frame:point(document.querySelector('#readFrame'))};
  })()`);
  let guideShot=await driver.captureGuiScreenshot(undefined,'observe');
  const observed=await guide.vision_read.execute({screenshotId:guideShot.screenshotId});
  assert.equal(observed.success,true,observed.error);
  assert.ok(observed.data.text.includes('READABLE TEXT'));
  assert.equal(JSON.stringify(observed).includes('never-return-this'),false);
  assert.equal(observed.data.controls.find(el=>el.name==='Delete account').disabled,true);
  const moved=await guide.vision_read_scroll.execute({screenshotId:guideShot.screenshotId,point:fixture.pane,direction:'down',percent:50});
  assert.equal(moved.success,true,moved.error);assert.ok(Math.abs(moved.data.delta.y-moved.data.container.height*0.5)<=0.5);
  assert.equal(await evaluate('scrollY'),0);
  assert.equal((await guide.vision_read.execute({screenshotId:guideShot.screenshotId})).success,false,'Scroll consumes source');
  guideShot=await driver.captureGuiScreenshot(undefined,'observe');
  const horizontal=await guide.vision_read_scroll.execute({screenshotId:guideShot.screenshotId,point:fixture.pane,direction:'right',percent:50});
  assert.equal(horizontal.success,true,horizontal.error);assert.ok(Math.abs(horizontal.data.delta.x-horizontal.data.container.width*0.5)<=0.5);
  await evaluate('document.querySelector("#readPane").scrollTop=9999');
  guideShot=await driver.captureGuiScreenshot(undefined,'observe');
  const boundary=await guide.vision_read_scroll.execute({screenshotId:guideShot.screenshotId,point:fixture.pane,direction:'down'});
  assert.equal(boundary.success,true,boundary.error);assert.equal(boundary.data.moved,false);assert.equal(await evaluate('scrollY'),0);
  await evaluate(`new Promise(resolve=>{const f=document.querySelector('#readFrame');f.onload=()=>resolve();f.srcdoc='<div style="height:1800px">Frame content</div>';})`);
  guideShot=await driver.captureGuiScreenshot(undefined,'observe');
  const framed=await guide.vision_read_scroll.execute({screenshotId:guideShot.screenshotId,point:fixture.frame,direction:'down',percent:50});
  assert.equal(framed.success,true,framed.error);assert.ok(framed.data.delta.y>50);assert.equal(framed.data.container.frameDepth,1);
  assert.equal(await evaluate('scrollY'),0);
  const ready=await guide.vision_read_wait.execute({timeoutMs:800});
  assert.equal(ready.success,true,ready.error);assert.equal(ready.data.imageKind,'viewport');assert.ok(ready.data.screenshotId);
  assert.equal(ready.data.geometryStable,true);
  const cropPlan=driver.planCrop(ready.data.imageSize,{x:0,y:0,width:100,height:100},2);
  const crop=await evaluate(`(${driver.renderPngCrop.toString()})(${JSON.stringify(ready.data.screenshot.split(',')[1])},${JSON.stringify(cropPlan)})`);
  const cropBytes=Buffer.from(crop.screenshot.split(',')[1],'base64');
  assert.equal(cropBytes.readUInt32BE(16),200);assert.equal(cropBytes.readUInt32BE(20),140);
  assert.deepEqual(await evaluate('({clicks:guideClicks,focus:guideFocus,wheels:guideWheels})'),{clicks:0,focus:0,wheels:0});
  assert.equal(await evaluate('document.querySelector("#pw").value'),'never-return-this');
  assert.equal((await guide.vision_read_scroll.execute({screenshotId:ready.data.screenshotId,direction:'down',clickBox:[0,0,10,10]})).success,false);
  await evaluate('document.querySelector("#readFrame").style.transform="rotate(180deg)"');
  const transformedShot=await driver.captureGuiScreenshot(undefined,'observe');
  const transformed=await guide.vision_read_scroll.execute({screenshotId:transformedShot.screenshotId,point:fixture.frame,direction:'down'});
  assert.equal(transformed.success,false);assert.match(transformed.error,/Transformed/);
  await evaluate('document.querySelector("#readFrame").style.transform="";document.documentElement.style.overflowY="hidden"');
  const lockedShot=await driver.captureGuiScreenshot(undefined,'observe');
  const locked=await guide.vision_read_scroll.execute({screenshotId:lockedShot.screenshotId,direction:'down'});
  assert.equal(locked.success,true,locked.error);assert.equal(locked.data.moved,false);assert.match(locked.data.reason,/locked/);
  const cancelled=new AbortController();cancelled.abort();
  assert.equal((await guide.vision_read_wait.execute({timeoutMs:800},{signal:cancelled.signal})).success,false);
  assert.equal(extensionDebuggerCalls,beforeGuideDebuggerCalls,'Guide capture/read/scroll/wait must never issue chrome.debugger calls');
  console.log('[vision-browser] Guide: bounded visible reads/password exclusion, nested and horizontal scroll without click/focus/wheel, edge stop, same-origin iframe, readiness refresh, original-image crop and cancellation passed.');
  }
  console.log('[vision-browser] Production driver: exact 1 CSS-pixel target hits at DPR 1/1.25/2, fractional physical dimensions, with/without gutters, document scrolling, Unicode clear/type and Shift+A passed.');
  console.log('[vision-browser] Nested wheel routing, exact drag endpoint, iframe click and cross-frame numbered DOM inspection passed.');
  console.log('[vision-browser] Shift-click, printable key events, waypoint drawing and native HTML5 drag/drop passed.');
  console.log('[vision-browser] Native PNG crop, view coordinate mapping, guard rejection/acceptance and explicit value/unknown checks passed.');
  } finally { await driver.cdpSession.detachAll(); }
} finally {
  socket?.close(); child.kill(); await new Promise(resolve => server.close(resolve));
}

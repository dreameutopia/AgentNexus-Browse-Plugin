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
  res.end('<!doctype html><style>body{margin:0;width:2500px;height:3500px}#target{position:fixed;right:35px;bottom:35px;width:8px;height:8px;background:red}</style><button id="target"></button><script>window.hits=[];addEventListener("pointerdown",e=>hits.push({x:e.clientX,y:e.clientY,id:e.target.id}));</script>');
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
  globalThis.chrome = {
    tabs: { query: async () => [{ id:1, windowId:1, url:`http://127.0.0.1:${server.address().port}` }] },
    runtime: { getPlatformInfo: async () => ({ os: process.platform === 'darwin' ? 'mac' : 'win' }) },
    debugger: { attach: async () => {}, detach: async () => { detachListeners.forEach(f => f({ tabId:1 })); },
      onDetach: { addListener: f => detachListeners.push(f) }, sendCommand: (_target, method, params) => send(method, params) },
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
    const geometry = await evaluate('({innerWidth,innerHeight,dpr:devicePixelRatio,vv:{width:visualViewport.width,height:visualViewport.height},rect:(()=>{const r=document.querySelector("#target").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()})');
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    const png = Buffer.from(shot.data, 'base64');
    const image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    const relative = { x: geometry.rect.x / geometry.innerWidth * 1000, y: geometry.rect.y / geometry.innerHeight * 1000 };
    const old = { x: relative.x / 1000 * metrics.cssVisualViewport.clientWidth, y: relative.y / 1000 * metrics.cssVisualViewport.clientHeight };
    for (const pos of [old, geometry.rect]) {
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
  await driver.executeGui('drag', { screenshotId:dragShot.screenshotId,from:dragFrom,to:dragTo,durationMs:300 });
  const dragged = await evaluate('dragPoints.at(-1)');
  assert.ok(Math.abs(dragged.x - dragTo.x / 1000 * 1000) < 0.01);
  assert.ok(Math.abs(dragged.y - dragTo.y / 1000 * 700) < 0.01);
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
  console.log('[vision-browser] Production driver: exact small-target hits at DPR 1/1.25/2, fractional physical dimensions, with/without gutters, document scrolling, Unicode clear/type and Shift+A passed.');
  console.log('[vision-browser] Nested wheel routing, exact drag endpoint, iframe click and cross-frame numbered DOM inspection passed.');
  } finally { await driver.cdpSession.detachAll(); }
} finally {
  socket?.close(); child.kill(); await new Promise(resolve => server.close(resolve));
}

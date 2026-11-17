/** Real Chromium CDP input in two isolated test windows. No user profile is used.
 * Tabs/windows extension calls are adapted to real CDP targets; this validates
 * background focus/input, not the OS foreground or extension installation UI.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';

const outfile = path.resolve('node_modules/.cache/window-binding-browser-driver.mjs');
await build({ entryPoints: ['tests/tools/window-binding-browser-entry.ts'], outfile, bundle: true, platform: 'node', format: 'esm', target: 'es2022' });
const executable = [process.env.TEXT_CHROMIUM_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && existsSync(file));
if (!executable) throw Error('Set TEXT_CHROMIUM_PATH to a Chromium executable');
const profile = mkdtempSync(path.join(tmpdir(), 'agentnexus-bound-window-'));
const child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true });
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>Binding test</title><input id="field"><script>window.inputEvents=[];field.addEventListener("input",e=>inputEvents.push(e.isTrusted));</script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let socket, driver;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Chrome startup timeout')), 15000);
    child.once('error', reject);
    child.once('exit', code => reject(Error(`Chrome exited: ${code}`)));
    child.stderr.on('data', chunk => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  const commands = [];
  socket.addEventListener('message', event => {
    const result = JSON.parse(event.data);
    const item = pending.get(result.id);
    if (!item) return;
    pending.delete(result.id);
    clearTimeout(item.timer);
    if (result.error) item.reject(Error(result.error.message)); else item.resolve(result.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    commands.push({ method, params, sessionId });
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const targets = new Map();
  for (const id of [101, 202]) {
    const { targetId } = await send('Target.createTarget', { url: `http://127.0.0.1:${server.address().port}/${id}`, newWindow: true });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const { windowId } = await send('Browser.getWindowForTarget', { targetId });
    targets.set(id, { id, targetId, sessionId, windowId, active: true, url: `http://127.0.0.1:${server.address().port}/${id}` });
    await send('Runtime.enable', {}, sessionId);
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await send('Runtime.evaluate', { expression: '!!document.querySelector("#field")', returnByValue: true }, sessionId);
      if (response.result.value) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  const agent = targets.get(101), user = targets.get(202);
  assert.notEqual(agent.windowId, user.windowId);
  await send('Page.bringToFront', {}, user.sessionId);
  const evaluate = async (tab, expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }, tab.sessionId)).result.value;
  await evaluate(user, 'field.focus();field.value="user typing";document.hasFocus()');
  const hooks = { addListener() { }, removeListener() { } };
  globalThis.chrome = {
    tabs: {
      query: async input => [...targets.values()].filter(tab => (input.windowId === undefined || input.windowId === tab.windowId) &&
        (!(input.currentWindow || input.lastFocusedWindow) || tab.id === 202)).map(tab => ({ ...tab })),
      get: async id => { if (!targets.has(id)) throw Error('No such tab'); return { ...targets.get(id) }; },
    },
    windows: {
      WINDOW_ID_CURRENT: -2, get: async windowId => {
        await send('Browser.getWindowBounds', { windowId }); return { id: windowId, type: 'normal' };
      }
    },
    debugger: {
      onDetach: hooks,
      attach: async () => { }, detach: async () => { },
      sendCommand: (debuggee, method, params) => send(method, params, targets.get(debuggee.tabId).sessionId),
    },
    scripting: {},
  };
  driver = await import(pathToFileURL(outfile).href);
  const before = commands.length;
  const scope = { browserScope: { mode: 'bound-window', windowId: agent.windowId } };
  await driver.executeWithBrowserScope(scope, async context => {
    const tab = await driver.textTab(context);
    assert.equal(tab.id, 101, 'The active user window must not become the agent target');
    await evaluate(agent, 'field.focus()');
    assert.equal(await evaluate(agent, 'document.hasFocus()'), true, 'Focus emulation must satisfy real page guards');
    await driver.textCommand(tab.id, 'Input.insertText', { text: 'agent typing' }, 8000, context);
    const image = await driver.browserChrome(context).debugger.sendCommand({ tabId: tab.id }, 'Page.captureScreenshot', { format: 'png' });
    assert.ok(image.data.length > 100);
    await assert.rejects(() => driver.browserChrome(context).debugger.sendCommand({ tabId: 202 }, 'Input.insertText', { text: 'wrong' }), /TAB_OUTSIDE_BOUND_WINDOW/);
  });
  assert.equal(await evaluate(agent, 'field.value'), 'agent typing');
  assert.equal(await evaluate(agent, 'inputEvents.every(Boolean)'), true, 'Input events must be trusted browser input');
  assert.equal(await evaluate(user, 'field.value'), 'user typing');
  assert.equal(await evaluate(user, 'document.activeElement.id'), 'field');
  assert.equal(commands.slice(before).some(command => ['Page.bringToFront', 'Target.activateTarget'].includes(command.method)), false);
  assert.equal(commands.filter(command => command.method === 'Emulation.setFocusEmulationEnabled').at(-1).params.enabled, false);
  await send('Target.closeTarget', { targetId: agent.targetId });
  targets.delete(101);
  await assert.rejects(() => driver.browserChrome(scope).tabs.query({ active: true }), /BOUND_WINDOW_CLOSED/);
  console.log('[window-binding-browser] Real Chromium: two windows, background trusted input, CDP screenshot, foreign target refusal, no activation commands, focus cleanup and closed-window refusal passed.');
} finally {
  if (driver) await driver.cdpSession.detachAll();
  socket?.close();
  child.kill();
  await new Promise(resolve => server.close(resolve));
}

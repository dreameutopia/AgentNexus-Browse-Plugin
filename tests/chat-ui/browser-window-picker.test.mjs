import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const file = path.resolve('entrypoints/sidepanel/components/chat/BrowserWindowPicker.vue');
const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file });
const script = compileScript(descriptor, { id: 'browser-window-picker', inlineTemplate: true });
const out = path.resolve('node_modules/.cache/browser-window-picker-test.mjs');
mkdirSync(path.dirname(out), { recursive: true });
await build({
  stdin: { contents: script.content, loader: 'ts', resolveDir: path.dirname(file) },
  outfile: out, bundle: true, platform: 'node', format: 'esm', external: ['vue'],
  plugins: [{
    name: 'test-i18n', setup(api) {
      api.onResolve({ filter: /^vue-i18n$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
      api.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        resolveDir: process.cwd(), contents:
          `import messages from './utils/i18n/locales/zh-CN.ts';
       export const useI18n=()=>({t:(key,values)=>{let text=key.split('.').reduce((item,part)=>item?.[part],messages)||key;for(const [name,value] of Object.entries(values||{}))text=text.replaceAll('{'+name+'}',String(value));return text;}});` }));
    }
  }],
});
const dom = new JSDOM('<div id="app"></div>', { url: 'https://extension.test/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'Event', 'PointerEvent', 'KeyboardEvent'])
  if (dom.window[key]) globalThis[key] = dom.window[key];
const eventHook = () => {
  const listeners = new Set(); return {
    addListener: callback => listeners.add(callback), removeListener: callback => listeners.delete(callback),
    emit: (...args) => { for (const callback of listeners) callback(...args); },
    get size() { return listeners.size; },
  };
};
const changed = eventHook(), removed = eventHook(), created = eventHook();
const session = {};
const windows = new Map([[1, { id: 1, type: 'normal', tabs: [{ title: 'Work', active: true }] }],
[2, { id: 2, type: 'normal', tabs: [{ title: 'Personal', active: true }] }]]);
let writeFailure;
let disconnectBeforeReply = false;
let mismatchedReply = false;
let activeConnections = 0;
globalThis.chrome = {
  runtime: {
    // A competing broadcast recipient may return an empty response. Saving must
    // use the dedicated worker port, never this first-response-wins channel.
    sendMessage: async () => null,
    connect: ({ name }) => {
      assert.equal(name, 'agentnexus:browser-window-binding-write:v1');
      activeConnections++;
      const onMessage = eventHook(), onDisconnect = eventHook();
      let closed = false;
      return {
        onMessage, onDisconnect,
        postMessage: message => {
          void (async () => {
            if (disconnectBeforeReply) { onDisconnect.emit(); return; }
            const reply = { id: mismatchedReply ? 'wrong-request' : message.id, ok: false };
            if (writeFailure) reply.error = writeFailure;
            else if (message.browserScope && !windows.has(message.browserScope.windowId)) reply.error = 'Window closed';
            else {
              const key = `beta.browserWindowBinding.${message.chatId}`;
              if (message.browserScope) await chrome.storage.session.set({ [key]: message.browserScope });
              else await chrome.storage.session.remove(key);
              reply.ok = true;
            }
            if (!closed) onMessage.emit(reply);
          })();
        },
        disconnect: () => { if (!closed) activeConnections--; closed = true; },
      };
    },
  },
  storage: {
    onChanged: changed, session: {
      get: async key => ({ [key]: session[key] }),
      set: async data => { Object.assign(session, data); for (const [key, newValue] of Object.entries(data)) changed.emit({ [key]: { newValue } }, 'session'); },
      remove: async key => { delete session[key]; changed.emit({ [key]: {} }, 'session'); },
    }
  },
  windows: {
    getCurrent: async () => windows.get(1), getAll: async () => [...windows.values()],
    get: async id => { if (!windows.has(id)) throw Error('closed'); return windows.get(id); },
    onRemoved: removed, onCreated: created,
  },
};
const { createApp, h, reactive, ref } = await import('vue');
const { default: Picker } = await import(pathToFileURL(out).href);
const props = reactive({ chatId: '', busy: false });
const picker = ref();
const app = createApp({ setup: () => () => h(Picker, { ...props, ref: picker }) });
app.mount('#app');
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const trigger = () => document.querySelector('.browser-window-trigger');
const options = () => [...document.querySelectorAll('.browser-window-option')];
await settle();
assert.equal(trigger().classList.contains('bound'), false, 'New sessions default to Beta off');
trigger().click(); await settle();
assert.equal(options().length, 3, 'Menu offers off, own window and another existing window');
options()[1].click(); await settle();
assert.equal(session['beta.browserWindowBinding.draft:1'].windowId, 1);
assert.ok(trigger().classList.contains('bound'));
await picker.value.prepareDraftBinding()('chat-a');
props.chatId = 'chat-a'; await settle();
assert.equal(session['beta.browserWindowBinding.chat-a'].windowId, 1, 'First-message session inherits the draft binding');
assert.equal(session['beta.browserWindowBinding.draft:1'], undefined, 'Consumed draft binding is cleared');
trigger().click(); await settle();
writeFileSync(path.resolve('node_modules/.cache/browser-window-picker-preview.html'),
  '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#f7f7f8;font:13px system-ui;color:#222}.composer{position:fixed;bottom:14px;left:12px;right:12px;border:1px solid #ddd;border-radius:16px;background:white;padding:14px}.prompt{color:#888;margin:0 0 18px}.row{display:flex;align-items:center;gap:10px}.model{border:0;background:#f4f4f5;border-radius:7px;padding:7px 10px;color:#444}.input-action-btn{display:flex;align-items:center;justify-content:center;border:0;border-radius:7px;width:30px;height:30px;background:transparent;color:#666}.browser-window-menu{bottom:112px!important}' +
  descriptor.styles.map(style => style.content).join('\n') + '</style><div class="composer"><p class="prompt">让 AI 在指定窗口中工作…</p><div class="row"><button class="model">GPT ▾</button>' +
  document.querySelector('.browser-window-picker').outerHTML + '</div></div>');
options()[2].click(); await settle();
assert.equal(session['beta.browserWindowBinding.chat-a'].windowId, 2, 'Another existing window can be selected');
props.busy = true; trigger().click(); await settle();
assert.equal(trigger().disabled, true, 'The entire operation-window entry is disabled during a task');
assert.equal(options().length, 0, 'A running task closes the picker and cannot reopen it');
props.busy = false; await settle();
windows.delete(2); removed.emit(2); await settle();
assert.ok(trigger().classList.contains('unavailable'));
// The worker owns reset; emulate its storage broadcast to this mounted view.
await chrome.storage.session.remove('beta.browserWindowBinding.chat-a'); await settle();
assert.equal(session['beta.browserWindowBinding.chat-a'], undefined);
assert.equal(trigger().classList.contains('bound'), false);
props.chatId = 'chat-b'; await settle();
assert.equal(trigger().classList.contains('bound'), false, 'Unrelated chats do not inherit a binding');
trigger().click(); await settle();
await chrome.storage.session.set({ 'beta.browserWindowBusyChats': ['chat-b'] }); await settle();
assert.equal(trigger().disabled, true, 'A task started in another sidebar also disables the whole entry');
assert.equal(options().length, 0, 'A remote task closes an already open picker');
await chrome.storage.session.set({ 'beta.browserWindowBusyChats': [] }); await settle();
assert.equal(trigger().disabled, false, 'Remote task settlement unlocks the picker');
trigger().click(); await settle();
writeFailure = 'BROWSER_BINDING_BUSY: another panel is running';
options()[1].click(); await settle();
await assert.rejects(picker.value.captureBinding(), /another panel is running/, 'A failed save must block sending with the old selection');
assert.match(document.body.textContent, /another panel is running/);
writeFailure = undefined;
options()[1].click(); await settle();
assert.equal((await picker.value.captureBinding()).windowId, 1, 'A successful retry clears the failed-save guard');
trigger().click(); await settle();
disconnectBeforeReply = true;
options()[0].click(); await settle();
await assert.rejects(picker.value.captureBinding(), /重新加载扩展/, 'Missing or stale worker provides an actionable error');
disconnectBeforeReply = false;
mismatchedReply = true;
options()[0].click(); await settle();
await assert.rejects(picker.value.captureBinding(), /不匹配/, 'An unrelated reply cannot confirm a save');
mismatchedReply = false;
options()[0].click(); await settle();
assert.equal(await picker.value.captureBinding(), undefined);
assert.equal(activeConnections, 0, 'Every completed or failed save releases its worker port');
app.unmount();
assert.equal(changed.size + removed.size + created.size, 0, 'All listeners are released');
console.log('[browser-window-picker] Defaults, both window choices, draft migration, busy guard, closure, disable and session switching passed.');

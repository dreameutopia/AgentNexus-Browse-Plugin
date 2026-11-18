/**
 * 元素捕获「操作窗口」回归
 *
 * 覆盖：点击输入框左下角「元素捕获」时的目标标签页解析必须与「校验元素」
 * 同口径 —— 绑定了操作窗口就只在该窗口内取标签页并把窗口带到前台，绝不回退
 * 到侧边栏当前窗口；失败路径给出可执行提示且不广播 START；标签页切换事件按
 * 捕获所在窗口过滤，侧边栏窗口切标签页不得误杀捕获。
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const out = path.resolve('node_modules/.cache/element-capture-window-test.mjs');
mkdirSync(path.dirname(out), { recursive: true });

await build({
  stdin: {
    contents: `import { useElementCapture } from './entrypoints/sidepanel/composables/use-element-capture.ts';\nimport { ELEMENT_CAPTURE_MESSAGE } from './utils/element-capture/protocol.ts';\nexport { useElementCapture, ELEMENT_CAPTURE_MESSAGE };`,
    loader: 'ts',
    resolveDir: root,
    sourcefile: 'element-capture-window-entry.ts',
  },
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['vue'],
  plugins: [{
    name: 'element-capture-window-stubs',
    setup(api) {
      // 统一处理 `@/` 别名：i18n 换成真实 zh-CN 目录的轻量 t，其余走正常解析
      api.onResolve({ filter: /^@\// }, async args => {
        if (args.path === '@/utils/i18n') return { path: 'i18n', namespace: 'stub' };
        const resolved = await api.resolve(path.resolve(root, args.path.slice(2)), {
          kind: args.kind,
          importer: args.importer,
          resolveDir: root,
        });
        if (resolved.errors.length) return { errors: resolved.errors };
        return { path: resolved.path, external: resolved.external };
      });
      api.onResolve({ filter: /use-app-dialog$/ }, () => ({ path: 'app-dialog', namespace: 'stub' }));
      api.onResolve({ filter: /image-store$/ }, () => ({ path: 'image-store', namespace: 'stub' }));
      api.onLoad({ filter: /^(i18n|app-dialog|image-store)$/, namespace: 'stub' }, args => {
        if (args.path === 'i18n') {
          return {
            resolveDir: root,
            contents: `import messages from './utils/i18n/locales/zh-CN.ts';
globalThis.__I18N_MESSAGES__ = messages;
export const t = (key, values) => {
  const text = key.split('.').reduce((item, part) => item?.[part], messages);
  if (typeof text !== 'string') throw new Error('missing i18n key: ' + key);
  let out = text;
  for (const [name, value] of Object.entries(values || {})) out = out.replaceAll('{' + name + '}', String(value));
  return out;
};`,
          };
        }
        if (args.path === 'app-dialog') {
          return {
            contents: `globalThis.__ALERTS__ ||= [];
export const showAlert = async (message, title) => { globalThis.__ALERTS__.push({ message, title }); return true; };
export const showConfirm = async () => true;
export const showAction = async () => 'confirm';`,
          };
        }
        return { contents: `export const imageStore = { putFromDataUrl: async () => null };` };
      });
    },
  }],
});

/* ------------------------------- chrome 桩 ------------------------------- */

const hooks = {
  runtimeMessage: new Set(),
  activated: new Set(),
  updated: new Set(),
  removed: new Set(),
};
const queries = [];
const sent = [];
const focused = [];
const alerts = [];
globalThis.__ALERTS__ = alerts;

/** 侧边栏所在窗口 = 1；绑定的操作窗口 = 2；3 只有 chrome:// 页面；4 是空窗口 */
const windows = new Map([
  [1, [
    { id: 11, windowId: 1, active: true, url: 'https://panel-window.test/page', title: 'Panel' },
    { id: 12, windowId: 1, active: false, url: 'https://panel-window.test/other', title: 'Other' },
  ]],
  [2, [
    { id: 21, windowId: 2, active: true, url: 'https://bound-window.test/page', title: 'Bound' },
    { id: 22, windowId: 2, active: false, url: 'https://bound-window.test/other', title: 'Bound other' },
  ]],
  [3, [{ id: 31, windowId: 3, active: true, url: 'chrome://settings/', title: 'Settings' }]],
  [4, []],
]);

let queryThrows = false;
let autoReady = true;
let injectionAllowed = true;

const emitRuntime = (message, sender) => {
  for (const listener of [...hooks.runtimeMessage]) listener(message, sender, () => {});
};

globalThis.chrome = {
  runtime: {
    id: 'test-extension',
    lastError: null,
    getURL: (p) => `chrome-extension://test-extension/${p}`,
    onMessage: {
      addListener: (fn) => hooks.runtimeMessage.add(fn),
      removeListener: (fn) => hooks.runtimeMessage.delete(fn),
    },
    sendMessage: async () => null,
  },
  tabs: {
    query: async (info) => {
      queries.push({ ...info });
      if (queryThrows) throw new Error('No window with id: 99');
      if (info.windowId !== undefined) return windows.get(info.windowId) ?? [];
      const current = windows.get(1) ?? [];
      return info.active ? current.filter((tab) => tab.active) : current;
    },
    sendMessage: (tabId, message) => {
      sent.push({ tabId, message });
      if (autoReady && message?.type === ELEMENT_CAPTURE_MESSAGE.START) {
        emitRuntime(
          { type: ELEMENT_CAPTURE_MESSAGE.READY, isTopFrame: true, url: 'https://bound-window.test/page' },
          { tab: { id: tabId }, frameId: 0 },
        );
      }
      return Promise.resolve({ ok: true });
    },
    onActivated: {
      addListener: (fn) => hooks.activated.add(fn),
      removeListener: (fn) => hooks.activated.delete(fn),
    },
    onUpdated: {
      addListener: (fn) => hooks.updated.add(fn),
      removeListener: (fn) => hooks.updated.delete(fn),
    },
    onRemoved: {
      addListener: (fn) => hooks.removed.add(fn),
      removeListener: (fn) => hooks.removed.delete(fn),
    },
  },
  windows: {
    update: async (windowId, updateInfo) => {
      focused.push({ windowId, updateInfo });
      if (!windows.has(windowId)) throw new Error('No window with id: ' + windowId);
      return { id: windowId };
    },
    onRemoved: { addListener: () => {}, removeListener: () => {} },
    onCreated: { addListener: () => {}, removeListener: () => {} },
  },
  scripting: {
    executeScript: async () => {
      if (!injectionAllowed) throw new Error('Cannot access contents of the page');
      return [];
    },
  },
};

/* -------------------------------- 挂载 -------------------------------- */

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'https://extension.test/',
});
for (const key of [
  'window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver',
  'Event', 'KeyboardEvent',
]) {
  if (dom.window[key]) globalThis[key] = dom.window[key];
}

const { createApp, h } = await import('vue');
const { useElementCapture, ELEMENT_CAPTURE_MESSAGE } = await import(pathToFileURL(out).href);
const zh = globalThis.__I18N_MESSAGES__;

let capture;
const app = createApp({
  setup() {
    capture = useElementCapture();
    return () => h('div');
  },
});
app.mount('#app');

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
function reset() {
  capture.stop({ silent: true });
  queries.length = 0;
  sent.length = 0;
  focused.length = 0;
  alerts.length = 0;
}
const alertMessage = () => alerts.at(-1)?.message;
const messages = zh.sidepanel.elementCapture;

try {
  /* 1. 绑定操作窗口：只查该窗口、把窗口带到前台、START 发给该窗口的活动标签页 */
  await capture.start({ scope: { mode: 'bound-window', windowId: 2 } });
  assert.deepEqual(queries.at(-1), { windowId: 2 }, '绑定操作窗口时按 windowId 查询');
  assert.ok(
    !queries.some((query) => 'currentWindow' in query),
    '绑定操作窗口时绝不回退到侧边栏当前窗口',
  );
  assert.deepEqual(
    focused,
    [{ windowId: 2, updateInfo: { focused: true } }],
    '操作窗口在别的窗口时必须带到前台，否则点击后毫无反馈',
  );
  assert.equal(sent.at(-1).tabId, 21, 'START 发给操作窗口的活动标签页');
  assert.equal(sent.at(-1).message.type, ELEMENT_CAPTURE_MESSAGE.START);
  assert.equal(capture.isCapturing.value, true);

  /* 2. 标签页切换按「捕获所在窗口」过滤 */
  for (const listener of [...hooks.activated]) listener({ tabId: 11, windowId: 1 });
  assert.equal(capture.isCapturing.value, true, '侧边栏窗口切标签页不得结束捕获');
  for (const listener of [...hooks.activated]) listener({ tabId: 21, windowId: 2 });
  assert.equal(capture.isCapturing.value, true, '重新激活捕获标签页不结束捕获');
  for (const listener of [...hooks.activated]) listener({ tabId: 22, windowId: 2 });
  assert.equal(capture.isCapturing.value, false, '操作窗口内切走标签页才结束捕获');
  assert.equal(sent.at(-1).message.type, ELEMENT_CAPTURE_MESSAGE.STOP);

  /* 3. 未绑定（跟随模式）：仍跟随侧边栏所在窗口，且不抢焦点 */
  reset();
  await capture.start();
  assert.deepEqual(queries.at(-1), { currentWindow: true }, '跟随模式查询侧边栏所在窗口');
  assert.equal(focused.length, 0, '跟随模式不主动抢焦点');
  assert.equal(sent.at(-1).tabId, 11, 'START 发给当前窗口的活动标签页');
  assert.equal(capture.isCapturing.value, true);

  /* 4. 操作窗口已关闭：查询失败必须中止，绝不回退到当前窗口 */
  reset();
  queryThrows = true;
  await capture.start({ scope: { mode: 'bound-window', windowId: 99 } });
  queryThrows = false;
  assert.equal(capture.isCapturing.value, false, '查询失败不得进入捕获态');
  assert.equal(sent.length, 0, '查询失败不得广播 START');
  assert.equal(alertMessage(), messages.captureWindowUnavailable);

  /* 5. 操作窗口里没有网页 */
  reset();
  await capture.start({ scope: { mode: 'bound-window', windowId: 4 } });
  assert.equal(capture.isCapturing.value, false);
  assert.equal(sent.length, 0);
  assert.equal(alertMessage(), messages.captureNoTab);

  /* 6. 操作窗口的活动页不支持捕获：先把窗口带到前台，再提示（不广播 START） */
  reset();
  await capture.start({ scope: { mode: 'bound-window', windowId: 3 } });
  assert.equal(capture.isCapturing.value, false);
  assert.equal(sent.length, 0);
  assert.deepEqual(
    focused,
    [{ windowId: 3, updateInfo: { focused: true } }],
    '提示里的「当前页面」必须是用户正看着的那个页面',
  );
  assert.equal(alertMessage(), messages.captureUnsupportedPage);

  /* 7. 页面拒绝注入脚本：提示带可执行下一步（含真实原因） */
  reset();
  autoReady = false;
  injectionAllowed = false;
  await capture.start({ scope: { mode: 'bound-window', windowId: 2 } });
  autoReady = true;
  injectionAllowed = true;
  assert.equal(capture.isCapturing.value, false, '补注入失败必须退出捕获态');
  assert.equal(alertMessage(), messages.captureInjectDenied.replace('{reason}', 'Cannot access contents of the page'));

  /* 8. 卸载时释放全部监听 */
  app.unmount();
  assert.equal(hooks.runtimeMessage.size, 0, 'onMessage 监听已释放');
  assert.equal(hooks.activated.size, 0, 'onActivated 监听已释放');
  assert.equal(hooks.updated.size, 0, 'onUpdated 监听已释放');
  assert.equal(hooks.removed.size, 0, 'onRemoved 监听已释放');

  await settle();
  console.log(
    '[element-capture-window] Bound-window targeting, focus, tab-activation filtering, failure alerts and listener release passed.',
  );
} finally {
  if (capture) capture.stop({ silent: true });
  dom.window.close();
}

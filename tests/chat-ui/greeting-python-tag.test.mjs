/**
 * 欢迎语 · Python 安装引导标签（GreetingPythonTag）回归测试
 *
 * 覆盖「按环境状态实时显隐」契约：
 *   1. 未安装（空存储）挂载 → 标签可见，文案正确；
 *   2. 安装完成（storage 推送 status=ready）→ 标签立即消失（无需刷新）；
 *   3. 删除环境（推送 status=idle）→ 标签重新出现（双向实时）；
 *   4. 已安装状态挂载 → 开屏不展示（不闪现）；
 *   5. 点击 → 触发 open 事件（导航交给 App.vue 的 openHubWithHash）；
 *   6. 卸载 → storage 订阅退订（不留监听器泄漏）。
 *
 * 走真实组件 + 真实 pyodide-env 模块（chrome.storage 桩模拟跨上下文推送），
 * i18n 用真实中文目录（断言真实文案而非 key）。
 *
 * 运行：node tests/chat-ui/greeting-python-tag.test.mjs
 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const file = path.resolve('entrypoints/sidepanel/components/greeting/GreetingPythonTag.vue');
const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file });
const script = compileScript(descriptor, { id: 'greeting-python-tag', inlineTemplate: true });
const out = path.resolve('node_modules/.cache/greeting-python-tag-test.mjs');
mkdirSync(path.dirname(out), { recursive: true });

await build({
  stdin: {
    contents: `${script.content}\nexport { PYODIDE_ENV_STORAGE_KEY } from '@/utils/pyodide/pyodide-config';`,
    loader: 'ts',
    resolveDir: path.dirname(file),
  },
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['vue'],
  alias: { '@': root },
  plugins: [
    {
      name: 'greeting-tag-stubs',
      setup(api) {
        // i18n：真实中文目录（断言真实文案）
        api.onResolve({ filter: /@\/utils\/i18n$/ }, () => ({ path: 'locale-stub', namespace: 'locale' }));
        api.onLoad({ filter: /.*/, namespace: 'locale' }, () => ({
          contents: `import {ref} from 'vue'; import zh from '${path.resolve('utils/i18n/locales/zh-CN.ts').replaceAll('\\', '/')}';
export const t=(key,p={})=>String(key.split('.').reduce((v,k)=>v?.[k],zh)??key).replace(/\\{(\\w+)\\}/g,(_,k)=>p[k]??'');
export const useLocale=()=>({locale:ref('zh-CN'),switchLocale:()=>{}});export const LOCALE_OPTIONS=[];`,
          resolveDir: root,
        }));
      },
    },
  ],
  logLevel: 'silent',
});

// ──── 宿主：JSDOM + chrome.storage 桩（local 读写 + onChanged 跨上下文广播） ────

const dom = new JSDOM('<div id="app"></div>', { url: 'https://extension.test/sidepanel.html' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver', 'Event']) {
  globalThis[key] = dom.window[key];
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

const storageListeners = new Set();
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return { [key]: store[key] };
      },
      async set(patch) {
        const changes = {};
        for (const [k, value] of Object.entries(patch)) {
          changes[k] = { oldValue: store[k], newValue: value };
          store[k] = value;
        }
        for (const listener of storageListeners) listener(changes, 'local');
      },
    },
    onChanged: {
      addListener: listener => storageListeners.add(listener),
      removeListener: listener => storageListeners.delete(listener),
    },
  },
};

const api = await import(pathToFileURL(out).href);
const { createApp, h, nextTick } = await import('vue');
const flush = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await nextTick();
};

const errors = [];
let opened = 0;
let app = null;

function mountTag() {
  app = createApp({
    render: () => h(api.default, { onOpen: () => { opened++; } }),
  });
  app.config.errorHandler = error => errors.push(error);
  app.mount('#app');
}

const tag = () => document.querySelector('.greeting-python-tag');
const TAG_TEXT = '安装Python运行时环境，解锁更多能力';

// ══════════ 1. 未安装（空存储）挂载 → 标签可见 ══════════
assert.equal(storageListeners.size, 0, '测试起点无残留监听');
mountTag();
await flush();
assert.deepEqual(errors, [], '挂载无未捕获异常');
assert.ok(tag(), '未安装时标签可见');
assert.ok(tag().textContent.includes(TAG_TEXT), '文案为「安装Python运行时环境，解锁更多能力」');
assert.equal(storageListeners.size, 1, '挂载后注册一条环境状态订阅');

// ══════════ 2. 安装完成（storage 推送 ready）→ 标签立即消失 ══════════
await chrome.storage.local.set({ [api.PYODIDE_ENV_STORAGE_KEY]: { status: 'ready' } });
await flush();
assert.equal(tag(), null, '安装完成后标签实时消失（无需刷新侧边栏）');

// ══════════ 3. 删除环境（推送 idle）→ 标签重新出现（双向实时） ══════════
await chrome.storage.local.set({ [api.PYODIDE_ENV_STORAGE_KEY]: { status: 'idle' } });
await flush();
assert.ok(tag(), '删除环境后标签实时恢复');

// ══════════ 4. 点击 → 触发 open 事件 ══════════
tag().click();
await flush();
assert.equal(opened, 1, '点击标签触发一次 open（导航由 App.vue 接管）');

// ══════════ 5. 卸载 → 订阅退订 ══════════
app.unmount();
assert.equal(storageListeners.size, 0, '卸载后环境状态订阅已退订（无监听器泄漏）');

// ══════════ 6. 已安装状态挂载 → 开屏不展示 ══════════
store[api.PYODIDE_ENV_STORAGE_KEY] = { status: 'ready' };
mountTag();
await flush();
assert.deepEqual(errors, [], '二次挂载无未捕获异常');
assert.equal(tag(), null, '已安装时开屏不展示标签（不闪现）');
app.unmount();

console.log('[sidepanel] 欢迎语 Python 安装引导标签：未安装可见 / 安装完成实时消失 / 删除恢复 / 点击 open / 卸载退订 —— 通过');

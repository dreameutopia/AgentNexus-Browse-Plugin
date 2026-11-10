/**
 * 管理中心 · 「使用监控」+「Python 环境」分区回归测试
 *
 * 覆盖本轮迁移的关键契约：
 *   1. 导航：两个分区在管理中心左导航中是独立入口，侧边栏设置弹窗不再保留；
 *   2. 使用监控：指标卡 / 筛选栏 / 协议聚合 / 模型占比 / 请求明细 / 失败摘要
 *      全部渲染，且**实时订阅**——引擎推送新快照后视图立即刷新；
 *   3. Python 环境：运行时详情四宫格 / 包芯片 / 目录搜索 / 测试运行台渲染，
 *      且**跨上下文实时同步**——watchPyodideEnv 推送新状态后视图立即刷新；
 *   4. 危险操作走行内二次确认（不弹 window.confirm）；
 *   5. 样式契约：两个分区不得出现原生 <select>，配色不含任何蓝紫。
 *
 * 运行：node tests/hub/usage-python.test.mjs
 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const outfile = path.resolve('node_modules/.cache/hub-usage-python-test.mjs');
mkdirSync(path.dirname(outfile), { recursive: true });

// ──── 桩：用量统计引擎（可推送新快照，验证实时刷新） ────
const USAGE_ENGINE_STUB = `
const listeners = new Set();
function base() {
  return {
    scopes: [
      { provider:'openai', model:'gpt-4.1', requestKind:'chat', channelId:'ch-a', channelLabel:'OpenAI 官方', agentId:'调研助手',
        requests:31, success:30, failed:0, aborted:1, inputTokens:430000, outputTokens:118000, totalTokens:548000,
        cachedInputTokens:226000, cacheEligibleInputTokens:318000, cacheHitRequests:19, cacheObservedRequests:26,
        continuationInputTokens:150000, continuationCachedTokens:102000, continuationCacheRequests:12, lastUsedAt:1 },
      { provider:'anthropic', model:'claude-sonnet-4.5', requestKind:'chat', channelId:'ch-b', channelLabel:'Anthropic 官方', agentId:'',
        requests:28, success:27, failed:1, aborted:0, inputTokens:296000, outputTokens:74000, totalTokens:370000,
        cachedInputTokens:104000, cacheEligibleInputTokens:208000, cacheHitRequests:16, cacheObservedRequests:23,
        continuationInputTokens:86000, continuationCachedTokens:57000, continuationCacheRequests:9, lastUsedAt:2 },
    ],
    recentRequests: [
      { at:1000, provider:'openai', model:'gpt-4.1', kind:'chat', outcome:'success', channelId:'ch-a', channelLabel:'OpenAI 官方', agentId:'调研助手', iteration:1, usage:{ inputTokens:100, outputTokens:20 } },
    ],
    schemaVersion:2, startedAt:100, updatedAt:200,
    totals: {
      cacheHitRequests:62, cacheObservedRequests:104, continuationInputTokens:402000, continuationCachedTokens:261000,
      continuationCacheRequests:33, requests:128, success:119, failed:6, aborted:3,
      inputTokens:1250000, outputTokens:318000, totalTokens:1568000, cachedInputTokens:486000,
      cacheReportedRequests:104, cacheEligibleInputTokens:902000, reasoningTokens:46500,
    },
    models: [
      { provider:'openai', model:'gpt-4.1', requests:46, success:44, failed:1, aborted:1,
        inputTokens:612000, outputTokens:168000, totalTokens:780000, cachedInputTokens:302000,
        cacheEligibleInputTokens:470000, cacheHitRequests:28, cacheObservedRequests:38,
        continuationInputTokens:214000, continuationCachedTokens:148000, continuationCacheRequests:18,
        reasoningTokens:21000, channelId:'ch-a', channelLabel:'OpenAI 官方', agentId:'调研助手', lastUsedAt:1 },
      { provider:'anthropic', model:'claude-sonnet-4.5', requests:38, success:36, failed:2, aborted:0,
        inputTokens:402000, outputTokens:96000, totalTokens:498000, cachedInputTokens:142000,
        cacheEligibleInputTokens:288000, cacheHitRequests:21, cacheObservedRequests:31,
        continuationInputTokens:118000, continuationCachedTokens:76000, continuationCacheRequests:11,
        reasoningTokens:25500, channelId:'ch-b', channelLabel:'Anthropic 官方', agentId:'', lastUsedAt:2 },
    ],
    recentErrors: [
      { at:500, provider:'gemini', model:'gemini-2.5-pro', kind:'chat', summary:'HTTP 429：上游限流' },
    ],
    hydrated:true,
  };
}
let snapshot = base();
export const aiUsageMetrics = {
  getSnapshot(){ return snapshot; },
  subscribe(listener){ listeners.add(listener); listener(snapshot); return () => listeners.delete(listener); },
  reset(){ snapshot = base(); listeners.forEach(l => l(snapshot)); },
};
export function __setRequests(n){
  snapshot = { ...snapshot, totals: { ...snapshot.totals, requests: n }, updatedAt: Date.now() };
  listeners.forEach(l => l(snapshot));
}
`;

await build({
  stdin: {
    contents: `
export { default as Hub } from './entrypoints/hub/App.vue';
export { default as UsageSection } from './entrypoints/hub/usage/UsageSection.vue';
export { default as PythonSection } from './entrypoints/hub/python/PythonSection.vue';
export { __setRequests } from './entrypoints/sidepanel/utils/metrics/usage-metrics-engine';
export { __pushEnv } from './utils/pyodide/index';
`,
    resolveDir: root,
    loader: 'ts',
  },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['vue'],
  loader: { '.css': 'empty' },
  alias: { '@': root },
  plugins: [
    {
      name: 'hub-stubs',
      setup(api) {
        // i18n：直接读真实中文目录（断言真实文案，而非 key）
        api.onResolve({ filter: /@\/utils\/i18n$/ }, args => ({ path: 'locale-stub', namespace: 'locale' }));
        api.onLoad({ filter: /.*/, namespace: 'locale' }, () => ({
          contents: `import {ref} from 'vue'; import zh from '${path.resolve('utils/i18n/locales/zh-CN.ts').replaceAll('\\', '/')}';
export const t=(key,p={})=>String(key.split('.').reduce((v,k)=>v?.[k],zh)??key).replace(/\\{(\\w+)\\}/g,(_,k)=>p[k]??'');
export const useLocale=()=>({locale:ref('zh-CN'),switchLocale:()=>{}});export const LOCALE_OPTIONS=[];`,
          resolveDir: root,
        }));
        // 插件客户端：外壳启动时调用，测试环境无 chrome.runtime
        api.onResolve({ filter: /@\/utils\/plugins\/client$/ }, args => ({ path: 'plugin-client-stub', namespace: 'plugin-client' }));
        api.onLoad({ filter: /.*/, namespace: 'plugin-client' }, () => ({
          contents: `export async function startPluginClient(){ return { ok:true }; }`,
        }));
        // 技能存储：技能分区组件读取（壳里真实挂载）
        api.onResolve({ filter: /@\/utils\/skills\/skill-store$/ }, args => ({ path: 'skill-store-stub', namespace: 'skill-store' }));
        api.onLoad({ filter: /.*/, namespace: 'skill-store' }, () => ({
          contents: `export function getAllSkills(){ return []; }
export function onSkillsChange(){ return () => {}; } export function resolveSkill(){ return null; }`,
        }));
        // 用量统计引擎：固定快照 + 可推送
        // 注意 path 必须固定：esbuild 以「namespace + path」标识模块，
        // 若沿用 args.path，不同导入写法（相对路径 / 根相对路径）会得到两个实例，
        // 组件订阅的监听器与测试推送的监听器分属不同实例，实时同步断言必然失败。
        api.onResolve({ filter: /usage-metrics-engine$/ }, args => ({ path: 'usage-engine-stub', namespace: 'usage-engine' }));
        api.onLoad({ filter: /.*/, namespace: 'usage-engine' }, () => ({
          contents: USAGE_ENGINE_STUB,
        }));
        // 协议驱动注册表：仅保留展示名
        api.onResolve({ filter: /stream[\\/]driver-registry$/ }, args => ({ path: 'driver-registry-stub', namespace: 'driver-registry' }));
        api.onLoad({ filter: /.*/, namespace: 'driver-registry' }, () => ({
          contents: `const LABELS={openai:'OpenAI',anthropic:'Anthropic',gemini:'Gemini'};
export const driverRegistry={ tryGet(id){ return LABELS[id]?{meta:{label:LABELS[id]}}:undefined; } };`,
        }));
        // Pyodide 全家桶：模拟已就绪环境 + 可推送状态
        api.onResolve({ filter: /pyodide/ }, args => ({ path: 'pyodide-stub', namespace: 'pyodide' }));
        api.onLoad({ filter: /.*/, namespace: 'pyodide' }, () => ({
          contents: `export const PYODIDE_VERSION='0.28.3';
export const PYODIDE_CORE_FILES=[{label:'python311.wasm',url:'https://x/python311.wasm',contentType:'application/wasm'}];
export const PYODIDE_FEATURED_PACKAGES=['numpy','pandas'];
export const DEFAULT_PYODIDE_ENV_STATE={status:'idle',pythonVersion:'',version:PYODIDE_VERSION,verifiedAt:0,packages:[],lastError:''};
const listeners=new Set();
let envState={status:'ready',pythonVersion:'3.14.0',version:PYODIDE_VERSION,verifiedAt:1000,
  packages:[{name:'numpy',version:'2.3.1'}],lastError:''};
export async function getPyodideEnvState(){ return JSON.parse(JSON.stringify(envState)); }
export async function updatePyodideEnvState(patch){ envState={...envState,...patch}; listeners.forEach(l=>l(JSON.parse(JSON.stringify(envState)))); return envState; }
export function watchPyodideEnv(l){ listeners.add(l); return ()=>listeners.delete(l); }
export async function ensurePyodideRuntime(){ return {}; }
export async function verifyPyodideRuntime(){ return {pythonVersion:'3.14.0',implementation:'CPython',checksumOk:true}; }
export async function clearFiles(){ envState={...DEFAULT_PYODIDE_ENV_STATE}; }
export async function downloadPyodideFile(){}
export async function listFileMeta(){ return [{name:'python311.wasm',size:1048576}]; }
export async function runPythonCode(){ return {ok:true,stdout:'ok',stderr:'',result:'42',durationMs:12,timedOut:false,errorName:'',errorDetail:''}; }
export async function getPackageCatalog(){ return [
  {name:'numpy',version:'2.3.1',fileName:'numpy.whl',imports:['numpy'],depends:[]},
  {name:'pandas',version:'2.3.0',fileName:'pandas.whl',imports:['pandas'],depends:['numpy']},
  {name:'scikit-learn',version:'1.6.1',fileName:'sk.whl',imports:['sklearn'],depends:['numpy']},
]; }
export async function installPackages(names){ return names.map(name=>({name,version:'1.0.0'})); }
export async function uninstallPackages(){}
export function __pushEnv(next){ envState={...envState,...next}; listeners.forEach(l=>l(JSON.parse(JSON.stringify(envState)))); }`,
        }));
        api.onLoad({ filter: /\.vue$/ }, args => {
          const real = /hub[\\/]App\.vue$|hub[\\/]usage[\\/]UsageSection\.vue$|hub[\\/]python[\\/]PythonSection\.vue$|hub[\\/]components[\\/](HubSelect|HubSwitch|HubSegmented)\.vue$/.test(args.path);
          if (!real) return { contents: `export default {render:()=>null};`, loader: 'js' };
          const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
          return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content, loader: 'ts', resolveDir: path.dirname(args.path) };
        });
      },
    },
  ],
  logLevel: 'silent',
});

const dom = new JSDOM('<div id="app"></div>', { url: 'https://extension.test/hub.html' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver', 'localStorage', 'KeyboardEvent', 'Event']) {
  globalThis[key] = dom.window[key];
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.chrome = {
  storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
  onChanged: { addListener() {}, removeListener() {} },
};

const api = await import(pathToFileURL(outfile).href);
const { createApp, nextTick } = await import('vue');
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { await tick(); await nextTick(); };

const q = selector => document.querySelector(selector);
const qa = selector => [...document.querySelectorAll(selector)];
const text = selector => q(selector)?.textContent?.trim() ?? '';

// ════════════════ 1. 管理中心壳：两个分区是左导航的独立入口 ════════════════

const app = createApp(api.Hub);
const errors = [];
app.config.errorHandler = error => errors.push(error);
app.mount('#app');
await flush();

assert.deepEqual(errors, [], '管理中心挂载无错误');

const navLabels = qa('.hub-nav-item .hub-nav-label').map(el => el.textContent.trim());
assert.ok(navLabels.includes('使用监控'), '左导航含「使用监控」入口');
assert.ok(navLabels.includes('Python 环境'), '左导航含「Python 环境」入口');
assert.ok(navLabels.includes('智能体'), '既有分区入口未丢失');
assert.ok(navLabels.includes('技能'), '既有分区入口未丢失');
assert.ok(navLabels.includes('插件'), '既有分区入口未丢失');
assert.ok(navLabels.includes('备份与恢复'), '既有分区入口未丢失');

// 点击导航可切到对应分区（v-show 常驻挂载：切换只改 display）
const usageNav = qa('.hub-nav-item').find(el => el.textContent.includes('使用监控'));
usageNav.click();
await flush();
const usageSection = q('.hub-usage')?.closest('section.api-section');
assert.ok(usageSection, '使用监控分区已挂载');
assert.notEqual(usageSection.style.display, 'none', '点击导航后使用监控分区可见');

const pythonNav = qa('.hub-nav-item').find(el => el.textContent.includes('Python 环境'));
pythonNav.click();
await flush();
const pythonSection = q('.hub-python')?.closest('section.api-section');
assert.ok(pythonSection, 'Python 环境分区已挂载');
assert.notEqual(pythonSection.style.display, 'none', '点击导航后 Python 环境分区可见');

// ════════════════ 2. 使用监控分区 ════════════════

const usageRoot = q('.hub-usage');
assert.ok(usageRoot, '使用监控分区渲染');
const usageText = usageRoot.textContent;

assert.ok(usageText.includes('使用监控'), '渲染标题「使用监控」');
assert.ok(usageText.includes('统计中'), '渲染统计状态徽标');
assert.ok(usageText.includes('统计起点'), '渲染统计起点');
assert.ok(usageText.includes('总请求次数'), '渲染总请求次数卡片');
assert.ok(usageText.includes('请求成功率'), '渲染成功率卡片');
assert.ok(usageText.includes('总消耗 Token'), '渲染总 Token 卡片');
assert.ok(usageText.includes('输入 Token 缓存占比'), '渲染缓存占比卡片');
assert.ok(usageText.includes('按协议统计'), '渲染按协议聚合分组');
assert.ok(usageText.includes('各模型 Token 消耗占比'), '渲染模型占比分组');
assert.ok(usageText.includes('按渠道、模型和智能体查看缓存'), '渲染缓存诊断分组');
assert.ok(usageText.includes('请求明细'), '渲染请求明细分组');
assert.ok(usageText.includes('最近失败原因'), '渲染最近失败分组');
assert.ok(usageText.includes('OpenAI'), '渲染协议名（OpenAI）');
assert.ok(usageText.includes('Anthropic'), '渲染协议名（Anthropic）');
assert.ok(usageText.includes('gpt-4.1'), '渲染模型名');
assert.ok(usageText.includes('claude-sonnet-4.5'), '渲染模型名');
assert.ok(usageText.includes('HTTP 429'), '渲染失败摘要');

// 筛选控件：搜索框 + 三个自绘下拉 + 排序分段控件
assert.ok(qa('.hub-usage__filters .hub-list-search').length === 1, '含模型/渠道/智能体文本搜索框');
assert.ok(qa('.hub-usage__filters .hub-select').length === 3, '含渠道 / 模型 / 智能体三个自绘下拉');
assert.ok(qa('.hub-usage__filters .hub-seg').length === 1, '含排序分段控件');
assert.equal(qa('.hub-usage select').length, 0, '不得出现原生 <select>');

// 筛选生效：文本搜索命中模型名
const searchInput = q('.hub-usage__filters .hub-list-search');
searchInput.value = 'claude';
searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
const filteredText = q('.hub-usage__rows')?.textContent ?? '';
assert.ok(filteredText.includes('claude-sonnet-4.5'), '搜索命中目标模型');
assert.ok(!filteredText.includes('gpt-4.1'), '搜索后无关模型被过滤');

// 实时同步：引擎推送新快照后视图立即刷新（不等用户手动刷新）
api.__setRequests(999);
await flush();
const requestCardValue = q('.hub-usage__card .hub-usage__card-value')?.textContent?.trim();
assert.equal(requestCardValue, '999', '引擎推送新快照后请求次数立即刷新');
assert.ok(q('.hub-usage__meta')?.textContent?.includes('最近更新'), '渲染「最近更新」时间戳（实时同步状态可见）');

// ════════════════ 3. Python 环境分区 ════════════════

const pythonRoot = q('.hub-python');
assert.ok(pythonRoot, 'Python 环境分区渲染');
const pythonText = pythonRoot.textContent;

assert.ok(pythonText.includes('Python 环境'), '渲染标题「Python 环境」');
assert.ok(pythonText.includes('BETA'), '渲染 BETA 徽标');
assert.ok(pythonText.includes('已就绪'), '渲染就绪状态徽标');
assert.ok(pythonText.includes('运行时详情'), '渲染运行时详情分组');
assert.ok(pythonText.includes('CPython 3.14.0'), '渲染 CPython 版本');
assert.ok(pythonText.includes('Pyodide 0.28.3'), '渲染 Pyodide 版本');
assert.ok(pythonText.includes('核验通过于'), '渲染核验时间');
assert.ok(pythonText.includes('本地缓存'), '渲染本地缓存信息');
assert.ok(pythonText.includes('Python 包管理'), '渲染包管理分组');
assert.ok(pythonText.includes('已安装 1 个包'), '渲染已装包计数');
assert.ok(pythonText.includes('numpy'), '渲染已装包芯片');
assert.ok(pythonText.includes('常用包'), '渲染常用包快捷安装');
assert.ok(pythonText.includes('测试运行'), '渲染测试运行台');
assert.ok(q('.hub-python__code'), '渲染代码编辑区');

const snippetButtons = qa('.hub-python__snippets .hub-python__chip');
assert.ok(snippetButtons.length >= 3, '提供代码片段一键载入');
snippetButtons[1].click();
await flush();
assert.ok(q('.hub-python__code').value.includes('json'), '点击片段后代码被载入');

// 实时同步：其它上下文写入 Python 环境状态后，本视图立即跟随
api.__pushEnv({ packages: [{ name: 'pandas', version: '2.3.0' }] });
await flush();
const pythonAfter = q('.hub-python')?.textContent ?? '';
assert.ok(pythonAfter.includes('pandas'), '环境状态推送后已装包列表立即刷新');
assert.ok(pythonAfter.includes('已安装 1 个包'), '已装包计数同步刷新');

// 危险操作：行内二次确认，不弹 window.confirm
let confirmCalls = 0;
dom.window.confirm = () => { confirmCalls++; return true; };
const removeBtn = qa('.hub-python__card .hub-python-btn-danger')[0];
assert.ok(removeBtn, '存在「彻底删除」按钮');
removeBtn.click();
await flush();
assert.equal(confirmCalls, 0, '删除环境不弹原生 confirm');
assert.ok(removeBtn.classList.contains('is-armed'), '首次点击进入待确认态');
removeBtn.click();
await flush();
assert.equal(confirmCalls, 0, '二次点击也不弹原生 confirm');

// ════════════════ 4. 样式契约：纯黑白灰，无蓝紫 ════════════════

const usageCss = readFileSync(path.resolve('entrypoints/hub/usage/usage-section.css'), 'utf8');
const pythonCss = readFileSync(path.resolve('entrypoints/hub/python/python-section.css'), 'utf8');
for (const [name, css] of [['usage-section.css', usageCss], ['python-section.css', pythonCss]]) {
  assert.equal(
    /#667eea|#4f46e5|#764ba2|#f093fb|#3b82f6|#8b5cf6|#7c3aed|#2563eb|102,\s*126,\s*234/.test(css),
    false,
    `${name} 不得残留蓝紫色`,
  );
}

// 侧边栏设置弹窗不再保留这两个分区
const settingsModal = readFileSync(path.resolve('entrypoints/sidepanel/components/modals/SettingsModal.vue'), 'utf8');
assert.equal(/UsageSection|PythonSection/.test(settingsModal), false, '设置弹窗不再引用使用监控 / Python 环境分区');
const sectionsIndex = readFileSync(path.resolve('entrypoints/sidepanel/components/modals/sections/index.ts'), 'utf8');
assert.equal(/UsageSection|PythonSection/.test(sectionsIndex), false, '分区出口不再导出这两个分区');

console.log('[hub] 使用监控 + Python 环境：导航入口、指标渲染、筛选、实时同步、行内二次确认、配色契约 —— 通过');

/**
 * 管理中心 · 「会话管理」分区回归测试
 *
 * 覆盖本轮实现的关键契约：
 *   1. 导航：分区在管理中心左导航中是独立入口，深链 #sessions 可达；
 *   2. 列表：常规 / 归档两个视图分流（归档会话不进常规列表）、计数徽标、
 *      消息数与相对时间渲染；
 *   3. 搜索：默认仅匹配标题；开启「搜索对话内容」开关后才扫描消息正文
 *      （开关默认关闭 —— 正文扫描是额外开销，必须按需开启）；
 *   4. 运行态闸门：会话执行中时「打开 / 删除」被拦截并弹等待提示，
 *      不进入确认框、不触碰删除引擎；
 *   5. 删除：自定义二次确认弹窗（绝不用 window.confirm），确认后走删除引擎
 *      并通知侧边栏；取消则无副作用；
 *   6. 归档 / 取消归档：行在两个视图间迁移，归档行带保留期文案；
 *   7. 保留策略：自动删除开关默认开启、保留天数默认 30，改动即落库；
 *   8. 实时同步：跨上下文变更广播后列表自动刷新（不等手动刷新）；
 *   9. 样式契约：右侧整体不出滚动条、仅 __scroll 容器滚动、配色无蓝紫、
 *      无原生 <select>。
 *
 * 运行：node tests/hub/sessions-section.test.mjs
 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const outfile = path.resolve('node_modules/.cache/hub-sessions-test.mjs');
mkdirSync(path.dirname(outfile), { recursive: true });

// ──── 桩：会话数据面全家桶（列表 / 引擎 / 桥 / 策略 / 清理） ────
// 六个模块必须解析到**同一个桩实例**（固定 path，见 esbuild 桩的模块实例坑），
// 否则组件订阅的状态与测试注入的状态分属不同内存，实时同步断言必然失败。
const SESSION_STUB = `
const state = {
  sessions: [],
  messages: new Map(),
  busy: new Set(),
  activeChatId: '',
  openResult: 'opened',
  openInvocations: 0,
  deleteInvocations: 0,
  deleted: [],
  deleteNotifications: [],
  renameInvocations: [],
  policy: { autoDelete: true, retentionDays: 30 },
  sweepCalls: 0,
  sweepResult: { deleted: [], skipped: 0, issues: [] },
  changeHandlers: new Set(),
  policyHandlers: new Set(),
};

function normalizePolicy(value) {
  const source = value ?? {};
  const autoDelete = typeof source.autoDelete === 'boolean' ? source.autoDelete : true;
  const raw = Number(source.retentionDays);
  const retentionDays = Number.isFinite(raw) ? Math.min(3650, Math.max(1, Math.round(raw))) : 30;
  return { autoDelete, retentionDays };
}

function fireChange(reason) {
  for (const handler of [...state.changeHandlers]) handler(reason);
}

function sortList(list, scope) {
  return [...list].sort((a, b) => scope === 'archived'
    ? (b.archivedAt ?? 0) - (a.archivedAt ?? 0)
    : b.updatedAt - a.updatedAt);
}

export const chatDatabase = {
  async listSessions({ scope = 'active', limit = 50, offset = 0 } = {}) {
    const filtered = state.sessions.filter(session =>
      scope === 'all' ? true
        : scope === 'archived' ? session.archivedAt !== undefined
          : session.archivedAt === undefined);
    return sortList(filtered, scope).slice(offset, offset + limit);
  },
  async findContentMatch(chatId, keyword) {
    const needle = String(keyword ?? '').trim().toLowerCase();
    if (!needle) return null;
    const contents = state.messages.get(chatId) ?? [];
    let count = 0;
    let snippet = '';
    for (const content of contents) {
      const at = content.toLowerCase().indexOf(needle);
      if (at >= 0) {
        count++;
        if (!snippet) snippet = content.slice(Math.max(0, at - 12), at + needle.length + 12);
      }
    }
    return count > 0 ? { count, snippet } : null;
  },
};

export function mergeMessagePatch(existing, patch, now = Date.now()) {
  const merged = { ...existing, ...patch, id: existing.id, chatId: existing.chatId, seq: existing.seq, updatedAt: now };
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete merged[key];
  return merged;
}

export function buildMatchSnippet(content, at, keywordLength) {
  const start = Math.max(0, at - 40);
  const end = Math.min(content.length, at + keywordLength + 40);
  return (start > 0 ? '…' : '') + content.slice(start, end).replace(/\\s+/g, ' ').trim() + (end < content.length ? '…' : '');
}

export const transcriptEngine = {
  async renameSession(chatId, title) {
    state.renameInvocations.push([chatId, title]);
    const session = state.sessions.find(item => item.chatId === chatId);
    if (!session) return null;
    session.title = title;
    session.updatedAt = Date.now();
    fireChange('renamed');
    return { ...session };
  },
  async archiveSession(chatId) {
    const session = state.sessions.find(item => item.chatId === chatId);
    if (!session) return null;
    session.archivedAt = Date.now();
    fireChange('archived');
    return { ...session };
  },
  async unarchiveSession(chatId) {
    const session = state.sessions.find(item => item.chatId === chatId);
    if (!session) return null;
    delete session.archivedAt;
    fireChange('unarchived');
    return { ...session };
  },
};

export const sessionDeletionEngine = {
  async deleteSession(chatId) {
    state.deleteInvocations++;
    state.sessions = state.sessions.filter(item => item.chatId !== chatId);
    state.messages.delete(chatId);
    state.deleted.push(chatId);
    fireChange('deleted');
    return {
      transcriptDeleted: true, imagesDeleted: 0, filesDeleted: 0,
      learnDraftsDiscarded: 0, activePointerCleared: false, runAborted: false, issues: [],
    };
  },
};

export const SESSION_BRIDGE_MSG = {
  CHANGED: 'agentnexus:session-changed',
  RUNTIME_STATUS: 'agentnexus:session-runtime-status',
  OPEN_IN_SIDEPANEL: 'agentnexus:session-open-in-sidepanel',
  DELETED: 'agentnexus:session-deleted',
};

export function notifySessionsChanged(reason) { fireChange(reason); }
export function notifySessionDeleted(chatId) { state.deleteNotifications.push(chatId); }
export async function readSidepanelActiveChatId() { return state.activeChatId; }
export async function listBusySessions(chatIds) {
  return new Set(chatIds.filter(id => state.busy.has(id)));
}
export async function requestOpenInSidepanel() {
  state.openInvocations++;
  return state.openResult;
}
export function watchSessionsChanged(handler) {
  state.changeHandlers.add(handler);
  return () => state.changeHandlers.delete(handler);
}
export async function queryWorkerBusySessions() { return []; }
export async function readSidepanelLocalRunningChats() { return []; }
export async function setLocalRunningChat() {}
export const SIDEPANEL_LOCAL_RUNNING_KEY = 'sidepanel.localRunningChats';

export const SESSION_ARCHIVE_POLICY_STORAGE_KEY = 'agentNexusSessionArchivePolicy';
export const SESSION_ARCHIVE_MIN_RETENTION_DAYS = 1;
export const SESSION_ARCHIVE_MAX_RETENTION_DAYS = 3650;
export const DEFAULT_SESSION_ARCHIVE_POLICY = { autoDelete: true, retentionDays: 30 };
export function normalizeSessionArchivePolicy(value) { return normalizePolicy(value); }
export async function loadSessionArchivePolicy() { return { ...state.policy }; }
export async function saveSessionArchivePolicy(patch) {
  state.policy = normalizePolicy({ ...state.policy, ...patch });
  for (const handler of [...state.policyHandlers]) handler({ ...state.policy });
  return { ...state.policy };
}
export function watchSessionArchivePolicy(handler) {
  state.policyHandlers.add(handler);
  return () => state.policyHandlers.delete(handler);
}

export async function sweepExpiredArchivedSessions() {
  state.sweepCalls++;
  return state.sweepResult;
}

/** 测试注入 / 断言钩子（仅测试包导出，不进生产代码） */
export const __hooks = {
  state,
  seedSession(partial) {
    const session = {
      chatId: 'chat_' + (state.sessions.length + 1),
      title: '未命名会话',
      createdAt: 1000,
      updatedAt: 1000,
      messageCount: 0,
      lastMessagePreview: '',
      agentName: '',
      skillNames: [],
      ...partial,
    };
    state.sessions.push(session);
    return session;
  },
  seedMessages(chatId, contents) { state.messages.set(chatId, [...contents]); },
  setBusy(ids) { state.busy = new Set(ids); fireChange('busy'); },
  setActiveChat(id) { state.activeChatId = id; },
  setOpenResult(result) { state.openResult = result; },
  fireChange(reason) { fireChange(reason); },
  setPolicy(patch) { state.policy = normalizePolicy({ ...state.policy, ...patch }); },
};
`;

await build({
  stdin: {
    contents: `
export { default as Hub } from './entrypoints/hub/App.vue';
export { default as SessionsSection } from './entrypoints/hub/sessions/SessionsSection.vue';
export { __hooks } from './utils/sessions/session-bridge';
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
      name: 'hub-sessions-stubs',
      setup(api) {
        // 会话数据面全家桶：六个模块 → 同一固定 path（共享同一份内存态）
        api.onResolve({ filter: /core[\\/]context[\\/](chat-database|transcript-engine|session-deletion-engine)$|utils[\\/]sessions[\\/](session-bridge|session-archive-policy|session-archive-sweeper)$/ }, () => ({
          path: 'session-mega-stub',
          namespace: 'session-stub',
        }));
        api.onLoad({ filter: /.*/, namespace: 'session-stub' }, () => ({
          contents: SESSION_STUB,
          resolveDir: root,
        }));
        // i18n：直接读真实中文目录（断言真实文案，而非 key）
        api.onResolve({ filter: /@\/utils\/i18n$/ }, () => ({ path: 'locale-stub', namespace: 'locale' }));
        api.onLoad({ filter: /.*/, namespace: 'locale' }, () => ({
          contents: `import {ref} from 'vue'; import zh from '${path.resolve('utils/i18n/locales/zh-CN.ts').replaceAll('\\', '/')}';
export const t=(key,p={})=>String(key.split('.').reduce((v,k)=>v?.[k],zh)??key).replace(/\\{(\\w+)\\}/g,(_,k)=>p[k]??'');
export const useLocale=()=>({locale:ref('zh-CN'),switchLocale:()=>{}});export const LOCALE_OPTIONS=[];`,
          resolveDir: root,
        }));
        // 插件客户端：外壳启动时调用，测试环境无 chrome.runtime
        api.onResolve({ filter: /@\/utils\/plugins\/client$/ }, () => ({ path: 'plugin-client-stub', namespace: 'plugin-client' }));
        api.onLoad({ filter: /.*/, namespace: 'plugin-client' }, () => ({
          contents: `export async function startPluginClient(){ return { ok:true }; }`,
        }));
        // 技能存储：技能分区组件读取（壳里真实挂载）
        api.onResolve({ filter: /@\/utils\/skills\/skill-store$/ }, () => ({ path: 'skill-store-stub', namespace: 'skill-store' }));
        api.onLoad({ filter: /.*/, namespace: 'skill-store' }, () => ({
          contents: `export function getAllSkills(){ return []; }
export function onSkillsChange(){ return () => {}; } export function getSkillById(){ return null; } export async function restoreCustomSkillsFromStorage(){} export async function setCustomSkill(){return {ok:false,reason:'invalid'};}`,
        }));
        // 用量统计引擎：固定空快照（本测试不覆盖使用监控）
        api.onResolve({ filter: /usage-metrics-engine$/ }, () => ({ path: 'usage-engine-stub', namespace: 'usage-engine' }));
        api.onLoad({ filter: /.*/, namespace: 'usage-engine' }, () => ({
          contents: `const empty=()=>({scopes:[],recentRequests:[],schemaVersion:2,startedAt:0,updatedAt:0,
totals:{cacheHitRequests:0,cacheObservedRequests:0,continuationInputTokens:0,continuationCachedTokens:0,
continuationCacheRequests:0,requests:0,success:0,failed:0,aborted:0,inputTokens:0,outputTokens:0,totalTokens:0,
cachedInputTokens:0,cacheReportedRequests:0,cacheEligibleInputTokens:0,reasoningTokens:0},models:[],recentErrors:[],hydrated:true});
let snap=empty(); const ls=new Set();
export const aiUsageMetrics={getSnapshot:()=>snap,subscribe(l){ls.add(l);l(snap);return()=>ls.delete(l);},reset(){}};`,
        }));
        // 协议驱动注册表：仅保留展示名
        api.onResolve({ filter: /stream[\\/]driver-registry$/ }, () => ({ path: 'driver-registry-stub', namespace: 'driver-registry' }));
        api.onLoad({ filter: /.*/, namespace: 'driver-registry' }, () => ({
          contents: `export const driverRegistry={ tryGet(){ return undefined; } };`,
        }));
        // Pyodide 全家桶：空环境（本测试不覆盖 Python 分区）
        api.onResolve({ filter: /pyodide/ }, () => ({ path: 'pyodide-stub', namespace: 'pyodide' }));
        api.onLoad({ filter: /.*/, namespace: 'pyodide' }, () => ({
          contents: `export const PYODIDE_VERSION='0.28.3';
export const PYODIDE_CORE_FILES=[]; export const PYODIDE_FEATURED_PACKAGES=[];
export const DEFAULT_PYODIDE_ENV_STATE={status:'idle',pythonVersion:'',version:PYODIDE_VERSION,verifiedAt:0,packages:[],lastError:''};
const ls=new Set(); let env={...DEFAULT_PYODIDE_ENV_STATE};
export async function getPyodideEnvState(){ return JSON.parse(JSON.stringify(env)); }
export async function updatePyodideEnvState(patch){ env={...env,...patch}; ls.forEach(l=>l(JSON.parse(JSON.stringify(env)))); return env; }
export function watchPyodideEnv(l){ ls.add(l); return ()=>ls.delete(l); }
export async function ensurePyodideRuntime(){ return {}; }
export async function verifyPyodideRuntime(){ return {pythonVersion:'3.14.0',implementation:'CPython',checksumOk:true}; }
export async function clearFiles(){ env={...DEFAULT_PYODIDE_ENV_STATE}; }
export async function downloadPyodideFile(){}
export async function listFileMeta(){ return []; }
export async function runPythonCode(){ return {ok:true,stdout:'',stderr:'',result:'',durationMs:0,timedOut:false,errorName:'',errorDetail:''}; }
export async function getPackageCatalog(){ return []; }
export async function installPackages(){ return []; }
export async function uninstallPackages(){}
export function __pushEnv(next){ env={...env,...next}; ls.forEach(l=>l(JSON.parse(JSON.stringify(env)))); }`,
        }));
        api.onLoad({ filter: /\.vue$/ }, args => {
          const real = /hub[\\/]App\.vue$|hub[\\/]sessions[\\/]SessionsSection\.vue$|hub[\\/]components[\\/](HubSelect|HubSwitch|HubSegmented|HubDialog)\.vue$/.test(args.path);
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
  runtime: {
    id: 'test-extension',
    lastError: undefined,
    onMessage: { addListener() {}, removeListener() {} },
    sendMessage(_message, _callback) { /* 无人应答：桥层按「不可用」降级 */ },
  },
  storage: {
    local: { async get() { return {}; }, async set() {}, async remove() {} },
    session: { async get() { return {}; }, async set() {}, async remove() {} },
    onChanged: { addListener() {}, removeListener() {} },
  },
};

const api = await import(pathToFileURL(outfile).href);
const { createApp, nextTick } = await import('vue');
const hooks = api.__hooks;
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { await tick(); await nextTick(); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const q = selector => document.querySelector(selector);
const qa = selector => [...document.querySelectorAll(selector)];
const text = selector => q(selector)?.textContent?.trim() ?? '';

// ════════════════ 0. 种子数据 ════════════════

const chatA = hooks.seedSession({
  chatId: 'chat_a', title: '季度营收分析', updatedAt: 5000, messageCount: 12,
  lastMessagePreview: '请汇总三个渠道的营收数据', agentName: '数据助手',
});
const chatB = hooks.seedSession({
  chatId: 'chat_b', title: '官网文案润色', updatedAt: 4000, messageCount: 3,
  lastMessagePreview: '把首页标题改得更简洁',
});
const chatC = hooks.seedSession({
  chatId: 'chat_c', title: '旧版接口调研', updatedAt: 3000, messageCount: 7,
  lastMessagePreview: '调研已完成', archivedAt: 1000,
});
hooks.seedMessages('chat_a', ['请汇总三个渠道的营收数据', '苹果发布会的报道也顺手整理一下']);
hooks.seedMessages('chat_b', ['把首页标题改得更简洁']);
hooks.seedMessages('chat_c', ['旧接口的鉴权方式已经过时']);

// ════════════════ 1. 管理中心壳：会话管理是左导航的独立入口 ════════════════

const app = createApp(api.Hub);
const errors = [];
app.config.errorHandler = error => errors.push(error);
app.mount('#app');
await flush();

assert.deepEqual(errors, [], '管理中心挂载无错误');

const navLabels = qa('.hub-nav-item .hub-nav-label').map(el => el.textContent.trim());
assert.ok(navLabels.includes('会话管理'), '左导航含「会话管理」入口');
assert.ok(navLabels.includes('智能体'), '既有分区入口未丢失');
assert.ok(navLabels.includes('使用监控'), '既有分区入口未丢失');
assert.ok(navLabels.includes('备份与恢复'), '既有分区入口未丢失');

const sessionsNav = qa('.hub-nav-item').find(el => el.textContent.includes('会话管理'));
sessionsNav.click();
await flush();

const sessionsRoot = q('.hub-sessions');
assert.ok(sessionsRoot, '会话管理分区已挂载');
const sessionsSection = sessionsRoot.closest('section.api-section');
assert.notEqual(sessionsSection.style.display, 'none', '点击导航后会话管理分区可见');

// ════════════════ 2. 列表：常规视图渲染 + 归档分流 ════════════════

const rootText = () => q('.hub-sessions').textContent;
assert.ok(rootText().includes('会话管理'), '渲染标题「会话管理」');
assert.ok(rootText().includes('共 2 个会话'), '常规视图计数为 2（归档不计入）');
assert.ok(rootText().includes('已归档 1 个'), '渲染归档计数徽标');
assert.ok(rootText().includes('季度营收分析'), '渲染常规会话标题');
assert.ok(rootText().includes('官网文案润色'), '渲染常规会话标题');
assert.ok(!rootText().includes('旧版接口调研'), '归档会话不进常规列表');
assert.ok(rootText().includes('12 条消息'), '渲染消息数');
assert.ok(rootText().includes('数据助手'), '渲染智能体徽标（会话元信息自带）');

// 归档行切换到归档视图才出现（HubSegmented 按钮）
const archivedBtn = qa('.hub-sessions__view .hub-seg__btn').find(btn => btn.textContent.includes('归档'));
assert.ok(archivedBtn, '存在「归档」视图切换');
archivedBtn.click();
await flush();
assert.ok(rootText().includes('旧版接口调研'), '归档视图渲染归档会话');
assert.ok(!rootText().includes('季度营收分析'), '归档视图不渲染常规会话');
assert.ok(q('.hub-sessions__policy'), '归档视图渲染保留策略设置卡');
assert.ok(rootText().includes('归档会话自动删除'), '渲染自动删除开关标题');
assert.ok(rootText().includes('自动删除'), '归档行渲染保留期文案');

// ════════════════ 3. 搜索：默认仅标题；开关后才扫正文 ════════════════

// 回到常规视图
const allBtn = qa('.hub-sessions__view .hub-seg__btn').find(btn => btn.textContent.includes('全部会话'));
allBtn.click();
await flush();

const searchInput = q('.hub-sessions__toolbar .hub-list-search');
assert.ok(searchInput, '存在搜索框');

// 默认（内容搜索关闭）：正文关键词不命中
searchInput.value = '苹果';
searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
assert.ok(rootText().includes('没有匹配的会话'), '默认仅匹配标题（正文关键词不命中）');

// 标题关键词命中
searchInput.value = '营收';
searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
assert.ok(rootText().includes('季度营收分析'), '标题关键词命中');
assert.ok(!rootText().includes('官网文案润色'), '标题过滤生效');

// 开启「搜索对话内容」开关后，正文关键词命中并展示命中片段
searchInput.value = '苹果';
searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
const contentSwitchInput = q('.hub-sessions__content-switch .hub-switch__input');
assert.ok(contentSwitchInput, '存在内容搜索开关');
assert.equal(contentSwitchInput.checked, false, '内容搜索开关默认关闭');
contentSwitchInput.checked = true;
contentSwitchInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await flush();
await wait(400); // 防抖 300ms + 异步扫描
await flush();
assert.ok(rootText().includes('季度营收分析'), '开启开关后正文关键词命中会话');
assert.ok(rootText().includes('内容命中'), '展示内容命中条数');

// ════════════════ 4. 运行态闸门：执行中拦截打开 / 删除 ════════════════

searchInput.value = '';
searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
contentSwitchInput.checked = false;
contentSwitchInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await flush();

hooks.setBusy(['chat_a']);
await wait(300); // 变更广播去抖 200ms
await flush();

// 打开被拦截：弹等待提示，不发起侧边栏请求
let confirmCalls = 0;
dom.window.confirm = () => { confirmCalls++; return true; };
const openBtnOf = chatId => {
  const row = qa('.hub-sessions__row').find(el => el.textContent.includes(
    chatId === 'chat_a' ? '季度营收分析' : '官网文案润色'));
  return row ? [...row.querySelectorAll('.hub-icon-btn')][0] : null;
};
const openBtn = openBtnOf('chat_a');
assert.ok(openBtn, '存在打开按钮');
openBtn.click();
await flush();
assert.equal(hooks.state.openInvocations, 0, '执行中的会话不发起打开请求');
assert.ok(q('.hub-dialog'), '弹出提示弹窗');
assert.ok(text('.hub-dialog__message').includes('等待'), '提示等待执行完毕');
q('.hub-dialog__btn--primary').click(); // 关闭提示
await flush();
assert.equal(confirmCalls, 0, '全程不弹原生 confirm');

// 执行中的会话显示「执行中」徽标
assert.ok(rootText().includes('执行中'), '执行中的会话展示执行中徽标');

// 删除被拦截：不进入确认框、不触碰删除引擎
const deleteBtnOf = chatId => {
  const row = qa('.hub-sessions__row').find(el => el.textContent.includes(
    chatId === 'chat_a' ? '季度营收分析' : '官网文案润色'));
  const buttons = row ? [...row.querySelectorAll('.hub-icon-btn')] : [];
  return buttons[buttons.length - 1]; // 行尾最后一个 = 删除
};
deleteBtnOf('chat_a').click();
await flush();
assert.equal(hooks.state.deleteInvocations, 0, '执行中的会话不进入删除');
assert.ok(!text('.hub-dialog__title').includes('删除会话'), '执行中不弹删除确认框');
// 关掉可能弹出的等待提示
const alertBtn = q('.hub-dialog__btn--primary');
if (alertBtn && text('.hub-dialog__message').includes('等待')) { alertBtn.click(); await flush(); }

hooks.setBusy([]);
await wait(300);
await flush();

// ════════════════ 5. 删除：自定义二次确认弹窗 ════════════════

deleteBtnOf('chat_b').click();
await flush();
assert.equal(confirmCalls, 0, '删除确认不弹原生 confirm');
assert.ok(q('.hub-dialog'), '弹出自定义确认弹窗');
assert.equal(q('.hub-dialog').getAttribute('role'), 'alertdialog', '确认弹窗为 alertdialog');
assert.ok(text('.hub-dialog__title').includes('删除会话'), '确认弹窗标题');
assert.ok(text('.hub-dialog__message').includes('官网文案润色'), '确认弹窗点名会话标题');
assert.ok(text('.hub-dialog__message').includes('不可恢复'), '确认弹窗说明不可恢复');

// 取消：无副作用
const cancelBtn = qa('.hub-dialog__btn').find(btn => btn.textContent.includes('取消'));
cancelBtn.click();
await flush();
assert.equal(hooks.state.deleteInvocations, 0, '取消后不执行删除');
assert.ok(rootText().includes('官网文案润色'), '取消后会话仍在列表');

// 确认：走删除引擎 + 通知侧边栏 + 列表刷新
deleteBtnOf('chat_b').click();
await flush();
const confirmDeleteBtn = qa('.hub-dialog__btn').find(btn => btn.textContent.includes('删除'));
confirmDeleteBtn.click();
await flush();
assert.equal(hooks.state.deleteInvocations, 1, '确认后调用删除引擎');
assert.deepEqual(hooks.state.deleted, ['chat_b'], '删除目标正确');
assert.ok(hooks.state.deleteNotifications.includes('chat_b'), '通知侧边栏该会话已删除');
assert.ok(!rootText().includes('官网文案润色'), '删除后行从列表消失');
assert.ok(rootText().includes('共 1 个会话'), '删除后计数刷新');

// ════════════════ 6. 打开：成功 / 侧边栏未开 / 侧边栏拒绝 ════════════════

hooks.setOpenResult('opened');
openBtnOf('chat_a').click();
await flush();
assert.equal(hooks.state.openInvocations, 1, '空闲会话发起打开请求');
assert.ok(rootText().includes('已在侧边栏打开'), '打开成功提示');
assert.ok(rootText().includes('侧边栏打开中'), '当前会话行展示「侧边栏打开中」徽标');

hooks.setOpenResult('unavailable');
openBtnOf('chat_a').click();
await flush();
assert.ok(text('.hub-dialog__message').includes('侧边栏未打开'), '侧边栏未开给出准确提示');
q('.hub-dialog__btn--primary').click();
await flush();

hooks.setOpenResult('rejected');
openBtnOf('chat_a').click();
await flush();
assert.ok(text('.hub-dialog__message').includes('稍后重试'), '侧边栏拒绝给出准确提示');
q('.hub-dialog__btn--primary').click();
await flush();
hooks.setOpenResult('opened');

// ════════════════ 7. 行内重命名 ════════════════

const renameBtn = [...qa('.hub-sessions__row').find(el => el.textContent.includes('季度营收分析'))
  .querySelectorAll('.hub-icon-btn')][1];
renameBtn.click();
await flush();
const renameInput = q('.hub-sessions__rename-input');
assert.ok(renameInput, '行内重命名输入框出现');
renameInput.value = '季度营收分析（终版）';
renameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true })); // 驱动 v-model
renameInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await flush();
assert.deepEqual(hooks.state.renameInvocations.at(-1), ['chat_a', '季度营收分析（终版）'], '重命名落到引擎');
assert.ok(rootText().includes('季度营收分析（终版）'), '列表标题即时更新');
assert.ok(rootText().includes('标题已更新'), '重命名成功提示');

// ════════════════ 8. 归档 / 取消归档（乐观迁移 + 视图分流） ════════════════

const archiveBtn = [...qa('.hub-sessions__row').find(el => el.textContent.includes('季度营收分析（终版）'))
  .querySelectorAll('.hub-icon-btn')][2];
archiveBtn.click();
await flush();
assert.ok(!rootText().includes('季度营收分析（终版）'), '归档后从常规列表消失');
assert.ok(rootText().includes('已归档 1 个') === false || rootText().includes('已归档 2 个'), '归档计数变化');
assert.ok(rootText().includes('会话已归档'), '归档成功提示');

archivedBtn.click();
await flush();
assert.ok(rootText().includes('季度营收分析（终版）'), '归档会话出现在归档视图');
assert.ok(rootText().includes('旧版接口调研'), '既有归档会话仍在');

const unarchiveBtn = [...qa('.hub-sessions__row').find(el => el.textContent.includes('季度营收分析（终版）'))
  .querySelectorAll('.hub-icon-btn')][2];
unarchiveBtn.click();
await flush();
assert.ok(!rootText().includes('季度营收分析（终版）'), '取消归档后离开归档视图');
assert.ok(rootText().includes('会话已取消归档') || rootText().includes('已取消归档'), '取消归档成功提示');

allBtn.click();
await flush();
assert.ok(rootText().includes('季度营收分析（终版）'), '取消归档后回到常规列表');

// ════════════════ 9. 保留策略：默认开启 + 30 天，改动即落库 ════════════════

archivedBtn.click();
await flush();
assert.equal(hooks.state.policy.autoDelete, true, '自动删除默认开启');
assert.equal(hooks.state.policy.retentionDays, 30, '保留天数默认 30');

const policySwitch = q('.hub-sessions__policy .hub-switch__input');
assert.ok(policySwitch, '策略卡含开关');
assert.equal(policySwitch.checked, true, '开关默认为开');
policySwitch.checked = false;
policySwitch.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await flush();
assert.equal(hooks.state.policy.autoDelete, false, '关闭自动删除即落库');
assert.ok(rootText().includes('保留策略已更新'), '策略变更提示');

const retentionInput = q('.hub-sessions__retention-input');
assert.ok(retentionInput, '保留天数输入框存在');
assert.equal(retentionInput.disabled, true, '自动删除关闭时天数输入禁用');
policySwitch.checked = true;
policySwitch.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await flush();
retentionInput.value = '7';
retentionInput.dispatchEvent(new dom.window.Event('input', { bubbles: true })); // 驱动 v-model.number
retentionInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await flush();
assert.equal(hooks.state.policy.retentionDays, 7, '保留天数修改即落库');
assert.ok(rootText().includes('保留策略已更新'), '天数变更提示');

// ════════════════ 10. 实时同步：跨上下文广播后自动刷新 ════════════════

allBtn.click();
await flush();
const beforeCount = qa('.hub-sessions__row').length;
// 模拟另一上下文（侧边栏）新建了会话，再广播变更
hooks.seedSession({ chatId: 'chat_new', title: '外部新建的会话', updatedAt: 9000, messageCount: 1 });
hooks.fireChange('created');
await wait(300); // 去抖 200ms
await flush();
assert.equal(qa('.hub-sessions__row').length, beforeCount + 1, '广播后列表自动刷新（无需手动刷新）');
assert.ok(rootText().includes('外部新建的会话'), '新会话出现在列表');

// ════════════════ 11. 样式契约 ════════════════

const css = readFileSync(path.resolve('entrypoints/hub/sessions/sessions-section.css'), 'utf8');
assert.equal(
  /#667eea|#4f46e5|#764ba2|#f093fb|#3b82f6|#8b5cf6|#7c3aed|#2563eb|102,\s*126,\s*234/.test(css),
  false,
  'sessions-section.css 不得残留蓝紫色',
);
assert.match(css, /\.hub-sessions__scroll\s*\{[^}]*overflow-y:\s*auto/s, '滚动只发生在 __scroll 容器');
assert.match(css, /\.hub-sessions\s*\{[^}]*min-height:\s*0/s, '根容器参与弹性链（min-height:0），外层不出滚动条');
assert.match(css, /\.hub-sessions__head\s*\{[^}]*flex:\s*none/s, '头部固定不滚动');
assert.match(css, /\.hub-sessions__toolbar\s*\{[^}]*flex:\s*none/s, '工具栏固定不滚动');
assert.equal(qa('.hub-sessions select').length, 0, '不得出现原生 <select>');
assert.equal(confirmCalls, 0, '全流程不弹原生 confirm');

// 深链：#sessions 可达（SECTION_HASHES 注册）
const appSource = readFileSync(path.resolve('entrypoints/hub/App.vue'), 'utf8');
assert.match(appSource, /'#sessions':\s*'sessions'/, '深链 #sessions 已注册');
assert.match(appSource, /id:\s*'sessions',\s*labelKey:\s*'hub\.tabSessions'/, '导航注册会话管理分区');

app.unmount();
assert.deepEqual(errors, [], '卸载无错误');

console.log('[hub] 会话管理：导航入口、常规/归档分流、标题+内容搜索（开关默认关）、运行态闸门、自定义删除确认、归档与保留策略、实时同步、布局与配色契约 —— 通过');

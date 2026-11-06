/** Real outbox + learning state machine + Hub/SkillManager templates, with browser/model ports. */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import vm from 'node:vm';

const root = process.cwd(), outfile = path.resolve('node_modules/.cache/learn-handoff-test.mjs');
// Exercise the real sidepanel browser adapter, including Chrome's opaque extension origins.
const sidepanel = parse(readFileSync('entrypoints/sidepanel/views/App.vue', 'utf8')).descriptor.scriptSetup.content;
const sideAst = ts.createSourceFile('App.ts', sidepanel, ts.ScriptTarget.Latest, true);
const adapter = sideAst.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(sideAst) === 'openHubWithHash'));
assert.ok(adapter);
const navigationCode = ts.transpileModule(adapter.getText(sideAst) + '\nglobalThis.open = openHubWithHash;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let tabs = [], updates = [], creates = [], navigationFails = false;
const navigation = { URL, console: { warn() {} }, chrome: { runtime: { getURL: () => 'chrome-extension://this-extension/hub.html' }, tabs: {
  query: async () => tabs,
  update: async (id, props) => { if (navigationFails) throw Error('tab closed'); updates.push({ id, ...props }); },
  create: async props => { creates.push(props); return { id: 99 }; },
} } };
vm.runInNewContext(navigationCode, navigation);
tabs = [{ id: 1, url: 'chrome-extension://other-extension/hub.html' }, { id: 2, url: 'invalid' }, { id: 3, url: 'chrome-extension://this-extension/hub.html?keep=1#plugins' }];
assert.equal(await navigation.open('#new-skill?id=test&t=1'), true);
assert.equal(updates[0].id, 3, '复用同扩展管理中心，不把 origin=null 的其他扩展当成本页');
assert.equal(updates[0].url, 'chrome-extension://this-extension/hub.html?keep=1#new-skill?id=test&t=1', '只改 hash，保留查询参数避免刷新已有编辑');
assert.equal(creates.length, 0);
navigationFails = true; assert.equal(await navigation.open('#new-skill?id=test'), false, '已关闭标签导航失败明确返回失败'); navigationFails = false;
tabs = []; assert.equal(await navigation.open('#new-skill?id=new'), true); assert.equal(creates.length, 1);
mkdirSync(path.dirname(outfile), { recursive: true });
await build({ stdin: { contents: `
export * from './utils/learn/learn-draft-store';
export { learnDraftHash, LEARN_DRAFT_STORAGE_KEY } from './utils/learn/learn-types';
export { useLearnSession } from './entrypoints/sidepanel/composables/use-learn-session';
export { getAllSkills, restoreCustomSkillsFromStorage } from './utils/skills/skill-store';
export { default as Hub } from './entrypoints/hub/App.vue';
`, resolveDir: root, loader: 'ts' }, outfile, bundle: true, format: 'esm', platform: 'node', external: ['vue'],
  loader: { '.css': 'empty' }, alias: { '@': root }, plugins: [{ name: 'handoff-ports', setup(api) {
    api.onResolve({ filter: /@\/utils\/i18n$/ }, args => ({ path: args.path, namespace: 'locale' }));
    api.onLoad({ filter: /.*/, namespace: 'locale' }, () => ({ contents: `import {ref} from 'vue'; import zh from '${path.resolve('utils/i18n/locales/zh-CN.ts').replaceAll('\\', '/')}';
export const t=(key,p={})=>String(key.split('.').reduce((v,k)=>v?.[k],zh)??key).replace(/\\{(\\w+)\\}/g,(_,k)=>p[k]??'');
export const useLocale=()=>({locale:ref('zh-CN'),switchLocale:()=>{}});export const LOCALE_OPTIONS=[];`, resolveDir: root }));
    api.onResolve({ filter: /@\/entrypoints\/sidepanel\/core$|@\/entrypoints\/sidepanel\/utils\/channels$|@\/entrypoints\/sidepanel\/utils\/stream\/stream-client$|@\/utils\/plugins\/client$/ }, args => ({ path: args.path, namespace: 'ports' }));
    api.onLoad({ filter: /.*/, namespace: 'ports' }, args => ({ contents: args.path.endsWith('/core')
      ? `export const {transcriptEngine,runtimeBuilder,conversationEngine,sessionDeletionEngine}=globalThis.__learnPorts;`
      : args.path.endsWith('/channels') ? `export const modelRegistry={options:[{key:'test',ref:{channelId:'test',modelId:'test'},label:'test',channelName:'test',vision:true,protocol:'openai'}]};`
      : args.path.endsWith('/stream-client') ? `export const streamClient={getCapabilities:()=>({vision:true})};`
      : `export const startPluginClient=async()=>{};` }));
    api.onLoad({ filter: /\.vue$/ }, args => {
      if (/AgentManager\.vue$/.test(args.path)) return { contents: `import {h,ref} from 'vue';export default {emits:['editorState'],setup(_,ctx){const open=ref(false),text=ref('');return()=>h('div',{class:'agent-test'},[h('button',{class:'agent-start',onClick:()=>{open.value=true;ctx.emit('editorState',true)}},'Edit agent'),open.value?h('textarea',{class:'agent-unsaved',value:text.value,onInput:e=>text.value=e.target.value}):null,h('button',{class:'agent-save',onClick:()=>{open.value=false;ctx.emit('editorState',false)}},'Save agent')]);}};`, loader: 'js' };
      if (/PluginManager\.vue$/.test(args.path)) return { contents: `import {h,ref} from 'vue';export default {setup(){const text=ref('');return()=>h('input',{class:'plugin-unsaved',value:text.value,onInput:e=>text.value=e.target.value});}};`, loader: 'js' };
      if (!/(hub[\\/]App|SkillManager|SkillDraftConfirm|hub[\\/]components[\\/]Hub(Select|Switch|Segmented))\.vue$/.test(args.path)) return { contents: `export default {render:()=>null};`, loader: 'js' };
      const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
      return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content, loader: 'ts', resolveDir: path.dirname(args.path) };
    });
    api.onLoad({ filter: /\.[cm]?[jt]s$/ }, args => {
      if (args.path.includes('node_modules')) return;
      const source = readFileSync(args.path, 'utf8');
      if (source.includes('import.meta.glob')) return { contents: source.replace(/import\.meta\.glob/g, '__emptyGlob').replace(/^/, 'const __emptyGlob=()=>({});\n'), loader: 'ts' };
    });
  } }], logLevel: 'silent' });

const dom = new JSDOM('<div id="hub"></div>', { url: 'https://extension.test/hub.html' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver', 'localStorage']) globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const lockTails = new Map(), held = new Set();
Object.defineProperty(navigator, 'locks', { configurable: true, value: { request(name, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (options.ifAvailable && held.has(name)) return Promise.resolve(callback(null));
  const previous = lockTails.get(name) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => { held.add(name); try { return await callback({ name }); } finally { held.delete(name); } });
  lockTails.set(name, next); return next;
} } });
const storage = {}, listeners = new Set();
let rejectWrite = () => false, rejectRead = false, beforeWrite = () => {};
globalThis.chrome = { storage: { local: {
  async get(keys) { if (rejectRead) throw Error('read unavailable'); return Object.fromEntries((keys === null ? Object.keys(storage) : typeof keys === 'string' ? [keys] : keys).filter(key => key in storage).map(key => [key, structuredClone(storage[key])])); },
  async getKeys() { if (rejectRead) throw Error('read unavailable'); return Object.keys(storage); },
  async set(values) { beforeWrite(values); if (Object.entries(values).some(([key, value]) => rejectWrite(key, value))) throw Error('simulated quota'); const changes = {};
    for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: structuredClone(storage[key]), newValue: structuredClone(value) }; storage[key] = structuredClone(value); }
    queueMicrotask(() => listeners.forEach(fn => fn(changes, 'local')));
  }, async remove(key) { delete storage[key]; },
}, onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };

let sourceNumber = 0, runKinds = [], validation = 'passed', opened = [], suffixes = [], failReplay = false, failOpen = false;
const body = '## 目标\n采集商品 SKU\n## 前置条件\n已登录，关键词为输入参数。\n## 完成计划\n1. 搜索商品\n## 具体操作讲解\n### 1. 搜索商品\n按文字与 XPath 定位搜索框，输入并回读结果。\n## 分支与坑点\n规格差异按实际选项处理。\n## 完成判定\n样本结果回读一致。\n## 边界\n仅抽样验证，批量执行时遍历并去重。';
const draft = { name: 'shop-collect-skus', description: '按关键词采集商品规格时使用', category: 'search', tags: ['搜索', '文本模式'], body, allowedTools: ['browser_observe', 'browser_interact'], mode: 'text', summary: '已抽样核验' };
const revisedBody = body.replace('规格差异按实际选项处理。', '默认逐项核对规格；缺货选项跳过并记录原因。');
globalThis.__learnPorts = {
  transcriptEngine: { createSession: async () => ({ chatId: `learning-${++sourceNumber}` }), getEffectiveContext: async () => ({ records: [], summary: '' }), setSystemPromptSuffix: async (chatId, text) => { if (failReplay) throw Error('replay failure'); suffixes.push({ chatId, draft: JSON.parse(text) }); } },
  runtimeBuilder: { build: async input => ({ ...input, limits: input.limitsOverride, toolIds: [...input.extraToolIds, 'getPageMarkdown'], advertisedToolIds: [...input.extraToolIds, 'getPageMarkdown'] }) },
  conversationEngine: { async run(runtime, options) {
    const isValidation = runtime.extraToolIds.includes('submit_validation'); runKinds.push(isValidation ? 'validation' : 'learning');
    if (isValidation) {
      assert.ok(!runtime.toolIds.includes('browser_page_exec') && !runtime.toolIds.includes('getPageMarkdown'), '验证执行面移除未声明工具和默认智能体附加工具');
      assert.ok(!runtime.advertisedToolIds.includes('browser_page_exec') && !runtime.advertisedToolIds.includes('getPageMarkdown'), '模型看到的schema也必须受相同边界约束');
    }
    if (isValidation && validation === 'error') return { status: 'error', error: 'model unavailable' };
    const name = isValidation ? 'submit_validation' : 'submit_skill', id = name + sourceNumber;
    options.observer({ type: 'tool-call', chatId: runtime.chatId, call: { id, name } });
    const report = validation === 'failed' ? { passed: false, issues: ['规格路径需确认'] } : { passed: true, issues: [], revision: { body: revisedBody, summary: '增加通用缺货分支', evidence: ['两种规格均回读正确'] } };
    options.observer({ type: 'tool-result', chatId: runtime.chatId, callId: id, status: 'success', result: { data: isValidation ? { report } : { draft } } });
    return { status: 'done' };
  }, abort() {} }, sessionDeletionEngine: { deleteSession: async () => {} },
};
const api = await import(pathToFileURL(outfile).href);
const { createApp, nextTick } = await import('vue');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) { for (let i = 0; i < 100; i++) { await tick(); await nextTick(); if (await predicate()) return; } throw Error('Timed out: ' + label); }
const config = { url: 'https://shop.test', goal: '批量采集商品 SKU', targetMode: 'text', strategy: 'text', modelRef: { channelId: 'test', modelId: 'test' }, autoValidate: false };
function session() { return api.useLearnSession({ observer: () => {}, notify: () => {}, showChat: () => {}, setActiveChat: () => {}, setResponding: () => {}, requestToolApproval: async () => true, dismissQuestions: () => {}, t: key => key,
  openHub: async hash => { opened.push(hash); return !failOpen; } }); }
async function learn(autoValidate, outcome = 'passed') {
  validation = outcome; runKinds = []; const flow = session(); flow.openModal(); assert.equal(flow.submitConfig({ ...config, autoValidate }), true); flow.answerDialog('confirm');
  if (outcome === 'failed') { await until(() => flow.dialog.value?.mode === 'validationFail', 'validation decision'); flow.answerDialog('create'); }
  await until(() => flow.phase.value === 'done', 'handoff completed'); return flow;
}

try {
  const without = await learn(false);
  assert.deepEqual(runKinds, ['learning']);
  const firstId = new URLSearchParams(opened.at(-1).split('?')[1]).get('id');
  assert.ok(firstId); assert.equal((await api.readLearnDraft(firstId)).transfer.draft.body, body);
  const withValidation = await learn(true);
  assert.deepEqual(runKinds, ['learning', 'validation']);
  const validatedId = new URLSearchParams(opened.at(-1).split('?')[1]).get('id');
  assert.equal((await api.readLearnDraft(validatedId)).transfer.draft.body, revisedBody, '验证后交付修订正文');
  await learn(true, 'failed'); assert.equal((await api.listLearnDrafts()).transfers.at(-1).draft.body, body, '验证不通过仍可交付原草稿');
  await learn(true, 'error'); assert.equal((await api.listLearnDrafts()).transfers.at(-1).draft.body, body, '验证异常保全学习成果');
  failOpen = true; const failedOpen = await learn(false); failOpen = false;
  assert.ok(failedOpen.recovery.value, '导航失败不丢内存恢复入口');
  const beforeOpen = opened.length;
  rejectWrite = key => key.startsWith(api.LEARN_TRANSFER_PREFIX); failReplay = true;
  const unavailable = await learn(false); rejectWrite = () => false; failReplay = false;
  assert.equal(opened.length, beforeOpen, '交接存储失败不打开空白表单');
  assert.equal(unavailable.recovery.value.draft.body, body, '双存储故障时仍可立即下载内存成果');
  const retried = await api.saveLearnDraft(draft, without.recovery.value.chatId);
  assert.equal(retried.id, firstId, '重试使用同一交接 ID');
  const reads = await Promise.all([api.readLearnDraft(firstId), api.readLearnDraft(firstId)]);
  assert.ok(reads.every(value => value.status === 'ok'), '并发读取不会消费成果');
  await without.cleanupSession();
  assert.equal((await api.readLearnDraft(firstId)).transfer.status, 'discarded');
  assert.equal((await api.completeLearnDraft(firstId, 'must-not-save')).ok, false, '终止后的记录不能伪报保存成功');
  assert.equal((await api.readLearnDraft(validatedId)).transfer.status, 'pending', '终止只清理自身成果');

  const oldNow = Date.now; Date.now = () => oldNow() + 86400000;
  assert.equal((await api.readLearnDraft(validatedId)).status, 'ok', '等待一天不丢失成果'); Date.now = oldNow;
  storage[api.LEARN_DRAFT_STORAGE_KEY] = { draft, createdAt: oldNow() - 86400000 };
  const migrated = await api.listLearnDrafts(); const legacy = migrated.transfers.find(item => item.id.startsWith('legacy-'));
  assert.ok(legacy && storage[api.LEARN_DRAFT_STORAGE_KEY], '旧过期草稿先复制、保留原始副本');
  await api.completeLearnDraft(legacy.id, 'legacy-skill');
  storage[api.LEARN_DRAFT_STORAGE_KEY] = { bad: true };
  assert.ok((await api.listLearnDrafts()).transfers.some(item => item.id === validatedId), '坏旧记录不阻止接收新成果');
  delete storage[api.LEARN_DRAFT_STORAGE_KEY];

  await api.restoreCustomSkillsFromStorage();
  const errors = []; let app;
  function mount() { app = createApp(api.Hub); app.config.errorHandler = error => errors.push(error); app.mount('#hub'); }
  mount(); await until(() => document.querySelector('.hub-handoff'), 'inbox visible');
  const pluginInput = document.querySelector('.plugin-unsaved'); pluginInput.value = '插件页面未提交的配置'; pluginInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(document.querySelector('.hub-editor'), null, '挂载不自动进入空白或预填表单');
  document.querySelector('.agent-start').click(); await nextTick();
  const agentInput = document.querySelector('.agent-unsaved'); agentInput.value = '尚未保存的智能体内容'; agentInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.location.hash = api.learnDraftHash(validatedId); window.dispatchEvent(new window.HashChangeEvent('hashchange')); await tick(); await nextTick();
  assert.equal(document.querySelector('.hub-handoff .hub-btn-primary').disabled, true, '保护其他分区的现有编辑');
  assert.equal(document.querySelector('.agent-unsaved').value, '尚未保存的智能体内容');
  document.querySelector('.agent-save').click(); await nextTick();
  // 自绘选择框（HubSelect）：点开触发器后点选目标选项（data-value 即选项值）
  async function pickHandoffTransfer(id) {
    document.querySelector('.hub-handoff .hub-select__trigger').click(); await nextTick();
    document.querySelector(`.hub-handoff .hub-select__option[data-value="${id}"]`).click(); await nextTick();
  }
  await pickHandoffTransfer(validatedId);
  document.querySelector('.hub-handoff .hub-btn-primary').click();
  await until(() => document.querySelector('.draft-card'), 'form prefilled');
  assert.equal((await api.readLearnDraft(validatedId)).transfer.status, 'pending', '预填不是接收确认');
  const form = document.querySelector('.hub-editor');
  assert.equal(form.querySelector('input[type="text"]').value, draft.name);
  assert.ok([...form.querySelectorAll('textarea')].some(input => input.value === revisedBody));
  assert.ok(form.textContent.includes('browser_observe') && form.textContent.includes('browser_interact'));
  const competing = await api.claimLearnDraftEditor(); assert.equal(competing.ok, false, '跨标签编辑锁阻止竞争');
  const bodyInput = [...form.querySelectorAll('textarea')].find(input => input.value === revisedBody);
  bodyInput.value += '\n用户补充的通用注意事项。'; bodyInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await until(async () => (await api.readLearnDraft(validatedId)).transfer.editorState?.form.body.includes('用户补充'), 'editor backup');
  window.location.hash = api.learnDraftHash(validatedId); window.dispatchEvent(new window.HashChangeEvent('hashchange')); await tick(); await nextTick();
  assert.ok(bodyInput.value.includes('用户补充'), '重复深链不能重置正在编辑的成果');
  assert.equal(document.querySelector('.plugin-unsaved').value, '插件页面未提交的配置', '接收不重建其他分区');
  app.unmount(); await tick(); document.querySelector('#hub').innerHTML = ''; mount();
  await until(() => document.querySelector('.hub-handoff .hub-select__trigger'), 'reload inbox');
  await pickHandoffTransfer(validatedId);
  document.querySelector('.hub-handoff .hub-btn-primary').click(); await until(() => document.querySelector('.draft-card'), 'reload form');
  assert.ok([...document.querySelectorAll('.hub-editor textarea')].some(input => input.value.includes('用户补充')), '刷新后恢复用户微调');
  rejectWrite = key => key === 'agentNexusCustomSkills';
  document.querySelector('.draft-card .hub-btn-primary').click();
  await until(() => document.querySelector('.hub-error')?.textContent.includes('simulated quota'), 'skill persistence failure');
  assert.ok(document.querySelector('.hub-editor'), '技能落盘失败保留编辑器');
  assert.equal((await api.readLearnDraft(validatedId)).transfer.status, 'pending');
  rejectWrite = () => false;
  beforeWrite = values => {
    if (!('agentNexusCustomSkills' in values)) return;
    beforeWrite = () => {};
    const input = [...document.querySelectorAll('.hub-editor textarea')].find(input => input.value.includes('用户补充'));
    input.value += '\n保存期间的异步更新。'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  document.querySelector('.draft-card .hub-btn-primary').click();
  await until(() => document.querySelector('.hub-error')?.textContent.includes('保存期间内容有更新'), 'late edit protection');
  assert.equal((await api.readLearnDraft(validatedId)).transfer.status, 'pending');
  rejectWrite = (key, value) => key.startsWith(api.LEARN_TRANSFER_PREFIX) && value.status === 'saved';
  document.querySelector('.draft-card .hub-btn-primary').click();
  await until(() => document.querySelector('.hub-error')?.textContent.includes('交接确认失败'), 'ack failure');
  assert.equal(api.getAllSkills().filter(skill => skill.source === 'custom').length, 1);
  assert.equal((await api.readLearnDraft(validatedId)).transfer.status, 'pending');
  rejectWrite = () => false;
  document.querySelector('.draft-card .hub-btn-primary').click();
  await until(async () => (await api.readLearnDraft(validatedId)).transfer.status === 'saved', 'save ack');
  assert.equal(api.getAllSkills().filter(skill => skill.source === 'custom').length, 1, '确认失败重试不会重复创建');
  assert.ok(api.getAllSkills()[0].body.includes('用户补充'));
  assert.ok(api.getAllSkills()[0].body.includes('保存期间的异步更新'));
  assert.deepEqual(api.getAllSkills()[0].allowedTools, draft.allowedTools);
  assert.equal((await api.completeLearnDraft(validatedId, api.getAllSkills()[0].id)).ok, true, '相同技能确认可以安全重试');
  assert.equal((await api.completeLearnDraft(validatedId, 'different-skill')).ok, false, '不能把已完成回执改绑另一技能');
  assert.equal(document.querySelector('.hub-editor'), null);
  assert.deepEqual(errors, []);
  app.unmount();
  // Corrupt recovery state must never silently fall back to an empty/original form.
  const malformed = await api.saveLearnDraft(draft, 'malformed-editor');
  storage[api.LEARN_TRANSFER_PREFIX + malformed.id].editorState = { form: { body: '不可丢弃的损坏恢复内容' } };
  document.querySelector('#hub').innerHTML = ''; mount();
  await until(() => document.querySelector('.hub-handoff .hub-select__trigger'), 'corrupt inbox');
  await pickHandoffTransfer(malformed.id);
  document.querySelector('.hub-handoff .hub-btn-primary').click();
  await until(() => document.querySelector('.hub-handoff__error'), 'corrupt snapshot blocked');
  assert.equal(document.querySelector('.hub-editor'), null);
  assert.equal(storage[api.LEARN_TRANSFER_PREFIX + malformed.id].editorState.form.body, '不可丢弃的损坏恢复内容');
  rejectRead = true;
  const unreadable = await api.listLearnDrafts(); rejectRead = false;
  assert.equal(unreadable.ok, false, '读失败与队列为空明确区分');
  assert.ok(storage[api.LEARN_TRANSFER_PREFIX + malformed.id]);
  const released = await api.claimLearnDraftEditor();
  assert.equal(released.ok, true, '失败的接收释放编辑锁'); released.release();
  const openIgnore = await api.saveLearnDraft(draft, 'already-open-editor');
  await until(() => document.querySelector('.hub-handoff .hub-select__trigger'), 'new inbox');
  await pickHandoffTransfer(openIgnore.id);
  document.querySelector('.hub-handoff .hub-btn-primary').click();
  await until(() => document.querySelector('.draft-card'), 'editor before ignore');
  assert.equal((await api.dismissLearnRecovery(draft, 'already-open-editor')).ok, true);
  await tick(); await nextTick();
  assert.ok(document.querySelector('.hub-editor'), '侧边栏忽略不销毁管理中心正在编辑的表单');
  document.querySelector('.draft-card .hub-btn-primary').click();
  await until(async () => (await api.readLearnDraft(openIgnore.id)).transfer.status === 'saved', 'ignored open editor can save');
  assert.equal(api.getAllSkills().filter(skill => skill.source === 'custom').length, 2);
  app.unmount();
  for (const item of (await api.listLearnDrafts()).transfers) {
    if (item.sourceChatId) await api.dismissLearnRecovery(item.draft, item.sourceChatId);
  }
  window.location.hash = api.learnDraftHash(validatedId);
  document.querySelector('#hub').innerHTML = ''; mount();
  await until(() => document.querySelector('.hub-handoff strong')?.textContent === '学习成果状态', 'saved deep link is a status notice');
  assert.ok(!document.querySelector('.hub-handoff').textContent.includes('请先保存正在编辑'), '已处理且无待接收项时不再显示接收操作说明');
  assert.equal(document.querySelector('.hub-handoff .hub-btn-primary'), null, '已处理时不显示接收按钮');
  assert.equal(document.querySelector('.hub-editor'), null);
  window.location.hash = api.learnDraftHash(openIgnore.id); window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await tick(); await nextTick();
  assert.deepEqual(errors, []);
  app.unmount();
  console.log('[chat-ui] Learning/validation handoff, durable receipts, legacy recovery, editor protection, refresh restoration, cross-tab locking and idempotent save passed.');
} finally { rejectWrite = () => false; rejectRead = false; dom.window.close(); }

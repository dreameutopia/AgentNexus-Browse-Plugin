/** Exercise the actual App event adapter and learning switch callback, then
 * render the actual ChatMessageList/MessageItem templates against their state. */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build, transform } from 'esbuild';
import { JSDOM } from 'jsdom';

const appFile = path.resolve('entrypoints/sidepanel/views/App.vue');
const source = parse(readFileSync(appFile, 'utf8')).descriptor.scriptSetup.content;
const ast = ts.createSourceFile(appFile + '.ts', source, ts.ScriptTarget.Latest, true);
const initializers = new Map();
let switchChat, setResponding, settled, dismissQuestionsSource;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'dismissConversationQuestions')
    dismissQuestionsSource = node.getText(ast);
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
    initializers.set(node.name.text, node.initializer.getText(ast));
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'setActiveChat')
    switchChat = node.initializer.getText(ast);
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'setResponding')
    setResponding = node.initializer.getText(ast);
  if (ts.isBinaryExpression(node) && node.left.getText(ast) === 'conversationEngine.onSettled')
    settled = node.right.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(switchChat && setResponding && settled, 'App learning lifecycle and runtime settlement must exist');
const functions = ['ensureAssistantMessage', 'applyUiRefresh', 'refreshUiMessage',
  'recordMetaOf', 'handleConversationEvent', 'requestToolApproval',
  // 会话级 UI 状态复位（会话切换 / 新建 / 学习切换共用的单一收尾：
  // 运行源 / 直播登记 / 压缩种子与感知 / 用量）
  'resetSessionScopedUiState'];
for (const name of functions) assert.ok(initializers.has(name), name);
const { code } = await transform(`
  let activeSessionIsLearn = false, uiRefreshScheduled = false;
  let pendingToolApproval = null;
  const TOOL_APPROVAL_TIMEOUT_SECONDS = 60;
  const legacyReasoningUserToggled = new Set();
  ${dismissQuestionsSource}
  ${functions.map(name => `const ${name} = ${initializers.get(name)};`).join('\n')}
  const switchChat = ${switchChat};
  const setResponding = ${setResponding};
  const settled = ${settled};
  return { switchChat, setResponding, settled, requestToolApproval, dismissConversationQuestions, event: handleConversationEvent,
    isLearnSession: () => activeSessionIsLearn };
`, { loader: 'ts', target: 'es2022' });

const listFile = path.resolve('entrypoints/sidepanel/components/chat/ChatMessageList.vue');
const output = path.resolve('node_modules/.cache/learn-chat-ui.mjs');
mkdirSync(path.dirname(output), { recursive: true });
await build({ entryPoints: [listFile], outfile: output, bundle: true,
  platform: 'node', format: 'esm', external: ['vue'], loader: { '.css': 'empty' },
  plugins: [{ name: 'chat-templates', setup(api) {
    api.onLoad({ filter: /(?:ChatMessageList|MessageItem)\.vue$/ }, args => {
      const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
      return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content,
        loader: 'ts', resolveDir: path.dirname(args.path) };
    });
    api.onResolve({ filter: /\.vue$|@\/utils\/i18n$|utils\/chat\/(?:diagram|chart|agent-image)-renderer$|utils\/chat\/(?:markdown-renderer|note-nav|message)$/ }, args => {
      if (/(?:ChatMessageList|MessageItem)\.vue$/.test(args.path)) return;
      return { path: args.path, namespace: 'ui-port' };
    });
    api.onLoad({ filter: /.*/, namespace: 'ui-port' }, args => ({ contents:
      args.path.endsWith('.vue') ? 'export default {render:()=>null};' :
      args.path === '@/utils/i18n' ? 'export const t=key=>key;' :
      args.path.endsWith('markdown-renderer') ? 'export const markdownRenderer={renderMessage:s=>s};' :
      args.path.endsWith('note-nav') ? 'export const openNoteDetail=()=>{};' :
      args.path.endsWith('/message') ? 'export const message={success:()=>{},error:()=>{}};' :
      'export const installDiagramRenderer=()=>{};export const processDiagrams=()=>{};export const installChartRenderer=()=>{};export const processCharts=()=>{};export const installAgentImages=()=>{};export const installAgentImageRenderer=()=>{};export const processAgentImages=()=>{};'
    }));
  } }],
});

const dom = new JSDOM('<div id="app"></div>', { url: 'https://example.test/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver'])
  globalThis[key] = dom.window[key];
const { createApp, h, nextTick, ref } = await import('vue');
const { default: ChatMessageList } = await import(pathToFileURL(output).href);
const frames = [];
const dialogs = new Map();
let nextDialogId = 0;
const approvalTimers = new Map();
const nativeTimeout = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
window.setTimeout = (fn, ms, ...args) => {
  if (ms !== 60000) return nativeTimeout(fn, ms, ...args);
  const id = 100000 + ++nextDialogId;
  approvalTimers.set(id, fn);
  return id;
};
window.clearTimeout = id => { approvalTimers.delete(id); nativeClear(id); };
// 直播片段流装配：App.vue 的事件适配器直接调用这些纯函数，
// 抽取执行时必须以真实实现注入（占位转真实消息要保留首截图片段）
const livePartsOutput = path.resolve('node_modules/.cache/live-parts.mjs');
await build({ stdin: { contents: "export * from './entrypoints/sidepanel/utils/chat/live-parts';", resolveDir: process.cwd(), loader: 'ts' },
  outfile: livePartsOutput, bundle: true, platform: 'node', format: 'esm' });
const liveParts = await import(pathToFileURL(livePartsOutput).href);
// 压缩片段生命周期：事件适配器镜像引擎侧写入直播消息（同一实现的注入）
const compactionPartsOutput = path.resolve('node_modules/.cache/compaction-parts-learn.mjs');
await build({ stdin: { contents: "export * from './entrypoints/sidepanel/utils/chat/compaction-part';", resolveDir: process.cwd(), loader: 'ts' },
  outfile: compactionPartsOutput, bundle: true, platform: 'node', format: 'esm' });
const compactionParts = await import(pathToFileURL(compactionPartsOutput).href);
const bindings = {
  messages: ref([{ id: 'old-user', role: 'user', content: '旧会话任务' }]),
  activeChatId: ref('old-chat'), isAiResponding: ref(false),
  pendingUiRefresh: new Map([['old-answer', { id: 'old-answer' }]]),
  runningAssistantMessages: new Map([['old-answer', {}]]),
  pendingImageRefs: new Map([['old-answer', { refs: ['old-image'] }]]),
  liveAssistantMessageId: ref(null),
  preRunCompactionSeed: new Map(),
  activeSystemPromptSuffix: ref('旧会话提示词'),
  learnRecoverableDraft: ref({ name: '旧草稿' }), contextUsage: ref({ total: 100 }),
  isCompacting: ref(true), requestAnimationFrame: fn => frames.push(fn),
  t: key => key, pushSystemNotice: () => {}, settleGuard: () => {},
  // userVisibleImageRefs（App.vue 的 user-message 展示口径）为纯函数，但其
  // 宿主模块 transcript-engine 的导入图含 chrome.storage 监听等重量级副作用，
  // 测试沙箱按语义等价桩注入（harness 记录均无图片引用，两条路径结果一致）
  userVisibleImageRefs: (record, assistantImageRefs) => {
    if (record?.uploadImageRefs !== undefined) return record.uploadImageRefs;
    const refs = record?.imageRefs ?? [];
    if (refs.length === 0 || !assistantImageRefs || assistantImageRefs.size === 0) return refs;
    const uploads = refs.filter(ref => !assistantImageRefs.has(ref));
    return uploads.length > 0 ? uploads : refs;
  },
  dismissPendingInteracts: () => {}, syncSessionContextCache: async () => {},
  openDialogWithHandle: () => {
    const id = ++nextDialogId;
    return { id, result: new Promise(resolve => dialogs.set(id, resolve)) };
  },
  // use-app-dialog 的结果语义已是 AppDialogResult（'confirm' | 'cancel' | ...）：
  // 审批语义映射为「仅 confirm = 允许」（与 App.vue requestToolApproval 同一收敛规则），
  // 测试内部继续用布尔调用，由本桥接层转换
  settleDialogById: (id, allowed) => {
    dialogs.get(id)?.(allowed === true ? 'confirm' : allowed === false ? 'cancel' : allowed);
    dialogs.delete(id);
  },
  startLiveMessage: liveParts.startLiveMessage,
  beginLiveMessage: liveParts.beginLiveMessage,
  appendLiveImage: liveParts.appendLiveImage,
  hasVisibleLiveContent: liveParts.hasVisibleLiveContent,
  pushCompactionPart: compactionParts.pushCompactionPart,
  settleCompactionPart: compactionParts.settleCompactionPart,
  settlePendingCompactionParts: compactionParts.settlePendingCompactionParts,
  createCompactionPart: compactionParts.createCompactionPart,
  historyDisplayParts: compactionParts.historyDisplayParts,
};
const adapter = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
// Run the real learning orchestration function with deferred engine ports.
// Learning uses the local engine: a background onSettled event never arrives.
const learnFile = path.resolve('entrypoints/sidepanel/composables/use-learn-session.ts');
const learnAst = ts.createSourceFile(learnFile, readFileSync(learnFile, 'utf8'), ts.ScriptTarget.Latest, true);
let runEngineSource, cleanupSource, observerSource, carrySource;
function findRun(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'runEngineOnce')
    runEngineSource = node.getText(learnAst);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'cleanupSessionImpl')
    cleanupSource = node.getText(learnAst);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'makeObserver') observerSource = node.getText(learnAst);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'collectCurrentAttemptContext') carrySource = node.getText(learnAst);
  ts.forEachChild(node, findRun);
}
findRun(learnAst);
assert.ok(runEngineSource && cleanupSource);
const receiptOutput = path.resolve('node_modules/.cache/learn-receipts.mjs');
await build({ stdin: { contents: "export * from './utils/learn/learn-validate'; export * from './utils/learn/learn-tool-policy';", resolveDir: process.cwd(), loader: 'ts' },
  outfile: receiptOutput, bundle: true, platform: 'node', format: 'esm' });
const guards = await import(pathToFileURL(receiptOutput).href);
const receiptState = {
  phase: { value: 'validating' }, sessionChatId: { value: 'learn' }, toolCalls: { value: 0 },
  contextUsage: { value: null },
  draft: { value: { name: 'demo-test', description: '同一任务', mode: 'text', allowedTools: ['browser_observe'], tags: [], category: 'general', body: 'original' } },
  failure: { value: null }, report: { value: null },
};
const originalDraft = receiptState.draft.value, persisted = [];
const currentRecords = [{ id: 'learning-old' }, { id: 'validation-new', content: '用户澄清与复核证据' }];
const receiptPorts = { ...receiptState,
  deps: { observer: () => {} }, ...guards,
  transcriptEngine: { setSystemPromptSuffix: async (_id, content) => persisted.push(content),
    getEffectiveContext: async () => ({ records: currentRecords, summary: 'learning summary', compactedAt: 1 }) },
};
const receiptCode = await transform(`let aborting=false, terminating=false; ${observerSource}\n${carrySource}
  const LEARN_FORCE_SUBMIT_HISTORY=16;
  return { observe: makeObserver('validating','text'), carry: collectCurrentAttemptContext };`, { loader: 'ts' });
const receipts = new Function(...Object.keys(receiptPorts), receiptCode.code)(...Object.values(receiptPorts));
const replacement = '## 目标\n同一任务\n## 前置条件\n起始页\n## 完成计划\n1. 搜索\n## 具体操作讲解\n### 1. 搜索\n根据文本定位并回读结果。\n## 分支与坑点\n空结果时更换输入。\n## 完成判定\n结果出现。\n## 边界\n抽样验证。';
const submittedReport = { passed: true, issues: [], revision: { body: replacement, summary: '修正通用入口', evidence: ['两个差异样本重新定位并回读成功'] } };
const receipt = (id, report = submittedReport) => receipts.observe({ type: 'tool-result', chatId: 'learn', callId: id, status: 'success', result: { data: { report } } });
receipts.observe({ type: 'tool-call', chatId: 'learn', call: { id: 'page', name: 'browser_page_exec' } });
receipt('page');
assert.equal(receiptState.draft.value, originalDraft, '页面数据伪装成 report 不能改草稿');
receipts.observe({ type: 'tool-call', chatId: 'learn', call: { id: 'bad', name: 'submit_validation' } });
receipt('bad', { ...submittedReport, revision: { body: 'bad' } });
assert.equal(receiptState.report.value, null, '非法修订不被静默标为通过');
assert.equal(receiptState.draft.value, originalDraft);
receipts.observe({ type: 'tool-call', chatId: 'learn', call: { id: 'valid', name: 'submit_validation' } });
receipt('valid');
assert.equal(receiptState.draft.value.body, replacement, '实际观察者应用完整修订正文');
assert.equal(receiptState.draft.value.name, originalDraft.name);
assert.equal(receiptState.draft.value.allowedTools, originalDraft.allowedTools);
assert.equal(JSON.parse(persisted[0]).body, replacement, '会话回放保存修订后的成果');
receipt('valid', { passed: true, issues: [] });
assert.equal(persisted.length, 1, '重复回执不会覆盖终态');
const carried = await receipts.carry('learn', new Set(['learning-old']), 'learning summary');
assert.deepEqual(carried.records, [currentRecords[1]], '收尾仅携带本次验证的证据');
assert.equal(carried.summary, '', '验证收尾不能混入学习阶段遗留摘要');
// 引擎用量快照经观察者进入学习状态数据源；跨会话事件不得串扰
receipts.observe({ type: 'context-usage', chatId: 'learn', usage: { totalTokens: 12, ratio: 0.6, threshold: 20 } });
assert.equal(receiptState.contextUsage.value.totalTokens, 12, 'Engine usage snapshots feed the learning status data');
receipts.observe({ type: 'context-usage', chatId: 'other', usage: { totalTokens: 1, ratio: 0.05, threshold: 20 } });
assert.equal(receiptState.contextUsage.value.totalTokens, 12, 'Foreign chat usage must not leak into learning status');
receipts.observe({ type: 'context-usage', chatId: 'learn', usage: { totalTokens: 18, ratio: 0.9, threshold: 20 } });
assert.equal(receiptState.contextUsage.value.totalTokens, 18, 'Later snapshots overwrite earlier ones within the same stage');
let completeRun, rejectBuild = false, runOptions;
let builtInput;
let glowActive = false;
const reportPageOperation = () => () => {};
const runBindings = {
  deps: { setResponding: adapter.setResponding, requestToolApproval: adapter.requestToolApproval,
    beginPageGlow: () => {
      assert.equal(glowActive, false, 'Each stage owns exactly one glow scope');
      glowActive = true;
      return { beginPageOperation: reportPageOperation, stop: () => { glowActive = false; } };
    },
    dismissQuestions: () => adapter.dismissConversationQuestions() },
  config: { value: { targetMode: 'text', learningLimits: { maxIterations: 12, maxDurationMinutes: 7 }, validationLimits: { maxIterations: 8, maxDurationMinutes: 4 } } }, draft: { value: { mode: 'text', allowedTools: ['browser_observe'] } },
  stageRunLimits: guards.stageRunLimits,
  validationToolIds: guards.validationToolIds,
  sessionChatId: { value: 'learn-chat' },
  runtimeBuilder: { build: async input => {
    builtInput = input;
    if (rejectBuild) throw new Error('build failed');
    return { limits: input.limitsOverride, toolIds: input.extraToolIds, advertisedToolIds: input.extraToolIds };
  } },
  conversationEngine: { run: (_runtime, options) => {
    runOptions = options;
    return new Promise(resolve => { completeRun = resolve; });
  }, abort: () => {
    assert.equal(glowActive, false, 'Explicit stop retires the glow before engine cleanup');
    completeRun({ status: 'aborted' });
  } },
  sessionDeletionEngine: { deleteSession: async () => {
    assert.equal(dialogs.size, 0, 'Close approval before deleting the session');
  } },
  makeObserver: () => adapter.event,
};
const runCode = await transform(`
  let activeRun = null, activeGlow, aborting = false, terminating = false, learningFeedback = null, limitAction = null;
  const LEARN_LIMITS = {}, LEARN_FORCE_SUBMIT_LIMITS = {}, LEARN_VISION_RUNTIME = {};
  const scenarioFor = () => 'learning', getPresetToolIds = () => [], visionFor = () => false;
  const handleLimitReached = () => false;
  const forceSubmitMessage = () => '', learnKickoffMessage = () => '';
  const forceValidateMessage = () => '', validateKickoffMessage = () => '';
  const buildLearnPrompt = () => '', buildValidatePrompt = () => '';
  const clearLearnDraft = async () => {}, reset = async () => {};
  ${runEngineSource}
  ${cleanupSource}
  return { runOnce: runEngineOnce, cleanup: cleanupSessionImpl };
`, { loader: 'ts', target: 'es2022' });
const learning = new Function(...Object.keys(runBindings), runCode.code)(...Object.values(runBindings));
const { runOnce } = learning;
const errors = [];
const app = createApp({ render: () => h(ChatMessageList, {
  messages: bindings.messages.value, showChatMode: true,
  isAiResponding: bindings.isAiResponding.value,
  liveMessageId: bindings.liveAssistantMessageId.value,
}) });
app.config.errorHandler = error => errors.push(error);
const flush = async () => { while (frames.length) frames.shift()(); await nextTick(); };
const checkLive = () => {
  assert.ok(document.querySelector('[data-streaming="1"]'), 'Latest assistant must stay live');
  assert.equal(document.querySelectorAll('.message-actions').length, 0, 'No copy/feedback during output');
  assert.equal(document.querySelectorAll('.prelude-header').length, 0, 'No final prelude collapse during output');
};
/** 直播翻转回归：运行期间追加的任何顶层消息（旧实现的压缩气泡正是如此）
 * 不得把流式消息挤成「已结束」渲染——按 liveMessageId 精确命中后，
 * 尾部追加的外来消息不影响直播态。 */
const checkLiveWithTrailingForeign = () => {
  bindings.messages.value.push({
    id: `foreign-${bindings.messages.value.length}`, role: 'assistant', content: '外来消息',
    parts: [{ type: 'notice', content: '外来消息' }], toolCalls: [], isSystemNotice: true,
  });
  checkLive();
  bindings.messages.value.pop();
};
try {
  app.mount('#app');
  adapter.switchChat('learn-chat');
  assert.equal(bindings.activeChatId.value, 'learn-chat');
  assert.equal(adapter.isLearnSession(), true);
  assert.deepEqual(bindings.messages.value, [], 'New learning transcript must not append to previous chat');
  for (const name of ['pendingUiRefresh', 'runningAssistantMessages', 'pendingImageRefs'])
    assert.equal(bindings[name].size, 0, `${name} must not survive chat switch`);
  assert.equal(bindings.activeSystemPromptSuffix.value, '');
  assert.equal(bindings.learnRecoverableDraft.value, null);
  assert.equal(bindings.contextUsage.value, null);
  assert.equal(bindings.isCompacting.value, false);
  // 引擎每轮测量的真实用量驱动用量环（与学习状态条同一事件源）
  adapter.event({ type: 'context-usage', chatId: 'learn-chat', usage: { totalTokens: 5, ratio: 0.25, threshold: 20 } });
  assert.equal(bindings.contextUsage.value.totalTokens, 5, 'Engine usage snapshots drive the context ring');
  adapter.event({ type: 'context-usage', chatId: 'other-chat', usage: { totalTokens: 999, ratio: 5, threshold: 20 } });
  assert.equal(bindings.contextUsage.value.totalTokens, 5, 'Foreign chat usage events are gated by chatId');

  adapter.event({ type: 'assistant-start', chatId: 'old-chat', messageId: 'late-old' });
  assert.equal(bindings.isAiResponding.value, false, 'Foreign start must not change response state');
  // 压缩进行中切换会话：旧会话的压缩事件被会话守卫丢弃，压缩感知必须由
  // 切换路径显式复位——否则新会话的圆环会永远呼吸在「正在压缩…」
  bindings.isCompacting.value = true;
  adapter.switchChat('learn-chat');
  assert.equal(bindings.isCompacting.value, false, 'Session switch must reset the compaction indicator');
  for (const stage of ['learning', 'validating']) {
    const running = runOnce(stage);
    assert.equal(glowActive, true, 'Light the target during local runtime assembly');
    assert.equal(bindings.isAiResponding.value, true, 'Responding must include runtime assembly');
    await Promise.resolve();
    assert.deepEqual(builtInput.limitsOverride, stage === 'learning'
      ? { maxIterations: 12, maxDurationMs: 7 * 60000 } : { maxIterations: 8, maxDurationMs: 4 * 60000 }, '阶段独立预算进入真实运行装配');
    assert.equal(runOptions.resetBudgetOnContinue, true);
    assert.equal(runOptions.beginPageOperation, reportPageOperation);
    const chatId = 'learn-chat', messageId = stage;
    // Learning and validation must call the very same approval UI as chat.
    for (const allowed of [true, false]) {
      const pending = runOptions.onToolApproval({ name: 'browser_interact', argumentsPreview: '支付订单' });
      assert.equal(dialogs.size, 1, 'Approval callback must open a real UI request');
      bindings.settleDialogById([...dialogs.keys()][0], allowed);
      assert.equal(await pending, allowed, 'User decision must return to learning engine');
      assert.equal(approvalTimers.size, 0);
    }
    const timedOut = runOptions.onToolApproval({ name: 'browser_interact', argumentsPreview: '支付订单' });
    [...approvalTimers.values()][0]();
    assert.equal(await timedOut, false);
    assert.equal(dialogs.size, 0, 'Approval timeout must also remove the dialog');
    adapter.event({ type: 'user-message', chatId, record: { id: `${stage}-task`, content: stage, createdAt: 1 } });
    adapter.event({ type: 'assistant-start', chatId, messageId });
    assert.equal(bindings.isAiResponding.value, true, `${stage} bypasses ordinary send entry`);
    adapter.event({ type: 'reasoning', chatId, messageId, delta: '推理中' });
    adapter.event({ type: 'token', chatId, messageId, delta: '仍在输出' });
    await flush();
    checkLive();
    adapter.event({ type: 'token', chatId, messageId, delta: '，继续输出' });
    await flush(); checkLive();
    checkLiveWithTrailingForeign();
    adapter.event({ type: 'assistant-complete', chatId, record: {
      id: messageId, role: 'assistant', content: '完成', createdAt: 1,
      parts: [{ type: 'reasoning', content: '推理' }, { type: 'text', content: '完成' }], toolCalls: [],
    } });
    completeRun({ status: 'completed' });
    await running;
    assert.equal(glowActive, false);
    assert.equal(bindings.isAiResponding.value, false);
    await flush();
    assert.equal(document.querySelectorAll('[data-streaming="1"]').length, 0);
    assert.ok(document.querySelector('.message-actions'), 'Actions appear on settlement');
    assert.ok(document.querySelector('.prelude-header'), 'Prelude may collapse after settlement');
    // Isolate the next phase's footer assertions from the previous completed reply.
    bindings.messages.value = [];
  }
  for (const terminal of ['assistant-error', 'aborted']) {
    const running = runOnce('learning');
    await Promise.resolve();
    adapter.event({ type: 'assistant-start', chatId: 'learn-chat', messageId: terminal });
    adapter.event({ type: 'token', chatId: 'learn-chat', messageId: terminal, delta: '部分输出' });
    await flush(); checkLive();
    adapter.event({ type: terminal, chatId: 'learn-chat', messageId: terminal, error: '测试失败' });
    const pendingApproval = runOptions.onToolApproval({ name: 'browser_interact', argumentsPreview: '支付订单' });
    completeRun({ status: terminal === 'aborted' ? 'aborted' : 'error' });
    await running;
    assert.equal(glowActive, false);
    assert.equal(await pendingApproval, false, 'Run exit must release pending approval');
    assert.equal(dialogs.size, 0);
    await flush();
    assert.equal(bindings.isAiResponding.value, false, `${terminal} must release response state`);
    assert.equal(document.querySelectorAll('[data-streaming="1"]').length, 0);
    bindings.messages.value = [];
  }
  // Explicit learning stop must settle approval BEFORE waiting for activeRun,
  // otherwise a local engine can wait up to its approval timeout to exit.
  const stoppedRun = runOnce('validating');
  await Promise.resolve();
  const stoppedApproval = runOptions.onToolApproval({ name: 'browser_interact', argumentsPreview: '支付订单' });
  await learning.cleanup();
  await stoppedRun;
  assert.equal(await stoppedApproval, false);
  assert.equal(dialogs.size, 0);
  assert.equal(approvalTimers.size, 0);
  rejectBuild = true;
  await assert.rejects(runOnce('learning'), /build failed/);
  assert.equal(glowActive, false, 'Assembly failure must release the glow scope');
  assert.equal(bindings.isAiResponding.value, false, 'Assembly failure must release responding state');
  bindings.activeChatId.value = 'other-chat';
  bindings.isAiResponding.value = true;
  adapter.setResponding('learn-chat', false);
  adapter.settled('learn-chat', {});
  assert.equal(bindings.isAiResponding.value, true, 'Late completion must not change another chat');
  assert.deepEqual(errors, []);
  console.log('[chat-ui] Learning chat isolation, learning/validation live rendering, final actions, error/abort settlement passed.');
} finally { app.unmount(); dom.window.close(); }

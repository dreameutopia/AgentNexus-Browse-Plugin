/** App 事件适配器的截屏时间线回归：vision 自动截图必须按发生顺序内联在
 * 消息片段流中，而不是退化成「消息末尾挂一张图」。
 *
 * 抽取 App.vue 的真实事件适配器（handleConversationEvent 等）执行真实事件
 * 序列：首截图（message-image 先于 assistant-start 到达）→ 占位转真实消息
 * （正文/推理）→ 工具调用 → 工具后的自动重截图 → 正文。
 *
 * 运行：node tests/chat-ui/vision-timeline.test.mjs（npm run test:chat-ui）
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';
import { build, transform } from 'esbuild';
import { JSDOM } from 'jsdom';

const appFile = path.resolve('entrypoints/sidepanel/views/App.vue');
const source = parse(readFileSync(appFile, 'utf8')).descriptor.scriptSetup.content;
const ast = ts.createSourceFile(appFile + '.ts', source, ts.ScriptTarget.Latest, true);
const initializers = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    initializers.set(node.name.text, node.initializer.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const functions = ['ensureAssistantMessage', 'applyUiRefresh', 'refreshUiMessage', 'recordMetaOf', 'handleConversationEvent'];
for (const name of functions) assert.ok(initializers.has(name), `App.vue 必须存在 ${name}`);

// 片段流装配的真实实现（占位转真实消息要保留首截图片段）
const livePartsOutput = path.resolve('node_modules/.cache/live-parts-timeline.mjs');
await build({
  stdin: { contents: "export * from './entrypoints/sidepanel/utils/chat/live-parts';", resolveDir: process.cwd(), loader: 'ts' },
  outfile: livePartsOutput, bundle: true, platform: 'node', format: 'esm',
});
const liveParts = await import(pathToFileURL(livePartsOutput).href);
// 压缩片段生命周期的真实实现（事件适配器镜像引擎侧写入直播消息）
const compactionPartOutput = path.resolve('node_modules/.cache/compaction-part-timeline.mjs');
await build({
  stdin: { contents: "export * from './entrypoints/sidepanel/utils/chat/compaction-part';", resolveDir: process.cwd(), loader: 'ts' },
  outfile: compactionPartOutput, bundle: true, platform: 'node', format: 'esm',
});
const compactionParts = await import(pathToFileURL(compactionPartOutput).href);

const { code } = await transform(`
  let uiRefreshScheduled = false;
  const legacyReasoningUserToggled = new Set();
  ${functions.map(name => `const ${name} = ${initializers.get(name)};`).join('\n')}
  return { event: handleConversationEvent };
`, { loader: 'ts', target: 'es2022' });

const dom = new JSDOM('<div id="app"></div>', { url: 'https://example.test/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver']) {
  globalThis[key] = dom.window[key];
}
const { ref } = await import('vue');
const frames = [];
const bindings = {
  messages: ref([]),
  activeChatId: ref('vision-chat'),
  isAiResponding: ref(false),
  isCompacting: ref(false),
  contextUsage: ref({ total: 0 }),
  runningAssistantMessages: new Map(),
  pendingImageRefs: new Map(),
  pendingUiRefresh: new Map(),
  liveAssistantMessageId: ref(null),
  preRunCompactionSeed: new Map(),
  requestAnimationFrame: fn => frames.push(fn),
  t: key => key,
  pushSystemNotice: () => {},
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
const flush = async () => {
  while (frames.length) {
    const frame = frames.shift();
    frame();
    await Promise.resolve();
  }
};

const chatId = 'vision-chat';
const messageId = 'vision-msg';
const kinds = message => (message.parts ?? []).map(part => part.type);
const imageRefs = message => (message.parts ?? [])
  .filter(part => part.type === 'image')
  .map(part => part.imageRef);

// 1. 首截图事件先于 assistant-start 到达（引擎准备阶段顺序）
adapter.event({ type: 'message-image', chatId, messageId, imageRef: 'shot-1' });
assert.equal(bindings.messages.value.length, 0, '消息尚未建立时首截图先缓冲');
adapter.event({ type: 'assistant-start', chatId, messageId });
assert.equal(bindings.messages.value.length, 1);
const message = bindings.messages.value[0];
assert.deepEqual(kinds(message), ['image', 'text'], '占位即含首截图片段（置于片段流最前）');
assert.deepEqual(message.imageRefs, ['shot-1']);

// 2. 首个内容事件（推理）到达：占位转真实消息 —— 首截图不得被清空
adapter.event({ type: 'reasoning', chatId, messageId, delta: '观察页面' });
assert.deepEqual(kinds(message), ['image', 'reasoning'], '占位转真实消息后首截图仍在片段流最前');

// 3. 正文与工具调用按序追加
adapter.event({ type: 'token', chatId, messageId, delta: '我来点击登录' });
assert.deepEqual(kinds(message), ['image', 'reasoning', 'text']);
adapter.event({
  type: 'tool-call', chatId, messageId,
  call: { id: 't1', name: 'vision_gui', status: 'pending', arguments: '{}' },
});
assert.deepEqual(kinds(message), ['image', 'reasoning', 'text', 'tool']);

// 4. 工具后的自动重截图：紧跟其轮次追加
adapter.event({ type: 'message-image', chatId, messageId, imageRef: 'shot-2' });
assert.deepEqual(kinds(message), ['image', 'reasoning', 'text', 'tool', 'image']);
assert.deepEqual(imageRefs(message), ['shot-1', 'shot-2'], '两次截屏按发生顺序内联');
assert.deepEqual(message.imageRefs, ['shot-1', 'shot-2'], '引用集合与片段流同序');

adapter.event({ type: 'token', chatId, messageId, delta: '已完成' });
assert.deepEqual(kinds(message), ['image', 'reasoning', 'text', 'tool', 'image', 'text']);
assert.deepEqual(imageRefs(message), ['shot-1', 'shot-2'], '正文续写不改变截图顺序');

// 5. 终态以引擎记录为准覆盖：片段顺序与直播态一致（按下标合并不失位）
adapter.event({
  type: 'assistant-complete', chatId,
  record: {
    id: messageId, role: 'assistant', content: '已完成', createdAt: 1,
    parts: [
      { type: 'image', imageRef: 'shot-1' },
      { type: 'reasoning', content: '观察页面' },
      { type: 'text', content: '我来点击登录' },
      { type: 'tool', toolCall: { id: 't1', name: 'vision_gui', status: 'success', arguments: '{}' } },
      { type: 'image', imageRef: 'shot-2' },
      { type: 'text', content: '已完成' },
    ],
    toolCalls: [{ id: 't1', name: 'vision_gui', status: 'success', arguments: '{}' }],
    imageRefs: ['shot-1', 'shot-2'],
  },
});
const settled = bindings.messages.value.find(item => item.id === messageId);
assert.deepEqual(kinds(settled), ['image', 'reasoning', 'text', 'tool', 'image', 'text'], '终态片段顺序与直播态一致');
assert.deepEqual(imageRefs(settled), ['shot-1', 'shot-2']);

// ── 6. 运行中压缩：事件序列在直播消息时间线上落成压缩片段（pending → 结算），
//      不再产生独立气泡消息（气泡会把流式消息挤成终态渲染）──
const compactId = 'msg-compact';
adapter.event({ type: 'assistant-start', chatId, messageId: compactId });
assert.equal(bindings.liveAssistantMessageId.value, compactId, '直播消息 id 登记');
adapter.event({ type: 'token', chatId, messageId: compactId, delta: '长任务进行中' });
adapter.event({ type: 'compaction', chatId, messageId: compactId, phase: 'start', trigger: 'runtime', originalTokens: 147968 });
const compactMessage = bindings.messages.value.find(item => item.id === compactId);
assert.equal(bindings.messages.value.length, 2, '压缩进度不新增顶层消息（时间线条目代替气泡）');
assert.equal(bindings.isCompacting.value, true);
const compactPart = compactMessage.parts.at(-1);
assert.equal(compactPart.type, 'compaction');
assert.equal(compactPart.compaction.status, 'pending');
assert.equal(compactPart.compaction.originalTokens, 147968);
adapter.event({
  type: 'compaction', chatId, messageId: compactId, phase: 'done', trigger: 'runtime',
  originalTokens: 147968, summaryTokens: 2560, summary: '<summary><task>任务</task></summary>',
});
assert.equal(compactPart.compaction.status, 'success');
assert.equal(compactPart.compaction.summaryTokens, 2560);
assert.equal(bindings.isCompacting.value, false);
// 压缩后继续输出：片段按序追加在压缩行之后
adapter.event({ type: 'token', chatId, messageId: compactId, delta: '，继续执行' });
assert.deepEqual(
  kinds(compactMessage).slice(-2),
  ['compaction', 'text'],
  '压缩后正文按序追加在压缩行之后',
);
// 终态：直播 id 清空（回落非直播渲染，反馈按钮回归）
adapter.event({ type: 'assistant-complete', chatId, record: { id: compactId, role: 'assistant', content: '完成', createdAt: 1, parts: compactMessage.parts, toolCalls: [] } });
assert.equal(bindings.liveAssistantMessageId.value, null, '终态清空直播消息登记');

// ── 7. 发送前压缩（pre-run）：无 messageId，结果缓冲并在 assistant-start
//    时种子为消息首个片段（引擎侧 runtime.preRunCompaction 持久化同一数据）──
adapter.event({ type: 'compaction', chatId, phase: 'start', trigger: 'pre-run' });
assert.equal(bindings.isCompacting.value, true, 'pre-run start 只驱动压缩感知');
adapter.event({
  type: 'compaction', chatId, phase: 'done', trigger: 'pre-run',
  originalTokens: 51200, summaryTokens: 1024, summary: '<summary>先前会话</summary>',
});
const seededId = 'msg-prerun';
adapter.event({ type: 'message-image', chatId, messageId: seededId, imageRef: 'shot-3' });
adapter.event({ type: 'assistant-start', chatId, messageId: seededId });
const seeded = bindings.messages.value.find(item => item.id === seededId);
const seededKinds = kinds(seeded);
assert.equal(seededKinds[0], 'compaction', '发送前压缩种子置于片段流最前');
assert.equal(seededKinds[1], 'image', '首截图随后（压缩先于本轮一切内容）');
assert.equal(seeded.parts[0].compaction.status, 'success');
assert.equal(seeded.parts[0].compaction.originalTokens, 51200);
assert.equal(seeded.parts[0].compaction.trigger, 'pre-run', '种子带上触发路径（与引擎侧同构）');
// 失败的发送前压缩同样种子（错误行持久呈现）
adapter.event({ type: 'assistant-complete', chatId, record: { id: seededId, role: 'assistant', content: '完成', createdAt: 1, parts: seeded.parts, toolCalls: [] } });
adapter.event({ type: 'compaction', chatId, phase: 'failed', trigger: 'pre-run', error: '压缩请求失败: 超时' });
const failedSeedId = 'msg-prerun-2';
adapter.event({ type: 'assistant-start', chatId, messageId: failedSeedId });
const failedSeed = bindings.messages.value.find(item => item.id === failedSeedId);
assert.equal(failedSeed.parts[0].compaction.status, 'error');
assert.equal(failedSeed.parts[0].compaction.error, '压缩请求失败: 超时');

dom.window.close();
console.log('[vision-timeline] App 事件适配器：首截图按序内联、工具后重截图紧跟其轮次、终态不失位、压缩时间线条目（运行中 + 发送前种子）。');

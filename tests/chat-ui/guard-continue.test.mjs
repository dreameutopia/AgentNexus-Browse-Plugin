/**
 * 守卫停止注记「继续」的资格判定回归。
 *
 * 与 API 错误重试共用 isResumeTailCurrent：只有注记仍是时间线末尾、
 * 且注记之后没有任何新输出（用户消息 / 模型输出 / 系统注记 / 新片段 /
 * 正文追加）时才允许继续；其余情况一律友好拒绝且不发起发送。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync('entrypoints/sidepanel/views/App.vue', 'utf8')
  .split('<script setup lang="ts">')[1]
  .split('</script>')[0];
const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ['isResumeTailCurrent', 'isGuardContinueCurrent', 'handleGuardContinue'];
const declarations = names
  .map(name =>
    ast.statements
      .find(
        node =>
          ts.isVariableStatement(node) &&
          node.declarationList.declarations.some(
            declaration => declaration.name.getText(ast) === name,
          ),
      )
      .getText(ast),
  )
  .join('\n');
const code = ts.transpileModule(declarations, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const ref = value => ({ value });
const notice = '已停止执行：达到对话轮次上限（30 轮）且未确认继续。';
const stopped = () => ({
  id: 'assistant',
  role: 'assistant',
  content: 'done\n\n' + notice,
  parts: [
    { type: 'text', content: 'done' },
    { type: 'notice', content: notice, noticeAction: 'guard-stop', guardKind: 'max-iterations' },
  ],
});
const user = { id: 'user', role: 'user', content: 'original' };
const alerts = [];
const sent = [];
const ports = {
  messages: ref([user, stopped()]),
  activeChatId: ref('chat'),
  isAiResponding: ref(false),
  sendInFlight: ref(false),
  isStopping: ref(false),
  activeSessionIsLearn: false,
  showAlert: async text => alerts.push(text),
  t: key => key,
  executeSend: async (retry, guardContinue) => sent.push({ retry, guardContinue }),
  conversationEngine: { isRunning: () => false },
};
const { handleGuardContinue } = new Function(
  'ports',
  'with (ports) { ' + code + ';return {handleGuardContinue}; }',
)(ports);

const target = [ 'assistant', 1 ];

// 1. 正常继续：注记仍是末尾 → 发起发送，请求携带原始定位与注记全文
await handleGuardContinue(...target);
assert.equal(sent.length, 1);
assert.deepEqual(sent[0].guardContinue, {
  chatId: 'chat',
  messageId: 'assistant',
  partIndex: 1,
  expectedNotice: notice,
});

// 2. 展示层正文漂移（rAF 旧快照覆盖导致正文缺少注记）不应误判失效：
//    片段仍以守卫注记为末尾，结构上没有任何后续输出 → 允许继续
ports.messages.value = [user, stopped()];
ports.messages.value[1].content = 'done';
await handleGuardContinue(...target);
assert.equal(sent.length, 2, 'content drift must not invalidate a structurally-current notice');
assert.equal(sent[1].guardContinue.messageId, 'assistant');

// 3. 迟到截图 / 压缩等非对话输出片段不构成新轮次 → 仍允许继续
ports.messages.value = [user, stopped()];
ports.messages.value[1].parts.push({ type: 'image', imageRef: 'late-shot' });
await handleGuardContinue(...target);
assert.equal(sent.length, 3, 'presentation-only trailing parts must not invalidate continue');
assert.equal(alerts.includes('sidepanel.chat.guardContinueExpired'), false);

// 4. 注记之后出现任何新消息/输出 → 全部失效
for (const extra of [
  { id: 'new-user', role: 'user', content: 'new' },
  { id: 'new-assistant', role: 'assistant', content: 'new' },
  { id: 'notice', role: 'assistant', content: 'notice', isSystemNotice: true },
  { id: 'hidden', role: 'user', content: '继续', isIgnore: true },
]) {
  ports.messages.value = [user, stopped(), extra];
  await handleGuardContinue(...target);
  assert.equal(alerts.at(-1), 'sidepanel.chat.guardContinueExpired');
  assert.equal(sent.length, 3, 'stale notice must not send');
}

// 5. 同一消息追加新的正文/推理/工具片段 → 失效（图片/压缩之外的输出）
for (const laterPart of [
  { type: 'text', content: 'later output' },
  { type: 'reasoning', content: 'later thought' },
  { type: 'tool', toolCall: { id: 'late-tool' } },
]) {
  ports.messages.value = [user, stopped()];
  ports.messages.value[1].parts.push(laterPart);
  await handleGuardContinue(...target);
  assert.equal(alerts.at(-1), 'sidepanel.chat.guardContinueExpired');
}

// 6. 同一消息正文追加输出 → 失效
ports.messages.value = [user, stopped()];
ports.messages.value[1].content += '\nlater output';
await handleGuardContinue(...target);
assert.equal(alerts.at(-1), 'sidepanel.chat.guardContinueExpired');

// 7. 下标漂移：点击时携带的原始下标因展示过滤偏移，仍应解析到唯一的
//    守卫注记并携带**真实下标**进入发送流程
ports.messages.value = [user, stopped()];
await handleGuardContinue('assistant', 0);
assert.equal(sent.at(-1).guardContinue.partIndex, 1, 'drifted index must resolve to the real notice');

// 8. 注记缺少可交互元数据 → 失效
ports.messages.value = [user, stopped()];
delete ports.messages.value[1].parts[1].noticeAction;
await handleGuardContinue(...target);
assert.equal(alerts.at(-1), 'sidepanel.chat.guardContinueExpired');

// 9. 在途运行 / 学习态 / 无真实用户轮 → 各自友好拒绝
ports.messages.value = [user, stopped()];
ports.isAiResponding.value = true;
await handleGuardContinue(...target);
assert.equal(alerts.at(-1), 'sidepanel.chat.guardContinueBusy');
ports.isAiResponding.value = false;

ports.conversationEngine.isRunning = () => true;
await handleGuardContinue(...target);
assert.equal(alerts.at(-1), 'sidepanel.chat.guardContinueBusy');
ports.conversationEngine.isRunning = () => false;

ports.activeSessionIsLearn = true;
await handleGuardContinue(...target);
assert.equal(alerts.at(-1), 'sidepanel.chat.guardContinueLearnBlocked');
ports.activeSessionIsLearn = false;

ports.messages.value = [{ ...user, isIgnore: true }, stopped()];
await handleGuardContinue(...target);
assert.equal(alerts.at(-1), 'sidepanel.chat.guardContinueNoContext');

assert.equal(sent.length, 4, 'only structurally-current continues may reach the send pipeline');
console.log('[chat-ui] Guard-stop continue eligibility, staleness and busy guards passed.');

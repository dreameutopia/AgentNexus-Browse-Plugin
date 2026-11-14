import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync('entrypoints/sidepanel/views/App.vue', 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0];
const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ['reportSendError', 'sendMessageInner', 'isResumeTailCurrent', 'retryFromErrorCard'];
const declarations = names.map(name => ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === name)).getText(ast)).join('\n');
const code = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const ref = value => ({ value });
const error = '<api-error kind="error"><summary>failed</summary></api-error>';
const failed = () => ({ id: 'assistant', role: 'assistant', content: 'partial\n' + error, parts: [{ type: 'text', content: 'partial\n' + error }] });
const user = { id: 'user', role: 'user', content: 'original' };
const alerts = [], sent = [];
const ports = {
  messages: ref([user, failed()]), activeChatId: ref('chat'), isAiResponding: ref(false), sendInFlight: ref(false), isStopping: ref(false),
  activeSessionIsLearn: false, showAlert: async text => alerts.push(text), t: key => key,
  executeSend: async retry => sent.push(retry),
};
const { retryFromErrorCard, sendMessageInner, reportSendError } = new Function('ports', 'with (ports) { ' + code + ';return {retryFromErrorCard,sendMessageInner,reportSendError}; }')(ports);
const target = { messageId: 'assistant', partIndex: 0, errorIndex: 0 };
await retryFromErrorCard(target);
assert.equal(sent.length, 1);
for (const message of [{ role: 'user', content: 'new' }, { role: 'assistant', content: 'new' }, { isSystemNotice: true, content: 'notice' }]) {
  ports.messages.value = [user, failed(), message];
  await retryFromErrorCard(target);
  assert.equal(alerts.at(-1), 'sidepanel.chat.apiErrorRetryExpired');
}
ports.messages.value = [user, failed()];
ports.messages.value[1].content += 'later output';
ports.messages.value[1].parts[0].content += 'later output';
await retryFromErrorCard(target);
assert.equal(sent.length, 1);
ports.messages.value = [user, failed()];
ports.messages.value[1].parts.push({ type: 'reasoning', content: 'new reasoning' });
await retryFromErrorCard(target);
assert.equal(sent.length, 1);
ports.messages.value = [user, failed()];
ports.messages.value[1].content += '\n' + error;
ports.messages.value[1].parts[0].content += '\n' + error;
await retryFromErrorCard(target);
assert.equal(sent.length, 1, 'only the newest failure can retry');
await retryFromErrorCard({ ...target, errorIndex: 1 });
assert.equal(sent.length, 2);
// A previous error may live in a collapsed prelude and be absent from the DOM.
ports.messages.value[1].parts.push({ type: 'reasoning', content: 'thinking' }, { type: 'text', content: error });
ports.messages.value[1].content += error;
await retryFromErrorCard({ ...target, partIndex: 2 });
assert.equal(sent.length, 3, 'card index belongs to the original text part');
ports.isAiResponding.value = true;
await retryFromErrorCard({ ...target, partIndex: 2 });
assert.equal(alerts.at(-1), 'sidepanel.chat.apiErrorRetryBusy');
ports.isAiResponding.value = false;
// Run the actual send pipeline with a long draft, image, file and page quote present.
let runtimeInput, receivedRuntime;
const draftAttachments = [{ id: 'image', kind: 'image', dataUrl: 'data:image/png;base64,draft' }, { id: 'file', kind: 'text', text: 'private draft file' }];
Object.assign(ports, {
  userInput: ref('draft'.repeat(6000)), pendingAttachments: ref(draftAttachments), confirmedQuote: ref({ text: 'private draft quote' }),
  modelRegistry: { configured: true }, attachmentManager: { isAdding: ref(true), clearAttachments: () => assert.fail('retry cleared attachments') },
  conversationEngine: { isRunning: () => false, run: async runtime => { receivedRuntime = runtime; return { status: 'done' }; } },
  MAX_USER_INPUT_CHARS: 20000, selectedAgent: ref(''), selectedSkills: ref([]), activeModelRef: ref('model'),
  activeOption: ref({ contextThreshold: 100000 }), CONTEXT_THRESHOLD_DEFAULT: 100000,
  activeSystemPromptSuffix: ref(''), agentEngine: {}, showAgentSelector: ref(true), showSkillSelector: ref(true), showChatMode: ref(true),
  transcriptEngine: { updateSessionUsage: async () => {}, getEffectiveContext: async () => ({ records: [{ id: 'assistant', status: 'error', content: ports.messages.value.at(-1).content }] }) },
  storeEffectiveContext: () => {}, importWorkspaceFiles: async () => new Map(), messageTextarea: ref({ style: { height: '123px' } }),
  runtimeBuilder: { build: async input => { runtimeInput = input; return { userInput: '', userImages: [], attachmentPrompt: '', pageQuotePrompt: '', initialContext: [], activationContext: [], toolIds: [], systemPrompt: '', model: { contextThreshold: 100000 } }; } },
  contextUsage: ref(null), measureContextUsage: () => ({}), composeLlmUserMessage: () => ({}), queryActivePageInfo: async () => null, estimateMessageTokens: () => 0, estimateTextTokens: () => 0,
  preRunAbortController: null, runEpoch: 0, selectionSignature: () => '', handleConversationEvent: () => {}, isCompacting: ref(false), syncSessionContextCache: async () => {},
});
const draft = ports.userInput.value, quote = ports.confirmedQuote.value;
// Capture requests use the same pipeline while preserving drafts and the originating chat.
ports.isStopping.value = true;
ports.waitForStopSettled = async () => { ports.activeChatId.value = 'another-chat'; };
await sendMessageInner(() => {}, undefined, undefined, { text: 'Create a reusable Skill', chatId: 'chat' });
assert.equal(runtimeInput, undefined, 'switching chats while waiting invalidates the capture request');
assert.equal(ports.userInput.value, draft);
ports.isStopping.value = false;
ports.activeChatId.value = 'chat';
const retry = { chatId: 'chat', messageId: 'assistant', content: ports.messages.value.at(-1).content };
await sendMessageInner(() => {}, retry);
assert.ok(receivedRuntime, 'retry reaches the engine');
assert.equal(runtimeInput.userInput, '');
assert.deepEqual(runtimeInput.userImages, []);
assert.equal(runtimeInput.pageQuote, undefined);
assert.deepEqual(receivedRuntime.retryTarget, { messageId: 'assistant', content: retry.content });
assert.equal(ports.userInput.value, draft);
assert.equal(ports.pendingAttachments.value, draftAttachments);
assert.equal(ports.confirmedQuote.value, quote);
assert.equal(ports.messageTextarea.value.style.height, '123px');
console.log('[chat-ui] Retry expiry, repeated failures, collapsed errors and full draft isolation passed.');

const failureRow = structuredClone(ports.messages.value.at(-1));
Object.assign(failureRow, { status: 'error', createdAt: 1, reasoning: '', toolCalls: [] });
let persistedFailure;
ports.transcriptEngine.loadSessionRecords = async () => [user, failureRow];
ports.transcriptEngine.flush = async record => { persistedFailure = structuredClone(record); };
ports.toApiErrorBlock = () => error;
ports.recordToUiMessage = record => ({ ...record });
ports.pendingUiRefresh = new Map();
await reportSendError(new Error('preparation failed'), retry);
assert.equal(ports.messages.value.length, 2, 'preparation failure also stays in the original assistant row');
assert.equal(persistedFailure.status, 'error');
assert.equal(persistedFailure.parts.at(-1).content, error, 'preparation failure is a new independent error part');
assert.equal(ports.messages.value.at(-1).content, retry.content + '\n\n' + error);
const countBefore = sent.length;
await retryFromErrorCard({ messageId: 'assistant', partIndex: persistedFailure.parts.length - 1, errorIndex: 0 });
assert.equal(sent.length, countBefore + 1, 'the latest preparation failure can be retried');

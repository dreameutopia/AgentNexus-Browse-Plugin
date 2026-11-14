import assert from 'node:assert/strict';
import { ConversationEngine } from '../../entrypoints/sidepanel/core/conversation/conversation-engine';
import { transcriptEngine } from '../../entrypoints/sidepanel/core/context/transcript-engine';
import { contextEngine } from '../../entrypoints/sidepanel/core/context/context-engine';
import { API_ERROR_RETRY_EXPIRED } from '../../entrypoints/sidepanel/utils/chat/retry-state';
import type { ChatMessageRecord } from '../../entrypoints/sidepanel/core/types';
const originals = { user: transcriptEngine.appendUserMessage, assistant: transcriptEngine.createAssistantRecord,
  flush: transcriptEngine.flush, load: transcriptEngine.loadSessionRecords };
const records: ChatMessageRecord[] = [];
let sequence = 0, requests = 0;
const make = (role: 'user' | 'assistant', content = ''): ChatMessageRecord => ({
  id: 'retry_' + ++sequence, seq: sequence, chatId: 'retry-chat', role, content,
  parts: [], reasoning: '', toolCalls: [], status: role === 'user' ? 'done' : 'streaming', createdAt: 1, updatedAt: 1,
});
try {
  transcriptEngine.appendUserMessage = async (_chat, content) => { const record = make('user', content); records.push(record); return record; };
  transcriptEngine.createAssistantRecord = async () => make('assistant');
  transcriptEngine.loadSessionRecords = async () => structuredClone(records);
  transcriptEngine.flush = async record => {
    const index = records.findIndex(item => item.id === record.id);
    if (index < 0) records.push(structuredClone(record)); else records[index] = structuredClone(record);
  };
  const send = async (_messages: any, callbacks: any) => {
    requests++;
    if (requests === 1) { callbacks.onToken('first partial'); throw new Error('network failure'); }
    if (requests === 2) throw new Error('second failure');
    callbacks.onToken(' continued answer');
    return { finalMessage: { role: 'assistant', content: ' continued answer' }, finishReason: 'stop' };
  };
  const engine = new ConversationEngine({ sendStream: send, sendVision: send, requiresApproval: () => false } as any);
  const runtime: any = { chatId: 'retry-chat', systemPrompt: 'policy', toolIds: [],
    model: { model: 'test', provider: 'openai', contextThreshold: 1000000 },
    limits: { maxIterations: 5, maxDurationMs: 60000, maxToolFailures: 5 }, vision: null,
    userInput: 'original instruction', userImages: [], attachmentPrompt: '', initialContext: [], activationContext: [], priorMaxSeq: 0 };
  await engine.run(runtime);
  assert.equal(records.length, 2);
  const first = structuredClone(records[1]);
  // A retry must also extend an existing compacted protocol snapshot.
  records[1].modelContext = await contextEngine.toProtocolMessages(records);
  const resume = async () => {
    const previous = structuredClone(records[1]);
    const context = await contextEngine.toProtocolMessages(records);
    const events: any[] = [];
    const summary = await engine.run({ ...runtime, userInput: '', initialContext: context,
      retryTarget: { messageId: previous.id, content: previous.content }, priorMaxSeq: previous.seq }, { observer: event => events.push(event) });
    assert.equal(records.length, 2, 'retry must update the original record');
    assert.equal(records[1].id, first.id);
    assert.ok(events.find(event => event.type === 'assistant-start')?.record.content.startsWith(first.content));
    return summary;
  };
  await resume();
  assert.equal(records[1].status, 'error');
  assert.equal((records[1].content.match(/<api-error\b/g) ?? []).length, 2, 'repeated failure is a distinct error block');
  const latestFailure = structuredClone(records[1]);
  await assert.rejects(engine.run({ ...runtime, userInput: '', initialContext: [{ role: 'user', content: 'context' }],
    retryTarget: { messageId: first.id, content: first.content } }), { message: API_ERROR_RETRY_EXPIRED });
  assert.equal(requests, 2, 'an older error cannot send a request');
  await resume();
  assert.equal(records[1].status, 'done');
  assert.ok(records[1].content.startsWith(latestFailure.content));
  assert.ok(records[1].content.endsWith(' continued answer'));
  const replay = await contextEngine.toProtocolMessages(records);
  assert.ok(replay.some(message => typeof message.content === 'string' && message.content.includes('original instruction')));
  assert.ok(replay.some(message => message.content === ' continued answer'), 'continuation survives history replay');
  records.push(make('user', 'new instruction'));
  await assert.rejects(engine.run({ ...runtime, userInput: '', initialContext: replay,
    retryTarget: { messageId: latestFailure.id, content: latestFailure.content } }), { message: API_ERROR_RETRY_EXPIRED });
  assert.equal(requests, 3);
  const count = records.length;
  await assert.rejects(engine.run({ ...runtime, initialContext: replay,
    retryTarget: { messageId: latestFailure.id, content: latestFailure.content } }), { message: API_ERROR_RETRY_EXPIRED });
  assert.equal(records.length, count, 'invalid retry must not append the supplied user input');
  console.log('[retry] original record, repeated failure, stale rejection, draft isolation and replay passed');
} finally {
  transcriptEngine.appendUserMessage = originals.user; transcriptEngine.createAssistantRecord = originals.assistant;
  transcriptEngine.flush = originals.flush; transcriptEngine.loadSessionRecords = originals.load;
}

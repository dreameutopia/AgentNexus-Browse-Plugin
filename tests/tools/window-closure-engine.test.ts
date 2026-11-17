import assert from 'node:assert/strict';
import { ConversationEngine } from '../../entrypoints/sidepanel/core/conversation/conversation-engine';
import { transcriptEngine } from '../../entrypoints/sidepanel/core/context/transcript-engine';
import type { ChatMessageRecord } from '../../entrypoints/sidepanel/core/types';
import { markdownRenderer } from '../../entrypoints/sidepanel/utils/chat/markdown-renderer';

const native = (globalThis as any).chrome;
const originals = { user: transcriptEngine.appendUserMessage, assistant: transcriptEngine.createAssistantRecord, flush: transcriptEngine.flush };
const listeners = new Set<(id: number) => void>();
const records: ChatMessageRecord[] = [];
let sequence = 0;
const make = (chatId: string, role: 'user' | 'assistant', content = '') => ({
  id: `window-close-${++sequence}`, seq: sequence, chatId, role, content, reasoning: '', parts: [], toolCalls: [],
  createdAt: 1, updatedAt: 1, status: role === 'user' ? 'done' : 'streaming',
}) as ChatMessageRecord;
try {
  (globalThis as any).chrome = { ...native,
    windows: { ...native.windows, get: async (id: number) => ({ id, type: 'normal' }),
      onRemoved: { addListener: (listener: (id: number) => void) => listeners.add(listener), removeListener: (listener: (id: number) => void) => listeners.delete(listener) } },
    tabs: { ...native.tabs, query: async () => [{ id: 700, windowId: 101, title: 'Work', url: 'https://example.com' }] },
  };
  transcriptEngine.appendUserMessage = async (chatId, content) => make(chatId, 'user', content);
  transcriptEngine.createAssistantRecord = async chatId => make(chatId, 'assistant');
  transcriptEngine.flush = async record => {
    const index = records.findIndex(item => item.id === record.id);
    if (index < 0) records.push(structuredClone(record)); else records[index] = structuredClone(record);
  };
  const runtime = (chatId: string): any => ({ chatId, browserScope: { mode: 'bound-window', windowId: 101 },
    systemPrompt: 'policy', toolIds: [], model: { model: 'test', provider: 'openai', contextThreshold: 1000000 },
    limits: { maxIterations: 5, maxConsecutiveFailedToolRounds: 5 }, vision: null,
    userInput: 'work', userImages: [], attachmentPrompt: '', initialContext: [], activationContext: [], priorMaxSeq: 0 });
  let entered!: () => void;
  let release!: () => void;
  const streaming = new Promise<void>(resolve => { entered = resolve; });
  const send = async (_messages: any, callbacks: any) => {
    callbacks.onToken('Partial answer'); entered();
    await new Promise<void>(resolve => { release = resolve; });
    return { finalMessage: { role: 'assistant', content: 'Partial answer' }, finishReason: 'stop' };
  };
  const engine = new ConversationEngine({ sendStream: send, sendVision: send, requiresApproval: () => false } as any);
  const events: any[] = [];
  const task = engine.run(runtime('window-close-stream'), { observer: event => events.push(event) });
  await streaming;
  for (const listener of [...listeners]) listener(202);
  assert.equal(engine.isRunning('window-close-stream'), true, 'Unrelated window closures do not stop the run');
  for (const listener of [...listeners]) listener(101);
  release();
  const summary = await task;
  assert.equal(summary.status, 'error');
  assert.match(summary.error ?? '', /<api-error\b/);
  assert.equal(events.filter(event => event.type === 'assistant-error').length, 1);
  assert.equal(events.some(event => event.type === 'aborted'), false, 'Window closure is not mislabeled as a user Stop');
  const record = records.find(item => item.id === summary.messageId)!;
  assert.equal(record.status, 'error');
  assert.match(record.content, /Partial answer/);
  assert.match(record.content, /BOUND_WINDOW_CLOSED/);
  assert.match(markdownRenderer.renderMessage(record.content), /api-error-card/, 'The persisted error uses a supported renderable tag');
  assert.equal(engine.isRunning('window-close-stream'), false);
  assert.equal(listeners.size, 0);

  // A guard UI may never resolve. Closing the target must still finish the run.
  let guardEntered!: () => void;
  const guarded = new Promise<void>(resolve => { guardEntered = resolve; });
  const guardedRuntime = runtime('window-close-guard');
  guardedRuntime.limits.maxDurationMs = -1; // An already-expired guard, independent of clock resolution.
  const guardTask = engine.run(guardedRuntime, {
    onLimitReached: async () => { guardEntered(); return new Promise<boolean>(() => {}); },
  });
  await guarded;
  for (const listener of [...listeners]) listener(101);
  assert.equal((await guardTask).status, 'error');
  assert.equal(listeners.size, 0);
  console.log('[window-closure-engine] Streaming, guard cancellation, persistence, renderable error and cleanup passed.');
} finally {
  transcriptEngine.appendUserMessage = originals.user;
  transcriptEngine.createAssistantRecord = originals.assistant;
  transcriptEngine.flush = originals.flush;
  (globalThis as any).chrome = native;
}

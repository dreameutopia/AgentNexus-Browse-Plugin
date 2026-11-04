import { strict as assert } from 'node:assert';
import { ConversationEngine } from '../../entrypoints/sidepanel/core/conversation/conversation-engine';
import { contextEngine } from '../../entrypoints/sidepanel/core/context/context-engine';
import { contextCompactor, ContextCompactor } from '../../entrypoints/sidepanel/core/context/compactor';
import { transcriptEngine } from '../../entrypoints/sidepanel/core/context/transcript-engine';
import { imageStore } from '../../entrypoints/sidepanel/core/images/image-store';
import { prepareProtocolHistory, protocolImageRefs, storeProtocolMessages } from '../../entrypoints/sidepanel/core/context/protocol-history';
import { aiUsageMetrics } from '../../entrypoints/sidepanel/utils/metrics/usage-metrics-engine';
import type { ChatMessageRecord } from '../../entrypoints/sidepanel/core/types';
import type { ChatMessage } from '../../entrypoints/sidepanel/utils/ai/ai-chat-api';
import { toolRegistry } from '../../tools/registry';
import { chatDatabase } from '../../entrypoints/sidepanel/core/context/chat-database';

const originals = {
  put: imageStore.putFromDataUrl, get: imageStore.getDataUrl,
  user: transcriptEngine.appendUserMessage, assistant: transcriptEngine.createAssistantRecord,
  flush: transcriptEngine.flush, window: (globalThis as any).window,
  compact: contextCompactor.compact,
};
const images = new Map<string, string>();
let imageSeq = 0, seq = 0;
const records: ChatMessageRecord[] = [];
function record(role: 'user' | 'assistant', content = ''): ChatMessageRecord {
  return { id: `cache_${++seq}`, seq, chatId: 'cache-test', role, content, parts: [], reasoning: '', toolCalls: [], status: role === 'user' ? 'done' : 'streaming', createdAt: 1, updatedAt: 1 };
}
try {
  (globalThis as any).window = globalThis;
  imageStore.putFromDataUrl = async url => {
    const found = [...images].find(([, value]) => value === url);
    if (found) return found[0];
    const ref = (++imageSeq).toString(16).padStart(64, '0'); images.set(ref, url); return ref;
  };
  imageStore.getDataUrl = async ref => images.get(ref) ?? null;
  transcriptEngine.appendUserMessage = async (_chat, text) => { const r = record('user', text); records.push(r); return r; };
  transcriptEngine.createAssistantRecord = async () => { const r = record('assistant'); records.push(r); return r; };
  transcriptEngine.flush = async () => {};

  const sent: ChatMessage[][] = [], options: any[] = [];
  let request = 0, screenshot = 0;
  const send = async (messages: ChatMessage[], callbacks: any, opts: any) => {
    sent.push(structuredClone(messages)); options.push(opts); request++;
    const content = request === 1 ? 'inspect first' : 'complete'; callbacks.onToken?.(content);
    const finalMessage: ChatMessage = request === 1
      ? { role: 'assistant', content, tool_calls: [{ id: 'test-call', type: 'function', function: { name: 'vision_gui', arguments: '{}' } }] }
      : { role: 'assistant', content };
    finalMessage.nativeReplay = { provider: 'openai', model: 'test', items: [{ reasoning_content: 'retained provider state' }] };
    if (request === 1) callbacks.onToolCall?.(finalMessage.tool_calls![0]);
    return { finalMessage, finishReason: request === 1 ? 'tool_calls' : 'stop' };
  };
  const engine = new ConversationEngine({ sendStream: send, sendVision: send, requiresApproval: () => false,
    executeTool: async (name: string) => name === 'screenshot'
      ? { success: true, data: { screenshot: `data:image/png;base64,${btoa(`image${++screenshot}`)}`, text: `screenshot-${screenshot}` } }
      : { success: true, data: { text: 'source evidence: exact result' + 'x'.repeat(12000) + 'END_EVIDENCE' } },
  } as any) as any;
  engine.interruptibleDelay = async () => {};
  const runtime: any = { chatId: 'cache-test', agentId: 'Vision-Agent', systemPrompt: 'stable policy',
    toolIds: ['screenshot', 'vision_gui'], advertisedToolIds: ['screenshot', 'vision_gui'],
    model: { provider: 'openai', model: 'test', contextThreshold: 64000 },
    limits: { maxIterations: 5, maxDurationMs: 10000, toolTimeoutMs: 1000, maxConsecutiveFailedToolRounds: 5 },
    vision: { screenshotTool: 'screenshot', screenshotArgs: {}, reScreenshotAfterTools: true },
    userInput: 'analyze current page', attachmentPrompt: 'FULL ATTACHMENT TEXT', userImages: [], initialContext: [],
    activationContext: [
      { role: 'assistant', content: '', tool_calls: [{ id: 'activation_0', type: 'function', function: { name: 'load_skill', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'activation_0', name: 'load_skill', content: '{"success":true,"instruction":"preserve exact evidence"}' },
    ], priorMaxSeq: 0 };
  const result = await engine.run(runtime, {});
  assert.equal(result.status, 'done');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].slice(0, sent[0].length), sent[0], 'within-run history must remain append-only');
  assert.equal(options[1].metrics.prefixChanged, false);
  assert.ok(sent[1].some(m => m.role === 'tool' && (m.content as string).includes('END_EVIDENCE')), 'tools exceeding 8KB must reach the model intact when the window fits');
  assert.deepEqual(options[0].tools, options[1].tools, 'tool catalog must remain unchanged');
  const reloaded = structuredClone(records);
  await prepareProtocolHistory(reloaded);
  const replay = contextEngine.toProtocolMessages(reloaded);
  assert.equal(JSON.stringify(replay.slice(0, sent[1].length - 1)), JSON.stringify(sent[1].slice(1)), 'reload must preserve every prior model-facing message');
  assert.ok(JSON.stringify(replay).includes('FULL ATTACHMENT TEXT'));
  assert.equal(replay.filter(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')).length, 2);
  assert.equal(replay.at(-1)?.content, 'complete');
  assert.equal(replay.at(-1)?.nativeReplay?.items[0].reasoning_content, 'retained provider state');
  assert.ok(protocolImageRefs(reloaded[0].modelMessages).length === 1, 'initial screenshot belongs to the exact user input');
  await engine.run({ ...runtime, userInput: 'continue', attachmentPrompt: '', initialContext: replay }, {});
  assert.deepEqual(sent[2].slice(0, sent[1].length), sent[1], 'next user send must retain the entire previous request prefix');
  assert.notEqual(records[1].modelMessages?.[0].tool_calls?.[0].id, records[3].modelMessages?.[0].tool_calls?.[0].id, 'synthetic skill call IDs must be unique across persisted runs');

  const large = record('assistant');
  large.modelMessages = await storeProtocolMessages(Array.from({ length: 150 }, (_, i) => ({ role: 'user', content: [
    { type: 'text', text: String(i) }, { type: 'image_url', image_url: { url: `data:image/png;base64,${btoa(String(i))}`, detail: 'high' } },
  ] })));
  await prepareProtocolHistory([large]);
  assert.equal(contextEngine.toProtocolMessages([large]).length, 150, 'record hydration must not depend on the global image LRU capacity');
  assert.equal(protocolImageRefs(large.modelMessages).length, 150, 'all model image references must participate in retention');
  const bad = { ...record('user', 'recoverable original'), modelMessages: [{ role: 'user', content: null }] } as any;
  await prepareProtocolHistory([bad]);
  assert.equal(contextEngine.toProtocolMessages([bad])[0].content, 'recoverable original');
  const missing = record('user');
  missing.modelMessages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `agentnexus-image:${'f'.repeat(64)}` } }] }];
  await prepareProtocolHistory([missing]);
  assert.ok(JSON.stringify(contextEngine.toProtocolMessages([missing])).includes('Historical image unavailable'));
  const partial = record('assistant'); partial.modelMessages = [];
  partial.modelPartial = { role: 'assistant', content: 'unfinished reasoning result', tool_calls: [{ id: 'pending', type: 'function', function: { name: 'vision_gui', arguments: '{}' } }] };
  const interrupted = contextEngine.toProtocolMessages([partial]);
  assert.equal(interrupted[0].content, 'unfinished reasoning result');
  assert.equal(interrupted[1].tool_call_id, 'pending');
  assert.equal(JSON.parse(interrupted[1].content as string).success, false);
  const beforeCompression = record('user', 'original evidence stays in the transcript');
  const latestInput = record('user', 'latest actual request');
  const compactedRecord = record('assistant'); compactedRecord.modelMessages = [];
  const latestMessage: ChatMessage = { role: 'user', content: latestInput.content };
  latestInput.modelMessages = await storeProtocolMessages([latestMessage]);
  contextCompactor.compact = async () => ({ summary: 'task and original evidence retained', originalTokens: 10000, summaryTokens: 10, droppedOldest: 0 });
  const compactHandle: any = { history: [{ role: 'user', content: beforeCompression.content }, latestMessage], runUserMessage: latestMessage,
    record: compactedRecord, abortController: new AbortController(), emit: () => {} };
  assert.equal(await engine.tryCompactHistory({ ...runtime, priorMaxSeq: 0 }, compactHandle), true);
  await engine.appendModelMessages(compactHandle, [{ role: 'assistant', content: 'completed after compression' }]);
  const compressedReload = structuredClone([beforeCompression, latestInput, compactedRecord]);
  await prepareProtocolHistory(compressedReload);
  const compressedReplay = contextEngine.toProtocolMessages(compressedReload);
  assert.equal(compressedReplay.length, 3, 'reload continues the compacted history instead of expanding old rounds');
  assert.ok((compressedReplay[0].content as string).includes('task and original evidence retained'));
  assert.equal(compressedReplay[1].content, latestInput.content);
  assert.equal(compressedReplay[2].content, 'completed after compression');
  assert.equal(beforeCompression.content, 'original evidence stays in the transcript');
  assert.deepEqual(contextEngine.toProtocolMessages([], { summary: 'legacy summary' }), contextEngine.toProtocolMessages([], { summary: 'legacy summary' }), 'missing legacy compaction time must not regenerate a timestamp');

  aiUsageMetrics.reset();
  for (const [channelId, agentId, iteration, cached] of [['A', 'vision', 1, 0], ['A', 'vision', 2, 80], ['B', 'auto', 1, 50]] as const) {
    aiUsageMetrics.record({ provider: 'openai', model: 'same-model', channelId, modelId: 'm', agentId, iteration, runId: 'r', kind: 'chat', outcome: 'success', usage: { inputTokens: 100, cachedInputTokens: cached } });
  }
  aiUsageMetrics.record({ provider: 'openai', model: 'same-model', channelId: 'A', agentId: 'vision', iteration: 3, kind: 'chat', outcome: 'success', usage: { inputTokens: 100 } });
  const metrics = aiUsageMetrics.getSnapshot();
  assert.equal(metrics.totals.cachedInputTokens, 130);
  assert.equal(metrics.totals.cacheEligibleInputTokens, 300, 'unreported cache usage is excluded');
  assert.equal(metrics.totals.cacheHitRequests, 2);
  assert.equal(metrics.totals.cacheObservedRequests, 3);
  assert.equal(metrics.totals.continuationInputTokens, 100);
  assert.equal(metrics.totals.continuationCachedTokens, 80);
  assert.equal(metrics.models.filter(m => m.channelId === 'B').length, 1);
  assert.equal(metrics.scopes.find(m => m.channelId === 'B')?.agentId, 'auto');
  assert.equal(metrics.recentRequests.length, 4);
  assert.equal(metrics.recentRequests[0].usage?.cachedInputTokens, undefined);
  const migrated = (aiUsageMetrics as any).parseStored({ schemaVersion: 1, startedAt: 1, updatedAt: 2,
    totals: { inputTokens: 1000, cachedInputTokens: 500, cacheEligibleInputTokens: 1000, cacheReportedRequests: 10 },
    byModel: { 'openai::legacy': { provider: 'openai', model: 'legacy', inputTokens: 1000, cachedInputTokens: 500 } }, recentErrors: [] });
  assert.equal(migrated.totals.cachedInputTokens, 500, 'legacy totals must survive migration');
  assert.equal(migrated.totals.cacheObservedRequests, 0, 'legacy data must not invent request-level hit ratios');
  assert.equal(migrated.byModel['openai::legacy'].inputTokens, 1000);
  for (const mode of ['read', 'images']) {
    const textRequests: ChatMessage[][] = []; let round = 0;
    const toolName = mode === 'read' ? 'browser_get_page_text' : 'screenshot';
    const textSend = async (messages: ChatMessage[], _callbacks: any) => {
      textRequests.push(structuredClone(messages));
      return { finalMessage: ++round === 1 ? { role: 'assistant', content: 'inspect', tool_calls: Array.from({ length: mode === 'images' ? 6 : 1 }, (_, i) =>
        ({ id: `text-${mode}-${i}`, type: 'function', function: { name: toolName, arguments: '{}' } })) } : { role: 'assistant', content: 'done' }, finishReason: round === 1 ? 'tool_calls' : 'stop' };
    };
    let image = 0;
    const textEngine = new ConversationEngine({ sendStream: textSend, sendVision: textSend, requiresApproval: () => false,
      executeTool: async () => mode === 'read' ? { success: true, data: { text: 'complete evidence' } }
        : { success: true, data: { screenshot: `data:image/png;base64,${btoa(`text-loop-${++image}`)}`, text: `viewport-${image}` } },
    } as any);
    assert.equal((await textEngine.run({ ...runtime, chatId: `text-${mode}`, vision: null, userInput: 'text loop', attachmentPrompt: '', activationContext: [],
      toolIds: [toolName], advertisedToolIds: [toolName] }, {})).status, 'done');
    assert.equal(textRequests.length, 2);
    assert.deepEqual(textRequests[1].slice(0, textRequests[0].length), textRequests[0]);
    if (mode === 'images') {
      const parts = textRequests[1].flatMap(m => Array.isArray(m.content) ? m.content : []);
      assert.equal(parts.filter(p => p.type === 'image_url').length, 6, 'text agents receive every screenshot in the multimodal channel');
      assert.ok(textRequests[1].filter(m => m.role === 'tool').every(m => !(m.content as string).includes('base64,')));
    }
  }
  let oversizedSends = 0;
  const oversized = new ConversationEngine({ sendStream: async () => { oversizedSends++; throw new Error('must not send'); } } as any);
  assert.equal((await oversized.run({ ...runtime, vision: null, userInput: '中'.repeat(20000), attachmentPrompt: '', activationContext: [], initialContext: [],
    model: { ...runtime.model, contextThreshold: 8192 } }, {})).status, 'error');
  assert.equal(oversizedSends, 0, 'a failed compaction must not silently send a history with deleted messages');
  const compactionInputs: ChatMessage[][] = [];
  const compactor = new ContextCompactor({ sendStream: async (messages: ChatMessage[]) => {
    compactionInputs.push(structuredClone(messages));
    return { finalMessage: { role: 'assistant', content: '<summary>All task constraints and evidence retained</summary>' }, finishReason: 'stop' };
  } } as any);
  const summarized = await compactor.compact({ model: runtime.model, threshold: 8192, messages: [
    { role: 'user', content: 'FIRST_FACT:' + '中'.repeat(15000) + ':LAST_FACT' },
    { role: 'user', content: [{ type: 'text', text: 'visual evidence' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==', detail: 'high' } }] },
  ] });
  assert.equal(summarized.droppedOldest, 0, 'hierarchical compaction must process all original records');
  const allCompactionText = JSON.stringify(compactionInputs);
  assert.ok(allCompactionText.includes('FIRST_FACT:') && allCompactionText.includes(':LAST_FACT'));
  assert.ok(compactionInputs.some(messages => messages.some(m => Array.isArray(m.content) && m.content.some(part => part.type === 'image_url'))), 'summarizer must see actual visual evidence');
  for (const mode of ['schema', 'drift']) {
    const source: ChatMessage = { role: 'user', content: 'immutable history' };
    let calls = 0; const definitions: any[] = [];
    const tool = toolRegistry.getTool('browser_get_page_text')!;
    const description = tool.openaiSchema.function.description;
    try {
      const send = async (_messages: ChatMessage[], _callbacks: any, options: any) => {
        definitions.push(structuredClone(options.toolDefinitions));
        return { finalMessage: ++calls === 1 ? { role: 'assistant', content: 'inspect', tool_calls: [
          { id: `guard-${mode}`, type: 'function', function: { name: 'browser_get_page_text', arguments: '{}' } },
        ] } : { role: 'assistant', content: 'done' }, finishReason: calls === 1 ? 'tool_calls' : 'stop' };
      };
      const guarded = new ConversationEngine({ sendStream: send, sendVision: send, requiresApproval: () => false,
        executeTool: async () => {
          if (mode === 'drift') source.content = 'unexpected mutation';
          else tool.openaiSchema.function.description = 'unexpected live schema update';
          return { success: true, data: { text: 'result' } };
        },
      } as any);
      const result = await guarded.run({ ...runtime, vision: null, initialContext: [source], userInput: 'continue', attachmentPrompt: '', activationContext: [],
        toolIds: ['browser_get_page_text'], advertisedToolIds: ['browser_get_page_text'] }, {});
      assert.equal(result.status, mode === 'drift' ? 'error' : 'done');
      assert.equal(calls, mode === 'drift' ? 1 : 2, 'unexpected non-compaction mutations must never reach the provider');
      if (mode === 'schema') assert.deepEqual(definitions[0], definitions[1], 'per-run schema snapshots remain immutable');
    } finally { tool.openaiSchema.function.description = description; }
  }
  const dbMethods = { save: chatDatabase.saveMessage, page: chatDatabase.getMessagesPage, session: chatDatabase.getSession };
  const saved = new Map<string, ChatMessageRecord>();
  const unsaved = record('assistant', 'UI evidence'); unsaved.status = 'streaming';
  unsaved.modelMessages = [{ role: 'assistant', content: 'exact model evidence survives quota failure' }];
  try {
    chatDatabase.getSession = async () => null;
    chatDatabase.getMessagesPage = async () => ({ records: [...saved.values()], hasMore: false }) as any;
    chatDatabase.saveMessage = async () => { throw new Error('simulated quota failure'); };
    await originals.flush.call(transcriptEngine, unsaved);
    const recovered = await transcriptEngine.getEffectiveContext(unsaved.chatId);
    assert.equal(contextEngine.toProtocolMessages(recovered.records).find(m => m.role === 'assistant')?.content, 'exact model evidence survives quota failure', 'failed writes cannot silently erase the next-turn prefix');
    chatDatabase.saveMessage = async message => { saved.set(message.id, structuredClone(message)); return { inserted: true, skipped: false }; };
    await originals.flush.call(transcriptEngine, unsaved);
    let rejectOld: (error: Error) => void = () => {};
    let first = true;
    chatDatabase.saveMessage = async message => {
      if (first) { first = false; return new Promise((_resolve, reject) => { rejectOld = reject; }); }
      saved.set(message.id, structuredClone(message)); return { inserted: false, skipped: false };
    };
    const older = originals.flush.call(transcriptEngine, unsaved);
    unsaved.modelMessages = [{ role: 'assistant', content: 'newer committed round' }];
    await originals.flush.call(transcriptEngine, unsaved);
    rejectOld(new Error('late old write failure')); await older;
    const current = await transcriptEngine.getEffectiveContext(unsaved.chatId);
    assert.equal(contextEngine.toProtocolMessages(current.records).find(m => m.role === 'assistant')?.content, 'newer committed round', 'late failures must not resurrect an older snapshot');
  } finally {
    chatDatabase.saveMessage = dbMethods.save; chatDatabase.getMessagesPage = dbMethods.page; chatDatabase.getSession = dbMethods.session;
  }
  console.log('[prompt-cache] exact replay, cross-send prefixes, image retention and scoped metrics passed');
} finally {
  imageStore.putFromDataUrl = originals.put; imageStore.getDataUrl = originals.get;
  transcriptEngine.appendUserMessage = originals.user; transcriptEngine.createAssistantRecord = originals.assistant;
  transcriptEngine.flush = originals.flush; (globalThis as any).window = originals.window;
  contextCompactor.compact = originals.compact;
}

import assert from 'node:assert/strict';
import { OpenAIAdapter } from '../../entrypoints/sidepanel/utils/stream/adapters/openai-adapter';
import { ResponsesAdapter } from '../../entrypoints/sidepanel/utils/stream/adapters/responses-adapter';
import { ClaudeAdapter } from '../../entrypoints/sidepanel/utils/stream/adapters/claude-adapter';
import { GeminiAdapter } from '../../entrypoints/sidepanel/utils/stream/adapters/gemini-adapter';
import { OllamaAdapter } from '../../entrypoints/sidepanel/utils/stream/adapters/ollama-adapter';
import { replayScope, nativePartIndex, inputReplayPrefix, staticReplayPrefix } from '../../entrypoints/sidepanel/utils/stream/adapters/native-replay';
import { estimateMessageTokens } from '../../entrypoints/sidepanel/utils/ai/token-estimate';
import { StreamClient } from '../../entrypoints/sidepanel/utils/stream/stream-client';
import type { ProtocolAdapter, StreamRequestConfig, UnifiedChatMessage } from '../../entrypoints/sidepanel/utils/stream/types';

const sse = (...events: any[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
const claudeFixture = (id: string) => sse(
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private plan' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `opaque-${id}` } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: `redacted-${id}` } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Working' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id, name: 'probe', input: {} } },
  { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"value":1}' } },
  { type: 'content_block_stop', index: 3 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' },
);
const cases: Array<{ adapter: ProtocolAdapter; fixture: (id: string) => string; assertNative: (message: UnifiedChatMessage) => void }> = [
  { adapter: new OpenAIAdapter(), fixture: id => sse({ choices: [{ delta: { content: 'Working', reasoning_content: 'private plan', tool_calls: [
    { index: 0, id, function: { name: 'probe', arguments: '{"value":1}' } },
  ] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n', assertNative: m => assert.equal(m.nativeReplay?.items[0].reasoning_content, 'private plan') },
  { adapter: new OllamaAdapter(), fixture: id => JSON.stringify({ done: true, message: { content: 'Working', thinking: 'private plan', tool_calls: [
    { id, function: { name: 'probe', arguments: { value: 1 } } },
  ] } }) + '\n', assertNative: m => assert.equal(m.nativeReplay?.items[0].thinking, 'private plan') },
  { adapter: new ClaudeAdapter(), fixture: claudeFixture, assertNative: m => {
    assert.equal(m.nativeReplay?.items[0].signature, `opaque-${m.tool_calls![0].id}`);
    assert.equal(m.nativeReplay?.items[1].type, 'redacted_thinking');
    assert.equal(m.nativeReplay?.items[3].input.value, 1);
  } },
  { adapter: new GeminiAdapter(), fixture: id => sse({ candidates: [{ content: { parts: [
    { text: 'private plan', thought: true }, { text: 'Working' },
    { functionCall: { id, name: 'probe', args: { value: 1 } }, thoughtSignature: `opaque-${id}` },
    { text: '', thoughtSignature: `tail-${id}` },
  ] }, finishReason: 'STOP' }] }), assertNative: m => {
    assert.equal(m.nativeReplay?.items[2].thoughtSignature, `opaque-${m.tool_calls![0].id}`);
    assert.equal(m.nativeReplay?.items[3].text, ''); assert.ok(m.nativeReplay?.items[3].thoughtSignature);
  } },
  { adapter: new ResponsesAdapter(), fixture: id => sse({ type: 'response.completed', response: { output: [
    { type: 'reasoning', id: `rs-${id}`, summary: [], encrypted_content: `opaque-${id}` },
    { type: 'message', id: `msg-${id}`, role: 'assistant', content: [{ type: 'output_text', text: 'Working', annotations: [] }] },
    { type: 'function_call', id: `fc-${id}`, call_id: id, name: 'probe', arguments: '{"value":1}', status: 'completed' },
  ], usage: { input_tokens: 100, output_tokens: 10, output_tokens_details: { reasoning_tokens: 7 } } } }), assertNative: m => {
    assert.equal(m.nativeReplay?.items[0].encrypted_content, `opaque-${m.tool_calls![0].id}`);
    assert.equal(m.nativeReplay?.items[1].id, `msg-${m.tool_calls![0].id}`);
  } },
];

function clean(value: any): any {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([k, v]) => [k, clean(v)]));
}
function sequence(body: any): any[] { return body.input ?? body.messages ?? body.contents; }
function assertPrefix(before: any, after: any): void {
  before = clean(before); after = clean(after);
  for (const key of ['model', 'tools', 'system', 'systemInstruction', 'temperature', 'tool_choice']) assert.deepEqual(after[key], before[key]);
  const old = sequence(before), next = sequence(after);
  assert.ok(next.length >= old.length);
  for (let i = 0; i < old.length; i++) {
    if (i === old.length - 1 && (old[i].parts || Array.isArray(old[i].content))) {
      const key = old[i].parts ? 'parts' : 'content';
      assert.equal(next[i].role, old[i].role);
      assert.deepEqual(next[i][key].slice(0, old[i][key].length), old[i][key]);
    } else assert.deepEqual(next[i], old[i]);
  }
}

export async function testNativeCache(): Promise<void> {
  assert.equal(nativePartIndex('3'), 3);
  assert.equal(nativePartIndex(1e9), 0);
  assert.equal(nativePartIndex(-1), 0);
  assert.doesNotThrow(() => estimateMessageTokens({ role: 'assistant', content: '', tool_calls: [null] }));
  for (const { adapter, fixture, assertNative } of cases) for (const visual of [false, true]) {
    const history: UnifiedChatMessage[] = [{ role: 'system', content: 'immutable system' }, { role: 'user', content: visual
      ? [{ type: 'text', text: 'task' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==', detail: 'high' } }]
      : 'task' }];
    const config: StreamRequestConfig = { model: 'same-model', replayScope: replayScope(adapter.providerType, 'https://endpoint.example', 'same-model'),
      messages: history, tools: [{ type: 'function', function: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } } }] };
    let previous = adapter.buildRequestBody(config);
    for (let round = 0; round < 3; round++) {
      const emitted: string[] = [], thoughts: string[] = [];
      const bytes = new TextEncoder().encode(fixture(`call_${round}`));
      const reader = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }).getReader();
      const result = await adapter.parseStreamResponse(reader, { onToken: t => emitted.push(t), onReasoning: t => thoughts.push(t) });
      const message = result.finalMessage;
      assert.equal(message.content, 'Working'); assert.equal(emitted.join(''), 'Working');
      if (adapter.providerType !== 'openai-responses') assert.equal(thoughts.join(''), 'private plan');
      assert.equal(message.tool_calls?.length, 1); assertNative(message);
      message.nativeReplay!.model = config.model; message.nativeReplay!.scope = config.replayScope;
      message.nativeReplay!.requestPrefix = staticReplayPrefix(config);
      if (adapter.providerType === 'claude') message.nativeReplay!.inputPrefix = inputReplayPrefix({ ...config });
      history.push(message, { role: 'tool', name: 'probe', tool_call_id: message.tool_calls![0].id, content: `exact result ${round}` });
      if (visual) history.push({ role: 'user', toolFeedbackFor: [message.tool_calls![0].id], content: [{ type: 'text', text: `new viewport ${round}` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${btoa(String(round))}`, detail: 'high' } }] });
      const body = adapter.buildRequestBody(config);
      if (visual && adapter.providerType === 'claude') {
        const last = body.messages.at(-1).content;
        assert.ok(last.every((block: any) => block.type === 'tool_result'), 'automatic feedback stays in the tool-result turn');
        assert.ok(last.at(-1).content.some((block: any) => block.type === 'image'), 'tool result contains actual screenshot evidence');
      }
      assertPrefix(previous, body);
      assert.ok(!JSON.stringify(body).includes('nativeReplay'), 'internal metadata cannot reach the wire');
      assert.ok(!JSON.stringify(body).includes('toolFeedbackFor'), 'feedback routing metadata stays local');
      assert.deepEqual(adapter.buildRequestBody({ ...config, messages: JSON.parse(JSON.stringify(history)) }), body, 'JSON persistence must reproduce native request items');
      const moved = adapter.buildRequestBody({ ...config, replayScope: 'different-endpoint' });
      assert.ok(!JSON.stringify(moved).includes('opaque-'), 'opaque state must not leak to another endpoint');
      previous = body;
    }
    // Consecutive user updates may extend the final turn on APIs requiring
    // alternation, but no existing content block may be rewritten.
    history.push({ role: 'user', content: 'append-only update' });
    assertPrefix(previous, adapter.buildRequestBody(config));
    if (adapter.providerType === 'claude') {
      const compacted: StreamRequestConfig = { ...config, messages: [{ role: 'system', content: 'new compacted memory' }, ...history.slice(1)] };
      const body = adapter.buildRequestBody(compacted);
      assert.ok(!JSON.stringify(body).includes('opaque-') && !JSON.stringify(body).includes('redacted-'), 'compaction must not replay prefix-bound invalid Claude thinking');
      assert.ok(JSON.stringify(body).includes('probe') && JSON.stringify(body).includes('exact result'), 'compaction preserves ordinary tool calls/results');
      const changed = { ...config, messages: history.map((m, index) => index === 1 ? { role: 'user' as const, content: 'recovered missing evidence' } : m) };
      assert.ok(!JSON.stringify(adapter.buildRequestBody(changed)).includes('opaque-'), 'earlier evidence changes also invalidate later bound thinking');
    }
  }
  {
    const adapter = new ClaudeAdapter();
    const partial = sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'plan', signature: 'complete-signature' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'visible partial answer' } },
    );
    let sent = false;
    const reader = new ReadableStream<Uint8Array>({ pull(c) {
      if (!sent) { sent = true; c.enqueue(new TextEncoder().encode(partial)); }
      else c.error(new DOMException('interrupted', 'AbortError'));
    } }).getReader();
    const aborted = await adapter.parseStreamResponse(reader, {});
    assert.equal(aborted.finishReason, 'abort');
    assert.equal(aborted.finalMessage.nativeReplay?.items[0].signature, 'complete-signature');
    assert.equal(aborted.finalMessage.nativeReplay?.items[1].text, 'visible partial answer', 'completed thinking cannot hide a visible partial answer on recovery');
  }
  const message: UnifiedChatMessage = { role: 'assistant', content: 'Working', nativeReplay: { provider: 'openai-responses', reasoningTokens: 7,
    items: [{ type: 'reasoning', encrypted_content: 'x'.repeat(100000) }] } };
  const short = structuredClone(message); short.nativeReplay!.items[0].encrypted_content = 'x';
  assert.equal(estimateMessageTokens(message), estimateMessageTokens(short), 'opaque transport encoding must not inflate context and trigger unnecessary compression');
  const originalFetch = globalThis.fetch;
  try {
    const requests: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      requests.push(JSON.parse(init.body));
      return new Response(cases[0].fixture('real-client'), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const client = new StreamClient();
    const providerConfig = { provider: 'openai' as const, baseUrl: 'https://native-client.example/v1', apiKey: 'not-persisted', model: 'same-model' };
    let completed: UnifiedChatMessage | undefined;
    const first = await client.chat({ model: 'same-model', messages: [{ role: 'user', content: 'task' }] },
      { onComplete: m => { completed = structuredClone(m); } }, { providerConfig, retryCount: 0 });
    assert.ok(completed?.nativeReplay?.scope, 'callback-based consumers also receive scoped native state');
    assert.ok(!JSON.stringify(first.finalMessage).includes('not-persisted'));
    await client.chat({ model: 'same-model', messages: [{ role: 'user', content: 'task' }, first.finalMessage,
      { role: 'tool', tool_call_id: 'real-client', content: 'result' }] }, {}, { providerConfig, retryCount: 0 });
    assert.equal(requests[1].messages[1].reasoning_content, 'private plan');
    assert.deepEqual(requests[1].messages[0], requests[0].messages[0]);
    // Legacy Responses gateways may reject include; that may not discard any
    // input items or turn a valid continuation into an unrecoverable error.
    requests.length = 0;
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body); requests.push(body);
      if (body.include) return new Response(JSON.stringify({ error: { message: 'include reasoning.encrypted_content unsupported' } }), { status: 400 });
      return new Response(cases[4].fixture('response-client'), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    await client.chat({ model: 'same-model', messages: [{ role: 'user', content: 'task' }] }, {}, {
      providerConfig: { ...providerConfig, provider: 'openai-responses', baseUrl: 'https://include-compat.example/v1' }, retryCount: 0,
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].input, requests[1].input);
    assert.equal(requests[1].include, undefined);
  } finally { globalThis.fetch = originalFetch; }
  console.log('[native-cache] Five protocols × text/vision: three tool rounds, native state, reload, appended updates and endpoint isolation passed.');
}

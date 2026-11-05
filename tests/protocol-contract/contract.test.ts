/**
 * 协议契约测试（Protocol Contract Tests）
 *
 * 覆盖四个协议维度 × 5 种协议（openai / ollama / gemini / claude / openai-responses）：
 *   1. 请求构造   —— body 结构、system 位置、工具格式、视觉格式、URL、请求头
 *   2. SSE 回放   —— fixture 样本回放，含 CRLF、SSE 注释行、网关 keepalive 空行、
 *                    跨 chunk 半行、末行无换行、终止事件后的尾随数据
 *   3. 工具分片聚合 —— delta 分片 / input_json_delta / function_call_arguments 增量
 *   4. 错误体解析 —— HTTP 非 2xx 的完整响应体、流内 error 事件必须向上抛
 * 另外：能力声明矩阵、视觉预处理（远程图转 base64 / 不支持视觉即报错）、实际请求地址预览。
 *
 * 运行：node tests/protocol-contract/run.mjs   （或 pnpm run test:contract）
 */

import openaiSSE from './fixtures/openai.sse';
import ollamaSSE from './fixtures/ollama.sse';
import geminiSSE from './fixtures/gemini.sse';
import claudeSSE from './fixtures/claude.sse';
import responsesSSE from './fixtures/responses.sse';

import { OpenAIAdapter } from '../../entrypoints/sidepanel/utils/stream/adapters/openai-adapter';
import { OllamaAdapter } from '../../entrypoints/sidepanel/utils/stream/adapters/ollama-adapter';
import { GeminiAdapter } from '../../entrypoints/sidepanel/utils/stream/adapters/gemini-adapter';
import { ClaudeAdapter } from '../../entrypoints/sidepanel/utils/stream/adapters/claude-adapter';
import { ResponsesAdapter } from '../../entrypoints/sidepanel/utils/stream/adapters/responses-adapter';
import { VisionGuiTool } from '../../tools/vision/gui-tool';
import { BrowserObserveTool } from '../../tools/browser/observe';
import { streamClient } from '../../entrypoints/sidepanel/utils/stream/stream-client';
import { prepareVisionRequest, clearVisionCache } from '../../entrypoints/sidepanel/utils/stream/vision';
import { probeConnection } from '../../entrypoints/sidepanel/utils/stream/probe';
import {
  ApiRequestError,
  PermanentRequestError,
  parseRetryAfterMs,
  sanitizeUrlForLog,
  toApiErrorBlock,
} from '../../entrypoints/sidepanel/utils/stream/errors';
import { resolveActualRequestUrl, fetchModelList } from '../../entrypoints/sidepanel/utils/api/provider-endpoint';
import {
  mergeUsageSafe,
  normalizeOpenAIUsage,
  normalizeClaudeUsage,
  normalizeGeminiUsage,
  normalizeOllamaUsage,
  normalizeResponsesUsage,
  normalizeTranscriptionUsage,
  normalizeUsageFromBody,
} from '../../entrypoints/sidepanel/utils/stream/adapters/usage-normalize';
import { aiUsageMetrics } from '../../entrypoints/sidepanel/utils/metrics/usage-metrics-engine';
import { testNativeCache } from './native-cache.test';
import type {
  AdapterCapabilities,
  ProtocolAdapter,
  ProviderType,
  StreamCallbacks,
  StreamRequestConfig,
  TokenUsage,
  UnifiedChatMessage,
  UnifiedToolCall,
  UnifiedToolDefinition,
} from '../../entrypoints/sidepanel/utils/stream/types';

// ==================== 极简断言 ====================

let passed = 0;
const failures: string[] = [];

function check(cond: boolean, label: string, extra?: unknown) {
  if (cond) {
    passed++;
  } else {
    failures.push(label + (extra !== undefined ? ` => ${JSON.stringify(extra)}` : ''));
  }
}

function eq(actual: unknown, expected: unknown, label: string) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    { actual, expected }
  );
}

/** 稳定序列化（键排序后比较，规避对象键序差异） */
function stableJson(value: unknown): string {
  const walk = (v: any): any => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map(k => [k, walk(v[k])]),
    );
  };
  return JSON.stringify(walk(value));
}

/** usage 字段级比较（键序无关） */
function eqUsage(actual: TokenUsage | undefined, expected: TokenUsage, label: string) {
  check(
    stableJson(actual) === stableJson(expected),
    label,
    { actual, expected },
  );
}

async function expectReject(promise: Promise<unknown>, part: string, label: string) {
  try {
    await promise;
    check(false, `${label}（应抛错但成功返回）`);
  } catch (error) {
    const message = String((error as any)?.message ?? error);
    check(message.includes(part), `${label}（错误信息应含 "${part}"）`, message);
  }
}

// ==================== 回放工具 ====================

interface ReplayOutcome {
  started: boolean;
  completed: boolean;
  tokens: string[];
  reasoning: string[];
  toolCalls: UnifiedToolCall[];
  content: string;
  finishReason: string | null;
  usage?: TokenUsage;
  error?: Error;
}

/** 按固定字节片构造 reader — chunkSize 很小时可验证跨 chunk 半行重组 */
function makeReader(text: string, chunkSize: number): ReadableStreamDefaultReader<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  return stream.getReader();
}

/** 静默适配器内部的 console 输出，让测试结果可读 */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

async function replay(
  adapter: ProtocolAdapter,
  text: string,
  chunkSize: number = text.length
): Promise<ReplayOutcome> {
  const outcome: ReplayOutcome = {
    started: false,
    completed: false,
    tokens: [],
    reasoning: [],
    toolCalls: [],
    content: '',
    finishReason: null,
  };

  const callbacks: StreamCallbacks = {
    onStart: () => {
      outcome.started = true;
    },
    onToken: token => outcome.tokens.push(token),
    onReasoning: token => outcome.reasoning.push(token),
    onToolCall: tc => outcome.toolCalls.push(tc),
    onComplete: msg => {
      outcome.completed = true;
      outcome.content = typeof msg.content === 'string' ? msg.content : '';
      if (msg.tool_calls) outcome.toolCalls = [...outcome.toolCalls, ...msg.tool_calls];
    },
    onError: error => {
      outcome.error = error;
    },
  };

  const result = await quiet(() =>
    adapter.parseStreamResponse(makeReader(text, chunkSize), callbacks)
  );
  outcome.content = typeof result.finalMessage.content === 'string' ? result.finalMessage.content : '';
  outcome.finishReason = result.finishReason;
  outcome.usage = result.usage;
  // tool_calls 已在 finalize 中触发 onToolCall，这里兜底用 result 去重
  if (result.finalMessage.tool_calls?.length && outcome.toolCalls.length === 0) {
    outcome.toolCalls = [...result.finalMessage.tool_calls];
  }
  return outcome;
}

/** 工具调用去重（onToolCall 与 result 都可能带） */
function uniqueToolCalls(list: UnifiedToolCall[]): UnifiedToolCall[] {
  const seen = new Set<string>();
  return list.filter(tc => {
    const key = `${tc.id}|${tc.function.name}|${tc.function.arguments}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ==================== 公共样本 ====================

const openai = new OpenAIAdapter();
const ollama = new OllamaAdapter();
const gemini = new GeminiAdapter();
const claude = new ClaudeAdapter();
const responses = new ResponsesAdapter();

const systemAndUser: UnifiedChatMessage[] = [
  { role: 'system', content: 'You are helpful' },
  { role: 'user', content: 'Hi' },
];

const weatherTool: UnifiedToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  },
];

const weatherCall: UnifiedToolCall = {
  id: 'call_xyz',
  type: 'function',
  function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
};

async function main() {
  // ============================================================
  // 一、SSE 样本回放（文本 + 推理 + 工具分片 + 终止事件后尾随数据）
  // ============================================================

  // ---------- OpenAI ----------
  const o1 = await replay(openai, openaiSSE);
  check(o1.started, 'openai: onStart 触发');
  check(o1.completed, 'openai: onComplete 触发');
  eq(o1.content, 'Hello, world!', 'openai: 文本拼接');
  eq(o1.reasoning.join(''), 'Let me think about it', 'openai: reasoning_content 独立通道');
  eq(o1.finishReason, 'tool_calls', 'openai: finishReason=tool_calls');
  eq(
    uniqueToolCalls(o1.toolCalls).map(tc => ({ id: tc.id, name: tc.function.name, args: tc.function.arguments })),
    [{ id: 'call_abc', name: 'get_weather', args: '{"city":"Paris"}' }],
    'openai: 工具分片聚合（3 片 delta）'
  );
  check(!o1.error, 'openai: 终止事件后尾随 error 行被跳过（提前结束读取）', o1.error?.message);
  // usage（末 chunk 带 usage 且 choices 为空 → 必须解析成功而非被空 choices 早退丢弃）
  eqUsage(
    o1.usage,
    { inputTokens: 120, outputTokens: 34, totalTokens: 154, cachedInputTokens: 64, reasoningTokens: 12 },
    'openai: 流式 usage 归一化（含 cached_tokens / reasoning_tokens）'
  );

  // 跨 chunk（每 7 字节一片）→ 半行必须重组
  const o2 = await replay(openai, openaiSSE, 7);
  eq(o2.content, 'Hello, world!', 'openai: 跨 chunk 半行重组后文本一致');
  eq(o2.finishReason, 'tool_calls', 'openai: 跨 chunk 后 finishReason 一致');
  eq(uniqueToolCalls(o2.toolCalls).length, 1, 'openai: 跨 chunk 工具调用仍聚合成功');

  // CRLF 行尾
  const o3 = await replay(openai, openaiSSE.replace(/\n/g, '\r\n'));
  eq(o3.content, 'Hello, world!', 'openai: CRLF 行尾处理');
  eq(uniqueToolCalls(o3.toolCalls).length, 1, 'openai: CRLF 下工具调用正常');

  // 末行无换行（必须冲刷 buffer）
  const noTrailingNewline =
    'data: {"choices":[{"index":0,"delta":{"content":"tail"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}]}';
  const o4 = await replay(openai, noTrailingNewline);
  eq(o4.content, 'tail!', 'openai: 末行无换行符不丢事件');

  // ---------- Ollama ----------
  const ol1 = await replay(ollama, ollamaSSE);
  eq(ol1.content, 'Hello, world!', 'ollama: 文本拼接');
  eq(ol1.finishReason, 'tool_calls', 'ollama: finishReason 归一化为 tool_calls');
  eq(
    uniqueToolCalls(ol1.toolCalls).map(tc => ({ name: tc.function.name, args: tc.function.arguments })),
    [{ name: 'get_weather', args: '{"city":"Paris"}' }],
    'ollama: object 形式工具参数 JSON 序列化'
  );
  const ol2 = await replay(ollama, ollamaSSE, 11);
  eq(ol2.content, 'Hello, world!', 'ollama: 跨 chunk 半行重组');
  eqUsage(
    ol1.usage,
    { inputTokens: 26, outputTokens: 11, totalTokens: 37, cachedInputTokens: 16 },
    'ollama: done 末行计数归一化（prompt_eval / eval / cached）'
  );

  // ---------- Gemini ----------
  const g1 = await replay(gemini, geminiSSE);
  eq(g1.content, 'Hello from Gemini', 'gemini: 文本拼接');
  eq(g1.finishReason, 'stop', 'gemini: finishReason=stop');
  eqUsage(
    g1.usage,
    { inputTokens: 20, outputTokens: 12, totalTokens: 32, cachedInputTokens: 12, reasoningTokens: 4 },
    'gemini: usageMetadata 归一化（输出含 thoughts，输入含缓存命中）'
  );

  const geminiToolSSE =
    'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}]},"finishReason":"STOP"}]}';
  const g2 = await replay(gemini, geminiToolSSE);
  eq(g2.finishReason, 'tool_calls', 'gemini: finishReason 归一化为 tool_calls');
  eq(
    uniqueToolCalls(g2.toolCalls).map(tc => ({ name: tc.function.name, args: tc.function.arguments })),
    [{ name: 'get_weather', args: '{"city":"Paris"}' }],
    'gemini: functionCall → 统一工具格式'
  );

  // ---------- Claude ----------
  const c1 = await replay(claude, claudeSSE);
  eq(c1.content, 'Hello from Claude', 'claude: 文本拼接');
  eq(c1.finishReason, 'tool_calls', 'claude: finishReason=tool_calls');
  eq(
    uniqueToolCalls(c1.toolCalls).map(tc => ({ id: tc.id, name: tc.function.name, args: tc.function.arguments })),
    [{ id: 'toolu_01', name: 'get_weather', args: '{"city":"Paris"}' }],
    'claude: input_json_delta 分片聚合'
  );
  check(!c1.error, 'claude: message_stop 后尾随 error 事件被跳过', c1.error?.message);
  eqUsage(
    c1.usage,
    { inputTokens: 153, outputTokens: 42, totalTokens: 195, cachedInputTokens: 128 },
    'claude: message_start(输入+缓存读) + message_delta(输出累计) last-wins 合并，输入不重复计数'
  );
  const c2 = await replay(claude, claudeSSE, 13);
  eq(c2.content, 'Hello from Claude', 'claude: 跨 chunk 半行重组');
  eq(uniqueToolCalls(c2.toolCalls)[0]?.function.arguments, '{"city":"Paris"}', 'claude: 跨 chunk 工具参数完整');

  // ---------- OpenAI Responses ----------
  const r1 = await replay(responses, responsesSSE);
  eq(r1.content, 'Hello, world!', 'responses: 文本拼接');
  eq(r1.reasoning.join(''), 'Let me check', 'responses: reasoning_summary 独立通道');
  eq(r1.finishReason, 'tool_calls', 'responses: finishReason=tool_calls');
  eq(
    uniqueToolCalls(r1.toolCalls).map(tc => ({ id: tc.id, name: tc.function.name, args: tc.function.arguments })),
    [{ id: 'call_xyz', name: 'get_weather', args: '{"city":"Paris"}' }],
    'responses: 工具分片聚合（delta → done 终值覆盖）'
  );
  check(!r1.error, 'responses: response.completed 后尾随 error 事件被跳过', r1.error?.message);
  eqUsage(
    r1.usage,
    { inputTokens: 55, outputTokens: 18, totalTokens: 73, cachedInputTokens: 30, reasoningTokens: 6 },
    'responses: response.completed 的 usage 归一化'
  );
  const r2 = await replay(responses, responsesSSE, 9);
  eq(r2.content, 'Hello, world!', 'responses: 跨 chunk 半行重组');
  eq(uniqueToolCalls(r2.toolCalls)[0]?.id, 'call_xyz', 'responses: 跨 chunk 后 call_id 保留');

  // ============================================================
  // 二、流内错误事件必须向上抛（否则静默退化成空回复）
  // ============================================================
  await expectReject(
    replay(openai, 'data: {"error":{"message":"rate limited"}}\n'),
    'rate limited',
    'openai: 流内 error 对象抛出'
  );
  await expectReject(
    replay(gemini, 'data: {"error":{"code":429,"message":"Quota exceeded"}}\n'),
    'Quota exceeded',
    'gemini: 流内 error 抛出（原实现会被 catch 吞掉）'
  );
  await expectReject(
    replay(
      claude,
      'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}\n'
    ),
    'Too many requests',
    'claude: 流内 error 事件抛出'
  );
  await expectReject(
    replay(responses, 'data: {"type":"error","code":"rate_limit","message":"Slow down"}\n'),
    'Slow down',
    'responses: 流内 error 事件抛出'
  );
  await expectReject(
    replay(
      responses,
      'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"model overloaded"}}}\n'
    ),
    'model overloaded',
    'responses: response.failed 抛出'
  );

  // 流内错误的 message 必须附带**原始事件 JSON**（配额 / 限流 / 密钥失效都能看到服务端原文）
  const inBandCases: Array<[string, any, string, string]> = [
    ['openai', openai, 'data: {"error":{"message":"rate limited","type":"rate_limit_error"}}\n', 'rate_limit_error'],
    ['gemini', gemini, 'data: {"error":{"code":429,"message":"Quota exceeded"}}\n', '429'],
    [
      'claude',
      claude,
      'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}\n',
      'rate_limit_error',
    ],
    ['responses', responses, 'data: {"type":"error","code":"rate_limit","message":"Slow down"}\n', 'rate_limit'],
  ];
  for (const [label, adapter, sse, rawField] of inBandCases) {
    try {
      await replay(adapter, sse);
      check(false, `${label}: 流内错误应抛出`);
    } catch (e) {
      const msg = (e as Error).message;
      check(msg.includes('```json'), `${label}: 流内错误 message 含原始 JSON 代码块`, msg);
      check(msg.includes(rawField), `${label}: 流内错误 message 含原始事件字段`, msg);
    }
  }

  // ============================================================
  // 三、请求构造
  // ============================================================

  // ---------- OpenAI ----------
  {
    const gui = new VisionGuiTool().openaiSchema;
    const observe = new BrowserObserveTool().openaiSchema;
    for (const [name, adapter] of [['openai',openai],['ollama',ollama],['gemini',gemini],['claude',claude],['responses',responses]] as const) {
      const body = adapter.buildRequestBody({model:'test',messages:systemAndUser,tools:[gui]});
      const schema = name === 'gemini' ? body.tools[0].functionDeclarations[0].parameters
        : name === 'claude' ? body.tools[0].input_schema
        : name === 'responses' ? body.tools[0].parameters : body.tools[0].function.parameters;
      eq(schema, gui.function.parameters, `${name}: preserves complete vision_gui action-discriminated schema`);
      check(JSON.stringify(body.tools).includes('<vision_gui>'), `${name}: preserves XML action descriptions`);
      const observeBody = adapter.buildRequestBody({model:'test',messages:systemAndUser,tools:[observe]});
      const observeSchema = name === 'gemini' ? observeBody.tools[0].functionDeclarations[0].parameters
        : name === 'claude' ? observeBody.tools[0].input_schema
        : name === 'responses' ? observeBody.tools[0].parameters : observeBody.tools[0].function.parameters;
      eq(observeSchema, observe.function.parameters, `${name}: preserves browser_observe enumeration/element branches`);
      check(JSON.stringify(observeBody.tools).includes('不传 elementId/frameId'), `${name}: preserves observe parameter guidance`);
    }
  }
  {
    const body = openai.buildRequestBody({
      model: 'gpt-4o',
      messages: systemAndUser,
      tools: weatherTool,
      stream: true,
      temperature: 0.4,
      max_tokens: 256,
    });
    eq(body.model, 'gpt-4o', 'openai: model');
    eq(body.messages, systemAndUser, 'openai: 消息原样透传（本就是 OpenAI 格式）');
    eq(body.tools[0].function.name, 'get_weather', 'openai: 工具保持 function 包裹格式');
    eq(body.stream, true, 'openai: stream=true');
    eq(body.stream_options, { include_usage: true }, 'openai: stream_options.include_usage（流式 usage 上报）');
    eq(body.temperature, 0.4, 'openai: temperature');
    eq(body.max_tokens, 256, 'openai: max_tokens');
    eq(
      openai.getRequestUrl('https://api.openai.com/v1'),
      'https://api.openai.com/v1/chat/completions',
      'openai: URL'
    );
    eq(
      openai.getRequestHeaders('sk-test'),
      { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
      'openai: Bearer 头'
    );
    eq(openai.getRequestHeaders(''), { 'Content-Type': 'application/json' }, 'openai: 无 key 不带认证头');
  }

  // ---------- Ollama ----------
  {
    const vision: UnifiedChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
    ];
    const body = ollama.buildRequestBody({ model: 'llama3', messages: vision, max_tokens: 100 });
    eq(body.messages[0].content, '看图', 'ollama: 多模态文本提取');
    eq(body.messages[0].images, ['AAA'], 'ollama: data URL → images 纯 base64');
    eq(body.options.num_predict, 100, 'ollama: max_tokens → num_predict');
    eq(
      ollama.getRequestUrl('http://localhost:11434'),
      'http://localhost:11434/api/chat',
      'ollama: URL'
    );
    eq(
      ollama.getRequestUrl('http://localhost:11434/v1/chat/completions'),
      'http://localhost:11434/api/chat',
      'ollama: 旧 OpenAI 风格 URL 自动还原'
    );
    // 远程 URL 兜底（预处理阶段会先转 base64，这里断言兜底文案）
    const remote = ollama.buildRequestBody({
      model: 'llama3',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://a/b.png' } }] }],
    });
    eq(remote.messages[0].content, '[Image URL: https://a/b.png]', 'ollama: 远程图兜底为文本占位');
    eq(remote.messages[0].images, undefined, 'ollama: 远程图未转 base64 时不会塞空 images');
  }

  // ---------- Gemini ----------
  {
    const body = gemini.buildRequestBody({
      model: 'gemini-2.0-flash',
      messages: systemAndUser,
      tools: weatherTool,
      temperature: 0.3,
    });
    eq(body.systemInstruction.parts[0].text, 'You are helpful', 'gemini: system → systemInstruction');
    eq(body.contents[0], { role: 'user', parts: [{ text: 'Hi' }] }, 'gemini: role 映射 + parts 结构');
    eq(body.tools[0].functionDeclarations[0].name, 'get_weather', 'gemini: 工具 → functionDeclarations');
    eq(body.generationConfig.temperature, 0.3, 'gemini: temperature');
    eq(
      gemini.getRequestUrl('https://generativelanguage.googleapis.com', 'gemini-2.0-flash'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse',
      'gemini: URL'
    );
    eq(
      gemini.getAuthenticatedUrl('https://generativelanguage.googleapis.com', 'GKEY', 'm'),
      'https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse&key=GKEY',
      'gemini: key 嵌入 URL'
    );
    const visionBody = gemini.buildRequestBody({
      model: 'g',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } }],
        },
      ],
    });
    eq(
      visionBody.contents[0].parts[0].inlineData,
      { mimeType: 'image/jpeg', data: 'BBB' },
      'gemini: data URL → inlineData'
    );

    // ── 跨协议回放关键约束 ──
    // 多 system 合并 + 并行工具结果同轮折叠（Gemini 对连续同角色 content 返回 400）
    const geminiReplay = gemini.buildRequestBody({
      model: 'g',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'system', content: '<conversation-memory>压缩摘要</conversation-memory>' },
        { role: 'user', content: '天气？' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            weatherCall,
            { id: 'call_t1', type: 'function', function: { name: 'get_time', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_xyz', content: '{"temp":20}' },
        { role: 'tool', tool_call_id: 'call_t1', name: 'get_time', content: '"5pm"' },
      ],
    });
    eq(
      geminiReplay.systemInstruction.parts[0].text,
      'You are helpful\n\n<conversation-memory>压缩摘要</conversation-memory>',
      'gemini: 多 system 消息合并（压缩记忆不丢失）'
    );
    eq(geminiReplay.contents.length, 3, 'gemini: 并行工具结果折叠为单条 user content');
    eq(
      geminiReplay.contents.map((c: any) => c.role),
      ['user', 'model', 'user'],
      'gemini: contents 严格 user/model 交替'
    );
    eq(
      geminiReplay.contents[2].parts.map((p: any) => p.functionResponse.name),
      ['get_weather', 'get_time'],
      'gemini: functionResponse 按工具名配对（name 缺失时回查 assistant.tool_calls）'
    );
    eq(
      geminiReplay.contents[2].parts[0].functionResponse.response,
      { temp: 20 },
      'gemini: 工具结果 JSON 对象原样回放'
    );
    eq(
      geminiReplay.contents[2].parts[1].functionResponse.response,
      { result: '5pm' },
      'gemini: 非对象 JSON 结果包装为 { result }'
    );
  }

  // ---------- Claude ----------
  {
    const body = claude.buildRequestBody({
      model: 'claude-3-5-sonnet-20241022',
      messages: systemAndUser,
      tools: weatherTool,
      temperature: 0.2,
      max_tokens: 512,
    });
    eq(body.system[0].text, 'You are helpful', 'claude: system 顶级字段');
    eq(body.system[0].cache_control, { type: 'ephemeral' }, 'claude: stable system cache checkpoint');
    eq(body.cache_control, { type: 'ephemeral' }, 'claude: automatic moving cache checkpoint');
    eq(body.messages[0], { role: 'user', content: [{ type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }] }, 'claude: 文本块与移动缓存断点');
    eq(body.tools[0].name, 'get_weather', 'claude: 工具 name 顶层');
    eq(body.tools[0].input_schema.type, 'object', 'claude: 工具 parameters → input_schema');
    eq(body.max_tokens, 512, 'claude: max_tokens');
    eq(claude.getRequestUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages', 'claude: URL');
    eq(
      claude.getRequestHeaders('ANTH'),
      {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': 'ANTH',
      },
      'claude: x-api-key + anthropic-version'
    );

    // 多轮：assistant 工具调用回放 + tool 结果
    const roundTrip = claude.buildRequestBody({
      model: 'c',
      messages: [
        { role: 'assistant', content: '', tool_calls: [weatherCall] },
        { role: 'tool', tool_call_id: 'call_xyz', content: 'sunny' },
      ],
    });
    const assistantBlock = roundTrip.messages[0].content;
    eq(assistantBlock[0], { type: 'tool_use', id: 'call_xyz', name: 'get_weather', input: { city: 'Paris' } }, 'claude: tool_calls → tool_use');
    const toolBlock = roundTrip.messages[1].content;
    eq(toolBlock[0].type, 'tool_result', 'claude: tool 消息 → tool_result');
    eq(toolBlock[0].tool_use_id, 'call_xyz', 'claude: tool_use_id 配对');
    eq(toolBlock[0].content, 'sunny', 'claude: tool 结果内容');

    // ── 跨协议回放关键约束 ──
    // 1. 多个 system 消息（主提示 + 压缩摘要记忆）必须全部合并进顶级 system
    const multiSystem = claude.buildRequestBody({
      model: 'c',
      messages: [
        ...systemAndUser,
        { role: 'system', content: '<conversation-memory>压缩摘要</conversation-memory>' },
      ],
    });
    eq(
      multiSystem.system[0].text,
      'You are helpful\n\n<conversation-memory>压缩摘要</conversation-memory>',
      'claude: 多 system 消息合并（压缩记忆不丢失）'
    );

    // 2. 并行工具调用的全部结果合入同一 user 轮（Anthropic 官方要求）
    const parallel = claude.buildRequestBody({
      model: 'c',
      messages: [
        { role: 'user', content: '天气？' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            weatherCall,
            { id: 'call_abc', type: 'function', function: { name: 'get_time', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_xyz', name: 'get_weather', content: 'sunny' },
        { role: 'tool', tool_call_id: 'call_abc', name: 'get_time', content: '5pm' },
      ],
    });
    eq(parallel.messages.length, 3, 'claude: 并行工具结果折叠为单条 user 轮');
    eq(parallel.messages[2].content.length, 2, 'claude: 同轮包含两个 tool_result block');
    eq(parallel.messages[2].content[0].tool_use_id, 'call_xyz', 'claude: tool_result 顺序与配对保持');

    // 3. 脏参数串永不炸请求（降级为 _malformedArguments，整轮可继续发送）
    const dirty = claude.buildRequestBody({
      model: 'c',
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_bad', type: 'function', function: { name: 't', arguments: '{"a":1} 不是JSON' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_bad', name: 't', content: 'ok' },
      ],
    });
    eq(
      dirty.messages[1].content[0].input,
      { _malformedArguments: '{"a":1} 不是JSON' },
      'claude: 非法参数串降级为 _malformedArguments（不抛错）'
    );

    // 4. 不满足 ^[a-zA-Z0-9_-]+$ 的历史 id 重写，且 tool_use/tool_result 配对双方一致
    const badId = claude.buildRequestBody({
      model: 'c',
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call/坏#id', type: 'function', function: { name: 't', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call/坏#id', name: 't', content: 'ok' },
      ],
    });
    const rewrittenUse = badId.messages[1].content[0];
    const rewrittenResult = badId.messages[2].content[0];
    check(
      /^[a-zA-Z0-9_-]+$/.test(rewrittenUse.id) && rewrittenResult.tool_use_id === rewrittenUse.id,
      'claude: 非法 id 重写后配对一致且满足协议字符集',
      { use: rewrittenUse.id, result: rewrittenResult.tool_use_id }
    );

    // 视觉：data URL → base64 source；远程 URL → url source（本次修复）
    const visionBody = claude.buildRequestBody({
      model: 'c',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,CCC' } },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ],
    });
    eq(
      visionBody.messages[0].content[0],
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCC' } },
      'claude: data URL → base64 source'
    );
    eq(
      visionBody.messages[0].content[1],
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' }, cache_control: { type: 'ephemeral' } },
      'claude: 远程 URL → url source（不再静默丢图）'
    );
  }

  // ---------- OpenAI Responses ----------
  {
    const body = responses.buildRequestBody({
      model: 'gpt-5',
      messages: [
        ...systemAndUser,
        { role: 'assistant', content: '', tool_calls: [weatherCall] },
        { role: 'tool', tool_call_id: 'call_xyz', content: 'sunny' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'high' } },
          ],
        },
      ],
      tools: weatherTool,
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      temperature: 0.5,
      max_tokens: 123,
    });

    eq(body.model, 'gpt-5', 'responses: model');
    eq(body.stream, true, 'responses: stream=true');
    eq(body.store, false, 'responses: store=false（无状态，不在服务端留存）');
    eq(body.max_output_tokens, 123, 'responses: max_tokens → max_output_tokens');
    eq(body.temperature, 0.5, 'responses: temperature');
    eq(body.input[0], { role: 'system', content: 'You are helpful' }, 'responses: system 进 input');
    eq(body.input[1], { role: 'user', content: 'Hi' }, 'responses: 纯文本消息');
    eq(
      body.input.find((item: any) => item.type === 'function_call'),
      { type: 'function_call', call_id: 'call_xyz', name: 'get_weather', arguments: '{"city":"Paris"}' },
      'responses: 助手 tool_calls → function_call 回放'
    );
    eq(
      body.input.find((item: any) => item.type === 'function_call_output'),
      { type: 'function_call_output', call_id: 'call_xyz', output: 'sunny' },
      'responses: tool 结果 → function_call_output（call_id 配对）'
    );
    const imageMsg = body.input.find((item: any) => Array.isArray(item.content));
    eq(imageMsg.content[0], { type: 'input_text', text: '看图' }, 'responses: 文本 part');
    eq(
      imageMsg.content[1],
      { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'high' },
      'responses: 图片 part（原生支持远程 URL）'
    );
    eq(body.tools[0], {
      type: 'function',
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: weatherTool[0].function.parameters,
      strict: false,
    }, 'responses: 工具 name 顶层 + strict');
    eq(body.tool_choice, { type: 'function', name: 'get_weather' }, 'responses: tool_choice 扁平化');
    eq(
      responses.getRequestUrl('https://api.openai.com/v1'),
      'https://api.openai.com/v1/responses',
      'responses: URL'
    );
    eq(
      responses.getRequestUrl('https://api.openai.com/v1/responses'),
      'https://api.openai.com/v1/responses',
      'responses: 已含端点不重复拼接'
    );
    eq(
      responses.getRequestHeaders('sk-x'),
      { 'Content-Type': 'application/json', Authorization: 'Bearer sk-x' },
      'responses: Bearer 头'
    );
    eq(
      responses.buildRequestBody({ model: 'm', messages: systemAndUser, tool_choice: 'auto' }).tool_choice,
      'auto',
      'responses: tool_choice=auto 透传'
    );

    // 跨协议回放关键约束：连续同角色纯文本消息合并（主系统提示 + 压缩摘要记忆）
    const merged = responses.buildRequestBody({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'system', content: '<conversation-memory>压缩摘要</conversation-memory>' },
        { role: 'user', content: 'Hi' },
      ],
    });
    eq(
      merged.input[0],
      { role: 'system', content: 'You are helpful' },
      'responses: system 消息保持原边界'
    );
  }

  // ============================================================
  // 四、能力声明矩阵 + 实际请求地址
  // ============================================================

  const expectedCapabilities: Record<ProviderType, AdapterCapabilities> = {
    openai: { vision: true, remoteImageUrl: 'native', tools: true, reasoning: true },
    ollama: { vision: true, remoteImageUrl: 'base64', tools: true, reasoning: true },
    gemini: { vision: true, remoteImageUrl: 'base64', tools: true, reasoning: true },
    claude: { vision: true, remoteImageUrl: 'native', tools: true, reasoning: true },
    'openai-responses': { vision: true, remoteImageUrl: 'native', tools: true, reasoning: true },
  };

  for (const [provider, expected] of Object.entries(expectedCapabilities)) {
    eq(
      streamClient.getCapabilities(provider as ProviderType),
      expected,
      `capabilities: ${provider}`
    );
  }
  eq(streamClient.getAvailableProviders().sort(), ['claude', 'gemini', 'ollama', 'openai', 'openai-responses'].sort(), '5 个协议全部注册');

  eq(
    resolveActualRequestUrl({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }),
    'https://api.openai.com/v1/chat/completions',
    '实际请求地址: openai'
  );
  eq(
    resolveActualRequestUrl({ provider: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }),
    'https://api.openai.com/v1/responses',
    '实际请求地址: openai-responses'
  );
  eq(
    resolveActualRequestUrl({ provider: 'claude', baseUrl: 'https://api.anthropic.com' }),
    'https://api.anthropic.com/v1/messages',
    '实际请求地址: claude'
  );
  eq(
    resolveActualRequestUrl({ provider: 'ollama', baseUrl: 'http://localhost:11434' }),
    'http://localhost:11434/api/chat',
    '实际请求地址: ollama'
  );
  eq(
    resolveActualRequestUrl({
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'GKEY',
      model: 'gemini-2.0-flash',
    }),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=GKEY',
    '实际请求地址: gemini（含模型与 key）'
  );

  // ============================================================
  // 五、视觉预处理（能力驱动）
  // ============================================================
  {
    clearVisionCache();
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const remoteImageConfig: StreamRequestConfig = {
        model: 'g',
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://img.example/a.png' } }] },
        ],
      };
      const dataUrlConfig: StreamRequestConfig = {
        model: 'g',
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,ZZZ' } }] },
        ],
      };

      // base64-only 协议（gemini）：远程图 → data URL
      const preparedGemini = await prepareVisionRequest('gemini', gemini.capabilities, remoteImageConfig);
      const geminiUrl = (preparedGemini.messages[0].content as any)[0].image_url.url;
      eq(geminiUrl, 'data:image/png;base64,AQID', '视觉: gemini 远程图转 base64');
      eq(fetchCount, 1, '视觉: 下载一次');

      // 缓存命中：重复请求不再下载（重试不会重复拉图）
      await prepareVisionRequest('gemini', gemini.capabilities, remoteImageConfig);
      eq(fetchCount, 1, '视觉: 缓存命中不重复下载');

      // native 协议（claude/openai/responses）：原样透传
      await prepareVisionRequest('claude', claude.capabilities, remoteImageConfig);
      await prepareVisionRequest('openai', openai.capabilities, remoteImageConfig);
      await prepareVisionRequest('openai-responses', responses.capabilities, remoteImageConfig);
      eq(fetchCount, 1, '视觉: native 协议不下载远程图');

      // data URL 对 base64-only 协议也无需下载
      await prepareVisionRequest('gemini', gemini.capabilities, dataUrlConfig);
      eq(fetchCount, 1, '视觉: data URL 不触发下载');

      // 无图片请求零开销
      const textConfig: StreamRequestConfig = { model: 'm', messages: systemAndUser };
      eq(await prepareVisionRequest('gemini', gemini.capabilities, textConfig), textConfig, '视觉: 纯文本请求原样返回');
      eq(fetchCount, 1, '视觉: 纯文本请求不下载');

      // 不支持视觉的协议 → 明确报错（不静默丢图）
      await expectReject(
        prepareVisionRequest('openai', { vision: false, remoteImageUrl: 'base64', tools: true, reasoning: false }, remoteImageConfig),
        '不支持图片输入',
        '视觉: 不支持视觉的协议直接报错'
      );
    } finally {
      globalThis.fetch = originalFetch;
      clearVisionCache();
    }
  }

  // ============================================================
  // 六、HTTP 错误体解析（完整响应体必须透传到错误信息）
  // ============================================================
  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers(),
      text: async () =>
        JSON.stringify({ error: { message: 'Missing bearer authentication in header', type: 'invalid_request_error' } }),
    })) as unknown as typeof fetch;

    try {
      await expectReject(
        openai.fetchStream('https://api.openai.com/v1/chat/completions', {}, { model: 'gpt-4o' }),
        '401',
        'HTTP 错误: 状态码透传'
      );
      await expectReject(
        openai.fetchStream('https://api.openai.com/v1/chat/completions', {}, { model: 'gpt-4o' }),
        'Missing bearer authentication in header',
        'HTTP 错误: 完整错误体透传'
      );
      await expectReject(
        responses.fetchStream('https://api.openai.com/v1/responses', {}, { model: 'gpt-5' }),
        'invalid_request_error',
        'HTTP 错误: responses 同样透传'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // ============================================================
  // 七、端到端：streamClient → 适配器（URL / 头 / 请求体 / 流解析一条链）
  // ============================================================
  {
    const originalFetch = globalThis.fetch;

    async function e2e(provider: ProviderType, baseUrl: string, apiKey: string | undefined, sse: string) {
      const captured: { url?: string; headers?: any; body?: any } = {};
      globalThis.fetch = (async (url: string, init: any) => {
        captured.url = String(url);
        captured.headers = init?.headers || {};
        captured.body = JSON.parse(init?.body);
        const bytes = new TextEncoder().encode(sse);
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'text/event-stream' }),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        } as unknown as Response;
      }) as typeof fetch;

      try {
        const result = await quiet(() =>
          streamClient.chat(
            { model: 'm-1', messages: systemAndUser, tools: weatherTool, stream: true },
            {},
            {
              providerConfig: { provider, baseUrl, apiKey, model: 'm-1' },
              retryCount: 0,
            }
          )
        );
        return { captured, result };
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    const e2eOpenAI = await e2e('openai', 'https://api.openai.com/v1', 'sk-e2e', openaiSSE);
    eq(e2eOpenAI.captured.url, 'https://api.openai.com/v1/chat/completions', 'e2e openai: URL');
    eq(e2eOpenAI.captured.headers['Authorization'], 'Bearer sk-e2e', 'e2e openai: Bearer 头');
    eq(e2eOpenAI.result.finalMessage.content, 'Hello, world!', 'e2e openai: 流式正文');
    eq(e2eOpenAI.result.finishReason, 'tool_calls', 'e2e openai: finishReason');
    eq(
      (e2eOpenAI.result.finalMessage.tool_calls || []).map(tc => tc.function.name),
      ['get_weather'],
      'e2e openai: 工具调用'
    );

    const e2eResponses = await e2e('openai-responses', 'https://api.openai.com/v1', 'sk-e2e', responsesSSE);
    eq(e2eResponses.captured.url, 'https://api.openai.com/v1/responses', 'e2e responses: URL');
    eq(e2eResponses.captured.headers['Authorization'], 'Bearer sk-e2e', 'e2e responses: Bearer 头');
    eq(e2eResponses.captured.body.stream, true, 'e2e responses: stream=true');
    eq(e2eResponses.captured.body.store, false, 'e2e responses: store=false');
    eq(e2eResponses.captured.body.tools[0].name, 'get_weather', 'e2e responses: 工具扁平化');
    eq(
      e2eResponses.captured.body.input[0],
      { role: 'system', content: 'You are helpful' },
      'e2e responses: input 序列化'
    );
    eq(e2eResponses.result.finalMessage.content, 'Hello, world!', 'e2e responses: 流式正文');
    eq(e2eResponses.result.finishReason, 'tool_calls', 'e2e responses: finishReason');
    eq(
      (e2eResponses.result.finalMessage.tool_calls || [])[0],
      { id: 'call_xyz', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      'e2e responses: 工具调用'
    );
  }

  // ============================================================
  // 八、模型列表端点（新协议复用 /models）
  // ============================================================
  {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 'gpt-4o' }] }),
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const models = await fetchModelList({
        provider: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-x',
      });
      eq(models, ['gpt-5', 'gpt-4o'], '模型列表: openai-responses 走 /models');
      eq(urls[0], 'https://api.openai.com/v1/models', '模型列表: URL');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // Ollama 版本前缀还原
  eq(
    ollama.getRequestUrl('http://localhost:11434/v1'),
    'http://localhost:11434/api/chat',
    'ollama: /v1 前缀剥除（不拼出 /v1/api/chat）'
  );

  // ============================================================
  // 九、结构化错误：403 / 429 / 密钥失效 → 必须携带完整原始 JSON
  // ============================================================
  {
    const originalFetch = globalThis.fetch;
    const mockHttpError = (status: number, statusText: string, body: unknown) => {
      globalThis.fetch = (async () => ({
        ok: false,
        status,
        statusText,
        headers: new Headers(),
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      })) as unknown as typeof fetch;
    };

    const openaiUrl = 'https://api.openai.com/v1/chat/completions';

    try {
      // --- 403（API 失效 / 无权限）---
      mockHttpError(403, 'Forbidden', {
        error: { message: 'API key does not exist', type: 'invalid_request_error', code: 'invalid_api_key' },
      });
      try {
        await openai.fetchStream(openaiUrl, {}, { model: 'm' });
        check(false, '403 应抛 ApiRequestError');
      } catch (error) {
        const err = error as ApiRequestError;
        check(err instanceof ApiRequestError, '403 → 抛出 ApiRequestError 实例');
        eq(err.status, 403, '403: status 保留');
        eq(err.isAuthError, true, '403: isAuthError');
        eq(err.isRetryable, false, '403: 永久失败不重试');
        eq(err.kind, 'http', '403: kind=http');
        check(err.rawBody.includes('API key does not exist'), '403: rawBody 保留完整原始响应');
        check(!!err.json, '403: json 解析成功');
        check(err.summary.includes('API key does not exist'), '403: 摘要取自服务端原文');
        check(err.message.includes('403'), '403: message 含状态码');
        check(err.message.includes('```json'), '403: message 含原始 JSON 代码块');
        check(err.message.includes('API key does not exist'), '403: message 含服务端错误原文');
      }

      // --- 429 限流（可重试）---
      mockHttpError(429, 'Too Many Requests', { error: { message: 'Rate limit reached for gpt-4o' } });
      try {
        await openai.fetchStream(openaiUrl, {}, { model: 'm' });
        check(false, '429 应抛 ApiRequestError');
      } catch (error) {
        const err = error as ApiRequestError;
        eq(err.isRateLimited, true, '429: isRateLimited');
        eq(err.isRetryable, true, '429: 可重试');
        check(err.message.includes('Rate limit reached'), '429: message 含限流原文');
      }

      // --- 401 无响应体 → 摘要按状态码兜底（不为空）---
      mockHttpError(401, 'Unauthorized', '');
      try {
        await openai.fetchStream(openaiUrl, {}, { model: 'm' });
        check(false, '401 应抛 ApiRequestError');
      } catch (error) {
        const err = error as ApiRequestError;
        check(err.summary.length > 0, '401 空响应体时摘要不为空');
        eq(err.isRetryable, false, '401: 不重试');
      }

      // --- 非 JSON 的网关 HTML 页 → 摘要降级为去标签文本 ---
      mockHttpError(502, 'Bad Gateway', '<html><body><h1>502 Bad Gateway</h1></body></html>');
      try {
        await openai.fetchStream(openaiUrl, {}, { model: 'm' });
        check(false, '502 应抛 ApiRequestError');
      } catch (error) {
        const err = error as ApiRequestError;
        check(!err.json, '502: json 为 undefined（非 JSON）');
        check(err.summary.includes('502 Bad Gateway'), '502: 摘要取自 HTML 文本', err.summary);
        eq(err.isRetryable, true, '502: 服务端错误可重试');
      }

      // --- 可重试矩阵 ---
      eq(new ApiRequestError({ status: 400 }).isRetryable, false, '重试矩阵: 400 不重试');
      eq(new ApiRequestError({ status: 401 }).isRetryable, false, '重试矩阵: 401 不重试');
      eq(new ApiRequestError({ status: 403 }).isRetryable, false, '重试矩阵: 403 不重试');
      eq(new ApiRequestError({ status: 404 }).isRetryable, false, '重试矩阵: 404 不重试');
      eq(new ApiRequestError({ status: 408 }).isRetryable, true, '重试矩阵: 408 可重试');
      eq(new ApiRequestError({ status: 422 }).isRetryable, false, '重试矩阵: 422 不重试');
      eq(new ApiRequestError({ status: 429 }).isRetryable, true, '重试矩阵: 429 可重试');
      eq(new ApiRequestError({ status: 500 }).isRetryable, true, '重试矩阵: 500 可重试');
      eq(new ApiRequestError({ status: 503 }).isRetryable, true, '重试矩阵: 503 可重试');
      eq(new ApiRequestError({ timeoutMs: 30000 }).isRetryable, true, '重试矩阵: 超时可重试');
      eq(new ApiRequestError({}).isRetryable, true, '重试矩阵: 网络错误可重试');
      eq(new ApiRequestError({ status: 401 }).isTimeout, false, '401 非超时');
      eq(new ApiRequestError({ timeoutMs: 1000 }).isTimeout, true, '超时判定');

      // --- StreamClient 重试决策端到端（403 不重试 / 429 重试 / 500 重试）---
      const runChat = async () => {
        let calls = 0;
        const countingFetch = async () => {
          calls++;
          return {
            ok: false,
            status: lastStatus,
            statusText: 'X',
            headers: new Headers(),
            text: async () => JSON.stringify({ error: { message: 'boom' } }),
          } as unknown as Response;
        };
        globalThis.fetch = countingFetch as unknown as typeof fetch;
        try {
          await streamClient.chat(
            { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
            {},
            {
              providerConfig: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm' },
              retryCount: 1,
              retryIntervalMs: 100,
            }
          );
        } catch {
          /* 预期失败 */
        }
        return calls;
      };

      let lastStatus = 403;
      eq(await runChat(), 1, '403: 只发 1 次请求（不重试）');
      lastStatus = 400;
      eq(await runChat(), 1, '400: 只发 1 次请求（不重试）');
      lastStatus = 429;
      eq(await runChat(), 2, '429: 发 2 次（retryCount=1 + 100ms 退避）');
      lastStatus = 500;
      eq(await runChat(), 2, '500: 发 2 次（可重试）');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // ============================================================
  // 十、连通性探测：5 协议同源复用适配器（URL / 头 / 非流式 body）
  // ============================================================
  {
    const originalFetch = globalThis.fetch;
    const cases: Array<{ provider: ProviderType; baseUrl: string; apiKey?: string; url: string }> = [
      { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', url: 'https://api.openai.com/v1/chat/completions' },
      { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', url: 'http://localhost:11434/api/chat' },
      {
        provider: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'GKEY',
        url: 'https://generativelanguage.googleapis.com/v1beta/models/m1:generateContent?key=GKEY',
      },
      { provider: 'claude', baseUrl: 'https://api.anthropic.com', apiKey: 'ANTH', url: 'https://api.anthropic.com/v1/messages' },
      { provider: 'openai-responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', url: 'https://api.openai.com/v1/responses' },
    ];

    try {
      for (const testCase of cases) {
        let captured: { url?: string; body?: any; headers?: any } = {};
        globalThis.fetch = (async (url: string, init: any) => {
          captured = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            text: async () => JSON.stringify({ ok: true }),
          } as unknown as Response;
        }) as unknown as typeof fetch;

        const result = await probeConnection({
          provider: testCase.provider,
          baseUrl: testCase.baseUrl,
          apiKey: testCase.apiKey,
          model: 'm1',
        });

        eq(captured.url, testCase.url, `probe ${testCase.provider}: URL 与适配器同源`);
        if (testCase.provider === 'gemini') {
          check(!('stream' in captured.body), 'probe gemini: body 无 stream 字段（非流式是独立 method）');
        } else {
          eq(captured.body.stream, false, `probe ${testCase.provider}: 非流式`);
        }
        check(result.latencyMs >= 0, `probe ${testCase.provider}: 返回耗时`);
        check(typeof result.raw === 'string', `probe ${testCase.provider}: 返回原始响应`);

        // 认证头按协议注入
        if (testCase.provider === 'openai' || testCase.provider === 'openai-responses') {
          eq(captured.headers['Authorization'], 'Bearer sk-1', `probe ${testCase.provider}: Bearer`);
        }
        if (testCase.provider === 'claude') {
          eq(captured.headers['x-api-key'], 'ANTH', 'probe claude: x-api-key');
          eq(captured.headers['anthropic-version'], '2023-06-01', 'probe claude: anthropic-version');
        }
      }

      // 探测失败：403 → ApiRequestError 且带原始 JSON
      globalThis.fetch = (async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: new Headers(),
        text: async () => JSON.stringify({ error: { message: 'invalid x-api-key' } }),
      })) as unknown as typeof fetch;
      await expectReject(
        probeConnection({ provider: 'claude', baseUrl: 'https://api.anthropic.com', apiKey: 'bad', model: 'm1' }),
        'invalid x-api-key',
        'probe: 403 摘要取自服务端原文'
      );

      // 探测失败：200 但 body 带 error → 同样算失败并展示原始 JSON
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: async () => JSON.stringify({ error: { message: 'model not found' } }),
      })) as unknown as typeof fetch;
      await expectReject(
        probeConnection({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', model: 'nope' }),
        'model not found',
        'probe: 200 + error 字段同样判失败'
      );

      // 探测失败：超时 → timeout 错误（可重试）
      globalThis.fetch = (async () => {
        throw Object.assign(new DOMException('The operation timed out', 'TimeoutError'), {});
      }) as unknown as typeof fetch;
      try {
        await probeConnection({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', model: 'm' });
        check(false, 'probe: 超时应抛错');
      } catch (error) {
        const err = error as ApiRequestError;
        check(err instanceof ApiRequestError, 'probe: 超时 → ApiRequestError');
        eq(err.isTimeout, true, 'probe: isTimeout');
        eq(err.isRetryable, true, 'probe: 超时可重试');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // ============================================================
  // 十一、Token usage 归一化边界 + stream_options 兼容降级 + 指标计数
  // ============================================================
  {
    // —— 脏数据防御：负数 / 小数 / 字符串数字 / 天文数字 ——
    eqUsage(
      mergeUsageSafe(undefined, normalizeOpenAIUsage({
        prompt_tokens: '-5',       // 字符串负数 → 拒绝
        completion_tokens: 12.7,   // 小数 → floor
        total_tokens: 1e18,        // 超阈值 → 视为脏数据拒绝
        prompt_tokens_details: { cached_tokens: 'not-a-number' },
      })),
      { outputTokens: 12 },
      'usage 脏数据防御: 非法字段静默丢弃，合法字段保留'
    );

    // —— Claude last-wins：后续快照覆盖，绝不累加 ——
    const claudeMerged = mergeUsageSafe(
      mergeUsageSafe(undefined, normalizeClaudeUsage({ input_tokens: 25, cache_read_input_tokens: 128 })),
      normalizeClaudeUsage({ output_tokens: 42 })
    );
    eqUsage(
      claudeMerged,
      { inputTokens: 153, outputTokens: 42, cachedInputTokens: 128, totalTokens: 195 },
      'claude: 输入=input+cache_read，total 由 input+output 推导'
    );
    eqUsage(
      mergeUsageSafe(claudeMerged, normalizeClaudeUsage({ output_tokens: 50 })),
      { inputTokens: 153, outputTokens: 50, cachedInputTokens: 128, totalTokens: 203 },
      'claude: message_delta 累计终值覆盖（50 覆盖 42，输入不重复）'
    );

    // —— DeepSeek 旧缓存字段兼容 ——
    eqUsage(
      mergeUsageSafe(undefined, normalizeOpenAIUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 40 })),
      { inputTokens: 100, cachedInputTokens: 40 },
      'usage: DeepSeek 旧字段 prompt_cache_hit_tokens 兼容'
    );

    // —— Claude 畸形防御：缺 input_tokens 但带缓存字段 → 缓存合计作为输入下限 ——
    eqUsage(
      mergeUsageSafe(undefined, normalizeClaudeUsage({ cache_read_input_tokens: 64 })),
      { inputTokens: 64, cachedInputTokens: 64 },
      'usage: claude 缺 input_tokens 时缓存字段不丢失'
    );

    // —— 转写 usage 双命名兼容（gpt-4o-transcribe 官方为 Responses 风格命名） ——
    eqUsage(
      mergeUsageSafe(undefined, normalizeTranscriptionUsage({
        usage: { type: 'tokens', input_tokens: 80, output_tokens: 20, total_tokens: 100, input_token_details: { cached_tokens: 30 } },
      })),
      { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      'usage: 转写 Responses 风格命名（input_tokens/output_tokens）解析'
    );
    eqUsage(
      mergeUsageSafe(undefined, normalizeTranscriptionUsage({
        usage: { prompt_tokens: 60, completion_tokens: 15, total_tokens: 75 },
      })),
      { inputTokens: 60, outputTokens: 15, totalTokens: 75 },
      'usage: 转写 Chat Completions 风格命名（prompt_tokens/completion_tokens）兼容'
    );

    // —— 非流式响应体分派（连通性探测复用） ——
    eqUsage(
      mergeUsageSafe(undefined, normalizeUsageFromBody('openai', { usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } })),
      { inputTokens: 9, outputTokens: 2, totalTokens: 11 },
      'usage: 非流式 openai 布局'
    );
    eqUsage(
      mergeUsageSafe(undefined, normalizeUsageFromBody('gemini', { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } })),
      { inputTokens: 7, outputTokens: 3, totalTokens: 10, cachedInputTokens: 0 },
      'usage: 非流式 gemini 布局（cachedContentTokenCount 缺失 = 0 命中，仍属有效上报）'
    );
    eqUsage(
      mergeUsageSafe(undefined, normalizeUsageFromBody('ollama', { prompt_eval_count: 5, eval_count: 6 })),
      { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
      'usage: 非流式 ollama 布局'
    );
    eqUsage(
      mergeUsageSafe(undefined, normalizeUsageFromBody('openai-responses', { usage: { input_tokens: 4, output_tokens: 5 } })),
      { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      'usage: 非流式 responses 布局'
    );

    // —— stream_options 兼容降级：旧网关 400 → 去参重发 + 端点记忆 + 指标只计一次 ——
    {
      const originalFetch = globalThis.fetch;
      let calls = 0;
      const bodies: any[] = [];
      const okSse =
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}\n\n' +
        'data: [DONE]\n\n';
      globalThis.fetch = (async (_url: string, init: any) => {
        calls++;
        const body = JSON.parse(init?.body);
        bodies.push(body);
        if (calls === 1) {
          return {
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            headers: new Headers(),
            text: async () =>
              JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options', type: 'invalid_request_error' } }),
          } as unknown as Response;
        }
        const bytes = new TextEncoder().encode(okSse);
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'text/event-stream' }),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        } as unknown as Response;
      }) as typeof fetch;

      try {
        const compatUrl = 'https://compat-gateway.example/v1';
        const chatOptions = {
          providerConfig: { provider: 'openai' as ProviderType, baseUrl: compatUrl, apiKey: 'k', model: 'm-1' },
          retryCount: 0,
        };

        const metricsBefore = aiUsageMetrics.getSnapshot().totals.requests;

        const result = await quiet(() =>
          streamClient.chat({ model: 'm-1', messages: systemAndUser, stream: true }, {}, chatOptions)
        );
        eq(calls, 2, '降级: 400(stream_options) 后自动去参重发一次');
        check(!!bodies[0].stream_options, '降级: 首次请求携带 stream_options');
        check(!bodies[1].stream_options, '降级: 重发请求已去掉 stream_options');
        eq(result.finalMessage.content, 'ok', '降级: 重发后流式正文正常');
        eqUsage(result.usage, { inputTokens: 9, outputTokens: 2, totalTokens: 11 }, '降级: 重发后 usage 正常解析');
        eq(
          aiUsageMetrics.getSnapshot().totals.requests - metricsBefore,
          1,
          '降级: 透明重发不重复计数（整次 executeRequest 只计 1 次请求）'
        );

        // 端点记忆：同端点后续请求直接不带 stream_options（不再先撞 400）
        await quiet(() =>
          streamClient.chat({ model: 'm-1', messages: systemAndUser, stream: true }, {}, chatOptions)
        );
        eq(calls, 3, '降级: 端点记忆生效，第三次请求直接成功');
        check(!bodies[2].stream_options, '降级: 记忆后请求体不再携带 stream_options');
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    // —— 建连/HTTP 失败（fetch 抛错路径）也必须计数 ——
    {
      const originalFetch = globalThis.fetch;
      aiUsageMetrics.reset();
      globalThis.fetch = (async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: new Headers(),
        text: async () => JSON.stringify({ error: { message: 'forbidden key' } }),
      })) as unknown as typeof fetch;
      try {
        let threw = false;
        try {
          await quiet(() =>
            streamClient.chat(
              { model: 'm-403', messages: systemAndUser, stream: true },
              {},
              {
                providerConfig: { provider: 'openai', baseUrl: 'https://deny.example/v1', apiKey: 'k', model: 'm-403' },
                retryCount: 0,
              }
            )
          );
        } catch {
          threw = true;
        }
        check(threw, '指标用例前置: 403 应抛错');
        const snap = aiUsageMetrics.getSnapshot();
        eq(snap.totals.requests, 1, '指标: 建连失败（HTTP 403）也计入总请求');
        eq(snap.totals.failed, 1, '指标: 建连失败计入 failed');
        eq(snap.recentErrors.length, 1, '指标: 建连失败保留单行摘要');
        check(snap.models.some(m => m.model === 'm-403' && m.failed === 1), '指标: 建连失败进入模型拆分');
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    // —— 指标引擎：失败/中止/占比的计数语义 ——
    {
      aiUsageMetrics.reset();
      aiUsageMetrics.record({ provider: 'openai', model: 'gpt-x', kind: 'chat', outcome: 'success', usage: { inputTokens: 100, outputTokens: 50 } });
      aiUsageMetrics.record({ provider: 'openai', model: 'gpt-x', kind: 'chat', outcome: 'failed', errorSummary: 'HTTP 429 [Too Many Requests]', usage: { inputTokens: 100 } });
      aiUsageMetrics.record({ provider: 'claude', model: 'c-1', kind: 'chat', outcome: 'aborted', usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 8 } });
      const snap = aiUsageMetrics.getSnapshot();
      eq(snap.totals.requests, 3, '指标: 总请求 = 成功+失败+中止');
      eq(snap.totals.success, 1, '指标: 成功计数');
      eq(snap.totals.failed, 1, '指标: 失败计数');
      eq(snap.totals.aborted, 1, '指标: 中止计数');
      eq(snap.totals.inputTokens, 210, '指标: 输入 token 累加');
      eq(snap.totals.totalTokens, 265, '指标: 总 token = input(210)+output(55)');
      eq(snap.totals.cacheReportedRequests, 1, '指标: 仅上报了缓存字段的请求进入命中率分母');
      eq(snap.totals.cacheEligibleInputTokens, 10, '指标: 命中率分母为上报请求的输入量');
      eq(snap.models.length, 2, '指标: 按模型拆分');
      eq(snap.models[0].model, 'gpt-x', '指标: 按 totalTokens 降序（gpt-x=250 > c-1=15）');
      check(Math.abs((snap.models[0].share ?? 0) - 250 / 265) < 1e-9, '指标: 占比 = 模型 total / 全局 total');
      eq(snap.recentErrors.length, 1, '指标: 失败摘要环形缓冲');
      check(snap.recentErrors[0].summary.includes('429'), '指标: 失败摘要保留单行原因');
      aiUsageMetrics.reset();
      eq(aiUsageMetrics.getSnapshot().totals.requests, 0, '指标: 清零');
      eq(aiUsageMetrics.getSnapshot().startedAt, 0, '指标: 清零后统计起点归零');
      // 统计起点：首条记录时落定
      aiUsageMetrics.record({ provider: 'x', model: 'm', kind: 'chat', outcome: 'success' });
      check(aiUsageMetrics.getSnapshot().startedAt > 0, '指标: 首条记录落定统计起点');
    }
  }

  // ============================================================
  // 十二、协议完整性与错误可分析性（终态校验 / HTML 端点 / 流内分类 /
  //       Retry-After / 日志脱敏 / 探测非 JSON）
  // ============================================================
  {
    // —— 终态校验 A：零事件流 → protocol 错误（绝不静默「成功」空回复）——
    try {
      await replay(openai, '');
      check(false, '终态校验: 空流应抛错');
    } catch (error) {
      const err = error as ApiRequestError;
      check(err instanceof ApiRequestError, '终态校验: 空流 → ApiRequestError 实例');
      eq(err.kind, 'protocol', '终态校验: 空流 kind=protocol');
      check(err.isRetryable, '终态校验: 协议错误可重试（瞬时故障可自愈）');
      check(
        err.summary.includes('未返回任何流式数据'),
        '终态校验: 空流摘要可读（指向地址/模型）',
        err.summary,
      );
    }

    // —— 终态校验 B：有内容但无结束事件 → 半截回复绝不冒充完整回复 ——
    const halfStream =
      'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n';
    try {
      await replay(openai, halfStream);
      check(false, '终态校验: 半截流应抛错');
    } catch (error) {
      const err = error as ApiRequestError;
      eq(err.kind, 'protocol', '终态校验: 半截流 kind=protocol');
      check(
        err.summary.includes('回复可能不完整'),
        '终态校验: 摘要说明回复可能不完整',
        err.summary,
      );
      check(err.rawBody.includes('"choices"'), '终态校验: 首行预览入 rawBody 供分析');
    }

    // —— 宽容边界：finish_reason 已到但网关没发 [DONE] → 仍判成功 ——
    const noDone =
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}';
    const nd = await replay(openai, noDone);
    eq(nd.content, 'ok', '终态校验: finish_reason 已到但缺 [DONE] 仍成功');
    eq(nd.finishReason, 'stop', '终态校验: finish_reason 保留');

    // —— 200 + text/html（地址指向登录页）→ 带页面证据失败且不重试 ——
    {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><body>Please login</body></html>',
      })) as unknown as typeof fetch;
      try {
        await openai.fetchStream('https://x.example/v1/chat/completions', {}, { model: 'm' });
        check(false, 'HTML 端点应抛错');
      } catch (error) {
        const err = error as ApiRequestError;
        check(err instanceof ApiRequestError, 'HTML 端点 → ApiRequestError 实例');
        eq(err.status, 200, 'HTML 端点: 保留真实状态码');
        eq(err.isRetryable, false, 'HTML 端点: 不重试（登录页重试无意义）');
        check(
          err.summary.includes('不是合法 JSON'),
          'HTML 端点: 摘要说明地址非 API 端点',
          err.summary,
        );
        check(err.rawBody.includes('Please login'), 'HTML 端点: 页面原文入 rawBody 供分析');
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    // —— 流内错误结构化：kind=inband + 协议前缀 + 原始事件进卡片 ——
    try {
      await replay(openai, 'data: {"error":{"message":"rate limited","type":"rate_limit_error"}}\n');
      check(false, '流内错误应抛出');
    } catch (error) {
      const err = error as ApiRequestError;
      check(err instanceof ApiRequestError, '流内错误 → ApiRequestError 实例');
      eq(err.kind, 'inband', '流内错误: kind=inband');
      eq(err.isRetryable, true, '流内错误: 保持可重试（瞬时限流可自愈）');
      check(
        err.summary.includes('OpenAI API error'),
        '流内错误: summary 带协议前缀',
        err.summary,
      );
      const card = toApiErrorBlock(err);
      check(card.includes('kind="inband"'), '流内错误: 卡片带分类属性');
      check(card.includes('rate_limit_error'), '流内错误: 卡片带原始事件 JSON');
    }

    const disconnectedCard = toApiErrorBlock(new Error('会话后台连接已断开'));
    eq(disconnectedCard.split('会话后台连接已断开').length - 1, 1, '单行内部错误只显示一次');
    check(toApiErrorBlock(new Error('会话失败\n连接细节')).includes('<raw>'), '多行内部错误保留完整原文');

    // —— Retry-After：秒数识别 / HTTP-date 与非法值不识别 ——
    eq(parseRetryAfterMs('7'), 7000, 'Retry-After: 秒数解析');
    eq(parseRetryAfterMs(' 12 '), 12000, 'Retry-After: 容忍空白');
    eq(
      parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT'),
      undefined,
      'Retry-After: HTTP-date 形态不识别（退避兜底）',
    );
    eq(parseRetryAfterMs(null), undefined, 'Retry-After: 缺失不识别');
    eq(parseRetryAfterMs('-1'), undefined, 'Retry-After: 负值不识别');
    eq(parseRetryAfterMs('abc'), undefined, 'Retry-After: 非数字不识别');

    // —— 429 的 Retry-After 进入错误对象（重试退避优先采用）——
    {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({ 'retry-after': '3' }),
        text: async () => JSON.stringify({ error: { message: 'slow down' } }),
      })) as unknown as typeof fetch;
      try {
        await openai.fetchStream('https://x.example/v1/chat/completions', {}, { model: 'm' });
        check(false, '429 应抛错');
      } catch (error) {
        const err = error as ApiRequestError;
        eq(err.retryAfterMs, 3000, 'Retry-After: 429 携带的秒数进入错误对象');
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    // —— URL 脱敏：Gemini 式 key 绝不进日志/卡片/指标 ——
    eq(
      sanitizeUrlForLog(
        'https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse&key=SECRET123',
      ),
      'https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse&key=***',
      'URL 脱敏: key 值替换为 ***',
    );
    eq(
      sanitizeUrlForLog('https://api.openai.com/v1/chat/completions'),
      'https://api.openai.com/v1/chat/completions',
      'URL 脱敏: 无密钥参数原样保留',
    );
    check(
      !(new ApiRequestError({ url: 'https://x.example/v1?model=m&api_key=TOPSECRET' }).url ?? '').includes(
        'TOPSECRET',
      ),
      'URL 脱敏: ApiRequestError.url 入库前已脱敏',
    );

    // —— 连通性探测：200 + 非 JSON（HTML/空体）绝不判成功 ——
    {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><body>gateway login</body></html>',
      })) as unknown as typeof fetch;
      try {
        await probeConnection({
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-x',
          model: 'gpt-4o',
        });
        check(false, 'probe: 非 JSON 响应应抛错');
      } catch (error) {
        const err = error as ApiRequestError;
        check(err instanceof ApiRequestError, 'probe: 非 JSON → ApiRequestError 实例');
        check(
          err.summary.includes('不是合法 JSON'),
          'probe: 摘要说明地址可能指向网页',
          err.summary,
        );
        check(err.rawBody.includes('gateway login'), 'probe: 页面原文入 rawBody');
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    // —— 永久性前置错误：视觉能力不匹配 → PermanentRequestError（不进重试）——
    try {
      await prepareVisionRequest(
        'openai',
        { vision: false, remoteImageUrl: 'base64', tools: true, reasoning: false },
        {
          model: 'm',
          messages: [
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://a/b.png' } }] },
          ],
        },
      );
      check(false, '视觉不支持应抛错');
    } catch (error) {
      check(
        error instanceof PermanentRequestError,
        '视觉不支持 → PermanentRequestError（StreamClient 据此跳过重试）',
      );
      check(
        error instanceof Error && error.message.includes('不支持图片输入'),
        '视觉不支持: 错误文案可读',
      );
    }
  }

  // ============================================================
  // Cache protocol contracts: signatures, local-only metadata and bounded
  // compatibility fallbacks must not break an otherwise valid conversation.
  {
    const signed = await replay(gemini, `data: ${JSON.stringify({ candidates: [{ content: { parts: [{
      functionCall: { name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'opaque-signature',
    }] }, finishReason: 'STOP' }] })}\n\n`);
    eq(signed.toolCalls[0]?.geminiThoughtSignature, 'opaque-signature', 'gemini: opaque function signature retained');
    const message: UnifiedChatMessage = { role: 'assistant', content: '', tool_calls: signed.toolCalls };
    const replayed = gemini.buildRequestBody({ model: 'g', messages: [message] });
    eq(replayed.contents[0].parts[0].thoughtSignature, 'opaque-signature', 'gemini: signature replayed unchanged');
    const other = openai.buildRequestBody({ model: 'o', messages: [message], metrics: { runId: 'local-only' } });
    check(!JSON.stringify(other).includes('opaque-signature'), 'openai: Gemini-only metadata must not leak');
    check(!JSON.stringify(other).includes('local-only'), 'protocol: diagnostic metadata stays local');
  }
  {
    const originalFetch = globalThis.fetch;
    const bodies: any[] = [];
    try {
      globalThis.fetch = (async (_url: any, init: any) => {
        const body = JSON.parse(init.body); bodies.push(body);
        const marked = body.cache_control || body.system?.some?.((part: any) => part.cache_control);
        if (marked) return new Response(JSON.stringify({ error: { message: 'cache_control is not supported here' } }), { status: 400 });
        return new Response(claudeSSE, { headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch;
      const config: StreamRequestConfig = { model: 'claude-cache-test', messages: systemAndUser, max_tokens: 512 };
      const options = { providerConfig: { provider: 'claude' as const, baseUrl: 'https://cache-compat.example', apiKey: 'test', model: 'claude-cache-test' }, retryCount: 0 };
      await quiet(() => streamClient.chat(config, {}, options));
      eq(bodies.length, 3, 'claude: reject automatic then block caching with bounded fallbacks');
      check(!!bodies[0].cache_control, 'claude: initially enable automatic caching');
      check(!bodies[1].cache_control && !!bodies[1].system[0].cache_control, 'claude: automatic rejection preserves block checkpoints');
      check(!JSON.stringify(bodies[2]).includes('cache_control'), 'claude: unsupported gateway receives no cache directives');
      await quiet(() => streamClient.chat(config, {}, options));
      eq(bodies.length, 4, 'claude: remembered compatibility avoids repeat failed attempts');
      check(!JSON.stringify(bodies[3]).includes('cache_control'), 'claude: remembered compatibility strips all block checkpoints');
    } finally { globalThis.fetch = originalFetch; }
  }
  {
    const originalFetch = globalThis.fetch;
    const bodies: any[] = [];
    try {
      globalThis.fetch = (async (_url: any, init: any) => {
        const body = JSON.parse(init.body); bodies.push(body);
        if (body.prompt_cache_key) return new Response(JSON.stringify({ error: { message: 'prompt_cache_key unsupported' } }), { status: 400 });
        return new Response(openaiSSE, { headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch;
      await quiet(() => streamClient.chat({ model: 'cache-key-test', messages: systemAndUser, promptCacheKey: 'stable' }, {}, {
        providerConfig: { provider: 'openai', baseUrl: 'https://key-compat.example/v1', apiKey: 'test', model: 'cache-key-test' }, retryCount: 0,
      }));
      eq(bodies.length, 2, 'openai: unsupported optional routing key does not stop the run');
      check(!bodies[1].prompt_cache_key, 'openai: rejected routing key removed on retry');
      eq(bodies[0].messages, bodies[1].messages, 'openai: compatibility fallback preserves all messages');
    } finally { globalThis.fetch = originalFetch; }
  }

  await quiet(() => testNativeCache());

  // 汇总
  // ============================================================
  console.log(`\n协议契约测试：通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    for (const f of failures) console.log('  ✗ ' + f);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('契约测试执行异常:', error);
  process.exit(1);
});

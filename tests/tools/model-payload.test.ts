/**
 * 模型侧工具载荷契约（conversation-engine → 模型上下文这一跳）：
 *
 * 1. compactFrameDiagnosticsForModel：诊断瘦身（丢 documents 簿记、保 issues、
 *    干净页收敛为单个摘要对象）——完整诊断留在 ToolResult 原始记录里。
 * 2. primary 通道：primary='content' 的正文（文件页文本 / 脚本 stdout / 询问
 *    答复）必须进模型载荷；primary='data'（默认）时 content 是派生摘要，删除
 *    以防翻倍。
 * 3. budget 字段：轮次预算以 JSON 字段交付（严格可解析——下游
 *    buildVisionContinuationMessage 按 JSON.parse 消费工具 content，
 *    字符串尾部追加会静默炸掉续拍摘要链路）。
 *
 * 运行：由 tools.test.ts 末尾动态引入（chrome 全局桩已就位）。
 */
import { strict as assert } from 'node:assert';
import {
  compactFrameDiagnosticsForModel,
} from '../../common/tool-handler';
import { ConversationEngine } from '../../entrypoints/sidepanel/core/conversation/conversation-engine';

// ───────────────── 1. 诊断压缩器（纯函数） ─────────────────
{
  const dirty = {
    frameDiagnostics: [
      {
        operation: 'observe-scan',
        status: 'complete',
        discoveryComplete: true,
        elapsedMs: 320,
        successfulFrameIds: [0, 38],
        issues: [],
        documents: [{ frameId: 0, documentId: 'A'.repeat(64) }, { frameId: 38, documentId: 'B'.repeat(64) }],
      },
      {
        operation: 'observe-focus',
        status: 'partial',
        discoveryComplete: false,
        elapsedMs: 40,
        successfulFrameIds: [0],
        issues: [
          { stage: 'focus', code: 'FOCUS_READ_FAILED', frameId: 38, message: 'x'.repeat(400) },
        ],
        documents: [{ frameId: 0, documentId: 'C'.repeat(64) }],
      },
    ],
    other: 1,
  };
  const compact = compactFrameDiagnosticsForModel(dirty) as any;
  assert.equal(compact.frameDiagnostics.status, 'partial', '状态取最差');
  assert.deepEqual(compact.frameDiagnostics.frames, [0, 38], 'frames 聚合去重排序');
  assert.equal(compact.frameDiagnostics.elapsedMs, 360, 'elapsedMs 求和');
  assert.equal(compact.frameDiagnostics.issues.length, 1, 'issues 保留');
  assert.ok((compact.frameDiagnostics.issues[0].message as string).length <= 201, 'issue 消息截断');
  assert.ok(!('documents' in compact.frameDiagnostics), 'documents 簿记被剔除');
  assert.equal(compact.other, 1, '其余字段原样保留');
  assert.ok(
    JSON.stringify(compact).length < JSON.stringify(dirty).length / 2,
    '压缩后显著变小',
  );

  const clean = compactFrameDiagnosticsForModel({
    frameDiagnostics: [
      { operation: 'a', status: 'complete', elapsedMs: 10, successfulFrameIds: [0], issues: [], documents: [{ frameId: 0, documentId: 'D'.repeat(64) }] },
    ],
  }) as any;
  assert.equal(clean.frameDiagnostics.status, 'complete');
  assert.deepEqual(clean.frameDiagnostics.issues, []);

  const untouched = { frameDiagnostics: 'weird-shape', keep: true };
  assert.equal(
    compactFrameDiagnosticsForModel(untouched),
    untouched,
    '形态异常时原样返回（不吞字段）',
  );
  const noField = { a: 1 };
  assert.equal(compactFrameDiagnosticsForModel(noField), noField, '无字段时零开销直通');
}

// ───────────────── 2. 引擎载荷：primary / budget / 诊断压缩 ─────────────────
{
  type ToolReply = { success: boolean; content?: unknown; data?: Record<string, unknown>; primary?: 'content' | 'data' };
  const makeEngine = (reply: ToolReply | ((args: unknown) => ToolReply)) => {
    let request = 0;
    const sent: Array<{ content: string }[]> = [];
    const engine = new ConversationEngine({
      requiresApproval: () => false,
      executeTool: async () => (typeof reply === 'function' ? reply({}) : reply),
      sendStream: async (messages: any[], callbacks: any) => {
        request++;
        sent.push(structuredClone(messages));
        if (request === 1) {
          const call = { id: 'call-1', type: 'function' as const, function: { name: 'file_util', arguments: '{"action":"read","path":"a.md"}' } };
          callbacks.onToolCall?.(call);
          return {
            finalMessage: { role: 'assistant', content: '', tool_calls: [call] },
            finishReason: 'tool_calls',
          };
        }
        return { finalMessage: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
      },
    } as any) as any;
    engine.interruptibleDelay = async () => {};
    return { engine, sent };
  };
  const runtime: any = {
    chatId: 'model-payload',
    toolIds: ['file_util'],
    advertisedToolIds: ['file_util'],
    vision: null,
    limits: { maxIterations: 60, maxDurationMs: 10_000, toolTimeoutMs: 5_000, maxConsecutiveFailedToolRounds: 5 },
    model: { provider: 'openai', model: 'test', contextThreshold: 64_000 },
    systemPrompt: 'policy',
    toolPolicy: undefined,
    userInput: 'read the file',
    attachmentPrompt: '',
    userImages: [],
    initialContext: [],
    activationContext: [],
    priorMaxSeq: 0,
  };
  const toolCall = {
    id: 'payload-call',
    type: 'function' as const,
    function: { name: 'file_util', arguments: '{"action":"read","path":"a.md"}' },
  };

  // 2a. primary='content'：正文必须原样进模型载荷，budget 字段在场
  {
    const { engine } = makeEngine({
      success: true,
      primary: 'content',
      content: [{ type: 'text', text: 'FILE BODY MARKER-XYZ' }],
      data: { path: 'a.md', index: 1 },
    });
    const result = await engine.executeToolCalls(
      runtime,
      {
        abortController: new AbortController(),
        dynamicToolIds: new Set(),
        record: { toolCalls: [], parts: [] },
        toolCallCount: 0,
        currentIteration: 7,
      } as any,
      [toolCall],
      {},
      () => {},
      Date.now() + 60_000,
    );
    const raw = result.messages[0].content as string;
    assert.ok(raw.includes('FILE BODY MARKER-XYZ'), `content 正文必须保留: ${raw.slice(0, 200)}`);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.path, 'a.md', '元数据 data 保留');
    assert.equal(typeof parsed.budget, 'string', 'budget 字段在场');
    assert.match(parsed.budget, /已用 7\/60 轮，剩余 53/, 'budget 携带事实');
    assert.equal(parsed.primary, undefined, 'primary 路由字段不下发');
  }

  // 2b. primary 默认 data：content 摘要删除、data 完整（防翻倍回归）
  {
    const { engine } = makeEngine({
      success: true,
      content: [{ type: 'text', text: 'SUMMARY-ONLY' }],
      data: { elements: '| # | Type |', frameDiagnostics: [
        { operation: 'scan', status: 'complete', elapsedMs: 5, successfulFrameIds: [0], issues: [], documents: [{ frameId: 0, documentId: 'E'.repeat(64) }] },
      ] },
    });
    const result = await engine.executeToolCalls(
      runtime,
      {
        abortController: new AbortController(),
        dynamicToolIds: new Set(),
        record: { toolCalls: [], parts: [] },
        toolCallCount: 0,
        currentIteration: 1,
      } as any,
      [toolCall],
      {},
      () => {},
      Date.now() + 60_000,
    );
    const raw = result.messages[0].content as string;
    const parsed = JSON.parse(raw);
    assert.equal(parsed.content, undefined, 'data 正题时删除 content 摘要');
    assert.equal(parsed.data.elements, '| # | Type |', 'data 正文保留');
    assert.ok(!('documents' in parsed.data.frameDiagnostics), '模型侧诊断已压缩');
    assert.equal(parsed.data.frameDiagnostics.status, 'complete', '压缩摘要含状态');
  }

  // 2c. 无 result 的失败占位：错误可读且不带 budget（没有轮次上下文载体）
  {
    const { engine } = makeEngine({ success: true });
    const result = await engine.executeToolCalls(
      runtime,
      {
        abortController: new AbortController(),
        dynamicToolIds: new Set(),
        record: { toolCalls: [], parts: [] },
        toolCallCount: 0,
        currentIteration: 3,
      } as any,
      [{ ...toolCall, id: 'ghost' }],
      {},
      () => {},
      Date.now() + 60_000,
    );
    // executeTool 总会返回 result（本用例返回 success:true 的 data 通道）——
    // 断言载荷严格 JSON 可解析（预算不得以字符串拼接破坏协议）
    const parsed = JSON.parse(result.messages[0].content as string);
    assert.equal(parsed.success, true);
    assert.equal(typeof parsed.budget, 'string');
  }
}

console.log('[model-payload] frameDiagnostics compression, primary content retention and budget field passed.');

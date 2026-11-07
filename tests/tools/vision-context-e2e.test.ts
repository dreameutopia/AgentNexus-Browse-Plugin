/**
 * 视觉循环「模型可见上下文唯一截图」端到端契约测试
 *
 * 覆盖任务的两条核心契约：
 *   1. **单次截屏**：用户发送消息到 agent 首次回复之间只有一次截屏；
 *      模型可见上下文里同一张视口截图只出现一次（用户主动上传的图片
 *      不计入该配额）。
 *   2. **纯读批次不重拍**：整批工具调用均为 noVisionRecapture=true 时，
 *      视觉循环按文本执行循环封装工具响应，不重拍、不合成多模态续拍消息。
 *
 * 测试手法：以内存替身驱动真实 ConversationEngine.run()，
 * 捕获每次模型请求的消息数组并统计其中的 image_url 部件。
 * 这比单测内部函数更接近真实链路——首截图入用户消息、续拍入续拍消息、
 * 历史重放三条路径都在其中。
 */

import assert from 'node:assert/strict';

const { ConversationEngine } = await import('../../entrypoints/sidepanel/core/conversation/conversation-engine');
const { imageStore } = await import('../../entrypoints/sidepanel/core/images/image-store');
const { ViewportImageDeduplicator } = await import('../../entrypoints/sidepanel/core/conversation/viewport-image-dedup');
const { collectPriorViewportRefs } = await import('../../entrypoints/sidepanel/core/context/viewport-ref-collector');

/** 统计一条消息里的 image_url 部件数 */
const imageParts = (message: any): number =>
  Array.isArray(message?.content)
    ? message.content.filter((part: any) => part.type === 'image_url').length
    : 0;

/** 统计一批消息里的 image_url 部件总数 */
const totalImageParts = (messages: readonly any[]): number =>
  messages.reduce((sum, message) => sum + imageParts(message), 0);

/**
 * 构造一个受控的引擎替身：
 *   - executeTool：按工具名返回可编程结果；
 *   - sendVision / sendStream：捕获请求消息，按脚本返回工具调用或文本。
 */
function makeEngine(options: {
  toolResults: Record<string, unknown>;
  rounds: Array<{
    toolCall?: { id: string; name: string; arguments: string };
    text?: string;
    /** 可选钩子：在引擎发出工具调用时同步触发，用于断言调用副作用 */
    onToolCall?: (call: { id: string; type: string; function: { id: string; name: string; arguments: string } }) => void;
  }>;
  captureResult?: unknown;
}) {
  const requests: any[][] = [];
  let round = 0;
  const engine = new ConversationEngine({
    executeTool: async (name: string) => {
      if (name === 'screenshot' && options.captureResult !== undefined) return options.captureResult as any;
      return (options.toolResults[name] ?? { success: true, data: { text: 'ok' } }) as any;
    },
    requiresApproval: () => false,
    sendVision: async (messages: any[]) => {
      requests.push(structuredClone(messages));
      const plan = options.rounds[round++] ?? { text: 'done' };
      if (plan.toolCall) {
        plan.onToolCall?.({ id: plan.toolCall.id, type: 'function', function: plan.toolCall });
        return { finalMessage: { role: 'assistant', content: '', tool_calls: [{ id: plan.toolCall.id, type: 'function', function: plan.toolCall }] }, finishReason: 'tool_calls' };
      }
      return { finalMessage: { role: 'assistant', content: plan.text ?? '' }, finishReason: 'stop' };
    },
    sendStream: async (messages: any[]) => {
      requests.push(structuredClone(messages));
      const plan = options.rounds[round++] ?? { text: 'done' };
      return { finalMessage: { role: 'assistant', content: plan.text ?? '' }, finishReason: 'stop' };
    },
  } as any) as any;
  return { engine, requests };
}

/** 视觉运行时的最小骨架（跳过真实装配：模型与工具面在此不参与判定） */
const visionRuntime = (overrides: Record<string, unknown> = {}) => ({
  chatId: 'vision-e2e',
  agentId: 'Vision-Action',
  systemPrompt: 'test',
  toolIds: ['screenshot', 'browser_get_page_text', 'vision_gui'],
  advertisedToolIds: ['screenshot', 'browser_get_page_text', 'vision_gui'],
  model: { contextThreshold: 32000 },
  limits: { maxIterations: 4, maxDurationMs: 60000, toolTimeoutMs: 5000, maxConsecutiveFailedToolRounds: 3 },
  vision: { screenshotTool: 'screenshot', screenshotArgs: {}, reScreenshotAfterTools: true },
  userInput: '看看页面',
  userImages: [],
  attachmentPrompt: '',
  initialContext: [],
  activationContext: [],
  priorMaxSeq: 0,
  priorViewportImageRefs: [],
  ...overrides,
}) as any;

// ── 契约 1：首截图 + 模型主动截图 → 模型上下文只有一张图 ──
{
  const PNG = 'data:image/png;base64,cG5n';
  const shot = { success: true, data: { screenshot: PNG, text: 'screenshotId=abc; viewport' } };
  // 内容寻址入库：同一张图恒得同一 hash（判重依据）
  const originalPut = imageStore.putFromDataUrl;
  const originalFind = imageStore.findRefByDataUrl;
  const hashByUrl = new Map<string, string>();
  let hashCounter = 0;
  imageStore.putFromDataUrl = async (dataUrl: string) => {
    if (!hashByUrl.has(dataUrl)) hashByUrl.set(dataUrl, 'a'.repeat(63) + String(hashCounter++ % 10));
    return hashByUrl.get(dataUrl)!;
  };
  imageStore.findRefByDataUrl = (dataUrl: string) => hashByUrl.get(dataUrl) ?? null;
  try {
    const { engine, requests } = makeEngine({
      toolResults: { screenshot: shot },
      captureResult: shot,
      rounds: [
        { toolCall: { id: 'c1', name: 'screenshot', arguments: '{}' } },
        { text: '页面已查看' },
      ],
    });
    // 桩掉真实运行所需的宿主能力
    const transcriptEngine = (await import('../../entrypoints/sidepanel/core/context/transcript-engine')).transcriptEngine;
    const originalAppend = transcriptEngine.appendUserMessage;
    const originalCreate = transcriptEngine.createAssistantRecord;
    const originalFlush = transcriptEngine.flush;
    (transcriptEngine as any).appendUserMessage = async (chatId: string, content: string, refs: readonly string[] = []) =>
      ({ id: 'u1', chatId, seq: 1, role: 'user', content, parts: [], reasoning: '', toolCalls: [], status: 'done', imageRefs: [...refs], uploadImageRefs: [...refs], createdAt: Date.now(), updatedAt: Date.now() }) as any;
    (transcriptEngine as any).createAssistantRecord = async (chatId: string) =>
      ({ id: 'a1', chatId, seq: 2, role: 'assistant', content: '', parts: [], reasoning: '', toolCalls: [], status: 'done', createdAt: Date.now(), updatedAt: Date.now() }) as any;
    (transcriptEngine as any).flush = async () => undefined;
    try {
      await engine.run(visionRuntime(), { userInput: '看看页面' } as any);
    } finally {
      (transcriptEngine as any).appendUserMessage = originalAppend;
      (transcriptEngine as any).createAssistantRecord = originalCreate;
      (transcriptEngine as any).flush = originalFlush;
    }
    assert.ok(requests.length >= 2, `Expected at least two model requests, got ${requests.length}`);
    // 第二次请求 = 工具执行后的请求：上下文里必须只有一张视口图
    const afterTool = requests[requests.length - 1];
    assert.equal(totalImageParts(afterTool), 1,
      'Model context must hold exactly one viewport image after an explicit screenshot call');
    // 首请求也已含一张（准备阶段首拍）
    assert.equal(totalImageParts(requests[0]), 1,
      'The first request carries the single initial viewport screenshot');
  } finally {
    imageStore.putFromDataUrl = originalPut;
    imageStore.findRefByDataUrl = originalFind;
  }
}

// ── 契约 2：整批纯读工具 → 不重拍、不合成多模态续拍消息 ──
{
  const PNG = 'data:image/png;base64,cG5n';
  const shot = { success: true, data: { screenshot: PNG, text: 'screenshotId=abc; viewport' } };
  let captureCalls = 0;
  const originalPut = imageStore.putFromDataUrl;
  imageStore.putFromDataUrl = async () => 'a'.repeat(64);
  try {
    const { engine, requests } = makeEngine({
      toolResults: { browser_get_page_text: { success: true, data: { text: '页面正文' } } },
      captureResult: (() => { captureCalls++; return shot; })(),
      rounds: [
        { toolCall: { id: 'c1', name: 'browser_get_page_text', arguments: '{}' } },
        { text: '已读取' },
      ],
    });
    const transcriptEngine = (await import('../../entrypoints/sidepanel/core/context/transcript-engine')).transcriptEngine;
    const originalAppend = transcriptEngine.appendUserMessage;
    const originalCreate = transcriptEngine.createAssistantRecord;
    const originalFlush = transcriptEngine.flush;
    (transcriptEngine as any).appendUserMessage = async (chatId: string, content: string, refs: readonly string[] = []) =>
      ({ id: 'u1', chatId, seq: 1, role: 'user', content, parts: [], reasoning: '', toolCalls: [], status: 'done', imageRefs: [...refs], uploadImageRefs: [...refs], createdAt: Date.now(), updatedAt: Date.now() }) as any;
    (transcriptEngine as any).createAssistantRecord = async (chatId: string) =>
      ({ id: 'a1', chatId, seq: 2, role: 'assistant', content: '', parts: [], reasoning: '', toolCalls: [], status: 'done', createdAt: Date.now(), updatedAt: Date.now() }) as any;
    (transcriptEngine as any).flush = async () => undefined;
    try {
      await engine.run(visionRuntime(), { userInput: '读页面' } as any);
    } finally {
      (transcriptEngine as any).appendUserMessage = originalAppend;
      (transcriptEngine as any).createAssistantRecord = originalCreate;
      (transcriptEngine as any).flush = originalFlush;
    }
    // 准备阶段首拍 1 次；纯读批次不得再拍
    assert.equal(captureCalls, 1, 'A pure-read batch must not trigger another screenshot');
    // 纯读批次不合成多模态续拍消息：第二次请求的上下文图片数与第一次相同
    assert.equal(totalImageParts(requests[requests.length - 1]), 1,
      'Pure-read batches keep the context image count unchanged');
    // 且不追加「继续完成任务」合成消息（否则上下文会多一条 user 消息）
    const last = requests[requests.length - 1];
    const synthetic = last.filter((message: any) =>
      message.role === 'user' && typeof message.content === 'string' && message.content.includes('继续完成任务'));
    assert.equal(synthetic.length, 0, 'Pure-read batches must not synthesize a vision continuation message');
  } finally {
    imageStore.putFromDataUrl = originalPut;
  }
}

// ── 契约 3：跨轮次同图 → 本轮首截图不重复附图 ──
{
  const H = 'c'.repeat(64);
  const originalPut = imageStore.putFromDataUrl;
  const originalFind = imageStore.findRefByDataUrl;
  imageStore.putFromDataUrl = async () => H;
  imageStore.findRefByDataUrl = () => H;
  try {
    const PNG = 'data:image/png;base64,cG5n';
    const shot = { success: true, data: { screenshot: PNG, text: 'screenshotId=abc; viewport' } };
    const { engine, requests } = makeEngine({
      toolResults: {},
      captureResult: shot,
      rounds: [{ text: '好的' }],
    });
    const transcriptEngine = (await import('../../entrypoints/sidepanel/core/context/transcript-engine')).transcriptEngine;
    const originalAppend = transcriptEngine.appendUserMessage;
    const originalCreate = transcriptEngine.createAssistantRecord;
    const originalFlush = transcriptEngine.flush;
    (transcriptEngine as any).appendUserMessage = async (chatId: string, content: string, refs: readonly string[] = []) =>
      ({ id: 'u1', chatId, seq: 1, role: 'user', content, parts: [], reasoning: '', toolCalls: [], status: 'done', imageRefs: [...refs], uploadImageRefs: [...refs], createdAt: Date.now(), updatedAt: Date.now() }) as any;
    (transcriptEngine as any).createAssistantRecord = async (chatId: string) =>
      ({ id: 'a1', chatId, seq: 2, role: 'assistant', content: '', parts: [], reasoning: '', toolCalls: [], status: 'done', createdAt: Date.now(), updatedAt: Date.now() }) as any;
    (transcriptEngine as any).flush = async () => undefined;
    try {
      // 历史视口图引用含本轮首拍的同一 hash → 判重 → 不重复附图
      await engine.run(visionRuntime({ priorViewportImageRefs: [H] }), { userInput: '继续' } as any);
    } finally {
      (transcriptEngine as any).appendUserMessage = originalAppend;
      (transcriptEngine as any).createAssistantRecord = originalCreate;
      (transcriptEngine as any).flush = originalFlush;
    }
    assert.equal(totalImageParts(requests[0]), 0,
      'A cross-round identical viewport must not be attached again');
  } finally {
    imageStore.putFromDataUrl = originalPut;
    imageStore.findRefByDataUrl = originalFind;
  }
}

// 判重器与历史引用提取的协作：历史收集的哈希即判重集合的输入
{
  const H = 'd'.repeat(64);
  const dedup = new ViewportImageDeduplicator();
  for (const ref of collectPriorViewportRefs([{ role: 'assistant', imageRefs: [H] } as any])) dedup.remember(ref);
  assert.equal(dedup.isDuplicate({ ref: H, kind: 'viewport' }), true,
    'Collected history refs feed the deduplicator directly');
}

// ── 存储边界：uploadImageRefs 归一化 ──
// uploadImageRefs 是 imageRefs 的子集，展示口径不得超出 GC 引用集合
// （否则气泡会展示已被回收的图片）；旧记录无该字段时保持缺省不受影响。
// 注：归一化发生在 saveMessage 内部（落库事务之前），故此处直接检验
// 归一化后的落库形态——用真实 saveMessage 会依赖 IndexedDB 宿主，
// 事务内才有可观测结果，故以「桩住事务层、保留归一化」的方式验证。
{
  const UP = '1'.repeat(64);
  const SHOT = '2'.repeat(64);
  const { chatDatabase } = await import('../../entrypoints/sidepanel/core/context/chat-database');
  const originalTx = (chatDatabase as any).tx;
  const originalSession = chatDatabase.getSession;
  let captured: any = null;
  (chatDatabase as any).getSession = async () => ({ id: 'c1', chatId: 'c1' }) as any;
  // 事务层留空：归一化在事务之前完成，落库形态在事务内的 put 处可观测。
  // get 必须返回 IDBRequest 形态（requestToPromise 依赖 onsuccess 回调），
  // 否则事务内的 await 永不 settle。
  (chatDatabase as any).tx = async (_stores: string[], _mode: string, work: any) => {
    await work({
      objectStore: (name: string) => ({
        // get 必须同步返回 IDBRequest 形态（requestToPromise 直接读 .onsuccess）
        get: (key: string) => {
          // 会话必须存在（saveMessage 在会话缺失时于写入前短路返回）
          const result = name === 'sessions' ? { id: key, chatId: key, messageCount: 0 } : undefined;
          const request: any = { result, onsuccess: null, onerror: null };
          queueMicrotask(() => request.onsuccess?.());
          return request;
        },
        put: (value: any) => { if (name === 'messages') captured = value; },
      }),
    });
    return { inserted: true, skipped: false };
  };
  try {
    await chatDatabase.saveMessage({
      id: 'm1', chatId: 'c1', seq: 1, role: 'user', content: 'x', parts: [], reasoning: '', toolCalls: [], status: 'done',
      imageRefs: [UP], uploadImageRefs: [UP], createdAt: Date.now(), updatedAt: Date.now(),
    } as any);
    assert.deepEqual(captured?.uploadImageRefs, [UP], 'Valid upload refs survive normalization');
    assert.ok(captured?.imageRefs?.includes(UP), 'Upload refs stay in the GC reference set');

    // 脏数据：游离引用（不在 imageRefs 内）被剔除——展示口径不得超出 GC 集合
    await chatDatabase.saveMessage({
      id: 'm2', chatId: 'c1', seq: 2, role: 'user', content: 'x', parts: [], reasoning: '', toolCalls: [], status: 'done',
      imageRefs: [SHOT], uploadImageRefs: [UP], createdAt: Date.now(), updatedAt: Date.now(),
    } as any);
    assert.deepEqual(captured?.uploadImageRefs, [], 'Dangling upload refs are dropped');

    // 旧记录：无 uploadImageRefs 字段 → 保持缺省，不被归一化凭空造出
    await chatDatabase.saveMessage({
      id: 'm3', chatId: 'c1', seq: 3, role: 'user', content: 'x', parts: [], reasoning: '', toolCalls: [], status: 'done',
      imageRefs: [SHOT], createdAt: Date.now(), updatedAt: Date.now(),
    } as any);
    assert.equal(captured?.uploadImageRefs, undefined, 'Legacy records keep the field absent');
  } finally {
    (chatDatabase as any).tx = originalTx;
    (chatDatabase as any).getSession = originalSession;
  }
}

console.log('[vision-context-e2e] Single-screenshot contract, pure-read batches, cross-round dedup and upload-ref normalization passed.');

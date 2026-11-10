/**
 * 工具执行契约测试（引擎层 + 会话引擎层）
 *
 * 覆盖本轮重构中「容易被改坏」的几条契约：
 *   1. 失败结果**必须带可读原因**——中止/超时/跳过三类结算没有工具返回值，
 *      若协议消息里只剩 {"success":false}，模型既不知道为什么失败、也不知道
 *      下一步该做什么（错误即数据，必须完整交给模型）。
 *   2. 超时文案按**实际生效的分钟数**渲染，并给出「重新规划/调整参数」的指引。
 *   3. 强制终止钩子（kill）在中止与超时两条路径上都被调用——钩子才是工具
 *      「真正停下」的机会。
 *   4. 上界非法（NaN / 非正数 / 超大）时被钳制——setTimeout 把 NaN 当 0ms，
 *      会让「所有工具瞬间超时」；超大值会溢出 32 位延时变成立即超时。
 *   5. 外部中止信号（运行中止 / 插件能力撤销）能中断批次。
 *   6. 轮次被销毁不等于轮次已结算：仍有在途工具时，中断报告不得谎报「已停」。
 */

import assert from 'node:assert/strict';
import {
  ToolExecutionEngine,
  TOOL_INTERRUPTED_BY_USER,
  toolExecutionEngine,
  type ToolCallOutcome,
} from '../../entrypoints/sidepanel/core/tools/tool-execution-engine';
import { ConversationEngine } from '../../entrypoints/sidepanel/core/conversation/conversation-engine';
import type { ToolResult } from '../../common/tool-handler';

/**
 * 本文件全部使用**真实时钟**（超时用真实等待触发）。
 * 引擎是全局单例，计时适配是它的可变状态——若上游测试注入过虚拟时钟而未
 * 还原，本文件的超时会永远不触发（表现为挂起）。这里显式复位，保证与
 * 测试执行顺序无关。
 */
toolExecutionEngine.resetTimerAdapter();

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const call = (name: string, args: unknown = {}) => ({
  id: name,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

/** 永不结算的执行器：模拟挂死的工具 */
const neverSettles = async (): Promise<ToolResult> =>
  new Promise<ToolResult>(() => {
    /* 永不结算 */
  });

// ── 1 & 2. 会话引擎层：中断/超时的 tool 消息必须带可读原因 ──
{
  // 中断：执行中的工具被强制中断
  const engine = new ConversationEngine({
    executeTool: async () => neverSettles(),
    requiresApproval: () => false,
  } as any) as any;
  const runtime: any = {
    chatId: 'contract-interrupt',
    toolIds: ['slow_tool'],
    vision: null,
    limits: { maxDurationMs: 60_000, toolTimeoutMs: 60_000 },
  };
  const handle: any = {
    abortController: new AbortController(),
    dynamicToolIds: new Set(),
    record: { toolCalls: [], parts: [] },
    toolCallCount: 0,
  };
  const pending = engine.executeToolCalls(
    runtime,
    handle,
    [call('slow_tool')],
    {},
    () => {},
    Date.now() + 60_000,
  );
  await sleep(30);
  handle.abortController.abort();
  const outcome = await pending;
  assert.equal(outcome.committed, true, '轮次有效时结果必须写入模型上下文');
  assert.equal(outcome.messages.length, 1, '每个 tool_call 必须有配对的 tool 消息');
  const parsed = JSON.parse(outcome.messages[0].content as string);
  assert.equal(parsed.success, false);
  assert.equal(
    parsed.error,
    TOOL_INTERRUPTED_BY_USER,
    '中断的 tool 消息必须带可读原因（模型据此知道是用户停了，不是工具坏了）',
  );
  assert.equal(outcome.anyFailure, true);
}

{
  // 超时：单工具上界到期 → 判失败 + 分钟数文案
  // 上界取 100ms（文案按分钟取整、下限 1 分钟 → 渲染为「1min」，
  // 既能快速触发，又覆盖了「不足 1 分钟按 1 分钟呈现」的取整规则）
  const engine = new ConversationEngine({
    executeTool: async () => neverSettles(),
    requiresApproval: () => false,
  } as any) as any;
  const runtime: any = {
    chatId: 'contract-timeout',
    toolIds: ['slow_tool'],
    vision: null,
    limits: { maxDurationMs: 60_000, toolTimeoutMs: 100 },
  };
  const handle: any = {
    abortController: new AbortController(),
    dynamicToolIds: new Set(),
    record: { toolCalls: [], parts: [] },
    toolCallCount: 0,
  };
  const outcome = await engine.executeToolCalls(
    runtime,
    handle,
    [call('slow_tool')],
    {},
    () => {},
    Date.now() + 60_000,
  );
  const parsed = JSON.parse(outcome.messages[0].content as string);
  assert.equal(parsed.success, false, '超时判定为失败');
  assert.match(
    parsed.error ?? '',
    /超过 1min 仍然未响应，请重新规划或调整工具参数重新调用/,
    '超时文案必须含分钟数与「重新规划/调整参数」的指引',
  );
}

// ── 3. 强制终止钩子：中止与超时两条路径都要调用 ──
{
  for (const mode of ['interrupt', 'timeout'] as const) {
    const exec = new ToolExecutionEngine();
    const chatId = `kill-${mode}`;
    const roundId = exec.beginRound(chatId);
    const killed: string[] = [];
    const batch = exec.runBatch({
      chatId,
      roundId,
      calls: [{ callId: 'c1', toolName: 'slow' }],
      timeoutMs: mode === 'timeout' ? 30 : 60_000,
      execute: async () => neverSettles(),
      kill: call => {
        killed.push(call.toolName);
      },
    });
    await sleep(20);
    if (mode === 'interrupt') await exec.interrupt(chatId);
    const result = await batch;
    const expected = mode === 'interrupt' ? 'interrupted' : 'timeout';
    assert.equal(result.outcomes[0].reason, expected, `结算原因应为 ${expected}`);
    assert.deepEqual(killed, ['slow'], `${mode} 路径必须调用强制终止钩子`);
    exec.closeRound(chatId, roundId);
  }
}

// ── 4. 上界钳制：非法值不得变成「立即超时」 ──
{
  const exec = new ToolExecutionEngine();
  const chatId = 'clamp-chat';
  const roundId = exec.beginRound(chatId);
  const batch = await exec.runBatch({
    chatId,
    roundId,
    calls: [{ callId: 'c1', toolName: 'quick' }],
    // NaN：setTimeout 会把它当成 0ms → 立刻超时。引擎必须兜底而不是照单全收
    timeoutMs: Number.NaN,
    execute: async () => {
      await sleep(5);
      return { success: true };
    },
  });
  assert.equal(batch.outcomes[0].status, 'success', '非法上界必须回落到兜底值，而不是瞬间超时');
  assert.equal(batch.outcomes[0].reason, 'completed');
  exec.closeRound(chatId, roundId);
}

{
  const exec = new ToolExecutionEngine();
  const chatId = 'clamp-huge-chat';
  const roundId = exec.beginRound(chatId);
  const batch = await exec.runBatch({
    chatId,
    roundId,
    calls: [{ callId: 'c1', toolName: 'quick' }],
    // 超过 32 位延时上限：setTimeout 会溢出成 0ms → 立即超时
    timeoutMs: 40 * 24 * 60 * 60_000,
    execute: async () => {
      await sleep(5);
      return { success: true };
    },
  });
  assert.equal(batch.outcomes[0].status, 'success', '超大上界必须被钳制，不能溢出成立即超时');
  exec.closeRound(chatId, roundId);
}

// ── 5. 外部中止信号能中断批次 ──
{
  const exec = new ToolExecutionEngine();
  const chatId = 'external-signal-chat';
  const roundId = exec.beginRound(chatId);
  const controller = new AbortController();
  const batch = exec.runBatch({
    chatId,
    roundId,
    calls: [{ callId: 'c1', toolName: 'slow' }],
    timeoutMs: 60_000,
    signal: controller.signal,
    execute: async () => neverSettles(),
  });
  await sleep(20);
  controller.abort();
  const result = await batch;
  assert.equal(result.outcomes[0].reason, 'interrupted', '外部中止信号必须中断批次');
  assert.equal(result.outcomes[0].error, TOOL_INTERRUPTED_BY_USER);
  exec.closeRound(chatId, roundId);
}

// ── 6. 轮次闸门：旧轮次的迟到结果不得写进新一轮 ──
{
  const exec = new ToolExecutionEngine();
  const chatId = 'destroy-round-chat';
  const staleRound = exec.beginRound(chatId);
  const staleBatch = exec.runBatch({
    chatId,
    roundId: staleRound,
    calls: [{ callId: 'c1', toolName: 'slow' }],
    timeoutMs: 60_000,
    execute: async () => neverSettles(),
  });
  await sleep(20);
  // 防御性替换：开新轮次会销毁旧轮次（旧轮次的结果此后一律不得写入上下文）
  const newRound = exec.beginRound(chatId);
  assert.notEqual(newRound, staleRound);
  assert.equal(exec.isRoundActive(chatId, staleRound), false, '旧轮次必须立即失效');
  await exec.interrupt(chatId);
  const stale = await staleBatch;
  assert.equal(
    stale.outcomes[0].roundId,
    staleRound,
    '旧结果仍归属旧轮次（调用方据此拒绝写入新一轮上下文）',
  );
  assert.equal(exec.isRoundActive(chatId, newRound), true, '新轮次有效');
  exec.closeRound(chatId, newRound);
}

// ── 7. 引擎产出的结果形状自洽（reason 与 status 不得矛盾） ──
{
  const exec = new ToolExecutionEngine();
  const chatId = 'shape-chat';
  const roundId = exec.beginRound(chatId);
  const batch = await exec.runBatch({
    chatId,
    roundId,
    calls: [{ callId: 'c1', toolName: 'weird' }],
    timeoutMs: 1000,
    // 缺陷实现：返回非 ToolResult
    execute: async () => undefined as unknown as ToolResult,
  });
  const outcome: ToolCallOutcome = batch.outcomes[0];
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.reason, 'failed');
  assert.match(outcome.error ?? '', /非 ToolResult 形态/);
  assert.ok(outcome.error, '失败结果必须带可读原因');
  exec.closeRound(chatId, roundId);
}

// ── 8. 协议形态完整性：多调用批次 + 中间一个挂死 ──
{
  // 三次调用：第一个成功、第二个挂死、第三个排队未开始。中断后：
  //   - 协议消息恰好 3 条，顺序与 tool_calls 一致（协议配对的基础）；
  //   - 每条都是完整的 tool 消息（role / tool_call_id / name / content 齐备）；
  //   - 挂死的与未开始的都以「中断」收尾且带可读原因。
  const engine = new ConversationEngine({
    executeTool: async (name: string) =>
      name === 'hangs' ? neverSettles() : { success: true, data: { name } },
    requiresApproval: () => false,
  } as any) as any;
  const runtime: any = {
    chatId: 'contract-shape',
    toolIds: ['ok_tool', 'hangs', 'later_tool'],
    vision: null,
    limits: { maxDurationMs: 60_000, toolTimeoutMs: 60_000 },
  };
  const handle: any = {
    abortController: new AbortController(),
    dynamicToolIds: new Set(),
    record: { toolCalls: [], parts: [] },
    toolCallCount: 0,
  };
  const toolCalls = [call('ok_tool'), call('hangs'), call('later_tool')];
  const pending = engine.executeToolCalls(
    runtime,
    handle,
    toolCalls,
    {},
    () => {},
    Date.now() + 60_000,
  );
  await sleep(40);
  handle.abortController.abort();
  const outcome = await pending;
  assert.equal(outcome.messages.length, 3, '每个 tool_call 必须恰好有一条配对的 tool 消息');
  for (let i = 0; i < toolCalls.length; i++) {
    const message = outcome.messages[i];
    assert.equal(message.role, 'tool', '角色必须是 tool');
    assert.equal(message.tool_call_id, toolCalls[i].id, 'tool_call_id 必须与对应调用一致');
    assert.equal(message.name, toolCalls[i].function.name, '工具名必须与对应调用一致');
    assert.equal(typeof message.content, 'string', 'content 必须是字符串（官方协议的形态）');
  }
  assert.equal(
    JSON.parse(outcome.messages[0].content as string).success,
    true,
    '中断前已完成的调用保留成功结论',
  );
  for (const index of [1, 2]) {
    const parsed = JSON.parse(outcome.messages[index].content as string);
    assert.equal(parsed.success, false, `第 ${index + 1} 次调用应判为失败`);
    assert.equal(
      parsed.error,
      TOOL_INTERRUPTED_BY_USER,
      `第 ${index + 1} 次调用必须带可读的中断原因`,
    );
  }
}

// ── 9. 轮次闸门（端到端）：失效轮次的结果不得写入模型上下文 ──
{
  const engine = new ConversationEngine({
    executeTool: async () => neverSettles(),
    requiresApproval: () => false,
  } as any) as any;
  const runtime: any = {
    chatId: 'contract-stale',
    toolIds: ['slow_tool'],
    vision: null,
    limits: { maxDurationMs: 60_000, toolTimeoutMs: 60_000 },
  };
  const handle: any = {
    abortController: new AbortController(),
    dynamicToolIds: new Set(),
    record: { toolCalls: [], parts: [] },
    toolCallCount: 0,
  };
  const pending = engine.executeToolCalls(
    runtime,
    handle,
    [call('slow_tool')],
    {},
    () => {},
    Date.now() + 60_000,
  );
  await sleep(40);
  // 模拟跨轮替换：外部销毁当前轮次（下一轮的工具结果绝不能污染本轮上下文）
  const active = toolExecutionEngine.getActiveRoundId(runtime.chatId);
  assert.ok(active, '工具批次期间应存在进行中的轮次');
  toolExecutionEngine.closeRound(runtime.chatId, active!);
  const outcome = await pending;
  assert.equal(outcome.committed, false, '轮次失效时结果不得写入模型上下文');
  assert.equal(outcome.messages.length, 0, '失效轮次不产出任何协议消息（由占位响应维持配对）');
  // 但结算必须照常发生：工具卡片停在 pending 会让用户以为还在跑。
  // 注：卡片的登记发生在流式 onToolCall（引擎主循环），本用例直接调用
  // executeToolCalls 跳过了该阶段，因此这里断言的是「结算动作已发生」——
  // 即便没有卡片可结算，也不应抛错、也不应产出协议消息。
  assert.equal(
    outcome.anyFailure,
    true,
    '轮次失效时批次仍按失败结算（供上层呈现）',
  );
}

// ── 10. runSolo 的隔离性：内部调用不被模型批次的中止波及 ──
{
  const exec = new ToolExecutionEngine();
  const chatId = 'solo-isolation-chat';
  const modelRound = exec.beginRound(chatId);

  // 模型批次：一次挂死的调用（稍后被中断）
  const modelBatch = exec.runBatch({
    chatId,
    roundId: modelRound,
    calls: [{ callId: 'model-call', toolName: 'hangs' }],
    timeoutMs: 60_000,
    execute: async () => neverSettles(),
  });
  await sleep(20);

  // 内部调用（模拟截图）：必须在同一队列里排队，但不能与模型批次共享轮次，
  // 也不能被模型批次的中止连带掐掉
  let soloOutcome: ToolCallOutcome | undefined;
  const solo = exec
    .runSolo({
      chatId,
      call: { callId: 'solo-call', toolName: 'capture' },
      timeoutMs: 5000,
      execute: async () => ({ success: true, data: { text: 'captured' } }),
    })
    .then(outcome => {
      soloOutcome = outcome;
      return outcome;
    });

  // 中断模型批次
  await exec.interrupt(chatId);
  const modelResult = await modelBatch;
  assert.equal(modelResult.outcomes[0].reason, 'interrupted', '模型批次被中断');

  // 内部调用最终仍然完成（队列串行把它排在挂死调用之后）
  const settledSolo = await solo;
  assert.equal(settledSolo.status, 'success', '内部调用不得被模型批次的中止波及');
  assert.equal(soloOutcome?.status, 'success');
  assert.equal(modelResult.outcomes[0].reason, 'interrupted');
}
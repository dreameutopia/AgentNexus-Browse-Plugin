/**
 * 工具执行引擎测试（core/tools/tool-execution-engine）
 *
 * 覆盖引擎的六条契约：
 *   1. 强制串行 —— 任一时刻只有一个工具在执行（全局 FIFO 队列）；
 *   2. 强制中断 —— 轮次中断立即结算执行中的调用，未开始的调用就地跳过，
 *      并调用工具自带的 kill 钩子；interrupt() 只在全部结算完毕后 resolve；
 *   3. 有界执行 —— 超时判失败，文案按实际生效的分钟数渲染；
 *   4. 错误不外逸 —— 工具抛出的不可控错误、非 ToolResult 形态返回值一律
 *      封装为失败结果，绝不中断批次；
 *   5. 轮次完整性 —— 轮次 id 按 chatId 缓存，批次/中断/异常路径都会销毁；
 *      失效轮次的 runBatch 结果不得写入上下文（outcomes 全部为跳过）；
 *   6. 配对完整性 —— outcomes 与 calls 一一对应且顺序一致（协议配对基础）。
 *
 * 引擎的定时器一律走真实时钟（短超时）：串行顺序由执行器内的 promise 协同
 * 控制，不依赖时间竞态，因此测试无需虚拟时钟，也不会因机器快慢而漂移。
 */

import assert from 'node:assert/strict';
import {
  ToolExecutionEngine,
  TOOL_INTERRUPTED_BY_USER,
  describeToolFailure,
  type ToolBatchOptions,
} from '../../entrypoints/sidepanel/core/tools/tool-execution-engine';
import type { ToolResult } from '../../common/tool-handler';

/** 把一批执行中的 promise 变成可控协作者（按序放行、可断言并发度） */
function createExecutorController() {
  let active = 0;
  let maxActive = 0;
  const gates: Array<{ name: string; resolve: () => void }> = [];
  const started: string[] = [];
  const execute = async (call: { toolName: string }, _ctx: unknown): Promise<ToolResult> => {
    active++;
    maxActive = Math.max(maxActive, active);
    started.push(call.toolName);
    await new Promise<void>(resolve => gates.push({ name: call.toolName, resolve }));
    active--;
    return { success: true, data: { name: call.toolName } };
  };
  return {
    execute,
    started,
    get maxActive() {
      return maxActive;
    },
    get pending() {
      return gates.length;
    },
    releaseNext() {
      const gate = gates.shift();
      assert.ok(gate, '没有待放行的调用');
      gate.resolve();
    },
    releaseAll() {
      while (gates.length > 0) gates.shift()!.resolve();
    },
  };
}

const calls = (...names: string[]) =>
  names.map(name => ({ callId: `c_${name}`, toolName: name }));

type BatchOptions = ToolBatchOptions;

const baseBatch = (
  chatId: string,
  roundId: string,
  opts: Partial<BatchOptions> = {},
): ToolBatchOptions =>
  Object.assign(
    { timeoutMs: 1000, chatId, roundId },
    // 覆盖项必须是完整的 ToolBatchOptions（不能用 Partial：Partial 会把未传
    // 的必填字段显式置 undefined，spread 后类型退化为「可选」而无法赋值）
    opts as ToolBatchOptions,
  );

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 等待队列真正排空（引擎排空是异步的，用「连续两次观察都无变化」作为收敛判据） */
async function waitIdle(engine: ToolExecutionEngine, isIdle: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !isIdle(); i++) await sleep(2);
}

// ── 1. 强制串行 ──
{
  const engine = new ToolExecutionEngine();
  const roundId = engine.beginRound('serial-chat');
  const controller = createExecutorController();
  const batch = engine.runBatch(
    baseBatch('serial-chat', roundId, {
      calls: calls('a', 'b', 'c'),
      execute: controller.execute,
    }),
  );
  // 第一个调用已启动，后两个必须排队（串行）
  await sleep(20);
  assert.deepEqual(controller.started, ['a'], '同一时刻只应有一个工具在执行');
  controller.releaseNext();
  await sleep(20);
  assert.deepEqual(controller.started, ['a', 'b'], '前一个完全结算后才启动下一个');
  controller.releaseNext();
  // 串行放行：c 只有在 b 结算后才会入队，因此必须等它真正启动再放行
  while (controller.started.length < 3) await sleep(2);
  controller.releaseNext();
  const result = await batch;
  assert.equal(result.outcomes.length, 3, '每个调用都有结果');
  assert.ok(result.outcomes.every(o => o.status === 'success'));
  assert.equal(controller.maxActive, 1, '并发度必须为 1');
  engine.closeRound('serial-chat', roundId);
}

// ── 2. 强制中断（执行中 + 未开始 + kill 钩子 + 批量） ──
{
  const engine = new ToolExecutionEngine();
  const chatId = 'interrupt-chat';
  const roundId = engine.beginRound(chatId);
  const controller = createExecutorController();
  const killed: string[] = [];
  const batch = engine.runBatch(
    baseBatch(chatId, roundId, {
      calls: calls('a', 'b', 'c'),
      execute: controller.execute,
      kill: call => {
        killed.push(call.toolName);
      },
    }),
  );
  await sleep(20);
  assert.deepEqual(controller.started, ['a'], '中断前只有第一个调用在执行');
  // 串行放行：第一个调用真正结算后，队列才会推进到下一个调用。
  // 中断的时机因此落在「b 执行中、c 仍在队列」——这正是批次中断要覆盖的
  // 两种形态：执行中的调用被强制中断，未开始的调用被就地跳过。
  controller.releaseNext();
  while (controller.started.length < 2) await sleep(2);
  assert.deepEqual(controller.started, ['a', 'b'], '串行推进到第二个调用');

  // 中断的**同步**保证：执行中的调用立即结算为「中断」，队列中尚未开始的
  // 调用就地跳过——整个批次的结算是同步完成的，报告不等待工具自身耗时。
  // 这正是「强制中断」的含义：停止反馈不受工具迟钝影响。
  const result = await engine.interrupt(chatId);
  assert.equal(result.interrupted, true);
  assert.equal(result.roundId, roundId);
  assert.equal(result.settledCalls, 3, '中断报告应覆盖本批全部调用');

  const settled = await batch;
  assert.equal(settled.interrupted, true);
  assert.deepEqual(
    settled.outcomes.map(o => o.reason),
    ['completed', 'interrupted', 'interrupted'],
    '中断前已完成的调用保留成功结论；执行中与未开始的调用都以中断收尾',
  );
  assert.deepEqual(
    settled.outcomes.map(o => o.error),
    [undefined, TOOL_INTERRUPTED_BY_USER, TOOL_INTERRUPTED_BY_USER],
    '中断文案统一为「用户主动中断会话导致工具中断运行」',
  );
  assert.equal(settled.anySuccess, true, '已完成的那次调用仍算成功');
  assert.equal(settled.anyFailure, true);
  assert.ok(killed.includes('b'), '强制终止钩子应作用于执行中的调用');
  assert.equal(controller.maxActive, 1, '中止不得引入并发');
  engine.closeRound(chatId, roundId);
}

// ── 3. 单工具超时（有界执行 + 文案） ──
{
  const engine = new ToolExecutionEngine();
  const chatId = 'timeout-chat';
  const roundId = engine.beginRound(chatId);
  const neverSettles = async () =>
    new Promise<ToolResult>(() => {
      /* 永不结算：模拟挂死的工具 */
    });
  const result = await engine.runBatch(
    baseBatch(chatId, roundId, {
      calls: calls('stuck'),
      timeoutMs: 30,
      execute: neverSettles,
    }),
  );
  const outcome = result.outcomes[0];
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.reason, 'timeout');
  assert.match(
    outcome.error ?? '',
    /^工具 stuck 超过 1min 仍然未响应，请重新规划或调整工具参数重新调用$/,
    '超时文案必须含分钟数与「重新规划/调整参数」指引',
  );
  assert.ok(outcome.executionTimeMs >= 30, '应记录真实执行耗时');
  engine.closeRound(chatId, roundId);
}

// ── 3b. 按调用解析超时（timeoutFor 解析失败回落统一上界） ──
{
  const engine = new ToolExecutionEngine();
  const chatId = 'timeout-resolve-chat';
  const roundId = engine.beginRound(chatId);
  let resolved: number | undefined;
  const batch = await engine.runBatch(
    baseBatch(chatId, roundId, {
      calls: calls('fast'),
      timeoutMs: 30,
      timeoutFor: () => {
        throw new Error('解析异常');
      },
      execute: async () => {
        resolved = Date.now();
        await sleep(5);
        return { success: true };
      },
    }),
  );
  assert.equal(resolved !== undefined, true, '超时解析异常不得阻止执行');
  assert.equal(batch.outcomes[0].status, 'success');
  engine.closeRound(chatId, roundId);
  // timeoutFor 返回非法值时同样回落统一上界
  const roundId2 = engine.beginRound(chatId);
  const second = await engine.runBatch(
    baseBatch(chatId, roundId2, {
      calls: calls('fast2'),
      timeoutMs: 30,
      timeoutFor: () => Number.NaN,
      execute: async () => ({ success: true }),
    }),
  );
  assert.equal(second.outcomes[0].status, 'success');
  engine.closeRound(chatId, roundId2);
}

// ── 4. 错误不外逸（抛出 / 非 ToolResult 形态 / 形态异常） ──
{
  const engine = new ToolExecutionEngine();
  const chatId = 'error-chat';
  const roundId = engine.beginRound(chatId);
  const result = await engine.runBatch(
    baseBatch(chatId, roundId, {
      calls: calls('throws', 'garbage', 'never'),
      timeoutMs: 200,
      execute: async call => {
        if (call.toolName === 'throws') throw new Error('内部炸了');
        if (call.toolName === 'garbage') return undefined as unknown as ToolResult;
        throw '字符串错误';
      },
    }),
  );
  assert.equal(result.outcomes.length, 3, '工具失败不得让批次少结算任何一个调用');
  assert.deepEqual(
    result.outcomes.map(o => o.reason),
    ['failed', 'failed', 'failed'],
  );
  assert.match(result.outcomes[0].error ?? '', /内部炸了/);
  assert.match(result.outcomes[1].error ?? '', /非 ToolResult 形态/);
  assert.match(result.outcomes[2].error ?? '', /字符串错误/);
  assert.equal(result.anySuccess, false);
  assert.equal(result.anyFailure, true);
  engine.closeRound(chatId, roundId);
}

// ── 4b. 单个工具失败不中断批次（后续调用照常执行） ──
{
  const engine = new ToolExecutionEngine();
  const chatId = 'resilience-chat';
  const roundId = engine.beginRound(chatId);
  const result = await engine.runBatch(
    baseBatch(chatId, roundId, {
      calls: calls('a', 'b', 'c'),
      execute: async call => {
        if (call.toolName === 'b') throw new Error('中途失败');
        return { success: true, data: { name: call.toolName } };
      },
    }),
  );
  assert.deepEqual(
    result.outcomes.map(o => o.status),
    ['success', 'error', 'success'],
    '单个工具的失败不得阻断批次内其余调用',
  );
  engine.closeRound(chatId, roundId);
}

// ── 5. 轮次完整性（缓存 + 销毁 + 失效轮次不得写入上下文） ──
{
  const engine = new ToolExecutionEngine();
  const chatId = 'round-chat';
  const roundId = engine.beginRound(chatId);
  assert.equal(engine.isRoundActive(chatId, roundId), true, '新轮次应有效');
  assert.equal(engine.getActiveRoundId(chatId), roundId);
  assert.notEqual(engine.beginRound('other-chat'), roundId, '轮次 id 必须区分会话');

  // 销毁后轮次失效
  engine.closeRound(chatId, roundId);
  assert.equal(engine.isRoundActive(chatId, roundId), false, '销毁后轮次必须失效');
  assert.equal(engine.getActiveRoundId(chatId), null);
  engine.closeRound(chatId, roundId); // 幂等
  assert.equal(engine.isRoundActive(chatId, roundId), false);

  // 失效轮次的批次：全部跳过，结果不得写入上下文（调用方以 committed=false 收敛）
  const stale = await engine.runBatch(
    baseBatch(chatId, roundId, {
      calls: calls('x', 'y'),
      execute: async () => ({ success: true }),
    }),
  );
  assert.deepEqual(
    stale.outcomes.map(o => o.reason),
    ['skipped', 'skipped'],
    '失效轮次的调用一律跳过，绝不执行',
  );
  assert.equal(stale.interrupted, true);

  // 同一 chatId 重开轮次：旧轮次 id 不再被认作当前轮次
  const nextRound = engine.beginRound(chatId);
  assert.notEqual(nextRound, roundId);
  assert.equal(engine.isRoundActive(chatId, nextRound), true);
  engine.closeRound(chatId, nextRound);
}

// ── 6. 配对完整性（顺序与数量恒等） ──
{
  const engine = new ToolExecutionEngine();
  const chatId = 'pairing-chat';
  const roundId = engine.beginRound(chatId);
  const controller = createExecutorController();
  const batch = engine.runBatch(
    baseBatch(chatId, roundId, {
      calls: calls('a', 'b', 'c', 'd'),
      execute: controller.execute,
    }),
  );
  await sleep(20);
  const pending = engine.interrupt(chatId);
  controller.releaseAll();
  const result = await pending;
  const settled = await batch;
  assert.equal(result.interrupted, true);
  assert.equal(settled.outcomes.length, 4, '每个 tool_call 都必须有配对的结果');
  assert.deepEqual(
    settled.outcomes.map(o => o.callId),
    ['c_a', 'c_b', 'c_c', 'c_d'],
    '结果顺序必须与调用顺序一致（协议配对的基础）',
  );
  engine.closeRound(chatId, roundId);
}

// ── 7. 跨会话隔离（不同 chatId 的轮次互不影响） ──
{
  const engine = new ToolExecutionEngine();
  const roundA = engine.beginRound('chat-a');
  const roundB = engine.beginRound('chat-b');
  assert.notEqual(roundA, roundB);
  const batch = engine.runBatch(
    baseBatch('chat-a', roundA, {
      calls: calls('a'),
      execute: async () => ({ success: true }),
    }),
  );
  await batch;
  // 只中止 chat-b：必须 await（中断会等待该会话全部调用结算），
  // 未 await 的挂起 Promise 会阻塞测试进程退出
  await engine.interrupt('chat-b');
  assert.equal(engine.isRoundActive('chat-a', roundA), true, '跨会话中断不得波及其它会话');
  engine.closeRound('chat-a', roundA);
  engine.closeRound('chat-b', roundB);
}

// ── 8. describeToolFailure 单一事实源 ──
{
  assert.equal(describeToolFailure({ success: false, error: 'boom' }), 'boom');
  assert.equal(describeToolFailure({ success: false, message: 'msg' }), 'msg');
  assert.equal(
    describeToolFailure({ success: false, data: { error: 'data-err' } }),
    'data-err',
  );
  assert.equal(describeToolFailure({ success: true, data: {} }), undefined);
  const long = 'x'.repeat(2000);
  const described = describeToolFailure({ success: false, error: long })!;
  assert.equal(described.length, 601, '失败原因须按上限截断（600 + 省略号）');
}

// ── 9. 中断在无轮次时安全返回（不抛错、不误报） ──
{
  const engine = new ToolExecutionEngine();
  const report = await engine.interrupt('never-existed');
  assert.equal(report.interrupted, false);
  assert.equal(report.roundId, null);
  assert.equal(report.settledCalls, 0);
}

// 轮次登记与中止必须同步生效——这两条是「强制中断」的契约前提：
// 批次创建与中止之间没有 await 缝隙时，中止必须立刻摘除全部调用。
{
  const engine = new ToolExecutionEngine();
  const chatId = 'sync-interrupt-chat';
  const roundId = engine.beginRound(chatId);
  const batch = engine.runBatch(
    baseBatch(chatId, roundId, {
      calls: calls('a', 'b'),
      execute: async () => new Promise<never>(() => {}),
    }),
  );
  const report = await engine.interrupt(chatId);
  assert.equal(report.interrupted, true, '无 await 缝隙时中断必须生效');
  assert.equal(report.settledCalls, 2, '登记后立即中断：全部调用就地结算');
  const settled = await batch;
  assert.deepEqual(settled.outcomes.map(o => o.reason), ['interrupted', 'interrupted']);
  engine.closeRound(chatId, roundId);
}

console.log('[tool-execution-engine] 全部断言通过');

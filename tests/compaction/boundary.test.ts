/**
 * 运行时压缩边界规划回归（compaction-boundary 纯模块）
 *
 * 覆盖两类边界模式与全部切分不变量（见 compaction-boundary.ts 模块注释）：
 *   1. user-boundary 语义与历史版本逐字一致（多轮对话 / 视觉续拍）；
 *   2. group-boundary 回退覆盖「单用户消息长自治运行」（网站学习 / 盲试验证
 *      的真实形态：kickoff 用户消息位于下标 0，其后是数十个工具轮次）——
 *      旧实现在此结构性放弃压缩，越过阈值整段运行报错；
 *   3. 切分不变量：无损拼接、尾部非空且含最新组、尾部无悬空 tool_call
 *      （每个 tool 消息的属主 assistant 同在尾部）、头部非空、预算约束；
 *   4. 防御：空历史、单组、预算全容纳等不可压缩情形一律返回 null。
 */

import assert from "node:assert/strict";
import {
  planRuntimeCompaction,
  RUNTIME_COMPACTION_TAIL_RATIO,
  USER_BOUNDARY_MIN_HEAD_TOKENS,
} from "../../entrypoints/sidepanel/core/conversation/compaction-boundary";
import {
  buildAtomicGroups,
  resolveContextThreshold,
} from "../../entrypoints/sidepanel/utils/ai/context-window-guard";
import { estimateMessageTokensDetailed } from "../../entrypoints/sidepanel/utils/ai/token-estimate";
import {
  CONTEXT_THRESHOLD_DEFAULT,
  CONTEXT_THRESHOLD_MIN,
} from "../../entrypoints/sidepanel/utils/channels/channel-types";
import type { ChatMessage } from "../../entrypoints/sidepanel/utils/ai/ai-chat-api";

// ──── 消息构造（协议合法形态）────

function user(text: string): ChatMessage {
  return { role: "user", content: text };
}

/** 带单个工具调用的 assistant（id 即配对键） */
function assistantRound(callId: string, content = ""): ChatMessage {
  return {
    role: "assistant",
    content,
    tool_calls: [
      { id: callId, type: "function", function: { name: "browser_observe", arguments: "{}" } },
    ],
  };
}

function toolResult(callId: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: callId, name: "browser_observe", content };
}

/** 一个完整工具轮次（assistant + 配对结果）；content 按 4 字符/token 放大体积 */
function round(callId: string, textTokens: number): ChatMessage[] {
  const filler = "x".repeat(textTokens * 4);
  return [assistantRound(callId, filler.slice(0, textTokens * 2)), toolResult(callId, filler.slice(textTokens * 2))];
}

function messageCost(message: ChatMessage): number {
  const detail = estimateMessageTokensDetailed(message);
  return detail.textTokens + detail.imageTokens;
}

/** 断言切分不变量（除「头部非空」外全部适用；head 非空由调用方按需追加断言） */
function assertInvariants(history: ChatMessage[], plan: { head: ChatMessage[]; tail: ChatMessage[] }): void {
  // 无损切分：按原序拼接恒等于原历史
  assert.deepEqual([...plan.head, ...plan.tail], history, "head+tail must reconstruct the original history");
  // 尾部非空
  assert.ok(plan.tail.length > 0, "tail must keep at least the newest group");
  // 尾部无悬空 tool_call：每个 tool 消息的属主 assistant 必同在尾部
  const tailOwners = new Set(
    plan.tail
      .filter(message => message.role === "assistant")
      .flatMap(message => (message.tool_calls ?? []).map(call => call.id)),
  );
  for (const message of plan.tail) {
    if (message.role !== "tool") continue;
    assert.ok(
      tailOwners.has(message.tool_call_id!),
      `tool ${message.tool_call_id} retained in tail must have its owner assistant in tail`,
    );
  }
  // 尾部首条不是 tool 消息（组边界切分的直接体现）
  assert.notEqual(plan.tail[0].role, "tool", "tail must start at a group boundary, never a tool message");
}

// ──── 1. user-boundary：既有语义（头部须具备实质可压体量）────

{
  // 头部体量 ≥ USER_BOUNDARY_MIN_HEAD_TOKENS：user-boundary 语义保持不变
  const history = [
    user("第一轮任务"),
    ...round("c1", USER_BOUNDARY_MIN_HEAD_TOKENS + 100),
    user("第二轮任务"),
    ...round("c2", 10),
  ];
  const plan = planRuntimeCompaction(history, 1_000_000);
  assert.ok(plan, "multi-turn history must produce a plan");
  assert.equal(plan.mode, "user-boundary");
  assert.equal(plan.head.length, 3, "head = everything before the last user message");
  assert.equal(plan.head[0].role, "user");
  assert.equal(plan.tail[0].content, "第二轮任务", "tail starts at the last user message");
  assertInvariants(history, plan);
}

{
  // 视觉续拍形态：合成 user 消息（工具后重截图）位于末尾——语义与多轮一致
  const history = [
    user("开始网站学习任务"),
    ...round("c1", USER_BOUNDARY_MIN_HEAD_TOKENS + 100),
    user("vision_gui 调用成功，执行结果：执行成功\n继续完成任务"),
    ...round("c2", 10),
  ];
  const plan = planRuntimeCompaction(history, 1_000_000);
  assert.ok(plan);
  assert.equal(plan.mode, "user-boundary", "vision continuation messages anchor the same boundary");
  assert.equal(plan.tail[0].role, "user");
  assertInvariants(history, plan);
}

{
  // 头部含旧摘要 + 实质内容：仍是 user-boundary（摘要不阻碍既有语义）
  const history = [
    { role: "system", content: "<conversation-memory>先前摘要</conversation-memory>" } as ChatMessage,
    ...round("c0", USER_BOUNDARY_MIN_HEAD_TOKENS + 500),
    user("第二轮任务"),
    ...round("c2", 10),
  ];
  const plan = planRuntimeCompaction(history, 1_000_000);
  assert.ok(plan);
  assert.equal(plan.mode, "user-boundary", "substantial head keeps the legacy user boundary");
  assert.equal(plan.tail[0].content, "第二轮任务");
  assert.ok(plan.head[0].role === "system", "old summary stays inside the compacted head");
  assertInvariants(history, plan);
}

{
  // 头部无可压缩实质（只有零星短消息）：user-boundary 语义下压缩零收益，
  // 必须降级 group-boundary 重新规划（头部实质判定）
  const history = [
    user("旧问题"),
    ...round("c1", 10),
    user("第二轮任务"),
    ...round("c2", 4_000),
  ];
  const plan = planRuntimeCompaction(history, 10_000);
  assert.ok(plan, "insubstantial head must fall back to group planning instead of giving up");
  assert.equal(plan.mode, "group-boundary");
  assert.ok(
    plan.head.some(message => message === history[2]),
    "the last user message joins the compacted head when the head lacks substance",
  );
  assert.ok(plan.tail.some(message => message.role === "tool" && message.tool_call_id === "c2"), "newest round stays in tail");
  assertInvariants(history, plan);
}

{
  // 二次压缩空转形态（根因回归）：首次压缩后头部只剩一条旧摘要系统消息。
  // 旧实现持续以 user-boundary 反复压缩这条摘要（零收益，每轮一次压缩请求）；
  // 现在必须降级 group-boundary，把摘要与其后的轮次一起重新规划。
  const history = [
    { role: "system", content: "<conversation-memory>先前摘要</conversation-memory>" } as ChatMessage,
    user("第二轮任务"),
    ...round("c2", 4_000),
  ];
  const plan = planRuntimeCompaction(history, 10_000);
  assert.ok(plan, "summary-only head must fall back to group planning");
  assert.equal(plan.mode, "group-boundary");
  assert.equal(plan.head[0].role, "system", "old summary joins the re-planned head");
  assert.ok(plan.head.some(message => message === history[1]), "the kickoff user message is compacted into the head");
  assert.ok(plan.tail.some(message => message.role === "tool" && message.tool_call_id === "c2"), "newest round stays in tail");
  assertInvariants(history, plan);
}

// ──── 2. group-boundary：单用户消息长自治运行（学习/验证的真实形态）────
// 注意：阈值经 resolveContextThreshold 统一解析（非法回落默认、下限钳制
// CONTEXT_THRESHOLD_MIN=8192），预算场景一律用 ≥8192 的阈值构造。

{
  // kickoff 用户消息位于下标 0：旧实现在此返回 null（结构性放弃），必须回退。
  // 阈值 10000 → 尾部预算 3000：最新两组（100+2000）容纳、最旧组（4000）放不下
  const history = [
    user("开始网站学习任务"),
    ...round("c1", 4_000),
    ...round("c2", 2_000),
    ...round("c3", 100),
  ];
  const plan = planRuntimeCompaction(history, 10_000);
  assert.ok(plan, "single-user long run must fall back to group boundary instead of giving up");
  assert.equal(plan.mode, "group-boundary");
  assert.equal(plan.head[0].role, "user", "kickoff message is compacted into the summary head");
  assert.equal(plan.tail[0].role, "assistant", "tail starts at an atomic-group boundary");
  assert.ok(plan.tail.some(message => message.role === "tool" && message.tool_call_id === "c2"), "budgeted rounds stay in tail");
  assert.ok(plan.tail.some(message => message.role === "tool" && message.tool_call_id === "c3"), "newest round stays in tail");
  assert.ok(!plan.tail.some(message => message.role === "tool" && message.tool_call_id === "c1"), "over-budget oldest round moves to head");
  assertInvariants(history, plan);
  assert.ok(plan.head.length > 0, "head must be non-empty (compaction has work to do)");

  // 预算约束：尾部总量 ≤ 阈值×比例，或尾部恰为最新一组（最新组无条件保留）
  const tailTokens = plan.tail.reduce((total, message) => total + messageCost(message), 0);
  const budget = Math.floor(10_000 * RUNTIME_COMPACTION_TAIL_RATIO);
  assert.ok(
    tailTokens <= budget || plan.tail.every(message => message.role !== "tool" || message.tool_call_id === "c3"),
    "tail must respect the budget unless it is exactly the newest group",
  );
}

{
  // 极小阈值（钳制到下限 8192 → 预算 2457）：最新组即使独占超预算也必须保留
  // （当前回合证据不丢），次新组放不下进入头部
  const history = [user("任务"), ...round("c1", 3_000), ...round("c2", 3_000)];
  const plan = planRuntimeCompaction(history, 1);
  assert.ok(plan, "tiny threshold still yields a plan while head content exists");
  assert.equal(plan.mode, "group-boundary");
  assert.equal(plan.head.length, 3, "head = kickoff + first round");
  assert.deepEqual(
    plan.tail.map(message => message.role),
    ["assistant", "tool"],
    "tail = the newest group alone",
  );
  assertInvariants(history, plan);
}

{
  // 首次压缩后的二次压缩形态：摘要系统消息位于头部，其后全是工具轮次
  // （kickoff 用户消息已被首次压缩消化，历史中不再有用户消息）
  const history = [
    { role: "system", content: "<conversation-memory>先前摘要</conversation-memory>" } as ChatMessage,
    ...round("c1", 3_000),
    ...round("c2", 100),
  ];
  const plan = planRuntimeCompaction(history, 1_000);
  assert.ok(plan);
  assert.equal(plan.mode, "group-boundary", "no user message at all → group fallback (summary-of-summary cascade)");
  assert.equal(plan.head[0].role, "system", "old summary message joins the compacted head");
  assert.ok(!plan.tail.some(message => message.role === "system"));
  assertInvariants(history, plan);
}

{
  // 较大预算：尾部可容纳多个最新组（连续窗口，无时序空洞）
  const history = [user("任务"), ...round("c1", 3_000), ...round("c2", 80), ...round("c3", 80)];
  const plan = planRuntimeCompaction(history, 10_000); // 预算 3000：c2+c3（约 160）放下，c1（3000）放不下
  assert.ok(plan);
  assert.ok(
    plan.tail.some(message => message.role === "tool" && message.tool_call_id === "c2") &&
      plan.tail.some(message => message.role === "tool" && message.tool_call_id === "c3"),
    "contiguous newest window may span multiple groups",
  );
  assert.ok(!plan.tail.some(message => message.role === "tool" && message.tool_call_id === "c1"));
  assertInvariants(history, plan);
}

// ──── 3. 防御：不可压缩情形返回 null ────

assert.equal(planRuntimeCompaction([], 1_000), null, "empty history → null");
assert.equal(
  planRuntimeCompaction([user("只有一条")], 1_000),
  null,
  "single group (no head to compact) → null",
);
{
  // 全部组都装进尾部预算：无头部可压缩（触发 95% 线时不可能出现，防御兜底）
  const history = [user("任务"), ...round("c1", 10), ...round("c2", 10)];
  assert.equal(
    planRuntimeCompaction(history, 1_000_000_000),
    null,
    "everything fits the tail budget → nothing to compact",
  );
}
{
  // 非法阈值回落共享默认值而非抛错（与 ContextWindowGuard.resolveThreshold 同口径）；
  // 默认 256K 下的尾部预算约 78K：旧组放大到预算之外，规划依然成立
  const history = [user("任务"), ...round("c1", 300_000), ...round("c2", 100)];
  const plan = planRuntimeCompaction(history, Number.NaN);
  assert.ok(plan, "invalid threshold falls back to the shared default and still plans");
  assert.ok(
    plan.tail.some(message => message.role === "tool" && message.tool_call_id === "c2"),
    "newest group retained under the default threshold",
  );
  assertInvariants(history, plan);
}

// ──── 4. 多阈值扫描：不变量对任意切分恒成立 ────

{
  // 组体量放大到跨数量级（10K–60K token），扫描钳制下限、默认值与多个真实档位
  const history = [
    user("开始网站学习任务"),
    ...round("c1", 60_000),
    ...round("c2", 40_000),
    ...round("c3", 30_000),
    ...round("c4", 20_000),
    ...round("c5", 10_000),
  ];
  const thresholds = [1, 9_000, 16_384, 65_536, 262_144];
  let planned = 0;
  for (const threshold of thresholds) {
    const plan = planRuntimeCompaction(history, threshold);
    if (!plan) continue; // 预算全容纳 → null 合法
    planned += 1;
    assertInvariants(history, plan);
    assert.ok(plan.head.length > 0, `head non-empty at threshold ${threshold}`);
    // 尾部永远包含最新组
    assert.ok(
      plan.tail.some(message => message.role === "tool" && message.tool_call_id === "c5"),
      `newest group always retained at threshold ${threshold}`,
    );
    // 尾部预算约束（或恰为最新一组）
    const tailTokens = plan.tail.reduce((total, message) => total + messageCost(message), 0);
    const budget = Math.floor(resolveContextThreshold(threshold) * RUNTIME_COMPACTION_TAIL_RATIO);
    assert.ok(
      tailTokens <= budget || plan.tail.every(message => message.role !== "tool" || message.tool_call_id === "c5"),
      `tail budget respected at threshold ${threshold}`,
    );
  }
  assert.ok(planned >= thresholds.length - 1, "threshold sweep must exercise real plans, not only nulls");
}

// ──── 5. 共享单一事实源的直接契约：原子组构建与阈值解析 ────

{
  // 并行调用同组、孤儿 tool 自成一组、组间按下标升序
  const parallelAssistant: ChatMessage = {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "p1", type: "function", function: { name: "browser_observe", arguments: "{}" } },
      { id: "p2", type: "function", function: { name: "browser_interact", arguments: "{}" } },
    ],
  };
  const history: ChatMessage[] = [
    user("任务"),
    parallelAssistant,
    { role: "tool", tool_call_id: "p1", name: "browser_observe", content: "ok" },
    { role: "tool", tool_call_id: "p2", name: "browser_interact", content: "ok" },
    // 孤儿 tool（属主不在场，协议脏数据）：不并入任何组，自成一组保持原子性
    { role: "tool", tool_call_id: "ghost", name: "browser_observe", content: "?" },
    assistantRound("c9"),
    toolResult("c9", "ok"),
  ];
  assert.deepEqual(
    buildAtomicGroups(history),
    [[0], [1, 2, 3], [4], [5, 6]],
    "parallel results join their owner's group; an orphan tool forms its own group",
  );
}

{
  // 阈值解析：非法值回落共享默认、下限钳制、正常值直通
  assert.equal(resolveContextThreshold(undefined), CONTEXT_THRESHOLD_DEFAULT);
  assert.equal(resolveContextThreshold(Number.NaN), CONTEXT_THRESHOLD_DEFAULT);
  assert.equal(resolveContextThreshold(0), CONTEXT_THRESHOLD_DEFAULT);
  assert.equal(resolveContextThreshold(-5), CONTEXT_THRESHOLD_DEFAULT);
  assert.equal(resolveContextThreshold(CONTEXT_THRESHOLD_MIN - 1), CONTEXT_THRESHOLD_MIN, "below-min clamps up");
  assert.equal(resolveContextThreshold(100_000.9), 100_000, "fractional floors");
}

console.log("[compaction] Runtime compaction boundary planning (user/group modes, invariants, defenses) passed.");

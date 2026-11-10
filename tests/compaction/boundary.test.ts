/**
 * 运行时压缩切分规划回归（compaction-boundary 纯模块）
 *
 * 覆盖新策略的全部形态与不变量（见 compaction-boundary.ts 模块注释）：
 *   1. tool-round（工具轮次模式）：
 *      - 末轮 ≤ 阈值×15% → 末轮原样保留为尾部起点，其后续续拍消息一并保留；
 *      - 末轮 > 阈值×15% → 巨型末轮并入压缩，切分点落在末轮之后（尾部可空）；
 *      - 单轮批量工具调用（并行调用 + 多条结果）作为一轮整体保留；
 *   2. user-turn（纯对话模式，无工具轮）：以最后一条用户消息为界；
 *      该回合本身 > 15% 则整段压缩（尾部为空）；
 *   3. 首发保护（protectFromIndex）：切分点是下界——受保护消息恒在尾部；
 *   4. 切分不变量：无损拼接、尾部无悬空 tool_call、尾部首条不是 tool 消息；
 *   5. 防御：空历史 / 无可压头部 / 头部无实质体量 / 非法阈值一律安全收敛。
 */

import assert from "node:assert/strict";
import {
  planRuntimeCompaction,
  RUNTIME_LAST_ROUND_MAX_RATIO,
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

/** 助手纯文本回复（纯对话历史用） */
function assistantText(text: string): ChatMessage {
  return { role: "assistant", content: text };
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

/** 单轮批量工具调用：一条 assistant 携 N 个调用（结果各自成 tool 消息） */
function assistantParallel(callIds: string[], content = ""): ChatMessage {
  return {
    role: "assistant",
    content,
    tool_calls: callIds.map(id => ({
      id,
      type: "function" as const,
      function: { name: "browser_observe", arguments: "{}" },
    })),
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

/** 上下文压缩消息（assistant 角色，新契约）；legacy 形态为 system 角色 */
function compactionMessage(role: "assistant" | "system" = "assistant"): ChatMessage {
  return { role, content: "<conversation-memory>先前摘要</conversation-memory>" };
}

function messageCost(message: ChatMessage): number {
  const detail = estimateMessageTokensDetailed(message);
  return detail.textTokens + detail.imageTokens;
}

/** 断言切分不变量（head 非空由各用例按需追加） */
function assertInvariants(history: ChatMessage[], plan: { head: ChatMessage[]; tail: ChatMessage[] }): void {
  // 无损切分：按原序拼接恒等于原历史
  assert.deepEqual([...plan.head, ...plan.tail], history, "head+tail must reconstruct the original history");
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
  // 尾部首条不是 tool 消息（切分恒落在组边界 / 用户回合边界）
  if (plan.tail.length > 0) {
    assert.notEqual(plan.tail[0].role, "tool", "tail must start at a group boundary, never a tool message");
  }
}

/** 阈值下的末轮保留上限 */
const roundLimit = (threshold: number) => Math.floor(resolveContextThreshold(threshold) * RUNTIME_LAST_ROUND_MAX_RATIO);

// ════════ 1. tool-round：末轮 ≤ 15% → 原样保留 ════════
{
  const history = [
    user("第一轮任务"),
    ...round("c1", USER_BOUNDARY_MIN_HEAD_TOKENS + 100),
    ...round("c2", 100),
  ];
  const plan = planRuntimeCompaction(history, 10_000);
  assert.ok(plan, "工具轮次历史必须产出方案");
  assert.equal(plan.mode, "tool-round");
  assert.equal(plan.tail.length, 2, "尾部 = 末轮（assistant + 配对结果）");
  assert.equal((plan.tail[0] as { tool_calls?: { id: string }[] }).tool_calls?.[0].id, "c2");
  assert.ok(plan.head.some(message => message.role === "tool" && message.tool_call_id === "c1"), "更早的轮次进入头部");
  assert.ok(!plan.tail.some(message => message.role === "tool" && message.tool_call_id === "c1"));
  assertInvariants(history, plan);
}

{
  // 末轮之后的合成消息（视觉续拍 / 计划提醒）一并保留为尾部——它们承载
  // 最新现场状态（当前截图），体量小且不应被摘要化
  const history = [
    user("开始网站学习任务"),
    ...round("c1", USER_BOUNDARY_MIN_HEAD_TOKENS + 100),
    ...round("c2", 100),
    user("vision_gui 调用成功，执行结果：执行成功\n继续完成任务"),
  ];
  const plan = planRuntimeCompaction(history, 10_000);
  assert.ok(plan);
  assert.equal(plan.mode, "tool-round");
  assert.equal(plan.tail.length, 3, "尾部 = 末轮 + 其后续合成消息");
  assert.equal(plan.tail[plan.tail.length - 1].role, "user");
  assertInvariants(history, plan);
}

{
  // 单轮批量工具调用（一条 assistant 携 2 个调用 + 2 条结果）：作为一轮整体保留
  const history = [
    user("任务"),
    ...round("c0", USER_BOUNDARY_MIN_HEAD_TOKENS + 100),
    assistantParallel(["p1", "p2"]),
    toolResult("p1", "ok1"),
    toolResult("p2", "ok2"),
  ];
  const plan = planRuntimeCompaction(history, 10_000);
  assert.ok(plan);
  assert.equal(plan.tail.length, 3, "批量调用轮的 assistant + 两条结果整体保留");
  assert.deepEqual(
    plan.tail.map(message => message.role),
    ["assistant", "tool", "tool"],
  );
  assertInvariants(history, plan);
}

// ════════ 2. tool-round：末轮 > 15% → 并入压缩，尾部只留其后续 ════════
{
  const history = [
    user("任务"),
    ...round("c1", USER_BOUNDARY_MIN_HEAD_TOKENS + 100),
    ...round("c2", 3_000),
  ];
  const plan = planRuntimeCompaction(history, 10_000);
  assert.ok(plan);
  assert.equal(plan.mode, "tool-round");
  assert.ok(
    roundLimit(10_000) < 3_000,
    "测试前提：末轮确实超过 15% 保留上限",
  );
  assert.equal(plan.tail.length, 0, "末轮超线且其后无消息 → 尾部为空（整段压缩）");
  assert.equal(plan.head.length, history.length, "头部 = 全部历史");
  assertInvariants(history, plan);
}

{
  // 末轮超线、其后有合成消息：末轮进头部，其后消息保留为尾部
  const history = [
    user("任务"),
    ...round("c1", USER_BOUNDARY_MIN_HEAD_TOKENS + 100),
    ...round("c2", 3_000),
    user("续拍：当前页面已滚动到详情区"),
  ];
  const plan = planRuntimeCompaction(history, 10_000);
  assert.ok(plan);
  assert.equal(plan.tail.length, 1, "尾部 = 末轮之后的合成消息");
  assert.equal(plan.tail[0].role, "user");
  assert.ok(plan.head.some(message => message.role === "tool" && message.tool_call_id === "c2"), "超线末轮并入头部");
  assertInvariants(history, plan);
}

// ════════ 3. user-turn：纯对话历史以最后一条用户消息为界 ════════
{
  const history = [
    user("第一轮问题" + "详".repeat(2_600)),
    assistantText("第一轮回答" + "答".repeat(2_600)),
    user("第二轮问题"),
    assistantText("第二轮回答"),
  ];
  const plan = planRuntimeCompaction(history, 10_000);
  assert.ok(plan, "纯对话历史必须产出方案");
  assert.equal(plan.mode, "user-turn");
  assert.equal(plan.tail.length, 2, "尾部 = 最后一条用户消息起的完整回合");
  assert.equal(plan.tail[0].content, "第二轮问题");
  assert.equal(plan.head.length, 2, "头部 = 最后一条用户消息之前");
  assertInvariants(history, plan);
}

{
  // 纯对话且最后回合本身超 15% → 整段压缩（尾部为空）
  const history = [
    user("很长的第一轮提问" + "详".repeat(2_600)),
    assistantText("很长的第一轮回答" + "答".repeat(2_600)),
    user("很长的第二轮提问" + "详".repeat(3_000)),
    assistantText("很长的第二轮回答" + "答".repeat(3_000)),
  ];
  const plan = planRuntimeCompaction(history, 10_000);
  assert.ok(plan);
  assert.equal(plan.mode, "user-turn");
  assert.equal(plan.tail.length, 0, "最后回合超 15% → 整段压缩");
  assertInvariants(history, plan);
}

// ════════ 4. 首发保护：protectFromIndex 是切分点下界 ════════
{
  const history = [
    user("历史内容" + "详".repeat(2_600)),
    user("本轮最新请求"),
  ];
  // 无保护：纯对话模式以最后一条用户消息为界（头部 = 首条）
  const free = planRuntimeCompaction(history, 10_000);
  assert.ok(free);
  assert.equal(free.tail[0].content, "本轮最新请求");
  // 有保护：受保护下标是切分点**上界**——切分左移，受保护消息恒在尾部
  const protectedPlan = planRuntimeCompaction(history, 10_000, { protectFromIndex: 1 });
  assert.ok(protectedPlan);
  assert.equal(protectedPlan.tail[0].content, "本轮最新请求", "受保护消息恒在尾部");
  assert.equal(protectedPlan.head.length, 1);
  // 保护下标在天然切分点右侧时不动切分（切分点本就 ≤ 保护下标）
  const later = planRuntimeCompaction(history, 10_000, { protectFromIndex: 2 });
  assert.ok(later, "保护范围覆盖全部历史时仍可规划");
  assert.equal(later.tail.length, 1, "切分点本就早于保护下标 → 切分不变");
  assert.equal(later.tail[0].content, "本轮最新请求");
  assert.equal(later.head.length, 1);
}

// ════════ 4b. 首发保护与工具轮次并用：天然切分点在受保护消息之后时左移 ════════
{
  // 形态：历史 = [旧内容, 本轮用户消息, 合成激活轮(assistant+tool)]
  // 天然切分点 = 最后一轮（激活轮）起点 → 会把本轮用户消息压进头部；
  // 保护下标 = 本轮用户消息下标 → 切分左移，用户消息与激活轮都留在尾部
  const history = [
    user("历史内容" + "详".repeat(2_600)),
    user("本轮最新请求"),
    assistantRound("act1", "activation"),
    toolResult("act1", "ok"),
  ];
  const natural = planRuntimeCompaction(history, 10_000);
  assert.ok(natural);
  assert.ok(
    natural.head.some(message => message.content === "本轮最新请求"),
    "无保护时天然切分会把本轮用户消息压进头部（这正是要防的形态）",
  );
  const protectedPlan = planRuntimeCompaction(history, 10_000, { protectFromIndex: 1 });
  assert.ok(protectedPlan);
  assert.equal(protectedPlan.tail[0].content, "本轮最新请求", "保护后本轮用户消息回到尾部");
  assert.equal(protectedPlan.head.length, 1, "头部收缩为初始上下文");
  assert.equal(protectedPlan.tail.length, 3, "尾部 = 用户消息 + 激活轮");
  assertInvariants(history, protectedPlan);
}

// ════════ 5. 防御：不可压缩情形返回 null ════════
assert.equal(planRuntimeCompaction([], 1_000), null, "空历史 → null");
assert.equal(
  planRuntimeCompaction([user("只有一条")], 1_000),
  null,
  "单条消息（头部为空）→ null",
);
{
  // 头部只有压缩消息 → 实质体量为零（摘要再压零收益）→ null
  const history = [compactionMessage("assistant"), user("新一轮请求")];
  assert.equal(planRuntimeCompaction(history, 10_000), null, "头部无实质可压体量 → null");
}
{
  // legacy system 角色的压缩消息同样不计入实质体量
  const history = [compactionMessage("system"), user("新一轮请求")];
  assert.equal(planRuntimeCompaction(history, 10_000), null, "旧版 system 摘要不计入实质体量");
}
{
  // 非法阈值回落共享默认而非抛错（与 ContextWindowGuard.resolveThreshold 同口径）
  const history = [
    user("任务"),
    ...round("c1", 3_000),
    ...round("c2", 30_000),
  ];
  const plan = planRuntimeCompaction(history, Number.NaN);
  assert.ok(plan, "非法阈值回落共享默认后仍能规划");
  assert.ok(
    roundLimit(Number.NaN) >= 30_000,
    `测试前提：默认阈值下末轮未超 15%（${roundLimit(Number.NaN)}）`,
  );
  assert.equal(plan.tail.length, 2, "默认阈值下末轮原样保留");
  assertInvariants(history, plan);
}

// ════════ 6. 多阈值扫描：不变量对任意切分恒成立 ════════
{
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
    if (!plan) continue;
    planned += 1;
    assertInvariants(history, plan);
    assert.ok(plan.head.length > 0, `head non-empty at threshold ${threshold}`);
    // 末轮要么整体在尾部（≤15%），要么整体在头部（>15%）——绝不半配对
    const inTail = plan.tail.some(message => message.role === "tool" && message.tool_call_id === "c5");
    const inHead = plan.head.some(message => message.role === "tool" && message.tool_call_id === "c5");
    assert.notEqual(inTail, inHead, `末轮必须整体归属一侧（threshold ${threshold}）`);
  }
  assert.ok(planned >= thresholds.length - 1, "threshold sweep must exercise real plans, not only nulls");
}

// ════════ 7. 共享单一事实源的直接契约 ════════
{
  // 并行调用同组、孤儿 tool 自成一组、组间按下标升序
  const parallelAssistant = assistantParallel(["p1", "p2"]);
  const history: ChatMessage[] = [
    user("任务"),
    parallelAssistant,
    toolResult("p1", "ok"),
    toolResult("p2", "ok"),
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

console.log("[compaction] Runtime compaction planning (tool-round 15% rule, user-turn fallback, first-send protection, invariants, defenses) passed.");

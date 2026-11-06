/**
 * 压缩器（compactor）回归测试
 *
 * 覆盖（边界规划见 boundary.test.ts，引擎编排见 tests/conversation-runtime
 * 与 tests/tools/prompt-cache）：
 *   1. 提示词契约：固定 XML 分区 / 差分压缩引导 / 篇幅约束 / plan_tool 口径；
 *   2. 基本压缩：单请求透传、系统提示词恒为 COMPACTION_SYSTEM_PROMPT、
 *      序列化行进入负载、结果 token 计量；
 *   3. 结果清洗：剥 <think>、无 <summary> 自动补包（格式自愈）、空结果报错；
 *   4. 分段归并：超预算分段 + 归并请求、每段负载受预算约束、原文全量进入输入；
 *   5. 防御：空消息、预中止、单图超预算、分段次数上限（≤16）、适配器契约
 *      违背（finalMessage 缺失 → 可读空结果错误而非 TypeError）、非法阈值
 *      归一（NaN/0 回落共享默认，绝不静默绕过分段保护）；
 *   6. 摘要记忆消息：plan_tool 回读引导、覆盖范围、旧版摘要防御性补包、
 *      isCompactionSummaryMessage 判定。
 */

import assert from "node:assert/strict";
import {
  ContextCompactor,
  CompactionError,
  COMPACTION_SYSTEM_PROMPT,
  SUMMARY_MESSAGE_MARKER,
  isCompactionSummaryMessage,
} from "../../entrypoints/sidepanel/core/context/compactor";
import { estimateTextTokens, IMAGE_CONTEXT_TOKENS } from "../../entrypoints/sidepanel/utils/ai/token-estimate";
import type { ChatMessage } from "../../entrypoints/sidepanel/utils/ai/ai-chat-api";

// 与 tests/tools/prompt-cache 同源的 Node 宿主适配：压缩器引用图中的
// 图片库等模块在浏览器判定处需要 window 存在
(globalThis as any).window = globalThis;

/** 压缩请求记录 + 可编程的模型输出 */
function makeSendStream(output: string | (() => string), requests: { messages: ChatMessage[] }[] = []) {
  let call = 0;
  return async (messages: ChatMessage[]) => {
    requests.push({ messages: structuredClone(messages) });
    const content = typeof output === "function" ? output() : output;
    call += 1;
    return { finalMessage: { role: "assistant", content } };
  };
}

const model: any = { provider: "openai", model: "compaction-test" };
/** CJK ≈ 1 token/字：按 token 数直接造体量 */
const big = (tokens: number) => "中".repeat(tokens);
const WRAPPED = "<summary>\n<task>目标</task>\n<pending>无</pending>\n</summary>";

// ──── 1. 提示词契约 ────
{
  for (const section of ["<task>", "<constraints>", "<key-facts>", "<progress>", "<errors>", "<pending>"]) {
    assert.ok(COMPACTION_SYSTEM_PROMPT.includes(section), `压缩提示词必须包含固定分区 ${section}`);
  }
  assert.ok(COMPACTION_SYSTEM_PROMPT.includes("plan_tool"), "压缩提示词必须声明 plan_tool 状态不在对话记录内");
  assert.ok(COMPACTION_SYSTEM_PROMPT.includes("差分压缩"), "压缩提示词必须包含差分压缩力度引导");
  assert.ok(COMPACTION_SYSTEM_PROMPT.includes("4000 token"), "压缩提示词必须包含篇幅软约束");
}

// ──── 2. 基本压缩：单请求、系统提示词契约、序列化与计量 ────
{
  const requests: { messages: ChatMessage[] }[] = [];
  const compactor = new ContextCompactor({ sendStream: makeSendStream(WRAPPED, requests) } as any);
  const result = await compactor.compact({
    messages: [
      { role: "user", content: "任务 A：调研三个站点 https://example.com/a" },
      {
        role: "assistant", content: "",
        tool_calls: [{ id: "t1", type: "function", function: { name: "browser_observe", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "t1", name: "browser_observe", content: "观察结果" },
    ],
    model,
    threshold: 100_000,
  });
  assert.equal(result.summary, WRAPPED, "已包裹的摘要原样透传");
  assert.ok(result.originalTokens > 0 && result.summaryTokens > 0);
  assert.ok(!("droppedOldest" in result), "压缩结果不再携带已废弃的 droppedOldest 字段");
  assert.equal(requests.length, 1, "预算内历史只需一次压缩请求");
  assert.equal(requests[0].messages[0].role, "system");
  assert.equal(requests[0].messages[0].content, COMPACTION_SYSTEM_PROMPT, "系统提示词必须是导出的压缩契约");
  const payload = requests[0].messages[1].content as string;
  assert.ok(payload.includes("任务 A"), "用户消息进入压缩负载");
  assert.ok(payload.includes("[0] USER") && payload.includes("[调用工具 browser_observe"), "消息按带下标的序列化行进入负载");
  assert.ok(payload.includes("工具 browser_observe 的结果"), "工具结果带工具名前缀进入负载");
}

// ──── 3. 结果清洗：剥 think + 自愈补包；空结果报错 ────
{
  const compactor = new ContextCompactor({ sendStream: makeSendStream("<think>推理过程</think>\n<task>裸分区内容</task>") } as any);
  const result = await compactor.compact({ messages: [{ role: "user", content: "x" }], model, threshold: 100_000 });
  assert.ok(result.summary.startsWith("<summary>"), "无包裹输出自动补包");
  assert.ok(!result.summary.includes("<think>"), "推理段必须剥离");
  assert.ok(result.summary.includes("裸分区内容"));
}
{
  await assert.rejects(
    () => new ContextCompactor({ sendStream: makeSendStream("   ") } as any)
      .compact({ messages: [{ role: "user", content: "x" }], model, threshold: 100_000 }),
    /压缩结果为空/,
  );
}

// ──── 4. 分段归并：超预算分段、每段受预算约束、原文全量进入输入 ────
{
  const requests: { messages: ChatMessage[] }[] = [];
  const compactor = new ContextCompactor({ sendStream: makeSendStream(() => WRAPPED, requests) } as any);
  const promptTokens = estimateTextTokens(COMPACTION_SYSTEM_PROMPT);
  // 预算 ≈ 7000：单条 4000 token 消息放得下、两条放不下 → 每条各自成段
  const threshold = Math.ceil((promptTokens + 512 + 7_000) / 0.9);
  const messages = Array.from({ length: 3 }, () => ({ role: "user", content: big(4_000) }) as ChatMessage);
  const result = await compactor.compact({ messages, model, threshold });

  assert.ok(requests.length >= 3, `分段 + 归并应发起多次请求，实际 ${requests.length} 次`);
  const payloadBudget = Math.floor(threshold * 0.9) - promptTokens - 512;
  for (const request of requests) {
    assert.equal(request.messages[0].content, COMPACTION_SYSTEM_PROMPT, "每次请求都带压缩契约");
    const userText = typeof request.messages[1].content === "string"
      ? request.messages[1].content
      : (request.messages[1].content as any[]).map(part => part.text ?? "").join("");
    assert.ok(
      estimateTextTokens(userText) <= payloadBudget + 512,
      "分段负载必须受预算约束（含 512 传输余量）",
    );
  }
  assert.ok(result.summary.startsWith("<summary>"), "归并结果仍是自愈包裹形态");
  assert.ok(result.originalTokens >= 12_000, "originalTokens 按原文全量计量（3 × 4000）");
}

// ──── 5. 防御：空消息 / 预中止 / 单图超预算 / 分段次数上限 ────
{
  await assert.rejects(
    () => new ContextCompactor({ sendStream: makeSendStream(WRAPPED) } as any)
      .compact({ messages: [], model, threshold: 100_000 }),
    (error: unknown) => {
      assert.ok(error instanceof CompactionError, '防御错误必须是 CompactionError（调用方按其类型降级冷却）');
      return /无可压缩的历史消息/.test((error as Error).message);
    },
  );
}
{
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => new ContextCompactor({ sendStream: makeSendStream(WRAPPED) } as any)
      .compact({ messages: [{ role: "user", content: "x" }], model, threshold: 100_000, signal: controller.signal }),
    /Compaction aborted/,
  );
}
{
  // 预算 ∈ [1024, IMAGE_CONTEXT_TOKENS+128)：文本放得下、单图放不下。
  // 全部由常量推导（含前提自检）：未来下调图片成本时本用例自动跟随校准。
  const imageCost = IMAGE_CONTEXT_TOKENS + 128;
  assert.ok(
    imageCost > 1024 + 128,
    `测试前提要求单图成本明显高于最小预算线（当前 ${imageCost}）；若常量已下调至该区间以下，请改用其它方式构造`,
  );
  const promptTokens = estimateTextTokens(COMPACTION_SYSTEM_PROMPT);
  const budgetTarget = Math.floor((1024 + imageCost) / 2);
  const threshold = Math.ceil((promptTokens + 512 + budgetTarget) / 0.9);
  const imageMessage: ChatMessage = {
    role: "user",
    content: [
      { type: "text", text: "视觉证据" },
      { type: "image_url", image_url: { url: "data:image/png;base64,YQ==", detail: "high" } },
    ],
  };
  await assert.rejects(
    () => new ContextCompactor({ sendStream: makeSendStream(WRAPPED) } as any)
      .compact({ messages: [imageMessage], model, threshold }),
    /单张历史图片（约 \d+ token）超出压缩预算（\d+ token）/,
  );
}
{
  // 适配器契约违背：finalMessage 缺失且流式累积为空 → 可读的空结果错误，
  // 不得以解构 TypeError 崩溃（协议脏数据/适配器缺陷的可定位收敛）
  const broken = async () => ({ finalMessage: undefined });
  await assert.rejects(
    () => new ContextCompactor({ sendStream: broken as any })
      .compact({ messages: [{ role: "user", content: "x" }], model, threshold: 100_000 }),
    /压缩结果为空/,
  );
}
{
  // 非法阈值归一：NaN 不得让预算比较恒 false 而静默绕过分段——
  // 回落共享默认（256K）后，300K 负载必须走分段 + 归并
  const requests: { messages: ChatMessage[] }[] = [];
  const compactor = new ContextCompactor({ sendStream: makeSendStream(() => WRAPPED, requests) } as any);
  const messages = Array.from({ length: 3 }, () => ({ role: "user", content: big(100_000) }) as ChatMessage);
  await compactor.compact({ messages, model, threshold: Number.NaN });
  assert.ok(requests.length >= 3, `默认预算下 300K 负载必须分段归并（实际 ${requests.length} 次请求）`);
  for (const request of requests) {
    const userText = typeof request.messages[1].content === "string"
      ? request.messages[1].content
      : (request.messages[1].content as any[]).map(part => part.text ?? "").join("");
    assert.ok(estimateTextTokens(userText) > 0, "分段请求负载非空");
  }
}
{
  // 预算刚够单条 ~600 token 消息：24 条各自成段 → 超过 16 次调用上限
  const promptTokens = estimateTextTokens(COMPACTION_SYSTEM_PROMPT);
  const threshold = Math.ceil((promptTokens + 512 + 1_100) / 0.9);
  const messages = Array.from({ length: 24 }, (_, index) => ({ role: "user", content: big(600) + index }) as ChatMessage);
  await assert.rejects(
    () => new ContextCompactor({ sendStream: makeSendStream(() => WRAPPED) } as any)
      .compact({ messages, model, threshold }),
    /分段过多/,
  );
}

// ──── 6. 摘要记忆消息：plan_tool 引导、覆盖范围、防御性补包、判定 ────
{
  const compactor = new ContextCompactor();
  const message = compactor.buildSummaryMessage(WRAPPED, Date.parse("2026-01-02T03:04:05Z"), 42);
  assert.equal(message.role, "system");
  const content = message.content as string;
  assert.ok(content.includes(SUMMARY_MESSAGE_MARKER));
  assert.ok(content.includes("42 条消息"), "覆盖范围（消息条数）进入注入文案");
  assert.ok(content.includes("plan_tool read"), "注入文案必须引导 plan_tool 回读权威进度");
  assert.ok(content.includes("冲突时以之后的消息为准"), "注入文案必须声明摘要与新消息的冲突规则");
  assert.ok(content.includes(WRAPPED), "已包裹摘要原样嵌入");
  assert.ok(isCompactionSummaryMessage(message));

  // 旧版无包裹摘要（历史存储形态）→ 注入前防御性补包；条数缺失不虚构
  const legacy = compactor.buildSummaryMessage("裸摘要", 0, 0);
  const legacyContent = legacy.content as string;
  assert.ok(legacyContent.includes("<summary>\n裸摘要\n</summary>"), "旧版摘要注入前自动补包");
  assert.ok(legacyContent.includes("时间未记录"));
  assert.ok(!legacyContent.includes("0 条消息"));
  assert.ok(isCompactionSummaryMessage(legacy));

  // 判定口径：普通 system 提示词与 user 消息都不是摘要记忆
  assert.ok(!isCompactionSummaryMessage({ role: "system", content: "主系统提示词" }));
  assert.ok(!isCompactionSummaryMessage({ role: "user", content: `<div>${SUMMARY_MESSAGE_MARKER}</div>` }));
}

console.log("[compaction] Compactor (prompt contract, self-healing, segmentation, defenses, summary message) passed.");

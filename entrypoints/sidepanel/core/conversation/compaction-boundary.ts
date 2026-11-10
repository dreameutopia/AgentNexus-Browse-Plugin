/**
 * 运行时压缩切分规划（compaction-boundary）——纯判定与切分模块
 *
 * 与 plan-reminder.ts 同构的「引擎旁路纯函数」模块：
 *   - planRuntimeCompaction：给定运行内历史与窗口阈值，规划一次压缩的
 *     「被压缩头部 head」与「原样保留尾部 tail」，保证切分点满足全部
 *     对话协议的配对硬约束；
 *   - 引擎（conversation-engine.tryCompactHistory）只负责执行：head 交给
 *     压缩器摘要（strategy='runtime'），tail 原样保留，二者重新拼成运行历史。
 *
 * ── 策略（2026-11 重构，取代旧 user-boundary / group-boundary 双模式）──
 *
 * 核心规则：**保留最后一轮工具调用**（原子组 = assistant.tool_calls 与其
 * 全部配对 tool 结果，天然支持单轮批量调用），其余进入摘要：
 *   1. 末轮 ≤ 阈值×15% → 末轮原样为尾部起点（其后的续拍截图/计划提醒等
 *      合成消息一并保留——它们是最新现场状态，体量小且承载当前视觉证据）；
 *   2. 末轮 > 阈值×15% → 巨型轮次并入压缩（保留它只会让它永久占位、每次
 *      压缩都零收益），切分点落在末轮之后，尾部只保留末轮之后的合成消息
 *      （可能为空——此时运行历史只剩压缩消息，模型从摘要续跑）；
 *   3. 无工具轮（纯对话历史）→ 以**最后一条用户消息**为界（Q4 决策）：
 *      该回合起原样保留、其前压缩；该回合本身 > 15% 则整段压缩（与规则 2
 *      对称，尾部为空）。wire 首条恒为用户消息，规避各协议首条约束。
 *
 * 防御规则：
 *   - protectFromIndex（引擎在「本轮用户消息尚未发送」时传入）：首发请求
 *     之前的压缩绝不把从未上屏的本轮用户消息压进摘要——否则用户诉求只以
 *     摘要形态存在一次，且合成激活轮（load_skill 结果）会被立即摘要化。
 *     该下标是切分点的**上界**（切分左移、头部收缩）：首发压缩退化为与
 *     发送前压缩同构的「只压初始上下文」形态；
 *   - 实质判定：头部非摘要内容不足 USER_BOUNDARY_MIN_HEAD_TOKENS 时返回
 *     null（摘要再压零收益，杜绝「每轮一次无效压缩请求」的空转）；
 *   - 无法形成合法切分（空历史 / 头部为空）返回 null，调用方按「不可压缩」
 *     降级，绝不返回非法切分。
 *
 * 切分不变量（调用方与测试共同依赖，违反任一条即视为实现错误）：
 *   - head 与 tail 按原序拼接恒等于原历史（无损切分）；
 *   - tail 非空且至少包含最新的原子组或最新用户回合（当前工作集不丢）；
 *     例外仅限「末轮 >15% 且其后无消息」的整段压缩形态（tail 合法为空）；
 *   - tail 中任何 tool 消息的属主 assistant 必同在 tail（无悬空 tool_call；
 *     组边界 + 切分点 = 保留集合最小下标双保险）；
 *   - tail 首条不是 tool 消息（切分恒落在组边界 / 用户回合边界）；
 *   - head 非空且具备实质可压缩体量；
 *   - protectFromIndex 强制时允许 head 为空（此时返回 null 交给守卫兜底）。
 *
 * 引擎侧的第三重防线（见 conversation-engine 主循环）：压缩「成功」但
 * 用量仍达触发线时按失败冷却——边界规划保证切分合法，冷却保证零收益
 * 压缩不会每轮重复发起。
 */

import { buildAtomicGroups, resolveContextThreshold } from '../../utils/ai/context-window-guard';
import { estimateMessageTokensDetailed } from '../../utils/ai/token-estimate';
import { isCompactionSummaryMessage } from '../context/summary-message';
import type { ChatMessage } from '../../utils/ai/ai-chat-api';

/**
 * 末轮保留上限（占上下文阈值的比例）。
 *
 * 取值权衡：尾部是模型的当前工作集（最近一轮观察结果、续拍截图、计划
 * 提醒），15% 在 256K 窗口约 38K——足够容纳十余条常规工具结果或一批
 * 截图；同时给「系统提示词 + 工具定义 + 摘要 + 后续增长」留出 85% 余量。
 * 末轮超线即并入压缩：巨型工具输出（页面全文抽取等）正是最该摘要化的内容，
 * 原样保留只会让它永久占位、后续每次压缩都零收益。
 */
export const RUNTIME_LAST_ROUND_MAX_RATIO = 0.15;

/**
 * 头部需要具备的最小「实质可压缩」体量（token）。
 *
 * 口径：头部中**非摘要消息**（排除 <conversation-memory> 摘要消息，新
 * assistant 角色与旧 system 角色都认）的文本 + 图片合计。摘要再压不会有
 * 收益（summary-of-summary 体量近似不变），只有实质内容才可能换回窗口
 * 空间——低于该值返回 null，由引擎侧冷却兜底，杜绝每轮一次的空转压缩。
 */
export const USER_BOUNDARY_MIN_HEAD_TOKENS = 2048;

/** 运行时压缩的切分模式 */
export type RuntimeCompactionMode =
  /** 工具轮次模式：切分点由「最后一轮工具调用」与 15% 线决定 */
  | 'tool-round'
  /** 纯对话模式：以最后一条用户消息为界（无工具轮历史） */
  | 'user-turn';

/** 一次运行时压缩的切分方案 */
export interface RuntimeCompactionPlan {
  mode: RuntimeCompactionMode;
  /** 被压缩头部：整体交给摘要压缩器，替换为一条上下文压缩消息（assistant） */
  head: ChatMessage[];
  /** 原样保留尾部（可能为空：整段压缩形态）：与压缩消息重新拼接为压缩后的运行历史 */
  tail: ChatMessage[];
}

/** 规划选项 */
export interface RuntimeCompactionOptions {
  /**
   * 受保护下标（含）：该下标起的消息不得进入头部（引擎在本轮用户消息
   * 尚未发送时传入其下标）。
   *
   * 语义是切分点的**上界**：头部 = slice(0, split)，要让受保护消息留在尾部
   * 必须 split ≤ protectFromIndex。天然切分点若在其右侧（例如「保留最后
   * 一轮工具调用」把切分点推到用户消息之后），此处把切分点**左移**到受
   * 保护下标——头部随之收缩，用户诉求与本轮激活轮原样进入尾部。
   */
  protectFromIndex?: number;
}

/** 单条消息的全量 token 成本（文本 + 图片，与 context-meter 同一估算器） */
function messageCost(message: ChatMessage): number {
  const detail = estimateMessageTokensDetailed(message);
  return detail.textTokens + detail.imageTokens;
}

/** 组内消息的 token 成本合计 */
function groupCost(history: readonly ChatMessage[], group: readonly number[]): number {
  let total = 0;
  for (const index of group) total += messageCost(history[index]);
  return total;
}

/**
 * 头部是否具备实质可压缩体量：非摘要消息的 token 合计达到
 * USER_BOUNDARY_MIN_HEAD_TOKENS（满足即提前返回；全部为摘要消息时恒 false）。
 */
function hasCompressibleSubstance(head: readonly ChatMessage[]): boolean {
  let substantiveTokens = 0;
  for (const message of head) {
    if (isCompactionSummaryMessage(message)) continue;
    substantiveTokens += messageCost(message);
    if (substantiveTokens >= USER_BOUNDARY_MIN_HEAD_TOKENS) return true;
  }
  return false;
}

/**
 * 定位最后一轮工具调用（原子组下标）：自新向旧找首个「含工具内容」的组
 * （组内有 tool 消息或带 tool_calls 的 assistant——并行批量调用同组天然覆盖）。
 * 找不到返回 -1（纯对话历史 → user-turn 模式）。
 */
function findLastToolRoundGroup(groups: readonly number[][], history: readonly ChatMessage[]): number {
  for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex--) {
    for (const index of groups[groupIndex]) {
      const message = history[index];
      if (message.role === 'tool' || (message.role === 'assistant' && message.tool_calls?.length)) {
        return groupIndex;
      }
    }
  }
  return -1;
}

/**
 * 规划一次运行时压缩（策略与两份提示词配置见 compaction-prompts /
 * 本文件头注释）。无法形成合法切分时返回 null。
 */
export function planRuntimeCompaction(
  history: readonly ChatMessage[],
  thresholdTokens: number,
  options: RuntimeCompactionOptions = {},
): RuntimeCompactionPlan | null {
  if (history.length === 0) return null;
  const threshold = resolveContextThreshold(thresholdTokens);
  const lastRoundRatioLimit = threshold * RUNTIME_LAST_ROUND_MAX_RATIO;

  const groups = buildAtomicGroups(history);
  const lastRoundGroup = findLastToolRoundGroup(groups, history);

  let mode: RuntimeCompactionMode;
  let split: number;
  if (lastRoundGroup !== -1) {
    // ── 工具轮次模式：末轮起点（≤15%）或末轮之后（>15%） ──
    mode = 'tool-round';
    const round = groups[lastRoundGroup];
    let roundStart = history.length;
    let roundEnd = 0;
    for (const index of round) {
      if (index < roundStart) roundStart = index;
      if (index + 1 > roundEnd) roundEnd = index + 1;
    }
    const roundFits = groupCost(history, round) <= lastRoundRatioLimit;
    split = roundFits ? roundStart : roundEnd;
  } else {
    // ── 纯对话模式：最后一条用户消息为界；该回合本身超 15% 则整段压缩 ──
    mode = 'user-turn';
    let lastUserIndex = -1;
    for (let index = history.length - 1; index >= 0; index--) {
      if (history[index].role === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    if (lastUserIndex <= 0) return null;
    // 该「回合」= 最后一条用户消息到末尾（纯对话中其后只有 assistant 回复）
    let turnCost = 0;
    for (let index = lastUserIndex; index < history.length; index++) {
      turnCost += messageCost(history[index]);
    }
    split = turnCost <= lastRoundRatioLimit ? lastUserIndex : history.length;
  }

  // 受保护下标是切分点上限：切分左移到受保护下标（头部更小、尾部更大），
  // 保证受保护消息（及其后的一切）原样留在尾部
  if (options.protectFromIndex !== undefined && options.protectFromIndex < split) {
    split = options.protectFromIndex;
  }
  if (split <= 0) return null;

  const head = history.slice(0, split);
  const tail = history.slice(split);
  if (head.length === 0) return null;
  if (!hasCompressibleSubstance(head)) return null;

  return { mode, head, tail };
}

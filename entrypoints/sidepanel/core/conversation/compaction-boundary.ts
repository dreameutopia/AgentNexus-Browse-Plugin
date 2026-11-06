/**
 * 运行时压缩边界规划（compaction-boundary）——纯判定与切分模块
 *
 * 与 plan-reminder.ts 同构的「引擎旁路纯函数」模块：
 *   - planRuntimeCompaction：给定运行内历史与窗口阈值，规划一次压缩的
 *     「被压缩头部 head」与「原样保留尾部 tail」，保证切分点满足全部
 *     对话协议的配对硬约束；
 *   - 引擎（conversation-engine.tryCompactHistory）只负责执行：head 交给
 *     压缩器摘要，tail 原样保留，二者重新拼成运行历史。
 *
 * 为什么需要两种边界模式（根因）：
 *   1. user-boundary（最后一条用户消息之前）：多轮对话与视觉续拍的常态。
 *      尾部以用户消息锚定当前回合，天然不会切开 assistant.tool_calls 与
 *      其 tool 结果的配对（配对只会出现在用户消息之后）。
 *   2. group-boundary（原子组边界回退）：头部不具备实质可压缩体量、或
 *      **单用户消息的长自治运行**——网站学习/盲试验证只有一条 kickoff
 *      用户消息（位于下标 0），普通对话的单次长工具循环同理。前者旧实现
 *      会反复压缩「只剩旧摘要的头部」（每次成功但零收益，触发线上每轮
 *      一次无效压缩请求，直到越限报错）；后者旧实现直接放弃压缩，越过
 *      阈值后整段运行以「上下文无法放入窗口」告终。回退模式按原子组
 *      （assistant.tool_calls 与其全部 tool 结果互为不可分整体）从新到旧
 *      保留一个连续窗口，其余进入摘要：配对约束由组边界保证，窗口大小
 *      由预算控制。
 *
 * 切分不变量（调用方与测试共同依赖，违反任一条即视为实现错误）：
 *   - head 与 tail 按原序拼接恒等于原历史（无损切分）；
 *   - tail 非空且至少包含最新的一个原子组（当前工作集不丢）；
 *   - tail 中任何 tool 消息的属主 assistant 必同在 tail（无悬空 tool_call；
 *     组边界 + 「splitIndex = 保留集合最小下标」双保险，即使出现理论上
 *     不可能的中断式分组也不会切出半配对）；
 *   - head 非空（无意义压缩不发生）；user-boundary 模式额外要求头部具备
 *     实质可压缩体量（非摘要消息 ≥ USER_BOUNDARY_MIN_HEAD_TOKENS），
 *     不满足时降级 group-boundary 重新规划；
 *   - 无法满足上述约束时返回 null，调用方按「不可压缩」降级，绝不返回
 *     非法切分。
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
 * group-boundary 模式下尾部保留窗口占上下文阈值的比例。
 *
 * 取值权衡：尾部是模型的当前工作集（最近几轮观察、计划提醒、截图），
 * 太小会让模型丢失正在使用的证据、行为断层；太大则压缩收益薄、很快再次
 * 触发。30% 在 256K 窗口下约 77K token，可容纳十余个完整工具轮次，同时
 * 给「系统提示词 + 工具定义（学习场景数万 token）+ 摘要后的继续增长」
 * 留出 70% 余量，避免压缩完成后下一轮立刻再次越限。
 */
export const RUNTIME_COMPACTION_TAIL_RATIO = 0.3;

/**
 * user-boundary 头部需要具备的最小「实质可压缩」体量（token）。
 *
 * 口径：头部中**非摘要消息**（排除 <conversation-memory> 摘要系统消息）的
 * 文本 + 图片合计。摘要再压不会有收益（summary-of-summary 体量近似不变），
 * 只有实质内容才可能换回窗口空间。低于该值时 user-boundary 压缩为零收益
 * 操作，必须降级 group-boundary 重新规划——这是「同一运行内二次压缩空转」
 * 根因的修复点：首次压缩后头部只剩摘要消息，旧实现继续以 user-boundary
 * 每轮压缩这条摘要，直到越限。
 *
 * 取绝对值而非比例：阈值下限 8K 时 2048 占 25%（值得压），1M 窗口时占
 * 0.2%（收益边际但至多发生一次，随后降级 group-boundary 即恢复有效压缩；
 * 引擎侧的「无缓解冷却」是该场景的比例化兜底）。
 */
export const USER_BOUNDARY_MIN_HEAD_TOKENS = 2048;

/** 一次运行时压缩的切分方案 */
export interface RuntimeCompactionPlan {
  /**
   * 边界模式：
   * - user-boundary：头部为最后一条用户消息之前的全部历史（既有语义）；
   * - group-boundary：头部为最新连续原子组窗口之前的全部历史（头部实质
   *   不足或单用户消息长自治运行的回退）。
   */
  mode: 'user-boundary' | 'group-boundary';
  /** 被压缩头部：整体交给摘要压缩器，替换为一条摘要系统消息 */
  head: ChatMessage[];
  /** 原样保留尾部：与摘要消息重新拼接为压缩后的运行历史 */
  tail: ChatMessage[];
}

/** 单条消息的全量 token 成本（文本 + 图片，与 context-meter 同一估算器） */
function messageCost(message: ChatMessage): number {
  const detail = estimateMessageTokensDetailed(message);
  return detail.textTokens + detail.imageTokens;
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
 * 规划一次运行时压缩。
 *
 * 优先 user-boundary：最后一条用户消息之前存在实质可压内容时沿用既有语义
 * （多轮对话 / 视觉续拍的行为与历史版本完全一致）；仅当头部无实质可压
 * （只有旧摘要或零星短消息）、用户消息位于下标 0（单用户消息长运行）或
 * 不存在时回退 group-boundary。无法形成合法切分时返回 null。
 */
export function planRuntimeCompaction(
  history: readonly ChatMessage[],
  thresholdTokens: number,
): RuntimeCompactionPlan | null {
  if (history.length === 0) return null;

  // ── 模式一：user-boundary（既有语义，要求头部具备实质可压体量）──
  let lastUserIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex > 0) {
    const head = history.slice(0, lastUserIndex);
    if (hasCompressibleSubstance(head)) {
      return {
        mode: 'user-boundary',
        head,
        tail: history.slice(lastUserIndex),
      };
    }
    // 头部无实质可压（二次压缩空转形态）：落入 group-boundary 重新规划，
    // 把摘要消息与其后的轮次一起纳入「可压头部 vs 保留窗口」的全局权衡。
  }

  // ── 模式二：group-boundary（实质不足 / 单用户消息长自治运行回退）──
  // 原子组 = assistant(tool_calls) 与其全部配对 tool 结果，组内不可分。
  // 少于两组意味着「没有可压缩的头部」，返回 null（与旧实现的放弃语义一致，
  // 但只在真正无可压缩时放弃，而非结构性放弃）。
  const groups = buildAtomicGroups(history);
  if (groups.length < 2) return null;

  // 阈值解析复用守卫的单一事实源实现（非法值回退共享默认并钳制下限），
  // 压缩尾部预算与裁剪行为对「阈值是什么」恒持同一答案。
  const tailBudget = Math.max(
    1,
    Math.floor(resolveContextThreshold(thresholdTokens) * RUNTIME_COMPACTION_TAIL_RATIO),
  );

  // 从最新组向旧组连续累加：一旦放不下即停止——保留「最近的连续窗口」
  // 而非跳过旧组凑数，上下文语义连续（组与组之间的时序不出现空洞）。
  // 最新的第一组无条件保留：当前回合的证据不能丢，即使它独占超预算
  // （此时 head 仍有可压缩内容，压缩依然有效）。
  const retained = new Set<number>();
  let usedTokens = 0;
  let splitIndex = history.length;
  for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex--) {
    let groupTokens = 0;
    for (const index of groups[groupIndex]) groupTokens += messageCost(history[index]);
    if (retained.size > 0 && usedTokens + groupTokens > tailBudget) break;
    for (const index of groups[groupIndex]) retained.add(index);
    usedTokens += groupTokens;
    // 切分点 = 保留集合的最小下标：所有保留消息下标 ≥ splitIndex（数学归纳于
    // 「组按下标升序展开」），head 中不含任何保留消息——非连续分组下依然安全。
    // 显式循环而非 Math.min(...group)：单组含极多工具结果时展开参数
    // 可能超出调用栈上限，循环对任意组大小无界安全。
    for (const index of groups[groupIndex]) {
      if (index < splitIndex) splitIndex = index;
    }
  }

  // 全部组都装进预算（触发压缩时不可能，防御性兜底）：无头部可压缩。
  if (splitIndex <= 0) return null;

  return {
    mode: 'group-boundary',
    head: history.slice(0, splitIndex),
    tail: history.slice(splitIndex),
  };
}

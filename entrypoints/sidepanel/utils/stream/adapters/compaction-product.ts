/**
 * 首条上下文压缩消息的 wire 归一助手（各协议适配器共用）
 *
 * 背景（2026-11 重构）：压缩产物在领域层恒为 **assistant** 角色（上下文
 * 压缩消息，见 core/context/summary-message 的角色契约）。但不同协议对
 * 「首条消息」有不同约束：
 *   - OpenAI Chat Completions / Responses：assistant 可出现在任意位置，
 *     首条即压缩消息完全合法 → **原生透传**（顺带修复「历史中段 system
 *     消息」在严格网关被拒的隐患）；
 *   - Anthropic Messages / Gemini：首条必须 user（Gemini 明确 400；
 *     Anthropic 官方文档虽未成文禁止 assistant 首条，但把首条压缩记忆并入
 *     顶级 system 是零风险的等价形态——压缩记忆本就是「系统级上下文」，
 *     且与压缩前的既有行为逐字一致）。
 *
 * 本模块只做**判定**（哪条是首条压缩记忆、其余是什么），文本提取与
 * wire 组装由各适配器按自身格式完成。
 */

import { isCompactionSummaryMessage } from '../../../core/context/summary-message';
import type { UnifiedChatMessage } from '../types';

/** 首条压缩记忆的切分结果 */
export interface CompactionProductSplit {
  /** 首条压缩记忆（非 system 序列中的首条且带压缩标记）；无则 null */
  product: UnifiedChatMessage | null;
  /** 其余非 system 消息（保持原序，剔除压缩记忆） */
  rest: UnifiedChatMessage[];
}

/**
 * 切分「首条压缩记忆」：仅当**第一条非 system 消息**是压缩记忆时命中
 * （压缩记忆恒位于模型上下文最前——见 compaction-boundary 与
 * context-engine 的注入位置；中段出现压缩记忆属脏数据，不做归一）。
 *
 * 判定用 core/context/summary-message 的 isCompactionSummaryMessage：
 * 新 assistant 角色与旧 system 角色都认（后者本就在 system 序列里，
 * 不走本路径）。
 */
export function splitLeadingCompactionProduct(
  messages: readonly UnifiedChatMessage[],
): CompactionProductSplit {
  const nonSystem = messages.filter(message => message.role !== 'system');
  if (nonSystem.length === 0) return { product: null, rest: [] };
  const first = nonSystem[0];
  if (!isCompactionSummaryMessage(first)) return { product: null, rest: nonSystem };
  return { product: first, rest: nonSystem.slice(1) };
}

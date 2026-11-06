/**
 * 压缩摘要记忆消息的共享契约（单一事实源）
 *
 * 生产方：ContextCompactor.buildSummaryMessage（运行时压缩 / 预运行压缩两处）。
 * 消费方：
 *   - compaction-boundary：识别「被压缩头部只剩旧摘要」的空转形态——摘要再压
 *     不会有收益，user-boundary 的实质判定必须把摘要消息排除在可压体量之外；
 *   - context-engine / 会话重放：持久化摘要重新注入为记忆消息。
 *
 * 本模块刻意保持零运行时依赖（仅类型引用）：它是纯规划模块
 * （compaction-boundary）与压缩器（compactor）的共同下游，放重依赖会把
 * ai-chat-api 整张引用图拖进边界规划与它的测试。
 */

import type { ChatMessage } from '../../utils/ai/ai-chat-api';

/** 摘要记忆消息的包裹标记（识别「已有摘要」系统消息的唯一口径） */
export const SUMMARY_MESSAGE_MARKER = '<conversation-memory>';

/**
 * 判定消息是否为压缩摘要记忆消息（system 角色 + 包含标记）。
 * 只认 string content：buildSummaryMessage 恒产出 string，数组形态的
 * system 消息不属于摘要记忆，按非摘要参与体量计量。
 */
export function isCompactionSummaryMessage(message: Pick<ChatMessage, 'role' | 'content'>): boolean {
  return (
    message.role === 'system' &&
    typeof message.content === 'string' &&
    message.content.includes(SUMMARY_MESSAGE_MARKER)
  );
}

/**
 * 兜底包裹：无 <summary> 元素的文本自动补包（格式自愈）。
 * 同时服务于两条路径：压缩器清洗模型输出、buildSummaryMessage 重新注入
 * 历史存储的旧版摘要（早期版本可能没有 <summary> 包裹）。
 */
export function ensureSummaryWrapped(text: string): string {
  const trimmed = text.trim();
  return /<summary[\s>]/i.test(trimmed) ? trimmed : `<summary>\n${trimmed}\n</summary>`;
}

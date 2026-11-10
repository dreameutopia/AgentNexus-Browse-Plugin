/**
 * 压缩摘要记忆消息的共享契约（单一事实源）
 *
 * 生产方：ContextCompactor.buildSummaryMessage（运行时压缩 / 预运行压缩两处）。
 * 消费方：
 *   - compaction-boundary：识别「被压缩头部只剩旧摘要」的空转形态——摘要再压
 *     不会有收益，实质判定必须把摘要消息排除在可压体量之外；
 *   - context-engine / 会话重放：持久化摘要重新注入为记忆消息；
 *   - context-window-guard：摘要消息按系统级优先保护（永不因超限被裁）。
 *
 * 角色契约（2026-11 重构）：压缩产物恒为 **assistant** 角色（「上下文压缩
 * 消息」——模型面记忆声明，非系统提示词）。两条理由：
 *   1. systemPrompt 由装配层管理、不归上下文引擎——摘要若以 system 注入，
 *      会与「system 消息必须首条」类严格网关校验冲突（历史中段的 system
 *      消息正是这类 400 的来源）；
 *   2. OpenAI 系协议 assistant 消息可合法出现在任意位置，wire 语义最贴近
 *      「模型已消化的既往对话」。
 * Claude / Gemini 协议对首条消息有额外约束（Gemini 要求 user 开头），由
 * 各协议适配器在 wire 层对**首条压缩产物**做归一（并入其顶级 system 字段），
 * 领域层与落库恒为 assistant。
 *
 * 向后兼容：旧版本持久化的摘要为 system 角色（modelContext 检查点 / 会话级
 * compactionSummary 重注入均可能遇到），判定与检查点识别必须两种角色都认。
 *
 * 本模块刻意保持零运行时依赖（仅类型引用）：它是纯规划模块
 * （compaction-boundary）与压缩器（compactor）的共同下游，放重依赖会把
 * ai-chat-api 整张引用图拖进边界规划与它的测试。
 */

import type { ChatMessage } from '../../utils/ai/ai-chat-api';

/** 摘要记忆消息的包裹标记（识别「已有摘要」消息的唯一口径） */
export const SUMMARY_MESSAGE_MARKER = '<conversation-memory>';

/**
 * 判定消息是否为压缩摘要记忆消息（assistant 或 legacy system 角色 + 包含标记）。
 * 只认 string content：buildSummaryMessage 恒产出 string，数组形态的消息
 * 不属于摘要记忆，按非摘要参与体量计量。
 */
export function isCompactionSummaryMessage(message: Pick<ChatMessage, 'role' | 'content'>): boolean {
  return (
    (message.role === 'assistant' || message.role === 'system') &&
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

/**
 * 取压缩消息的**内容本体**（内层 <summary>…</summary>），剥掉外层信封。
 *
 * 用途：压缩消息再次进入压缩载荷时（摘要的摘要），只应把「摘要内容」交给
 * 压缩模型——外层信封的样板（权威记忆声明、冲突规则、plan_tool 回读引导）
 * 与内容无关，原样喂回会诱导模型把样板复制进新摘要（叠出嵌套样板），
 * 也白白占用压缩预算。
 *
 * 契约：存在内层 <summary> 时取其内容；否则剥掉信封标签后返回剩余正文
 * （旧版无包裹形态的兜底）。非压缩消息的内容原样返回。
 */
export function summaryBodyOnly(message: Pick<ChatMessage, 'role' | 'content'>): string {
  if (!isCompactionSummaryMessage(message)) {
    return typeof message.content === 'string' ? message.content : '';
  }
  const text = typeof message.content === 'string' ? message.content : '';
  const inner = /<summary[\s>][\s\S]*<\/summary>/i.exec(text);
  if (inner) return inner[0].trim();
  return text.replaceAll(/<\/?conversation-memory>/g, '').trim();
}

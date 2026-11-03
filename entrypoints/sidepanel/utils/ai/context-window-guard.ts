import type { ChatMessage, VisionContent } from './ai-chat-api';
import {
  CONTEXT_THRESHOLD_DEFAULT,
  CONTEXT_THRESHOLD_MIN,
} from '../channels/channel-types';
import {
  estimateMessageTokens,
  estimateTextTokens,
  IMAGE_CONTEXT_TOKENS,
  sliceTextToTokenBudget,
} from './token-estimate';

export interface ContextGuardResult {
  messages: ChatMessage[];
  /** 裁剪前的 token 估算总量 */
  originalTokens: number;
  /** 裁剪后的 token 估算总量 */
  finalTokens: number;
  /** 上下文 token 阈值 */
  threshold: number;
  truncated: boolean;
  removedMessages: number;
  toolContentsTrimmed: number;
}

type NormalizedMessage = ChatMessage & {
  __normalizedIndex?: number;
};

/**
 * 工具结果的**传输层**截断上限（字符，非 token）：
 * tool 角色内容按字符截断是协议载荷防护（页面抽取类结果可达数十万字符），
 * 与 token 预算是两件事——截断后的内容再按 token 计入预算。
 */
const TOOL_CONTENT_LIMIT = 8 * 1024;

/** NUL 控制字符（OpenAI 等对话 API 会拒绝包含它的文本） */
const NUL_CHAR = String.fromCharCode(0);

/**
 * 上下文窗口守卫（token 口径）。
 *
 * 计量与 context-meter（用量环 + 压缩触发）同源：全部经
 * utils/ai/token-estimate 的唯一实现（文本启发式估算 + 图片固定 1800 token），
 * 环上显示的 85%/95% 判定与实际裁剪行为不会漂移。
 *
 * 裁剪策略保持不变：system 优先保留（超限时按 token 预算截断其正文）、
 * tool 内容传输层截断、非 system 消息按「原子组」从新到旧保留。
 */
export class ContextWindowGuard {
  static readonly TOOL_CONTENT_LIMIT = TOOL_CONTENT_LIMIT;

  static protect(messages: ChatMessage[], threshold?: number): ContextGuardResult {
    const safeThreshold = this.resolveThreshold(threshold);
    const normalizedMessages = messages.map((message, index) => this.normalizeMessage(message, index));
    const originalTokens = this.totalTokens(normalizedMessages);
    const toolContentsTrimmed = messages.reduce((count, message) => {
      if (message.role !== 'tool') {
        return count;
      }

      const originalText = typeof message.content === 'string' ? message.content : this.safeStringify(message.content);
      return count + (originalText.length > TOOL_CONTENT_LIMIT ? 1 : 0);
    }, 0);

    if (normalizedMessages.length === 0) {
      return {
        messages: [],
        originalTokens,
        finalTokens: 0,
        threshold: safeThreshold,
        truncated: false,
        removedMessages: 0,
        toolContentsTrimmed,
      };
    }

    const systemMessages = normalizedMessages.filter(message => message.role === 'system');
    const nonSystemMessages = normalizedMessages.filter(message => message.role !== 'system');
    const systemTokens = this.totalTokens(systemMessages);

    if (systemTokens >= safeThreshold) {
      const protectedSystemMessages = this.trimSystemMessagesToThreshold(systemMessages, safeThreshold);
      const finalTokens = this.totalTokens(protectedSystemMessages);
      return {
        messages: protectedSystemMessages,
        originalTokens,
        finalTokens,
        threshold: safeThreshold,
        truncated: true,
        removedMessages: normalizedMessages.length - protectedSystemMessages.length,
        toolContentsTrimmed,
      };
    }

    const remainingBudget = Math.max(safeThreshold - systemTokens, 0);
    const retainedNonSystemMessages = this.retainNewestMessagesWithinBudget(nonSystemMessages, remainingBudget);
    const finalMessages = [...systemMessages, ...retainedNonSystemMessages]
      .sort((left, right) => (left.__normalizedIndex ?? 0) - (right.__normalizedIndex ?? 0))
      .map(({ __normalizedIndex, ...message }) => message);
    const finalTokens = this.totalTokens(finalMessages);

    return {
      messages: finalMessages,
      originalTokens,
      finalTokens,
      threshold: safeThreshold,
      truncated: finalTokens < originalTokens,
      removedMessages: normalizedMessages.length - finalMessages.length,
      toolContentsTrimmed,
    };
  }

  /**
   * 阈值解析（防御性）：
   * 运行链路恒显式传入 runtime.model.contextThreshold（模型级 token 阈值，经
   * modelRegistry 钳制）。缺省回落仅服务未传阈值的边缘调用方——
   * 直接采用共享默认值，**绝不回读全局配置**：回读会产生第二把口径不同的
   * 裁剪刀（运行快照阈值 vs 存储阈值），与「裁剪单点执行」原则冲突。
   */
  private static resolveThreshold(threshold?: number): number {
    if (!Number.isFinite(threshold) || (threshold as number) <= 0) {
      return CONTEXT_THRESHOLD_DEFAULT;
    }
    return Math.max(CONTEXT_THRESHOLD_MIN, Math.floor(threshold as number));
  }

  private static normalizeMessage(message: ChatMessage, index: number): NormalizedMessage {
    return {
      ...message,
      __normalizedIndex: index,
      content: this.normalizeContent(message.role, message.content),
      tool_calls: message.tool_calls?.map(toolCall => ({
        ...toolCall,
        function: {
          ...toolCall.function,
          arguments: this.sanitizeText(toolCall.function.arguments),
        },
      })),
      name: message.name ? this.sanitizeText(message.name) : message.name,
      tool_call_id: message.tool_call_id ? this.sanitizeText(message.tool_call_id) : message.tool_call_id,
    };
  }

  private static normalizeContent(role: ChatMessage['role'], content: ChatMessage['content']): ChatMessage['content'] {
    if (typeof content === 'string') {
      const sanitized = this.sanitizeText(content);
      return role === 'tool' ? this.trimToolContent(sanitized) : sanitized;
    }

    return content.map(part => {
      const normalizedPart: VisionContent = {
        ...part,
        text: part.text ? this.sanitizeText(part.text) : part.text,
        image_url: part.image_url
          ? {
              ...part.image_url,
              url: this.sanitizeText(part.image_url.url),
            }
          : part.image_url,
      };

      if (role === 'tool' && normalizedPart.text) {
        normalizedPart.text = this.trimToolContent(normalizedPart.text);
      }

      return normalizedPart;
    });
  }

  private static sanitizeText(value: string): string {
    // 剥离 NUL 控制字符：OpenAI 等对话 API 会拒绝包含 NUL 的文本
    return value.replaceAll(NUL_CHAR, '');
  }

  private static trimToolContent(content: string): string {
    if (content.length <= TOOL_CONTENT_LIMIT) {
      return content;
    }

    return `${content.slice(0, TOOL_CONTENT_LIMIT)}\n...[tool response truncated to ${TOOL_CONTENT_LIMIT} chars]`;
  }

  /**
   * 在 token 预算内从新到旧保留消息（按原子组）。
   *
   * 原子组 = assistant(tool_calls) 与其全部配对 tool 结果消息：
   * 组内要么整体保留、要么整体丢弃。这满足全部协议的配对硬约束——
   * OpenAI 要求 assistant.tool_calls 的每个 id 都有紧随的 tool 消息、
   * Claude 要求 tool_use 与 tool_result 逐个配对、Gemini 要求 functionCall
   * 与 functionResponse 成对——绝不允许「保留了工具调用却裁掉部分结果」的半配对形态。
   * 组长度一次性预计算，从新到旧累加，不会重复计入已保留消息。
   *
   * 图片消息按固定 1800 token 计入组成本（见 token-estimate）：单张截图
   * 不再以 base64 全长挤爆预算，多图历史也能按真实成本参与保留决策。
   */
  private static retainNewestMessagesWithinBudget(messages: NormalizedMessage[], budget: number): NormalizedMessage[] {
    if (budget <= 0 || messages.length === 0) {
      return [];
    }

    const groups = this.buildAtomicGroups(messages);
    const groupTokens = groups.map(group =>
      group.reduce((total, index) => total + estimateMessageTokens(messages[index]), 0),
    );

    const retainedIndices = new Set<number>();
    let usedTokens = 0;

    for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex--) {
      const groupCost = groupTokens[groupIndex];
      if (usedTokens + groupCost > budget) {
        continue;
      }
      usedTokens += groupCost;
      for (const index of groups[groupIndex]) {
        retainedIndices.add(index);
      }
    }

    return messages.filter((_, index) => retainedIndices.has(index));
  }

  /**
   * 展开消息序列为互斥原子组：
   *   - tool 消息定位属主 assistant 后并入其组（同一 assistant 的多条并行结果同组）；
   *   - 无法定位属主的 tool 消息（孤儿）与其余消息各自成组；
   *   - 组间保持消息原始顺序（最终结果按 __normalizedIndex 重排）。
   */
  private static buildAtomicGroups(messages: NormalizedMessage[]): number[][] {
    const toolOwner = new Map<number, number>();
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message.role !== 'tool' || !message.tool_call_id) continue;
      const ownerIndex = this.findOwningAssistantMessageIndex(messages, index, message.tool_call_id);
      if (ownerIndex !== -1) {
        toolOwner.set(index, ownerIndex);
      }
    }

    const groups: number[][] = [];
    const groupIndexOf = new Map<number, number>();
    for (let index = 0; index < messages.length; index++) {
      if (toolOwner.has(index)) continue; // tool 消息并入属主组
      groupIndexOf.set(index, groups.length);
      groups.push([index]);
    }
    for (const [toolIndex, ownerIndex] of toolOwner) {
      const groupIndex = groupIndexOf.get(ownerIndex);
      if (groupIndex !== undefined) {
        groups[groupIndex].push(toolIndex);
      }
    }
    return groups;
  }

  private static findOwningAssistantMessageIndex(messages: NormalizedMessage[], toolIndex: number, toolCallId: string): number {
    for (let index = toolIndex - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== 'assistant') {
        continue;
      }

      if (message.tool_calls?.some(toolCall => toolCall.id === toolCallId)) {
        return index;
      }

      break;
    }

    return -1;
  }

  /** system 消息超阈值时按 token 预算逐条截断正文（保持消息结构与顺序） */
  private static trimSystemMessagesToThreshold(messages: NormalizedMessage[], threshold: number): ChatMessage[] {
    if (messages.length === 0) {
      return [];
    }

    let remaining = threshold;
    const trimmed: ChatMessage[] = [];

    for (const message of messages) {
      if (remaining <= 0) {
        break;
      }

      const baseTokens = estimateMessageTokens({
        ...message,
        content: typeof message.content === 'string' ? '' : [],
      });
      const availableContentTokens = Math.max(remaining - baseTokens, 0);
      const nextMessage: ChatMessage = {
        role: message.role,
        content: this.trimContentToTokens(message.content, availableContentTokens),
        name: message.name,
        tool_calls: message.tool_calls,
        tool_call_id: message.tool_call_id,
      };
      trimmed.push(nextMessage);
      remaining -= estimateMessageTokens(nextMessage);
    }

    return trimmed;
  }

  /**
   * 按 token 预算裁剪消息正文：
   *   - 字符串 content → sliceTextToTokenBudget（估算同源，保证裁后不超预算）；
   *   - 数组 content（防御路径：system 恒为字符串）→ 文本部件按剩余预算
   *     逐段截断，图片部件按固定 1800 token 扣预算、装不下即丢弃。
   */
  private static trimContentToTokens(
    content: ChatMessage['content'],
    maxTokens: number,
  ): ChatMessage['content'] {
    if (maxTokens <= 0) {
      return typeof content === 'string' ? '' : [];
    }

    if (typeof content === 'string') {
      return sliceTextToTokenBudget(content, maxTokens);
    }

    let remaining = maxTokens;
    const trimmedParts: VisionContent[] = [];

    for (const part of content) {
      if (remaining <= 0) {
        break;
      }

      const nextPart: VisionContent = { ...part };
      if (nextPart.text) {
        const sliced = sliceTextToTokenBudget(nextPart.text, remaining);
        nextPart.text = sliced;
        remaining -= estimateTextTokens(sliced);
        trimmedParts.push(nextPart);
        continue;
      }

      if (nextPart.image_url?.url) {
        if (IMAGE_CONTEXT_TOKENS > remaining) continue; // 图片装不下预算 → 丢弃
        remaining -= IMAGE_CONTEXT_TOKENS;
        trimmedParts.push(nextPart);
      }
    }

    return trimmedParts;
  }

  private static totalTokens(messages: Pick<ChatMessage, 'role' | 'content' | 'name' | 'tool_calls' | 'tool_call_id'>[]): number {
    return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
  }

  /** JSON 序列化为文本（失败回落 String）；仅用于 tool 内容的传输层截断判定 */
  private static safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return String(value ?? '');
    }
  }
}

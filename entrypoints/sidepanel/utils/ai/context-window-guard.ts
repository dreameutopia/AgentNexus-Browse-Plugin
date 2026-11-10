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
  trimDanglingSurrogate,
} from './token-estimate';
import { isCompactionSummaryMessage } from '../../core/context/summary-message';

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

/**
 * 不做传输层截断的工具（按 tool 消息的 name 识别）。
 *
 * 技能指令与资源文件不是「工具产出的数据」，而是**按需注入的上下文**：体量在
 * 装配侧已按 SKILL_PAGE_TOKEN_BUDGET（≈3000 token/页）分页约束（见
 * utils/skills/skill-pagination），单次注入天然有界且略高于传输层的 8KB——
 * 一刀切会静默砍页，模型读到残缺指令却以为读全了。
 * 其余工具（页面抽取等）可能返回数十万字符，仍按 TOOL_CONTENT_LIMIT 截断。
 */
const SKILL_CONTEXT_TOOL_NAMES: ReadonlySet<string> = new Set(['skill_tool', 'load_skill', 'read_skill_file']);

/** NUL 控制字符（OpenAI 等对话 API 会拒绝包含它的文本） */
const NUL_CHAR = String.fromCharCode(0);

/** 文本中是否含任何 UTF-16 代理项（快速预筛：base64 等纯 ASCII 跳过替换扫描） */
const HAS_SURROGATE_RE = /[\uD800-\uDFFF]/;

/** 未配对的孤立代理项（高位无低位跟随 / 低位无高位在前） */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * 展开消息序列为互斥原子组（导出的单一事实源实现）：
 *   - tool 消息定位属主 assistant 后并入其组（同一 assistant 的多条并行结果同组）；
 *   - 无法定位属主的 tool 消息（孤儿）与其余消息各自成组；
 *   - 组间保持消息原始顺序（组按下标升序，最终结果按 __normalizedIndex 重排）。
 *
 * 消费方：窗口守卫的「从新到旧保留」（retainNewestMessagesWithinBudget）与
 * 运行时压缩的切分规划（core/conversation/compaction-boundary）。两处共享
 * 同一实现，配对约束的判定不会漂移。
 *
 * @param messages 消息序列（下标即组内元素的引用键）
 * @returns 每组为其成员消息下标的升序数组（组间按下标升序）
 */
export function buildAtomicGroups(messages: readonly ChatMessage[]): number[][] {
  const toolOwner = new Map<number, number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'tool' || !message.tool_call_id) continue;
    const ownerIndex = findOwningAssistantMessageIndex(messages, index, message.tool_call_id);
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

/**
 * 定位 tool 消息的属主 assistant（从 tool 消息向前扫描，首个 id 匹配者）。
 * 遇到任何 assistant 即停止——OpenAI 协议里 tool 结果紧跟其属主，越过
 * 第一个 assistant 继续扫描只会把结果错配给更早的调用。
 */
function findOwningAssistantMessageIndex(
  messages: readonly ChatMessage[],
  toolIndex: number,
  toolCallId: string,
): number {
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

/**
 * 阈值解析（防御性，导出的单一事实源实现）：
 * 运行链路恒显式传入 runtime.model.contextThreshold（模型级 token 阈值，经
 * modelRegistry 钳制）。缺省/非法回落仅服务边缘调用方——直接采用共享默认值，
 * **绝不回读全局配置**：回读会产生第二把口径不同的裁剪刀（运行快照阈值 vs
 * 存储阈值），与「裁剪单点执行」原则冲突。
 *
 * 消费方：窗口守卫裁剪（protect）与运行时压缩的尾部预算规划
 * （core/conversation/compaction-boundary）——两处对「阈值是什么」的答案恒一致。
 */
export function resolveContextThreshold(threshold?: number): number {
  if (!Number.isFinite(threshold) || (threshold as number) <= 0) {
    return CONTEXT_THRESHOLD_DEFAULT;
  }
  return Math.max(CONTEXT_THRESHOLD_MIN, Math.floor(threshold as number));
}

/**
 * 上下文窗口守卫（token 口径）。
 *
 * 计量与 context-meter（用量环 + 压缩触发）同源：全部经
 * utils/ai/token-estimate 的唯一实现（文本启发式估算 + 图片固定 1200 token），
 * 环上显示的 80%/90% 判定与实际裁剪行为不会漂移。
 *
 * 裁剪策略保持不变：system 优先保留（超限时按 token 预算截断其正文）、
 * tool 内容传输层截断（技能类工具除外，见 SKILL_CONTEXT_TOOL_NAMES）、
 * 非 system 消息按「原子组」从新到旧保留。
 */
export class ContextWindowGuard {
  static readonly TOOL_CONTENT_LIMIT = TOOL_CONTENT_LIMIT;

  static protect(messages: ChatMessage[], threshold?: number, options: { preserveToolContent?: boolean } = {}): ContextGuardResult {
    const safeThreshold = resolveContextThreshold(threshold);
    const normalizedMessages = messages.map((message, index) => this.normalizeMessage(message, index, options.preserveToolContent));
    const originalTokens = this.totalTokens(normalizedMessages);
    const toolContentsTrimmed = messages.reduce((count, message) => {
      // 技能类工具不做传输层截断（见 SKILL_CONTEXT_TOOL_NAMES），不应计入「已截断」
      if (options.preserveToolContent || message.role !== 'tool' || SKILL_CONTEXT_TOOL_NAMES.has(message.name ?? '')) {
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

    // system 消息 + 上下文压缩消息（assistant 角色的 <conversation-memory>
    // 记忆，新旧角色都认）共同构成「受保护区」：摘要按定义位于历史最前，
    // 若不单列保护，会被「从新到旧保留」当作最旧内容整条裁掉——模型随即
    // 失去全部既往记忆。保护区整体优先于非保护消息参与预算。
    const systemMessages = normalizedMessages.filter(
      message => message.role === 'system' || isCompactionSummaryMessage(message),
    );
    const nonSystemMessages = normalizedMessages.filter(
      message => message.role !== 'system' && !isCompactionSummaryMessage(message),
    );
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
      truncated: retainedNonSystemMessages.length < nonSystemMessages.length,
      removedMessages: normalizedMessages.length - finalMessages.length,
      toolContentsTrimmed,
    };
  }

  private static normalizeMessage(message: ChatMessage, index: number, preserveToolContent = false): NormalizedMessage {
    return {
      ...message,
      ...(message.nativeReplay ? { nativeReplay: structuredClone(message.nativeReplay) } : {}),
      __normalizedIndex: index,
      content: this.normalizeContent(message, preserveToolContent),
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

  private static normalizeContent(message: ChatMessage, preserveToolContent = false): ChatMessage['content'] {
    const { role, content } = message;
    // 技能类工具的结果按需注入且体量已受设计上限约束，不做传输层截断
    const trimmable = !preserveToolContent && role === 'tool' && !SKILL_CONTEXT_TOOL_NAMES.has(message.name ?? '');
    if (typeof content === 'string') {
      const sanitized = this.sanitizeText(content);
      return trimmable ? this.trimToolContent(sanitized) : sanitized;
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

      if (trimmable && normalizedPart.text) {
        normalizedPart.text = this.trimToolContent(normalizedPart.text);
      }

      return normalizedPart;
    });
  }

  private static sanitizeText(value: string): string {
    // 剥离 NUL 控制字符：OpenAI 等对话 API 会拒绝包含 NUL 的文本
    let sanitized = value.replaceAll(NUL_CHAR, '');
    // 孤立代理项 → U+FFFD：被劈开的增补平面字符（emoji 等）经 JSON.stringify
    // 会成为 "\ud8xx" 孤立转义——语法合法、语义非法，serde 系严格网关会整单
    // 400 且报错不含字段名。U+FFFD 替代与 UTF-8 编码器标准行为一致；本守卫是
    // 全部会话请求的最后一道闸（模型自产内容同样可能携带孤立代理项）。
    // 含代理项的文本才进入替换扫描（图片 base64 等纯 ASCII 零开销跳过）。
    if (HAS_SURROGATE_RE.test(sanitized)) {
      sanitized = sanitized.replace(LONE_SURROGATE_RE, '�');
    }
    return sanitized;
  }

  private static trimToolContent(content: string): string {
    if (content.length <= TOOL_CONTENT_LIMIT) {
      return content;
    }

    // 截断点回退孤立代理：切点落在高位代理（0xD800-0xDBFF）上时退 1 码元，
    // 避免产出半个增补平面字符（见 sanitizeText 的网关拒收说明）
    return `${trimDanglingSurrogate(content, TOOL_CONTENT_LIMIT)}\n...[tool response truncated to ${TOOL_CONTENT_LIMIT} chars]`;
  }

  /**
   * 在 token 预算内从新到旧保留消息（按原子组）。
   *
   * 原子组（buildAtomicGroups，模块级单一事实源实现）= assistant(tool_calls)
   * 与其全部配对 tool 结果消息：组内要么整体保留、要么整体丢弃。这满足全部
   * 协议的配对硬约束——OpenAI 要求 assistant.tool_calls 的每个 id 都有紧随的
   * tool 消息、Claude 要求 tool_use 与 tool_result 逐个配对、Gemini 要求
   * functionCall 与 functionResponse 成对——绝不允许「保留了工具调用却裁掉
   * 部分结果」的半配对形态。组长度一次性预计算，从新到旧累加，不会重复计入
   * 已保留消息。
   *
   * 图片消息按固定 1200 token 计入组成本（见 token-estimate）：单张截图
   * 不再以 base64 全长挤爆预算，多图历史也能按真实成本参与保留决策。
   */
  private static retainNewestMessagesWithinBudget(messages: NormalizedMessage[], budget: number): NormalizedMessage[] {
    if (budget <= 0 || messages.length === 0) {
      return [];
    }

    const groups = buildAtomicGroups(messages);
    const groupTokens = groups.map(group => this.totalTokens(group.map(index => messages[index])));

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
   * 受保护区（system + 上下文压缩消息）超阈值时按 token 预算裁剪正文。
   *
   * 两条独立的顺序（刻意分离）：
   *   - **预算分配顺序**：上下文压缩消息优先、主 system 提示词其次——记忆
   *     是任务上下文（丢了它模型就不知道在做什么，降级是灾难性的）；system
   *     提示词被截只丢掉靠后的次要分区（文本截断保留前缀：环境声明、交互
   *     准则、智能体指令等最关键的开头部分完整留存）；
   *   - **输出顺序**：始终保持原序——压缩消息紧随主提示词的位置不可漂移
   *     （否则 wire 上「权威记忆」会跑到请求末尾，语义与提示词声明相悖）。
   *
   * 硬不变量：**裁剪后总量不得超过阈值**。文本截断按「文本 token」预算计算，
   * 而消息总量还含 JSON 包装开销，二者存在数个 token 的取整差——不做收敛
   * 就会在边界上超限（守卫的职责是「装进窗口」，超限即失去意义）。
   *
   * 空内容处理：压缩记忆若被挤到没有实质内容，宁可整条不放入（空的
   * <conversation-memory> 比没有记忆更具误导性——模型会以为「记忆为空」）。
   * 普通 system 消息沿用既有行为（保留结构，正文可为空）。
   *
   * 注：本分支在引擎链路中恒伴随 `truncated=true` → 引擎随即以可读错误
   * 终止该轮（见 conversation-engine 的窗口守卫判定），不会真的发出去；
   * 但守卫是通用工具，输出仍必须自洽（预算不超限、顺序正确、结构完整）。
   */
  private static trimSystemMessagesToThreshold(messages: NormalizedMessage[], threshold: number): ChatMessage[] {
    if (messages.length === 0) {
      return [];
    }

    // 分配顺序：压缩记忆优先（任务上下文价值最高），主 system 提示词其次
    const allocationOrder = messages
      .map((message, index) => ({ message, index }))
      .sort((left, right) => {
        const rank = (message: NormalizedMessage) => (isCompactionSummaryMessage(message) ? 0 : 1);
        return rank(left.message) - rank(right.message);
      });

    let remaining = threshold;
    const trimmedByIndex = new Map<number, ChatMessage>();
    for (const { message, index } of allocationOrder) {
      if (remaining <= 0) {
        break;
      }

      const baseTokens = estimateMessageTokens({
        ...message,
        content: typeof message.content === 'string' ? '' : [],
      });
      const isMemory = isCompactionSummaryMessage(message);
      const build = (contentBudget: number): ChatMessage => ({
        role: message.role,
        content: this.trimContentToTokens(message.content, contentBudget),
        name: message.name,
        tool_calls: message.tool_calls,
        tool_call_id: message.tool_call_id,
      });

      // 预算收敛：按文本预算截断后实测消息总量可能仍略超剩余（JSON 包装
      // 开销的取整差）→ 逐轮收紧文本预算，直到装得下或文本预算归零
      let contentBudget = Math.max(remaining - baseTokens, 0);
      let next = build(contentBudget);
      let cost = estimateMessageTokens(next);
      for (let attempt = 0; attempt < 4 && cost > remaining && contentBudget > 0; attempt++) {
        contentBudget = Math.max(0, contentBudget - (cost - remaining) - 1);
        next = build(contentBudget);
        cost = estimateMessageTokens(next);
      }
      // 装不下（文本预算已归零）→ 不放入：宁可缺一条，也不让总量超阈值
      if (cost > remaining) {
        break;
      }
      // 压缩记忆被挤到没有实质内容 → 整条不放入（空信封比无记忆更具误导性）
      if (isMemory && typeof next.content === 'string' && next.content.trim().length === 0) {
        continue;
      }
      trimmedByIndex.set(index, next);
      remaining -= cost;
    }

    // 输出保持原序（未被分配到预算的消息自然缺席）
    return messages
      .map((_, index) => trimmedByIndex.get(index))
      .filter((message): message is ChatMessage => message !== undefined);
  }

  /**
   * 按 token 预算裁剪消息正文：
   *   - 字符串 content → sliceTextToTokenBudget（估算同源，保证裁后不超预算）；
   *   - 数组 content（防御路径：system 恒为字符串）→ 文本部件按剩余预算
   *     逐段截断，图片部件按固定 1200 token 扣预算、装不下即丢弃。
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
    return messages.reduce((total, message) => {
      const { __normalizedIndex: _index, ...wireMessage } = message as NormalizedMessage;
      return total + estimateMessageTokens(wireMessage);
    }, 0);
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

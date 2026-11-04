/**
 * LLM 摘要式上下文压缩器
 *
 * 职责：把「模型面历史消息」交给模型做一次性结构化摘要（流式输出，防止长负载
 * 非流式请求超时断链），产出可长期驻留的压缩记忆，替换原历史参与后续请求。
 *
 * 提示词设计参照业界实践（Claude Code /compact 的固定分区结构、Cline 的要点式
 * 摘要），核心原则：
 *   1. 固定 XML 分区输出（任务目标 / 约束偏好 / 关键事实 / 已完成进展 /
 *      错误与处理 / 待办与下一步），分区缺失信息即视为丢失；
 *   2. 防丢失硬性要求：用户原始诉求逐条保留、标识符（URL/文件名/笔记ID/工具名）
 *      原样保留、不得臆造，宁可长不可丢；
 *   3. 摘要以系统级消息注入并被窗口守卫优先保护（永不因超限被裁掉）。
 *
 * 防御性设计：
 *   - 压缩负载超过预算时分段摘要并归并，原文与图片均进入压缩输入，不删除最旧消息；
 *   - 流式输出失败 / 结果为空 → 抛 CompactionError，完整历史不能容纳时停止发送；
 *   - 剥离模型输出中的 <think> 推理段；无 <summary> 包裹时自动补包（格式自愈）。
 */

import { aiChatApi, type ChatMessage } from '../../utils/ai/ai-chat-api';
import { ApiRequestError } from '../../utils/stream/errors';
import { estimateTextTokens, sliceTextToTokenBudget, IMAGE_CONTEXT_TOKENS } from '../../utils/ai/token-estimate';
import type { ResolvedModelConfig } from '../types';

// ==================== 依赖注入（可测试性） ====================

export interface CompactorDeps {
  sendStream: typeof aiChatApi.sendStreamMessage;
}

const defaultDeps: CompactorDeps = {
  sendStream: (messages, callbacks, options) =>
    aiChatApi.sendStreamMessage(messages, callbacks, options),
};

// ==================== 错误与常量 ====================

/** 压缩失败（网络/空结果/中止）；调用方据此降级，绝不让压缩失败阻断对话主流程 */
export class CompactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompactionError';
  }
}

/** 压缩请求负载的安全上界（占上下文阈值比例） */
const PAYLOAD_RATIO_LIMIT = 0.9;

/** 压缩系统提示词（分区结构与防丢失要求） */
const COMPACTION_SYSTEM_PROMPT = `你是「对话记忆压缩器」。你的唯一任务：把一段浏览器助手 AgentNexus 的对话历史（含工具调用与结果）压缩为结构化摘要，供同一对话的后续轮次作为记忆使用。摘要质量决定助手能否继续完成任务，因此信息完整性优先于简短。

输出要求（严格遵守）：
1. 只输出一个 <summary> XML 元素，不要输出任何 XML 之外的解释文字。
2. 使用以下固定分区（分区内容为空时写"无"，不得省略分区）：

<summary>
  <task>用户的核心任务与目标。逐条保留用户的原始诉求（保留关键原话），多轮演进的意图变化要写清先后关系。</task>
  <constraints>用户明确的约束、偏好与规则（语言、格式、范围、禁止事项等）。</constraints>
  <key-facts>已确立的关键事实、数据、结论与决策。URL、文件名、笔记标题、页面标题、数字等标识符必须原样保留。</key-facts>
  <progress>已完成的工作与关键工具调用及其结果要点（做了什么、得到了什么、涉及哪些页面/站点）。无效与失败的尝试也要记录，避免重复执行。</progress>
  <errors>遇到的错误、失败原因与已尝试的处理；尚未解决的写明现状。</errors>
  <pending>尚未完成的事项、用户等待中的结果与约定的下一步行动。</pending>
</summary>

3. 防丢失硬性要求：
   - 用户消息的诉求一条都不能丢，关键表述保留原话；
   - 标识符（URL / 标题 / 笔记 ID / 工具名 / 数字与单位）原样保留，禁止改写或省略；
   - 只依据对话记录内容归纳，禁止臆造不存在的信息；
   - 在不丢失信息的前提下尽量精炼；信息与篇幅冲突时，保信息。`;

// ==================== 实现 ====================

export interface CompactionInput {
  /** 待压缩的模型面历史（不含本轮 system 提示词；可含旧摘要系统消息） */
  messages: ChatMessage[];
  model: ResolvedModelConfig;
  /** 上下文 token 阈值（用于限制压缩请求负载） */
  threshold: number;
  signal?: AbortSignal;
}

export interface CompactionResult {
  /** 清洗后的摘要文本（保证为 <summary>…</summary> 形态） */
  summary: string;
  /** 被压缩原文的 token 估算量 */
  originalTokens: number;
  /** 摘要的 token 估算量 */
  summaryTokens: number;
  /** 因负载超限被排除出压缩输入的最旧消息条数 */
  droppedOldest: number;
}

/** 剥离 <think> 推理段（与对话流展示层的清理规则一致） */
function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .trim();
}

/** 单条消息序列化为压缩输入的紧凑文本行 */
function serializeMessage(message: ChatMessage, index: number): string {
  const label = `[${index}] ${message.toolFeedbackFor?.length ? 'TOOL_FEEDBACK' : message.role.toUpperCase()}`;
  const parts: string[] = [];
  if (typeof message.content === 'string') {
    if (message.content) parts.push(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text' && part.text) parts.push(part.text);
      else if (part.type === 'image_url') parts.push('（附图）');
    }
  }
  if (message.tool_calls?.length) {
    for (const call of message.tool_calls) {
      parts.push(`[调用工具 ${call.function.name}，参数 ${call.function.arguments ?? '{}'}]`);
    }
  }
  if (message.role === 'tool' && message.name) {
    parts.unshift(`工具 ${message.name} 的结果：`);
  }
  return `${label}: ${parts.join('\n') || '（空）'}`;
}

export class ContextCompactor {
  constructor(private readonly deps: CompactorDeps = defaultDeps) {}

  /**
   * 执行一次压缩。任何失败以 CompactionError 抛出（含原始原因），由调用方降级。
   * 中止信号触发时同样抛错（abort 场景由上层按运行中止语义处理）。
   */
  async compact(input: CompactionInput): Promise<CompactionResult> {
    return this.compactInternal(input, 0, { calls: 0 });
  }

  private async compactInternal(input: CompactionInput, depth: number, budget: { calls: number }): Promise<CompactionResult> {
    if (input.signal?.aborted) throw new DOMException('Compaction aborted', 'AbortError');
    if (input.messages.length === 0) {
      throw new CompactionError('无可压缩的历史消息');
    }

    // Text serialization and image accounting share the normal context budget.
    // Actual images are attached separately, never encoded as prompt text.
    const payloadBudget = Math.max(1, Math.floor(input.threshold * PAYLOAD_RATIO_LIMIT) - estimateTextTokens(COMPACTION_SYSTEM_PROMPT) - 512);
    const lines = input.messages.map((message, index) => serializeMessage(message, index));
    const images = input.messages.map(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url' && part.image_url) : []);
    const costs = lines.map((line, index) => estimateTextTokens(line) + 1 + images[index].length * IMAGE_CONTEXT_TOKENS);
    const droppedOldest = 0;
    const totalTokens =
      costs.reduce((total, cost) => total + cost, 0);
    if (totalTokens > payloadBudget) {
      if (depth >= 3 || payloadBudget < 1024) throw new CompactionError('无法在当前窗口内完整压缩历史，原始记录已保留，请使用更大的上下文窗口');
      const groups: ChatMessage[][] = [];
      let group: ChatMessage[] = [], used = 0;
      const add = (message: ChatMessage, cost: number) => {
        if (cost > payloadBudget) throw new CompactionError('单张历史图片超出压缩预算，请使用更大的上下文窗口');
        if (used + cost > payloadBudget && group.length) { groups.push(group); group = []; used = 0; }
        group.push(message); used += cost;
      };
      for (let index = 0; index < lines.length; index++) {
        let remaining = lines[index];
        while (remaining) {
          const text = sliceTextToTokenBudget(remaining, payloadBudget - 256);
          if (!text) throw new CompactionError('压缩预算不足，无法完整保留文本');
          remaining = remaining.slice(text.length);
          const message: ChatMessage = { role: 'user', content: `[原记录 ${index} 的连续文本片段]\n${text}` };
          add(message, estimateTextTokens(serializeMessage(message, 0)) + 1);
        }
        for (const image of images[index]) {
          const message: ChatMessage = { role: 'user', content: [{ type: 'text', text: `原记录 ${index} 的视觉证据` }, image] };
          add(message, IMAGE_CONTEXT_TOKENS + 128);
        }
      }
      if (group.length) groups.push(group);
      const summaries: ChatMessage[] = [];
      for (let index = 0; index < groups.length; index++) {
        const result = await this.compactInternal({ ...input, messages: groups[index] }, depth + 1, budget);
        summaries.push({ role: 'user', content: `[按原始顺序的分段摘要 ${index + 1}/${groups.length}]\n${result.summary}` });
      }
      const merged = await this.compactInternal({ ...input, messages: summaries }, depth + 1, budget);
      return { ...merged, originalTokens: totalTokens, droppedOldest: 0 };
    }

    const userPayload =
      `[待压缩对话记录（按时间顺序，含工具调用与结果）]\n${lines.join('\n')}\n\n` +
      `请依据以上记录输出 <summary> 压缩摘要。`;
    const payloadContent: Exclude<ChatMessage['content'], string> = [{ type: 'text', text: userPayload }];
    for (let index = droppedOldest; index < images.length; index++) for (const image of images[index]) {
      payloadContent.push({ type: 'text', text: `以下图片属于记录 [${index}]；总结可确认的视觉证据，无法确认的内容必须明确标注。` }, image);
    }

    // ── 流式请求（长负载必须流式，避免非流式请求的超时断链） ──
    if (++budget.calls > 16) throw new CompactionError('完整压缩所需分段过多，已停止额外请求并保留原始记录，请使用更大的上下文窗口');
    let streamed = '';
    const { finalMessage } = await this.deps.sendStream(
      [
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        { role: 'user', content: payloadContent.length > 1 ? payloadContent : userPayload },
      ],
      {
        onToken: token => {
          streamed += token;
        },
        onReasoning: () => undefined,
        onToolCall: () => undefined,
        onComplete: () => undefined,
        onError: error => console.warn('[ContextCompactor] 压缩流式错误回调:', error),
      },
      {
        // Keep the endpoint's sampling defaults. Forcing a low temperature can
        // degrade newer reasoning models; preserve facts through the summary
        // instructions rather than silently changing model configuration.
        signal: input.signal,
        // 压缩与主对话共用同一运行级端点快照，保证协议一致
        endpoint: input.model,
        metrics: { kind: 'compaction' },
      },
    ).catch(error => {
      // ApiRequestError 携带的 Markdown 展示块不适合塞进单行降级通知，
      // 压缩为单行摘要；完整原始响应仍可通过控制台 error.cause 排查
      const detail =
        error instanceof ApiRequestError
          ? error.toSingleLine()
          : error instanceof Error
            ? error.message
            : String(error);
      const compactionError = new CompactionError(`压缩请求失败: ${detail}`);
      try {
        (compactionError as unknown as { cause?: unknown }).cause = error;
      } catch {
        /* cause 只读时忽略 */
      }
      throw compactionError;
    });

    // ── 结果清洗：去 think 段 → 兜底流式累积 → 空校验 → XML 自愈包裹 ──
    const rawSummary = stripThinkBlocks(
      typeof finalMessage.content === 'string' && finalMessage.content.trim()
        ? finalMessage.content
        : streamed,
    );
    if (!rawSummary) {
      throw new CompactionError('压缩结果为空');
    }

    const summary = /<summary[\s>]/i.test(rawSummary)
      ? rawSummary
      : `<summary>\n${rawSummary}\n</summary>`;

    return {
      summary,
      originalTokens: totalTokens,
      summaryTokens: estimateTextTokens(summary),
      droppedOldest,
    };
  }

  /** 摘要 → 注入用的系统消息（守卫将其作为 system 优先保护，永不因超限被裁） */
  buildSummaryMessage(summary: string, compactedAt: number): ChatMessage {
    const date = new Date(compactedAt);
    const timestamp = Number.isFinite(compactedAt) && compactedAt > 0 && Number.isFinite(date.getTime())
      ? date.toISOString() : '时间未记录';
    return {
      role: 'system',
      content:
        `<conversation-memory>\n` +
        `以下是对本会话先前对话的压缩摘要（压缩于 ${timestamp}）。` +
        `这是当前任务目标的权威记忆；摘要之后的消息是压缩后新增的对话。\n\n${summary}\n` +
        `</conversation-memory>`,
    };
  }
}

/** 全局单例（生产依赖） */
export const contextCompactor = new ContextCompactor();

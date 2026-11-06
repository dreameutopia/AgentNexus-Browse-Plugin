/**
 * LLM 摘要式上下文压缩器
 *
 * 职责：把「模型面历史消息」交给模型做一次性结构化摘要（流式输出，防止长负载
 * 非流式请求超时断链），产出可长期驻留的压缩记忆，替换原历史参与后续请求。
 *
 * 提示词设计参照业界实践（Claude Code /compact 的固定分区结构、Codex 的
 * handoff 语义、Cline 的要点式摘要），核心原则：
 *   1. 固定 XML 分区输出（当前核心目标 / 约束偏好 / 关键事实 / 当前进度 /
 *      错误经验 / 待办与下一步），分区缺失信息即视为丢失；
 *   2. 差分压缩力度：用户原话、约束、关键事实、错误原因、待办必须详尽保留，
 *      冗长工具输出（页面抽取/观察/调试）归纳为结论与关键数据；
 *   3. 防丢失硬性要求：用户原始诉求逐条保留、标识符（URL/文件名/笔记ID/工具名）
 *      原样保留、不得臆造，宁可长不可丢；篇幅有软约束（一般 ≤4000 token）但
 *      永不让位于凑短丢信息；
 *   4. plan_tool 的执行状态存储在会话计划库、不在对话记录内：摘要注入文案
 *      明确指引模型用 plan_tool read 回读权威进度，不凭摘要推断。
 *
 * 防御性设计：
 *   - 压缩负载超过预算时分段摘要并归并（原文与图片均进入压缩输入，不删除
 *     最旧消息）；分段受深度（≤3）、请求次数（≤16）与最小预算（≥1024）约束，
 *     超限时抛错保留原始记录，绝不静默丢内容；
 *   - 流式输出失败 / 结果为空 → 抛 CompactionError，由调用方降级（冷却重试），
 *     完整历史不能容纳时上层停止发送而非发送裁剪历史；
 *   - 剥离模型输出中的 <think> 推理段；无 <summary> 包裹时自动补包（格式自愈，
 *     历史存储的旧版摘要经 buildSummaryMessage 注入时同样自愈）；
 *   - 摘要以系统级消息注入并被窗口守卫优先保护（永不因超限被裁掉）。
 */

import { aiChatApi, type ChatMessage } from '../../utils/ai/ai-chat-api';
import { ApiRequestError } from '../../utils/stream/errors';
import { estimateTextTokens, sliceTextToTokenBudget, IMAGE_CONTEXT_TOKENS } from '../../utils/ai/token-estimate';
import { CONTEXT_THRESHOLD_DEFAULT } from '../../utils/channels/channel-types';
import type { ResolvedModelConfig } from '../types';
import { ensureSummaryWrapped } from './summary-message';

// 摘要记忆消息契约的再导出：调用方（引擎/边界规划/后台运行时/测试）沿用压缩器入口
export { ensureSummaryWrapped, isCompactionSummaryMessage, SUMMARY_MESSAGE_MARKER } from './summary-message';

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

/** 压缩请求负载的安全上界（占上下文阈值比例）；其余留给输出与传输开销 */
const PAYLOAD_RATIO_LIMIT = 0.9;

/**
 * 摘要体量告警线（占上下文阈值比例）。超过仅告警不失败——摘要偏大时压缩
 * 收益变薄，但内容仍是有效记忆；真正的「压缩未产生缓解」由引擎侧冷却兜底。
 */
const SUMMARY_SIZE_WARN_RATIO = 0.2;

/**
 * 压缩阈值的防御性归一：非法值（NaN / ±∞ / ≤0）回落共享默认。
 *
 * 刻意**不钳下限**（与 ContextWindowGuard.resolveContextThreshold 的差异）：
 * 压缩预算的安全性方向是「宁可更小」——调用方给出比注册表下限更紧的窗口时，
 * 按更紧的算；抬高预算反而可能在真实窗口不足时发出超限负载。上游
 * （modelRegistry）在生产路径恒传入已钳制的 contextThreshold，此归一只在
 * 防御层兜住协议脏数据与调用方笔误，同时保证 payloadBudget 的比较运算
 * 恒为合法数值比较（NaN 预算会让超限判定恒 false，静默绕过分段保护）。
 */
function resolveCompactionThreshold(threshold: number): number {
  return Number.isFinite(threshold) && threshold > 0 ? threshold : CONTEXT_THRESHOLD_DEFAULT;
}

/** 压缩系统提示词（分区结构 / 差分压缩 / 防丢失 / 篇幅约束 / plan_tool 口径） */
export const COMPACTION_SYSTEM_PROMPT = `你是「对话记忆压缩器」。你的唯一任务：把一段浏览器助手 AgentNexus 的对话历史（含工具调用与结果）压缩为结构化摘要，供同一对话的后续轮次作为记忆使用。摘要质量决定助手能否继续完成任务，因此信息完整性优先于简短。

输出要求（严格遵守）：
1. 只输出一个 <summary> XML 元素，XML 之外不得有任何解释文字。
2. 摘要体内依次包含以下固定分区（分区内容为空时写"无"，不得省略分区、不得改用其他标签名）：

<summary>
  <task>当前核心目标：用户的核心任务与目标。逐条保留用户的原始诉求（关键表述保留原话）；多轮演进的意图变化写清先后关系与最新目标。</task>
  <constraints>用户明确的约束、偏好与规则（语言、格式、范围、禁止事项等）。</constraints>
  <key-facts>已确立的关键事实、数据、结论与决策。URL、文件名、笔记标题、页面标题、数字与单位等标识符必须原样保留。</key-facts>
  <progress>当前进度：已完成的工作与关键工具调用及其结果要点（做了什么、得到了什么、涉及哪些页面/站点），按推进顺序组织。</progress>
  <errors>错误经验：遇到的错误、失败原因与已尝试的处理；尚未解决的写明现状。失败尝试同样重要，必须记录以避免重复执行。</errors>
  <pending>待办与下一步：尚未完成的事项、用户等待中的结果与约定的下一步行动。任务计划（plan_tool）的执行状态存储在会话计划库中、不在本记录内，此处不得臆造计划状态。</pending>
</summary>

3. 差分压缩（不同内容不同力度）：
   - 必须详尽保留：用户原话诉求、约束与偏好、关键事实与决策、错误及其原因、待办事项；
   - 大幅压缩：冗长的工具输出（页面全文抽取、DOM/观察结果、重复的探查与调试输出、长列表与重复样本）→ 归纳为结论与关键数据，标识符原样保留；
   - 可以丢弃：与任务无关的寒暄、重复表述、已被后续结果推翻的中间过程。

4. 防丢失硬性要求：
   - 用户消息的诉求一条都不能丢，关键表述保留原话；
   - 标识符（URL / 标题 / 笔记 ID / 工具名 / 数字与单位）原样保留，禁止改写或省略；
   - 只依据对话记录内容归纳，禁止臆造不存在的信息；
   - 在不丢失信息的前提下尽量精炼；信息与篇幅冲突时，保信息。

5. 篇幅约束：整个摘要一般控制在 4000 token 以内；信息确实庞大时可适当超出，但不得为凑短而丢弃任何用户诉求、关键事实、错误经验或待办。`;

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
    const result = await this.compactInternal(input, 0, { calls: 0 });
    const threshold = resolveCompactionThreshold(input.threshold);
    if (result.summaryTokens > threshold * SUMMARY_SIZE_WARN_RATIO) {
      console.warn(
        `[ContextCompactor] 摘要体量偏大（${result.summaryTokens} token，占阈值 ` +
          `${Math.round((result.summaryTokens / threshold) * 100)}%），压缩收益变薄；已保留完整摘要`,
      );
    }
    return result;
  }

  private async compactInternal(input: CompactionInput, depth: number, budget: { calls: number }): Promise<CompactionResult> {
    if (input.signal?.aborted) throw new DOMException('Compaction aborted', 'AbortError');
    if (input.messages.length === 0) {
      throw new CompactionError('无可压缩的历史消息');
    }

    // Text serialization and image accounting share the normal context budget.
    // Actual images are attached separately, never encoded as prompt text.
    // 阈值先经防御性归一：NaN/≤0 会让预算比较恒 false，静默绕过分段保护。
    const safeThreshold = resolveCompactionThreshold(input.threshold);
    const payloadBudget = Math.max(1, Math.floor(safeThreshold * PAYLOAD_RATIO_LIMIT) - estimateTextTokens(COMPACTION_SYSTEM_PROMPT) - 512);
    const lines = input.messages.map((message, index) => serializeMessage(message, index));
    const images = input.messages.map(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url' && part.image_url) : []);
    const costs = lines.map((line, index) => estimateTextTokens(line) + 1 + images[index].length * IMAGE_CONTEXT_TOKENS);
    const totalTokens =
      costs.reduce((total, cost) => total + cost, 0);
    if (totalTokens > payloadBudget) {
      if (depth >= 3 || payloadBudget < 1024) throw new CompactionError('无法在当前窗口内完整压缩历史，原始记录已保留，请使用更大的上下文窗口');
      const groups: ChatMessage[][] = [];
      let group: ChatMessage[] = [], used = 0;
      const add = (message: ChatMessage, cost: number) => {
        if (cost > payloadBudget) {
          // 带实际数值：现场可定位是「窗口过小」而非「实现错误」
          throw new CompactionError(
            `单张历史图片（约 ${IMAGE_CONTEXT_TOKENS} token）超出压缩预算（${payloadBudget} token），` +
              '原始记录已保留，请使用更大的上下文窗口',
          );
        }
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
      return { ...merged, originalTokens: totalTokens };
    }

    const userPayload =
      `[待压缩对话记录（按时间顺序，含工具调用与结果）]\n${lines.join('\n')}\n\n` +
      `请依据以上记录输出 <summary> 压缩摘要。`;
    const payloadContent: Exclude<ChatMessage['content'], string> = [{ type: 'text', text: userPayload }];
    for (let index = 0; index < images.length; index++) for (const image of images[index]) {
      payloadContent.push({ type: 'text', text: `以下图片属于记录 [${index}]；总结可确认的视觉证据，无法确认的内容必须明确标注。` }, image);
    }

    // ── 流式请求（长负载必须流式，避免非流式请求的超时断链） ──
    if (++budget.calls > 16) throw new CompactionError('完整压缩所需分段过多，已停止额外请求并保留原始记录，请使用更大的上下文窗口');
    let streamed = '';
    const response = await this.deps.sendStream(
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

    // ── 结果清洗：适配器契约防御 → 去 think 段 → 兜底流式累积 → 空校验 → XML 自愈包裹 ──
    // finalMessage 缺失/形态异常（协议脏数据或适配器缺陷）不得以解构 TypeError
    // 崩溃——回落流式累积；两者皆空由下方空结果错误以可读文案收敛。
    const finalContent =
      response?.finalMessage && typeof response.finalMessage.content === 'string'
        ? response.finalMessage.content
        : '';
    const rawSummary = stripThinkBlocks(finalContent.trim() ? finalContent : streamed);
    if (!rawSummary) {
      throw new CompactionError('压缩结果为空');
    }

    const summary = ensureSummaryWrapped(rawSummary);
    return {
      summary,
      originalTokens: totalTokens,
      summaryTokens: estimateTextTokens(summary),
    };
  }

  /**
   * 摘要 → 注入用的系统消息（守卫将其作为 system 优先保护，永不因超限被裁）。
   *
   * 文案三重职责：
   *   1. 权威记忆声明 + 冲突规则（摘要 vs 摘要之后的消息，以后者为准）；
   *   2. plan_tool 回读引导——计划执行状态不在摘要内，需要进度先 read，
   *      以读取结果为权威（与 plan-prompt 的「以读到的为准」同一口径）；
   *   3. 防御性补包：历史存储的旧版摘要可能没有 <summary> 包裹，注入前自愈。
   */
  buildSummaryMessage(summary: string, compactedAt: number, compactedMessages?: number): ChatMessage {
    const date = new Date(compactedAt);
    const timestamp = Number.isFinite(compactedAt) && compactedAt > 0 && Number.isFinite(date.getTime())
      ? date.toISOString() : '时间未记录';
    const scope = Number.isFinite(compactedMessages) && (compactedMessages as number) > 0
      ? `，覆盖此前 ${compactedMessages} 条消息` : '';
    // 剥离摘要体内残留的旧包裹标签：二次压缩的输入会把上一轮 <conversation-memory>
    // 信封原文序列化给模型，模型可能原样回显——嵌套信封对协议无害但语义混乱，
    // 注入前统一剥掉（只剥标签本身，内容原样保留）。
    const body = summary.replaceAll(/<\/?conversation-memory>/g, '').trim();
    return {
      role: 'system',
      content:
        `<conversation-memory>\n` +
        `以下是对本会话先前对话的压缩摘要（压缩于 ${timestamp}${scope}）。` +
        `这是当前任务目标的权威记忆；摘要之后的消息是压缩后新增的对话，两者冲突时以之后的消息为准。\n` +
        `任务计划（plan_tool）的执行状态不在本摘要内：需要剩余步骤或各项状态时，先调用 plan_tool read，以读取结果为权威，不要凭摘要推断计划进度。\n\n` +
        `${ensureSummaryWrapped(body)}\n` +
        `</conversation-memory>`,
    };
  }
}

/** 全局单例（生产依赖） */
export const contextCompactor = new ContextCompactor();

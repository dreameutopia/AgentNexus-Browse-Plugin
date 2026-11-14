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

import { aiChatApi, type ChatMessage, type VisionContent } from '../../utils/ai/ai-chat-api';
import { ApiRequestError } from '../../utils/stream/errors';
import {
  estimateTextTokens,
  sliceTextToTokenBudget,
  sliceTextTailToTokenBudget,
  IMAGE_CONTEXT_TOKENS,
} from '../../utils/ai/token-estimate';
import { CONTEXT_THRESHOLD_DEFAULT } from '../../utils/channels/channel-types';
import type { ResolvedModelConfig } from '../types';
import { ensureSummaryWrapped, isCompactionSummaryMessage, summaryBodyOnly } from './summary-message';
import {
  COMPACTION_PROMPT_PRE_RUN,
  COMPACTION_PROMPT_RUNTIME,
  compactionPromptFor,
  type CompactionStrategy,
} from './compaction-prompts';

// 摘要记忆消息契约的再导出：调用方（引擎/边界规划/后台运行时/测试）沿用压缩器入口
export { ensureSummaryWrapped, isCompactionSummaryMessage, SUMMARY_MESSAGE_MARKER } from './summary-message';
// 压缩策略的再导出：引擎/后台按时机传入 strategy；双提示词配置单一事实源在 compaction-prompts
export {
  COMPACTION_PROMPT_PRE_RUN,
  COMPACTION_PROMPT_RUNTIME,
  compactionPromptFor,
  type CompactionStrategy,
} from './compaction-prompts';

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

/**
 * 内部信号：分段摘要触顶（深度或请求次数上限），需转入**一次性截断兜底**。
 *
 * 只在顶层（compact）捕获并处理：兜底把**整个原始载荷**按「从后往前保留」
 * 裁剪到预算内后发起**一次**压缩请求。若在递归内部处理，同一载荷会被多个
 * 分段各自截断（信息多处丢失、请求次数失控），且兜底结果无法再归并。
 */
class TrimFallbackRequired extends Error {
  constructor() {
    super('compaction trim fallback required');
    this.name = 'TrimFallbackRequired';
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
 * 摘要必须包含的分区（与 compaction-prompts 的 PARTITION_TEMPLATE 同源）。
 *
 * 六个分区承载压缩后的全部可续跑依据：目标 / 约束 / 关键事实 / 进度 /
 * 错误经验 / 待办。缺任一分区 = 该维度记忆直接丢失，因此摘要落地前
 * 逐个校验（见 assertSummaryStructure）。
 */
const REQUIRED_SUMMARY_PARTITIONS = [
  'task',
  'constraints',
  'key-facts',
  'progress',
  'errors',
  'pending',
] as const;

/**
 * 分段摘要的请求次数上限（防线一的请求预算）。
 *
 * 触顶后的收敛：不再直接失败，而是转入**截断兜底**（最后一次请求，按
 * 「从后往前保留」裁剪负载）——分段优先、截断兜底（Q2 决策）。兜底自身
 * 再无可用额度时才报可读错误。总额度 = 本上限 + 1 次兜底请求。
 */
const MAX_SEGMENT_REQUESTS = 16;

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

export interface CompactionInput {
  /** 待压缩的模型面历史（不含本轮 system 提示词；可含旧摘要消息） */
  messages: ChatMessage[];
  model: ResolvedModelConfig;
  /** 上下文 token 阈值（用于限制压缩请求负载） */
  threshold: number;
  signal?: AbortSignal;
  /**
   * 压缩时机策略（决定使用哪份提示词，见 compaction-prompts）。
   * 缺省 = pre-run（向后兼容：不传即会话归档口径）。
   */
  strategy?: CompactionStrategy;
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
    // 压缩消息（摘要的摘要）只取内容本体：外层信封的样板与内容无关，
    // 喂回压缩模型会诱导其复制样板、并白白占用压缩预算
    if (isCompactionSummaryMessage(message)) {
      const body = summaryBodyOnly(message);
      if (body) parts.push(body);
    } else if (message.content) {
      parts.push(message.content);
    }
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
   *
   * 两道防线（Q2 决策「分段优先 + 截断兜底」）：
   *   1. 无损分段摘要：超预算内容切段压缩再归并，内容不丢；
   *   2. 截断兜底：分段触顶（深度 ≥3 或请求次数用尽）时，把整个载荷按
   *      「从后往前保留」裁剪到预算内，发起**一次**压缩请求（最旧内容被
   *      丢弃但留痕告警）；再失败才以可读错误收敛。
   */
  async compact(input: CompactionInput): Promise<CompactionResult> {
    let result: CompactionResult;
    try {
      result = await this.compactInternal(input, 0, { calls: 0 });
    } catch (error) {
      if (!(error instanceof TrimFallbackRequired)) throw error;
      result = await this.compactTrimmedPayload(input);
    }
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
    const systemPrompt = compactionPromptFor(input.strategy);
    const payloadBudget = Math.max(1, Math.floor(safeThreshold * PAYLOAD_RATIO_LIMIT) - estimateTextTokens(systemPrompt) - 512);
    const lines = input.messages.map((message, index) => serializeMessage(message, index));
    const images = input.messages.map(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url' && part.image_url) : []);
    const costs = lines.map((line, index) => estimateTextTokens(line) + 1 + images[index].length * IMAGE_CONTEXT_TOKENS);
    const totalTokens =
      costs.reduce((total, cost) => total + cost, 0);
    if (totalTokens > payloadBudget) {
      // 防线一（无损）：分段摘要——超预算内容切段压缩再归并，内容不丢；
      // 防线二（有损兜底）：分段三层仍无法收敛时转顶层一次性截断（见 compact）。
      if (depth >= 3) throw new TrimFallbackRequired();
      if (payloadBudget < 1024) {
        throw new CompactionError('无法在当前窗口内完整压缩历史，原始记录已保留，请使用更大的上下文窗口');
      }
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
    // 请求次数上限是「分段触顶」的一种形态：触顶时不再直接失败，而是转入
    // 顶层一次性截断兜底（分段优先、截断兜底，Q2 决策）。
    if (budget.calls >= MAX_SEGMENT_REQUESTS) {
      throw new TrimFallbackRequired();
    }
    budget.calls += 1;
    const rawSummary = await this.requestSummary(input, systemPrompt, userPayload, payloadContent);
    const summary = ensureSummaryWrapped(rawSummary);
    const missing = this.missingSummaryPartitions(summary);
    if (missing.length > 0) {
      // 结构不合规的摘要**不直接采用**：分区缺失意味着对应维度的记忆直接
      // 丢失（缺 <pending> 就是待办丢失、缺 <key-facts> 就是批次 ID 丢失）。
      // 但也**不直接失败**：摘要模型偶尔会漏写分区，一次失败就放弃压缩
      // 会让上下文无限增长——那比一份不完美的摘要更糟。折中：再要一次
      // （带明确的缺失清单），仍不合规则**接受并在注入时标注**，
      // 让模型知道哪些维度没有可靠记忆（由 plan_tool read / list 兜底）。
      const repaired = await this.repairSummary(input, systemPrompt, userPayload, payloadContent, missing, budget);
      if (repaired) return repaired;
    }
    return {
      summary,
      originalTokens: totalTokens,
      summaryTokens: estimateTextTokens(summary),
    };
  }

  /**
   * 结构不合规时的**一次定向修复**：把缺失的分区名明确告知摘要模型再要一次。
   *
   * 为什么只修一次：修复是额外的模型往返（实测单次压缩已需 ~139 秒），
   * 连续修复说明模型与契约不合，再要也未必对——那属于提示词/模型侧问题，
   * 应在冷却后由下一轮重试，而不是在此无限循环。
   */
  private async repairSummary(
    input: CompactionInput,
    systemPrompt: string,
    userPayload: string,
    payloadContent: Exclude<ChatMessage['content'], string>,
    missing: readonly string[],
    budget: { calls: number },
  ): Promise<{ summary: string; originalTokens: number; summaryTokens: number } | null> {
    if (budget.calls >= MAX_SEGMENT_REQUESTS) return null;
    budget.calls += 1;
    const hint =
      `\n\n【结构补正】上一次摘要缺少以下分区：${missing.join('、')}。` +
      '请**重新输出完整摘要**，六个分区必须全部存在（内容为空的分区写"无"）：' +
      `${REQUIRED_SUMMARY_PARTITIONS.join('、')}。只输出 <summary> 元素。`;
    try {
      const raw = await this.requestSummary(
        input,
        systemPrompt,
        userPayload + hint,
        payloadContent.length > 1
          ? payloadContent
          : ([{ type: 'text', text: userPayload + hint }] as Exclude<ChatMessage['content'], string>),
      );
      const summary = ensureSummaryWrapped(raw);
      const stillMissing = this.missingSummaryPartitions(summary);
      if (stillMissing.length > 0) {
        console.warn(
          `[ContextCompactor] 摘要结构补正后仍缺少分区：${stillMissing.join('、')}——` +
            '采用不完整摘要并在注入时标注缺失维度',
        );
      }
      return {
        summary,
        originalTokens: 0,
        summaryTokens: estimateTextTokens(summary),
      };
    } catch (error) {
      console.warn('[ContextCompactor] 摘要结构补正请求失败：', error);
      return null;
    }
  }

  /**
   * 摘要结构校验：六个分区必须齐全。
   *
   * 为什么校验（而不是"模型写了就收"）：分区缺失意味着**对应维度的记忆
   * 直接丢了**——缺 <pending> 就是待办丢失，缺 <key-facts> 就是关键事实
   * （含批次 ID）丢失，缺 <task> 就是目标丢失。这些是压缩后继续推进的
   * 全部依据，丢了之后模型只能凭残缺的上下文重建，等于压缩白做。
   */
  private missingSummaryPartitions(summary: string): string[] {
    return REQUIRED_SUMMARY_PARTITIONS.filter(
      partition => !new RegExp(`<${partition}>[\\s\\S]*?</${partition}>`).test(summary),
    );
  }

  /**
   * 发起一次压缩请求并清洗结果（两条路径共用：正常分段与截断兜底）。
   *
   * 清洗契约：适配器契约防御 → 去 think 段 → 兜底流式累积 → 空校验；
   * 空结果以可读错误收敛（调用方按失败降级冷却）。
   */
  private async requestSummary(
    input: CompactionInput,
    systemPrompt: string,
    userPayload: string,
    payloadContent: Exclude<ChatMessage['content'], string>,
  ): Promise<string> {
    let streamed = '';
    const response = await this.deps.sendStream(
      [
        { role: 'system', content: systemPrompt },
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

    // ── 结果清洗：适配器契约防御 → 去 think 段 → 兜底流式累积 → 空校验 ──
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
    return rawSummary;
  }

  /**
   * 分段摘要触顶后的**一次性有损兜底**：按「从后往前保留」把整个载荷截到
   * 预算内，再发起一次压缩请求。
   *
   * 触发条件（防线一触顶）：递归深度 ≥ 3，或分段请求次数用尽。
   * 语义要点：
   *   - 从最新记录向最旧连续累加，放不下即停——与窗口守卫的「从新到旧保留」
   *     同一语义（不跳过中间记录凑数，时序连续）；
   *   - 单条记录超预算时保留其**尾部**文本（超长工具结果的结论通常在末尾）；
   *   - 截掉的最旧记录只在分段无法收敛时发生，console.warn 留痕；原始记录
   *     在转录侧完整保留，本方法只影响压缩输入；
   *   - 单图超预算不走截断（一张图放不下说明阈值已低于图片固定成本的退化
   *     情形），沿用既有的可读错误。
   */
  private async compactTrimmedPayload(input: CompactionInput): Promise<CompactionResult> {
    if (input.signal?.aborted) throw new DOMException('Compaction aborted', 'AbortError');
    const safeThreshold = resolveCompactionThreshold(input.threshold);
    const systemPrompt = compactionPromptFor(input.strategy);
    const payloadBudget = Math.max(1, Math.floor(safeThreshold * PAYLOAD_RATIO_LIMIT) - estimateTextTokens(systemPrompt) - 512);
    if (payloadBudget < 1024) {
      throw new CompactionError('无法在当前窗口内完整压缩历史，原始记录已保留，请使用更大的上下文窗口');
    }

    const lines = input.messages.map((message, index) => serializeMessage(message, index));
    const images = input.messages.map(message =>
      Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'image_url' && part.image_url)
        : [],
    );
    const costs = lines.map((line, index) => estimateTextTokens(line) + 1 + images[index].length * IMAGE_CONTEXT_TOKENS);
    const totalTokens = costs.reduce((total, cost) => total + cost, 0);

    const keptIndices: number[] = [];
    let used = 0;
    for (let index = lines.length - 1; index >= 0; index--) {
      const cost = costs[index];
      if (used + cost > payloadBudget) break;
      used += cost;
      keptIndices.unshift(index);
    }
    let keptLines: string[];
    let keptImages: (readonly VisionContent[])[];
    if (keptIndices.length === 0) {
      // 最新一条也放不下：超长单条保留其尾部文本（从后往前保留的行内对偶）
      const last = lines[lines.length - 1] ?? '';
      const keptText = sliceTextTailToTokenBudget(last, Math.max(1, payloadBudget - 256));
      if (!keptText) {
        throw new CompactionError('压缩预算不足，无法保留任何记录，原始记录已保留');
      }
      keptLines = [`${keptText}\n[原记录过长，仅保留其末尾片段]`];
      keptImages = [[]];
    } else {
      keptLines = keptIndices.map(index => lines[index]);
      keptImages = keptIndices.map(index => images[index]);
    }
    const dropped = input.messages.length - keptIndices.length;
    if (dropped > 0) {
      console.warn(
        `[ContextCompactor] 分段摘要已触顶（深度或请求次数上限），按「从后往前保留」截掉最旧 ${dropped} 条记录后压缩；` +
          '原始记录在转录中完整保留，仅压缩输入被裁剪',
      );
    }

    const userPayload =
      `[待压缩对话记录（按时间顺序，含工具调用与结果；最旧记录可能已被截断）]\n${keptLines.join('\n')}\n\n` +
      `请依据以上记录输出 <summary> 压缩摘要。`;
    const payloadContent: Exclude<ChatMessage['content'], string> = [{ type: 'text', text: userPayload }];
    for (let index = 0; index < keptImages.length; index++) for (const image of keptImages[index]) {
      payloadContent.push({ type: 'text', text: `以下图片属于记录 [${index}]；总结可确认的视觉证据，无法确认的内容必须明确标注。` }, image);
    }

    const rawSummary = await this.requestSummary(input, systemPrompt, userPayload, payloadContent);
    const summary = ensureSummaryWrapped(rawSummary);
    const missing = this.missingSummaryPartitions(summary);
    if (missing.length > 0) {
      // 截断兜底路径已无预算再修一次：采用不完整摘要，但在注入时标注缺失维度，
      // 让模型知道哪些记忆不可靠（由 plan_tool read / data_ref list 兜底）。
      console.warn(
        `[ContextCompactor] 截断兜底摘要缺少分区：${missing.join('、')}——` +
          '采用不完整摘要并在注入时标注缺失维度',
      );
    }
    return {
      summary,
      originalTokens: totalTokens,
      summaryTokens: estimateTextTokens(summary),
    };
  }

  /**
   * 摘要 → 注入用的**上下文压缩消息**（assistant 角色；见 summary-message 的
   * 角色契约：systemPrompt 不归上下文引擎管理，摘要绝不以 system 注入）。
   * 守卫将其按系统级优先保护，永不因超限被裁（context-window-guard）。
   *
   * 文案三重职责：
   *   1. 权威记忆声明 + 冲突规则（摘要 vs 摘要之后的消息，以后者为准）；
   *   2. plan_tool 回读引导——计划执行状态不在摘要内，需要进度先 read，
   *      以读取结果为权威（与 plan-prompt 的「以读到的为准」同一口径），
   *      随摘要自动拼接、无需调用方另行注入；
   *   3. **暂存区形态核验引导**——摘要是模型写的**转述**，批次结构可能被
   *      概括得比真实结构更简单；引用批次前先 list/info 核对真实形态，
   *      否则模型会基于错误结构做投影或导出（实测：摘要说批次"含 base 与
   *      skuPrices"，模型据此推断 extract 能取到 base，实际取不到，
   *      于是把 15 个页面全部重抓了一遍）。核对成本是一次 list 调用，
   *      远低于重抓。
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
      role: 'assistant',
      content:
        `<conversation-memory>\n` +
        `以下是对本会话先前对话的压缩摘要（压缩于 ${timestamp}${scope}）。` +
        `这是当前任务目标的权威记忆；摘要之后的消息是压缩后新增的对话，两者冲突时以之后的消息为准。\n` +
        `任务计划（plan_tool）的执行状态不在本摘要内：需要剩余步骤或各项状态时，先调用 plan_tool read，以读取结果为权威，不要凭摘要推断计划进度。\n` +
        `数据批次（dataRef）与结果文件（results/…json）在摘要里可能只保留了名字与大致结构：**引用前先核对真实形态**——refs 用 data_ref_tool(action="list"/"info")、结果文件用 data_ref_tool(action="info", file=路径) 或 js_run(action="read", path=路径, index=1)（字段名、嵌套关系、行数），再决定怎么投影/导出——摘要的转述不能替代实测形态。\n\n` +
        `${ensureSummaryWrapped(body)}\n` +
        `</conversation-memory>`,
    };
  }
}

/** 全局单例（生产依赖） */
export const contextCompactor = new ContextCompactor();

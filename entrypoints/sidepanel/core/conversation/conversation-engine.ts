import { getPluginSnapshot, onPluginsChange } from '@/utils/plugins/catalog';
import { invariant, isPluginRef, ownerOf } from '@/utils/plugins/contracts';
/**
 * 会话引擎
 *
 * 职责：接收装配好的 ConversationRuntime，驱动「流式请求 → 工具执行 → 继续请求」循环
 * 直至完成，全程向观察者发送 UI 框架无关的事件，并把结果写入转录（用户面）。
 *
 * 边界（刻意为之）：
 *   - 对 agent / skill 概念零感知（只认 runtime 里的 systemPrompt / toolIds / vision 配置）
 *   - 不触碰任何 Vue 响应式状态；UI 由 App 层订阅事件自行渲染
 *   - 并发模型：同一 chatId 同时只允许一个运行（重复启动抛 ChatBusyError），
 *     不同 chatId 天然并行；abort 按 chatId 独立
 *
 * 行为对齐：工具循环上限/时长守卫与连续失败守卫（经 onLimitReached 回调交由
 * UI 决策是否继续，阈值均可经应用设置配置）、单轮多工具按调用顺序**串行**执行
 * （每个调用独立超时/可中止；因中止或时长上限未开始的调用以可读错误响应收尾，
 * 保证 assistant.tool_calls 与 tool 结果严格配对）、单工具 120s 超时（定时器在
 * 完成/失败/中止路径均清理）、工具执行可中止（用户停止即刻生效，不被最长超时
 * 卡住；中止统一回传「用户主动中断会话导致工具中断运行」）、工具参数「完整 JSON
 * 优先，首行 JSON 兜底」的解析阶梯、vision 截图→多模态→工具后重截图（截图带
 * 独立超时与中止通道，绝不悬挂运行）、
 * 流式 token/reasoning 增量以事件外发（UI 渲染与转录同源；中止后不再累积）、
 * 终止原因分诊（length 截断注记 / content_filter 按错误收尾 / 空响应防御）、
 * 声明 requiresApproval 的工具经 onToolApproval 人审放行（默认拒绝，安全侧；
 * 审批等待有界，防 UI 通道失联时运行永久悬停）、
 * 窗口裁剪时向模型注入事实注记（防「早期对话仍在」的幻觉假设）、
 * abort 在准备阶段（预登记）与运行阶段均即时生效，且先于一切守卫决策。
 */

import { aiChatApi, type ChatMessage } from '../../utils/ai/ai-chat-api';
import { openaiToolsConverter } from '../../utils/tools/openai-tools-converter';
import { appendSystemTimestamp } from '../../utils/system-time';
import { t } from '@/utils/i18n/core';
import type { ToolExecutionContext } from '@/tools/registry';
import { transcriptEngine } from '../context/transcript-engine';
import { contextEngine, toModelFacingContent } from '../context/context-engine';
import { storeProtocolMessages } from '../context/protocol-history';
import { contextCompactor } from '../context/compactor';
import { measureContextUsage, COMPACTION_RUNTIME_RATIO } from '../context/context-meter';
import { imageStore } from '../images/image-store';
import { toApiErrorBlock } from '../../utils/stream/errors';
import { INTERACTIVE_TOOL_NAMES } from '@/tools/interact/interact-prompt';
import { ensurePlansHydrated, getPlan } from '@/utils/plan/plan-store';
import { buildPlanReminder, needsPlanReminder } from './plan-reminder';
import { toolRegistry } from '@/tools/registry';
import { skillEngine } from '../registry/skill-engine';
import { filterVisionAssistantTools, isVisionAssistantTool } from '@/utils/agents/vision-assistant-policy';
import { needsVisionRefresh, takeVisionToolImage, withoutVisionImage, VISION_TOOL_SETTLE_DELAY_MS, type VisionToolImage } from './vision-feedback';
import { GENERIC_WAIT_TOOL_ID, waitExecutionTimeout } from '@/tools/common/wait-contract';
import type {
  ChatMessageRecord,
  ContextUsage,
  ConversationEvent,
  ConversationRuntime,
  RunSummary,
} from '../types';
import type { ToolCallUI } from '../../types/chat';
import type { ToolResult } from '@/common/tool-handler';

// ==================== 依赖注入（可测试性） ====================

export interface ConversationDeps {
  /** 文本流式请求 */
  sendStream: (
    messages: ChatMessage[],
    callbacks: Parameters<typeof aiChatApi.sendStreamMessage>[1],
    options: Parameters<typeof aiChatApi.sendStreamMessage>[2],
  ) => ReturnType<typeof aiChatApi.sendStreamMessage>;
  /** 视觉流式请求 */
  sendVision: (
    messages: ChatMessage[],
    callbacks: Parameters<typeof aiChatApi.sendVisionMessage>[1],
    options: Parameters<typeof aiChatApi.sendVisionMessage>[2],
  ) => ReturnType<typeof aiChatApi.sendVisionMessage>;
  /**
   * 工具执行。context 携带发起调用的会话 id，供会话感知工具（如 plan_tool）
   * 做数据隔离；不感知会话的工具可忽略。
   */
  executeTool: (
    name: string,
    parameters: unknown,
    context?: ToolExecutionContext,
  ) => Promise<ToolResult>;
  /**
   * 查询工具（按本次执行参数）是否需要用户批准（破坏性/不可逆操作的人审门）。
   * 引擎对注册表零感知，审批要求由注入方提供；缺省视为无需批准。
   * 第二参数为解析后的工具参数：支撑「单工具多操作」的 action 级审批
   * （如 note_tool 仅 delete 需要放行）。
   */
  requiresApproval: (name: string, args: unknown) => boolean;
}

const defaultDeps: ConversationDeps = {
  sendStream: (messages, callbacks, options) =>
    aiChatApi.sendStreamMessage(messages, callbacks, options),
  sendVision: (messages, callbacks, options) =>
    aiChatApi.sendVisionMessage(messages, callbacks, options),
  executeTool: (name, parameters, context) => openaiToolsConverter.executeTool(name, parameters, context),
  requiresApproval: (name, args) => openaiToolsConverter.requiresApproval(name, args),
};

// ==================== 运行选项与错误 ====================

/** 守卫种类：轮数/时长上限（既有）与连续工具失败（防模型重复撞墙烧 token） */
export type GuardKind = 'max-iterations' | 'max-duration' | 'tool-failures';

/** 工具审批请求（onToolApproval 回调入参）：足够用户判断「是否放行」的最小信息集 */
export interface ToolApprovalRequest {
  /** 工具调用 id（与 tool-call 事件一致，UI 可定位） */
  id: string;
  /** 工具名 */
  name: string;
  /** 参数预览（截断至安全长度；审批只需判断意图，无需全文） */
  argumentsPreview: string;
}

export interface RunOptions {
  /** 事件观察者（异常会被吞掉并告警，不影响运行） */
  observer?: (event: ConversationEvent) => void;
  /**
   * 达到守卫触发条件（轮数/时长上限、连续工具失败）时的延续确认；
   * 返回 true 重置守卫继续运行。
   * 缺省行为：终止并在回复末尾追加停止说明。
   */
  onLimitReached?: (kind: GuardKind, info: { iterations?: number; minutes?: number; consecutiveFailures?: number }) => Promise<boolean>;
  /** Local staged workflows grant a fresh, explicitly chosen budget window on continue. */
  resetBudgetOnContinue?: boolean;
  /**
   * 工具审批通道：声明 requiresApproval 的工具在执行前经此回调请求用户放行，
   * 返回 true 才执行。缺省（未提供回调）一律拒绝——安全侧默认：
   * 破坏性操作宁可失败回传模型（模型可向用户说明并换路径），
   * 绝不在无人审批的通道里静默执行。
   * 等待有界（TOOL_APPROVAL_MAX_WAIT_MS）：回调永不结算时按拒绝收敛，
   * 运行绝不因审批通道失联而永久悬停。
   */
  onToolApproval?: (request: ToolApprovalRequest) => Promise<boolean>;
}

/** 同一 chatId 重复启动 */
export class ChatBusyError extends Error {
  constructor(chatId: string) {
    super(`会话 ${chatId} 已有运行中的任务`);
    this.name = 'ChatBusyError';
  }
}

/** 输入不合法 */
export class EmptyRunInputError extends Error {
  constructor() {
    super('无可发送内容：用户输入为空且无历史上下文');
    this.name = 'EmptyRunInputError';
  }
}

interface RunHandle {
  previousCompactions?: number;
  toolSchemas?: Map<string, import('@/common/openai-types').OpenAITool>;
  previousRequest?: ChatMessage[];
  /** Only the current incomplete stream; completed rounds live in modelMessages. */
  roundText?: string;
  abortController: AbortController;
  startedAt: number;
  /** 运行内历史（含本轮用户消息、assistant tool_calls、tool 结果、vision 合成消息） */
  history: ChatMessage[];
  /** 本轮用户消息在 history 中的引用（空输入续跑时为 null）；运行中压缩据此判定持久化边界 */
  runUserMessage: ChatMessage | null;
  record: ChatMessageRecord;
  snapshotTimer: ReturnType<typeof globalThis.setInterval> | null;
  toolCallCount: number;
  /** An explicit screenshot in the same tool batch cannot bypass the 3s gap. */
  captureGapPending?: boolean;
  /** 事件发射（run 内闭包，供流式累积等内部方法复用） */
  emit: (event: ConversationEvent) => void;
  /** 最近一次请求的全量上下文用量（RunSummary 数据源） */
  lastUsage: ContextUsage | null;
  /** 本次运行内已执行的压缩次数 */
  compactions: number;
  /** 压缩熔断：本运行内压缩已失败过一次则不再重试（防每轮循环重复失败的通知风暴与无效请求） */
  compactionFailed: boolean;
  /** 运行内动态扩容的工具 ID（load_skill 激活技能后，把该技能预授权工具并入后续请求） */
  dynamicToolIds: Set<string>;
  pluginOwners?: Set<string>;
  pluginBindings?: ConversationRuntime['pluginBindings'];
  /**
   * 终止型工具（ToolMetadata.terminal）已成功执行：本轮工具全部执行完、
   * 结果已回传模型后结束循环，不再发起下一次请求。
   * 由 executeToolCalls 置位、主循环在工具阶段之后消费（见 run 主循环）。
   */
  stopAfterRound: boolean;
  /**
   * 连续「整轮工具全部失败」的轮数（任一轮有成功调用即归零）。
   * 达到 runtime.limits.maxConsecutiveFailedToolRounds（应用设置可调，默认 5）
   * 触发延续确认。
   */
  consecutiveFailedRounds: number;
  /** 最近一次计划状态提醒注入所在轮次（0 = 尚未注入）：提醒频率间隔判定输入 */
  lastReminderRound: number;
}

/** 流式期间快照落库间隔 */
const SNAPSHOT_INTERVAL_MS = 2000;

/** 工具执行等待（页面加载缓冲）时长 */
const TOOL_SETTLE_DELAY_MS = 1000;

/**
 * 用户主动中止会话时回传模型的工具错误文案（执行中被中止 / 因中止未开始执行，
 * 两种情形统一口径）。错误即数据：模型据此知道「不是工具坏了，是用户停了」，
 * 不会把它当作可重试的环境故障反复重试。
 */
const TOOL_INTERRUPTED_BY_USER = '用户主动中断会话导致工具中断运行';

/**
 * 审批等待的兜底时限（毫秒）。
 * UI 侧的审批弹窗自带 60s 超时自动拒绝，本值是其上的防御性上界——
 * 若审批通道因 UI 异常失联（Promise 永不结算），运行绝不永久悬停：
 * 到时按「未获批准」收敛，与安全侧默认拒绝语义一致。
 */
const TOOL_APPROVAL_MAX_WAIT_MS = 120 * 1000;

/**
 * vision 截图的兜底超时（毫秒）。
 * 截图经工具执行通道，但不在主循环的 per-call 超时包装内（准备阶段与
 * vision 续拍均直接调用）；无界等待会让一次卡死的截图工具悬挂整个运行。
 */
const SCREENSHOT_TIMEOUT_MS = 30 * 1000;

/** 审批请求中的参数预览长度上限（审批只判断意图，不需要全文） */
const TOOL_APPROVAL_PREVIEW_MAX_CHARS = 400;

// ==================== LLM 用户消息构造（唯一实现） ====================

/**
 * 组装发给模型的本轮用户消息（引擎运行与发送前上下文计量共用，保证逐字同源）：
 *   - 转录可见正文（runtime.userInput，含附件摘要标记）+ 附件全文块 + 系统时间戳；
 *   - images 非空时输出多模态数组（text 在前、图片按传入顺序排列），
 *     引擎侧传入「用户上传图片 + vision 截图」，计量侧传入用户上传图片
 *     （vision 截图在运行期产生，预估不含它，实际请求后由引擎测量回填）。
 */
export function composeLlmUserMessage(
  userInput: string,
  attachmentPrompt: string,
  images: readonly string[],
  highDetailLastImage = false,
): ChatMessage {
  const llmText = appendSystemTimestamp(
    attachmentPrompt ? `${userInput}\n\n${attachmentPrompt}` : userInput,
  );
  if (images.length === 0) {
    return { role: 'user', content: llmText };
  }
  return {
    role: 'user',
    content: [
      { type: 'text', text: llmText },
      ...images.map((url,index) => ({
        type: 'image_url' as const,
        image_url: { url, detail: highDetailLastImage && index === images.length - 1 ? 'high' as const : 'auto' as const },
      })),
    ],
  };
}

/**
 * vision 合成消息中单条工具结果摘要的长度上限（字符）。
 * 摘要进入 user 角色消息，不受工具内容截断（TOOL_CONTENT_LIMIT 仅作用于
 * tool 角色）约束：页面抽取类结果可达数十万字符——不设上限时会瞬间占满
 * 上下文预算，甚至因单条超预算被守卫整组丢弃（连同「继续完成任务」指令
 * 一起）。图片本体已按固定 1800 token 计量（token-estimate），此处只管文本。
 */
const VISION_SUMMARY_MAX_CHARS = 600;

// ==================== 引擎 ====================

export class ConversationEngine {
  private runs = new Map<string, RunHandle>();
  /**
   * 准备阶段（用户消息入档 / vision 首截图 / 助手占位记录）的预登记中止器。
   * 该阶段尚未写入 runs（RunHandle 未成形），但不登记则用户点停止无法生效；
   * 预登记保证 abort 在 run() 全生命周期内可用。
   */
  private pendingAborts = new Map<string, AbortController>();
  constructor(private readonly deps: ConversationDeps = defaultDeps) {
    onPluginsChange(() => {
      const state = getPluginSnapshot();
      for (const handle of this.runs.values()) for (const key of handle.pluginOwners ?? []) {
        const plugin = state.packages.find(p => p.key === key), binding = handle.pluginBindings?.[key];
        if (!plugin?.enabled || plugin.blocked || !binding || plugin.epoch !== binding.epoch || plugin.digest !== binding.digest) handle.abortController.abort();
      }
    });
  }

  isRunning(chatId: string): boolean {
    return this.runs.has(chatId) || this.pendingAborts.has(chatId);
  }

  /** Atomic in-memory snapshot for a sidepanel attaching to an existing run. */
  getRunningRecord(chatId: string): ChatMessageRecord | null {
    const record = this.runs.get(chatId)?.record;
    return record ? structuredClone(record) : null;
  }

  /** 中止指定会话的运行（准备阶段与运行中均可中止；无运行时返回 false） */
  abort(chatId: string): boolean {
    const handle = this.runs.get(chatId);
    if (handle) {
      handle.abortController.abort();
      return true;
    }
    const pending = this.pendingAborts.get(chatId);
    if (pending) {
      pending.abort();
      return true;
    }
    return false;
  }

  /**
   * 启动一次会话运行（含本轮用户输入的入档）。
   * 运行结束（完成/出错/中止）后 resolve RunSummary；主循环内的失败不向外抛
   * （错误体现在 summary 与事件中）；以下两类异常向外抛出，由调用方呈现：
   *   - ChatBusyError / EmptyRunInputError（启动前置校验）
   *   - 准备阶段（入档/截图/占位记录）失败——该阶段尚未产生可承载错误的助手记录
   */
  async run(runtime: ConversationRuntime, options: RunOptions = {}): Promise<RunSummary> {
    if (this.runs.has(runtime.chatId) || this.pendingAborts.has(runtime.chatId)) {
      throw new ChatBusyError(runtime.chatId);
    }
    if (!runtime.userInput.trim() && runtime.initialContext.length === 0) {
      throw new EmptyRunInputError();
    }

    const emit = (event: ConversationEvent) => {
      if (!options.observer) return;
      try {
        options.observer(event);
      } catch (error) {
        console.warn('[ConversationEngine] 事件观察者异常:', error);
      }
    };

    const startedAt = Date.now();
    const abortController = new AbortController();
    this.pendingAborts.set(runtime.chatId, abortController);

    let record: ChatMessageRecord;
    let handle: RunHandle;
    try {
      // ── 1. 用户消息入档（vision：先截图，多模态进运行历史；图片本体入库为
      //        内容哈希引用，data URL 仅存在于运行期） ──
      let userHistoryMessage: ChatMessage | null = null;
      /** vision 首截图的内容哈希（挂接到本条助手消息的图片区，见步骤 2） */
      let initialScreenshotRef: string | null = null;
      if (runtime.userInput.trim()) {
        // 上传图片先入库取引用（失败降级为无引用，绝不阻断发送）
        const userImageRefs =
          runtime.userImages.length > 0 ? await imageStore.putFromDataUrls(runtime.userImages) : [];
        record = await transcriptEngine.appendUserMessage(
          runtime.chatId,
          runtime.userInput,
          userImageRefs,
        );
        emit({ type: 'user-message', chatId: runtime.chatId, record });

        let visionImage: { image: string; description: string } | null = null;
        if (runtime.vision) {
          visionImage = await this.captureScreenshot(runtime, abortController.signal);
          if (visionImage) {
            initialScreenshotRef = await imageStore.putFromDataUrl(visionImage.image);
          }
        }
        // 转录（用户可见）存原始输入；附件全文与系统时间戳只拼进发给模型的
        // 这条用户消息——构造收敛到 composeLlmUserMessage（与发送前计量同源），
        // systemPrompt 因此保持逐轮稳定，可命中上下文缓存
        userHistoryMessage = composeLlmUserMessage(
          runtime.userInput + (visionImage ? `\n${visionImage.description}` : runtime.vision ? '\nCurrent viewport screenshot unavailable. Call screenshot to recover; do not use attachment images or old screenshot IDs for GUI coordinates.' : ''),
          runtime.attachmentPrompt,
          visionImage ? [...runtime.userImages, visionImage.image] : runtime.userImages,
          !!visionImage,
        );
        record.modelMessages = await storeProtocolMessages([userHistoryMessage]);
        await transcriptEngine.flush(record);
      }

      // ── 2. 助手记录占位 + 快照定时器 ──
      record = await transcriptEngine.createAssistantRecord(runtime.chatId);
      const activationContext = structuredClone(runtime.activationContext);
      const activationIds = new Map<string, string>();
      for (const message of activationContext) for (const call of message.tool_calls ?? []) {
        const id = `${record.id}_${activationIds.size}`;
        activationIds.set(call.id, id);
        call.id = id;
      }
      for (const message of activationContext) if (message.tool_call_id && activationIds.has(message.tool_call_id)) {
        message.tool_call_id = activationIds.get(message.tool_call_id);
      }
      record.modelMessages = await storeProtocolMessages(activationContext);
      // vision 首截图引用挂接到助手消息：立即落库保证运行中断/重载后图片不丢；
      // 模型侧由 modelMessages 保留原始图片位置；UI 引用与时间线各司其职：
      //   - imageRefs：引用集合（byImageRef 索引据此计数，删除引擎按它回收）；
      //   - parts['image']：时间线片段（按截屏顺序内联渲染为「查看屏幕」容器）。
      if (initialScreenshotRef) {
        record.imageRefs = [initialScreenshotRef];
        record.parts.push({ type: 'image', imageRef: initialScreenshotRef });
        await transcriptEngine.flush(record);
        emit({
          type: 'message-image',
          chatId: runtime.chatId,
          messageId: record.id,
          imageRef: initialScreenshotRef,
        });
      }
      // plan-store 幂等水合：引擎与 plan_tool 在 worker 执行，worker 冷启动后
      // 内存无既有计划（无 localStorage 缓存可读）——不水合会让本轮 plan_tool
      // 把持久化的计划误判为不存在（add 自动建立分支整体覆盖旧状态）。
      // restorePlansFromStorage 全路径 catch，水合失败不阻断运行。
      await ensurePlansHydrated();
      handle = {
        abortController,
        startedAt,
        history: [
          ...runtime.initialContext,
          ...(userHistoryMessage ? [userHistoryMessage] : []),
          // 合成激活轮紧跟本轮用户消息：modelMessages 保留原始轮次，
          // UI 不会出现这轮「凭空」的工具卡片，
          // 但对模型而言与真实调用逐字同源
          ...activationContext,
        ],
        runUserMessage: userHistoryMessage,
        record,
        snapshotTimer: null,
        toolCallCount: 0,
        emit,
        lastUsage: null,
        compactions: 0,
        compactionFailed: false,
        // 运行内动态扩容的工具 ID（load_skill 激活技能后注入其预授权工具）
        dynamicToolIds: new Set<string>(),
        pluginOwners: new Set(runtime.pluginOwners ?? []),
        pluginBindings: runtime.pluginBindings,
        consecutiveFailedRounds: 0,
        stopAfterRound: false,
        lastReminderRound: 0,
      };
      this.pendingAborts.delete(runtime.chatId);
      this.runs.set(runtime.chatId, handle);
      handle.snapshotTimer = globalThis.setInterval(() => {
        void transcriptEngine.flush(handle.record);
      }, SNAPSHOT_INTERVAL_MS);
      emit({ type: 'assistant-start', chatId: runtime.chatId, messageId: record.id });
    } catch (setupError) {
      // 准备失败：清理登记后原样抛出，由调用方以可读错误呈现（此时无助手记录可承载）
      this.pendingAborts.delete(runtime.chatId);
      this.runs.delete(runtime.chatId);
      console.error('[ConversationEngine] 运行准备失败:', setupError);
      throw setupError instanceof Error ? setupError : new Error(String(setupError));
    }

    // ── 3. 主循环 ──
    // guardIterations：当前守卫窗口内的轮数（用户确认继续后归零）
    // totalIterations：本次运行累计轮数（写入用量统计，不因守卫重置而丢失）
    let guardIterations = 0;
    let totalIterations = 0;
    let stopNote: string | null = null;
    // 时长守卫基准与运行起点分离：确认继续时仅重置守卫基准，不污染 usage 时长统计
    let guardStartMs = startedAt;
    // 终态累积：循环内不提前 return，统一走第 4 段单出口收尾
    let runStatus: 'done' | 'error' | 'aborted' = 'done';
    let runError: string | undefined;

    try {
      let shouldContinue = true;
      while (shouldContinue) {
        const pluginState = getPluginSnapshot();
        for (const key of [...(runtime.pluginOwners ?? []), ...(handle.pluginOwners ?? [])]) {
          const installed = pluginState.packages.find(p => p.key === key), binding = runtime.pluginBindings?.[key];
          invariant(installed?.enabled && !installed.blocked && binding && installed.epoch === binding.epoch && installed.digest === binding.digest, 'CAPABILITY_REVOKED');
        }
        guardIterations++;
        totalIterations++;

        // 中止优先于一切守卫决策：用户刚点停止时不再弹出确认条（确认条
        // 在停止后弹出即成悬挂弹窗——stopAiResponse 的 settleGuard 收敛不到
        // 一个尚未打开的确认），直接按中止收尾
        if (abortController.signal.aborted) {
          shouldContinue = false;
          break;
        }

        // 守卫：轮数 / 时长（经回调交由 UI 决策）
        const limitKind =
          guardIterations > runtime.limits.maxIterations
            ? ('max-iterations' as const)
            : Date.now() - guardStartMs > runtime.limits.maxDurationMs
              ? ('max-duration' as const)
              : null;
        if (limitKind) {
          emit({ type: 'guard', chatId: runtime.chatId, kind: limitKind });
          const proceed = options.onLimitReached
            ? await options.onLimitReached(limitKind, {
                iterations: limitKind === 'max-iterations' ? runtime.limits.maxIterations : undefined,
                minutes:
                  limitKind === 'max-duration'
                    ? Math.round(runtime.limits.maxDurationMs / 60000)
                    : undefined,
              })
            : false;
          if (!proceed) {
            stopNote = t('sidepanel.app.userStopped');
            shouldContinue = false;
            break;
          }
          if (options.resetBudgetOnContinue) {
            // This iteration has not requested the model yet; count it as the first of N.
            guardIterations = 1;
            guardStartMs = Date.now();
          } else {
            if (limitKind === 'max-iterations') guardIterations = 0;
            if (limitKind === 'max-duration') guardStartMs = Date.now();
          }
        }

        // 确认等待期间用户点停止（settleGuard(false) 已按停止收敛；此处兜底
        // proceed=true 但信号已置位的时序）——按中止收尾，不再发起下一次请求
        if (abortController.signal.aborted) {
          shouldContinue = false;
          break;
        }

        // ── 会话工具集：运行时基础集 + load_skill 动态扩容（去重保序） ──
        const mergedToolIds = handle.dynamicToolIds.size > 0
          ? [...new Set([...runtime.toolIds, ...handle.dynamicToolIds])]
          : runtime.toolIds;
        const advertised = runtime.advertisedToolIds ?? mergedToolIds;
        const sessionToolIds = runtime.toolPolicy === 'vision-assistant'
          ? filterVisionAssistantTools(advertised) : advertised;
        const toolSchemas = handle.toolSchemas ??= new Map();
        for (const schema of openaiToolsConverter.getToolsByIds(sessionToolIds.filter(id => !toolSchemas.has(id)))) {
          toolSchemas.set(schema.function.name, structuredClone(schema));
        }
        const toolDefinitions = sessionToolIds.flatMap(id => toolSchemas.has(id) ? [structuredClone(toolSchemas.get(id)!)] : []);

        // ── 上下文用量测量 + 运行时压缩（95%）：测量先于组装（反映真实需求量）；
        //    压缩失败仅告警降级，本轮继续由窗口守卫裁剪，绝不阻断对话 ──
        handle.lastUsage = measureContextUsage({
          toolDefinitions,
          systemPrompt: runtime.systemPrompt,
          toolIds: sessionToolIds,
          messages: handle.history,
          threshold: runtime.model.contextThreshold,
        });
        if (handle.lastUsage.ratio >= COMPACTION_RUNTIME_RATIO && !handle.compactionFailed) {
          const compacted = await this.tryCompactHistory(runtime, handle);
          if (compacted) {
            handle.compactions += 1;
            handle.lastUsage = measureContextUsage({
              toolDefinitions,
              systemPrompt: runtime.systemPrompt,
              toolIds: sessionToolIds,
              messages: handle.history,
              threshold: runtime.model.contextThreshold,
            });
          }
        }

        // Assemble a lossless request. Compaction is the only automatic history
        // rewrite; never send a silently truncated fallback after it fails.
        const guarded = contextEngine.protect(
          [
            { role: 'system', content: runtime.systemPrompt },
            ...handle.history,
          ] as ChatMessage[],
          runtime.model.contextThreshold,
        );
        if (guarded.truncated || handle.lastUsage.totalTokens > runtime.model.contextThreshold) {
          throw new Error('上下文无法完整放入当前模型窗口，且未能通过压缩解决。本次未发送删减历史的请求；完整记录已保留。请提高上下文阈值、使用更大窗口的模型或缩小单次输入。');
        }
        const requestMessages = guarded.messages;
        const previous = handle.previousRequest;
        let sharedPrefixMessages = 0;
        while (previous && sharedPrefixMessages < Math.min(previous.length, requestMessages.length) &&
          JSON.stringify(previous[sharedPrefixMessages]) === JSON.stringify(requestMessages[sharedPrefixMessages])) sharedPrefixMessages++;
        if (previous && sharedPrefixMessages < previous.length && handle.previousCompactions === handle.compactions) {
          throw new Error('检测到未压缩情况下的历史前缀变化，已保留完整记录并停止本次请求，避免发送被改写的上下文。');
        }
        handle.previousRequest = requestMessages;
        handle.previousCompactions = handle.compactions;

        const hasImageContent = requestMessages.some(
          message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'),
        );
        const send = hasImageContent ? this.deps.sendVision : this.deps.sendStream;

        handle.roundText = '';
        const { finalMessage, finishReason } = await send(requestMessages, {
          onToken: token => this.appendToken(handle, token),
          onReasoning: delta => this.appendReasoning(handle, delta),
          onToolCall: call => {
            if (handle.record.toolCalls.some(existing => existing.id === call.id)) return;
            const uiCall: ToolCallUI = {
              id: call.id,
              name: call.function.name,
              status: 'pending',
              arguments: call.function.arguments,
            };
            handle.record.toolCalls.push(uiCall);
            handle.record.modelPartial = {
              role: 'assistant', content: handle.roundText ?? '',
              tool_calls: [...(handle.record.modelPartial?.tool_calls ?? []), structuredClone(call)],
            };
            handle.record.parts.push({ type: 'tool', toolCall: { ...uiCall } });
            collapseReasoningParts(handle.record);
            emit({ type: 'tool-call', chatId: runtime.chatId, messageId: record.id, call: { ...uiCall } });
          },
          onComplete: () => undefined,
          onError: error => console.warn('[ConversationEngine] 流式错误回调:', error),
        }, {
          metrics: {
            agentId: runtime.agentId ?? '', runId: handle.record.id, iteration: totalIterations,
            compacted: handle.compactions > 0, trimmed: guarded.truncated,
            sharedPrefixMessages,
            prefixChanged: !!previous && sharedPrefixMessages < previous.length,
          },
          tools: sessionToolIds,
          toolDefinitions,
          signal: abortController.signal,
          // 端点快照：协议/端点/凭据/采样默认值全部定值于装配时刻，
          // 运行中用户切换协议或密钥不会影响本次运行的后续请求
          endpoint: runtime.model,
        });

        // ── 终止原因分诊（finishReason 是模型侧的「怎么结束的」，此前被丢弃）──
        // content_filter：服务端安全策略拦截，属 AI 不可控类——按运行错误收尾，
        // 结构化卡片呈现（部分已流出的内容经 catch 路径保留在记录中）
        if (finishReason === 'content_filter') {
          throw new Error(
            `模型输出被服务端安全策略拦截（finish_reason=content_filter），本轮回复可能不完整`,
          );
        }

        // 形态防御：适配器契约保证 tool_calls 为数组，但协议脏数据（异常网关
        // 拼装出的非数组字段）不应让 .length/.map 抛错中断整个运行——按空处理，
        // 走下方「无调用」分支由终止原因分诊收尾
        const rawToolCalls = finalMessage.tool_calls;
        const toolCalls: NonNullable<ChatMessage['tool_calls']> = Array.isArray(rawToolCalls)
          ? rawToolCalls
          : [];
        const contentText = typeof finalMessage.content === 'string' ? finalMessage.content.trim() : '';

        if (toolCalls.length === 0) {
          // 空响应防御：无终止事件且无任何产出 → 大概率网关异常截流（连接被
          // 干净关闭、无 [DONE]、无错误），按错误收尾而非伪装成正常的空完成
          if (!finishReason && !contentText) {
            throw new Error('模型返回空响应（未收到终止事件与任何内容），连接可能被服务端异常关闭');
          }
          await this.appendModelMessages(handle, [finalMessage]);
          handle.roundText = '';
          // length：输出被提供商上限截断——内容有效但不完整，以显式注记收尾。
          // 带 tool_calls 的 length 不在此列：参数 JSON 大概率同样被截断，
          // 由 parseToolArguments 以可读错误回传模型自纠（可控类）。
          if (finishReason === 'length') {
            stopNote = t('sidepanel.chat.responseTruncated');
          }
          shouldContinue = false;
          break;
        }

        // ── 工具执行（按调用顺序串行 + 各自超时 + 可中止 + 审批门） ──
        handle.history.push(finalMessage);
        const modelRoundStart = handle.record.modelMessages?.length ?? 0;
        const contextRoundStart = handle.record.modelContext?.length;
        await this.appendModelMessages(handle, [finalMessage, ...toolCalls.map(call => ({
          role: 'tool' as const, tool_call_id: call.id, name: call.function.name,
          content: JSON.stringify({ success: false, error: 'Tool execution has not completed; do not assume it succeeded.' }),
        }))]);
        handle.roundText = '';
        // 本轮工具执行的时长截止点：串行模式下 N 个挂死调用最坏累加 N×单工具
        // 超时，必须以运行时长上限截断，否则一轮即可超出 maxDurationMs 数倍
        const toolDeadlineMs = guardStartMs + runtime.limits.maxDurationMs;
        const toolOutcome = await this.executeToolCalls(
          runtime,
          handle,
          toolCalls,
          options,
          emit,
          toolDeadlineMs,
        );
        // Explicit user/model waits do not consume the active-work duration
        // budget. Wall-clock duration/usage still includes the entire wait.
        guardStartMs += toolOutcome.waitedMs;
        handle.history.push(...toolOutcome.messages);
        handle.record.modelMessages = (handle.record.modelMessages ?? []).slice(0, modelRoundStart);
        if (contextRoundStart !== undefined) handle.record.modelContext = handle.record.modelContext?.slice(0, contextRoundStart);
        await this.appendModelMessages(handle, [finalMessage, ...toolOutcome.messages]);
        handle.roundText = '';

        // 中止优先：工具阶段结束后若已中止，跳过守卫/等待/重截图直接退出——
        // 否则「全部调用因中止记为失败」会误触发连续失败守卫，向一个已停止的
        // 运行弹出确认条（stopAiResponse 无法收敛晚于它打开的确认）
        if (abortController.signal.aborted) {
          shouldContinue = false;
          break;
        }

        // ── 终止型工具已成功：本轮工具结果已回传模型，按正常完成收尾 ──
        // 位置在中止检查之后、时长守卫之前：中止语义优先（用户停止 > 任务完成），
        // 且不能落到下方 `continue`——那会回到循环顶部再发一次请求。
        // 语义为 'done'（任务完成）而非错误：runStatus 保持默认值，stopNote
        // 追加一条可读说明，让历史里能看到「因提交而结束」而不是戛然而止
        if (handle.stopAfterRound) {
          stopNote = t('sidepanel.terminalTool.stopped');
          shouldContinue = false;
          break;
        }

        // 时长上限在串行执行期间被触及：剩余调用已以「未执行」错误收尾，
        // 跳过本轮后处理，交循环顶部的时长守卫向用户确认（确认继续则下一轮
        // 重新发起调用；放弃则以停止说明收尾）
        if (Date.now() > toolDeadlineMs + toolOutcome.waitedMs) {
          continue;
        }

        // ── 连续失败守卫：连续 N 轮「全部调用失败」→ 升级为用户决策 ──
        // 单轮失败交模型自纠（错误即数据）；连续全败说明环境性阻塞，
        // 继续循环只会重复撞墙烧 token。任一轮有成功调用即归零。
        // 阈值 N 由应用设置配置（maxConsecutiveFailedToolRounds，默认 5）。
        if (toolOutcome.anyFailure && !toolOutcome.anySuccess) {
          handle.consecutiveFailedRounds += 1;
          const failureThreshold = Math.max(
            1,
            Math.floor(runtime.limits.maxConsecutiveFailedToolRounds) || 1,
          );
          if (handle.consecutiveFailedRounds >= failureThreshold) {
            emit({ type: 'guard', chatId: runtime.chatId, kind: 'tool-failures' });
            const proceed = options.onLimitReached
              ? await options.onLimitReached('tool-failures', {
                  consecutiveFailures: handle.consecutiveFailedRounds,
                })
              : false;
            if (!proceed) {
              stopNote = t('sidepanel.chat.toolFailuresStopped', {
                count: handle.consecutiveFailedRounds,
              });
              shouldContinue = false;
              break;
            }
            handle.consecutiveFailedRounds = 0;
            if (options.resetBudgetOnContinue) {
              guardIterations = 0;
              guardStartMs = Date.now();
            }
          }
        } else {
          handle.consecutiveFailedRounds = 0;
        }

        // ── 计划状态提醒：模型连续工作但未维护计划时，把计划状态重新呈现到
        //    上下文尾部（just-in-time + recency；判定与文案见 plan-reminder.ts）。
        //    合成 user 消息与 vision 续拍同构（push history + 持久化），尾部追加
        //    不动任何前缀消息，不破坏上下文缓存；与 plan_tool 同一内存实例，
        //    读到的即最新状态 ──
        const planItems = getPlan(runtime.chatId);
        if (needsPlanReminder({
          items: planItems,
          roundCalls: toolCalls,
          iteration: totalIterations,
          lastReminderRound: handle.lastReminderRound,
        })) {
          const planReminder = buildPlanReminder(planItems);
          if (planReminder) {
            handle.lastReminderRound = totalIterations;
            handle.history.push(planReminder);
            await this.appendModelMessages(handle, [planReminder]);
          }
        }

        // 工具执行完成后按需等待页面加载（中止信号可提前打断等待）。
        // 只有浏览器类工具会改变页面状态（导航/点击/注入）；笔记、技能等纯数据
        // 工具的固定等待纯属额外延迟，多轮累积会显著拖慢对话节奏
        if (!runtime.vision && toolCalls.some(call => call.function?.name?.startsWith('browser_') ||
          call.function?.name === 'vision_gui') &&
          needsVisionRefresh(toolCalls, toolOutcome.images,
            name => toolRegistry.getTool(name)?.metadata.visionRefresh)) {
          await this.interruptibleDelay(TOOL_SETTLE_DELAY_MS, abortController.signal);
        }

        // ── vision：工具成功后重截图，持久化合成多模态用户消息到模型历史；
        //    截图本体入库并挂接到本条助手消息——imageRefs 入引用集合、
        //    parts['image'] 按发生顺序进入时间线，UI 据此内联渲染「查看屏幕」） ──
        if ((runtime.vision?.reScreenshotAfterTools || toolOutcome.images.length > 0) && toolOutcome.messages.length > 0) {
          const continuation = await this.buildVisionContinuationMessage(
            runtime,
            toolCalls,
            toolOutcome.messages,
            toolOutcome.images,
            abortController.signal,
          );
          if (continuation) {
            if (continuation.imageRefs.length) handle.captureGapPending = false;
            handle.history.push(continuation.message);
            await this.appendModelMessages(handle, [continuation.message]);
            if (continuation.imageRefs.length) {
              handle.record.imageRefs = [
                ...(handle.record.imageRefs ?? []),
                ...continuation.imageRefs,
              ];
              // 时间线追加（flush 时 imageRefs 经 normalizeImageRefs 去重保序，
              // 片段流保持「每次截屏各一条」的真实发生顺序）
              for (const imageRef of continuation.imageRefs) handle.record.parts.push({ type: 'image', imageRef });
              await transcriptEngine.flush(handle.record);
              for (const imageRef of continuation.imageRefs) emit({
                type: 'message-image',
                chatId: runtime.chatId,
                messageId: handle.record.id,
                imageRef,
              });
            }
          }
        }
      }
    } catch (error) {
      // 归一化为 <api-error> 错误卡片：结构化 API 错误携带分类徽章 + 完整原始响应；
      // 未知错误也完整保留原始消息——用户永远能看到「因为什么导致了中断」
      runError = toApiErrorBlock(error);
      runStatus = abortController.signal.aborted ? 'aborted' : 'error';
      if (runStatus === 'error') console.error('[ConversationEngine] 运行失败:', error);
    }

    // 收尾期间保持运行登记（isRunning 为 true）：新的发送在此窗口内经
    // sendMessageInner 的前置检查安静等待（输入不丢弃），不会与尚在 flush /
    // 发终态事件的上一轮交错——「会话预览回写顺序」「终态事件与新轮事件先后」
    // 「seq 播种」三者的竞态窗口由此闭合。外层 finally 保证任何路径（含
    // finalize 抛错）都清除登记，防止同会话被永久锁死。
    try {
      // ── 3.5 中止状态矫正 ──
      // 工具执行 / 审批等待 / 页面加载缓冲期间的中止不经过 catch（无异常抛出），
      // 而是在循环顶部的中止检查处以 'done' 语义退出——按真实语义矫正为
      // 'aborted'：终态事件发射 aborted（而非 assistant-complete）、转录状态
      // 落库为 aborted，UI 与历史会话都能正确识别「这是被用户中止的一轮」。
      if (runStatus === 'done' && abortController.signal.aborted) {
        runStatus = 'aborted';
      }

      // ── 4. 统一收尾（单出口）：终止说明 → 终态落库 → 终态事件 → 摘要 ──
      // 中止路径跳过守卫停止说明：aborted 事件必然伴随「已停止当前任务」系统
      // 通知（且守卫确认条的「停止」与引擎中止常由同一次点击触发），两条停止
      // 说明并存是冗余；非中止路径（确认条倒计时归零 / 用户点「停止」于确认条）
      // 仍按原样追加具体原因
      if (stopNote && runStatus !== 'aborted') {
        this.appendNotice(handle, stopNote);
      }
      await this.finalize(handle, runStatus, runStatus === 'error' ? runError : undefined, totalIterations);
      // 终态事件携带实际执行时长（finalize 已写入 record.usage，取同一来源避免两处口径漂移）
      const durationMs = handle.record.usage?.durationMs;
      if (runStatus === 'aborted') {
        emit({ type: 'aborted', chatId: runtime.chatId, messageId: record.id, durationMs });
      } else if (runStatus === 'error') {
        // runStatus 为 'error' 时 runError 必已赋值；兜底值防御未来路径漏设消息
        emit({ type: 'assistant-error', chatId: runtime.chatId, messageId: record.id, error: runError ?? '未知错误', durationMs });
      } else {
        emit({ type: 'assistant-complete', chatId: runtime.chatId, record: { ...handle.record } });
      }
      return this.summary(runtime.chatId, handle, totalIterations, runStatus, runError);
    } finally {
      this.runs.delete(runtime.chatId);
      this.pendingAborts.delete(runtime.chatId);
    }
  }

  // ==================== 内部：运行时上下文压缩 ====================

  /**
   * 运行时压缩（95% 触发）：最后一条用户消息之前的历史（含旧摘要消息）交给
   * 压缩器摘要，替换为一条摘要系统消息；最后一条用户消息及其之后的内容
   * （可能包含本轮 assistant.tool_calls + tool 结果配对）原样保留，
   * 以满足 OpenAI 协议的配对约束。
   * 返回是否压缩成功；失败（非中止）只告警并返回 false，本轮交由窗口守卫裁剪。
   * 压缩期间的中止信号原样上抛，由主循环按运行中止语义收尾。
   */
  private async tryCompactHistory(
    runtime: ConversationRuntime,
    handle: RunHandle,
  ): Promise<boolean> {
    const history = handle.history;
    let lastUserIndex = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    // 最后用户消息之前没有可压缩内容（含历史为空 / 开局即超限两种情形）
    if (lastUserIndex <= 0) return false;

    const head = history.slice(0, lastUserIndex);
    const tail = history.slice(lastUserIndex);
    const headTokens = measureContextUsage({
      systemPrompt: '',
      toolIds: [],
      messages: head,
      threshold: 1,
    }).messagesTokens;

    handle.emit({ type: 'compaction', chatId: runtime.chatId, phase: 'start', trigger: 'runtime', originalTokens: headTokens });
    try {
      const result = await contextCompactor.compact({
        messages: head,
        model: runtime.model,
        threshold: runtime.model.contextThreshold,
        signal: handle.abortController.signal,
      });
      handle.history = [
        contextCompactor.buildSummaryMessage(result.summary, Date.now()),
        ...tail,
      ];
      handle.record.modelContext = await storeProtocolMessages(handle.history);
      await transcriptEngine.flush(handle.record);
      handle.emit({
        type: 'compaction',
        chatId: runtime.chatId,
        phase: 'done',
        trigger: 'runtime',
        originalTokens: result.originalTokens,
        summaryTokens: result.summaryTokens,
      });
      console.info(
        `[ConversationEngine] 运行时压缩完成: ${result.originalTokens} → ${result.summaryTokens} token` +
          (result.droppedOldest > 0 ? `（${result.droppedOldest} 条最旧消息未纳入压缩）` : ''),
      );
      // 边界对齐持久化：压缩头恰好等于初始上下文（边界落在本轮用户消息）时，
      // 压缩点可用 runtime.priorMaxSeq 精确表达，落库后下次发送直接以摘要续跑，
      // 免去 85% 预压缩对同一段历史重复调用模型；边界落在运行内（vision 合成
      // 消息之前等）时 seq 无法表达该边界，由本条记录的 modelContext 检查点恢复。
      // 持久化失败已由转录引擎经持久化降级通道通知用户，此处不重试不阻断。
      const boundaryAligned =
        handle.runUserMessage !== null && history[lastUserIndex] === handle.runUserMessage;
      if (boundaryAligned && runtime.priorMaxSeq > 0) {
        const persisted = await transcriptEngine.setCompaction(
          runtime.chatId,
          result.summary,
          runtime.priorMaxSeq,
        );
        if (!persisted) {
          console.warn('[ConversationEngine] 会话压缩元信息写入失败；本条模型历史检查点仍保留压缩结果');
        }
      }
      return true;
    } catch (error) {
      if (handle.abortController.signal.aborted) throw error;
      // 熔断：本运行内不再重试压缩（后续轮次由窗口守卫裁剪兜底）
      handle.compactionFailed = true;
      console.warn('[ConversationEngine] 运行时压缩失败，降级为窗口裁剪:', error);
      handle.emit({
        type: 'compaction',
        chatId: runtime.chatId,
        phase: 'failed',
        trigger: 'runtime',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  // ==================== 内部：流式累积 ====================

  /**
   * 追加正文 token 并发射 token 事件（UI 流式渲染的唯一来源）。
   * 含工具调用后首个文本 token 的冒号清理（对齐既有行为），事件携带清洗后的
   * 增量，保证 UI 展示与转录记录逐字一致。
   */
  private appendToken(handle: RunHandle, token: string): void {
    // 中止后不再累积：底层 fetch 取消存在窗口期（abort 已置位但驱动仍在
    // 吐增量），继续写入会污染已定稿的记录（finalize 已 flush，改动只留在
    // 内存里造成 UI/库分叉），事件也会打到已终态化的消息上
    if (!token || handle.abortController.signal.aborted) return;
    let cleanToken = token;
    handle.roundText = (handle.roundText ?? '') + token;
    handle.record.modelPartial = { ...handle.record.modelPartial, role: 'assistant', content: handle.roundText };
    const hasToolCalls = handle.record.toolCalls.length > 0;
    const hasTextPart = handle.record.parts.some(part => part.type === 'text' && part.content);
    if (hasToolCalls && !hasTextPart) {
      cleanToken = token.replace(/^:\s*:?\s*/, '').replace(/^:\s*/, '');
    }
    this.appendToPart(handle.record, 'text', cleanToken);
    handle.record.content += cleanToken;
    handle.emit({
      type: 'token',
      chatId: handle.record.chatId,
      messageId: handle.record.id,
      delta: cleanToken,
    });
  }

  /** 追加推理 delta 并发射 reasoning 事件 */
  private appendReasoning(handle: RunHandle, delta: string): void {
    // 中止后不再累积（与 appendToken 同一口径，见其注释）
    if (!delta || handle.abortController.signal.aborted) return;
    this.appendToPart(handle.record, 'reasoning', delta);
    handle.record.reasoning += delta;
    handle.emit({
      type: 'reasoning',
      chatId: handle.record.chatId,
      messageId: handle.record.id,
      delta,
    });
  }

  /**
   * 追加系统注记（守卫停止说明 / 截断注记等）。
   * - parts 记为 notice 类型片段：UI 以独立系统信息条渲染（区别于正文样式），
   *   历史会话重载时同样按 notice 片段还原；
   * - content 同步追加纯文本：保持「content = 完整拼接文本」的转录语义，
   *   模型面上下文（context-engine 读 content）依旧能感知本轮的终止原因。
   */
  private appendNotice(handle: RunHandle, text: string): void {
    if (!text) return;
    handle.record.parts.push({ type: 'notice', content: text });
    handle.record.content += `\n\n${text}`;
    handle.emit({
      type: 'notice',
      chatId: handle.record.chatId,
      messageId: handle.record.id,
      text,
    });
  }

  private appendToPart(record: ChatMessageRecord, type: 'text' | 'reasoning', delta: string): void {
    const last = record.parts.length > 0 ? record.parts[record.parts.length - 1] : null;
    if (last && last.type === type) {
      last.content = (last.content || '') + delta;
      return;
    }
    record.parts.push({ type, content: delta });
    if (type === 'text') collapseReasoningParts(record);
  }

  // ==================== 内部：工具执行 ====================

  /**
   * 一轮工具执行的聚合产出：协议消息 + 成败统计（连续失败守卫数据源）。
   *
   * 执行模型：**按调用顺序串行**——同一轮的多个调用依次执行，前一个完全
   * 结算（成功/失败/超时/中止）后才启动下一个。串行的理由：浏览器类工具
   * 改写同一页面、数据类工具改写同一份存储，并发交错会让「模型看到的结果
   * 顺序」与「真实操作顺序」脱钩；串行下两者因果恒成立，同轮审批弹窗也不会
   * 并发叠出。
   *
   * 不可逃逸保证：每个调用的全部路径都以 return 收尾（含 catch 与两种跳过），
   * 任何错误都封装为 {success:false} 的 tool 消息回传模型——工具层错误在
   * 结构上无法中断主循环。
   *
   * 配对完整性：因中止/时长上限未开始执行的调用同样返回配对的 tool 结果——
   * assistant.tool_calls 与 tool 结果必须一一对应，否则下一次请求违反
   * OpenAI 协议、被网关 400 拒绝。
   *
   * @param deadlineMs 本轮工具执行的时长截止点（毫秒时间戳）：到达后不再启动
   *   新调用，剩余调用以「已达运行时长上限」错误收尾，交循环顶部时长守卫确认
   */
  private async executeToolCalls(
    runtime: ConversationRuntime,
    handle: RunHandle,
    toolCalls: NonNullable<ChatMessage['tool_calls']>,
    options: RunOptions,
    emit: (event: ConversationEvent) => void,
    deadlineMs: number,
  ): Promise<{ messages: ChatMessage[]; images: VisionToolImage[]; waitedMs: number; anySuccess: boolean; anyFailure: boolean }> {
    let anySuccess = false;
    let anyFailure = false;
    const signal = handle.abortController.signal;
    const results: ChatMessage[] = [];
    const images: VisionToolImage[] = [];
    let waitedMs = 0;

    for (const toolCall of toolCalls) {
      const startedAt = Date.now();
      // 形态防御：脏协议可能缺失 function 分段，先归一为字符串——
      // 保证消息构造（含 catch 分支）永不因属性缺失二次抛错逃逸本循环
      const toolName = typeof toolCall?.function?.name === 'string' ? toolCall.function.name : '';

      // 中止检查（启动前）：停止后不再启动任何调用；已排队的调用以统一的
      // 中断文案收尾（记录 + 事件 + 协议消息三件套，见 settleSkippedToolCall）
      if (signal.aborted) {
        anyFailure = true;
        results.push(
          this.settleSkippedToolCall(
            runtime, handle, emit, toolCall, toolName, TOOL_INTERRUPTED_BY_USER, 0,
          ),
        );
        continue;
      }
      // 时长截止（启动前）：串行累加不许超出本轮预算；超限调用以可读错误收尾，
      // 交循环顶部的时长守卫向用户确认（确认继续则下一轮重新发起）
      if (Date.now() > deadlineMs + waitedMs) {
        anyFailure = true;
        const minutes = Math.max(1, Math.round(runtime.limits.maxDurationMs / 60000));
        results.push(
          this.settleSkippedToolCall(
            runtime, handle, emit, toolCall, toolName,
            `已达本次运行时长上限（${minutes} 分钟），工具 ${toolName || '(未知工具)'} 未执行`,
            Date.now() - startedAt,
          ),
        );
        continue;
      }

      try {
        const plugins = getPluginSnapshot();
        for (const key of [...(runtime.pluginOwners ?? []), ...(handle.pluginOwners ?? [])]) {
          const installed = plugins.packages.find(p => p.key === key), binding = runtime.pluginBindings?.[key];
          invariant(installed?.enabled && !installed.blocked && binding && installed.epoch === binding.epoch && installed.digest === binding.digest, 'CAPABILITY_REVOKED');
        }
        // Never trust a provider to call only advertised tools. Capability limits
        // apply before parsing, approval, skill loading, or any side effect.
        if ((!runtime.toolIds.includes(toolName) && !handle.dynamicToolIds.has(toolName)) ||
            (runtime.toolPolicy === 'vision-assistant' && !isVisionAssistantTool(toolName)) ||
            (runtime.pluginToolCeiling && !runtime.pluginToolCeiling.includes(toolName))) {
          throw new Error(`TOOL_NOT_ALLOWED: ${toolName} 不在本轮工具范围内。${runtime.toolPolicy === 'vision-assistant' ? '视觉助手只观察并指导；代操作请切换视觉通用助手 / 文本通用助手。' : '请使用本轮已提供的工具。'}`);
        }
        // 参数解析先于审批：无效参数直接以可控失败回传模型自纠，
        // 不浪费用户的审批注意力；审批预览也得以展示解析后的 JSON
        const args = parseToolArguments(toolCall.function?.arguments);

        // ── 审批门：声明 requiresApproval 的工具先经用户放行（缺省拒绝，安全侧）──
        // 拒绝（或无审批通道）不走执行，直接以「可控失败」回传模型——
        // 模型可向用户说明意图并换路径，与工具错误的两级模型完全一致
        if (runtime.pluginToolCeiling && toolName === 'load_skill') {
          const ref = (args as { skill_name?: string })?.skill_name;
          const skill = typeof ref === 'string' ? skillEngine.get(ref) : undefined;
          invariant(skill?.enabled && skill.allowedTools.every(id => runtime.pluginToolCeiling!.includes(id)), 'SKILL_NOT_ALLOWED');
        }
        if (runtime.toolPolicy === 'vision-assistant' && toolName === 'load_skill') {
          const ref = (args as { skill_name?: unknown })?.skill_name;
          const skill = typeof ref === 'string' ? skillEngine.get(ref) : undefined;
          if (!skill || !skill.enabled || !skill.allowedTools.every(isVisionAssistantTool))
            throw new Error('SKILL_NOT_ALLOWED: 该技能不存在、未启用或需要代操作工具；请切换合适的执行智能体。');
        }
        if (runtime.toolPolicy === 'vision-assistant' && toolName === 'browser_get_page_text' &&
            (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length > 0))
          throw new Error('TOOL_NOT_ALLOWED: 视觉助手的全文读取仅接受空参数，不能指定其它标签页。');
        if (this.deps.requiresApproval(toolName, args)) {
          const approved = options.onToolApproval
            ? await this.awaitToolApproval(options.onToolApproval, {
                id: toolCall.id,
                name: toolName,
                argumentsPreview: this.previewArguments(args),
              })
            : false;
          // 审批等待期间用户中止：以中断文案收尾（而非「未获批准」——
          // 拒绝的语义是「看了并否决」，中止的语义是「直接停了任务」）
          if (signal.aborted) {
            anyFailure = true;
            results.push(
              this.settleSkippedToolCall(
                runtime, handle, emit, toolCall, toolName, TOOL_INTERRUPTED_BY_USER,
                Date.now() - startedAt,
              ),
            );
            continue;
          }
          if (!approved) {
            anyFailure = true;
            results.push(
              this.settleSkippedToolCall(
                runtime, handle, emit, toolCall, toolName,
                options.onToolApproval
                  ? `APPROVAL_NOT_GRANTED：工具 ${toolName} 未获批准（用户拒绝或等待超时），未执行。停止该操作并说明原因，不得换工具、按键或脚本绕过；可继续不依赖该授权的工作。`
                  : `APPROVAL_UNAVAILABLE：工具 ${toolName} 需要审批，但当前运行未接入用户审批回调，未执行。这不是用户拒绝；请报告审批通道问题，不得绕过。`,
                Date.now() - startedAt,
              ),
            );
            continue;
          }
        }

        // 超时与用户中止的竞争等待：任一先到即结束等待（定时器与监听器在
        // 成功/失败/超时/中止四条路径均清理，避免长循环下累积悬空句柄）。
        // 交互类工具（INTERACTIVE_TOOL_NAMES）不设执行超时：等待真实用户
        // 答复可能远超 toolTimeoutMs，超时时长由 UI 层自行控制，此处只保留
        // 中止通道。
        // 中止时底层执行可能仍在后台完成（扩展消息通道无法取消），其结果
        // 被丢弃并以「用户主动中断会话导致工具中断运行」回传——停止操作的
        // 反馈即刻生效，不再被最长 120s 的工具超时卡住
        if (runtime.vision && ['screenshot','vision_read_wait'].includes(toolName) && handle.captureGapPending)
          await this.interruptibleDelay(VISION_TOOL_SETTLE_DELAY_MS, signal);
        if (runtime.vision && needsVisionRefresh([toolCall], [], name => toolRegistry.getTool(name)?.metadata.visionRefresh))
          handle.captureGapPending = true;
        const result = await new Promise<ToolResult>((resolve, reject) => {
          const callController = new AbortController();
          const isInteractiveTool = INTERACTIVE_TOOL_NAMES.has(toolName);
          const timeoutMs = toolName === GENERIC_WAIT_TOOL_ID ? waitExecutionTimeout(args, runtime.limits.toolTimeoutMs) : runtime.limits.toolTimeoutMs;
          let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
          const cleanup = () => {
            if (timer !== null) globalThis.clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
          };
          if (!isInteractiveTool) {
            timer = globalThis.setTimeout(() => {
              callController.abort();
              cleanup();
              reject(
                new Error(
                  `工具 ${toolName} 执行超时（超过 ${timeoutMs / 1000} 秒）`,
                ),
              );
            }, timeoutMs);
          }
          const onAbort = () => {
            callController.abort();
            cleanup();
            reject(new Error(TOOL_INTERRUPTED_BY_USER));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
          // 会话上下文随执行注入：plan_tool 等会话感知工具据此隔离数据
          //（不同会话的并发运行各自的 chatId 互不串扰）
          this.deps.executeTool(toolName,
            runtime.toolPolicy === 'vision-assistant' && toolName === 'screenshot' ? { mode: 'observe' } : args,
            { chatId: runtime.chatId, signal: callController.signal, pluginBindings: runtime.pluginBindings, pluginApproved: true }).then(
            value => {
              cleanup();
              resolve(value);
            },
            error => {
              cleanup();
              reject(error);
            },
          );
        });
        const executionTimeMs = Date.now() - startedAt;
        // 形态防御：类型契约声明返回 ToolResult，但运行时的缺陷实现可能返回
        // undefined / null / 字符串 / 数组——直接访问 .isError 会抛错，按成功
        // 判定则产生「空结果假成功」。统一以可读错误回传，让缺陷在模型面暴露
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          const shape = !result ? String(result) : Array.isArray(result) ? 'array' : typeof result;
          anyFailure = true;
          results.push(
            this.settleSkippedToolCall(
              runtime, handle, emit, toolCall, toolName,
              `工具 ${toolName} 返回了非 ToolResult 形态的响应（类型: ${shape}），该工具存在实现缺陷，请反馈`,
              executionTimeMs,
            ),
          );
          continue;
        }
        // 成败判定三要素齐全：显式 success=false、error 字段、isError 标记任一
        // 命中即为失败——漏掉 success:false 会让「仅带 message 的失败结果」在
        // UI 标记成功、而回传模型的 JSON 又是失败，两侧状态分裂
        const success = !result.isError && !result.error && result.success !== false;
        if (success) anySuccess = true;
        else anyFailure = true;
        // 失败结果就地提取精准原因（error/message/首段文本），供 UI 与事件消费——
        // 否则「以结果形态返回的失败」在展开区无任何可读信息
        const failureReason = success ? undefined : describeToolFailure(result);
        this.applyToolResult(handle, toolCall.id, success ? 'success' : 'error', {
          result,
          executionTimeMs,
          ...(failureReason !== undefined ? { error: failureReason } : {}),
        });
        emit({
          type: 'tool-result',
          chatId: runtime.chatId,
          messageId: handle.record.id,
          callId: toolCall.id,
          status: success ? 'success' : 'error',
          result,
          error: failureReason,
          executionTimeMs,
        });
        // load_skill 成功后：把该技能的预授权工具并入本会话后续请求，
        // 使 L1 发现（未预先选择技能）的调用路径同样具备技能配套工具
        if (success && toolName === 'load_skill') {
          this.injectSkillTools(runtime, handle, result);
        }
        // 终止型工具（submit_skill / submit_validation 等）成功 → 标记本轮收尾。
        // 只在成功时标记：提交参数不合法要回传模型自纠，不能因一次失败就终止运行；
        // 结果照常回传与落库，模型与 UI 都能看到「提交了什么」
        if (success && toolRegistry.getTool(toolName)?.metadata.terminal === true) {
          handle.stopAfterRound = true;
        }
        if (success) {
          const image = takeVisionToolImage(result, results.length,toolName,args);
          if (image) {
            images.push(image);
            if (image.kind === 'viewport') handle.captureGapPending = false;
            // 视口截图归档：与 vision loop 的自动重截图存进同一处图片库，
            // 并分配 8 位短 id —— 模型据此在最终回答里用
            // <agent-image id="xxxxxxxx" /> 把这张截图展示给用户
            // 视觉助手（观察+指导）不参与：它不代替用户操作，也不引用截图
            if (image.kind === 'viewport' && runtime.toolPolicy !== 'vision-assistant') {
              const archived = await this.archiveViewportImage(image);
              if (archived) {
                image.imageRef = archived.ref;
                image.shortId = archived.shortId;
                // 短 id 注入工具结果：回传模型的 JSON 里必须带上它，
                // 否则模型无从得知该用哪个 id 引用这张图
                if (result.data && typeof result.data === 'object') {
                  const data = result.data as Record<string, unknown>;
                  data.imageId = archived.shortId;
                  // 引用语法紧挨着 id：模型照抄邻近指令的成功率远高于远端协议
                  if (typeof data.text === 'string') {
                    data.text =
                      `${data.text} Archived for citation: imageId=${archived.shortId} — ` +
                      `show it to the user in your final answer with <agent-image id="${archived.shortId}" />.`;
                  }
                }
              }
            }
          }
        }
        results.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolName,
          content: JSON.stringify(Object.assign({ success }, (runtime.vision || images.some(image => image.callIndex === results.length)) ? withoutVisionImage(result) : result)),
        });
      } catch (error) {
        // 中止归一化：中止瞬间并发到达的其它错误（底层通道被关闭等）统一按
        // 中断文案呈现，保证用户停止后的回传信息一致、可分析、不误导模型
        const executionTimeMs = Date.now() - startedAt;
        const message = signal.aborted
          ? TOOL_INTERRUPTED_BY_USER
          : error instanceof Error
            ? error.message
            : String(error);
        anyFailure = true;
        results.push(
          this.settleSkippedToolCall(runtime, handle, emit, toolCall, toolName, message, executionTimeMs),
        );
      } finally {
        if (toolName === GENERIC_WAIT_TOOL_ID || INTERACTIVE_TOOL_NAMES.has(toolName)) waitedMs += Date.now() - startedAt;
      }
    }

    handle.toolCallCount += toolCalls.length;
    return { messages: results, images, waitedMs, anySuccess, anyFailure };
  }

  /**
   * 为一个「未以正常结果收尾」的工具调用落定三件套：转录记录（UI 工具卡片）
   * + tool-result 事件（实时渲染）+ 协议 tool 消息（回传模型）。
   * 中止、时长上限、审批拒绝、执行异常四种收尾统一走此出口——三个消费面
   * 永远同源，不出现「UI 还挂着 pending、模型侧却已收到结果」的分裂。
   */
  private settleSkippedToolCall(
    runtime: ConversationRuntime,
    handle: RunHandle,
    emit: (event: ConversationEvent) => void,
    toolCall: NonNullable<ChatMessage['tool_calls']>[number],
    toolName: string,
    message: string,
    executionTimeMs: number,
  ): ChatMessage {
    this.applyToolResult(handle, toolCall.id, 'error', { error: message, executionTimeMs });
    emit({
      type: 'tool-result',
      chatId: runtime.chatId,
      messageId: handle.record.id,
      callId: toolCall.id,
      status: 'error',
      error: message,
      executionTimeMs,
    });
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      name: toolName,
      content: JSON.stringify({ success: false, error: message }),
    };
  }

  /**
   * 有界等待审批结果：UI 审批弹窗自带 60s 超时自动拒绝，本层在其之上再加
   * TOOL_APPROVAL_MAX_WAIT_MS 兜底——审批通道因 UI 异常失联（Promise 永不
   * 结算）时按「未获批准」收敛，运行绝不永久悬停。审批 Promise 的异常向上传播，
   * 由 per-call catch 封装为可控失败。
   */
  private async awaitToolApproval(
    approval: NonNullable<RunOptions['onToolApproval']>,
    request: ToolApprovalRequest,
  ): Promise<boolean> {
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    try {
      return await Promise.race([
        approval(request),
        new Promise<false>(resolve => {
          timer = globalThis.setTimeout(() => resolve(false), TOOL_APPROVAL_MAX_WAIT_MS);
        }),
      ]);
    } finally {
      if (timer !== null) globalThis.clearTimeout(timer);
    }
  }

  /** 审批请求的参数预览：解析后的参数序列化并截断至安全长度（只保留判断意图所需的信息） */
  private previewArguments(args: unknown): string {
    let text: string;
    try {
      text = JSON.stringify(args) ?? '{}';
    } catch {
      text = String(args);
    }
    return text.length <= TOOL_APPROVAL_PREVIEW_MAX_CHARS
      ? text
      : `${text.slice(0, TOOL_APPROVAL_PREVIEW_MAX_CHARS)}…`;
  }

  /**
   * load_skill 成功后的动态工具扩容：把技能声明的 allowedTools 并入运行内工具集。
   * 防御性收敛在注入源头一次完成：
   *   - 会话中途被停用的技能不再扩容（正文虽已由 load_skill 返回，但停用
   *     意味着用户撤销了对该技能的授权，其预授权工具不应继续进入后续请求）；
   *   - 未注册的工具 ID（拼错 / 已下线工具的残留声明）在此剔除并告警一次，
   *     避免请求侧 getToolsByIds 在后续每轮循环对同一批未知 ID 重复告警。
   */
  private injectSkillTools(runtime: ConversationRuntime, handle: RunHandle, result: ToolResult): void {
    const loadedName = result?.data?.skill;
    if (typeof loadedName !== 'string' || !loadedName) return;
    const skill = skillEngine.get(loadedName);
    if (!skill || !skill.enabled || skill.allowedTools.length === 0) return;
    if (isPluginRef(skill.id)) (handle.pluginOwners ??= new Set()).add(ownerOf(skill.id));
    const known: string[] = [];
    const unknown: string[] = [];
    for (const raw of skill.allowedTools) {
      if (typeof raw !== 'string') continue;
      const toolId = raw.trim();
      if (!toolId) continue;
      if (runtime.toolPolicy === 'vision-assistant' && !isVisionAssistantTool(toolId)) continue;
      if (runtime.pluginToolCeiling && !runtime.pluginToolCeiling.includes(toolId)) continue;
      if (toolRegistry.getTool(toolId)) known.push(toolId);
      else unknown.push(toolId);
    }
    if (unknown.length > 0) {
      console.warn(
        `[ConversationEngine] 技能 "${skill.name}" 声明了未注册的工具 ID，已忽略: ${unknown.join(', ')}`,
      );
    }
    if (known.length === 0) return;
    for (const toolId of known) handle.dynamicToolIds.add(toolId);
    console.debug(
      `[ConversationEngine] 技能 "${skill.name}" 激活，动态注入预授权工具: ${known.join(', ')}`,
    );
  }

  /** 把工具结果同步进记录（toolCalls + parts 双结构，UI 兼容） */
  private applyToolResult(
    handle: RunHandle,
    callId: string,
    status: 'success' | 'error',
    detail: { result?: unknown; error?: string; executionTimeMs: number },
  ): void {
    // 落库体积防护：超大结果（如 base64 截图）以截断摘要代替，避免单条记录失控拖垮 IndexedDB
    const recordableResult =
      detail.result !== undefined ? sanitizeRecordedResult(detail.result) : undefined;

    const uiCall = handle.record.toolCalls.find(call => call.id === callId);
    if (uiCall) {
      uiCall.status = status;
      if (recordableResult !== undefined) uiCall.result = recordableResult;
      if (detail.error !== undefined) uiCall.error = detail.error;
      uiCall.executionTime = detail.executionTimeMs;
    }
    const toolPart = handle.record.parts.find(
      part => part.type === 'tool' && part.toolCall?.id === callId,
    );
    if (toolPart?.toolCall) {
      toolPart.toolCall.status = status;
      if (recordableResult !== undefined) toolPart.toolCall.result = recordableResult;
      if (detail.error !== undefined) toolPart.toolCall.error = detail.error;
      toolPart.toolCall.executionTime = detail.executionTimeMs;
    }
  }

  // ==================== 内部：vision ====================

  /** 可中止的固定等待：到达时长或收到中止信号时结束（用于工具后的页面加载缓冲） */
  private interruptibleDelay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const finish = () => {
        globalThis.clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => finish();
      const timer = globalThis.setTimeout(finish, ms);
      signal.addEventListener('abort', onAbort);
    });
  }

  /**
   * 视口截图归档（工具产出的截图）。
   *
   * 落进与 vision loop 自动重截图**同一处图片库**（内容寻址 + 8 位短 id），
   * 因此「自动拍的」与「模型主动存档的」在存储与引用上完全同构：都被会话
   * 记录的图片引用持有，都能在回答里按短 id 引用。
   *
   * 失败一律降级为 null（不阻断工具结果与后续流程）：归档只是附加能力，
   * 截图本身已经回传给模型，存档失败不应让整轮失败。
   */
  private async archiveViewportImage(
    image: VisionToolImage,
  ): Promise<{ ref: string; shortId: string } | null> {
    try {
      const ref = await imageStore.putFromDataUrl(image.image);
      if (!ref) return null;
      const shortId = await imageStore.getShortId(ref);
      if (!shortId) return null;
      return { ref, shortId };
    } catch (error) {
      console.warn('[ConversationEngine] 截图归档失败（降级为不引用）:', error);
      return null;
    }
  }

  /**
   * 截图；失败 / 超时 / 中止一律返回 null（降级为纯文本，绝不阻断主流程）。
   * 竞争等待自带独立超时与中止通道：截图经工具通道执行、不受主循环 per-call
   * 超时包装覆盖，无界等待会让一次卡死的截图工具悬挂整个运行（准备阶段首拍
   * 与 vision 续拍都走这里）；中止时立即返回，保证停止反馈即刻生效。
   */
  private async captureScreenshot(
    runtime: ConversationRuntime,
    signal?: AbortSignal,
  ): Promise<{ image: string; description: string } | null> {
    if (!runtime.vision) return null;
    if (signal?.aborted) return null;
    const captureController = new AbortController();
    try {
      const execution = this.deps.executeTool(
        runtime.vision.screenshotTool,
        runtime.toolPolicy === 'vision-assistant' ? { mode: 'observe' } : runtime.vision.screenshotArgs,
        { chatId: runtime.chatId, signal: captureController.signal },
      );
      const result = await new Promise<ToolResult | null>(resolve => {
        let settled = false;
        let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
        const onAbort = () => { captureController.abort(); finish(null); };
        const finish = (value: ToolResult | null) => {
          if (settled) return;
          settled = true;
          if (timer !== null) globalThis.clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = globalThis.setTimeout(() => {
          captureController.abort();
          console.warn('[ConversationEngine] 截图超时，降级为纯文本');
          finish(null);
        }, SCREENSHOT_TIMEOUT_MS);
        // 迟到的完成/拒绝在 settled 后被幂等吞掉，但处理器必须先挂上——
        // 否则超时/中止之后底层的拒绝会变成未处理的 Promise rejection
        execution.then(
          value => finish(value),
          error => {
            if (!settled) {
              console.warn('[ConversationEngine] 截图失败，降级为纯文本:', error);
            }
            finish(null);
          },
        );
      });
      if (!result || result.success !== true || signal?.aborted) return null;
      const description = (result.data as { text?: string } | undefined)?.text;
      const screenshot = (result?.data as { screenshot?: string } | undefined)?.screenshot;
      return typeof screenshot === 'string' && screenshot.startsWith('data:image/png;base64,') && typeof description === 'string'
        ? { image: screenshot, description } : null;
    } catch (error) {
      console.warn('[ConversationEngine] 截图失败，降级为纯文本:', error);
      return null;
    }
  }

  /**
   * 工具成功后：重截图 + 合成「继续完成任务」多模态用户消息（模型历史）。
   * 结果摘要安全化：文本截断至 VISION_SUMMARY_MAX_CHARS；截图结果以
   * 「见随附图片」占位（新截图作为 image_url 部件随消息附上，base64
   * 绝不进入文本部件）。
   * 返回值携带新截图的内容哈希引用（入库成功时）：调用方据此把截图挂接到
   * 助手消息图片区（UI 查看/放大/下载），与合成消息的 data URL 各司其职。
   */
  private async buildVisionContinuationMessage(
    runtime: ConversationRuntime,
    toolCalls: NonNullable<ChatMessage['tool_calls']>,
    toolMessages: ChatMessage[],
    images: VisionToolImage[],
    signal: AbortSignal,
  ): Promise<{ message: ChatMessage; imageRefs: string[] } | null> {
    const refresh = !!runtime.vision?.reScreenshotAfterTools && needsVisionRefresh(toolCalls, images,
      name => toolRegistry.getTool(name)?.metadata.visionRefresh);
    // Tool results already contain the evidence; reads/plans need no synthetic
    // continuation, delay, or new image invalidating the current screenshot ID.
    if (!refresh && images.length === 0) return null;
    const successSummaries: string[] = [];
    for (let index = 0; index < toolCalls.length; index++) {
      const toolMessage = toolMessages[index];
      if (!toolMessage || toolMessage.role !== 'tool') continue;
      try {
        const parsed = JSON.parse(toolMessage.content as string) as { success?: boolean };
        if (parsed.success !== true) {
          const failure = parsed as { error?: unknown };
          successSummaries.push(`${toolCalls[index].function.name} failed: ${typeof failure.error === 'string' ? failure.error.slice(0, VISION_SUMMARY_MAX_CHARS) : 'Inspect the latest screenshot before deciding how to recover.'}`);
          continue;
        }
        // answer：interact 等交互类工具的用户答复（无 text 的工具结果也能摘出关键信息）
        const data = parsed as { data?: { text?: unknown; answer?: unknown; screenshot?: unknown } };
        const text =
          typeof data.data?.text === 'string' && data.data.text.trim()
            ? data.data.text.trim()
            : typeof data.data?.answer === 'string'
              ? data.data.answer.trim()
              : '';
        const hasScreenshot =
          typeof data.data?.screenshot === 'string' && data.data.screenshot.length > 0;
        const outcome = text
          ? text.length > VISION_SUMMARY_MAX_CHARS
            ? `${text.slice(0, VISION_SUMMARY_MAX_CHARS)}…（已截断）`
            : text
          : hasScreenshot
            ? '（页面截图，见随附图片）'
            : '执行成功';
        successSummaries.push(`${toolCalls[index].function.name} 调用成功，执行结果：${outcome}`);
      } catch {
        /* 解析失败忽略该条 */
      }
    }
    if (successSummaries.length === 0) return null;
    // 中止后不再续拍（截图会立即以 null 收敛，这里提前退出省去无谓的构造）
    if (signal.aborted) return null;

    const content: ChatMessage['content'] = [
      { type: 'text', text: `${successSummaries.join('\n')}\n继续完成任务` },
    ];
    // Every automatic post-tool capture starts at least 3s after the batch has
    // completed, including hover/scroll/navigation/failures. Initial capture,
    // reused screenshots and read-only results do not create another capture.
    if (refresh) await this.interruptibleDelay(VISION_TOOL_SETTLE_DELAY_MS, signal);
    if (signal.aborted) return null;
    const fresh = refresh ? await this.captureScreenshot(runtime, signal) : null;
    const delivered = images.map(image => ({
      image: image.image,
      description: image.description,
      // 工具产出的截图已在工具循环里归档（同一处图片库），此处复用其引用，
      // 不重复写库；自动续拍没有引用，走常规入库
      imageRef: image.imageRef,
    }));
    if (fresh) delivered.push({ image: fresh.image, description: fresh.description, imageRef: undefined });
    const imageRefs: string[] = [];
    for (const visual of delivered) {
      (content as Array<{ type: string; text?: string }>).push({ type: 'text', text: visual.description });
      (content as Array<{ type: string }>).push({
        type: 'image_url',
        image_url: { url: visual.image, detail: 'high' },
      } as never);
      const imageRef = visual.imageRef ?? await imageStore.putFromDataUrl(visual.image);
      if (imageRef) imageRefs.push(imageRef);
    }
    if (refresh && !fresh) {
      (content as Array<{ type: string; text?: string }>).push({ type: 'text', text: 'Latest viewport screenshot unavailable. Call screenshot to recover. Do not reuse earlier screenshot IDs or infer coordinates from older images.' });
    }
    return { message: { role: 'user', content, toolFeedbackFor: toolCalls.map(call => call.id) }, imageRefs };
  }

  // ==================== 内部：收尾 ====================

  private async finalize(
    handle: RunHandle,
    status: 'done' | 'error' | 'aborted',
    error: string | undefined,
    iterations: number,
  ): Promise<void> {
    if (handle.roundText) {
      await this.appendModelMessages(handle, [{ role: 'assistant', content: handle.roundText }]);
      handle.roundText = '';
    }
    if (status !== 'done') {
      await this.appendModelMessages(handle, [{ role: 'user', content: status === 'aborted'
        ? '[System status: the previous run was interrupted. Completed tool results remain valid; unfinished operations are not evidence of success.]'
        : `[System status: the previous run failed. Its partial output may be incomplete.] ${toModelFacingContent(error ?? '')}` }]);
    }
    if (handle.snapshotTimer !== null) {
      globalThis.clearInterval(handle.snapshotTimer);
      handle.snapshotTimer = null;
    }
    handle.record.status = status;
    if (error !== undefined) {
      handle.record.error = error;
      // 持久化进正文与 parts（不 emit token 事件：实时视图由 App 依据
      // assistant-error 事件自行追加，此处只保证重载会话后错误卡片仍可见）
      const errorText = `\n\n${error}`;
      this.appendToPart(handle.record, 'text', errorText);
      handle.record.content += errorText;
    }
    // 终态统一收起推理片段：任何收尾形态（done / aborted / error）下，
    // 未被用户手动展开过的思考过程都应以收起态定稿——流式期间可能从未
    // 到达过「正文/工具触发自动收起」的时点（如中止于纯思考阶段），
    // 不在此收起会让历史重载后的推理片段保持全展开
    collapseReasoningParts(handle.record);
    handle.record.usage = {
      iterations,
      durationMs: Date.now() - handle.startedAt,
      toolCalls: handle.toolCallCount,
    };
    // await 落库：保证 run() resolve 前终态记录已持久化，
    // 避免用户立即发送下一条消息时 priorRecords 读不到本轮结果
    await transcriptEngine.flush(handle.record);
  }

  private async appendModelMessages(handle: RunHandle, messages: ChatMessage[]): Promise<void> {
    const stored = await storeProtocolMessages(messages);
    delete handle.record.modelPartial;
    handle.record.modelMessages = [...(handle.record.modelMessages ?? []), ...stored];
    if (handle.record.modelContext) handle.record.modelContext = [...handle.record.modelContext, ...stored];
    await transcriptEngine.flush(handle.record);
  }

  private summary(
    chatId: string,
    handle: RunHandle,
    iterations: number,
    status: 'done' | 'error' | 'aborted',
    error?: string,
  ): RunSummary {
    return {
      chatId,
      messageId: handle.record.id,
      status,
      iterations,
      durationMs: Date.now() - handle.startedAt,
      error,
      compactions: handle.compactions,
      ...(handle.lastUsage ? { contextUsage: handle.lastUsage } : {}),
    };
  }
}

/**
 * 正文/工具调用出现时收起推理片段（UI 展示约定）。
 * 用户手动展开过的片段（userToggled）不强制收起——流式输出期间用户主动
 * 查看思考过程是明确意图，新内容到达不应将其合上。
 */
function collapseReasoningParts(record: ChatMessageRecord): void {
  for (const part of record.parts) {
    if (part.type === 'reasoning' && !part.userToggled) part.collapsed = true;
  }
}

/**
 * 解析模型给出的工具参数（形态防御优先，再走解析阶梯）。
 *   - 对象 / 数组（异常适配器直传已解析参数）：原样透传——非对象参数由
 *     tool-executor 以「参数必须是 JSON 对象」的可读错误回传模型；
 *   - null / undefined：空参数（协议约定的无参调用）→ {}；
 *   - 字符串：完整 JSON 优先（兼容合法多行/格式化 JSON），失败再回落
 *     「首行 JSON」兼容（部分模型会在 JSON 后追加多余文本）；两级均失败时
 *     抛出带原始参数预览的可读错误，由调用方转为工具错误结果；
 *   - 其余标量（数字/布尔等脏数据）：转字符串后按字符串阶梯处理，
 *     同样以「不是合法 JSON + 原始参数预览」的可读错误收尾。
 */
function parseToolArguments(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object') return raw;
  if (raw === null || raw === undefined) return {};
  const text = typeof raw === 'string' ? raw.trim() : String(raw);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // 落回首行解析；解析失败抛出可分析错误（含原始参数预览，便于定位模型输出问题）
    const firstLine = text.split('\n')[0].trim();
    try {
      return JSON.parse(firstLine);
    } catch (error) {
      const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`工具参数不是合法 JSON（${reason}）。原始参数: "${preview}"`);
    }
  }
}

/** 记录内工具结果的体积上限（字符）；超出以摘要代替，事件流仍携带完整结果供实时渲染 */
const MAX_RECORDED_RESULT_CHARS = 64 * 1024;

/** data URL 图片串（工具结果内联截图的典型形态；绝不落入转录库） */
const DATA_IMAGE_PREFIX = 'data:image/';

/**
 * 从工具结果中剔除内联图片 data URL（递归，深度上限防御脏数据环）。
 * 图片应经独立图片库以引用形态存在；base64 二进制进转录库会同时违反
 * 「消息只持引用」的存储约定并把单条记录撑到数百 KB。
 * 返回占位说明（保留字段结构，模型面/界面均可见「此处曾有图片」）。
 */
function stripInlineDataImages(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (typeof value === 'string') {
    return value.startsWith(DATA_IMAGE_PREFIX) ? '[图片数据已省略]' : value;
  }
  if (Array.isArray(value)) {
    return value.map(item => stripInlineDataImages(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      result[key] = stripInlineDataImages(item, depth + 1);
    }
    return result;
  }
  return value;
}

/** 工具失败原因提取上限（字符）：错误摘要用于 UI 内联展示，过长截断 */
const TOOL_FAILURE_REASON_MAX_CHARS = 600;

/** 从「结果形态」的失败 ToolResult 中提取可读原因（error / message / data.error / 首段文本） */
function describeToolFailure(result: ToolResult): string | undefined {
  const truncate = (text: string): string =>
    text.length <= TOOL_FAILURE_REASON_MAX_CHARS
      ? text
      : `${text.slice(0, TOOL_FAILURE_REASON_MAX_CHARS)}…`;
  if (typeof result.error === 'string' && result.error) return truncate(result.error);
  if (typeof result.message === 'string' && result.message) return truncate(result.message);
  // 部分工具把错误详情放在 data.error（data.message）里
  const dataError = (result.data as { error?: unknown; message?: unknown } | undefined)?.error;
  if (typeof dataError === 'string' && dataError) return truncate(dataError);
  const dataMessage = (result.data as { message?: unknown } | undefined)?.message;
  if (typeof dataMessage === 'string' && dataMessage) return truncate(dataMessage);
  const first = result.content?.[0];
  if (first && first.type === 'text' && typeof first.text === 'string' && first.text) {
    return truncate(first.text);
  }
  return undefined;
}

/** 序列化工具结果并施加体积上限（先剔除内联图片 data URL）；不可序列化或超限时返回可分析的摘要对象 */
function sanitizeRecordedResult(result: unknown): unknown {
  const stripped = stripInlineDataImages(result);
  let text: string;
  try {
    text = JSON.stringify(stripped) ?? 'null';
  } catch {
    return { truncated: true, reason: 'unserializable', type: typeof result };
  }
  if (text.length <= MAX_RECORDED_RESULT_CHARS) {
    return stripped;
  }
  return {
    truncated: true,
    reason: 'oversize',
    originalSize: text.length,
    limit: MAX_RECORDED_RESULT_CHARS,
    preview: text.slice(0, MAX_RECORDED_RESULT_CHARS),
  };
}

/** 全局单例（生产依赖） */
export const conversationEngine = new ConversationEngine();
export type { ConversationRuntime };

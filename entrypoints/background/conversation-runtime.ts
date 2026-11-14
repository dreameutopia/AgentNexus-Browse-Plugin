import {
  conversationEngine,
  composeLlmUserMessage,
} from "../sidepanel/core/conversation/conversation-engine";
import { queryActivePageInfo } from "../sidepanel/utils/system-context";
import { contextCompactor } from "../sidepanel/core/context/compactor";
import { transcriptEngine } from "../sidepanel/core/context/transcript-engine";
import {
  COMPACTION_PRE_RUN_RATIO,
  measureContextUsage,
} from "../sidepanel/core/context/context-meter";
import { skillEngine } from "../sidepanel/core/registry/skill-engine";
import { appSettingsStore } from "../sidepanel/utils/channels/app-settings";
import { registerInteractHandler } from "@/tools/interact/interact-ui-bridge";
import type { InteractResolution } from "@/tools/interact/interact-ui-bridge";
import { toolExecutionEngine } from "../sidepanel/core/tools/tool-execution-engine";
import { pageGlow } from "./page-glow";
import {
  CONVERSATION_PORT,
  CONVERSATION_READY,
  LOCAL_PAGE_GLOW_PORT,
  type LocalPageGlowCommand,
  type Question,
  type RuntimeCommand,
  type RuntimeMessage,
  type RuntimeQuestion,
} from "../sidepanel/core/conversation/runtime-protocol";

/**
 * 一个会话的停止阶段（同步中止语义的状态机）。
 *
 * 用户点停止后，必须**等它走完**才允许新的 run 进入，否则新消息会与上一轮
 * 迟到的工具结果交错。三个阶段：
 *   1. aborting      已置位中止，但运行尚未结算（工具仍在执行 / 收尾中）；
 *   2. settling      运行已结算，仍在强制中断工具并把中断结果写入模型上下文；
 *   3. done          工具轮次已销毁、结果已落库——停止流程真正结束。
 *
 * 任何阶段都对新 run 有排队语义：新请求等待 done 之后才开始，用户的输入
 * 不丢弃、也不会与上一轮交错。
 */
type StopPhase = 'aborting' | 'settling' | 'done';

interface StopState {
  phase: StopPhase;
  /** 该阶段完成的信号（resolve 于 phase === 'done'） */
  resolve: () => void;
  settled: Promise<void>;
}

/**
 * 中止时的收尾等待上限（毫秒）。
 * 引擎已给每个工具配了 kill 钩子与结算上界，正常路径远快于此值；本值是
 * 防御性上界——即使某条工具路径异常（如钩子卡死），停止流程也必须在可预期
 * 时间内放行，绝不让用户被一个不响应的工具永久锁死。
 */
const STOP_SETTLE_TIMEOUT_MS = 30_000;

/** 后台运行时：一个会话同时至多一个停止阶段在进行 */
const stopStates = new Map<string, StopState>();

/**
 * 取得（或创建）一个会话的停止阶段。同会话并发调用共享同一阶段，
 * 避免两个停止流程互相踩踏。
 */
function ensureStopState(chatId: string): StopState {
  const existing = stopStates.get(chatId);
  if (existing) return existing;
  let resolve!: () => void;
  const settled = new Promise<void>(r => {
    resolve = r;
  });
  const state: StopState = { phase: 'aborting', resolve, settled };
  stopStates.set(chatId, state);
  return state;
}

/** 终止一个会话的停止阶段（幂等；同时释放排队中的新请求） */
function finishStopState(chatId: string, state: StopState): void {
  if (state.phase !== 'done') state.phase = 'done';
  stopStates.delete(chatId);
  state.resolve();
}

/**
 * 会话级停止：同步中断所有正在执行的工具并等待其结算、写入上下文、落库。
 *
 * 顺序（刻意如此，保证「先停下，再落定」）：
 *   1. 置位运行级中止信号 —— 模型请求取消，后续轮次不再发起；
 *   2. 强制中断该会话正在执行的工具（引擎轮次级中止，批量中断）——
 *      执行中的调用立即结算为「中断」，批次内未开始的调用立即跳过；
 *   3. 等待该运行真正结算完毕 —— 届时中断结果已按标准协议写入模型上下文
 *      （tool 结果与 assistant.tool_calls 一一配对）并随转录落库，轮次 id 已销毁。
 * 返回后，该会话不存在任何「仍在执行」的工具，用户的新消息不会与上一轮交错。
 */
async function settleStop(chatId: string): Promise<void> {
  const state = ensureStopState(chatId);
  try {
    // 阶段 1/2：置位运行级中止 + 打断预运行阶段 + 收敛挂起提问
    // （与 abort 路径共用 abortRun，两条路径的动作必须一致）
    abortRun(chatId);
    // 阶段 3：等待该运行真正结算完毕。
    //
    // **有上界**：停止流程绝不能把 UI 永久锁死。即便出现预期之外的卡死
    // （工具不响应中止、底层通道挂起），也必须在可预期时间内放行。
    // 超时放行的正确性由会话引擎的 ChatBusyError 兜底：旧运行未结束前，
    // 同一会话的新运行会被直接拒绝（不会与旧运行的迟到结果交错）。
    const inFlight = inFlightRuns.get(chatId);
    if (inFlight) {
      let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
      const awaited = inFlight.then(
        () => 'settled' as const,
        () => 'settled' as const,
      );
      const timeout = new Promise<'timeout'>(resolve => {
        timer = globalThis.setTimeout(() => resolve('timeout'), STOP_SETTLE_TIMEOUT_MS);
      });
      const outcome = await Promise.race([awaited, timeout]);
      // 及时清理定时器：否则每次停止都会留下一个 30s 的悬空定时器，
      // 无谓地吊着 MV3 worker 的生命周期
      if (timer !== null) globalThis.clearTimeout(timer);
      if (outcome === 'timeout') {
        console.warn(
          `[ConversationRuntime] 会话 ${chatId} 的运行在 ${STOP_SETTLE_TIMEOUT_MS}ms 内未结算，` +
            '停止流程已放行（该会话的新运行将被 ChatBusyError 拒绝，直到旧运行真正结束）',
        );
      }
    }
    if (state.phase === 'done') return;
    // 阶段 3b：兜底等待——运行已结算但仍有工具轮次在收尾（如迟到的 kill 钩子）
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const bounded = new Promise<void>(resolve => {
      timer = globalThis.setTimeout(resolve, STOP_SETTLE_TIMEOUT_MS);
    });
    try {
      await Promise.race([toolExecutionEngine.interrupt(chatId), bounded]);
    } finally {
      if (timer !== null) globalThis.clearTimeout(timer);
    }
  } finally {
    finishStopState(chatId, state);
  }
}

/**
 * 会话的在途运行登记（module 级）。
 *
 * 为什么是 module 级：停止流程需要在**运行结算之后**继续等待工具轮次收尾，
 * 而运行的 finally 会立刻清掉 initConversationRuntime 内部的登记——把在途
 * 运行提升为模块级状态后，「等待运行结算」与「等待停止阶段完成」互不遮蔽，
 * 两条路径各自可见，也不会因 UI 断开（视图端口卸载）而丢失。
 */
const inFlightRuns = new Map<string, Promise<unknown>>();

/**
 * 预运行阶段（发送前压缩 / 装配）的中止控制器（module 级）。
 *
 * 与 inFlightRuns 同理：停止流程必须能在**运行登记之前**就打断预运行阶段
 * （一次完整的压缩 LLM 调用可能长达数分钟），否则「停止」会一直等它结束。
 */
const preparingRuns = new Map<string, AbortController>();

function keepWorkerAlive() {
  return setInterval(() => {
    void chrome.runtime.getPlatformInfo().catch(() => undefined);
  }, 20_000);
}

/**
 * 挂起中的提问（守卫确认 / 工具审批 / interact）——module 级。
 *
 * 停止时必须一并收敛：这些提问各自带超时（审批 60s、interact 由设置决定），
 * 不收敛会让运行一直挂在提问上，「停止」永远等不到运行结算。
 */
const pendingQuestions = new Map<
  string,
  Question & { finish: (value: boolean | InteractResolution) => void }
>();

/**
 * 已请求中止的会话（module 级）。
 *
 * 语义：本次运行是**被用户停掉的**，不是「跑失败了」。两条停止路径都必须
 * 登记它——否则预运行阶段被中止时，任务会以「会话已停止」异常收尾，UI 看到
 * 的是一条错误卡片，而不是干净的「已停止」。
 */
const cancelled = new Set<string>();

/** 运行时是否已初始化（端口监听器只允许注册一次） */
let runtimeInitialized = false;

/**
 * 当前正在占用运行资源的会话（跨上下文唯一权威）。
 *
 * 覆盖三个维度：
 *   - inFlightRuns   模型请求 / 工具轮次在途；
 *   - preparingRuns  发送前压缩 / 运行时装配在途（此时引擎尚未登记运行）；
 *   - stopStates     停止流程在途（已置位中止、尚未结算）。
 *
 * 任一为真都意味着「这个会话正在动」——管理中心据此拒绝切换 / 删除，
 * 必须等用户主动停止或任务自然结束。侧边栏本地引擎持有的学习类运行
 * 不在此列（那部分由侧边栏自报，见 utils/sessions/session-bridge）。
 */
export function listBusySessionIds(): string[] {
  const ids = new Set<string>();
  for (const id of inFlightRuns.keys()) ids.add(id);
  for (const id of preparingRuns.keys()) ids.add(id);
  for (const [id, state] of stopStates) {
    if (state.phase !== 'done') ids.add(id);
  }
  return [...ids];
}

/**
 * 统一的中止动作：置位运行级中止 + 打断预运行阶段 + 收敛挂起提问。
 *
 * 两条停止路径（abort / abortAndWait）共用本函数——它们的差别只在
 * 「是否等运行结算完毕」，动作本身必须一致，否则必然出现某条路径漏掉
 * 某个中止点（历史上就出现过：abort 打断了压缩，abortAndWait 没有）。
 *
 * @returns 会话引擎侧的中止结果（false = 该会话没有运行中的引擎运行）
 */
function abortRun(chatId: string): boolean {
  pageGlow.stop(chatId);
  // 登记「被用户停掉」：两条停止路径共用，缺一不可
  if (inFlightRuns.has(chatId) || preparingRuns.has(chatId)) cancelled.add(chatId);
  const aborted = conversationEngine.abort(chatId);
  // 预运行阶段（压缩 / 装配）：引擎尚未登记运行，engine.abort 是空操作，
  // 必须经它自己的 controller 打断
  preparingRuns.get(chatId)?.abort();
  // 挂起提问：审批 / interact / 守卫——收敛它们，运行才可能继续往下走
  for (const q of pendingQuestions.values())
    if (q.chatId === chatId) {
      q.finish(
        q.question.kind === "interact"
          ? { answered: false, status: "dismissed" }
          : false,
      );
    }
  return aborted;
}

/** The worker owns runs. A disconnected view never aborts a request or a tool. */
export function initConversationRuntime(): void {
  // 幂等保护：重复初始化会注册第二个端口监听器，导致同一条命令被处理两次
  // （回复重复、运行重复登记）。worker 重启会重置模块状态，故此处只需防重复调用。
  if (runtimeInitialized) {
    console.warn('[ConversationRuntime] 重复初始化被忽略（端口监听器已注册）');
    return;
  }
  runtimeInitialized = true;
  const ports = new Set<chrome.runtime.Port>();
  const compacting = new Set<string>();
  const post = (port: chrome.runtime.Port, message: RuntimeMessage) => {
    try {
      port.postMessage(message);
    } catch {
      ports.delete(port);
    }
  };
  const broadcast = (message: RuntimeMessage) => {
    for (const port of ports) post(port, message);
  };
  const ask = (
    chatId: string,
    question: RuntimeQuestion,
    timeoutMs: number,
  ): Promise<boolean | InteractResolution> =>
    new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(
        () =>
          finish(
            question.kind === "interact"
              ? { answered: false, status: "timeout" }
              : false,
          ),
        timeoutMs,
      );
      const finish = (value: boolean | InteractResolution) => {
        clearTimeout(timer);
        pendingQuestions.delete(id);
        resolve(value);
      };
      const pending = {
        id,
        chatId,
        question,
        deadline: Date.now() + timeoutMs,
        finish,
      };
      pendingQuestions.set(id, pending);
      broadcast({
        type: "question",
        question: { id, chatId, question, deadline: pending.deadline },
      });
    });

  // Interactive tools run in the worker too; the pending question survives closing the UI.
  registerInteractHandler((request, context) => {
    const chatId = context?.chatId;
    if (!chatId || !inFlightRuns.has(chatId) || cancelled.has(chatId))
      return Promise.resolve({ answered: false, status: "dismissed" });
    return ask(
      chatId,
      { kind: "interact", request },
      appSettingsStore.getInteractTimeoutMinutes() * 60_000,
    ) as Promise<InteractResolution>;
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === LOCAL_PAGE_GLOW_PORT) {
      const owner = Symbol("local-page-glow");
      let operation = 0;
      let setTarget: ((tabId: number) => void) | undefined;
      pageGlow.start(owner);
      const keepAlive = keepWorkerAlive();
      port.onMessage.addListener((message: LocalPageGlowCommand) => {
        if (!Number.isSafeInteger(message?.operation)) return;
        if (message.type === "begin" && message.operation > operation) {
          operation = message.operation;
          setTarget = pageGlow.beginOperation(owner, message.followForeground === true);
        } else if (message.type === "target" && message.operation === operation) {
          setTarget?.(message.tabId);
        }
      });
      port.onDisconnect.addListener(() => {
        clearInterval(keepAlive);
        pageGlow.stop(owner);
      });
      return;
    }
    // onConnect is the internal extension channel; external extensions are
    // delivered to onConnectExternal. MessageSender.id is optional.
    if (port.name !== CONVERSATION_PORT) return;
    ports.add(port);
    const preflightGlow = Symbol("send-preflight");
    let preflightKeepAlive: ReturnType<typeof keepWorkerAlive> | undefined;
    const endPreflight = () => {
      clearInterval(preflightKeepAlive);
      preflightKeepAlive = undefined;
      pageGlow.stop(preflightGlow);
    };
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      endPreflight();
    });
    port.onMessage.addListener(async (command: RuntimeCommand) => {
      const reply = (value: any) =>
        post(port, { type: "reply", id: command.id, value });
      const fail = (error: unknown) =>
        post(port, {
          type: "reply",
          id: command.id,
          error: String(error instanceof Error ? error.message : error),
        });
      if (command.type === "preparingGlow") {
        if (command.active) {
          pageGlow.start(preflightGlow, command.windowId);
          preflightKeepAlive ??= keepWorkerAlive();
        } else endPreflight();
        reply(true);
      } else if (command.type === "attach") {
        reply({
          running: inFlightRuns.has(command.chatId),
          compacting: compacting.has(command.chatId),
          record: conversationEngine.getRunningRecord(command.chatId),
          questions: [...pendingQuestions.values()]
            .filter((q) => q.chatId === command.chatId)
            .map(({ finish: _finish, ...q }) => q),
        });
      } else if (command.type === "answer") {
        const pending = pendingQuestions.get(command.questionId);
        if (
          pending &&
          Date.now() < pending.deadline &&
          (pending.question.kind === "interact"
            ? typeof command.answer === "object"
            : typeof command.answer === "boolean")
        ) {
          pending.finish(command.answer);
        }
        reply(true);
      } else if (command.type === "abort") {
        endPreflight();
        // 快速中止（非阻塞）：立即置位中止与轮次中断，只等运行结算——
        // 与 abortAndWait 的差别是「不等工具轮次收尾」，用于不关心收尾时序的路径。
        if (inFlightRuns.has(command.chatId)) cancelled.add(command.chatId);
        const aborted = abortRun(command.chatId);
        void Promise.resolve(inFlightRuns.get(command.chatId))
          .catch(() => undefined)
          .then(() => reply(aborted));
      } else if (command.type === "abortAndWait") {
        endPreflight();
        // 同步中止：强制中断该会话所有正在执行的工具，等待它们结算、
        // 结果写入模型上下文并落库——resolve 后才允许发送下一条消息。
        void settleStop(command.chatId)
          .then(() => reply(true))
          .catch(error => fail(error));
      } else if (command.type === "run") {
        const { runtime } = command;
        // 排队：停止流程进行中时，新消息等待「已真正停下」后再进入，
        // 保证上一轮的迟到工具结果不会与新一轮的请求交错（输入不丢弃）。
        // 排队**先于**在途检查：停止过程中旧运行尚未从在途表摘除，
        // 若先检查就会把「停止后立刻发新消息」误判为并发运行而直接拒绝。
        const stopState = stopStates.get(runtime.chatId);
        if (stopState && stopState.phase !== "done") {
          try {
            await stopState.settled;
          } catch {
            /* 停止阶段的异常不影响新运行的发起 */
          }
        }
        if (inFlightRuns.has(runtime.chatId)) {
          fail(new Error("会话已有运行中的任务"));
          return;
        }
        // Extension API activity keeps MV3 alive during an active task, including long
        // model/tool waits. The timer is independent of all sidepanel connections.
        const keepAlive = keepWorkerAlive();
        const prepareAbort = new AbortController();
        preparingRuns.set(runtime.chatId, prepareAbort);
        pageGlow.start(runtime.chatId, preflightKeepAlive === undefined ? command.windowId : undefined);
        endPreflight();
        const emit = (
          event: import("../sidepanel/core/types").ConversationEvent,
        ) => {
          if (event.type === "compaction") {
            if (event.phase === "start") compacting.add(runtime.chatId);
            else compacting.delete(runtime.chatId);
          }
          broadcast({ type: "event", event });
        };
        const task = (async () => {
          await Promise.all([skillEngine.restore(), appSettingsStore.load()]);
          if (cancelled.has(runtime.chatId)) throw new Error("会话已停止");
          // 预运行计量与引擎构造同口径注入 <system_context>（时间时区 +
          // 激活网页）；queryActivePageInfo 失败返回 null，不影响计量
          const activePage = await queryActivePageInfo();
          // The long first compaction belongs to the worker as well. Closing the
          // panel during this model request must not discard the pending input.
          if (
            // Retries update the existing last record. Runtime compaction keeps
            // its continuation in modelContext without advancing past its seq.
            !runtime.retryTarget && runtime.initialContext?.length &&
            measureContextUsage({
              systemPrompt: runtime.systemPrompt,
              toolIds: runtime.advertisedToolIds ?? runtime.toolIds,
              messages: [
                ...runtime.initialContext,
                composeLlmUserMessage(
                  runtime.userInput,
                  runtime.attachmentPrompt,
                  runtime.userImages,
                  runtime.pageQuotePrompt,
                  false,
                  activePage,
                ),
                ...runtime.activationContext,
              ],
              threshold: runtime.model.contextThreshold,
            }).ratio >= COMPACTION_PRE_RUN_RATIO
          ) {
            emit({
              type: "compaction",
              chatId: runtime.chatId,
              phase: "start",
              trigger: "pre-run",
            });
            const startedAt = Date.now();
            try {
              const result = await contextCompactor.compact({
                messages: runtime.initialContext,
                model: runtime.model,
                threshold: runtime.model.contextThreshold,
                signal: prepareAbort.signal,
                strategy: 'pre-run',
              });
              if (prepareAbort.signal.aborted) throw new Error("会话已停止");
              await transcriptEngine.setCompaction(
                runtime.chatId,
                result.summary,
                runtime.priorMaxSeq,
              );
              runtime.initialContext = [
                contextCompactor.buildSummaryMessage(
                  result.summary,
                  Date.now(),
                  runtime.initialContext.length,
                ),
              ];
              // 结果回执随 runtime 进入引擎：助手记录创建时种子为消息时间线的
              // 首个压缩片段（持久化），与 UI 侧「缓冲事件、assistant-start 时
              // 种子」同一来源——时间线在两条路径上落成同一形态。
              runtime.preRunCompaction = {
                status: "success",
                originalTokens: result.originalTokens,
                summaryTokens: result.summaryTokens,
                summary: result.summary,
                durationMs: Date.now() - startedAt,
              };
              emit({
                type: "compaction",
                chatId: runtime.chatId,
                phase: "done",
                trigger: "pre-run",
                originalTokens: result.originalTokens,
                summaryTokens: result.summaryTokens,
                summary: result.summary,
                durationMs: runtime.preRunCompaction.durationMs,
              });
            } catch (error) {
              if (prepareAbort.signal.aborted) throw error;
              const failureText = String(
                error instanceof Error ? error.message : error,
              );
              runtime.preRunCompaction = {
                status: "error",
                error: failureText,
                durationMs: Date.now() - startedAt,
              };
              emit({
                type: "compaction",
                chatId: runtime.chatId,
                phase: "failed",
                trigger: "pre-run",
                error: failureText,
                durationMs: runtime.preRunCompaction.durationMs,
              });
            }
          }
          if (prepareAbort.signal.aborted) throw new Error("会话已停止");
          preparingRuns.delete(runtime.chatId);
          return conversationEngine.run(runtime, {
            observer: emit,
            beginPageOperation: (followForeground) => pageGlow.beginOperation(runtime.chatId, followForeground),
            onLimitReached: (guard, info) =>
              ask(
                runtime.chatId,
                { kind: "guard", guard, info },
                60_000,
              ) as Promise<boolean>,
            onToolApproval: (request) =>
              ask(
                runtime.chatId,
                { kind: "approval", request },
                60_000,
              ) as Promise<boolean>,
          });
        })().finally(() => pageGlow.stop(runtime.chatId));
        inFlightRuns.set(runtime.chatId, task);
        void task
          .then(
            (summary) => {
              reply(summary);
              broadcast({ type: "settled", chatId: runtime.chatId, summary });
            },
            (error) => {
              fail(error);
              if (cancelled.has(runtime.chatId))
                emit({
                  type: "aborted",
                  chatId: runtime.chatId,
                  messageId: "",
                });
              broadcast({
                type: "settled",
                chatId: runtime.chatId,
                error: cancelled.has(runtime.chatId)
                  ? undefined
                  : String(error),
              });
            },
          )
          .finally(() => {
            clearInterval(keepAlive);
            inFlightRuns.delete(runtime.chatId);
            cancelled.delete(runtime.chatId);
            preparingRuns.delete(runtime.chatId);
            compacting.delete(runtime.chatId);
            for (const q of pendingQuestions.values())
              if (q.chatId === runtime.chatId) q.finish(false);
          });
      }
    });
  });

  // A round trip wakes a suspended worker and confirms this version registered
  // its port listener before the view dispatches a run. Old loaded workers must
  // be reloaded, rather than accepting input into a channel with no receiver.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== CONVERSATION_READY) return;
    sendResponse({ ready: true, protocol: CONVERSATION_PORT });
  });
}

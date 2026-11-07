import {
  conversationEngine,
  composeLlmUserMessage,
} from "../sidepanel/core/conversation/conversation-engine";
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
import {
  CONVERSATION_PORT,
  CONVERSATION_READY,
  type Question,
  type RuntimeCommand,
  type RuntimeMessage,
  type RuntimeQuestion,
} from "../sidepanel/core/conversation/runtime-protocol";

/** The worker owns runs. A disconnected view never aborts a request or a tool. */
export function initConversationRuntime(): void {
  const ports = new Set<chrome.runtime.Port>();
  const running = new Map<string, Promise<unknown>>();
  const cancelled = new Set<string>();
  const preparing = new Map<string, AbortController>();
  const compacting = new Set<string>();
  const questions = new Map<
    string,
    Question & { finish: (value: boolean | InteractResolution) => void }
  >();
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
        questions.delete(id);
        resolve(value);
      };
      const pending = {
        id,
        chatId,
        question,
        deadline: Date.now() + timeoutMs,
        finish,
      };
      questions.set(id, pending);
      broadcast({
        type: "question",
        question: { id, chatId, question, deadline: pending.deadline },
      });
    });

  // Interactive tools run in the worker too; the pending question survives closing the UI.
  registerInteractHandler((request, context) => {
    const chatId = context?.chatId;
    if (!chatId || !running.has(chatId) || cancelled.has(chatId))
      return Promise.resolve({ answered: false, status: "dismissed" });
    return ask(
      chatId,
      { kind: "interact", request },
      appSettingsStore.getInteractTimeoutMinutes() * 60_000,
    ) as Promise<InteractResolution>;
  });

  chrome.runtime.onConnect.addListener((port) => {
    // onConnect is the internal extension channel; external extensions are
    // delivered to onConnectExternal. MessageSender.id is optional.
    if (port.name !== CONVERSATION_PORT) return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    port.onMessage.addListener((command: RuntimeCommand) => {
      const reply = (value: any) =>
        post(port, { type: "reply", id: command.id, value });
      const fail = (error: unknown) =>
        post(port, {
          type: "reply",
          id: command.id,
          error: String(error instanceof Error ? error.message : error),
        });
      if (command.type === "attach") {
        reply({
          running: running.has(command.chatId),
          compacting: compacting.has(command.chatId),
          record: conversationEngine.getRunningRecord(command.chatId),
          questions: [...questions.values()]
            .filter((q) => q.chatId === command.chatId)
            .map(({ finish: _finish, ...q }) => q),
        });
      } else if (command.type === "answer") {
        const pending = questions.get(command.questionId);
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
        if (running.has(command.chatId)) cancelled.add(command.chatId);
        const aborted = conversationEngine.abort(command.chatId);
        preparing.get(command.chatId)?.abort();
        for (const q of questions.values())
          if (q.chatId === command.chatId) {
            q.finish(
              q.question.kind === "interact"
                ? { answered: false, status: "dismissed" }
                : false,
            );
          }
        void Promise.resolve(running.get(command.chatId))
          .catch(() => undefined)
          .then(() => reply(aborted));
      } else if (command.type === "run") {
        const { runtime } = command;
        if (running.has(runtime.chatId)) {
          fail(new Error("会话已有运行中的任务"));
          return;
        }
        // Extension API activity keeps MV3 alive during an active task, including long
        // model/tool waits. The timer is independent of all sidepanel connections.
        const keepAlive = setInterval(() => {
          void chrome.runtime.getPlatformInfo();
        }, 20_000);
        const prepareAbort = new AbortController();
        preparing.set(runtime.chatId, prepareAbort);
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
          // The long first compaction belongs to the worker as well. Closing the
          // panel during this model request must not discard the pending input.
          if (
            runtime.initialContext?.length &&
            measureContextUsage({
              systemPrompt: runtime.systemPrompt,
              toolIds: runtime.advertisedToolIds ?? runtime.toolIds,
              messages: [
                ...runtime.initialContext,
                composeLlmUserMessage(
                  runtime.userInput,
                  runtime.attachmentPrompt,
                  runtime.userImages,
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
          preparing.delete(runtime.chatId);
          return conversationEngine.run(runtime, {
            observer: emit,
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
        })();
        running.set(runtime.chatId, task);
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
            running.delete(runtime.chatId);
            cancelled.delete(runtime.chatId);
            preparing.delete(runtime.chatId);
            compacting.delete(runtime.chatId);
            for (const q of questions.values())
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

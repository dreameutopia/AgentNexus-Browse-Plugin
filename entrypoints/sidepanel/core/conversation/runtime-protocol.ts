import type {
  ChatMessageRecord,
  ConversationEvent,
  ConversationRuntime,
  RunSummary,
} from "../types";
import type { GuardKind, ToolApprovalRequest } from "./conversation-engine";
import type {
  InteractRequest,
  InteractResolution,
} from "@/tools/interact/interact-ui-bridge";

export const CONVERSATION_PORT = "agentnexus-conversation";
export const CONVERSATION_READY = "agentnexus-conversation-ready";
export const ACTIVE_CHAT_KEY = "sidepanel.activeChatId";
export const LOCAL_PAGE_GLOW_PORT = "agentnexus:local-page-glow";
export const PAGE_TOOL_TARGET_MESSAGE = "agentnexus:page-tool-target";
export type LocalPageGlowCommand =
  | { type: "begin"; operation: number; followForeground: boolean }
  | { type: "target"; operation: number; tabId: number };
export type BeginPageOperation = (followForeground: boolean) => (tabId: number) => void;
export interface LocalPageGlow {
  beginPageOperation: BeginPageOperation;
  stop(): void;
}

export type RuntimeQuestion =
  | {
      kind: "guard";
      guard: GuardKind;
      info: {
        iterations?: number;
        minutes?: number;
        consecutiveFailures?: number;
      };
    }
  | { kind: "approval"; request: ToolApprovalRequest }
  | { kind: "interact"; request: InteractRequest };
export type Question = {
  id: string;
  chatId: string;
  question: RuntimeQuestion;
  deadline: number;
};
export type RuntimeCommand =
  | { id: string; type: "run"; runtime: ConversationRuntime; windowId?: number }
  | { id: string; type: "preparingGlow"; active: boolean; windowId?: number }
  | { id: string; type: "attach" | "abort" | "abortAndWait"; chatId: string }
  | {
      id: string;
      type: "answer";
      questionId: string;
      answer: boolean | InteractResolution;
    };

/**
 * 可发起的命令形态（去掉 id）：供视图端构造命令时使用。
 * 显式导出避免联合类型的分配（distributive conditional）在 Omit 下退化成
 * 只剩单个成员，导致类型提示与校验全部失效。
 */
export type RuntimeCommandInput =
  | Omit<Extract<RuntimeCommand, { type: "run" }>, "id">
  | Omit<Extract<RuntimeCommand, { type: "preparingGlow" }>, "id">
  | Omit<Extract<RuntimeCommand, { type: "attach" | "abort" | "abortAndWait" }>, "id">
  | Omit<Extract<RuntimeCommand, { type: "answer" }>, "id">;
export interface RuntimeSnapshot {
  running: boolean;
  compacting: boolean;
  record: ChatMessageRecord | null;
  questions: Question[];
}
export type RuntimeMessage =
  | {
      type: "reply";
      id: string;
      value?: RuntimeSnapshot | RunSummary | boolean;
      error?: string;
    }
  | { type: "event"; event: ConversationEvent }
  | { type: "question"; question: Question }
  | { type: "settled"; chatId: string; summary?: RunSummary; error?: string };

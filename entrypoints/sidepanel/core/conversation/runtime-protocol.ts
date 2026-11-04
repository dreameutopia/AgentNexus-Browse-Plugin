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
  | { id: string; type: "run"; runtime: ConversationRuntime }
  | { id: string; type: "attach" | "abort"; chatId: string }
  | {
      id: string;
      type: "answer";
      questionId: string;
      answer: boolean | InteractResolution;
    };
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

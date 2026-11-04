import type { ConversationRuntime, RunSummary } from "../types";
import type { RunOptions } from "./conversation-engine";
import { getInteractHandler } from "@/tools/interact/interact-ui-bridge";
import {
  CONVERSATION_PORT,
  CONVERSATION_READY,
  type Question,
  type RuntimeCommand,
  type RuntimeMessage,
  type RuntimeSnapshot,
} from "./runtime-protocol";

/** View-side transport. Attach's reply is an ordered barrier before live events. */
export class ConversationRuntimeClient {
  private port: chrome.runtime.Port | null = null;
  private requests = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private options = new Map<string, RunOptions>();
  private running = new Set<string>();
  private buffered: RuntimeMessage[] | null = null;
  private questionIds = new Set<string>();
  private generation = 0;
  private ready: Promise<void> | null = null;
  onSettled?: (chatId: string, summary?: RunSummary, error?: string) => void;

  private connect(): chrome.runtime.Port {
    if (this.port) return this.port;
    const port = chrome.runtime.connect({ name: CONVERSATION_PORT });
    this.port = port;
    port.onMessage.addListener((message: RuntimeMessage) => {
      if (message.type === "reply") {
        const pending = this.requests.get(message.id);
        this.requests.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error));
        else pending?.resolve(message.value);
      } else if (this.buffered) this.buffered.push(message);
      else this.deliver(message);
    });
    port.onDisconnect.addListener(() => {
      // Chrome exposes connection failures only inside this callback. Reading
      // lastError also prevents an unchecked runtime.lastError console entry.
      const reason = chrome.runtime.lastError?.message;
      if (this.port !== port) return;
      this.generation++;
      this.port = null;
      this.ready = null;
      for (const pending of this.requests.values())
        pending.reject(new Error(reason?.includes("Receiving end does not exist")
          ? "会话后台尚未就绪，请在扩展管理页重新加载扩展后重试"
          : "会话后台连接已断开，请重新打开侧边栏后重试"));
      this.requests.clear();
      this.running.clear();
    });
    return port;
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          const response = await chrome.runtime.sendMessage({ type: CONVERSATION_READY });
          if (response?.ready !== true || response?.protocol !== CONVERSATION_PORT) throw new Error('missing runtime');
        } catch {
          throw new Error("会话后台尚未就绪，请在扩展管理页重新加载扩展后重试");
        }
      })();
    }
    try { await this.ready; }
    catch (error) { this.ready = null; throw error; }
  }

  private async request(
    command:
      | Omit<Extract<RuntimeCommand, { type: "run" }>, "id">
      | Omit<Extract<RuntimeCommand, { type: "attach" | "abort" }>, "id">
      | Omit<Extract<RuntimeCommand, { type: "answer" }>, "id">,
  ): Promise<any> {
    const generation = this.generation;
    await this.ensureReady();
    if (generation !== this.generation) throw new Error("会话视图已关闭");
    const port = this.connect();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      try {
        port.postMessage({ ...command, id });
      } catch (error) {
        this.requests.delete(id);
        reject(error);
      }
    });
  }

  private deliver(message: RuntimeMessage): void {
    if (message.type === "event")
      this.options.get(message.event.chatId)?.observer?.(message.event);
    if (
      message.type === "question" &&
      this.options.has(message.question.chatId)
    ) {
      void this.answer(message.question).catch(console.warn);
    }
    if (message.type === "settled") {
      this.running.delete(message.chatId);
      this.onSettled?.(message.chatId, message.summary, message.error);
    }
  }

  private async answer(pending: Question): Promise<void> {
    if (this.questionIds.has(pending.id)) return;
    this.questionIds.add(pending.id);
    const generation = this.generation;
    const options = this.options.get(pending.chatId);
    const q = pending.question;
    try {
      const answer =
        q.kind === "guard"
          ? ((await options?.onLimitReached?.(q.guard, q.info)) ?? false)
          : q.kind === "approval"
            ? ((await options?.onToolApproval?.(q.request)) ?? false)
            : ((await getInteractHandler()?.(q.request)) ?? {
                answered: false,
                status: "dismissed" as const,
              });
      if (generation === this.generation)
        await this.request({ type: "answer", questionId: pending.id, answer });
    } finally {
      this.questionIds.delete(pending.id);
    }
  }

  isRunning(chatId: string): boolean {
    return this.running.has(chatId);
  }
  detach(): void {
    this.generation++;
    this.questionIds.clear();
    const port = this.port;
    this.port = null;
    this.ready = null;
    this.options.clear();
    this.running.clear();
    for (const pending of this.requests.values())
      pending.reject(new Error("会话视图已关闭"));
    this.requests.clear();
    port?.disconnect();
  }
  abort(chatId: string): boolean {
    void this.request({ type: "abort", chatId }).catch(console.warn);
    return this.running.has(chatId);
  }

  async abortAndWait(chatId: string): Promise<void> {
    await this.request({ type: "abort", chatId });
    this.running.delete(chatId);
  }

  async run(
    runtime: ConversationRuntime,
    options: RunOptions = {},
  ): Promise<RunSummary> {
    this.options.set(runtime.chatId, options);
    this.running.add(runtime.chatId);
    try {
      return await this.request({ type: "run", runtime });
    } finally {
      this.running.delete(runtime.chatId);
    }
  }

  /** Read history AFTER this barrier, then hydrate the snapshot and release events. */
  async attach(
    chatId: string,
    options: RunOptions,
    hydrate: (snapshot: RuntimeSnapshot) => Promise<void>,
  ): Promise<void> {
    this.options.clear();
    this.options.set(chatId, options);
    this.buffered = [];
    try {
      const snapshot: RuntimeSnapshot = await this.request({
        type: "attach",
        chatId,
      });
      // Events before the reply are already represented by its snapshot.
      this.buffered = [];
      if (snapshot.running) this.running.add(chatId);
      else this.running.delete(chatId);
      await hydrate(snapshot);
      for (const question of snapshot.questions)
        this.buffered.push({ type: "question", question });
    } finally {
      const buffered = this.buffered ?? [];
      this.buffered = null;
      for (const message of buffered) this.deliver(message);
    }
  }
}

export const backgroundConversation = new ConversationRuntimeClient();

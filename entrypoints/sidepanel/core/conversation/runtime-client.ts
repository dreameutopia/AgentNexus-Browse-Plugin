import type { ConversationRuntime, RunSummary } from "../types";
import type { RunOptions } from "./conversation-engine";
import { getInteractHandler } from "@/tools/interact/interact-ui-bridge";
import {
  CONVERSATION_PORT,
  CONVERSATION_READY,
  LOCAL_PAGE_GLOW_PORT,
  type LocalPageGlow,
  type LocalPageGlowCommand,
  type Question,
  type RuntimeCommandInput,
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
  private panelWindow?: Promise<number | undefined>;
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
      this.panelWindow = undefined;
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

  private async request(command: RuntimeCommandInput): Promise<any> {
    const generation = this.generation;
    const targetWindow = command.type === "run" || (command.type === "preparingGlow" && command.active)
      ? this.panelWindow ?? this.findPanelWindow()
      : undefined;
    await this.ensureReady();
    const windowId = await targetWindow;
    if (generation !== this.generation) throw new Error("会话视图已关闭");
    if (command.type === "preparingGlow" && command.active && targetWindow !== this.panelWindow) return;
    const port = this.connect();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      try {
        port.postMessage({ ...command, ...(windowId !== undefined ? { windowId } : {}), id });
      } catch (error) {
        this.requests.delete(id);
        reject(error);
      }
    });
  }

  private async findPanelWindow(): Promise<number | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [tab] = await Promise.race([
        chrome.tabs.query({ active: true, currentWindow: true, windowType: "normal" }),
        new Promise<chrome.tabs.Tab[]>(resolve => { timer = setTimeout(() => resolve([]), 300); }),
      ]);
      return tab?.windowId;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
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

  /** The view owns preflight; a dispatched run takes over in the worker. */
  beginPreparingGlow(): () => void {
    const generation = this.generation;
    const panelWindow = this.findPanelWindow();
    this.panelWindow = panelWindow;
    const start = this.request({ type: "preparingGlow", active: true }).catch(error => {
      if (generation === this.generation) console.warn("[PageGlow] 侧栏未能提交发送准备", error);
    });
    return () => {
      void start.then(() => {
        if (generation !== this.generation || this.panelWindow !== panelWindow) return;
        this.panelWindow = undefined;
        return this.request({ type: "preparingGlow", active: false }).catch(() => undefined);
      });
    };
  }

  /** Local learning/validation keeps its own engine but shares the worker's page selector. */
  beginLocalPageGlow(): LocalPageGlow | undefined {
    try {
      const port = chrome.runtime.connect({ name: LOCAL_PAGE_GLOW_PORT });
      let connected = true;
      let operation = 0;
      port.onDisconnect.addListener(() => {
        const reason = chrome.runtime.lastError?.message;
        connected = false;
        if (reason) console.warn('[PageGlow] 本地会话连接已断开', reason);
      });
      const send = (message: LocalPageGlowCommand) => {
        if (!connected) return;
        try {
          port.postMessage(message);
        } catch (error) {
          console.warn('[PageGlow] 无法报告本地会话目标', error);
        }
      };
      return {
        beginPageOperation: followForeground => {
          const id = ++operation;
          send({ type: "begin", operation: id, followForeground });
          return tabId => send({ type: "target", operation: id, tabId });
        },
        stop: () => {
          if (!connected) return;
          connected = false;
          try {
            port.disconnect();
          } catch (error) {
            console.warn('[PageGlow] 无法断开本地会话连接', error);
          }
        },
      };
    } catch (error) {
      console.warn('[PageGlow] 无法启动本地会话光晕', error);
      return undefined;
    }
  }

  detach(): void {
    this.generation++;
    this.questionIds.clear();
    const port = this.port;
    this.port = null;
    this.ready = null;
    this.panelWindow = undefined;
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

  /**
   * 强制中断某会话（同步语义）。
   *
   * 与 abort 的区别：这里**等待该会话的运行真正结算完毕**——包括运行级中止、
   * 正在执行的工具被强制中断、以及中断后对应 tool 结果写入模型上下文并落库。
   * 该 Promise resolve 后，才可以允许用户发送下一条消息；否则新消息会与上
   * 一轮的迟到工具结果交错，破坏上下文结构。
   */
  async abortAndWait(chatId: string): Promise<void> {
    await this.request({ type: "abortAndWait", chatId });
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

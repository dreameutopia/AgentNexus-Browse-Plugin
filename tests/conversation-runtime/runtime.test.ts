import assert from "node:assert/strict";

const tick = () => new Promise((resolve) => setImmediate(resolve));
class EventHook {
  listeners: ((...args: any[]) => void)[] = [];
  addListener(fn: (...args: any[]) => void) {
    this.listeners.push(fn);
  }
  removeListener(fn: (...args: any[]) => void) {
    const index = this.listeners.indexOf(fn);
    if (index >= 0) this.listeners.splice(index, 1);
  }
  fire(...args: any[]) {
    for (const fn of [...this.listeners]) fn(...args);
  }
}
const connections: any[] = [];
const onConnect = new EventHook();
const onMessage = new EventHook();
let workerAvailable = true;
let readyDelay: Promise<void> | null = null;
let readyChecks = 0;
(globalThis as any).chrome = {
  runtime: {
    id: "test-extension",
    onConnect,
    onMessage,
    async sendMessage(message: any) {
      readyChecks++;
      if (!workerAvailable) throw new Error('Could not establish connection. Receiving end does not exist.');
      if (readyDelay) await readyDelay;
      let response: any;
      onMessage.fire(message, {}, (value: any) => { response = value; });
      return response;
    },
    getPlatformInfo: async () => ({}),
    connect({ name }: { name: string }) {
      const view: any = {
        name,
        onMessage: new EventHook(),
        onDisconnect: new EventHook(),
      };
      const host: any = {
        name,
        sender: {},
        onMessage: new EventHook(),
        onDisconnect: new EventHook(),
      };
      let closed = false;
      view.postMessage = (data: any) => {
        if (closed) throw Error("disconnected");
        const copy = structuredClone(data);
        setImmediate(() => {
          if (!closed) host.onMessage.fire(copy);
        });
      };
      host.postMessage = (data: any) => {
        if (closed) throw Error("disconnected");
        const copy = structuredClone(data);
        setImmediate(() => {
          if (!closed) view.onMessage.fire(copy);
        });
      };
      view.disconnect = () => {
        closed = true;
        view.onDisconnect.fire();
        host.onDisconnect.fire();
      };
      connections.push(view);
      onConnect.fire(host);
      return view;
    },
  },
};

const runs = new Map<string, any>();
const glowPorts = new Map<number, string>();
const glowActivated = new EventHook();
const glowCommitted = new EventHook();
const glowFocused = new EventHook();
const glowRemoved = new EventHook();
const glowReplaced = new EventHook();
const glowUpdated = new EventHook();
let activeTab = 7;
let activeWindow = 1;
let workerFocusDiffersFromPanel = true;
let delayInjection: Promise<void> | undefined;
let delayQuery: Promise<void> | undefined;
let acknowledgeHide: Promise<void> | undefined;
let injectAttempts = 0;
(globalThis as any).chrome.tabs = {
  onUpdated: glowUpdated,
  onActivated: glowActivated,
  onRemoved: glowRemoved,
  onReplaced: glowReplaced,
  query: async (query: chrome.tabs.QueryInfo) => {
    if (query.windowId === 99) return [];
    if (query.lastFocusedWindow && workerFocusDiffersFromPanel) {
      return [{ id: 9, windowId: 2, active: true }];
    }
    const tab = { id: activeTab, windowId: activeWindow, active: true };
    await delayQuery;
    return [tab];
  },
  connect(tabId: number, options: chrome.tabs.ConnectInfo) {
    assert.equal(options.name, 'agentnexus:page-glow-v2');
    assert.equal(glowPorts.size, 0, 'Close the old document connection before opening another');
    const receiver = new EventHook();
    queueMicrotask(() => receiver.fire({ type: 'ready' }));
    return {
      onMessage: receiver,
      onDisconnect: new EventHook(),
      postMessage(message: { type: string }) {
        if (message.type === 'show') {
          assert.equal(glowPorts.size, 0, 'Only one document may show the glow');
          glowPorts.set(tabId, options.documentId!);
          queueMicrotask(() => receiver.fire({ type: 'shown' }));
        } else if (message.type === 'hide') {
          const hidden = () => {
            glowPorts.delete(tabId);
            receiver.fire({ type: 'hidden' });
          };
          if (acknowledgeHide) void acknowledgeHide.then(hidden);
          else queueMicrotask(hidden);
        }
      },
      disconnect() { glowPorts.delete(tabId); },
    };
  },
};
(globalThis as any).chrome.windows = {
  onFocusChanged: glowFocused,
  WINDOW_ID_NONE: -1,
};
(globalThis as any).chrome.scripting = {
  executeScript: async ({ target, files }: { target: chrome.scripting.InjectionTarget; files?: string[] }) => {
    assert.deepEqual(files, ['inject-scripts/page-glow.js']);
    if (target.tabId === 9 && target.documentIds?.[0] !== 'eligible-again') {
      throw new Error('Cannot access contents of a protected page');
    }
    if (target.tabId === 14 && ++injectAttempts === 1) throw new Error('Frame is not ready');
    await delayInjection;
    return [{ documentId: target.documentIds?.[0] ?? `doc-${target.tabId}`, frameId: 0 }];
  },
};
(globalThis as any).chrome.webNavigation = { onCommitted: glowCommitted };
const summary = {
  status: "completed",
  iterations: 1,
  durationMs: 100,
  compactions: 0,
};
const testEngine = {
  getRunningRecord: (chatId: string) =>
    structuredClone(runs.get(chatId)?.record ?? null),
  run: (runtime: any, options: any) =>
    new Promise((resolve, reject) => {
      const record = {
        id: `${runtime.chatId}-reply`,
        chatId: runtime.chatId,
        role: "assistant",
        content: "",
        parts: [{ type: "text", content: "" }],
        toolCalls: [],
        createdAt: 1,
      };
      runs.set(runtime.chatId, { record, options, resolve, reject });
      options.observer({
        type: "assistant-start",
        chatId: runtime.chatId,
        messageId: record.id,
      });
    }),
  abort: (chatId: string) => {
    const run = runs.get(chatId);
    if (!run) return false;
    run.options.observer({ type: "aborted", chatId, messageId: run.record.id });
    run.resolve({ ...summary, status: "aborted" });
    runs.delete(chatId);
    return true;
  },
};
(globalThis as any).testEngine = testEngine;
const { initConversationRuntime } =
  await import("../../entrypoints/background/conversation-runtime");
const { ConversationRuntimeClient } =
  await import("../../entrypoints/sidepanel/core/conversation/runtime-client");
initConversationRuntime();

const first = new ConversationRuntimeClient();
const endPreflight = first.beginPreparingGlow();
await tick();
await tick();
assert.deepEqual([...glowPorts], [[7, 'doc-7']], 'Light the page before assembling the runtime');
workerFocusDiffersFromPanel = false;
const events: any[] = [];
const initialRun = first
  .run({ chatId: "one" } as any, { observer: (event) => events.push(event) })
  .catch(() => undefined);
for (let n = 0; n < 5; n++) await tick();
assert.equal(runs.size, 1);
endPreflight();
for (let n = 0; n < 3; n++) await tick();
assert.deepEqual([...glowPorts], [[7, 'doc-7']]);
const commit = (tabId: number, documentId: string, frameId = 0) =>
  glowCommitted.fire({ tabId, frameId, documentId, documentLifecycle: 'active' });
const activate = (tabId: number) => {
  activeTab = tabId;
  glowActivated.fire({ tabId, windowId: 1 });
};
commit(7, 'iframe', 1);
assert.deepEqual([...glowPorts], [[7, 'doc-7']]);
commit(7, 'navigated');
assert.equal(glowPorts.size, 0);
await tick();
assert.deepEqual([...glowPorts], [[7, 'navigated']]);
activate(9);
await tick();
assert.equal(glowPorts.size, 0, 'A restricted target must leave the old tab dark');
activate(8);
await tick();
assert.deepEqual([...glowPorts], [[8, 'doc-8']]);
const beginOperation = runs.get('one').options.beginPageOperation;
const reportTarget = beginOperation(false);
reportTarget(7);
await tick();
assert.deepEqual([...glowPorts], [[7, 'doc-7']], 'A tool can target an inactive tab');
let finishHide = () => {};
acknowledgeHide = new Promise<void>(resolve => { finishHide = resolve; });
activate(10);
activate(9);
activate(10);
reportTarget(7);
await tick();
assert.deepEqual([...glowPorts], [[7, 'doc-7']], 'Wait for removal before promoting the latest tab');
finishHide();
acknowledgeHide = undefined;
await tick();
assert.deepEqual([...glowPorts], [[10, 'doc-10']]);
glowActivated.fire({ tabId: 12, windowId: 2 });
assert.deepEqual([...glowPorts], [[10, 'doc-10']], 'Background window activation must not steal focus');
let finishQuery = () => {};
delayQuery = new Promise<void>(resolve => { finishQuery = resolve; });
activeWindow = 2;
activeTab = 11;
glowFocused.fire(2);
activeTab = 12;
glowActivated.fire({ tabId: 12, windowId: 2 });
finishQuery();
delayQuery = undefined;
await tick();
assert.deepEqual([...glowPorts], [[12, 'doc-12']], 'A delayed window query must not roll back a newer activation');
activeWindow = 1;
activeTab = 9;
glowFocused.fire(1);
await tick();
assert.equal(glowPorts.size, 0);
commit(9, 'eligible-again');
await tick();
assert.deepEqual([...glowPorts], [[9, 'eligible-again']], 'Same-tab navigation can restore a protected target');
activeTab = 8;
glowRemoved.fire(9);
await tick();
assert.deepEqual([...glowPorts], [[8, 'doc-8']]);
activeTab = 13;
glowReplaced.fire(13, 8);
await tick();
assert.deepEqual([...glowPorts], [[13, 'doc-13']]);
glowFocused.fire(99);
await tick();
assert.deepEqual([...glowPorts], [[13, 'doc-13']], 'DevTools focus without a normal tab keeps the page target');
activate(14);
await tick();
assert.equal(glowPorts.size, 0, 'A temporary injection failure leaves the old document dark');
glowUpdated.fire(14, { status: 'complete' });
await tick();
assert.deepEqual([...glowPorts], [[14, 'doc-14']], 'A completed load recovers a transient injection failure');
activate(13);
await tick();
const token = (delta: string) => {
  const run = runs.get("one");
  run.record.content += delta;
  run.record.parts[0].content += delta;
  run.options.observer({
    type: "token",
    chatId: "one",
    messageId: run.record.id,
    delta,
  });
};
token("before");
await tick();
connections[0].disconnect();
await initialRun;
assert.equal(glowPorts.size, 1, 'Closing the panel must not detach the worker-owned glow');
token(" hidden");
assert.equal(
  runs.get("one").record.content,
  "before hidden",
  "Closing the view must leave the worker running",
);

const second = new ConversationRuntimeClient();
let displayed = "";
await second.attach(
  "one",
  {
    observer: (event) => {
      if (event.type === "token") displayed += event.delta;
    },
  },
  async (snapshot) => {
    assert.equal(snapshot.running, true);
    displayed = snapshot.record!.content;
    token(" during hydration");
    await tick();
    await tick();
  },
);
assert.equal(
  displayed,
  "before hidden during hydration",
  "Hydration must not lose or duplicate concurrent tokens",
);
assert.equal(
  second.isRunning("one"),
  true,
  "Reopened view must restore the stop button",
);
token(" live");
await tick();
assert.equal(displayed, "before hidden during hydration live");

// A pending approval remains in the worker while the view is closed and is
// presented by the next view; reconnecting never grants approval implicitly.
connections[1].disconnect();
const approval = runs.get("one").options.onToolApproval({
  id: "delete",
  name: "delete_note",
  argumentsPreview: "{}",
});
const third = new ConversationRuntimeClient();
let approvals = 0;
await third.attach(
  "one",
  {
    onToolApproval: async () => {
      approvals++;
      return false;
    },
  },
  async () => {},
);
assert.equal(await approval, false);
assert.equal(approvals, 1);
await third.abortAndWait("one");
assert.equal(glowPorts.size, 0);
assert.equal(
  runs.size,
  0,
  "The restored stop action must abort the original worker run",
);
assert.equal(third.isRunning("one"), false);
await third.attach("one", {}, async (snapshot) =>
  assert.equal(snapshot.running, false),
);
connections[2].disconnect();

const owner = new ConversationRuntimeClient();
let answerOldDialog: (value: boolean) => void = () => {};
const detachedRun = owner
  .run({ chatId: "two" } as any, {
    onToolApproval: () =>
      new Promise((resolve) => {
        answerOldDialog = resolve;
      }),
  })
  .catch(() => undefined);
for (let n = 0; n < 5; n++) await tick();
const unrelated = new ConversationRuntimeClient();
await unrelated.attach("unrelated-chat", {}, async () => {});
const waiting = runs
  .get("two")
  .options.onToolApproval({
    id: "approval-two",
    name: "delete_note",
    argumentsPreview: "{}",
  });
await tick();
owner.detach();
answerOldDialog(false);
await detachedRun;
await tick();
const reopened = new ConversationRuntimeClient();
let restoredApprovals = 0;
await reopened.attach(
  "two",
  {
    onToolApproval: async () => {
      restoredApprovals++;
      return true;
    },
  },
  async (snapshot) =>
    assert.equal(
      snapshot.questions.length,
      1,
      "Closing an open dialog must not answer or dismiss it",
    ),
);
assert.equal(
  await waiting,
  true,
  "An unrelated connected view must not reject another chat's approval",
);
assert.equal(restoredApprovals, 1);

// Completion during history loading must drain after hydration, restoring idle UI.
let completed = false;
reopened.onSettled = () => {
  completed = true;
};
await reopened.attach("two", {}, async (snapshot) => {
  assert.equal(snapshot.running, true);
  const run = runs.get("two");
  run.options.observer({
    type: "assistant-complete",
    chatId: "two",
    record: run.record,
  });
  run.resolve(summary);
  runs.delete("two");
  await tick();
  await tick();
});
assert.equal(completed, true);
assert.equal(reopened.isRunning("two"), false);
await reopened.attach("two", {}, async (snapshot) => {
  assert.equal(
    snapshot.running,
    false,
    "A task that finished while hidden must reopen as idle",
  );
  assert.equal(snapshot.record, null);
});
unrelated.detach();
reopened.detach();

// The pre-run model call must also survive the view closing, and expose its
// cancellation channel even before the conversation engine registers a run.
(globalThis as any).compactionRatio = 0.9;
let finishCompaction: (value: any) => void = () => {};
(globalThis as any).compactInput = ({ signal }: any) =>
  new Promise((resolve, reject) => {
    finishCompaction = resolve;
    signal.addEventListener("abort", () => reject(new Error("cancelled")), {
      once: true,
    });
  });
const compactingView = new ConversationRuntimeClient();
const compactRuntime = {
  chatId: "compact",
  initialContext: [{ role: "user", content: "history" }],
  activationContext: [],
  userInput: "new",
  userImages: [],
  toolIds: [],
  model: { contextThreshold: 100 },
  priorMaxSeq: 1,
} as any;
const compactTask = compactingView.run(compactRuntime).catch(() => undefined);
for (let n = 0; n < 5; n++) await tick();
compactingView.detach();
await compactTask;
const compactReopened = new ConversationRuntimeClient();
await compactReopened.attach("compact", {}, async (snapshot) => {
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.compacting, true);
});
finishCompaction({ summary: "summary", originalTokens: 90, summaryTokens: 10 });
for (let n = 0; n < 5; n++) await tick();
assert.equal(
  runs.has("compact"),
  true,
  "Hidden pre-run compaction must advance into the original conversation",
);
await compactReopened.abortAndWait("compact");

const cancelledCompaction = compactReopened
  .run({ ...compactRuntime, chatId: "cancel-compaction" })
  .catch(() => undefined);
for (let n = 0; n < 5; n++) await tick();
await compactReopened.abortAndWait("cancel-compaction");
await cancelledCompaction;
assert.equal(
  runs.has("cancel-compaction"),
  false,
  "Stop during pre-run compaction must prevent any conversation request",
);
let retryPreCompactions = 0;
(globalThis as any).compactInput = async () => { retryPreCompactions++; throw new Error('retry must compact inside the engine'); };
const retryTask = compactReopened.run({ ...compactRuntime, chatId: 'retry-compact', userInput: '',
  retryTarget: { messageId: 'failed-record', content: 'partial error' } }).catch(() => undefined);
for (let n = 0; n < 5; n++) await tick();
assert.equal(retryPreCompactions, 0, 'pre-run compaction must not advance past the record being resumed');
assert.equal(runs.has('retry-compact'), true);
await compactReopened.abortAndWait('retry-compact');
await retryTask;
compactReopened.detach();

// Fail before dispatch when an older loaded worker has no runtime receiver.
// The failed readiness check must not poison a retry after extension reload.
(globalThis as any).compactionRatio = 0;
workerAvailable = false;
const startup = new ConversationRuntimeClient();
const portsBeforeFailure = connections.length;
await assert.rejects(startup.run({ chatId: 'startup' } as any), /重新加载扩展/);
assert.equal(connections.length, portsBeforeFailure);
assert.equal(startup.isRunning('startup'), false);
workerAvailable = true;
let releaseReady: () => void = () => {};
readyDelay = new Promise(resolve => { releaseReady = resolve; });
const checksBeforeStart = readyChecks;
const startupTask = startup.run({ chatId: 'startup' } as any).catch(() => undefined);
for (let n = 0; n < 3; n++) await tick();
assert.equal(connections.length, portsBeforeFailure, 'Do not open the port until the worker confirms readiness');
assert.equal(readyChecks, checksBeforeStart + 1);
releaseReady();
for (let n = 0; n < 5; n++) await tick();
assert.equal(runs.has('startup'), true);
await startup.abortAndWait('startup');
await startupTask;
startup.detach();
readyDelay = null;
// A panel reopening shares browser-session storage. A browser restart creates
// an empty session store, regardless of the previous persistent selection.
let browserSession: Record<string, unknown> = {};
(globalThis as any).chrome.storage = {
  session: {
    get: async (key: string) => ({ [key]: browserSession[key] }),
    set: async (value: Record<string, unknown>) => { Object.assign(browserSession, value); },
  },
};
const { readActiveChat, rememberActiveChat } = await import('../../entrypoints/sidepanel/core/conversation/active-session');
assert.equal(await readActiveChat(), '');
await rememberActiveChat('same-browser-chat');
assert.equal(await readActiveChat(), 'same-browser-chat', 'Reopening the panel restores its chat');
browserSession = {};
assert.equal(await readActiveChat(), '', 'Restarting the browser opens the welcome page');
await rememberActiveChat('another-chat');
await rememberActiveChat('');
assert.equal(await readActiveChat(), '', 'Creating a new chat keeps the welcome selection on panel reopen');
// Completion, rejection, and a delayed injection resolving after Stop.
const glowView = new ConversationRuntimeClient();
for (const chatId of ['glow-success', 'glow-failure', 'glow-abort']) {
  let release = () => {};
  if (chatId === 'glow-abort') delayInjection = new Promise<void>(resolve => { release = resolve; });
  const task = glowView.run({ chatId } as any);
  const settled = chatId === 'glow-failure' ? assert.rejects(task, /simulated failure/) : task;
  for (let n = 0; n < 5; n++) await tick();
  const run = runs.get(chatId);
  if (chatId === 'glow-abort') {
    await glowView.abortAndWait(chatId);
    run.options.beginPageOperation(false)(7);
    release();
    delayInjection = undefined;
  } else {
    assert.equal(glowPorts.size, 1);
    if (chatId === 'glow-failure') run.reject(new Error('simulated failure'));
    else run.resolve(summary);
    runs.delete(chatId);
  }
  await settled;
  await tick();
  assert.equal(glowPorts.size, 0);
  assert.equal(glowActivated.listeners.length, 0);
  assert.equal(glowCommitted.listeners.length, 0);
}
glowView.detach();
const abandoned = new ConversationRuntimeClient();
const releaseAbandoned = abandoned.beginPreparingGlow();
await tick();
await tick();
assert.equal(glowPorts.size, 1);
abandoned.detach();
releaseAbandoned();
await tick();
assert.equal(glowPorts.size, 0, 'Abandoning local preparation clears its glow');
const local = abandoned.beginLocalPageGlow()!;
await tick();
assert.deepEqual([...glowPorts], [[13, 'doc-13']]);
const setLocalTarget = local.beginPageOperation(false);
setLocalTarget(7);
await tick();
await tick();
assert.deepEqual([...glowPorts], [[7, 'doc-7']]);
activate(8);
setLocalTarget(7);
await tick();
assert.deepEqual([...glowPorts], [[8, 'doc-8']]);
local.stop();
await tick();
assert.equal(glowPorts.size, 0, 'Local learning or validation must release the same renderer');
console.log(
  "[conversation-runtime] Close/reopen, hidden streaming, hydration races, approval restoration, stop and page-glow lifecycle passed.",
);

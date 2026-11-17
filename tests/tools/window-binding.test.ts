import assert from 'node:assert/strict';
import { browserChrome, executeWithBrowserScope, enableScopedPageFocus, parseBrowserScope } from '../../tools/browser/browser-scope';
import { browserTabsTool } from '../../tools/browser/tab-management';
import { DomExploreTool } from '../../tools/browser/dom-explore-tool';
import { PageCleanTool } from '../../tools/browser/page-clean-tool';
import { NetworkObserverTool } from '../../tools/browser/network-observer';
import { resolveTabTarget } from '../../tools/browser/tab-target';
import { executeScriptBounded } from '../../tools/common/frame-read';
import { queryActivePageInfo } from '../../entrypoints/sidepanel/utils/system-context';
import { ScreenshotTool } from '../../tools/vision/screenshot-tool';
import { textTab } from '../../tools/browser/text-runtime';
import { cdpSession } from '../../tools/browser/cdp-session';
import { readBrowserBinding, writeBrowserBinding, initBrowserBindingWriter, BROWSER_BINDING_WRITE_MESSAGE, withBrowserBindingLock, clearClosedBrowserBindings } from '../../utils/browser-window-binding';
import { watchOperationWindow } from '../../utils/browser-window-lifecycle';
import type { ToolExecutionContext } from '../../tools/registry';
import { browserOperation } from '../../tools/browser/scope-errors';

const previous = (globalThis as any).chrome;
const hook = { addListener() { }, removeListener() { } };
const windowRemovedListeners = new Set<(windowId: number) => void>();
const windowRemoved = { addListener(listener: (windowId: number) => void) { windowRemovedListeners.add(listener); }, removeListener(listener: (windowId: number) => void) { windowRemovedListeners.delete(listener); } };
const tabs = new Map<number, chrome.tabs.Tab>();
const windows = new Set([101, 202]);
let focusedWindow = 202;
let nextId = 99000;
const mutations: Array<{ action: string; id?: number; data?: any }> = [];
const queries: chrome.tabs.QueryInfo[] = [];
const session: Record<string, unknown> = {};
const networkRules = new Map<number, chrome.declarativeNetRequest.Rule>();
const a = 91011, a2 = 91012, b = 92021;
const scope: ToolExecutionContext = { browserScope: { mode: 'bound-window', windowId: 101 } };
const otherScope: ToolExecutionContext = { browserScope: { mode: 'bound-window', windowId: 202 } };
const seed = () => {
  tabs.clear();
  for (const [id, windowId, active] of [[a, 101, true], [a2, 101, false], [b, 202, true]] as const)
    tabs.set(id, { id, windowId, active, title: `page-${id}`, url: 'https://same.example/path/', status: 'complete', index: 0, pinned: false, highlighted: active, incognito: false } as chrome.tabs.Tab);
};
const get = async (id: number) => {
  const tab = tabs.get(id);
  if (!tab) throw new Error('No such tab');
  return { ...tab };
};
const png = Buffer.alloc(33);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20);
const native: any = {
  runtime: { id: 'test', getManifest: () => ({}), getURL: (p: string) => `chrome-extension://test/${p}` },
  storage: {
    session: {
      async get(key: string | null) { return key === null ? { ...session } : { [key]: session[key] }; },
      async set(value: Record<string, unknown>) { Object.assign(session, value); },
      async remove(key: string) { delete session[key]; },
    }
  },
  tabs: {
    async query(input: chrome.tabs.QueryInfo) {
      queries.push({ ...input });
      return [...tabs.values()].filter(tab =>
        (input.windowId === undefined || tab.windowId === input.windowId) &&
        (!(input.currentWindow || input.lastFocusedWindow) || tab.windowId === focusedWindow) &&
        (input.active === undefined || tab.active === input.active) &&
        (!input.url || tab.url === 'https://same.example/path/')).map(tab => ({ ...tab }));
    },
    get,
    async update(id: number, data: any) {
      const tab = await get(id);
      mutations.push({ action: 'update', id, data });
      if (data.active) for (const member of tabs.values()) if (member.windowId === tab.windowId) member.active = false;
      tabs.set(id, { ...tab, ...data });
      return get(id);
    },
    async create(data: any) {
      mutations.push({ action: 'create', data });
      const id = ++nextId;
      tabs.set(id, { id, windowId: data.windowId ?? focusedWindow, active: data.active !== false, url: data.url ?? 'about:blank' } as chrome.tabs.Tab);
      return get(id);
    },
    async remove(ids: number | number[]) {
      for (const id of Array.isArray(ids) ? ids : [ids]) { mutations.push({ action: 'remove', id }); tabs.delete(id); }
    },
    async captureVisibleTab(windowId: number) {
      mutations.push({ action: 'capture', id: windowId });
      return `data:image/png;base64,${png.toString('base64')}`;
    },
    onUpdated: hook,
  },
  windows: {
    onRemoved: windowRemoved,
    WINDOW_ID_CURRENT: -2,
    async get(id: number, options?: any) {
      if (!windows.has(id)) throw new Error('No such window');
      return { id, type: 'normal', focused: id === focusedWindow, state: 'normal', ...(options?.populate ? { tabs: [...tabs.values()].filter(tab => tab.windowId === id) } : {}) };
    },
    async getAll() { return Promise.all([...windows].map(id => native.windows.get(id, { populate: true }))); },
    async getLastFocused() { return native.windows.get(focusedWindow); },
    async update(id: number, data: any) { mutations.push({ action: 'focus', id, data }); if (data.focused) focusedWindow = id; return native.windows.get(id); },
  },
  scripting: {
    async executeScript(request: any) {
      mutations.push({ action: 'inject', id: request.target.tabId });
      return [{ frameId: 0, result: { documentId: 'doc', width: 800, height: 600, devicePixelRatio: 1, pageX: 0, pageY: 0, scale: 1, offsetX: 0, offsetY: 0, contentWidth: 800, contentHeight: 600, zoom: 1 } }];
    },
  },
  debugger: {
    onDetach: hook,
    onEvent: hook,
    async attach(target: any) { mutations.push({ action: 'attach', id: target.tabId }); },
    async detach() { },
    async sendCommand(target: any, method: string, params: any) { mutations.push({ action: method, id: target.tabId, data: params }); return {}; },
  },
  declarativeNetRequest: {
    async getSessionRules() { return [...networkRules.values()]; },
    async updateSessionRules(input: { addRules?: chrome.declarativeNetRequest.Rule[]; removeRuleIds?: number[] }) {
      for (const id of input.removeRuleIds ?? []) networkRules.delete(id);
      for (const rule of input.addRules ?? []) networkRules.set(rule.id, rule);
    },
  },
};

seed();
(globalThis as any).chrome = native;
try {
  assert.equal(browserChrome(), native, 'Beta off must return the native API object');
  assert.equal(browserChrome({ chatId: 'legacy' }), native);
  assert.throws(() => parseBrowserScope({ mode: 'bound-window', windowId: -1 }), /INVALID_BROWSER_SCOPE/);
  for (const invalid of [null, [], { mode: 'bound-window', windowId: 101, extra: true }, Object.create({ mode: 'bound-window', windowId: 101 }),
    { get mode() { throw new Error('hostile getter'); }, windowId: 101 }])
    assert.throws(() => parseBrowserScope(invalid), /INVALID_BROWSER_SCOPE/);
  assert.ok(Object.isFrozen(parseBrowserScope(scope.browserScope)));
  const diagnostic = browserChrome(scope);
  await new Promise<void>(resolve => diagnostic.tabs.get(b, tab => {
    assert.equal(tab, undefined);
    assert.match(diagnostic.runtime.lastError?.message ?? '', /TAB_OUTSIDE_BOUND_WINDOW/);
    resolve();
  }));
  assert.equal(diagnostic.runtime.lastError, undefined, 'Callback errors must not leak into later successful calls');
  const originalWindowGet = native.windows.get;
  native.windows.get = async () => { throw { message: 'permission revoked' }; };
  await assert.rejects(() => diagnostic.tabs.query({}), /BROWSER_SCOPE_API_FAILED.*permission revoked/, 'API errors must retain their cause instead of claiming the window closed');
  native.windows.get = originalWindowGet;
  const aborted = new AbortController();
  aborted.abort('test');
  let dispatched = false;
  await assert.rejects(() => browserOperation('test', { ...scope, signal: aborted.signal }, () => { dispatched = true; }), /BROWSER_SCOPE_ABORTED/);
  assert.equal(dispatched, false);
  await assert.rejects(() => browserOperation('testMutation', scope, () => new Promise(() => {}), { timeoutMs: 5, mutating: true }),
    error => (error as any).code === 'BROWSER_SCOPE_TIMEOUT' && (error as any).outcomeUncertain === true);
  let stale: ToolExecutionContext | undefined;
  await executeWithBrowserScope(scope, async context => { stale = context; });
  await assert.rejects(() => browserChrome(stale).tabs.get(a), /BROWSER_SCOPE_CONTEXT_CLOSED/);
  const beforeForeignFocus = mutations.length;
  await assert.rejects(() => executeWithBrowserScope(scope, async context => enableScopedPageFocus(b, context)), /TAB_OUTSIDE_BOUND_WINDOW/);
  assert.equal(mutations.length, beforeForeignFocus, 'A rejected focus target must never receive cleanup commands');
  native.tabs.move = async (ids: number, data: any) => { assert.equal(data.windowId, 101); return get(ids); };
  await diagnostic.tabs.move(a, { windowId: -2, index: 0 });
  delete native.tabs.move;
  assert.equal((await browserChrome().tabs.query({ active: true, currentWindow: true }))[0].id, b);

  const listed = await browserTabsTool.execute({ action: 'list', currentWindow: false }, scope);
  assert.equal(listed.success, true);
  assert.deepEqual((listed.data as any).tabs.map((tab: any) => tab.tabId), [a, a2]);
  const concurrent = await Promise.all([browserChrome(scope).tabs.query({ active: true, currentWindow: true }), browserChrome(otherScope).tabs.query({ active: true })]);
  assert.deepEqual(concurrent.map(rows => rows[0].windowId), [101, 202], 'Scopes must not share mutable target state');
  assert.deepEqual(queries.at(-2), { active: true, windowId: 101 });

  const resolved = await resolveTabTarget({ tabId: a2, tool: 'test', context: scope });
  assert.equal(resolved.ok, true);
  assert.equal(focusedWindow, 202);
  assert.equal(mutations.some(call => call.action === 'focus'), false, 'Tab activation must not focus its window');
  const foreign = await resolveTabTarget({ tabId: b, tool: 'test', context: scope });
  assert.equal(foreign.ok, false);
  assert.match(JSON.stringify(foreign), /TAB_OUTSIDE_BOUND_WINDOW/);

  const count = mutations.length;
  const mixed = await browserTabsTool.execute({ action: 'close', tabIds: [a, b] }, scope);
  assert.equal(mixed.success, false);
  assert.equal(tabs.has(a) && tabs.has(b), true, 'Mixed-window close must fail before any removal');
  assert.equal(mutations.length, count);
  await assert.rejects(() => browserChrome(scope).tabs.remove([a, b]), /TAB_OUTSIDE_BOUND_WINDOW/);
  await assert.rejects(() => executeScriptBounded({ target: { tabId: b }, func: () => 1 }, 1000, undefined, scope), /TAB_OUTSIDE_BOUND_WINDOW/);
  assert.equal(mutations.length, count, 'Out-of-window injection must not dispatch');
  const foreignExplore = await new DomExploreTool().execute({ action: 'children', selector: 'body', tabId: b }, scope);
  assert.equal(foreignExplore.success, false);
  assert.match(JSON.stringify(foreignExplore), /TAB_OUTSIDE_BOUND_WINDOW/);
  assert.equal(mutations.length, count, 'DOM exploration must reject before activating or focusing a foreign tab');

  const legacyRule = { id: 91001, priority: 1, action: { type: 'block' }, condition: { requestDomains: ['doubleclick.net'] } } as chrome.declarativeNetRequest.Rule;
  networkRules.set(legacyRule.id, legacyRule);
  const cleaned = await new PageCleanTool().execute({ mode: 'network', tabId: a2 }, scope);
  assert.equal(cleaned.success, true, JSON.stringify(cleaned));
  const scopedRules = [...networkRules.values()].filter(rule => rule.id !== 91001);
  assert.ok(scopedRules.length > 0);
  assert.ok(scopedRules.every(rule => JSON.stringify(rule.condition.tabIds) === JSON.stringify([a2])), 'Bound network cleanup must not create global rules');
  await new PageCleanTool().execute({ mode: 'network', restore: true, tabId: a2 }, scope);
  assert.deepEqual([...networkRules.keys()], [91001], 'Bound restore must preserve existing legacy global rules');

  const capture = new NetworkObserverTool();
  const started = await executeWithBrowserScope(scope, context => capture.execute({ action: 'start', durationSec: 10 }, context));
  assert.equal(started.success, true, JSON.stringify(started));
  const captureId = (started.data as any).captureId;
  const foreignCapture = await capture.execute({ action: 'read', captureId }, otherScope);
  assert.equal(foreignCapture.success, false);
  assert.match(JSON.stringify(foreignCapture), /TAB_OUTSIDE_BOUND_WINDOW/);
  assert.equal((await capture.execute({ action: 'stop', captureId }, scope)).success, true);

  const created = await browserTabsTool.execute({ action: 'create', url: 'https://new.example' }, scope);
  assert.equal((created.data as any).windowId, 101);
  assert.equal(focusedWindow, 202);
  const tree = await browserTabsTool.execute({ action: 'windows' }, scope);
  assert.equal((tree.data as any).windowCount, 1);
  assert.equal((tree.data as any).windows[0].windowId, 101);
  const page = await queryActivePageInfo(scope);
  assert.equal(page?.title, `page-${a2}`);
  assert.equal((await queryActivePageInfo())?.title, `page-${b}`, 'Legacy context must still follow focused window');

  const attachmentsBeforeScreenshot = mutations.filter(call => call.action === 'attach').length;
  const screenshot = await executeWithBrowserScope(scope, context => new ScreenshotTool().execute({ mode: 'observe' }, context));
  assert.equal(screenshot.success, true, JSON.stringify(screenshot));
  assert.equal((screenshot.data as any).tabId, a2);
  assert.equal(mutations.filter(call => call.action === 'capture').at(-1)?.id, 101);
  assert.equal(mutations.filter(call => call.action === 'attach').length, attachmentsBeforeScreenshot, 'Observation-only screenshot must not attach debugger');

  await executeWithBrowserScope(scope, async context => {
    const target = await textTab(context);
    assert.equal(target.id, a2);
    assert.equal(mutations.filter(call => call.action === 'Emulation.setFocusEmulationEnabled').at(-1)?.data.enabled, true);
    await enableScopedPageFocus(target.id, context);
  });
  assert.equal(mutations.filter(call => call.action === 'Emulation.setFocusEmulationEnabled').at(-1)?.data.enabled, false, 'Focus emulation must be released before returning');
  assert.equal(focusedWindow, 202);

  let releaseFirst!: () => void, releaseSecond!: () => void;
  let enteredFirst!: () => void, enteredSecond!: () => void;
  const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve; });
  const secondEntered = new Promise<void>(resolve => { enteredSecond = resolve; });
  const first = executeWithBrowserScope(scope, async context => {
    await enableScopedPageFocus(a2, context); enteredFirst();
    await new Promise<void>(resolve => { releaseFirst = resolve; });
  });
  await firstEntered;
  const second = executeWithBrowserScope(scope, async context => {
    await enableScopedPageFocus(a2, context); enteredSecond();
    await new Promise<void>(resolve => { releaseSecond = resolve; });
  });
  await secondEntered;
  releaseFirst(); await first;
  assert.equal(mutations.filter(call => call.action === 'Emulation.setFocusEmulationEnabled').at(-1)?.data.enabled, true, 'One completed execution must not clear another execution’s focus lease');
  releaseSecond(); await second;
  assert.equal(mutations.filter(call => call.action === 'Emulation.setFocusEmulationEnabled').at(-1)?.data.enabled, false);

  tabs.get(a2)!.windowId = 202;
  await assert.rejects(() => browserChrome(scope).tabs.get(a2), /TAB_OUTSIDE_BOUND_WINDOW/, 'Dragged-out tabs must immediately lose scope');
  tabs.get(a2)!.windowId = 101;
  windows.delete(101);
  const beforeClose = mutations.length;
  await assert.rejects(() => browserChrome(scope).tabs.query({ active: true }), /BOUND_WINDOW_CLOSED/);
  const closed = await browserTabsTool.execute({ action: 'create', url: 'https://blocked.example' }, scope);
  assert.equal(closed.success, false);
  assert.equal(mutations.length, beforeClose, 'Closed binding must never create or operate in another window');
  assert.equal(await queryActivePageInfo(scope), null);
  assert.equal(await executeWithBrowserScope(scope, async () => 'non-page-tool'), 'non-page-tool', 'Closing the window must not disable non-page tools');
  assert.equal((await browserChrome().tabs.query({ active: true, currentWindow: true }))[0].id, b);
  windows.add(101);

  const legacySwitch = await browserTabsTool.execute({ action: 'switch', tabId: a });
  assert.equal(legacySwitch.success, true);
  assert.equal(focusedWindow, 101, 'Beta off must retain existing window focus behavior');
  assert.equal((await browserTabsTool.execute({ action: 'list' })).success, true);
  await writeBrowserBinding('session-a', scope.browserScope);
  assert.deepEqual(await readBrowserBinding('session-a'), scope.browserScope);
  assert.equal(await readBrowserBinding('session-b'), undefined);
  await writeBrowserBinding('session-a');
  assert.equal(await readBrowserBinding('session-a'), undefined);
  let writer: any;
  let connectWriter: any;
  let busy = false;
  native.runtime.onMessage = { addListener(listener: any) { writer = listener; } };
  native.runtime.onConnect = { addListener(listener: any) { connectWriter = listener; } };
  initBrowserBindingWriter(() => !busy);
  const writeRequest = (browserScope: unknown, sender = { id: 'test', url: 'chrome-extension://test/sidepanel.html' }) =>
    new Promise<any>(resolve => writer({ type: BROWSER_BINDING_WRITE_MESSAGE, chatId: 'broker', browserScope }, sender, resolve));
  assert.equal((await writeRequest(scope.browserScope)).ok, true);
  busy = true;
  assert.match((await writeRequest(undefined)).error, /BROWSER_BINDING_BUSY/);
  assert.deepEqual(await readBrowserBinding('broker'), scope.browserScope, 'Cross-panel running guard must preserve the previous binding');
  busy = false;
  assert.equal((await writeRequest(null)).ok, false);
  assert.equal((await writeRequest(undefined, { id: 'test', url: 'https://page.example/' })).ok, false);
  let unlock!: () => void;
  let locked!: () => void;
  const entered = new Promise<void>(resolve => { locked = resolve; });
  const runningRegistration = withBrowserBindingLock('broker', async () => {
    locked(); await new Promise<void>(resolve => { unlock = resolve; }); busy = true;
  });
  await entered;
  const queuedWrite = writeRequest(undefined);
  unlock(); await runningRegistration;
  assert.match((await queuedWrite).error, /BROWSER_BINDING_BUSY/, 'A queued save must recheck the run lock after registration');
  const portRequest = (browserScope: unknown, sender = { id: 'test', url: 'chrome-extension://test/sidepanel.html' }) =>
    new Promise<any>(resolve => {
      let listener: any;
      connectWriter({
        name: `${BROWSER_BINDING_WRITE_MESSAGE}:v1`, sender,
        onMessage: { addListener(callback: any) { listener = callback; } },
        onDisconnect: hook, postMessage: resolve,
      });
      listener({ id: '12345678-1234-1234-1234-123456789012', chatId: 'port-broker', browserScope });
    });
  assert.match((await portRequest(scope.browserScope)).error, /BROWSER_BINDING_BUSY/);
  busy = false;
  const confirmed = await portRequest(scope.browserScope);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.id, '12345678-1234-1234-1234-123456789012');
  assert.deepEqual(await readBrowserBinding('port-broker'), scope.browserScope);
  assert.equal((await portRequest(undefined, { id: 'test', url: 'https://page.example/' })).ok, false);
  session['beta.browserWindowBinding.closed-chat'] = scope.browserScope;
  session['beta.browserWindowBinding.draft:101'] = scope.browserScope;
  session['beta.browserWindowBinding.other-chat'] = otherScope.browserScope;
  busy = true;
  await clearClosedBrowserBindings(101);
  assert.equal(await readBrowserBinding('closed-chat'), undefined, 'A closed target is reset even while the chat is busy');
  assert.equal(await readBrowserBinding('draft:101'), undefined, 'Draft bindings reset across panels too');
  assert.deepEqual(await readBrowserBinding('other-chat'), otherScope.browserScope, 'Closing one window preserves bindings to other windows');
  session['beta.browserWindowBinding.rebound'] = scope.browserScope;
  let releaseRebind!: () => void;
  const held = withBrowserBindingLock('rebound', async () => {
    await new Promise<void>(resolve => { releaseRebind = resolve; });
    session['beta.browserWindowBinding.rebound'] = otherScope.browserScope;
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const resetRacingRebind = clearClosedBrowserBindings(101);
  releaseRebind(); await held; await resetRacingRebind;
  assert.deepEqual(await readBrowserBinding('rebound'), otherScope.browserScope, 'A late closure event must not overwrite a newer binding');
  session['beta.browserWindowBinding.missed-close'] = { mode: 'bound-window', windowId: 303 };
  await clearClosedBrowserBindings();
  assert.equal(await readBrowserBinding('missed-close'), undefined, 'Startup reconciliation repairs missed closure events');
  const listenerCount = windowRemovedListeners.size;
  const existingListeners = new Set(windowRemovedListeners);
  const closureErrors: unknown[] = [];
  const watch = watchOperationWindow(scope.browserScope, error => closureErrors.push(error));
  await watch.ready;
  const taskListeners = [...windowRemovedListeners].filter(listener => !existingListeners.has(listener));
  for (const listener of taskListeners) listener(202);
  assert.equal(closureErrors.length, 0);
  for (const listener of taskListeners) listener(101);
  for (const listener of taskListeners) listener(101);
  assert.equal(closureErrors.length, 1, 'Repeated close signals notify a task once');
  watch.dispose(); watch.dispose();
  assert.equal(windowRemovedListeners.size, listenerCount, 'Task closure listeners are always released');
  console.log('[window-binding] Scoped tools, legacy behavior, screenshots, context, focus cleanup, moves, closed windows and session isolation passed.');
} finally {
  await cdpSession.detachAll();
  (globalThis as any).chrome = previous;
}

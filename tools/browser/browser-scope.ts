import type { ToolExecutionContext } from '../registry';
import { BrowserScopeError, browserErrorText, browserOperation } from './scope-errors';
export { BrowserScopeError, browserErrorText } from './scope-errors';

/** Serializable target descriptor. Absence always means legacy behavior. */
export interface BrowserScope {
  readonly mode: 'bound-window';
  readonly windowId: number;
}

export function parseBrowserScope(value: unknown): BrowserScope | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BrowserScopeError('INVALID_BROWSER_SCOPE', 'parseScope', '窗口绑定必须是有效的窗口描述对象。');
  try {
    const fields = Object.getOwnPropertyDescriptors(value);
    const mode = fields.mode?.value;
    const windowId = fields.windowId?.value;
    if (Reflect.ownKeys(value).some(key => key !== 'mode' && key !== 'windowId') || mode !== 'bound-window' ||
        !Number.isSafeInteger(windowId) || windowId < 0)
      throw new Error('Expected own data fields mode and windowId');
    return Object.freeze({ mode: 'bound-window', windowId });
  } catch (cause) {
    throw new BrowserScopeError('INVALID_BROWSER_SCOPE', 'parseScope', '窗口绑定无效，请重新选择操作窗口。', { cause });
  }
}

type FocusLease = { tabs: Set<number>; closing: boolean };
const focusLeases = new WeakMap<BrowserScope, FocusLease>();
const closedExecutions = new WeakSet<BrowserScope>();
const authorizedCleanup = new WeakMap<BrowserScope, Set<number>>();
const focusOwners = new Map<number, Set<BrowserScope>>();
const focusTransitions = new Map<number, Promise<void>>();

function transitionFocus(tabId: number, work: () => Promise<void>): Promise<void> {
  const next = (focusTransitions.get(tabId) ?? Promise.resolve()).catch(() => undefined).then(work);
  focusTransitions.set(tabId, next);
  const clear = () => { if (focusTransitions.get(tabId) === next) focusTransitions.delete(tabId); };
  void next.then(clear, clear);
  return next;
}

function assertLive(context: ToolExecutionContext, operation: string): void {
  if (closedExecutions.has(context.browserScope!))
    throw new BrowserScopeError('BROWSER_SCOPE_CONTEXT_CLOSED', operation, '该次页面操作已结束，迟到操作未执行。', { windowId: context.browserScope!.windowId });
  if (context.signal?.aborted)
    throw new BrowserScopeError('BROWSER_SCOPE_ABORTED', operation, '操作已取消，未继续执行。', { cause: context.signal.reason, windowId: context.browserScope!.windowId });
}

function validateId(id: unknown, name: string): asserts id is number {
  if (!Number.isSafeInteger(id) || (id as number) < 0)
    throw new BrowserScopeError('INVALID_BROWSER_ARGUMENT', name, `${name} 必须是非负安全整数。`);
}

/** One immutable target per invocation, never a global current-window variable. */
export class BrowserWindowTarget {
  readonly scope: BrowserScope;
  readonly context: ToolExecutionContext;

  constructor(context: ToolExecutionContext) {
    const parsed = parseBrowserScope(context.browserScope);
    if (!parsed) throw new BrowserScopeError('INVALID_BROWSER_SCOPE', 'createTarget', '缺少指定窗口对象。');
    this.scope = Object.isFrozen(context.browserScope) ? context.browserScope! : parsed;
    this.context = { browserScope: this.scope, signal: context.signal };
  }

  checkWindow(id?: number): void {
    if (id !== undefined && id !== chrome.windows.WINDOW_ID_CURRENT && id !== this.scope.windowId)
      throw new BrowserScopeError('WINDOW_OUTSIDE_BOUND_SCOPE', 'resolveWindow', '不能访问绑定窗口以外的窗口。', { windowId: this.scope.windowId });
  }

  async window(populate = false): Promise<chrome.windows.Window> {
    assertLive(this.context, 'windows.get');
    let window: chrome.windows.Window;
    try {
      window = await browserOperation('windows.get', this.context, () => chrome.windows.get(this.scope.windowId, { populate }));
    } catch (error) {
      if (/no (such )?window|no window with id|invalid window id|window.*(?:closed|not found)/i.test(browserErrorText(error instanceof Error ? error.cause ?? error : error)))
        throw new BrowserScopeError('BOUND_WINDOW_CLOSED', 'windows.get', '绑定窗口已关闭，请重新选择；不会回退到其他窗口。', { cause: error, windowId: this.scope.windowId });
      throw error;
    }
    assertLive(this.context, 'windows.get');
    if (!window || window.id !== this.scope.windowId)
      throw new BrowserScopeError('BOUND_WINDOW_CLOSED', 'windows.get', '未返回绑定窗口的有效信息；不会回退到其他窗口。', { windowId: this.scope.windowId });
    if (window.type !== undefined && window.type !== 'normal')
      throw new BrowserScopeError('INVALID_BROWSER_SCOPE', 'windows.get', '只能绑定普通浏览器窗口。', { windowId: this.scope.windowId });
    if (window.tabs) for (const tab of window.tabs) this.validateTab(tab);
    return window;
  }

  validateTab(tab: chrome.tabs.Tab, requestedId?: number): chrome.tabs.Tab {
    if (!tab || !Number.isSafeInteger(tab.id) || tab.id! < 0 || (requestedId !== undefined && tab.id !== requestedId))
      throw new BrowserScopeError('BROWSER_SCOPE_API_FAILED', 'tabs.get', '浏览器未返回有效的目标标签页。', { tabId: requestedId, windowId: this.scope.windowId });
    if (tab.windowId !== this.scope.windowId)
      throw new BrowserScopeError('TAB_OUTSIDE_BOUND_WINDOW', 'resolveTab', `标签页 ${tab.id} 不属于绑定窗口，未执行。`, { tabId: tab.id, windowId: this.scope.windowId });
    const authorized = authorizedCleanup.get(this.scope) ?? new Set<number>();
    authorized.add(tab.id!);
    authorizedCleanup.set(this.scope, authorized);
    return tab;
  }

  async tab(tabId: number): Promise<chrome.tabs.Tab> {
    validateId(tabId, 'tabId');
    await this.window();
    const tab = await browserOperation('tabs.get', this.context, () => chrome.tabs.get(tabId), { tabId });
    assertLive(this.context, 'tabs.get');
    return this.validateTab(tab, tabId);
  }

  async query(input: chrome.tabs.QueryInfo = {}): Promise<chrome.tabs.Tab[]> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BrowserScopeError('INVALID_BROWSER_ARGUMENT', 'tabs.query', '查询参数必须是对象。');
    this.checkWindow(input.windowId);
    await this.window();
    const { currentWindow: _current, lastFocusedWindow: _last, ...rest } = input;
    const tabs = await browserOperation('tabs.query', this.context, () => chrome.tabs.query({ ...rest, windowId: this.scope.windowId }));
    assertLive(this.context, 'tabs.query');
    if (!Array.isArray(tabs)) throw new BrowserScopeError('BROWSER_SCOPE_API_FAILED', 'tabs.query', '浏览器标签页列表格式无效。');
    return tabs.map(tab => this.validateTab(tab));
  }

  async activeTab(): Promise<chrome.tabs.Tab> {
    const [tab] = await this.query({ active: true });
    if (!tab) throw new BrowserScopeError('BROWSER_SCOPE_API_FAILED', 'resolveActiveTab', '绑定窗口没有可用的活动标签页。', { windowId: this.scope.windowId });
    return tab;
  }

  call<T>(operation: string, work: () => T | PromiseLike<T>, options: { tabId?: number; mutating?: boolean; timeoutMs?: number; cleanup?: boolean } = {}): Promise<T> {
    if (!options.cleanup) assertLive(this.context, operation);
    return browserOperation(operation, this.context, () => {
      if (!options.cleanup) assertLive(this.context, operation);
      return work();
    }, options);
  }
}

export async function assertScopeWindow(context?: ToolExecutionContext): Promise<chrome.windows.Window | undefined> {
  return context?.browserScope !== undefined ? new BrowserWindowTarget(context).window() : undefined;
}

export async function assertScopeTab(tabId: number, context?: ToolExecutionContext): Promise<chrome.tabs.Tab> {
  return context?.browserScope !== undefined ? new BrowserWindowTarget(context).tab(tabId) : chrome.tabs.get(tabId);
}

export async function enableScopedPageFocus(tabId: number, context?: ToolExecutionContext): Promise<void> {
  if (context?.browserScope === undefined) return;
  parseBrowserScope(context.browserScope);
  const scope = context.browserScope;
  const lease = focusLeases.get(scope);
  if (!lease || lease.closing)
    throw new BrowserScopeError('BROWSER_SCOPE_CONTEXT_CLOSED', 'enableFocus', '页面输入必须经工具执行入口管理，不能使用已结束的执行上下文。');
  await transitionFocus(tabId, async () => {
    await assertScopeTab(tabId, context);
    if (lease.closing) throw new BrowserScopeError('BROWSER_SCOPE_CONTEXT_CLOSED', 'enableFocus', '操作已结束，未启用焦点模拟。');
    lease.tabs.add(tabId);
    const owners = focusOwners.get(tabId) ?? new Set<BrowserScope>();
    owners.add(scope);
    focusOwners.set(tabId, owners);
    await browserOperation('Emulation.setFocusEmulationEnabled', context,
      () => chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }), { tabId, mutating: true });
  });
}

/** Finally releases focus, bounds failed cleanup, and rejects late queued operations. */
export async function executeWithBrowserScope<T>(context: ToolExecutionContext | undefined,
  work: (context: ToolExecutionContext | undefined) => Promise<T>): Promise<T> {
  if (context?.browserScope === undefined) return work(context);
  const scope = parseBrowserScope(context.browserScope)!;
  const scopedContext = { ...context, browserScope: scope };
  assertLive(scopedContext, 'toolExecution');
  const lease: FocusLease = { tabs: new Set(), closing: false };
  focusLeases.set(scope, lease);
  let result!: T;
  let failed = false;
  let failure: unknown;
  try { result = await work(scopedContext); }
  catch (error) { failed = true; failure = error; }
  lease.closing = true;
  closedExecutions.add(scope);
  const cleanup = await Promise.allSettled([...lease.tabs].map(tabId => transitionFocus(tabId, async () => {
    const owners = focusOwners.get(tabId);
    owners?.delete(scope);
    if (owners?.size) return;
    focusOwners.delete(tabId);
    try {
      await browserOperation('releaseFocus', scopedContext,
        () => chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: false }),
        { cleanup: true, tabId, timeoutMs: 2000, mutating: true });
    } catch (error) {
      try {
        await browserOperation('detachAfterFocusFailure', scopedContext, () => chrome.debugger.detach({ tabId }),
          { cleanup: true, tabId, timeoutMs: 2000, mutating: true });
      } catch (detachError) {
        if (!/no (such )?tab|no tab with id|not attached|target.*closed/i.test(browserErrorText(detachError)))
          throw new BrowserScopeError('BROWSER_SCOPE_CLEANUP_FAILED', 'releaseFocus',
            `焦点模拟清理未确认：${browserErrorText(error)}；脱离调试器也失败：${browserErrorText(detachError)}。请先核对页面状态，勿重复操作。`,
            { cause: detachError, tabId, windowId: scope.windowId, outcomeUncertain: true });
      }
    }
  })));
  focusLeases.delete(scope);
  const errors = cleanup.flatMap(item => item.status === 'rejected' ? [browserErrorText(item.reason)] : []);
  if (errors.length) throw new BrowserScopeError('BROWSER_SCOPE_CLEANUP_FAILED', 'toolExecution',
    `${failed ? `原始失败：${browserErrorText(failure)}；` : '操作可能已生效；'}${errors.join('；')}`,
    { cause: failure, windowId: scope.windowId, outcomeUncertain: true });
  if (failed) throw failure;
  return result;
}

const facades = new WeakMap<ToolExecutionContext, typeof chrome>();

/** All callers share this optional target abstraction. No global monkey patch. */
export function browserChrome(context?: ToolExecutionContext): typeof chrome {
  if (context?.browserScope === undefined) return chrome;
  const cached = facades.get(context);
  if (cached) return cached;
  const target = new BrowserWindowTarget(context);
  const scope = target.scope;
  let callbackError: { message: string } | undefined;
  const invokeCallback = (callback: (...args: any[]) => void, value: unknown, error?: unknown) => {
    const previous = callbackError;
    callbackError = error === undefined ? undefined : { message: browserErrorText(error) };
    try { callback(value); }
    catch (cause) { console.error('[BrowserScope] 浏览器回调抛出异常', browserErrorText(cause)); }
    finally { callbackError = previous; }
  };
  const method = (work: (...args: any[]) => Promise<any>) => (...input: any[]) => {
    const args = [...input];
    const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined;
    const result = Promise.resolve().then(() => work(...args));
    if (!callback) return result;
    void result.then(value => invokeCallback(callback, value), error => invokeCallback(callback, undefined, error));
    return undefined;
  };
  const unsupported = (api: string) => method(async () => {
    throw new BrowserScopeError('BROWSER_SCOPE_API_FAILED', api, '该浏览器 API 尚无窗口范围适配，未执行；请补充适配后再调用。', { windowId: scope.windowId });
  });
  const tabs = new Proxy(chrome.tabs, { get(native, property) {
    if (property === 'query') return method(input => target.query(input));
    if (property === 'get') return method(id => target.tab(id));
    if (property === 'getCurrent') return method(() => target.activeTab());
    if (property === 'create') return method(async (input: chrome.tabs.CreateProperties) => {
      if (!input || typeof input !== 'object') throw new BrowserScopeError('INVALID_BROWSER_ARGUMENT', 'tabs.create', '创建参数必须是对象。');
      target.checkWindow(input.windowId);
      await target.window();
      if (input.openerTabId !== undefined) await target.tab(input.openerTabId);
      const tab = await target.call('tabs.create', () => chrome.tabs.create({ ...input, windowId: scope.windowId }), { mutating: true, timeoutMs: 10000 });
      return target.validateTab(tab);
    });
    if (property === 'captureVisibleTab') return method(async (idOrOptions?: number | chrome.tabs.CaptureVisibleTabOptions, options?: chrome.tabs.CaptureVisibleTabOptions) => {
      target.checkWindow(typeof idOrOptions === 'object' ? undefined : idOrOptions);
      await target.window();
      return target.call('tabs.captureVisibleTab', () => chrome.tabs.captureVisibleTab(scope.windowId,
        (typeof idOrOptions === 'object' ? idOrOptions : options) ?? {}));
    });
    if (property === 'connect') return (tabId: number, info?: chrome.tabs.ConnectInfo) => deferredTabPort(target, tabId, info, invokeCallback);
    const tabMethods = ['update', 'remove', 'reload', 'goBack', 'goForward', 'sendMessage', 'setZoom', 'getZoom',
      'setZoomSettings', 'getZoomSettings', 'duplicate', 'discard', 'detectLanguage', 'highlight', 'move'];
    if (typeof property === 'string' && tabMethods.includes(property)) return method(async (...args: any[]) => {
      if (property === 'highlight') {
        target.checkWindow(args[0]?.windowId);
        await target.window();
        args[0] = { ...args[0], windowId: scope.windowId };
      } else {
        if (args[0] === undefined || (property === 'update' && typeof args[0] === 'object' && !Array.isArray(args[0])) ||
            (property === 'setZoom' && args.length === 1)) {
          const active = await target.activeTab();
          if (args[0] === undefined) args[0] = active.id; else args.unshift(active.id);
        }
        const ids: unknown[] = Array.isArray(args[0]) ? args[0] : [args[0]];
        if (!ids.length) throw new BrowserScopeError('INVALID_BROWSER_ARGUMENT', `tabs.${property}`, '标签页 ID 列表不能为空。');
        for (const id of ids) { validateId(id, 'tabId'); await target.tab(id); }
        if (property === 'move') {
          target.checkWindow(args[1]?.windowId);
          args[1] = { ...args[1], windowId: scope.windowId };
        }
        if (property === 'update' && args[1]?.openerTabId !== undefined) await target.tab(args[1].openerTabId);
      }
      return target.call(`tabs.${property}`, () => (native as any)[property](...args),
        { mutating: !['getZoom', 'getZoomSettings', 'detectLanguage'].includes(property), timeoutMs: property === 'sendMessage' ? 30000 : 10000 });
    });
    const value = Reflect.get(native, property);
    return typeof value === 'function' ? unsupported(`tabs.${String(property)}`) : value;
  } });
  const windows = new Proxy(chrome.windows, { get(native, property) {
    if (property === 'getAll') return method(async (options?: chrome.windows.QueryOptions) => {
      if (options?.windowTypes && !options.windowTypes.includes('normal')) return [];
      return [await target.window(options?.populate)];
    });
    if (['get', 'getCurrent', 'getLastFocused'].includes(String(property))) return method(async (...args: any[]) => {
      if (property === 'get') target.checkWindow(args.shift());
      return target.window(args[0]?.populate);
    });
    if (property === 'update') return method(async (id: number, input: chrome.windows.UpdateInfo) => {
      target.checkWindow(id);
      const window = await target.window();
      if (!input || typeof input !== 'object') throw new BrowserScopeError('INVALID_BROWSER_ARGUMENT', 'windows.update', '窗口更新参数必须是对象。');
      if (input.state !== undefined && input.state !== window.state)
        throw new BrowserScopeError('BOUND_WINDOW_OPERATION_DENIED', 'windows.update', '改变窗口显示状态可能抢占焦点，请由用户手动完成。');
      const { focused: _focus, drawAttention: _attention, state: _state, ...rest } = input;
      return Object.keys(rest).length ? target.call('windows.update', () => chrome.windows.update(scope.windowId, rest), { mutating: true }) : window;
    });
    if (property === 'create' || property === 'remove') return method(async () => {
      throw new BrowserScopeError('BOUND_WINDOW_OPERATION_DENIED', `windows.${String(property)}`, '绑定模式不允许工具创建或关闭浏览器窗口。');
    });
    const value = Reflect.get(native, property);
    return typeof value === 'function' ? unsupported(`windows.${String(property)}`) : value;
  } });
  const scripting = chrome.scripting && new Proxy(chrome.scripting, { get(native, property) {
    const value = Reflect.get(native, property);
    if (['executeScript', 'insertCSS', 'removeCSS'].includes(String(property))) return method(async (input: any) => {
      await target.tab(input?.target?.tabId);
      return target.call(`scripting.${String(property)}`, () => value.call(native, input), { mutating: true, timeoutMs: 300000, tabId: input.target.tabId });
    });
    return typeof value === 'function' ? unsupported(`scripting.${String(property)}`) : value;
  } });
  const debuggerApi = chrome.debugger && new Proxy(chrome.debugger, { get(native, property) {
    const value = Reflect.get(native, property);
    if (['attach', 'detach', 'sendCommand'].includes(String(property))) return method(async (debuggee: chrome.debugger.Debuggee, ...args: any[]) => {
      validateId(debuggee?.tabId, 'debuggee.tabId');
      if (debuggee.targetId !== undefined || debuggee.extensionId !== undefined)
        throw new BrowserScopeError('BOUND_DEBUG_TARGET_DENIED', `debugger.${String(property)}`, '绑定模式只允许使用标签页调试目标。');
      const tabId = debuggee.tabId!;
      const command = args[0];
      const release = property === 'detach' || (property === 'sendCommand' &&
        ((command === 'Input.dispatchKeyEvent' && args[1]?.type === 'keyUp') ||
         (command === 'Input.dispatchMouseEvent' && args[1]?.type === 'mouseReleased')));
      const authorizedRelease = release && authorizedCleanup.get(scope)?.has(tabId) === true;
      if (!authorizedRelease) await target.tab(tabId);
      if (property === 'sendCommand' && (command === 'Page.bringToFront' || /^(Target|Browser)\./.test(String(command))))
        throw new BrowserScopeError('BOUND_DEBUG_COMMAND_DENIED', String(command), '该命令会越过窗口或焦点限制，未执行。');
      if (property === 'sendCommand' && command === 'Emulation.setFocusEmulationEnabled' && args[1]?.enabled === true)
        return enableScopedPageFocus(tabId, context);
      return target.call(`debugger.${String(property)}${property === 'sendCommand' ? `:${command}` : ''}`,
        () => value.call(native, debuggee, ...args), { tabId, cleanup: authorizedRelease,
          mutating: property !== 'sendCommand' || !/^(DOM\.get|Page\.get|Accessibility\.get|Network\.get)/.test(String(command)),
          timeoutMs: authorizedRelease ? 2000 : command === 'Runtime.evaluate'
            ? Math.min(310000, Math.max(8000, Number(args[1]?.timeout) + 1000 || 16000))
            : command === 'Page.printToPDF' ? 120000 : 8000 });
    });
    if (property === 'getTargets') return method(async () => {
      const allowed = new Set((await target.query()).map(tab => tab.id));
      const targets = await target.call('debugger.getTargets', () => chrome.debugger.getTargets());
      return targets.filter(item => item.tabId !== undefined && allowed.has(item.tabId));
    });
    return typeof value === 'function' ? unsupported(`debugger.${String(property)}`) : value;
  } });
  const runtime = chrome.runtime && new Proxy(chrome.runtime, { get(native, property) {
    if (property === 'lastError') return callbackError ?? native.lastError;
    const value = Reflect.get(native, property);
    return typeof value === 'function' ? value.bind(native) : value;
  } });
  const facade = new Proxy(chrome, { get(native, property) {
    if (property === 'tabs') return tabs;
    if (property === 'windows') return windows;
    if (property === 'scripting') return scripting;
    if (property === 'debugger') return debuggerApi;
    if (property === 'runtime') return runtime;
    return Reflect.get(native, property);
  } });
  facades.set(context, facade);
  return facade;
}

/** Preserve the synchronous Port API while asynchronous target validation is pending. */
function deferredTabPort(target: BrowserWindowTarget, tabId: number, info: chrome.tabs.ConnectInfo | undefined,
  invoke: (callback: (...args: any[]) => void, value: unknown, error?: unknown) => void): chrome.runtime.Port {
  let native: chrome.runtime.Port | undefined;
  let disconnected = false;
  const queued: unknown[] = [];
  const messages = new Set<(...args: any[]) => void>();
  const disconnects = new Set<(...args: any[]) => void>();
  const removeListeners = () => {
    chrome.tabs.onDetached?.removeListener(detached);
    chrome.tabs.onRemoved?.removeListener(removed);
    target.context.signal?.removeEventListener('abort', aborted);
  };
  const close = (error?: unknown, notify = true) => {
    if (disconnected) return;
    disconnected = true;
    queued.length = 0;
    removeListeners();
    try { native?.disconnect(); }
    catch (cause) { console.warn('[BrowserScope] 端口清理失败', browserErrorText(cause)); }
    if (notify) for (const listener of [...disconnects]) invoke(listener, port, error);
    messages.clear(); disconnects.clear();
  };
  const detached = (id: number) => { if (id === tabId) close(new BrowserScopeError('TAB_OUTSIDE_BOUND_WINDOW', 'tabs.connect', '标签页已移出绑定窗口，页面连接已关闭。', { tabId, windowId: target.scope.windowId })); };
  const removed = (id: number) => { if (id === tabId) close(new Error('目标标签页已关闭，页面连接已释放。')); };
  const aborted = () => close(new BrowserScopeError('BROWSER_SCOPE_ABORTED', 'tabs.connect', '页面连接已取消。', { tabId, windowId: target.scope.windowId }));
  const event = (listeners: Set<(...args: any[]) => void>) => ({
    addListener: (listener: (...args: any[]) => void) => { listeners.add(listener); },
    removeListener: (listener: (...args: any[]) => void) => { listeners.delete(listener); },
    hasListener: (listener: (...args: any[]) => void) => listeners.has(listener),
    hasListeners: () => listeners.size > 0,
  });
  const port = {
    name: info?.name ?? '',
    get sender() { return native?.sender; },
    onMessage: event(messages), onDisconnect: event(disconnects),
    postMessage(message: unknown) {
      if (disconnected) throw new Error('Attempting to use a disconnected port object');
      if (native) native.postMessage(message);
      else {
        if (queued.length >= 100) throw new BrowserScopeError('BROWSER_SCOPE_API_FAILED', 'tabs.connect', '等待窗口校验的端口消息已达上限。');
        queued.push(structuredClone(message));
      }
    },
    disconnect() { close(undefined, false); },
  } as chrome.runtime.Port;
  chrome.tabs.onDetached?.addListener(detached);
  chrome.tabs.onRemoved?.addListener(removed);
  target.context.signal?.addEventListener('abort', aborted, { once: true });
  void target.tab(tabId).then(() => {
    if (disconnected) return;
    assertLive(target.context, 'tabs.connect');
    native = chrome.tabs.connect(tabId, info);
    native.onMessage.addListener(message => { for (const listener of [...messages]) invoke(() => listener(message, port), undefined); });
    native.onDisconnect.addListener(() => {
      const error = chrome.runtime?.lastError;
      close(error?.message);
    });
    for (const message of queued.splice(0)) native.postMessage(message);
  }).catch(error => {
    if (disconnected) return;
    close(error);
  });
  return port;
}

import { parseBrowserScope, type BrowserScope } from '@/tools/browser/browser-scope';
import { BrowserScopeError, browserErrorText, browserOperation } from '@/tools/browser/scope-errors';
import { isClosedBrowserWindowError } from './browser-window-lifecycle';

export const BROWSER_BINDING_WRITE_MESSAGE = 'agentnexus:browser-window-binding-write';
/** UI mirror only; the worker's run maps remain the authority for write guards. */
export const BROWSER_WINDOW_BUSY_CHATS = 'beta.browserWindowBusyChats';
const BROWSER_BINDING_PREFIX = 'beta.browserWindowBinding.';
const BROWSER_BINDING_WRITE_PORT = `${BROWSER_BINDING_WRITE_MESSAGE}:v1`;
export const browserBindingKey = (chatId: string) => {
  if (typeof chatId !== 'string' || !chatId.trim() || chatId.length > 512 || /[\u0000-\u001f]/.test(chatId))
    throw new BrowserScopeError('INVALID_BROWSER_ARGUMENT', 'browserBindingKey', '会话标识无效，未读取或修改窗口绑定。');
  return `${BROWSER_BINDING_PREFIX}${chatId}`;
};
const mutations = new Map<string, Promise<unknown>>();
let writable: ((chatId: string) => boolean | Promise<boolean>) | undefined;

function assertBindingSender(sender?: chrome.runtime.MessageSender): void {
  if (sender?.id !== chrome.runtime.id || typeof sender.url !== 'string' || !sender.url.startsWith(chrome.runtime.getURL('')))
    throw new BrowserScopeError('INVALID_BROWSER_ARGUMENT', 'writeBinding', '窗口绑定只能由扩展页面修改。');
}

/** A dedicated port has one worker recipient, unlike first-response-wins broadcasts. */
async function requestBindingWrite(chatId: string, browserScope?: BrowserScope): Promise<void> {
  let port: chrome.runtime.Port | undefined;
  let dispatched = false;
  const id = crypto.randomUUID();
  try {
    await browserOperation('requestBindingWrite', undefined, () => new Promise<void>((resolve, reject) => {
      port = chrome.runtime.connect({ name: BROWSER_BINDING_WRITE_PORT });
      port.onMessage.addListener(reply => {
        if (reply?.id !== id || typeof reply.ok !== 'boolean') {
          reject(new Error('后台返回了不匹配的窗口绑定确认，请重新加载扩展并重新打开侧边栏。'));
          return;
        }
        if (reply.ok) resolve();
        else reject(new Error(typeof reply.error === 'string' ? reply.error : '后台拒绝保存窗口绑定，但未提供原因。'));
      });
      port.onDisconnect.addListener(() => {
        const reason = chrome.runtime.lastError?.message;
        reject(new Error(`窗口绑定后台连接已断开${reason ? `：${reason}` : ''}。请在扩展管理页重新加载扩展并重新打开侧边栏后重试。${dispatched ? '保存结果未确认，请先检查绑定状态。' : ''}`));
      });
      port.postMessage({ id, chatId, browserScope });
      dispatched = true;
    }), { mutating: true, timeoutMs: 15000 });
  } finally {
    try { port?.disconnect(); }
    catch (error) { console.warn('[BrowserBinding] 释放保存连接失败', browserErrorText(error)); }
  }
}

/** Shared by dispatch and binding writes in the worker, including across panels. */
export function withBrowserBindingLock<T>(chatId: string, work: () => Promise<T>): Promise<T> {
  browserBindingKey(chatId);
  const previous = mutations.get(chatId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  mutations.set(chatId, next);
  const release = () => { if (mutations.get(chatId) === next) mutations.delete(chatId); };
  void next.then(release, release);
  return next;
}

/** Session-only: Chrome window IDs must never survive a browser restart. */
export async function readBrowserBinding(chatId: string): Promise<BrowserScope | undefined> {
  if (!chatId || typeof chrome === 'undefined' || !chrome.storage?.session) return undefined;
  const key = browserBindingKey(chatId);
  const data = await browserOperation('storage.session.getBinding', undefined, () => chrome.storage.session.get(key));
  if (!data || typeof data !== 'object')
    throw new BrowserScopeError('BROWSER_SCOPE_API_FAILED', 'storage.session.getBinding', '浏览器未返回有效的绑定存储结果。');
  return parseBrowserScope(data[key]);
}

/**
 * 「操作窗口」内的标签页 —— 侧边栏一切「对页面动手」的入口共用的目标解析口径
 * （元素捕获、捕获元素校验都走这里，避免两处各自 query 出不同窗口）：
 *
 *   - 已绑定操作窗口 → 只查该窗口，绝不回退到其它窗口；
 *   - 未绑定（跟随模式）→ 跟随侧边栏所在窗口。
 *
 * 查询失败（绑定窗口刚被关闭 / 浏览器拒绝）返回 null：调用方必须按失败处理，
 * 不得把 null 当成「没有标签页」后回退到当前窗口 —— 那会把操作落到错误的页面上。
 */
export async function queryOperationTabs(scope?: BrowserScope): Promise<chrome.tabs.Tab[] | null> {
  try {
    return await chrome.tabs.query(scope ? { windowId: scope.windowId } : { currentWindow: true });
  } catch {
    return null;
  }
}

export async function writeBrowserBinding(chatId: string, scope?: BrowserScope): Promise<void> {
  const key = browserBindingKey(chatId);
  const binding = parseBrowserScope(scope);
  if (typeof document !== 'undefined') {
    // No local fallback: an unavailable worker must not bypass another panel's run lock.
    await requestBindingWrite(chatId, binding);
    return;
  }
  await withBrowserBindingLock(chatId, async () => {
    if (writable && !await writable(chatId))
      throw new BrowserScopeError('BROWSER_BINDING_BUSY', 'writeBinding', '此会话正在运行或停止中，请先结束任务再修改窗口绑定。');
    if (!chrome.storage?.session) throw new BrowserScopeError('BROWSER_SCOPE_API_FAILED', 'writeBinding', '当前浏览器不支持会话存储，无法安全保存窗口绑定。');
    if (binding) {
      const { assertScopeWindow } = await import('@/tools/browser/browser-scope');
      await assertScopeWindow({ browserScope: binding });
    }
    if (writable && !await writable(chatId))
      throw new BrowserScopeError('BROWSER_BINDING_BUSY', 'writeBinding', '保存前发现会话已经开始运行，绑定未修改。');
    await browserOperation('storage.session.writeBinding', undefined, () => binding
      ? chrome.storage.session.set({ [key]: binding }) : chrome.storage.session.remove(key), { mutating: true });
    if (binding) {
      // Close can race the write and its onRemoved scan. Check again after the
      // write, while still holding the chat lock, so a dead target cannot linger.
      const { assertScopeWindow } = await import('@/tools/browser/browser-scope');
      try { await assertScopeWindow({ browserScope: binding }); }
      catch (error) {
        if (isClosedBrowserWindowError(error))
          await browserOperation('resetClosedWindowAfterWrite', undefined, () => chrome.storage.session.remove(key), { mutating: true });
        throw error;
      }
    }
  });
}

/** System invalidation bypasses the user-write busy guard, but never overwrites a newer selection. */
export async function clearClosedBrowserBindings(windowId?: number): Promise<void> {
  const stored = await browserOperation('listWindowBindings', undefined, () => chrome.storage.session.get(null));
  if (!stored || typeof stored !== 'object') throw new Error('会话存储未返回有效的窗口绑定列表。');
  let openIds: Set<number> | undefined;
  if (windowId === undefined) {
    const windows = await browserOperation('reconcileWindowBindings', undefined, () => chrome.windows.getAll({ windowTypes: ['normal'] }));
    if (!Array.isArray(windows)) throw new Error('浏览器未返回有效的窗口列表，未更改窗口绑定。');
    openIds = new Set(windows.map(window => window.id).filter((id): id is number => typeof id === 'number'));
  }
  const results = await Promise.allSettled(Object.keys(stored).filter(key => key.startsWith(BROWSER_BINDING_PREFIX)).map(key =>
    withBrowserBindingLock(key.slice(BROWSER_BINDING_PREFIX.length), async () => {
      const data = await browserOperation('readBindingBeforeReset', undefined, () => chrome.storage.session.get(key));
      const binding = parseBrowserScope(data[key]);
      if (!binding || (windowId === undefined ? openIds!.has(binding.windowId) : binding.windowId !== windowId)) return;
      await browserOperation('resetClosedWindowBinding', undefined, () => chrome.storage.session.remove(key), { mutating: true });
    })));
  const failures = results.flatMap(result => result.status === 'rejected' ? [browserErrorText(result.reason)] : []);
  if (failures.length) throw new Error(`部分已关闭窗口的绑定同步失败：${failures.join('；')}`);
}

/** Only the worker registers this request handler. */
export function initBrowserBindingWriter(isWritable: (chatId: string) => boolean | Promise<boolean>): void {
  if (writable) return;
  writable = isWritable;
  const reconcile = (windowId?: number) => {
    void clearClosedBrowserBindings(windowId).catch(error => console.error('[BrowserBinding] 自动恢复跟随模式失败', browserErrorText(error)));
  };
  chrome.windows.onRemoved.addListener(reconcile);
  if (chrome.storage?.session) reconcile();
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== BROWSER_BINDING_WRITE_PORT) return;
    let closed = false;
    let received = false;
    port.onDisconnect.addListener(() => { closed = true; });
    port.onMessage.addListener(message => {
      if (received) return;
      received = true;
      const reply = (value: { ok: boolean; error?: string }) => {
        if (closed) return;
        try { port.postMessage({ id: message?.id, ...value }); }
        catch (error) { console.warn('[BrowserBinding] 无法发送保存确认', browserErrorText(error)); }
      };
      void (async () => {
        try {
          assertBindingSender(port.sender);
          if (typeof message?.id !== 'string' || message.id.length !== 36)
            throw new BrowserScopeError('INVALID_BROWSER_ARGUMENT', 'writeBinding', '窗口绑定请求标识无效。');
          await writeBrowserBinding(message.chatId, message.browserScope);
          reply({ ok: true });
        } catch (error) { reply({ ok: false, error: browserErrorText(error) }); }
      })();
    });
  });
  // Keep accepting the previous UI protocol while an already open panel updates.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== BROWSER_BINDING_WRITE_MESSAGE) return;
    void (async () => {
      try {
        assertBindingSender(sender);
        await writeBrowserBinding(message.chatId, message.browserScope);
        sendResponse({ ok: true });
      } catch (error) { sendResponse({ ok: false, error: browserErrorText(error) }); }
    })();
    return true;
  });
}

const PORT_NAME = 'agentnexus:page-glow-v2';
const SCRIPT = 'inject-scripts/page-glow.js';
const MAX_ATTEMPTS = 3;
const ACK_TIMEOUT_MS = 1200;
const BROWSER_TIMEOUT_MS = 2500;

type Owner = string | symbol;
type Run = { tabId?: number; operation?: symbol };
type Target = {
  tabId: number;
  documentId?: string;
  attempts: number;
  retry?: ReturnType<typeof setTimeout>;
  loadRecoveryUsed?: boolean;
};
type Link = {
  target: Target;
  port: chrome.runtime.Port;
  phase: 'connecting' | 'showing' | 'visible' | 'retiring';
  timer?: ReturnType<typeof setTimeout>;
};

function report(phase: string, error: unknown, tabId?: number): void {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[URL]')
    .slice(0, 300);
  console.warn('[PageGlow]', { phase, tabId, message });
}

function isRestricted(message: string): boolean {
  return /cannot access (contents of|a |the |this |(?:chrome|edge|about):)|missing host permission|not allowed on|extensions gallery|cannot be scripted|permission denied/i.test(message);
}

async function bounded<T>(operation: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description}超时`)), BROWSER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Selects one target. A renderer must retire its DOM before the next can draw. */
class PageGlow {
  private readonly runs = new Map<Owner, Run>();
  private owner?: Owner;
  private target?: Target;
  private link?: Link;
  private foregroundTab?: number;
  private foregroundWindow?: number;
  private pendingFocusWindow?: number;
  private selection = 0;
  private foregroundEpoch = 0;

  start(owner: Owner, panelWindowId?: number): void {
    if (!this.runs.size) this.listen(true);
    this.claim(owner, {});
    const windowId = typeof panelWindowId === 'number' && Number.isInteger(panelWindowId) && panelWindowId >= 0
      ? panelWindowId : undefined;
    console.info('[PageGlow] start', { source: typeof owner === 'string' ? 'conversation' : owner.description, windowId });
    if (windowId !== undefined && windowId !== this.foregroundWindow) {
      this.pendingFocusWindow = undefined;
      this.foregroundWindow = windowId;
      this.useForeground();
      this.queryForeground(windowId);
      return;
    }
    this.select(this.foregroundTab);
    if (this.foregroundTab === undefined) this.queryForeground(this.foregroundWindow);
  }

  stop(owner: Owner): void {
    if (!this.runs.delete(owner) || this.owner !== owner) return;
    this.owner = Array.from(this.runs.keys()).pop();
    if (this.owner !== undefined) {
      const tabId = this.runs.get(this.owner)?.tabId ?? this.foregroundTab;
      this.select(tabId);
      if (tabId === undefined) this.queryForeground(this.foregroundWindow);
      return;
    }
    this.selection++;
    this.foregroundTab = undefined;
    this.foregroundWindow = undefined;
    this.pendingFocusWindow = undefined;
    this.select(undefined);
    // Keep topology listeners until a retiring document has acknowledged removal.
    if (!this.link) this.listen(false);
  }

  beginOperation(owner: Owner, followForeground: boolean): (tabId: number) => void {
    const run = this.runs.get(owner);
    if (!run) return () => {};
    const operation = Symbol();
    const epoch = this.foregroundEpoch;
    run.operation = operation;
    if (followForeground) {
      run.tabId = undefined;
      this.claim(owner, run);
      this.select(this.foregroundTab);
    }
    return tabId => {
      if (!Number.isInteger(tabId) || tabId < 0 || this.runs.get(owner) !== run ||
          run.operation !== operation || this.foregroundEpoch !== epoch) return;
      run.tabId = tabId === this.foregroundTab ? undefined : tabId;
      this.claim(owner, run);
      this.select(tabId);
    };
  }

  private claim(owner: Owner, run: Run): void {
    this.runs.delete(owner);
    this.runs.set(owner, run);
    this.owner = owner;
  }

  private useForeground(tabId?: number): void {
    this.foregroundEpoch++;
    this.foregroundTab = tabId;
    for (const run of this.runs.values()) run.tabId = undefined;
    this.select(tabId);
  }

  private queryForeground(windowId?: number, fromFocus = false): void {
    const selection = ++this.selection;
    void (async () => {
      const query: chrome.tabs.QueryInfo = windowId === undefined
        ? { active: true, lastFocusedWindow: true, windowType: 'normal' }
        : { active: true, windowId, windowType: 'normal' };
      for (let attempt = 0; attempt < 2; attempt++) {
        if (selection !== this.selection || !this.runs.size) return;
        try {
          let [tab] = await bounded(chrome.tabs.query(query), '查询活动标签页');
          if (!tab && windowId === undefined && selection === this.selection) {
            const tabs = await bounded(chrome.tabs.query({ active: true, windowType: 'normal' }), '查找普通浏览器窗口');
            if (tabs.length === 1) [tab] = tabs;
          }
          if (selection !== this.selection || !this.runs.size) return;
          if (fromFocus) {
            this.pendingFocusWindow = undefined;
            // Undocked DevTools and popups can receive browser focus without
            // replacing the normal window the sidebar is operating on.
            if (tab?.id === undefined) return;
            this.foregroundWindow = tab.windowId;
            this.useForeground(tab.id);
            return;
          }
          if (tab?.id === undefined) console.info('[PageGlow] no-target', { windowId });
          this.foregroundWindow = tab?.windowId ?? windowId;
          this.foregroundTab = tab?.id;
          const pinned = this.owner === undefined ? undefined : this.runs.get(this.owner)?.tabId;
          this.select(pinned ?? tab?.id);
          return;
        } catch (error) {
          if (attempt === 1 && selection === this.selection) {
            if (fromFocus) this.pendingFocusWindow = undefined;
            report('select-foreground', error);
          }
        }
      }
    })();
  }

  private select(tabId?: number, documentId?: string, replace = false): void {
    if (!replace && this.target?.tabId === tabId) return;
    clearTimeout(this.target?.retry);
    this.target = tabId !== undefined && tabId >= 0 ? { tabId, documentId, attempts: 0 } : undefined;
    if (this.target) console.info('[PageGlow] target', { tabId, windowId: this.foregroundWindow });
    this.reconcile();
  }

  private reconcile(): void {
    if (this.link) {
      if (this.link.target !== this.target) this.retire(this.link);
      return;
    }
    const target = this.target;
    if (target && target.attempts === 0) void this.connect(target);
    if (!this.runs.size) this.listen(false);
  }

  private async connect(target: Target): Promise<void> {
    target.attempts++;
    const { tabId, documentId } = target;
    try {
      const [injection] = await bounded(chrome.scripting.executeScript({
        target: documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] },
        files: [SCRIPT],
        injectImmediately: true,
      }), '注入光晕脚本');
      if (this.target !== target) return;
      if (!injection) throw new Error('主文档没有返回脚本注入结果');
      target.documentId = injection.documentId ?? documentId;
      const port = chrome.tabs.connect(tabId, {
        name: PORT_NAME,
        ...(target.documentId ? { documentId: target.documentId } : { frameId: 0 }),
      });
      const link: Link = { target, port, phase: 'connecting' };
      this.link = link;
      port.onMessage.addListener(message => this.receive(link, message));
      port.onDisconnect.addListener(() => {
        const reason = chrome.runtime.lastError?.message;
        this.release(link, reason ?? '文档连接已断开');
      });
      this.awaitAck(link);
    } catch (error) {
      if (this.target === target) this.retry(target, 'inject', error);
    }
  }

  private receive(link: Link, message: { type?: string; error?: unknown } | null): void {
    if (this.link !== link) return;
    if (message?.type === 'hidden' && link.phase === 'retiring') {
      this.release(link);
    } else if (message?.type === 'ready' && link.phase === 'connecting') {
      if (link.target !== this.target) return this.retire(link);
      link.phase = 'showing';
      try {
        link.port.postMessage({ type: 'show' });
        this.awaitAck(link);
      } catch (error) {
        this.release(link, error);
      }
    } else if (message?.type === 'shown' && link.phase === 'showing') {
      clearTimeout(link.timer);
      link.phase = 'visible';
      console.info('[PageGlow] shown', { tabId: link.target.tabId });
    } else if (message?.type === 'failed') {
      // The renderer sends failed only after removing its host.
      this.release(link, typeof message.error === 'string' ? message.error : '页面未能挂载光晕');
    }
  }

  private awaitAck(link: Link): void {
    clearTimeout(link.timer);
    link.timer = setTimeout(() => {
      const error = new Error('页面未确认光晕状态');
      if (link.phase === 'connecting') this.release(link, error);
      else if (link.phase === 'showing') this.retire(link, error);
      else report('retire-timeout', error, link.target.tabId);
    }, ACK_TIMEOUT_MS);
  }

  private retire(link: Link, error?: Error): void {
    if (link.phase === 'retiring') return;
    if (link.phase === 'connecting') return this.release(link, error);
    link.phase = 'retiring';
    // Do not promote a new document on timeout alone. The previous renderer
    // may still be painting, even when its main thread cannot process messages.
    try {
      link.port.postMessage({ type: 'hide' });
      this.awaitAck(link);
      if (error) report('show-timeout', error, link.target.tabId);
    } catch (disconnectError) {
      this.release(link, disconnectError);
    }
  }

  private release(link: Link, error?: unknown): void {
    if (this.link !== link) return;
    this.link = undefined;
    clearTimeout(link.timer);
    if (link.phase === 'retiring') console.info('[PageGlow] cleared', { tabId: link.target.tabId });
    try {
      link.port.disconnect();
    } catch (disconnectError) {
      report('disconnect', disconnectError, link.target.tabId);
    }
    if (link.target === this.target) {
      this.retry(link.target, 'renderer', error ?? '页面连接已释放');
    }
    this.reconcile();
  }

  private retry(target: Target, phase: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (isRestricted(message)) {
      console.info('[PageGlow] blocked', { tabId: target.tabId, phase });
      target.attempts = MAX_ATTEMPTS;
      return;
    }
    if (target.attempts >= MAX_ATTEMPTS) {
      report(phase, error, target.tabId);
      return;
    }
    target.retry = setTimeout(() => {
      target.retry = undefined;
      if (this.target === target && !this.link) void this.connect(target);
    }, target.attempts * 120);
  }

  private readonly activated = ({ tabId, windowId }: chrome.tabs.TabActiveInfo) => {
    if (!this.runs.size) return;
    if (this.pendingFocusWindow !== undefined) {
      if (this.pendingFocusWindow === windowId) this.queryForeground(windowId, true);
    } else if (this.foregroundWindow === undefined) {
      this.useForeground();
      this.queryForeground();
    } else if (this.foregroundWindow === windowId) {
      this.selection++;
      this.useForeground(tabId);
    }
  };

  private readonly focused = (windowId: number) => {
    if (windowId < 0 || !this.runs.size) return;
    if (this.foregroundWindow === windowId) {
      if (this.pendingFocusWindow !== undefined) {
        this.pendingFocusWindow = windowId;
        this.queryForeground(windowId, true);
      }
      return;
    }
    this.pendingFocusWindow = windowId;
    this.queryForeground(windowId, true);
  };

  private readonly committed = (event: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
    if (event.frameType ? event.frameType !== 'outermost_frame' : event.frameId !== 0) return;
    if (event.documentLifecycle && event.documentLifecycle !== 'active') return;
    const link = this.link;
    if (event.tabId === this.target?.tabId &&
        !(event.documentId && this.target.documentId === event.documentId && link?.phase === 'visible')) {
      this.select(event.tabId, event.documentId, true);
    }
    if (link?.target.tabId === event.tabId && link.target.documentId && event.documentId &&
        link.target.documentId !== event.documentId) {
      // The old document is no longer presented in this tab, even if cached.
      this.release(link);
    }
  };

  private readonly updated = (tabId: number, change: chrome.tabs.TabChangeInfo) => {
    const target = this.target;
    if (change.status !== 'complete' || target?.tabId !== tabId || this.link) return;
    if (target.retry !== undefined) {
      clearTimeout(target.retry);
      target.retry = undefined;
      // A tab update can be the only signal when a restricted document
      // hands back to a regular page. Resolve the current main document again.
      target.documentId = undefined;
      void this.connect(target);
    } else if (target.attempts >= MAX_ATTEMPTS && !target.loadRecoveryUsed) {
      target.loadRecoveryUsed = true;
      target.attempts = 0;
      target.documentId = undefined;
      void this.connect(target);
    }
  };

  private readonly removed = (tabId: number) => {
    const link = this.link?.target.tabId === tabId ? this.link : undefined;
    if (this.target?.tabId === tabId) this.select(undefined);
    if (link) this.release(link);
    if (this.foregroundTab === tabId) {
      this.useForeground();
      if (this.runs.size) this.queryForeground();
    } else if (this.owner !== undefined && this.runs.get(this.owner)?.tabId === tabId) {
      this.useForeground(this.foregroundTab);
    }
    for (const run of this.runs.values()) if (run.tabId === tabId) run.tabId = undefined;
  };

  private readonly replaced = (addedTabId: number, removedTabId: number) => {
    if (this.foregroundTab === removedTabId) {
      this.selection++;
      this.foregroundEpoch++;
      this.foregroundTab = addedTabId;
    }
    for (const run of this.runs.values()) if (run.tabId === removedTabId) run.tabId = addedTabId;
    if (this.target?.tabId === removedTabId) this.select(addedTabId);
    if (this.link?.target.tabId === removedTabId) this.release(this.link);
  };

  private listening = false;
  private listen(enabled: boolean): void {
    if (this.listening === enabled) return;
    this.listening = enabled;
    const method = enabled ? 'addListener' : 'removeListener';
    chrome.tabs?.onActivated?.[method](this.activated);
    chrome.tabs?.onUpdated?.[method](this.updated);
    chrome.tabs?.onRemoved?.[method](this.removed);
    chrome.tabs?.onReplaced?.[method](this.replaced);
    chrome.windows?.onFocusChanged?.[method](this.focused);
    chrome.webNavigation?.onCommitted?.[method](this.committed);
  }
}

export const pageGlow = new PageGlow();

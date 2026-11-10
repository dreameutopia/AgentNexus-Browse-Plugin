/**
 * CDP（Chrome DevTools Protocol）会话管理器
 *
 * 通过 chrome.debugger 附加到标签页并复用同一条调试会话，向工具层提供
 * 「最高权限」的页面执行通道：CDP 的 Runtime.evaluate 直接在页面主世界（MAIN）
 * 的 V8 上下文中求值，**不受页面 Content Security Policy 约束**——这正是
 * Puppeteer/Playwright 的 page.evaluate 底层机制，可作为 chrome.scripting
 * 注入代码在严格 CSP 网站（GitHub、Google 等禁用 unsafe-eval）上 eval 被拒时
 * 的权威兜底。
 *
 * 设计要点（对齐 Chrome 扩展最佳实践）：
 * 1. 会话复用 + TTL 自动脱离：chrome.debugger.attach 只能对同一标签页成功一次，
 *    反复 attach/detach 会造成标签页「正在被调试」提示条闪烁。这里首次 attach 后
 *    保持会话，最后一次使用后闲置 TTL 自动 detach，既省开销又不长期占用；
 * 2. onDetach 事件兜底清理：页面关闭、导航导致目标丢失、用户手动停止调试等场景
 *    下浏览器会推送 onDetach，据此同步本地会话表，避免状态不一致；
 * 3. 被其它调试器（DevTools、Puppeteer 等）占用时 attach 会抛错，统一转换为
 *    结构化错误，由上层决定是否回退到 scripting 通道；
 * 4. 求值结果双模式序列化：优先 returnByValue 直接取回可 JSON 化的值；对 DOM 节点、
 *    函数等不可按值返回的对象，回退为按 RemoteObject 描述信息转换，保证不丢结果。
 */

/** CDP 协议版本（chrome.debugger.attach 要求） */
const CDP_PROTOCOL_VERSION = '1.3';

/** 会话闲置 TTL：最后一次使用后超过该时长自动 detach */
const SESSION_TTL_MS = 60_000;

/** Runtime.evaluate 默认超时（工具层可覆盖） */
const DEFAULT_EVALUATE_TIMEOUT_MS = 15_000;

/** CDP 求值结果 */
export interface CdpEvaluateResult {
  ok: boolean;
  /** returnByValue 取回的可序列化值（不可按值返回时为 undefined） */
  value?: unknown;
  /** RemoteObject 类型：number/string/boolean/object/function/symbol/undefined */
  remoteType?: string;
  /** RemoteObject 子类型：node/error/null 等，或不可按值返回时的描述文本 */
  description?: string;
  /** 求值抛出的异常信息（含 V8 堆栈描述） */
  error?: string;
}

/** Runtime.evaluate 选项 */
export interface CdpEvaluateOptions {
  /** 是否等待 Promise settle 后返回结果（等价于控制台 await 语义） */
  awaitPromise?: boolean;
  /** 超时时间（毫秒） */
  timeoutMs?: number;
  /** 指定求值的 JS 上下文 ID（默认主框架主世界上下文） */
  contextId?: number;
}

/** 从 ExceptionDetails 提取可读的异常描述（含堆栈） */
function describeExceptionDetails(details: any): string {
  if (!details) return 'Unknown exception';
  const ex = details.exception;
  const desc =
    (ex && (ex.description || (ex.value !== undefined ? String(ex.value) : undefined))) ||
    details.text ||
    'Unknown exception';
  return typeof desc === 'string' ? desc : String(desc);
}

/**
 * CDP 会话管理器（单例）
 */
class CdpSessionManager {
  /** tabId → 闲置自动脱离定时器 */
  private ttlTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private listenersReady = false;
  private attaching = new Map<number, Promise<void>>();
  private epochs = new Map<number, number>();
  /** A live screenshot must not lose its viewport to an idle-time detach. */
  private retainedUntil = new Map<number, number>();

  retainUntil(tabId: number, expiresAt: number): void {
    if (!this.hasSession(tabId) || !Number.isFinite(expiresAt)) return;
    this.retainedUntil.set(tabId, Math.max(this.retainedUntil.get(tabId) ?? 0, expiresAt));
    this.refreshTtl(tabId);
  }

  /** Changes on attach/detach so gestures can reject a session replaced mid-operation. */
  getEpoch(tabId: number): number { return this.epochs.get(tabId) ?? 0; }

  /** 当前是否持有指定标签页的调试会话 */
  hasSession(tabId: number): boolean {
    return this.ttlTimers.has(tabId);
  }

  /** Renew an existing session only; never attach while checking stale evidence. */
  touch(tabId: number): boolean {
    if (!this.hasSession(tabId)) return false;
    this.refreshTtl(tabId);
    return true;
  }

  /** chrome.debugger 是否可用（仅 background/service worker 环境可用） */
  isSupported(): boolean {
    return typeof chrome !== 'undefined' && !!chrome.debugger;
  }

  /** 注册 onDetach 监听（幂等），保证外部脱离时同步本地状态 */
  private ensureListeners(): void {
    if (this.listenersReady) return;
    try {
      chrome.debugger.onDetach.addListener((target) => {
        if (typeof target.tabId === 'number') {
          this.forget(target.tabId);
        }
      });
      this.listenersReady = true;
    } catch (error) {
      console.warn('[CdpSession] 注册 onDetach 监听失败:', error);
    }
  }

  /** 刷新 TTL（首次 attach 与每次复用时调用） */
  private refreshTtl(tabId: number): void {
    const old = this.ttlTimers.get(tabId);
    if (old) clearTimeout(old);
    this.ttlTimers.set(
      tabId,
      setTimeout(() => {
        void this.detach(tabId);
      }, Math.max(SESSION_TTL_MS, (this.retainedUntil.get(tabId) ?? 0) - Date.now())),
    );
  }

  /** 移除本地会话记录（不清定时器以外的状态，不调用 detach API） */
  private forget(tabId: number): void {
    const timer = this.ttlTimers.get(tabId);
    if (timer) clearTimeout(timer);
    this.ttlTimers.delete(tabId);
    this.retainedUntil.delete(tabId);
    this.epochs.set(tabId, this.getEpoch(tabId) + 1);
  }

  /**
   * 附加（或复用）指定标签页的调试会话
   * @throws 附加失败时抛出 Error（含被占用/不可调试等原因），由上层回退处理
   */
  async attach(tabId: number): Promise<void> {
    this.ensureListeners();
    if (this.ttlTimers.has(tabId)) {
      this.refreshTtl(tabId);
      return;
    }
    let pending = this.attaching.get(tabId);
    if (!pending) {
      pending = chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION).then(() => {
        this.epochs.set(tabId, this.getEpoch(tabId) + 1);
        this.refreshTtl(tabId);
      });
      this.attaching.set(tabId, pending);
    }
    try { await pending; }
    finally { if (this.attaching.get(tabId) === pending) this.attaching.delete(tabId); }
  }

  /** 主动脱离指定标签页的调试会话 */
  async detach(tabId: number): Promise<void> {
    const pending = this.attaching.get(tabId);
    if (pending) await pending.catch(() => undefined);
    this.forget(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // 会话可能已被浏览器自动脱离（页面关闭/导航等），忽略即可
    }
  }

  /** 脱离全部会话（供清理场景调用） */
  async detachAll(): Promise<void> {
    const tabIds = Array.from(this.ttlTimers.keys());
    await Promise.all(tabIds.map((tabId) => this.detach(tabId)));
  }

  /**
   * 在页面主世界求值表达式（CDP Runtime.evaluate）
   *
   * 调用前需已 attach（本方法会自动 attach，失败则抛错）。
   * 语义与 F12 控制台一致：以脚本形式求值并返回完成值；awaitPromise 开启时
   * 对返回的 Promise 等待 settle。
   */
  async evaluate(
    tabId: number,
    expression: string,
    options: CdpEvaluateOptions = {},
  ): Promise<CdpEvaluateResult> {
    const { awaitPromise = true, timeoutMs = DEFAULT_EVALUATE_TIMEOUT_MS, contextId } = options;

    await this.attach(tabId);
    // 求值期间会话绝不闲置脱离：attach 只刷 60s 闲置 TTL，而 timeoutMs 可达
    // 300s——不保留的话，长求值跑到 60s 会被 TTL 定时器 detach 掉，CDP 响应
    // 永远不会回来（工具层白等满超时，模型收到的还是兜底文案）。
    // 求值结束后保留期仍生效，但恢复正常闲置回收节奏。
    this.retainUntil(tabId, Date.now() + timeoutMs + 5_000);

    const baseParams: Record<string, unknown> = {
      expression,
      awaitPromise,
      // 页面侧返回值按值序列化（等价于结构化克隆），避免 RemoteObject 句柄泄漏
      returnByValue: true,
      timeout: timeoutMs,
      ...(contextId !== undefined ? { contextId } : {}),
    };

    let response: any;
    try {
      response = await this.sendCommand(tabId, baseParams, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 不可按值返回（循环引用链过长等）：回退为按描述信息返回
      if (/couldn't be returned by value|reference chain/i.test(message)) {
        try {
          response = await this.sendCommand(
            tabId,
            { ...baseParams, returnByValue: false },
            timeoutMs,
          );
        } catch (fallbackError) {
          return {
            ok: false,
            error: `CDP 求值失败: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
          };
        }
      } else {
        return { ok: false, error: `CDP 求值失败: ${message}` };
      }
    }

    if (response?.exceptionDetails) {
      return {
        ok: false,
        error: describeExceptionDetails(response.exceptionDetails),
      };
    }

    const remote = response?.result;
    if (!remote) {
      return { ok: true, value: undefined, remoteType: 'undefined' };
    }

    // 值可按 JSON 返回时直接取回；否则（DOM 节点/函数/符号等）转为描述文本
    if (remote.value !== undefined) {
      return { ok: true, value: remote.value, remoteType: remote.type };
    }
    if (remote.type === 'undefined') {
      return { ok: true, value: undefined, remoteType: 'undefined' };
    }
    const fallbackValue =
      remote.description ||
      (remote.subtype === 'null' ? null : `[${remote.type}${remote.subtype ? `:${remote.subtype}` : ''}]`);
    return { ok: true, value: fallbackValue, remoteType: remote.type, description: remote.description };
  }

  /**
   * 终止目标页当前正在执行的 JavaScript（CDP Runtime.terminateExecution）。
   *
   * 这是页面求值通道的**硬杀**手段：注入通道（chrome.scripting）无法终止
   * 页面里已在运行的脚本（同一线程上的死循环更是谁都杀不掉），而 CDP 走的是
   * 浏览器调试器，可以打断当前执行——包括死循环。
   *
   * 作用域说明：terminateExecution 作用于「目标当前正在执行的那段 JS」，
   * 未必精确是我们注入的那一段。因此调用方只在**用户主动中断 / 单工具超时**
   * 时使用（此时页面上的任何脚本继续跑都属于用户预期之外的残留），并把它
   * 定位为「尽力而为」的清理手段，而非精确取消。
   *
   * 幂等：目标没有正在执行的脚本时命令同样成功（无副作用）。
   */
  async terminateExecution(tabId: number): Promise<boolean> {
    if (!this.isSupported() || !this.hasSession(tabId)) return false;
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.terminateExecution');
      return true;
    } catch {
      // 目标已关闭 / 调试器已脱离 / 当前无可终止的执行：清理手段失败不影响主流程
      return false;
    }
  }

  /**
   * 封装 Runtime.evaluate 的 sendCommand 调用
   *
   * CDP 侧没有细粒度的取消机制，这里用 Promise.race 做超时保护：
   * 超时后放弃等待并向调用方返回，页面侧求值仍会自然完成（不中断）。
   */
  private async sendCommand(
    tabId: number,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<any> {
    const request = chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', params);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`求值超时（${timeoutMs}ms 未完成）`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([request, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export const cdpSession = new CdpSessionManager();

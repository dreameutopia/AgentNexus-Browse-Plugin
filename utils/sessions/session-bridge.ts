/**
 * 会话跨上下文桥（管理中心 ↔ 侧边栏 ↔ 后台）
 *
 * 「会话管理」分区（entrypoints/hub/sessions）要在**另一个扩展页面**里操作
 * 侧边栏持有的会话，绕不开三类跨上下文事实：
 *   1. **谁正在执行**：普通对话的运行由后台 worker 持有（inFlightRuns），
 *      学习 / 验证类的运行则由侧边栏本地引擎持有 —— 两处都要覆盖，
 *      否则会出现「管理中心显示空闲、实际正在跑」的窗口；
 *   2. **侧边栏当前开着哪个会话**：会话指针在 chrome.storage.session，
 *      管理中心可直接读取，无需任何消息往返；
 *   3. **会话列表的实时性**：任一上下文改动会话后，其余上下文要立即看到。
 *
 * 本模块是这三件事的**唯一协议出口**：消息类型常量、广播、订阅、查询
 * 都收敛在此，避免「同一语义在两处各写一遍」导致的漂移。
 *
 * 消息应答的唯一性约束（Chrome 语义）：
 *   `chrome.runtime.sendMessage` 会被**除发送方以外的所有扩展上下文**收到，
 *   而**只有第一个调用 sendResponse 的监听器生效**。因此每种消息类型必须
 *   严格「单一应答方」：
 *     - RUNTIME_STATUS   → 仅后台应答（worker 持有运行态，是唯一权威）；
 *     - OPEN_IN_SIDEPANEL / DELETED → 仅侧边栏接收（后台与管理中心都忽略）；
 *     - CHANGED          → 广播，无人应答。
 *   侧边栏本地运行态不走消息而走 chrome.storage.session（见下），
 *   正是为了避开「多应答方抢答」这一类难以排查的时序问题。
 */

/** 跨上下文消息类型（单一事实源；改名必须同步全部收发方） */
export const SESSION_BRIDGE_MSG = {
  /** 会话列表发生变化（广播，无应答） */
  CHANGED: 'agentnexus:session-changed',
  /** 查询后台持有的运行态（应答方：后台） */
  RUNTIME_STATUS: 'agentnexus:session-runtime-status',
  /** 请求侧边栏打开指定会话（接收方：侧边栏） */
  OPEN_IN_SIDEPANEL: 'agentnexus:session-open-in-sidepanel',
  /** 通知侧边栏：某会话已被删除（接收方：侧边栏） */
  DELETED: 'agentnexus:session-deleted',
} as const;

/** 会话变更原因（供订阅方判断是否需要重载整表） */
export type SessionChangeReason =
  | 'created'
  | 'renamed'
  | 'updated'
  | 'archived'
  | 'unarchived'
  | 'deleted'
  | 'swept';

/** 侧边栏本地运行中的会话（chrome.storage.session，数组形态便于整体覆盖写） */
export const SIDEPANEL_LOCAL_RUNNING_KEY = 'sidepanel.localRunningChats';

/** chrome.runtime 不可用时的统一降级：无广播、无监听、无查询 */
function runtimeAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}

/**
 * 广播会话变更（fire-and-forget）。
 *
 * 失败（后台未就绪 / 扩展正在卸载）一律吞掉：本函数只是「让别处尽快刷新」
 * 的加速手段，真正的数据一致性由 IndexedDB 权威源 + 管理中心的定时与
 * 聚焦刷新兜底，绝不能因为一条通知发不出去就让调用方的主流程失败。
 */
export function notifySessionsChanged(reason: SessionChangeReason): void {
  if (!runtimeAvailable()) return;
  try {
    const sending = chrome.runtime.sendMessage({
      type: SESSION_BRIDGE_MSG.CHANGED,
      reason,
    });
    // 未捕获的 promise 拒绝（无接收端）必须显式吞掉，否则会产生噪声告警
    if (sending && typeof sending.catch === 'function') {
      sending.catch(() => undefined);
    }
  } catch {
    /* 广播失败不影响主流程 */
  }
}

/**
 * 订阅会话变更广播，返回退订函数。
 *
 * 发送方不会收到自己的广播（Chrome 语义），因此管理中心的「本地删除」
 * 与「侧边栏的删除」不会互相触发重复刷新。
 */
export function watchSessionsChanged(handler: (reason: SessionChangeReason) => void): () => void {
  if (!runtimeAvailable() || !chrome.runtime.onMessage) return () => undefined;
  const listener = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean | undefined => {
    const payload = message as { type?: string; reason?: SessionChangeReason } | undefined;
    if (!payload || payload.type !== SESSION_BRIDGE_MSG.CHANGED) return undefined;
    try {
      handler(payload.reason ?? 'updated');
    } catch (error) {
      console.warn('[SessionBridge] 会话变更处理失败:', error);
    }
    // 不接管应答通道：广播类消息无需响应，返回 undefined 让通道自然关闭
    void sendResponse;
    return undefined;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/**
 * 查询后台持有的运行态（应答方：后台）。
 *
 * 覆盖后台的三个运行维度：模型请求在途、发送前压缩在途、停止流程在途。
 * 三者任一为真都意味着「这个会话正在动」，操作必须先让用户等待。
 *
 * 后台不可达（旧版本 worker / 扩展正在更新）时返回空集 —— 调用方据此
 * 继续执行，真正的中止兜底由会话删除引擎负责（宁可中止一次运行，
 * 也不能因一次查询失败就卡死用户的删除意图）。
 */
export async function queryWorkerBusySessions(chatIds: readonly string[]): Promise<string[]> {
  if (!runtimeAvailable() || chatIds.length === 0) return [];
  const response = await sendExtensionMessage<{ ok?: boolean; busy?: string[] }>({
    type: SESSION_BRIDGE_MSG.RUNTIME_STATUS,
    chatIds: [...chatIds],
  });
  if (!response || !response.ok || !Array.isArray(response.busy)) return [];
  return response.busy.filter(id => typeof id === 'string' && id.length > 0);
}

/**
 * 读取侧边栏当前打开的会话（chrome.storage.session 的活跃会话指针）。
 *
 * 该指针跨「面板关闭」存活（浏览器会话级存储），因此读到的值可能对应
 * 一个并未打开的面板 —— 调用方只把它当作「删除后是否需要通知侧边栏换新会话」
 * 的提示，任何基于它的动作都必须允许「通知了但没人接」。
 */
export async function readSidepanelActiveChatId(): Promise<string> {
  if (!runtimeAvailable() || !chrome.storage?.session) return '';
  try {
    const stored = await chrome.storage.session.get('sidepanel.activeChatId');
    const value = stored['sidepanel.activeChatId'];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * 读取侧边栏本地引擎正在运行的会话（学习 / 验证类运行）。
 *
 * 走 chrome.storage.session 而非消息：侧边栏本地运行与后台 worker 运行是
 * 两个互斥的持有者，用消息查询会撞上「多应答方抢答」的 Chrome 语义；
 * 存储读取则是单向的、只读的，不存在应答权竞争。
 */
export async function readSidepanelLocalRunningChats(): Promise<string[]> {
  if (!runtimeAvailable() || !chrome.storage?.session) return [];
  try {
    const stored = await chrome.storage.session.get(SIDEPANEL_LOCAL_RUNNING_KEY);
    const value = stored[SIDEPANEL_LOCAL_RUNNING_KEY];
    return Array.isArray(value) ? value.filter(id => typeof id === 'string' && id.length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * 汇总「正在执行」的会话集合（后台 worker 运行 ∪ 侧边栏本地运行）。
 *
 * 这是「能否切换 / 删除该会话」的唯一判据。两个来源都取并集：只看其一
 * 都会漏掉另一侧持有的运行（表现为「以为空闲，实际正在写库」）。
 */
export async function listBusySessions(chatIds: readonly string[]): Promise<Set<string>> {
  const busy = new Set<string>();
  if (chatIds.length === 0) return busy;
  const [workerBusy, localRunning] = await Promise.all([
    queryWorkerBusySessions(chatIds),
    readSidepanelLocalRunningChats(),
  ]);
  const scope = new Set(chatIds);
  for (const id of workerBusy) if (scope.has(id)) busy.add(id);
  for (const id of localRunning) if (scope.has(id)) busy.add(id);
  return busy;
}

/**
 * 登记 / 注销「侧边栏本地引擎正在运行的会话」。
 *
 * 只有侧边栏会调用本方法：学习 / 验证类的运行由侧边栏本地引擎持有
 * （不走后台端口），后台因此看不到它们 —— 侧边栏必须自报，管理中心
 * 才能在「切换 / 删除」前拦住这些会话。
 *
 * 写入是整体覆盖：读出当前集合 → 增删一项 → 写回。比「逐项增删」更
 * 稳（并发写入不会互相抹掉对方的修改），且集合极小（同时最多一两个）。
 */
export async function setLocalRunningChat(chatId: string, running: boolean): Promise<void> {
  if (!chatId || !runtimeAvailable() || !chrome.storage?.session) return;
  try {
    const stored = await chrome.storage.session.get(SIDEPANEL_LOCAL_RUNNING_KEY);
    const raw = stored[SIDEPANEL_LOCAL_RUNNING_KEY];
    const current = Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const next = running
      ? current.includes(chatId)
        ? current
        : [...current, chatId]
      : current.filter(id => id !== chatId);
    // 无变化不写：避免每次运行状态查询都产生一次存储写入与变更事件
    if (next.length === current.length && next.every((id, index) => id === current[index])) return;
    await chrome.storage.session.set({ [SIDEPANEL_LOCAL_RUNNING_KEY]: next });
  } catch (error) {
    console.warn('[SessionBridge] 上报侧边栏本地运行态失败:', error);
  }
}

/** 请求侧边栏打开会话的结果（三态，供调用方给出准确的用户提示） */
export type OpenInSidepanelResult =
  /** 侧边栏已接手切换 */
  | 'opened'
  /** 侧边栏在场但拒绝了（正忙 / 会话不存在） */
  | 'rejected'
  /** 侧边栏未打开或通信失败（无人应答） */
  | 'unavailable';

/**
 * 请求侧边栏打开指定会话。
 *
 * 三态区分「没开」与「拒绝」：前者提示用户先打开侧边栏，后者提示稍后重试 ——
 * 混成一个布尔会让用户对着一个无法执行的操作反复重试。
 * 侧边栏若正忙（当前会话在跑），它会自行拒绝并给出提示 —— 管理中心
 * 在此之前已做过运行态检查，双侧各自防御。
 */
export async function requestOpenInSidepanel(chatId: string): Promise<OpenInSidepanelResult> {
  if (!chatId) return 'unavailable';
  const response = await sendExtensionMessage<{ ok?: boolean }>({
    type: SESSION_BRIDGE_MSG.OPEN_IN_SIDEPANEL,
    chatId,
  });
  if (!response) return 'unavailable';
  return response.ok === true ? 'opened' : 'rejected';
}

/**
 * 通知侧边栏：某个会话已被删除。
 *
 * 侧边栏若正打开该会话，会清空缓存并回到新会话（与侧边栏内部删除的
 * 收尾逻辑完全一致）。侧边栏没开时无人接收，通知自然落空，无副作用。
 */
export function notifySessionDeleted(chatId: string): void {
  if (!chatId || !runtimeAvailable()) return;
  try {
    const sending = chrome.runtime.sendMessage({
      type: SESSION_BRIDGE_MSG.DELETED,
      chatId,
    });
    if (sending && typeof sending.catch === 'function') sending.catch(() => undefined);
  } catch {
    /* 通知失败不影响删除结果 */
  }
}

/**
 * 向扩展内其它上下文发消息并等待应答。
 *
 * 用回调形态而非 promise 形态：Chrome 的 promise 形态在「无接收端」时
 * 会以 rejected promise 表现，需要额外的 try/catch 与 lastError 判定；
 * 回调形态统一走「无应答 → null」，调用方只需判空。
 *
 * 超时兜底：接收方存在但迟迟不应答（例如侧边栏正卡在同步任务里）时，
 * 挂起的通道会一直占着 —— 加有界超时，超时按「无应答」处理。
 */
function sendExtensionMessage<T>(message: unknown, timeoutMs = 5000): Promise<T | null> {
  if (!runtimeAvailable()) return Promise.resolve(null);
  return new Promise<T | null>(resolve => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      chrome.runtime.sendMessage(message, (response: unknown) => {
        clearTimeout(timer);
        // 无接收端时 Chrome 会写入 runtime.lastError；读取它即可避免控制台噪声
        void chrome.runtime.lastError;
        finish((response ?? null) as T | null);
      });
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

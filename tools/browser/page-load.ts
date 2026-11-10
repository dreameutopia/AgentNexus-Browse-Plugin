/**
 * 页面加载就绪等待（单一实现）
 *
 * browser_navigation 的 open / refresh / back / forward / wait 五个 action 与
 * 项目内部调用方（如 setup_excalidraw_canvas）共用同一套就绪判定，杜绝多份
 * 实现随时间漂移。判定标准（比「tab.status === 'complete'」严一档）：
 *   - tab.status === 'complete' **且** document.readyState === 'complete'
 *     连续命中 2 次才算就绪——动态渲染站点（正文由 JS 异步注入）在
 *     status=complete 时往往还没出正文，早一步行动会拿到空壳；
 *   - 注入探测被拒绝（受限页 chrome:// 等）→ 退化为只看 tab.status；
 *   - 探测成功但返回值不是字符串 → 按已就绪处理（探测不到 ≠ 没就绪，
 *     避免在无法探测的页面上空等到超时）；
 *   - 标签页在等待期间被关闭 → 立即以 reason:'closed' 返回，不空转到超时。
 *
 * 结果以结构化 outcome 返回（不抛错），由调用方决定成功/失败文案与载荷形态。
 */

/** 默认等待上限（毫秒）——与 browser_navigation 各导航 action 的 timeout 默认值同源 */
export const PAGE_LOAD_DEFAULT_TIMEOUT_MS = 30_000;
/**
 * 等待类 timeout 的合法上限（毫秒）。
 *
 * 有界执行的理由：工具在 background 轮询，会话引擎的工具超时（默认 120s）
 * 到点只会给出「引擎兜底超时」的笼统结果——工具侧必须**先于引擎**自己收敛，
 * 返回带 tabId/status/elapsedMs 的可分析诊断。100s 留出引擎兜底余量；
 * 真正的长等待（分钟级）不属于「页面加载等待」，应改用 generic_wait。
 */
export const PAGE_LOAD_TIMEOUT_MAX_MS = 100_000;
/** 默认轮询间隔（毫秒） */
export const PAGE_LOAD_DEFAULT_POLL_MS = 500;
/** 连续命中几次「完成」才算就绪 */
export const PAGE_LOAD_REQUIRED_CONSECUTIVE = 2;
/** wait action 的 checkInterval 合法区间（毫秒）：过小会空转刷 API，过大失去等待意义 */
export const WAIT_INTERVAL_MIN_MS = 50;
export const WAIT_INTERVAL_MAX_MS = 10_000;

export interface TabReadyOptions {
  /** 等待上限（毫秒，默认 PAGE_LOAD_DEFAULT_TIMEOUT_MS） */
  timeoutMs?: number;
  /** 轮询间隔（毫秒，默认 PAGE_LOAD_DEFAULT_POLL_MS） */
  pollIntervalMs?: number;
}

export type TabReadyOutcome =
  | {
      ready: true;
      /** 实际耗时（毫秒） */
      elapsedMs: number;
      /** 末段连续命中次数（≥ PAGE_LOAD_REQUIRED_CONSECUTIVE） */
      consecutive: number;
      /** 就绪判定是否经过 document.readyState 探测确认（false = 探测被拒，按 tab.status 判定） */
      readyStateConfirmed: boolean;
      /** 就绪时的 tab.status */
      status: 'complete';
    }
  | {
      ready: false;
      reason: 'timeout' | 'closed';
      elapsedMs: number;
      /** 超时时的 tab.status（标签页被关闭时为最后一次读到的值） */
      status?: string;
      /** 超时时已连续命中的次数（诊断用） */
      consecutive?: number;
    };

/**
 * 等待指定标签页达到就绪状态（可被调用方传入的超时/间隔约束的有界等待）。
 * 纯轮询 chrome.tabs + 可失败的 readyState 探测，不写任何页面状态。
 */
export async function waitForTabReady(
  tabId: number,
  options: TabReadyOptions = {},
): Promise<TabReadyOutcome> {
  const timeoutMs = options.timeoutMs ?? PAGE_LOAD_DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? PAGE_LOAD_DEFAULT_POLL_MS;
  const startedAt = Date.now();
  let consecutive = 0;
  let readyStateConfirmed = false;
  let lastStatus: string | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    // 空值防御：真实 chrome.tabs.get 对缺失 id 会 reject，但实现不依赖该行为——
    // 解析出 undefined（桩/异常实现）同样按「标签页已关闭」收口，绝不裸读 .status
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      tab = undefined;
    }
    if (!tab) {
      return { ready: false, reason: 'closed', elapsedMs: Date.now() - startedAt, status: lastStatus };
    }
    lastStatus = tab.status;

    if (tab.status === 'complete') {
      let ready: boolean;
      let confirmed = false;
      try {
        const probe = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.readyState,
        });
        const state = probe?.[0]?.result;
        if (typeof state === 'string') {
          // 探测成功：只有明确知道未就绪才继续等待
          ready = state === 'complete';
          confirmed = true;
        } else {
          // 探测成功但取不到有效值：按已就绪处理（与页面提取工具的宽松口径一致）
          ready = true;
        }
      } catch {
        // 探测被拒绝（受限页）：退化为只看 tab.status
        ready = true;
      }
      if (ready) {
        consecutive += 1;
        // 取**最近一次**有效检查的确认状态：终局判定由最后一跳的证据强度决定，
        // 早先的强确认不能替最终的弱确认（退化路径）背书
        readyStateConfirmed = confirmed;
        if (consecutive >= PAGE_LOAD_REQUIRED_CONSECUTIVE) {
          return {
            ready: true,
            elapsedMs: Date.now() - startedAt,
            consecutive,
            readyStateConfirmed,
            status: 'complete',
          };
        }
      } else {
        consecutive = 0;
        readyStateConfirmed = false;
      }
    } else {
      consecutive = 0;
      readyStateConfirmed = false;
    }

    // 有界睡眠：轮询间隔只取剩余预算内的值——timeout 短于间隔时不得多睡一个
    // 间隔（否则 50ms 预算 + 10s 间隔会实等 10s，超时语义失效）
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
  }

  return {
    ready: false,
    reason: 'timeout',
    elapsedMs: Date.now() - startedAt,
    status: lastStatus,
    consecutive,
  };
}

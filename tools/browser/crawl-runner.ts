/**
 * 批量抓取执行器（crawl runner）
 *
 * 一段脚本跑遍 N 个目标页：扩展侧驱动循环（导航 → 等待就绪 → 注入脚本），
 * 产出**一张**关系表 + 一份逐目标账本。
 *
 * ── 为什么循环必须在扩展侧（不能在页面内自导航）────────────────
 * 这是硬约束，不是风格选择：
 *   1. **导航销毁 JS realm**：页面内自导航的循环，其累加器与 await 链在
 *      每次导航后一起消失（bfcache 文档的逆否命题）。把循环放进页面等于
 *      把状态放进每轮都会死的地方。
 *   2. **unload / pagehide 不可靠**：Chrome 默认已停止触发 unload；bfcache
 *      可能**冻结**而非销毁页面，恢复顺序不可控。
 *   3. **CORS 边界**：即便 ISOLATED world 的 content script，
 *      fetch(下一个目标) 也受同源策略约束——只有持 host_permissions 的
 *      background 能跨源取下一目标。
 *   4. **SPA 路由不触发 load**：等 load 的就绪判据对 SPA 会挂起或误判。
 * 因此：扩展侧拥有循环（导航 + 就绪 + 执行），页面只做提取器。
 *
 * 与 Playwright / Puppeteer 的一致性：二者同样把「多 URL」建模为
 * **驱动侧对导航原语的循环**，页面对象由驱动持有、按目标串行复用。
 *
 * ── 复用既有实现（不产生第二套语义）─────────────────────────────
 *   - 脚本求值：tools/browser/page-script-runner.ts（引擎升级/净化/超时同源）
 *   - 就绪等待：tools/browser/page-load.ts 的 waitForTabReady
 *   - 风控探测：tools/browser/challenge-detect.ts 的 detectChallengePage
 *   - 数据落库：utils/data-ref-store.ts
 */

import { waitForTabReady } from './page-load';
import { detectChallengePage } from './challenge-detect';
import { abortable, abortableDelay, withTimeBudget } from '@/utils/shared/abort';
import { errorDetails } from '@/utils/shared/error-details';
import { cdpSession } from './cdp-session';
import {
  runPageScript,
  type ExecStrategy,
  type ExecWorld,
} from './page-script-runner';

// ==================== 常量 ====================

/** 单次批量调用的目标数上限（防御失控；远超此规模应分批以便中途检查） */
export const CRAWL_MAX_TARGETS = 60;
/** 目标间随机停顿的默认区间（毫秒）——抖动而非固定间隔 */
export const CRAWL_DEFAULT_PACE_MIN_MS = 1_500;
export const CRAWL_DEFAULT_PACE_MAX_MS = 4_000;
/** 停顿区间的绝对上下限（毫秒）：下限允许关闭，上限防单批次跑成小时级 */
export const CRAWL_PACE_MIN_BOUND_MS = 0;
export const CRAWL_PACE_MAX_BOUND_MS = 30_000;
/** 单目标（导航 + 就绪 + 执行）的默认上限（毫秒） */
export const CRAWL_DEFAULT_TARGET_TIMEOUT_MS = 30_000;
/** 单目标上限的绝对值（毫秒） */
export const CRAWL_TARGET_TIMEOUT_MAX_MS = 120_000;
/** 连续失败触发熔断的次数 */
export const CRAWL_CIRCUIT_BREAKER_THRESHOLD = 3;
/** 单目标结果的字符上限（防止某个页面返回巨量数据撑爆暂存区） */
export const CRAWL_MAX_CAPTURE_CHARS = 6_000_000;
const CRAWL_MAX_BATCH_CHARS = 6_000_000;

// ==================== 类型 ====================

/** 逐目标状态（账本的一行） */
export type CrawlTargetStatus =
  | 'ok'           // 提取成功且拿到了数据
  | 'empty'        // 页面就绪但提取器返回空——软 404 / 选择器失配的典型信号
  | 'failed'       // 提取器抛错或导航失败
  | 'timeout'      // 该目标超时
  | 'blocked'      // 命中风控/人机验证页——需人工处理（requiresHuman）
  | 'drifted'      // 最终 URL 或正文与预期不符——站点改了链接结构 / 软 404
  | 'skipped';     // 未执行（前序熔断 / 风控中止 / 总预算耗尽 / 用户中止）

/** 单个目标的账本条目 */
export interface CrawlTargetRecord {
  /** 目标在列表中的序号（0 基） */
  index: number;
  /** 请求的 URL */
  url: string;
  /** 目标的语义标签（模型给定，便于回读账本） */
  label?: string;
  /** 导航后的最终 URL（与 url 不同说明发生了跳转） */
  finalUrl?: string;
  /** 该目标的状态 */
  status: CrawlTargetStatus;
  /** 失败/异常的原因（可读） */
  error?: string;
  /** 是否需要人工介入（命中风控时为 true） */
  requiresHuman?: boolean;
  /** 该目标耗时（毫秒） */
  durationMs: number;
}

/** 一个目标页的抓取指令 */
export interface CrawlTargetInput {
  url: string;
  label?: string;
  /** 预期 URL 必须包含的片段——不匹配即判 drifted（站点改链接结构时的护栏） */
  expectUrlIncludes?: string;
  /** 预期正文必须包含的文本——不匹配即判 drifted/empty（软 404 护栏） */
  expectTextIncludes?: string;
}

/** 一次批量抓取的结果 */
export interface CrawlOutcome {
  /** 逐目标账本（每个目标都有条目，含「未执行」） */
  ledger: CrawlTargetRecord[];
  /** 成功目标的数据行（每行带来源列） */
  rows: Record<string, unknown>[];
  /** 按状态计数 */
  summary: Record<string, number>;
  /** 整批耗时（毫秒） */
  totalDurationMs: number;
}

// ==================== 执行器 ====================

/** 批量抓取的执行参数 */
export interface CrawlRunOptions {
  /** 目标页列表 */
  targets: CrawlTargetInput[];
  /** 提取脚本（async 函数体） */
  code: string;
  /** 传给脚本的额外参数（$args[0] 之后追加） */
  args?: unknown[];
  /** 单目标上限（毫秒） */
  targetTimeoutMs: number;
  /** 整批预算（毫秒） */
  totalTimeoutMs: number;
  /** 目标间随机停顿区间 */
  paceMinMs: number;
  paceMaxMs: number;
  /** 执行世界 */
  world: ExecWorld;
  /** 执行策略 */
  strategy: ExecStrategy;
  /** 是否等待返回的 Promise 完成 */
  awaitPromise: boolean;
  /** 起始标签页（缺省用当前活动页） */
  tabId?: number;
  frameId?: number;
  onTabTarget?: (tabId: number) => void;
  /** 中止信号 */
  signal?: AbortSignal;
}

/**
 * 执行一次批量抓取。
 *
 * 失败隔离是这一层的核心：任何一步失败都只影响**那一个**目标，
 * 以账本条目返回，绝不抛出中断整批——模型据此判断哪些需要补抓。
 */
export async function runCrawlBatch(options: CrawlRunOptions): Promise<CrawlOutcome> {
  const {
    targets,
    code,
    args = [],
    targetTimeoutMs,
    totalTimeoutMs,
    paceMinMs,
    paceMaxMs,
    world,
    strategy,
    awaitPromise,
    signal,
  } = options;

  const startedAt = Date.now();
  const ledger: CrawlTargetRecord[] = [];
  const rows: Record<string, unknown>[] = [];
  let consecutiveFailures = 0;
  let circuitOpen = false;
  let blocked = false;
  let resultLimitReached = false;
  let capturedChars = 2;

  let tabId: number;
  try {
    tabId = options.tabId ?? (await withTimeBudget(totalTimeoutMs, initSignal => abortable(resolveTabId(), initSignal), signal));
    options.onTabTarget?.(tabId);
  } catch (error) {
    for (let index = 0; index < targets.length; index++) ledger.push({ index, url: targets[index].url, label: targets[index].label, status: 'skipped', error: '无法初始化抓取标签页：' + errorDetails(error), durationMs: 0 });
    return { ledger, rows, summary: summarize(ledger), totalDurationMs: Date.now() - startedAt };
  }

  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];

    // 熔断 / 风控 / 总预算 / 用户中止：剩余目标统一标 skipped
    // （账本必须有**全部**目标的条目——模型据此知道谁没跑）
    const skipReason = resultLimitReached ? '结果已达到单批容量上限，请缩小字段或分批继续' : thisSkipReason({
      circuitOpen,
      blocked,
      elapsedMs: Date.now() - startedAt,
      totalTimeoutMs,
      signal,
    });
    if (skipReason) {
      ledger.push({
        index,
        url: target.url,
        label: target.label,
        status: 'skipped',
        error: skipReason,
        durationMs: 0,
      });
      continue;
    }

    const targetStartedAt = Date.now();
    let outcome: Awaited<ReturnType<typeof crawlOne>>;
    try { outcome = await withTimeBudget(Math.min(targetTimeoutMs, totalTimeoutMs - (Date.now() - startedAt)), targetSignal => crawlOne({
      target,
      index,
      tabId,
      code,
      args,
      targetTimeoutMs,
      world,
      strategy,
      awaitPromise,
      frameId: options.frameId ?? 0,
      signal: targetSignal,
    }), signal); }
    catch (error) {
      outcome = { rows: [], record: { index, url: target.url, label: target.label,
        status: error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'failed',
        error: errorDetails(error), durationMs: Date.now() - targetStartedAt } };
    }
    ledger.push(outcome.record);

    // 结果行只含成功目标的数据（不把失败行混进待导出的表）；
    // 来源信息作为来源列附在每行上，使子表与父表天然可连接。
    if (outcome.record.status === 'ok') {
      const previousRows = rows.length, previousChars = capturedChars;
      for (const row of outcome.rows) {
        const source = {
          _target: target.label ?? String(index), _index: index, _url: target.url,
          _finalUrl: outcome.record.finalUrl ?? target.url, _status: outcome.record.status,
        };
        const next: Record<string, unknown> = {
          ...row,
          ...source,
        };
        const collisions = Object.keys(source).filter(key => Object.hasOwn(row, key));
        if (collisions.length) {
          let column = '_source_conflicts';
          while (Object.hasOwn(next, column)) column += '_';
          next[column] = Object.fromEntries(collisions.map(key => [key, row[key]]));
        }
        const chars = JSON.stringify(next).length + 1;
        if (capturedChars + chars > CRAWL_MAX_BATCH_CHARS) {
          resultLimitReached = true;
          outcome.record.status = 'failed';
          outcome.record.error = '单批结果容量耗尽，已保留前序目标的数据；本目标未暂存，请缩小字段或分批重试';
          rows.length = previousRows;
          capturedChars = previousChars;
          break;
        }
        capturedChars += chars;
        rows.push(next);
      }
    }

    // 风控页：立刻停止（不继续打扰目标站），交由用户处理
    if (outcome.record.status === 'blocked') {
      blocked = true;
      continue;
    }

    // 失败计数（仅统计真失败；blocked/timeout 各自已定性）
    if (
      outcome.record.status === 'failed' ||
      outcome.record.status === 'timeout' ||
      outcome.record.status === 'drifted' ||
      outcome.record.status === 'empty'
    ) {
      consecutiveFailures++;
      if (consecutiveFailures >= CRAWL_CIRCUIT_BREAKER_THRESHOLD) circuitOpen = true;
    } else {
      consecutiveFailures = 0;
    }

    // 目标间随机停顿（最后一个目标后不等待）
    if (index < targets.length - 1) {
      const delay = Math.min(pickDelay(paceMinMs, paceMaxMs), Math.max(0, totalTimeoutMs - (Date.now() - startedAt)));
      if (delay > 0 && !signal?.aborted && !resultLimitReached && !circuitOpen) {
        try { await abortableDelay(delay, signal); } catch { /* Remaining targets receive skipped ledger records. */ }
      }
    }
  }

  return {
    ledger,
    rows,
    summary: summarize(ledger),
    totalDurationMs: Date.now() - startedAt,
  };
}

/** 剩余目标未执行的原因（null = 继续执行） */
function thisSkipReason(state: {
  circuitOpen: boolean;
  blocked: boolean;
  elapsedMs: number;
  totalTimeoutMs: number;
  signal?: AbortSignal;
}): string | null {
  if (state.signal?.aborted) return '用户已中止，剩余目标未执行';
  if (state.circuitOpen) return '连续失败达熔断阈值，剩余目标未执行';
  if (state.blocked) return '前序目标命中风控页，按纪律停止后续抓取（需人工完成验证）';
  if (state.elapsedMs >= state.totalTimeoutMs) return '整批预算耗尽，剩余目标未执行';
  return null;
}

/**
 * 抓取一个目标页：导航 → 等待就绪 → 风控探测 → 注入脚本 → 校验身份。
 *
 * 任何一步失败都只影响这一个目标，以账本条目返回，绝不抛出。
 */
async function crawlOne(params: {
  target: CrawlTargetInput;
  index: number;
  tabId: number;
  code: string;
  args: unknown[];
  targetTimeoutMs: number;
  world: ExecWorld;
  strategy: ExecStrategy;
  awaitPromise: boolean;
  frameId: number;
  signal: AbortSignal;
}): Promise<{ record: CrawlTargetRecord; rows: Record<string, unknown>[] }> {
  const { target, index, tabId, code, args, targetTimeoutMs, world, strategy, awaitPromise, frameId, signal } = params;
  const startedAt = Date.now();

  const base = { index, url: target.url, label: target.label };

  // ── 导航 ──
  let finalUrl = target.url;
  try {
    signal.throwIfAborted();
    await abortable(chrome.tabs.update(tabId, { url: target.url }), signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      record: {
        ...base,
        status: 'failed',
        error: `导航失败：${message}`,
        durationMs: Date.now() - startedAt,
      },
      rows: [],
    };
  }

  // ── 等待就绪（判据与 browser_navigation 同一实现）──
  signal.throwIfAborted();
  const ready = await waitForTabReady(tabId, { timeoutMs: targetTimeoutMs, signal });
  if (!ready.ready) {
    return {
      record: {
        ...base,
        status: ready.reason === 'closed' ? 'failed' : 'timeout',
        error:
          ready.reason === 'closed'
            ? '标签页在等待期间被关闭'
            : `页面在 ${targetTimeoutMs}ms 内未就绪`,
        durationMs: Date.now() - startedAt,
      },
      rows: [],
    };
  }
  try {
    const tab = await abortable(chrome.tabs.get(tabId), signal);
    if (tab.url) finalUrl = tab.url;
  } catch {
    // 标签页信息读不到不致命：finalUrl 保持请求值
  }

  // ── 风控 / 人机验证探测（命中即停，绝不尝试绕过）──
  signal.throwIfAborted();
  const challenge = await abortable(detectChallengePage(tabId), signal);
  signal.throwIfAborted();
  if (challenge.detected) {
    return {
      record: {
        ...base,
        finalUrl,
        status: 'blocked',
        error: `命中风控/人机验证页${challenge.reason ? `（${challenge.reason}）` : ''}——需用户手动完成验证`,
        requiresHuman: true,
        durationMs: Date.now() - startedAt,
      },
      rows: [],
    };
  }

  // ── 身份核验：最终 URL 与预期不符 → drifted（站点改了链接结构）──
  if (target.expectUrlIncludes && !finalUrl.includes(target.expectUrlIncludes)) {
    return {
      record: {
        ...base,
        finalUrl,
        status: 'drifted',
        error:
          `最终 URL 不含预期片段 "${target.expectUrlIncludes}"（实际 "${finalUrl}"）` +
          '——目标页可能已跳转或站点改了链接结构',
        durationMs: Date.now() - startedAt,
      },
      rows: [],
    };
  }

  if (target.expectTextIncludes) {
    const checked = await abortable(chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] }, world: 'ISOLATED',
      func: function pageContainsText(needle: string) { return (document.body?.innerText ?? '').includes(needle); },
      args: [target.expectTextIncludes],
    }), signal);
    if (checked[0]?.result !== true) return { record: { ...base, finalUrl, status: 'drifted', error: '目标页面正文不含预期片段，未执行提取脚本', durationMs: Date.now() - startedAt }, rows: [] };
  }

  // ── 注入脚本 ──
  const scriptArgs = [
    { index, label: target.label, url: target.url, finalUrl },
    ...args,
  ];
  let engine: 'scripting' | 'cdp' | null = null;
  const cancel = () => { if (engine === 'cdp') void cdpSession.terminateExecution(tabId).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  let run: Awaited<ReturnType<typeof runPageScript>>;
  try { signal.throwIfAborted(); run = await abortable(runPageScript({
    tabId,
    frameId,
    code,
    args: scriptArgs,
    world,
    strategy,
    awaitPromise,
    timeoutMs: targetTimeoutMs,
    captureLimit: CRAWL_MAX_CAPTURE_CHARS,
    onEngineChange: next => { signal.throwIfAborted(); engine = next; },
  }), signal); }
  finally { signal.removeEventListener('abort', cancel); }
  signal.throwIfAborted();

  if (!run.ok) {
    return {
      record: {
        ...base,
        finalUrl,
        status: 'failed',
        error: `脚本执行失败：${run.error ?? '未知原因'}`,
        durationMs: Date.now() - startedAt,
      },
      rows: [],
    };
  }

  // ── 归一化脚本返回值 → 结果行 ──
  if (run.rawJsonError) throw new Error('完整结果捕获失败：' + run.rawJsonError);
  const raw = run.rawJson ?? JSON.stringify(run.value ?? null);
  if (raw.length > CRAWL_MAX_CAPTURE_CHARS) throw new Error('目标结果超过容量上限，请减少字段或行数');
  const value: unknown = JSON.parse(raw);
  const rows = normalizeRows(value);

  if (rows.length === 0) {
    return {
      record: {
        ...base,
        finalUrl,
        status: 'empty',
        error: '脚本执行成功但没有返回任何数据（可能是选择器失配或页面确实无数据）',
        durationMs: Date.now() - startedAt,
      },
      rows: [],
    };
  }

  return {
    record: { ...base, finalUrl, status: 'ok', durationMs: Date.now() - startedAt },
    rows,
  };
}

/**
 * 脚本返回值 → 结果行数组。
 *
 * 归一化规则（确定性）：
 *   - 对象数组 → 每个元素一行；
 *   - 单个对象 → 一行；
 *   - 标量 → 一行 {value: 标量}（保持「每目标至少一行」的语义不丢数据）；
 *   - null / undefined → 无行（该目标记为 empty）。
 */
function normalizeRows(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    const rows: Record<string, unknown>[] = [];
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        rows.push(item as Record<string, unknown>);
      } else {
        rows.push({ value: item });
      }
    }
    return rows;
  }
  if (typeof value === 'object') return [value as Record<string, unknown>];
  return [{ value }];
}

/** 取一个可用的标签页（优先当前活动页；没有则新建一个） */
async function resolveTabId(): Promise<number> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && typeof activeTab.id === 'number') return activeTab.id;
  const { existingNavigationWindowId } = await import('./navigation-window');
  const windowId = await existingNavigationWindowId();
  const created = await chrome.tabs.create({ url: 'about:blank', windowId, active: true });
  if (typeof created.id !== 'number') {
    throw new Error('无法创建可用标签页');
  }
  return created.id;
}

/** 随机停顿（抖动而非固定间隔——固定间隔与突发流量一样容易被识别） */
export function pickDelay(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

/** 账本汇总（按状态计数） */
export function summarize(ledger: CrawlTargetRecord[]): Record<string, number> {
  const summary: Record<string, number> = {
    total: ledger.length,
    ok: 0,
    empty: 0,
    failed: 0,
    timeout: 0,
    blocked: 0,
    drifted: 0,
    skipped: 0,
  };
  for (const record of ledger) {
    summary[record.status] = (summary[record.status] ?? 0) + 1;
  }
  return summary;
}

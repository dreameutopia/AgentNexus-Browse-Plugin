/**
 * 工具执行引擎（Tool Execution Engine）
 *
 * 单一事实源：**所有**工具的执行都必须经过本引擎。引擎只做四件事，
 * 每一件都是为了保住「模型上下文完整性」这一条底线：
 *
 *   1. **强制串行**：全局 FIFO 队列，任一时刻只有一个工具调用在执行。
 *      工具会改写同一页面、同一份存储、同一份会话数据；并发执行会让
 *      「模型看到的结果顺序」与「真实发生顺序」脱钩，回传上下文即失真。
 *      跨会话同样排队——会话之间共享浏览器页面与后台资源，并发并不安全。
 *
 *      串行的作用域是**一个扩展上下文**：每个 JS 上下文（sidepanel /
 *      background worker）各持一个引擎实例与一条队列。因此「同一上下文
 *      内的全部工具调用严格串行」成立；不同上下文之间（如 sidepanel 上的
 *      学习会话 与 background 里的聊天会话）各自的工具仍可能并行——那是
 *      既有的进程边界，不在本引擎的职责内。
 *
 *   2. **强制中断**：每个调用持有独立的 AbortController，合流「轮次中止」
 *      与「单工具超时」。工具经 ToolExecutionContext.signal 感知中止；
 *      另可选实现 kill() 钩子做**硬杀**（真正终止底层执行，如 CDP
 *      Runtime.terminateExecution 掐掉页面脚本、Pyodide worker 中断）。
 *      引擎自身在中止/超时后**立刻**结算该调用，绝不被工具的迟钝拖住。
 *
 *   3. **有界执行**：单工具最长执行时间有上界（默认 30 分钟，应用设置可调）。
 *      超时判定为失败，自动封装为标准 tool 结果回传模型，绝不悬挂会话。
 *
 *   4. **轮次完整性**：每批工具调用按 chatId 绑定一个**轮次 id**。工具结果
 *      写入模型上下文前必须校验「本轮次仍是该会话的当前轮次」——否则上一轮
 *      因超时/中断而迟到的结果会插进新一轮的上下文，把 assistant.tool_calls
 *      与 tool 结果的配对关系搅乱（协议不合法 → 网关 400）。
 *
 * 边界（刻意为之）：
 *   - 引擎不认识模型协议、不认识转录、不认识 UI：它只产出规范化的调用结果
 *     （ToolCallOutcome），由会话引擎负责写入上下文与渲染。
 *   - 引擎不认识任何具体工具：kill 能力由调用方（会话引擎）按工具注册表
 *     委派，引擎只负责在正确的时机调用它。
 *   - 引擎不认识会话：会话 id 只是隔离键与轮次索引。
 */

import type { ToolResult } from '@/common/tool-handler';

// ==================== 类型 ====================

/**
 * 调用结算原因（语义分类，UI 与模型面据此区分「失败」的性质）：
 *   - completed  正常返回
 *   - failed     工具返回失败结果，或抛出不可控错误
 *   - interrupted 用户中断（或外部中止信号）
 *   - timeout    超过单工具最长执行时间
 *   - deadline   超过本轮运行时长上限，未开始执行
 *   - skipped    轮次已失效，未开始执行
 */
export type ToolOutcomeReason =
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'timeout'
  | 'deadline'
  | 'skipped';

/** 单次工具调用的规范化结果（引擎唯一产出） */
export interface ToolCallOutcome {
  /** 协议 tool_call id（与 assistant.tool_calls 一一配对） */
  callId: string;
  toolName: string;
  /** 成功/失败二态（与协议 tool 消息的 success 字段同源） */
  status: 'success' | 'error';
  /** 成功时的工具结果原文 */
  result?: ToolResult;
  /** 失败原因（可读文本，直接进入 tool 消息的 error 字段） */
  error?: string;
  /** 执行耗时（毫秒）；未开始执行为 0 */
  executionTimeMs: number;
  /** 归属的工具调用轮次 id */
  roundId: string;
  /** 结算原因分类 */
  reason: ToolOutcomeReason;
}

/** 一次工具调用的执行计划（协议顺序即执行顺序） */
export interface ToolCallPlan {
  /** 协议 tool_call id */
  callId: string;
  toolName: string;
  /**
   * 原始参数（字符串或已解析对象）。
   * 解析刻意留在执行器内完成：参数非法要以可读错误回传模型自纠，
   * 而引擎的职责是「执行与结算」，不该掺入协议层的参数容错。
   */
  rawArgs?: unknown;
}

/** 单次调用的执行上下文（注入工具实现） */
export interface ToolCallContext {
  /**
   * 本次调用的中止信号：轮次中止 + 单工具超时的合流。
   * 工具应监听它并在中止时尽快停止自身工作（可读 signal.aborted）。
   */
  signal: AbortSignal;
  /** 归属的工具调用轮次 id */
  roundId: string;
  /** 发起本次工具调用的会话 id */
  chatId: string;
}

/** 单次调用的执行器（由会话引擎提供：范围校验 / 审批门 / 实际执行） */
export type ToolCallExecutor = (
  call: ToolCallPlan,
  context: ToolCallContext,
) => Promise<ToolResult>;

/** 强制终止钩子：引擎在中止/超时后调用，给工具一次真正杀掉执行的机会 */
export type ToolCallKiller = (
  call: ToolCallPlan,
  context: ToolCallContext,
) => void | Promise<void>;

export interface ToolBatchOptions {
  /** 会话 id（轮次索引与隔离键） */
  chatId: string;
  /** 轮次 id（必须来自 engine.beginRound） */
  roundId: string;
  /** 本批次的工具调用（顺序即执行顺序） */
  calls: ToolCallPlan[];
  /** 单工具最长执行时间（毫秒） */
  timeoutMs: number;
  /**
   * 可选：按调用解析单工具超时（缺省用 options.timeoutMs）。
   * 用于「同一工具族的不同调用需要不同上界」的场景（如显式等待工具按
   * 等待秒数放宽上界、交互类工具按人类答复窗口放宽上界）。
   * 解析失败一律回落到 options.timeoutMs（绝不因超时解析异常而失控）。
   */
  timeoutFor?: (call: ToolCallPlan) => number;
  /** 批次级外部中止信号（运行中止 / 插件能力撤销） */
  signal?: AbortSignal;
  /** 本批次执行截止时间戳（运行时长上限）；超过后不再开始新调用 */
  deadlineMs?: number;
  /**
   * 本批次的运行时长预算（毫秒）——仅用于把「已达上限」文案渲染成分钟数。
   * 缺省时文案退化为最小分钟数（不猜测预算，避免误导模型）。
   */
  maxDurationMs?: number;
  /** 执行器 */
  execute: ToolCallExecutor;
  /** 可选：强制终止钩子 */
  kill?: ToolCallKiller;
}

export interface ToolBatchResult {
  roundId: string;
  /** 与 options.calls 一一对应、顺序一致的结算结果（协议配对的基础） */
  outcomes: ToolCallOutcome[];
  /** 任一调用成功 */
  anySuccess: boolean;
  /** 任一调用失败（含中断/超时/未执行） */
  anyFailure: boolean;
  /** 本批次是否因中止而终止 */
  interrupted: boolean;
}

/** 中止报告：供上层确认「已真正停下」 */
export interface ToolInterruptReport {
  chatId: string;
  /** 是否存在进行中的轮次并被中止 */
  interrupted: boolean;
  /** 被中止的轮次 id（无进行中轮次为 null） */
  roundId: string | null;
  /** 该轮次下已结算的调用数 */
  settledCalls: number;
}

// ==================== 常量 ====================

/**
 * 用户主动中止会话时回传模型的工具错误文案（执行中被中止 / 因中止未开始执行，
 * 两种情形统一口径）。错误即数据：模型据此知道「不是工具坏了，是用户停了」，
 * 不会把它当作可重试的环境故障反复重试。
 */
export const TOOL_INTERRUPTED_BY_USER = '用户主动中断会话导致工具中断运行';

/**
 * 超过运行时长上限、因而未开始执行的调用的收尾文案。
 *
 * 带上工具名与上限分钟数：模型据此知道「是哪个工具没跑、还剩多少预算」，
 * 而不是只看到一个无差别的通用句。
 */
function deadlineMessage(toolName: string, maxDurationMs: number): string {
  const minutes = Math.max(MIN_REPORTED_MINUTES, Math.round(maxDurationMs / 60_000));
  return `已达本次运行时长上限（${minutes} 分钟），工具 ${toolName || '(未知工具)'} 未执行`;
}

/**
 * 强制终止钩子的等待上界（毫秒）。
 * 硬杀是尽力而为：钩子自身的卡死绝不能反过来拖住「停止」——超界即放弃等待，
 * 结算照常进行（钩子仍在后台跑，不影响上下文正确性）。
 */
const KILL_HOOK_MAX_WAIT_MS = 1500;

/** 单工具超时文案中分钟数的最小值（防止 0/负数分钟） */
const MIN_REPORTED_MINUTES = 1;

/**
 * 引擎兜底的单工具上界（毫秒，30 分钟）。
 *
 * 仅在调用方给出的上界非法（NaN / Infinity / 非正数）时启用：上界必须是
 * 一个有限的正数，否则 setTimeout 会把它当成 0ms，让每次调用瞬间判超时。
 */
const DEFAULT_TOOL_TIMEOUT_MS = 30 * 60_000;

/**
 * 单工具上界的硬上限（毫秒，24 小时）。
 *
 * setTimeout 的延时是 32 位有符号整数：超过 2^31-1 ms（约 24.8 天）会溢出成
 * 负值，被当作 0ms 立即触发——表现为「设定了一周的超时却瞬间超时」。这里把
 * 上界钳到 24 小时，既杜绝溢出，也不改变任何现实配置（设置上限 120 分钟）。
 */
const MAX_TOOL_TIMEOUT_MS = 24 * 60 * 60_000;

// ==================== 内部状态 ====================

/** 单个待执行任务（队列元素） */
interface ToolJob {
  batch: ToolBatchState;
  call: ToolCallPlan;
  /** 排队序号（调试与日志用） */
  index: number;
  /** 本任务的超时上界（毫秒） */
  timeoutMs: number;
  /** 是否已结算（幂等保护） */
  settled: boolean;
  /** 是否已开始执行 */
  started: boolean;
}

/** 一批工具调用的运行时状态 */
interface ToolBatchState {
  chatId: string;
  roundId: string;
  /** 批次中止器（合流：轮次中止 + 外部信号） */
  controller: AbortController;
  /** 本批次的全部任务（按调用顺序） */
  jobs: ToolJob[];
  /** 是否已被中止 */
  interrupted: boolean;
  /** 批次执行截止时间戳 */
  deadlineMs?: number;
  /** 本批次的运行时长预算（毫秒，仅用于文案渲染） */
  maxDurationMs?: number;
  /** 批次级执行器与终止钩子 */
  execute: ToolCallExecutor;
  kill?: ToolCallKiller;
  /** 本批次的结算结果（按调用顺序） */
  outcomes: ToolCallOutcome[];
  /** 批次全部结算完成的信号 */
  resolveDone: () => void;
  done: Promise<void>;
}

/** 一个工具调用轮次（一个会话同一时刻至多一个进行中的轮次） */
interface ToolRoundState {
  id: string;
  chatId: string;
  /** 轮次中止器：轮次内所有批次随之中止 */
  controller: AbortController;
  /** 轮次内的批次（用于批量中断） */
  batches: Set<ToolBatchState>;
  /** 轮次相位：active 可写入上下文；closed 已销毁 */
  phase: 'active' | 'closed';
  /** 结算信号是否已推进（防重复 resolve；closeRound 与 settleBatchWhenDone 共用） */
  settledResolved: boolean;
  /** 轮次全部结算完成的信号 */
  resolveSettled: () => void;
  settledPromise: Promise<void>;
  /** 轮次内累计结算的调用数 */
  settledCalls: number;
}

// ==================== 引擎 ====================

export class ToolExecutionEngine {
  /** 全局 FIFO 队列（强制串行的唯一执行通道） */
  private queue: ToolJob[] = [];
  /** 队列是否正在排空（重入保护） */
  private draining = false;
  /** 会话 → 当前进行中的轮次（轮次 id 缓存） */
  private rounds = new Map<string, ToolRoundState>();
  /**
   * 内部调用（runSolo）的临时轮次（按轮次 id 索引）。
   *
   * 为什么单列一张表：临时轮次**不占**会话的「当前轮次」槽位——否则内部调用
   * 会取代并中止在途的模型工具批次。它们仍需登记，以便批次结算时能找回
   * 自己的轮次状态（在途批次计数、中止信号、结算信号）。
   */
  private soloRounds = new Map<string, ToolRoundState>();
  /** 轮次 id 自增序列 */
  private roundSeq = 0;

  /**
   * 引擎层定时器的注册与清理适配。
   *
   * 为什么是注入点：计时必须与调用方使用的时间基准一致（含测试的虚拟时钟，
   * 以及运行时对 Date.now / setTimeout 的任何替换）。默认走 globalThis，
   * 测试可注入同一套虚拟时钟，使引擎定时器与被测逻辑在同一个时间轴上推进。
   */
  private timers: {
    setTimeout: (callback: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
    clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
  } = {
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: handle => globalThis.clearTimeout(handle),
  };

  /** 仅测试可用：替换引擎的计时适配（生产代码不得调用） */
  setTimerAdapter(adapter: Partial<ToolExecutionEngine['timers']>): void {
    this.timers = { ...this.timers, ...adapter };
  }

  /**
   * 仅测试可用：恢复默认（真实时钟）计时适配。
   *
   * 必须存在的理由：引擎是**全局单例**，计时适配是它的可变状态——
   * 测试若注入虚拟时钟后不还原，后续任何用到引擎的代码都会继承那把假钟
   * （超时定时器不再按预期触发，表现为「调用永远不超时」）。
   * 测试应在自己的 finally 里调用本方法复位。
   */
  resetTimerAdapter(): void {
    this.timers = {
      setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimeout: handle => globalThis.clearTimeout(handle),
    };
  }

  // ── 轮次生命周期 ──

  /**
   * 开启一个**模型发起的**工具调用轮次，返回轮次 id。
   *
   * 一个会话同一时刻只承载一个模型工具轮次：新轮次取代旧轮次是引擎的显式
   * 语义（上下文里只允许存活的轮次写入结果）。
   *
   * 防御：若已存在未收尾的轮次（异常路径：上一轮未收尾就发起了新一轮），
   * 先中止并销毁旧轮次——旧轮次的结果此后一律不得写入上下文，其仍在执行的
   * 工具也一并强制中断（否则那份工作会继续跑到自然结束，页面副作用仍在发生）。
   *
   * **内部调用（截图 / 自动建笔记）不得走本方法**：它会让在途的模型轮次被
   * 取代。内部调用请用 `runSolo`，它开的是独立的临时轮次。
   */
  beginRound(chatId: string): string {
    const existing = this.rounds.get(chatId);
    if (existing) {
      console.warn(
        `[ToolExecutionEngine] 会话 ${chatId} 存在未收尾的工具轮次 ${existing.id}，已强制销毁`,
      );
      this.disposeRound(existing);
    }
    return this.createRound(chatId).id;
  }

  /** 销毁并中止一个轮次（中止在途工具 + 清缓存 + 推进结算信号） */
  private disposeRound(round: ToolRoundState): void {
    // 先中止再销毁：销毁只清缓存，不中止的话在途工具会继续跑到自然结束
    round.controller.abort();
    for (const batch of [...round.batches]) this.abortBatch(batch);
    this.closeRound(round.chatId, round.id);
  }

  /** 构造并登记一个新轮次（不做任何取代动作） */
  private createRound(chatId: string): ToolRoundState {
    this.roundSeq += 1;
    const id = `tr_${chatId}_${this.roundSeq}_${Date.now().toString(36)}`;
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>(resolve => {
      resolveSettled = resolve;
    });
    const round: ToolRoundState = {
      id,
      chatId,
      controller: new AbortController(),
      batches: new Set(),
      phase: 'active',
      settledResolved: false,
      resolveSettled,
      settledPromise,
      settledCalls: 0,
    };
    this.rounds.set(chatId, round);
    return round;
  }

  /**
   * 构造一个内部调用的临时轮次：登记在 soloRounds，不占会话的当前轮次槽位。
   *
   * 这样模型轮次（若在途）的轮次闸门、中断语义、结算账目完全不受内部调用影响，
   * 而内部调用自身仍能被批次结算正确对账。
   */
  private createSoloRound(chatId: string): ToolRoundState {
    this.roundSeq += 1;
    const id = `solo_${chatId}_${this.roundSeq}_${Date.now().toString(36)}`;
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>(resolve => {
      resolveSettled = resolve;
    });
    const round: ToolRoundState = {
      id,
      chatId,
      controller: new AbortController(),
      batches: new Set(),
      phase: 'active',
      settledResolved: false,
      resolveSettled,
      settledPromise,
      settledCalls: 0,
    };
    this.soloRounds.set(id, round);
    return round;
  }

  /**
   * 轮次是否仍是该会话的**当前**轮次（上下文写入的准入闸门）。
   *
   * 只有返回 true 的轮次，其工具结果才允许写入模型上下文——这是防止
   * 「上一轮的迟到结果插进新一轮上下文」的唯一闸门。
   */
  isRoundActive(chatId: string, roundId: string): boolean {
    const round = this.rounds.get(chatId);
    return !!round && round.id === roundId && round.phase !== 'closed';
  }

  /** 当前会话进行中的轮次 id（无则 null） */
  getActiveRoundId(chatId: string): string | null {
    const round = this.rounds.get(chatId);
    return round && round.phase !== 'closed' ? round.id : null;
  }

  /** 取该会话当前登记的轮次对象（无则 null） */
  private currentRound(chatId: string): ToolRoundState | null {
    const round = this.rounds.get(chatId);
    return round && round.phase !== 'closed' ? round : null;
  }

  /**
   * 轮次是否仍然有效（可执行 + 结果可写入上下文）。
   *
   * 兼容两类轮次：
   *   - 会话当前轮次：必须仍是该会话的**当前**轮次（轮次闸门的核心）；
   *   - 内部调用的临时轮次：只要求未被销毁（它本来就不占当前槽位）。
   */
  private roundAlive(chatId: string, roundId: string): boolean {
    const registered = this.rounds.get(chatId);
    if (registered && registered.id === roundId) return registered.phase !== 'closed';
    // 注意不能「有登记轮次就直接返回 false」——那会让同会话并存的内部调用
    // 临时轮次被误判为失效（内部调用与模型批次并存是常态）。
    const solo = this.soloRounds.get(roundId);
    return !!solo && solo.chatId === chatId && solo.phase !== 'closed';
  }

  /**
   * 销毁轮次：轮次 id 从缓存中移除，此后该轮次的结果一律不得写入上下文。
   *
   * 兼容两类轮次：会话的当前轮次（this.rounds）与内部调用的临时轮次
   * （this.soloRounds）——两者都必须可被正常销毁，否则临时轮次会泄漏。
   *
   * 幂等：重复销毁同一轮次是安全的空操作。
   */
  closeRound(chatId: string, roundId: string): void {
    const registered = this.rounds.get(chatId);
    if (registered && registered.id === roundId) {
      this.rounds.delete(chatId);
      this.markRoundClosed(registered);
      return;
    }
    const solo = this.soloRounds.get(roundId);
    if (solo && solo.chatId === chatId) {
      this.soloRounds.delete(roundId);
      this.markRoundClosed(solo);
    }
  }

  /** 标记轮次已销毁，并推进结算信号（幂等） */
  private markRoundClosed(round: ToolRoundState): void {
    round.phase = 'closed';
    // 保留 in-flight 批次集合不清理：批次结算后仍需从集合中移除并对账——
    // 提前清空会让「批次已结算」与「集合已空」错位，中断报告等不到轮次结算。
    // 只有**没有在途批次**时才推进结算信号：轮次被销毁 ≠ 轮次已结算。
    // 若仍有工具在跑（防御性替换路径），等批次真正结算后再推进——否则
    // 中断报告会宣称「已停下」，而工具其实还在执行。
    this.maybeSettleRound(round);
  }

  // ── 中止 ──

  /**
   * 强制中断某会话正在执行的全部工具（批次内批量中断）。
   *
   * 语义（同步中断的严格版本）：
   *   - 轮次中止器置位 → 轮次内所有批次的执行中调用立即结算为「中断」；
   *   - 批次内尚未开始的调用立即从队列摘除并结算为「中断」（不等队列排空）；
   *   - 返回的 Promise 在**本会话所有轮次调用全部结算完毕**后才 resolve——
   *     即便某个迟到的批次仍在执行，也必须等它结算。调用方据此确认
   *     「真的停了」，才允许放行用户的新消息（否则新消息会与迟到的工具
   *     结果交错，破坏上下文结构）。
   *
   * 上界由调用方负责（见 STOP_SETTLE_TIMEOUT_MS）：引擎自身不设等待上限，
   * 避免与「有界执行」的工具超时形成二义性。
   */
  async interrupt(chatId: string): Promise<ToolInterruptReport> {
    const round = this.rounds.get(chatId);
    if (!round || round.phase === 'closed') {
      return { chatId, interrupted: false, roundId: null, settledCalls: 0 };
    }
    round.controller.abort();
    // 同步摘除本会话所有在途批次并结算其中尚未开始的调用——
    // 这一步不 await，保证「中断」本身是同步生效的
    for (const batch of [...round.batches]) this.abortBatch(batch);
    this.armRoundIfIdle(round);
    await round.settledPromise;
    // 中止期间该会话可能换开了新轮次（上一轮收尾后立即开新轮次）：等待它结算，
    // 保证「该会话不存在仍在执行的工具」这一事实成立。
    // **不**中止新轮次——它属于用户新发起的运行，不在本次停止的范围内。
    const next = this.rounds.get(chatId);
    if (next && next !== round) {
      this.armRoundIfIdle(next);
      await next.settledPromise;
    }
    return {
      chatId,
      interrupted: true,
      roundId: round.id,
      settledCalls: round.settledCalls,
    };
  }

  // ── 批次执行 ──

  /**
   * 执行一批工具调用（严格串行）。
   *
   * 保证：
   *   - 返回的 outcomes 与 options.calls **一一对应且顺序一致**——
   *     协议配对（assistant.tool_calls ↔ tool 消息）的基础；
   *   - 任何路径（成功/失败/超时/中止/未执行）都有且仅有一个 outcome；
   *   - 工具抛出的不可控错误在引擎内被捕获并封装为失败结果，
   *     **绝不逸出引擎**——单个工具的失败不得以任何形式中断会话流程。
   */
  async runBatch(options: ToolBatchOptions): Promise<ToolBatchResult> {
    const { chatId, roundId, calls } = options;
    // 轮次解析：优先取「该会话的当前轮次」；否则取**已登记但已让位**的轮次
    // （runSolo 开的临时轮次不占当前槽位，但仍需能正常执行与结算）。
    const registered = this.rounds.get(chatId);
    const round = registered && registered.id === roundId
      ? registered
      : this.soloRounds.get(roundId);

    // 防御：空批次（无调用）立即返回——空批次没有可结算的调用，
    // 不得进入队列，否则批次信号永远不会被结算。
    if (calls.length === 0) {
      return { roundId, outcomes: [], anySuccess: false, anyFailure: false, interrupted: false };
    }

    // 轮次已失效（被中断/被销毁/从未登记）：全部调用立即以「跳过」结算。
    // 这条路径保证「每个 tool_call 都有配对的 tool 结果」，协议不因竞态而破裂。
    if (!round || round.phase === 'closed') {
      const outcomes = calls.map(call =>
        this.makeOutcome(roundId, call, 'skipped', TOOL_INTERRUPTED_BY_USER, 0),
      );
      return {
        roundId,
        outcomes,
        anySuccess: false,
        anyFailure: calls.length > 0,
        interrupted: true,
      };
    }

    const batch = this.createBatch(round, options);
    // 轮次已在批次创建期间被中断：全部调用就地跳过，绝不进队
    if (batch.interrupted) {
      return {
        roundId,
        outcomes: batch.outcomes,
        anySuccess: false,
        anyFailure: true,
        interrupted: true,
      };
    }
    for (const job of batch.jobs) this.enqueue(job);
    await batch.done;
    return {
      roundId,
      outcomes: batch.outcomes,
      anySuccess: batch.outcomes.some(o => o.status === 'success'),
      anyFailure: batch.outcomes.some(o => o.status === 'error'),
      interrupted: batch.interrupted,
    };
  }

  /**
   * 单独执行一个工具调用（走同一条全局队列与同一套超时/中断语义）。
   *
   * 用途：**引擎内部**发起的工具调用（如 vision 截图、发送前自动建笔记）——
   * 它们不是模型发起的 tool_call，因此不进模型上下文、不占「工具调用轮次」，
   * 但同样必须经队列串行：否则内部调用会与其它会话的工具并发操作同一个页面 /
   * 同一份存储。
   *
   * **隔离性是本方法的存在理由**（不要简化成复用 runBatch）：
   *   - 独立轮次：即便该会话正处于模型工具批次中，内部调用也另开一个临时轮次，
   *     用完即销毁。复用在途轮次会让「批次被中断」连带掐掉内部调用（截图因此
   *     失败），也会让内部调用的批次计入轮次结算账目。
   *   - 独立中止信号：只有 options.signal（通常是没有的）能中止它，
   *     模型运行的中止信号不会波及它。
   *   - 串行仍然成立：队列是全局的，与轮次划分无关。
   */
  async runSolo(options: {
    chatId: string;
    call: ToolCallPlan;
    timeoutMs: number;
    signal?: AbortSignal;
    execute: ToolCallExecutor;
    kill?: ToolCallKiller;
  }): Promise<ToolCallOutcome> {
    const { chatId, call, timeoutMs, execute, kill, signal } = options;
    // 独立的临时轮次：**不用 beginRound**（它会取代并中止在途的模型轮次）。
    // 临时轮次不进入 this.rounds 的「当前轮次」槽位，因此模型轮次的轮次闸门
    // 与中断语义完全不受影响；串行由全局队列保证，与轮次划分无关。
    const round = this.createSoloRound(chatId);
    try {
      const batch = await this.runBatch({
        chatId,
        roundId: round.id,
        calls: [call],
        timeoutMs,
        ...(signal ? { signal } : {}),
        execute,
        ...(kill ? { kill } : {}),
      });
      return (
        batch.outcomes[0] ??
        this.makeOutcome(round.id, call, 'failed', '工具执行未产生结果', 0)
      );
    } finally {
      this.closeRound(chatId, round.id);
    }
  }

  // ==================== 内部实现 ====================

  private createBatch(round: ToolRoundState, options: ToolBatchOptions): ToolBatchState {
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => {
      resolveDone = resolve;
    });
    const batch: ToolBatchState = {
      chatId: options.chatId,
      roundId: options.roundId,
      controller,
      jobs: [],
      interrupted: false,
      deadlineMs: options.deadlineMs,
      maxDurationMs: options.maxDurationMs,
      execute: options.execute,
      kill: options.kill,
      outcomes: [],
      resolveDone,
      done,
    };

    // 轮次中止 → 批次中止
    const onRoundAbort = () => this.abortBatch(batch);
    round.controller.signal.addEventListener('abort', onRoundAbort, { once: true });
    // 外部信号（运行中止 / 插件能力撤销）→ 批次中止
    const externalSignal = options.signal;
    const onExternalAbort = () => this.abortBatch(batch);
    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    options.calls.forEach((call, index) => {
      batch.jobs.push({
        batch,
        call,
        index,
        timeoutMs: resolveTimeout(options, call),
        settled: false,
        started: false,
      });
    });
    // 注册批次后才检查中止：调用必须先全部登记，中止才能一次性把它们全部
    // 结算为「中断」（先检查会留下无主的调用，批次信号永远等不到）
    round.batches.add(batch);
    if (round.controller.signal.aborted) this.abortBatch(batch);
    else if (externalSignal?.aborted) this.abortBatch(batch);
    this.settleBatchWhenDone(round, batch, () => {
      // 清理中止监听：批次的信号源是「整轮运行」级别的 AbortSignal，
      // 正常完成时它并不会触发 abort——监听器若不移除，会随轮次累积，
      // 最终触发 MaxListeners 告警并拖住内存。
      round.controller.signal.removeEventListener('abort', onRoundAbort);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    });
    return batch;
  }

  /** 批次全部结算后从轮次移除，并推进轮次结算信号 */
  private settleBatchWhenDone(
    round: ToolRoundState,
    batch: ToolBatchState,
    cleanup: () => void,
  ): void {
    void batch.done.then(() => {
      cleanup();
      round.batches.delete(batch);
      for (const job of batch.jobs) {
        if (job.settled) round.settledCalls += 1;
      }
      // 同步推进（不 await）：批次信号由本轮的微任务队列触发，而「等待轮次
      // 结算」的调用方（中断）恰好排在同一条链上——若在这里 await，就会出现
      // 「中断报告等排空循环、排空循环等中断报告」的活锁。
      this.maybeSettleRound(round);
    });
  }

  /**
   * 若轮次已无在途批次，推进其结算信号（幂等）。
   * 与 closeRound 共用同一把「结算闸门」，保证任何路径都只推进一次。
   */
  private maybeSettleRound(round: ToolRoundState): void {
    // 判定只看「有没有在途批次」：轮次是否已销毁（phase）不影响结算——
    // 被销毁的轮次若已无在途批次，它同样是「已结算」的。
    if (round.batches.size > 0) return;
    if (round.settledResolved) return;
    round.settledResolved = true;
    round.resolveSettled();
  }

  /**
   * 无在途批次的轮次立即视为「已结算」。
   *
   * 关键场景：批次尚未入队就收到中断时，轮次没有任何批次可等——若这里不
   * 主动推进，中断报告会永远悬挂，用户的停止流程也就永远无法结束。
   */
  private armRoundIfIdle(round: ToolRoundState): void {
    if (round.batches.size === 0) this.maybeSettleRound(round);
  }

  /** 批次中止：标记 + 立即结算尚未开始的调用（不等队列排空） */
  private abortBatch(batch: ToolBatchState): void {
    if (batch.interrupted) return;
    batch.interrupted = true;
    // 调用级中止必须**先于**下述结算：执行中的调用靠它立刻拿到「中断」，
    // 并据此触发强制终止钩子（先杀后结算，顺序不可颠倒）
    batch.controller.abort();
    for (const job of batch.jobs) {
      // 执行中的调用由中止竞争路径自行结算（它能拿到真实执行耗时，
      // 也知道工具是否真的响应了中止）；这里只结算**尚未开始**的调用——
      // 它们躺在队列里等，不会自己醒过来，必须就地收尾，否则批次永远等不到
      // 「全部调用已结算」，中断报告会永远悬挂。
      if (job.settled || job.started) continue;
      this.settleJob(
        job,
        this.makeOutcome(batch.roundId, job.call, 'interrupted', TOOL_INTERRUPTED_BY_USER, 0),
      );
    }
    // 全部调用都已结算（含执行中的那条由执行路径自行结算）→ 提前放行批次信号
    if (batch.jobs.every(job => job.settled)) batch.resolveDone();
  }

  /** 入队（全局 FIFO） */
  private enqueue(job: ToolJob): void {
    this.queue.push(job);
    this.drain();
  }

  /** 排空队列：任一时刻只有一个任务在执行（强制串行） */
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    void (async () => {
      try {
        while (this.queue.length > 0) {
          const job = this.queue.shift()!;
          if (job.settled) continue; // 中止时已就地结算
          await this.runJob(job);
        }
      } catch (error) {
        // 排空循环本身绝不能因单个任务异常而中断——否则整个队列永久卡死。
        console.error('[ToolExecutionEngine] 队列排空异常，已跳过该任务:', error);
      } finally {
        this.draining = false;
        // 重入防御：finally 期间可能有新任务入队（同步重入），补一次排空。
        if (this.queue.length > 0) this.drain();
      }
    })();
  }

  /** 执行单个任务并结算 */
  private async runJob(job: ToolJob): Promise<void> {
    job.started = true;
    const outcome = await this.executeJob(job);
    this.settleJob(job, outcome);
  }

  /**
   * 单次调用的执行与结算（核心）。
   *
   * 三条竞争路径：正常执行 / 中止 / 超时。任一先到即结算，
   * 引擎**绝不被工具的迟钝拖住**——这是「强制中断」与「有界执行」的落点。
   */
  private async executeJob(job: ToolJob): Promise<ToolCallOutcome> {
    const { batch, call } = job;
    const startedAt = Date.now();

    // 前置判定：已中止 / 轮次已失效 → 不执行
    if (batch.interrupted || !this.roundAlive(batch.chatId, batch.roundId)) {
      return this.makeOutcome(batch.roundId, call, 'interrupted', TOOL_INTERRUPTED_BY_USER, 0);
    }
    // 运行时长上限：排队期间已超预算 → 未开始执行
    if (batch.deadlineMs !== undefined && Date.now() > batch.deadlineMs) {
      return this.makeOutcome(
        batch.roundId,
        call,
        'deadline',
        deadlineMessage(call.toolName, batch.maxDurationMs ?? 0),
        0,
      );
    }

    const controller = new AbortController();
    const context: ToolCallContext = {
      signal: controller.signal,
      roundId: batch.roundId,
      chatId: batch.chatId,
    };

    // 批次中止 → 调用级中止（工具据此自行停止）
    const onBatchAbort = () => controller.abort();
    batch.controller.signal.addEventListener('abort', onBatchAbort, { once: true });
    if (batch.controller.signal.aborted) controller.abort();

    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let cleanup = () => {};

    // 执行 promise：工具抛出的任何不可控错误都在此被捕获，
    // 封装为失败结果——工具层错误在结构上无法中断会话流程。
    const execution: Promise<ToolCallOutcome> = (async () => {
      try {
        const result = await batch.execute(call, context);
        // 形态防御：缺陷实现可能返回 undefined / null / 字符串 / 数组——
        // 直接访问 .isError 会抛错，按成功判定则造成「空结果假成功」。
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          const shape = !result ? String(result) : Array.isArray(result) ? 'array' : typeof result;
          return this.makeOutcome(
            batch.roundId,
            call,
            'failed',
            `工具 ${call.toolName} 返回了非 ToolResult 形态的响应（类型: ${shape}），该工具存在实现缺陷，请反馈`,
            Date.now() - startedAt,
          );
        }
        const success = !result.isError && !result.error && result.success !== false;
        return this.makeOutcome(
          batch.roundId,
          call,
          success ? 'completed' : 'failed',
          success ? undefined : describeToolFailure(result) ?? '工具执行失败',
          Date.now() - startedAt,
          result,
          success ? 'success' : 'error',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.makeOutcome(
          batch.roundId,
          call,
          'failed',
          `工具 ${call.toolName} 执行异常: ${message}`,
          Date.now() - startedAt,
        );
      }
    })();

    // 中止路径：立即结算，并给工具一次硬杀机会
    const interrupted: Promise<ToolCallOutcome> = new Promise(resolve => {
      const onAbort = () => {
        controller.abort();
        resolve(
          this.makeOutcome(batch.roundId, call, 'interrupted', TOOL_INTERRUPTED_BY_USER, Date.now() - startedAt),
        );
      };
      if (batch.controller.signal.aborted) onAbort();
      else batch.controller.signal.addEventListener('abort', onAbort, { once: true });
      cleanup = () => batch.controller.signal.removeEventListener('abort', onAbort);
    });

    // 超时路径：有界执行。超时判定为失败，封装为标准 tool 结果回传模型。
    const timeoutText = this.timeoutMessage(call.toolName, job.timeoutMs);
    const timedOut: Promise<ToolCallOutcome> = new Promise(resolve => {
      timer = this.timers.setTimeout(() => {
        controller.abort();
        resolve(
          this.makeOutcome(batch.roundId, call, 'timeout', timeoutText, Date.now() - startedAt),
        );
      }, job.timeoutMs);
    });

    let winner: ToolCallOutcome;
    try {
      winner = await Promise.race([execution, interrupted, timedOut]);
    } finally {
      if (timer !== null) this.timers.clearTimeout(timer);
      batch.controller.signal.removeEventListener('abort', onBatchAbort);
      cleanup();
    }
    // 中止/超时后：底层工作可能仍在继续（工具是否真的停下取决于它是否响应
    // signal / 是否实现 kill 钩子），但**引擎不再等它**——这正是「强制中断」
    // 与「有界执行」的落点：引擎的等待方已经拿到结算结果，迟到结果一律丢弃。
    // 绝不在此 await 底层执行 promise：挂死的工具会把排空循环（乃至整个
    // 会话的工具通道）永久卡死，正是「强制中断」要杜绝的失败模式。
    if (winner.reason === 'interrupted' || winner.reason === 'timeout') {
      await this.invokeKill(batch, call, context);
    }
    // 说明：底层执行的迟到结果被丢弃——Promise.race 已经为 execution 挂了
    // 处理函数（它自身不会 reject：内部已兜底捕获），因此这里既不需要额外
    // 的兜底 catch，也不会产生未处理拒绝。
    return winner;
  }

  /**
   * 调用强制终止钩子（工具的硬杀能力）。
   * 钩子自身抛错或超时一律吞掉——终止钩子是清理手段，不是失败原因。
   */
  private async invokeKill(
    batch: ToolBatchState,
    call: ToolCallPlan,
    context: ToolCallContext,
  ): Promise<void> {
    if (!batch.kill) return;
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    try {
      // 走引擎的计时适配（与超时定时器同一时间基准）——
      // 否则测试的虚拟时钟与这里的真实时钟会互相打架
      const bounded = new Promise<void>(resolve => {
        timer = this.timers.setTimeout(resolve, KILL_HOOK_MAX_WAIT_MS);
      });
      try {
        await Promise.race([Promise.resolve(batch.kill(call, context)), bounded]);
      } finally {
        if (timer !== null) this.timers.clearTimeout(timer);
      }
    } catch (error) {
      console.warn(
        `[ToolExecutionEngine] 工具 ${call.toolName} 的强制终止钩子失败（已忽略）:`,
        error,
      );
    }
  }

  /**
   * 幂等结算。
   *
   * 每次结算都要推进批次信号的结算检查：批次可能在「所有调用都已结算」的
   * 那一刻正处于中止路径（此时 resolveDone 会被重复调用），也可能在正常路径
   * 上需要在最后一个调用结算时才放行——统一由这里收口，避免调用方漏推进。
   * resolveDone 幂等（Promise 只会 settle 一次），重复调用无害。
   */
  private settleJob(job: ToolJob, outcome: ToolCallOutcome): void {
    if (job.settled) return;
    job.settled = true;
    job.batch.outcomes[job.index] = outcome;
    if (job.batch.jobs.every(j => j.settled)) job.batch.resolveDone();
    // 轮次结算检查：批次可能在中止路径上提前结算（此时批次信号已放行，但
    // 轮次仍挂着「还有批次在途」的账）——必须在这里对账，否则中断报告会
    // 永远等不到轮次结算。resolveDone 幂等，重复放行无害。
    // 两类轮次都要对账：会话当前轮次（this.rounds）与内部调用的临时轮次
    // （this.soloRounds）——后者若不结算，runSolo 的 finally 与批次计数会错位。
    const registered = this.rounds.get(job.batch.chatId);
    if (registered && registered.id === job.batch.roundId) this.maybeSettleRound(registered);
    const solo = this.soloRounds.get(job.batch.roundId);
    if (solo) this.maybeSettleRound(solo);
  }

  /** 构造规范化结果 */
  private makeOutcome(
    roundId: string,
    call: ToolCallPlan,
    reason: ToolOutcomeReason,
    error: string | undefined,
    executionTimeMs: number,
    result?: ToolResult,
    status?: 'success' | 'error',
  ): ToolCallOutcome {
    // 状态与原因必须自洽：completed ⇔ success。调用方显式给出 status 时以它为准
    //（工具返回了 success:false 的失败结果时用 error）；未给出时按 reason 推导，
    // 并保证 completed 一定配 success——否则「原因说成功、状态说失败」会让
    // 模型与 UI 看到自相矛盾的结论。
    const resolvedStatus: 'success' | 'error' =
      status ?? (reason === 'completed' ? 'success' : 'error');
    const resolvedError =
      resolvedStatus === 'success' ? undefined : (error ?? '工具未返回可读结果');
    return {
      callId: call.callId,
      toolName: call.toolName,
      status: resolvedStatus,
      ...(result !== undefined ? { result } : {}),
      ...(resolvedError !== undefined ? { error: resolvedError } : {}),
      executionTimeMs,
      roundId,
      reason,
    };
  }

  /**
   * 超时文案：分钟数由实际生效的超时值换算（向上取整，最小 1 分钟）。
   * 文案面向模型：明确「没响应」的事实 + 「重新规划或调整参数」的行动指引。
   */
  private timeoutMessage(toolName: string, timeoutMs: number): string {
    const minutes = Math.max(MIN_REPORTED_MINUTES, Math.round(timeoutMs / 60_000));
    return `工具 ${toolName || '(未知工具)'} 超过 ${minutes}min 仍然未响应，请重新规划或调整工具参数重新调用`;
  }
}

// ==================== 共享判定 ====================

/**
 * 解析单工具的超时上界：优先用批次提供的按调用解析器，解析失败或非法一律
 * 回落到批次的统一上界——超时解析本身绝不能让调用失去上界。
 *
 * 统一上界本身也做防御：非法（NaN / Infinity / 非正数）时回落到引擎的
 * 兜底上界。**绝不能让上界变成 NaN**——setTimeout(fn, NaN) 等价于 0ms，
 * 会让每一次调用在执行的瞬间就判定超时（表现为「所有工具秒失败」）。
 */
function resolveTimeout(options: ToolBatchOptions, call: ToolCallPlan): number {
  const fallback = clampTimeout(options.timeoutMs);
  if (!options.timeoutFor) return fallback;
  try {
    return clampTimeout(options.timeoutFor(call));
  } catch {
    return fallback;
  }
}

/**
 * 钳制单工具上界：非有限数 / 非正数 → 兜底值；超过硬上限 → 收敛到硬上限
 * （setTimeout 的 32 位延时溢出会让「超长超时」变成「立即超时」）。
 */
function clampTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TOOL_TIMEOUT_MS;
  return Math.min(value, MAX_TOOL_TIMEOUT_MS);
}

/** 工具失败原因提取上限（字符）：错误摘要用于 UI 内联展示，过长截断 */
const TOOL_FAILURE_REASON_MAX_CHARS = 600;

/**
 * 从「结果形态」的失败 ToolResult 中提取可读原因（error / message / data.error / 首段文本）。
 * 单一事实源：引擎（判定成败）与会话引擎（渲染失败原因）共用同一口径。
 */
export function describeToolFailure(result: ToolResult): string | undefined {
  const truncate = (text: string): string =>
    text.length <= TOOL_FAILURE_REASON_MAX_CHARS
      ? text
      : `${text.slice(0, TOOL_FAILURE_REASON_MAX_CHARS)}…`;
  if (typeof result.error === 'string' && result.error) return truncate(result.error);
  if (typeof result.message === 'string' && result.message) return truncate(result.message);
  const dataError = (result.data as { error?: unknown; message?: unknown } | undefined)?.error;
  if (typeof dataError === 'string' && dataError) return truncate(dataError);
  const dataMessage = (result.data as { message?: unknown } | undefined)?.message;
  if (typeof dataMessage === 'string' && dataMessage) return truncate(dataMessage);
  const first = result.content?.[0];
  if (first && first.type === 'text' && typeof first.text === 'string' && first.text) {
    return truncate(first.text);
  }
  return undefined;
}

// ==================== 全局单例 ====================

/**
 * 全局唯一的工具执行引擎。
 *
 * 必须是单例：串行保证依赖「所有工具调用共用同一条队列」——
 * 多实例会让「强制串行」退化为「每个实例内部串行」，并发依旧存在。
 */
export const toolExecutionEngine = new ToolExecutionEngine();

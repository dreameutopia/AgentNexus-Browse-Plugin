/**
 * interact 询问弹窗状态机（单例排队 + 倒计时 + 悬浮球）
 *
 * 与 use-app-dialog 同一设计家族（单例状态 + FIFO 排队 + Promise 收敛），
 * 但生命周期更复杂，按产品决策实现三段式：
 *
 *   弹窗（dialog）→ 最小化（ball 悬浮球，边框为剩余时间进度环）→ 重新展开
 *
 * 收敛路径（四条，全部保证 Promise 不悬挂）：
 *   - 用户提交答复（点选项 / 自定义输入）→ { answered: true }
 *   - 用户明确拒绝（拒绝按钮）→ { answered: false, status: 'declined' }
 *   - 等待超时（默认 20 分钟，用户可在设置中调整；视为用户不在线）
 *     → { answered: false, status: 'timeout' }
 *   - 外部打断（用户停止任务 / 切换会话，由 App 层调用 dismissPendingInteracts）
 *     → { answered: false, status: 'dismissed' }（含排队中的全部询问）
 *
 * 防御性设计：
 *   - 单例排队：同一时刻最多一个询问在展示，后到者 FIFO 等待（引擎并行
 *     工具调用时模型可能一回合发多个 interact）；
 *   - 倒计时基于绝对截止时间（deadline - now），定时器漂移不影响精度；
 *   - 询问代数（generation）守卫：迟到的旧定时器回调凭代数失效，绝不错误
 *     收敛或污染下一个询问的剩余时间（定时器句柄层的极端竞态兜底）；
 *   - 定时器在每条收敛路径与 dismiss 时清理，绝不泄漏悬空句柄；
 *   - 超时时长读取应用设置并钳制到合法区间（边界常量来自 utils/channels
 *     的单一事实源），脏配置回落默认 20 分钟；
 *   - openInteract 对入参做最低限度防御（本模块是公共 API，不能假设调用方
 *     都经过工具层清洗）：非法请求立即按 dismissed 收敛并告警，不进队列。
 */

import { ref } from 'vue';
import type {
  InteractRequest,
  InteractResolution,
  InteractUnansweredStatus,
} from '@/tools/interact/interact-ui-bridge';
import {
  INTERACT_TIMEOUT_MIN_MINUTES,
  INTERACT_TIMEOUT_MAX_MINUTES,
  INTERACT_TIMEOUT_DEFAULT_MINUTES,
  appSettingsStore,
} from '../utils/channels';

/** 展示形态：dialog = 居中弹窗；ball = 右上角悬浮球（最小化） */
export type InteractPhase = 'dialog' | 'ball';

/** 弹窗运行时状态（InteractDialog.vue 的唯一数据源） */
export interface InteractDialogState {
  /** 是否有询问在展示（弹窗或悬浮球形态） */
  visible: boolean;
  /** 当前形态 */
  phase: InteractPhase;
  /** 当前询问（工具层已清洗；null = 无展示） */
  request: InteractRequest | null;
  /** 本次询问的总等待时长（毫秒，用于进度环；0 = 无展示占位） */
  totalMs: number;
  /** 剩余等待时长（毫秒，每 500ms 刷新） */
  remainingMs: number;
}

const state = ref<InteractDialogState>({
  visible: false,
  phase: 'dialog',
  request: null,
  totalMs: 0,
  remainingMs: 0,
});

/** 排队中的询问（当前展示之外的；含 resolve 以便整体打断时逐个收敛） */
interface QueuedInteract {
  request: InteractRequest;
  resolve: (resolution: InteractResolution) => void;
}
const queue: QueuedInteract[] = [];

/** 当前询问的收敛器与截止时间 */
let pendingResolve: ((resolution: InteractResolution) => void) | null = null;
let deadlineMs = 0;
let countdownTimer: number | null = null;
/** 询问代数：每次开始展示新询问自增；旧代数的迟到回调凭此失效 */
let generation = 0;

/** 倒计时刷新间隔（毫秒）：进度环按剩余比例插值，500ms 足够平滑 */
const TICK_MS = 500;

/**
 * 读取用户配置的等待时长（分钟 → 毫秒）。
 * 非数字 / 非有限数回落默认值；越界与浮点分钟钳制收敛（配置侧校验之外的
 * 第二道防线，脏存储直接进入运行时也不会产生 0 或负数等待）。
 */
function resolveWaitMs(): number {
  const raw = appSettingsStore.getInteractTimeoutMinutes();
  const minutes =
    typeof raw === 'number' && Number.isFinite(raw)
      ? Math.min(
          INTERACT_TIMEOUT_MAX_MINUTES,
          Math.max(INTERACT_TIMEOUT_MIN_MINUTES, Math.floor(raw)),
        )
      : INTERACT_TIMEOUT_DEFAULT_MINUTES;
  return minutes * 60 * 1000;
}

/** 停止倒计时（幂等；各收敛路径统一调用，防悬空句柄） */
function stopCountdown(): void {
  if (countdownTimer !== null) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

/** 收敛当前询问（内部唯一出口）：resolve → 清态 → 驱动队列 */
function settleCurrent(resolution: InteractResolution): void {
  stopCountdown();
  // 代数推进：本询问的所有迟到回调（含已在事件队列中的极端情形）此后全部失效
  generation++;
  const resolve = pendingResolve;
  pendingResolve = null;
  state.value = {
    ...state.value,
    visible: false,
    phase: 'dialog',
    request: null,
  };
  resolve?.(resolution);
  pumpQueue();
}

/** 从队列取出下一个询问并开始展示（队列空则保持空闲态） */
function pumpQueue(): void {
  if (state.value.visible || pendingResolve !== null) return;
  const next = queue.shift();
  if (!next) return;

  const waitMs = resolveWaitMs();
  const currentGeneration = ++generation;
  deadlineMs = Date.now() + waitMs;
  pendingResolve = next.resolve;
  state.value = {
    visible: true,
    phase: 'dialog',
    request: next.request,
    totalMs: waitMs,
    remainingMs: waitMs,
  };

  stopCountdown();
  countdownTimer = window.setInterval(() => {
    // 代数守卫：回调所属询问已被收敛 / 被新询问替代时直接退出。
    // 注意：此处绝不能触碰共享的 countdownTimer 句柄——它此刻属于新询问，
    // 旧回调一旦清理会误杀新询问的倒计时（进度冻结且永不超时）；
    // 旧定时器本身已在收敛路径被 clearInterval，残留的迟到回调静默作废即可
    if (currentGeneration !== generation) {
      return;
    }
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      // 超时：视为用户不在线未能及时响应
      settleCurrent({ answered: false, status: 'timeout' });
      return;
    }
    state.value = { ...state.value, remainingMs: remaining };
  }, TICK_MS);
}

/**
 * 打开询问并等待用户操作（interact 工具经 UI 桥接调用）。
 * 已有询问展示时进入 FIFO 队列，前一个收敛后自动弹出。
 * 入参最低防御：非对象或缺少 question 的请求立即按 dismissed 收敛并告警
 * （不进队列、不展示，调用方 Promise 不悬挂）。
 */
export function openInteract(request: InteractRequest): Promise<InteractResolution> {
  return new Promise(resolve => {
    if (
      request === null ||
      typeof request !== 'object' ||
      typeof request.question !== 'string' ||
      !request.question.trim()
    ) {
      console.warn('[use-interact] 收到非法询问请求，已按 dismissed 收敛:', request);
      resolve({ answered: false, status: 'dismissed' satisfies InteractUnansweredStatus });
      return;
    }
    queue.push({ request, resolve });
    pumpQueue();
  });
}

/** 用户提交答复（点选选项或自定义输入）；空答复与无展示时为安全空操作 */
export function submitInteractAnswer(answer: string, source: 'option' | 'custom'): void {
  const text = typeof answer === 'string' ? answer.trim() : '';
  if (!pendingResolve || !text) return;
  settleCurrent({ answered: true, answer: text, source });
}

/** 用户明确拒绝回答（区别于最小化与超时） */
export function declineInteract(): void {
  if (!pendingResolve) return;
  settleCurrent({ answered: false, status: 'declined' });
}

/** 最小化：弹窗 → 右上角悬浮球（询问继续计时，可重新展开） */
export function minimizeInteract(): void {
  if (!state.value.visible) return;
  state.value = { ...state.value, phase: 'ball' };
}

/** 重新展开：悬浮球 → 弹窗 */
export function reopenInteract(): void {
  if (!state.value.visible) return;
  state.value = { ...state.value, phase: 'dialog' };
}

/**
 * 外部整体打断（用户停止任务 / 切换会话时由 App 层调用）：
 * 当前询问与排队中的全部询问一律按 dismissed 收敛，队列清空。
 * 幂等：无展示且无排队时不产生任何副作用。
 */
export function dismissPendingInteracts(): void {
  // 先清队列再收敛当前，避免 settleCurrent 内 pumpQueue 取到刚清空的队列外的旧引用
  const queued = queue.splice(0, queue.length);
  for (const item of queued) {
    try {
      item.resolve({ answered: false, status: 'dismissed' satisfies InteractUnansweredStatus });
    } catch (error) {
      console.warn('[use-interact] 收敛排队询问时异常:', error);
    }
  }
  if (pendingResolve !== null) {
    settleCurrent({ answered: false, status: 'dismissed' });
  }
}

/** 弹窗状态（InteractDialog.vue 挂载读取；对外只读消费，写入只经本模块函数） */
export function useInteractDialog() {
  return state;
}

/**
 * 应用级轻量弹窗（Promise 化 alert / confirm）
 *
 * 动机：附件上传链路需要多条异步交互提示（超限拒绝 / 自动裁剪确认 /
 * 内嵌图片确认 / 模型能力提示），window.alert/confirm 是同步模态——
 * 打开期间整个 sidepanel JS 线程冻结（与守卫确认条取代 window.confirm
 * 的理由一致），且样式不可控。本 composable 提供单例弹窗状态：
 *
 *   const ok = await showAlert('...');            // 单按钮，恒 true
 *   const ok = await showConfirm('...', '标题');   // 双按钮，确认 true / 取消 false
 *
 * 设计约定：
 *   - 单例排队：同一时刻只显示一个弹窗，后到的请求等待前一个关闭
 *     （链路内多次 await 不会叠弹窗）；
 *   - 关闭即 resolve：确认/取消/点击遮罩（仅 alert）都会收敛，绝不悬挂 Promise；
 *   - 状态极简（title/message/type/resolve），展示全部交给 AppDialog.vue；
 *   - 跨模块定向收敛：每次打开分配单调递增 id，openDialogWithHandle 返回
 *     { id, result }，settleDialogById(id, ok) 可在不经过用户操作的情况下
 *     收敛指定弹窗（如「停止任务」时关闭悬挂的工具审批弹窗）。id 在排队
 *     期间即已确定，调用方无需关心弹窗是否已展示。
 */

import { ref } from 'vue';
import { t } from '@/utils/i18n';

/** 弹窗形态：单按钮（告知）或双按钮（确认） */
export type AppDialogMode = 'alert' | 'confirm';

export interface AppDialogOptions {
  /** 正文（支持 \n 换行） */
  message: string;
  /** 标题（缺省按形态取通用标题） */
  title?: string;
  /** 形态：alert = 单「知道了」按钮；confirm = 取消/确认双按钮 */
  mode?: AppDialogMode;
  /** 语义图标：info（蓝）/ warn（橙）/ error（红），缺省 info */
  tone?: 'info' | 'warn' | 'error';
  /** confirm 形态主按钮文案（缺省通用「确认」） */
  confirmText?: string;
  /** confirm 形态次按钮文案（缺省通用「取消」） */
  cancelText?: string;
}

/** 弹窗句柄：id 供跨模块定向收敛，result 为用户操作结果 */
export interface AppDialogHandle {
  /** 弹窗 id（调用时即确定；排队中的弹窗同样持有稳定 id） */
  id: number;
  /** 用户操作结果（确认 true；取消 / 遮罩 / 定向收敛按传入值） */
  result: Promise<boolean>;
}

/** 对话框运行时状态（AppDialog.vue 的全部数据源） */
export interface AppDialogState extends Required<Omit<AppDialogOptions, 'title'>> {
  title: string;
  visible: boolean;
  /** 弹窗 id（打开时分配；settleDialogById 定向收敛用，模板不消费） */
  id: number;
}

const state = ref<AppDialogState>({
  title: '',
  message: '',
  mode: 'alert',
  tone: 'info',
  confirmText: '',
  cancelText: '',
  visible: false,
  id: 0,
});

/** 排队中的下一个请求（单例：同一时刻只显示一个弹窗） */
const queue: Array<() => void> = [];
/** 当前弹窗的收敛器（确认 → true；取消/遮罩 → false） */
let pendingResolve: ((ok: boolean) => void) | null = null;
/** 弹窗 id 序号（单调递增；跨模块定向收敛的定位键） */
let dialogSeq = 0;
/** 当前展示中弹窗的 id（0 = 无；与 state.visible 同步维护） */
let visibleDialogId = 0;

/** 前一个弹窗关闭后启动排队中的下一个（保持 FIFO） */
function pumpQueue() {
  const next = queue.shift();
  if (next) next();
}

/**
 * 打开弹窗并返回句柄（id + 结果 Promise）。
 * 已有弹窗显示时进入 FIFO 队列，前一个关闭后自动弹出；
 * id 在调用时即分配——排队中的弹窗同样可被 settleDialogById 预定收敛
 * （展示时发现已被收敛则直接跳过并放行队列，见 show 内的 visible 检查）。
 */
export function openDialogWithHandle(options: AppDialogOptions): AppDialogHandle {
  const id = ++dialogSeq;
  const result = new Promise<boolean>(resolve => {
    /** 本弹窗是否已被定向收敛（收敛发生在展示前时，跳过展示直接放行队列） */
    let settledBeforeShow = false;
    const show = () => {
      if (settledBeforeShow) {
        pumpQueue();
        return;
      }
      state.value = {
        title: options.title ?? t(options.mode === 'confirm' ? 'common.confirm' : 'common.notice'),
        message: options.message,
        mode: options.mode ?? 'alert',
        tone: options.tone ?? 'info',
        // 按钮文案在打开时解析（跟随当前语言；alert 主按钮回落「知道了」，
        // confirm 双按钮回落通用「确认 / 取消」，alert 不使用 cancelText）
        confirmText:
          options.confirmText ??
          t(options.mode === 'confirm' ? 'common.confirm' : 'common.noticeConfirm'),
        cancelText: options.cancelText ?? t('common.cancel'),
        visible: true,
        id,
      };
      visibleDialogId = id;
      pendingResolve = resolve;
    };
    if (state.value.visible) queue.push(show);
    else show();
    // 定向收敛注册：即使弹窗仍在队列中也能标记收敛（展示时跳过）
    settledDialogIds.set(id, (ok: boolean) => {
      settledBeforeShow = true;
      resolve(ok);
    });
  });
  return { id, result };
}

/** id → 定向收敛器（打开时注册，任何路径关闭时清除；防悬挂注册泄漏） */
const settledDialogIds = new Map<number, (ok: boolean) => void>();

/**
 * 打开弹窗并等待用户操作。
 * 已有弹窗显示时进入 FIFO 队列，前一个关闭后自动弹出。
 */
function open(options: AppDialogOptions): Promise<boolean> {
  return openDialogWithHandle(options).result;
}

/** 单按钮告知弹窗（点击按钮或遮罩关闭，恒 resolve(true)） */
export function showAlert(message: string, title?: string, tone?: AppDialogOptions['tone']): Promise<boolean> {
  return open({ message, title, mode: 'alert', tone });
}

/** 双按钮确认弹窗的按钮文案定制（缺省回落通用「确认 / 取消」） */
export interface AppDialogActions {
  confirmText?: string;
  cancelText?: string;
}

/** 双按钮确认弹窗（确认 resolve(true)；取消/遮罩 resolve(false)）；按钮文案可定制 */
export function showConfirm(
  message: string,
  title?: string,
  tone?: AppDialogOptions['tone'],
  actions?: AppDialogActions,
): Promise<boolean> {
  return open({ message, title, mode: 'confirm', tone, ...actions });
}

/** AppDialog.vue 专用：用户点击按钮（ok = 确认/知道了） */
export function settleAppDialog(ok: boolean): void {
  if (!state.value.visible) return;
  const closedId = state.value.id;
  state.value = { ...state.value, visible: false };
  visibleDialogId = 0;
  // 防御：pendingResolve 缺失（异常路径下弹窗被外部关闭）时也要放行队列，
  // 否则后续弹窗会被永久卡死
  const resolve = pendingResolve;
  pendingResolve = null;
  settledDialogIds.delete(closedId);
  resolve?.(ok);
  pumpQueue();
}

/**
 * 按弹窗 id 定向收敛（跨模块强制关闭通道）。
 * 覆盖三种状态：展示中（走正常收敛流程，界面同步关闭）；排队中（标记
 * 跳过，轮到它时不再展示并放行后续队列）；已关闭/不存在（幂等 no-op）。
 * 返回是否执行了收敛（调用方可据此决定是否需要补充反馈）。
 */
export function settleDialogById(id: number, ok: boolean): boolean {
  // 展示中且 id 匹配：走统一收敛（包含队列放行与注册清理）
  if (state.value.visible && visibleDialogId === id) {
    settleAppDialog(ok);
    return true;
  }
  // 排队中：标记跳过 + 直接 resolve（Promise 只会结算一次，后到的
  // 正常展示路径再 resolve 是无害的空操作）
  const settleQueued = settledDialogIds.get(id);
  if (settleQueued) {
    settledDialogIds.delete(id);
    settleQueued(ok);
    return true;
  }
  return false;
}

/** 弹窗状态（AppDialog.vue 挂载读取；对外只读消费，写入只经本模块函数） */
export function useAppDialog() {
  return state;
}

/**
 * API 错误卡片「重试」按钮（document 级事件委托 + 应用层回调注册）
 *
 * 错误卡片由 markdown-renderer 经 v-html 注入，无法走 Vue 事件；与
 * code-copy.ts / api-error-model.ts 同构，统一走事件委托（扩展页 CSP 为
 * `script-src 'self'`，内联 onclick 会被浏览器直接拦截）。
 *
 * 分工：
 *   - 渲染层（本模块）：只负责识别点击并转发，不携带任何会话状态；
 *   - 应用层（App.vue 注册回调）：决定重试语义与全部守卫——重试 =
 *     以当前输入（失败后通常为空 → 引擎空输入续跑）重走发送流程，
 *     引擎以失败前的完整历史继续会话（finalize 已写入失败状态说明）。
 *
 * 回调异常在这里兜底捕获：点击重试永不因回调缺陷抛出未处理拒绝。
 */

/** 应用层重试回调（无参数：消息列表恒为当前会话视图，可见卡片必属当前
 *  会话上下文，无需按卡片定位归属——见 App.vue 注册处的说明） */
type ApiErrorRetryHandler = () => void;

let retryHandler: ApiErrorRetryHandler | null = null;
let handlerInstalled = false;

/** 注册/注销应用层重试回调（App.vue 挂载时注册；传 null 注销） */
export function setApiErrorRetryHandler(handler: ApiErrorRetryHandler | null): void {
  retryHandler = handler;
}

/** 安装 document 级重试委托（幂等；仅 DOM 上下文生效） */
export function installApiErrorRetryHandler(): void {
  if (handlerInstalled || typeof document === 'undefined') return;
  handlerInstalled = true;

  document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest?.('.api-error-retry-btn') as HTMLElement | null;
    if (!button) return;
    event.preventDefault();
    if (!retryHandler) return;
    try {
      retryHandler();
    } catch (error) {
      console.warn('[ApiErrorRetry] 重试回调异常:', error);
    }
  });
}

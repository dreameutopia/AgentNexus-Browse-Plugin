/**
 * API 错误卡片「请求模型」浮层（document 级事件委托）
 *
 * 卡片顶栏右侧原先平铺「协议 / 模型 / 端点」三段文本：长端点 URL 会把顶栏
 * 撑开、把状态徽章与操作按钮挤到换行（窄侧边栏尤其明显）。现改为单个
 * 「请求模型」按钮，点开浮层卡展示三项定位信息。
 *
 * 为什么不用内联 onclick：
 *   扩展页 CSP 为 `script-src 'self'`（不含 'unsafe-inline'），浏览器会直接
 *   拦截 HTML 属性里的内联事件处理器——写上去的 onclick 永远不会被触发。
 *   与 code-copy.ts / file-card 的委托同构，统一走事件委托，既符合 CSP 又避免重复绑定。
 *
 * 浮层内容由渲染器（markdown-renderer 的 buildRequestModelBlock）预先输出在 DOM 中，
 * 本模块只负责显隐与焦点管理：没有动态 HTML 注入，也就没有 XSS 面。
 *
 * 交互约定：
 *   - 点击按钮：开/关浮层；同时只允许一个浮层展开（打开新的会收起旧的）；
 *   - 点击浮层之外：收起全部；
 *   - Esc：收起全部并把焦点交还触发按钮。
 */

/** 展开态标记类（与 CSS 的 .api-error-model.is-open 对应） */
const OPEN_CLASS = 'is-open';

/** 取触发器所在的浮层容器 */
function wrapperOf(target: EventTarget | null): HTMLElement | null {
  const element = target as HTMLElement | null;
  return (element?.closest?.('.api-error-model') as HTMLElement | null) ?? null;
}

/** 取容器内的浮层面板 */
function panelOf(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>('.api-error-model-panel');
}

/** 设置展开态（同步 class / aria-expanded / hidden 三处，避免状态漂移） */
function setOpen(wrapper: HTMLElement, open: boolean): void {
  const button = wrapper.querySelector<HTMLElement>('.api-error-model-btn');
  const panel = panelOf(wrapper);
  wrapper.classList.toggle(OPEN_CLASS, open);
  button?.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (panel) panel.hidden = !open;
}

/** 当前展开的浮层容器 */
function openWrappers(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`.api-error-model.${OPEN_CLASS}`));
}

/** 收起全部浮层（可排除某个容器——它正在被打开） */
function closeAll(except?: HTMLElement): void {
  openWrappers().forEach(wrapper => {
    if (wrapper !== except) setOpen(wrapper, false);
  });
}

let handlerInstalled = false;

/** 安装 document 级浮层委托（幂等；仅 DOM 上下文生效） */
export function installApiErrorModelHandler(): void {
  if (handlerInstalled || typeof document === 'undefined') return;
  handlerInstalled = true;

  document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest?.('.api-error-model-btn') as HTMLElement | null;

    if (button) {
      event.preventDefault();
      const wrapper = wrapperOf(button);
      if (!wrapper) return;
      const willOpen = !wrapper.classList.contains(OPEN_CLASS);
      // 同时只展开一个浮层
      closeAll(wrapper);
      setOpen(wrapper, willOpen);
      return;
    }

    // 浮层内部点击（含选中复制端点 URL）不应收起浮层
    if (target?.closest?.('.api-error-model-panel')) return;
    closeAll();
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const opened = openWrappers();
    if (!opened.length) return;
    opened.forEach(wrapper => setOpen(wrapper, false));
    // 焦点回到触发按钮，便于键盘用户继续操作
    opened[0]?.querySelector<HTMLElement>('.api-error-model-btn')?.focus();
  });
}

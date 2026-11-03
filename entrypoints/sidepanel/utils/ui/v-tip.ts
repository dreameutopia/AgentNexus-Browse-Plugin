/**
 * 自定义 tooltip 指令（v-tip）
 *
 * 取代原生 title 属性的动机：
 *   - 原生 title 悬停约 1 秒后才出现且无法调节，无法满足「覆盖解释框
 *     即时出现」的交互预期；
 *   - 原生样式不可定制（系统字体、纯黑底），与应用视觉风格割裂。
 *
 * 实现（单例共享浮层，零依赖）：
 *   - 全局唯一一个 tooltip 元素挂在 body 下，mouseenter/focusin 时定位
 *     到宿主元素上方（顶部空间不足自动翻转到下方），mouseleave/focusout
 *     即刻隐藏；
 *   - 出现延迟 100ms：过滤快速掠过（扫过按钮组寻找目标）时的视觉噪音，
 *     停留意图明确时接近即时（原生约 1000ms）；
 *   - 宿主设置 aria-label 补偿可访问性（移除 title 后屏幕阅读器仍有文本）；
 *   - 指令值支持动态更新（updated 钩子），如发送/停止按钮的语义切换。
 *
 * 用法：<button v-tip="t('sidepanel.app.xxx')" …>（替代 :title）
 */

import type { Directive } from 'vue';

/** 出现延迟（毫秒）：过滤掠过噪音，同时保持「即时」体感 */
const SHOW_DELAY_MS = 100;
/** 浮层与宿主的间距（像素） */
const GAP_PX = 8;
/** 浮层距视口边缘的最小留白（像素） */
const VIEWPORT_MARGIN_PX = 6;

/** 宿主元素上的挂载状态 */
interface TipHostState {
  text: string;
  onEnter: () => void;
  onLeave: () => void;
}

const hostStates = new WeakMap<HTMLElement, TipHostState>();

let tipEl: HTMLElement | null = null;
let showTimer: number | undefined;
/** 当前展示中的宿主（隐藏时校验，避免快速切换时的错乱） */
let activeHost: HTMLElement | null = null;

/** 惰性创建共享浮层（首次使用时） */
const ensureTipElement = (): HTMLElement => {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'app-tooltip';
  tipEl.setAttribute('role', 'tooltip');
  tipEl.style.display = 'none';
  document.body.appendChild(tipEl);
  return tipEl;
};

/** 按宿主几何位置定位浮层：默认上方居中，顶部空间不足翻转到下方 */
const positionTip = (host: HTMLElement, tip: HTMLElement): void => {
  const rect = host.getBoundingClientRect();
  tip.style.visibility = 'hidden';
  tip.style.display = 'block';

  const tipWidth = tip.offsetWidth;
  const tipHeight = tip.offsetHeight;

  // 水平：居中并钳制在视口内
  let left = rect.left + rect.width / 2 - tipWidth / 2;
  left = Math.min(Math.max(left, VIEWPORT_MARGIN_PX), window.innerWidth - tipWidth - VIEWPORT_MARGIN_PX);

  // 垂直：优先上方；顶部放不下放下方；两处都放不下（视口过矮）退化为贴顶
  let top = rect.top - tipHeight - GAP_PX;
  if (top < VIEWPORT_MARGIN_PX) {
    const below = rect.bottom + GAP_PX;
    top = below + tipHeight > window.innerHeight - VIEWPORT_MARGIN_PX ? VIEWPORT_MARGIN_PX : below;
  }

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.style.visibility = 'visible';
};

const showTip = (host: HTMLElement, text: string): void => {
  const tip = ensureTipElement();
  tip.textContent = text;
  positionTip(host, tip);
  tip.classList.add('is-visible');
};

const hideTip = (): void => {
  window.clearTimeout(showTimer);
  showTimer = undefined;
  if (tipEl) {
    tipEl.classList.remove('is-visible');
    tipEl.style.display = 'none';
  }
  activeHost = null;
};

/** 在宿主元素上注册 tooltip 监听（mounted 与 updated 补注册共用） */
const setupTipHost = (el: HTMLElement, text: string): void => {
  // 可访问性补偿：移除 title 后屏幕阅读器仍有可读文本
  el.setAttribute('aria-label', text);

  const onEnter = (): void => {
    const state = hostStates.get(el);
    if (!state?.text) return;
    hideTip();
    activeHost = el;
    showTimer = window.setTimeout(() => {
      if (activeHost === el) showTip(el, state.text);
    }, SHOW_DELAY_MS);
  };
  const onLeave = (): void => {
    if (activeHost === el) hideTip();
    else window.clearTimeout(showTimer);
  };

  el.addEventListener('mouseenter', onEnter);
  el.addEventListener('mouseleave', onLeave);
  el.addEventListener('focusin', onEnter);
  el.addEventListener('focusout', onLeave);
  hostStates.set(el, { text, onEnter, onLeave });
};

export const vTip: Directive<HTMLElement, string | undefined> = {
  mounted(el, binding) {
    const text = binding.value;
    if (!text) return;
    setupTipHost(el, text);
  },

  updated(el, binding) {
    const state = hostStates.get(el);
    // 文本更新：同步状态与 aria-label；正在展示中则立即刷新浮层内容
    if (state) {
      state.text = binding.value ?? '';
      if (binding.value) el.setAttribute('aria-label', binding.value);
      else el.removeAttribute('aria-label');
      if (activeHost === el && tipEl) {
        if (state.text) tipEl.textContent = state.text;
        else hideTip();
      }
      return;
    }
    // mounted 时值为空（未注册监听），后续更新出值 → 补注册
    if (binding.value) setupTipHost(el, binding.value);
  },

  unmounted(el) {
    const state = hostStates.get(el);
    if (!state) return;
    el.removeEventListener('mouseenter', state.onEnter);
    el.removeEventListener('mouseleave', state.onLeave);
    el.removeEventListener('focusin', state.onEnter);
    el.removeEventListener('focusout', state.onLeave);
    hostStates.delete(el);
    if (activeHost === el) hideTip();
  },
};

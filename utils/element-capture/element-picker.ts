/**
 * 页面内元素捕获器（内容脚本侧，运行于每个 frame）
 *
 * 职责：
 *   - 页面遮罩外的红色高亮框（鼠标命中元素即框选，右键完全不拦截）；
 *   - Ctrl/⌘ + 左键确认元素 → 高亮闪烁并浮出「确认 / 取消」操作条；
 *   - 确认后调用选择器引擎生成唯一选择器并二次校验，截取元素完整截图；
 *   - 通过消息协议把结果上报侧边栏（frameId 由侧边栏从 sender 中补写）。
 *
 * 稳定性约定：
 *   - 所有 DOM 操作均放在 try/catch 中，失败通过 FAILED 消息上报，不阻断页面；
 *   - 不修改页面元素属性 / 样式，仅追加一个独立 root 节点并在退出时彻底移除；
 *   - 截图前隐藏捕获 UI，截完恢复页面滚动位置与捕获 UI。
 */

import {
  buildElementSelector,
  captureElementDescriptor,
  deepElementFromPoint,
  isVisibleElement,
  resolveElementBySelector,
} from './selector-engine';
import {
  ELEMENT_CAPTURE_MESSAGE,
  type ElementCaptureHighlightRequest,
  type ElementCaptureHighlightResponse,
  type ElementCaptureVerifyRequest,
  type ElementCaptureVerifyResponse,
} from './protocol';

const ROOT_ID = 'anx-element-capture-root';
const STYLE_ID = 'anx-element-capture-style';
const UI_DATA_ATTR = 'data-anx-capture-ui';
/** 校验高亮使用独立根节点：不进入捕获状态、不干扰捕获 UI */
const VERIFY_ROOT_ID = 'anx-element-verify-root';
const VERIFY_STYLE_ID = 'anx-element-verify-style';
const VERIFY_DATA_ATTR = 'data-anx-verify-ui';
const VERIFY_DEFAULT_DURATION_MS = 3000;
const VERIFY_MAX_DURATION_MS = 10_000;
// 版本化安装标记：扩展更新后，旧内容脚本留下的同名标记会让补注入变成空操作
// （旧实例的 chrome.runtime 已失效，无法响应新消息）。带版本号可确保新捕获器
// 一定完成安装；旧实例此时已收不到消息、也不会进入捕获态，不会产生重复 UI。
const INSTALL_FLAG = '__ANX_ELEMENT_CAPTURE_INSTALLED_V2__';
const OFFSET_TOKEN = '__anxFrameOffset';
const MAX_TILES_X = 3;
const MAX_TILES_Y = 4;
const MAX_SCREENSHOT_WIDTH = 900;
const MAX_SCREENSHOT_HEIGHT = 1400;

type PickerState = 'idle' | 'picking' | 'confirmed';

interface FrameOffset {
  x: number;
  y: number;
}

let installed = false;
let state: PickerState = 'idle';
let hoveredElement: Element | null = null;
let selectedElement: Element | null = null;
let uiRoot: HTMLElement | null = null;
let highlightBox: HTMLElement | null = null;
let highlightLabel: HTMLElement | null = null;
let confirmBar: HTMLElement | null = null;
let uiFrameId: number | null = null;
let captureInFlight = false;
let rafId = 0;
const pendingOffsetRequests = new Map<
  string,
  (offset: FrameOffset | null) => void
>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function randomToken(): string {
  return `anx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isHostUiTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(`[${UI_DATA_ATTR}]`);
}

/* -------------------------------------------------------------------------- */
/* 帧偏移桥：让子 frame 知道自己在顶层视口中的位置（用于跨 iframe 截图裁剪）       */
/* -------------------------------------------------------------------------- */

async function resolveFrameOffset(): Promise<FrameOffset> {
  if (window.top === window) return { x: 0, y: 0 };
  const parentWindow = window.parent;
  if (!parentWindow || parentWindow === window) return { x: 0, y: 0 };

  return new Promise<FrameOffset>((resolve) => {
    const requestId = randomToken();
    let settled = false;
    const finish = (offset: FrameOffset | null) => {
      if (settled) return;
      settled = true;
      pendingOffsetRequests.delete(requestId);
      resolve(offset || { x: 0, y: 0 });
    };

    pendingOffsetRequests.set(requestId, finish);
    window.setTimeout(() => finish(null), 500);

    try {
      parentWindow.postMessage({ [OFFSET_TOKEN]: 'request', requestId }, '*');
    } catch {
      finish(null);
    }
  });
}

function installFrameOffsetBridge(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as
      | { [OFFSET_TOKEN]?: string; requestId?: string; x?: number; y?: number }
      | null;
    if (!data || typeof data !== 'object') return;

    if (data[OFFSET_TOKEN] === 'response' && typeof data.requestId === 'string') {
      const resolver = pendingOffsetRequests.get(data.requestId);
      if (resolver) {
        resolver({
          x: Number.isFinite(data.x) ? Number(data.x) : 0,
          y: Number.isFinite(data.y) ? Number(data.y) : 0,
        });
      }
      return;
    }

    if (data[OFFSET_TOKEN] === 'request' && typeof data.requestId === 'string') {
      const source = event.source as Window | null;
      if (!source) return;

      const frameElement = Array.from(document.querySelectorAll('iframe')).find(
        (frame) => frame.contentWindow === source,
      );
      if (!frameElement) return;

      const requestId = data.requestId;
      void (async () => {
        try {
          const rect = frameElement.getBoundingClientRect();
          const base = await resolveFrameOffset();
          source.postMessage(
            {
              [OFFSET_TOKEN]: 'response',
              requestId,
              x: base.x + rect.left + frameElement.clientLeft,
              y: base.y + rect.top + frameElement.clientTop,
            },
            '*',
          );
        } catch {
          // 帧已卸载 / 跨域异常：不回复，由请求方超时回退
        }
      })();
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 捕获 UI                                                                    */
/* -------------------------------------------------------------------------- */

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      position: fixed !important;
      inset: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
      background: transparent !important;
    }
    #${ROOT_ID} [${UI_DATA_ATTR}="box"] {
      position: fixed !important;
      border: 2px solid #ff3b30 !important;
      background: rgba(255, 59, 48, 0.08) !important;
      border-radius: 2px !important;
      box-sizing: border-box !important;
      pointer-events: none !important;
      display: none;
      transition: none !important;
    }
    #${ROOT_ID} [${UI_DATA_ATTR}="box"].anx-flash {
      animation: anx-capture-flash 0.75s ease-in-out 2;
    }
    #${ROOT_ID} [${UI_DATA_ATTR}="label"] {
      position: fixed !important;
      max-width: 360px !important;
      padding: 3px 8px !important;
      border-radius: 4px !important;
      background: #ff3b30 !important;
      color: #fff !important;
      font: 11px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      pointer-events: none !important;
      display: none;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25) !important;
    }
    #${ROOT_ID} [${UI_DATA_ATTR}="bar"] {
      position: fixed !important;
      display: none;
      align-items: center !important;
      gap: 6px !important;
      padding: 6px !important;
      border-radius: 8px !important;
      background: #1f2024 !important;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35) !important;
      pointer-events: auto !important;
      font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
    }
    #${ROOT_ID} [${UI_DATA_ATTR}="bar"] button {
      appearance: none !important;
      border: 0 !important;
      border-radius: 6px !important;
      padding: 5px 12px !important;
      font: inherit !important;
      cursor: pointer !important;
      color: #fff !important;
    }
    #${ROOT_ID} [${UI_DATA_ATTR}="confirm"] {
      background: #ff3b30 !important;
    }
    #${ROOT_ID} [${UI_DATA_ATTR}="cancel"] {
      background: #3a3b40 !important;
    }
    @keyframes anx-capture-flash {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255, 59, 48, 0); }
      50% { box-shadow: 0 0 0 4px rgba(255, 59, 48, 0.55); }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function ensureUi(): void {
  if (uiRoot && uiRoot.isConnected) return;
  ensureStyles();

  uiRoot = document.createElement('div');
  uiRoot.id = ROOT_ID;
  uiRoot.setAttribute(UI_DATA_ATTR, 'root');

  highlightBox = document.createElement('div');
  highlightBox.setAttribute(UI_DATA_ATTR, 'box');

  highlightLabel = document.createElement('div');
  highlightLabel.setAttribute(UI_DATA_ATTR, 'label');

  confirmBar = document.createElement('div');
  confirmBar.setAttribute(UI_DATA_ATTR, 'bar');

  const confirmButton = document.createElement('button');
  confirmButton.type = 'button';
  confirmButton.setAttribute(UI_DATA_ATTR, 'confirm');
  confirmButton.textContent = '确认';
  confirmButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void confirmSelection();
  });

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.setAttribute(UI_DATA_ATTR, 'cancel');
  cancelButton.textContent = '取消';
  cancelButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    cancelSelection();
  });

  confirmBar.appendChild(confirmButton);
  confirmBar.appendChild(cancelButton);

  uiRoot.appendChild(highlightBox);
  uiRoot.appendChild(highlightLabel);
  uiRoot.appendChild(confirmBar);
  (document.body || document.documentElement).appendChild(uiRoot);
}

function removeUi(): void {
  if (rafId) {
    window.cancelAnimationFrame(rafId);
    rafId = 0;
  }
  uiRoot?.remove();
  uiRoot = null;
  highlightBox = null;
  highlightLabel = null;
  confirmBar = null;

  const style = document.getElementById(STYLE_ID);
  if (style) style.remove();
}

/* -------------------------------------------------------------------------- */
/* 校验高亮（独立于捕获流程：侧边栏「校验元素」触发的定位反馈）                    */
/* -------------------------------------------------------------------------- */

let verifyRoot: HTMLElement | null = null;
let verifyBox: HTMLElement | null = null;
let verifyLabel: HTMLElement | null = null;
let verifyElement: Element | null = null;
let verifyDeadline = 0;
let verifyFrame = 0;

function ensureVerifyStyles(): void {
  if (document.getElementById(VERIFY_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = VERIFY_STYLE_ID;
  style.textContent = `
    #${VERIFY_ROOT_ID} {
      position: fixed !important;
      inset: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      pointer-events: none !important;
      /* 低于捕获 UI（2147483647），捕获期间校验高亮也不会盖住选取框 */
      z-index: 2147483646 !important;
      background: transparent !important;
    }
    #${VERIFY_ROOT_ID} [${VERIFY_DATA_ATTR}="box"] {
      position: fixed !important;
      border: 2px solid #ff3b30 !important;
      background: rgba(255, 59, 48, 0.12) !important;
      border-radius: 3px !important;
      box-sizing: border-box !important;
      pointer-events: none !important;
      animation: anx-verify-flash 0.5s ease-in-out infinite !important;
    }
    #${VERIFY_ROOT_ID} [${VERIFY_DATA_ATTR}="label"] {
      position: fixed !important;
      max-width: 360px !important;
      padding: 3px 8px !important;
      border-radius: 4px !important;
      background: #ff3b30 !important;
      color: #fff !important;
      font: 11px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      pointer-events: none !important;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25) !important;
    }
    @keyframes anx-verify-flash {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255, 59, 48, 0); border-color: #ff3b30; }
      50% { box-shadow: 0 0 0 5px rgba(255, 59, 48, 0.45); border-color: #ff6b62; }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function ensureVerifyUi(): void {
  if (verifyRoot && verifyRoot.isConnected) return;
  ensureVerifyStyles();

  verifyRoot = document.createElement('div');
  verifyRoot.id = VERIFY_ROOT_ID;
  verifyRoot.setAttribute(VERIFY_DATA_ATTR, 'root');

  verifyBox = document.createElement('div');
  verifyBox.setAttribute(VERIFY_DATA_ATTR, 'box');

  verifyLabel = document.createElement('div');
  verifyLabel.setAttribute(VERIFY_DATA_ATTR, 'label');

  verifyRoot.appendChild(verifyBox);
  verifyRoot.appendChild(verifyLabel);
  (document.body || document.documentElement).appendChild(verifyRoot);
}

function stopVerifyHighlight(): void {
  if (verifyFrame) {
    window.cancelAnimationFrame(verifyFrame);
    verifyFrame = 0;
  }
  verifyElement = null;
  verifyDeadline = 0;
  verifyRoot?.remove();
  verifyRoot = null;
  verifyBox = null;
  verifyLabel = null;
  const style = document.getElementById(VERIFY_STYLE_ID);
  if (style) style.remove();
}

/** 用 rAF 持续跟随元素位置（滚动 / 布局变化 / 自身动画都能跟住） */
function tickVerifyHighlight(): void {
  verifyFrame = 0;
  const element = verifyElement;
  if (!element || !element.isConnected || !verifyBox) {
    stopVerifyHighlight();
    return;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    verifyBox.style.display = 'none';
    if (verifyLabel) verifyLabel.style.display = 'none';
  } else {
    verifyBox.style.display = 'block';
    verifyBox.style.left = `${rect.left}px`;
    verifyBox.style.top = `${rect.top}px`;
    verifyBox.style.width = `${rect.width}px`;
    verifyBox.style.height = `${rect.height}px`;

    if (verifyLabel) {
      const id = element.getAttribute('id');
      const tag = element.tagName.toLowerCase();
      verifyLabel.textContent = `${id ? `<${tag}#${id}>` : `<${tag}>`} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
      verifyLabel.style.display = 'block';
      verifyLabel.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - 200))}px`;
      verifyLabel.style.top = `${Math.max(0, rect.top - 24)}px`;
    }
  }

  if (Date.now() >= verifyDeadline) {
    stopVerifyHighlight();
    return;
  }
  verifyFrame = window.requestAnimationFrame(tickVerifyHighlight);
}

/**
 * 在页面内框选并闪烁提示一个已定位的元素。
 * 重复调用会替换上一次高亮（不会叠加多个框）。
 */
function showVerifyHighlight(element: Element, durationMs: number): void {
  stopVerifyHighlight();
  ensureVerifyUi();
  verifyElement = element;
  verifyDeadline = Date.now() + Math.min(VERIFY_MAX_DURATION_MS, Math.max(200, durationMs));
  try {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  } catch {
    // 不支持平滑滚动时忽略：元素可能已在视口内
  }
  tickVerifyHighlight();
}


function positionHighlight(): void {
  if (!uiRoot || !highlightBox) return;
  const element = selectedElement || hoveredElement;
  if (!element || !element.isConnected) {
    highlightBox.style.display = 'none';
    if (highlightLabel) highlightLabel.style.display = 'none';
    return;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    highlightBox.style.display = 'none';
    if (highlightLabel) highlightLabel.style.display = 'none';
    return;
  }

  highlightBox.style.display = 'block';
  highlightBox.style.left = `${rect.left}px`;
  highlightBox.style.top = `${rect.top}px`;
  highlightBox.style.width = `${rect.width}px`;
  highlightBox.style.height = `${rect.height}px`;

  if (highlightLabel) {
    const tag = element.tagName.toLowerCase();
    const id = element.getAttribute('id');
    const label = id ? `<${tag}#${id}>` : `<${tag}>`;
    highlightLabel.textContent = `${label} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    const labelWidth = Math.min(360, Math.max(80, label.length * 7 + 20));
    highlightLabel.style.display = 'block';
    highlightLabel.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - labelWidth))}px`;
    highlightLabel.style.top = `${Math.max(0, rect.top - 24)}px`;
  }
}

function positionConfirmBar(): void {
  if (!confirmBar) return;
  const element = selectedElement;
  if (!element) {
    confirmBar.style.display = 'none';
    return;
  }

  const rect = element.getBoundingClientRect();
  confirmBar.style.display = 'flex';
  confirmBar.style.visibility = 'hidden';

  const barWidth = confirmBar.offsetWidth || 120;
  const barHeight = confirmBar.offsetHeight || 34;
  const margin = 8;

  let left = rect.right - barWidth;
  let top = rect.bottom + margin;

  if (top + barHeight > window.innerHeight - margin) {
    // 下方无空间 → 放到框上方
    top = rect.top - barHeight - margin;
  }
  if (top < margin) {
    // 上方也无空间 → 放在框内部右下角
    top = rect.bottom - barHeight - margin;
  }

  left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - barWidth - margin));
  top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - barHeight - margin));

  confirmBar.style.left = `${left}px`;
  confirmBar.style.top = `${top}px`;
  confirmBar.style.visibility = 'visible';
}

function scheduleReposition(): void {
  if (rafId) return;
  rafId = window.requestAnimationFrame(() => {
    rafId = 0;
    positionHighlight();
    if (selectedElement) positionConfirmBar();
  });
}

/* -------------------------------------------------------------------------- */
/* 事件处理                                                                   */
/* -------------------------------------------------------------------------- */

function handleMouseMove(event: MouseEvent): void {
  if (state !== 'picking' || captureInFlight) return;
  const target = deepElementFromPoint(event.clientX, event.clientY);
  if (!target || isHostUiTarget(target) || target === hoveredElement) return;
  hoveredElement = target;
  scheduleReposition();
}

function handleMouseDown(event: MouseEvent): void {
  if (captureInFlight) return;
  if (isHostUiTarget(event.target)) return;
  // 右键完全不拦截（保留页面原生上下文菜单）
  if (event.button === 2) return;
  if (event.button !== 0) return;

  if (state === 'confirmed') {
    // 已确认态下，点击页面空白处返回继续选取
    event.preventDefault();
    event.stopPropagation();
    cancelSelection();
    return;
  }

  if (state !== 'picking') return;

  // 阻止选取过程中的链接跳转 / 表单提交，但不影响 Ctrl 判定
  event.preventDefault();
  event.stopPropagation();

  if (!(event.ctrlKey || event.metaKey)) return;

  const target = deepElementFromPoint(event.clientX, event.clientY);
  if (!target || isHostUiTarget(target) || !isVisibleElement(target)) return;

  hoveredElement = target;
  selectedElement = target;
  state = 'confirmed';

  positionHighlight();
  highlightBox?.classList.remove('anx-flash');
  // 强制重排后再加动画类，确保每次都能闪烁
  void highlightBox?.offsetWidth;
  highlightBox?.classList.add('anx-flash');
  positionConfirmBar();
}

function handleClick(event: MouseEvent): void {
  if (isHostUiTarget(event.target)) return;
  if (event.button === 2) return;
  if (state === 'picking' || state === 'confirmed') {
    event.preventDefault();
    event.stopPropagation();
  }
}

function handleKeyDown(event: KeyboardEvent): void {
  if (captureInFlight) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    requestStop('user-cancel');
    return;
  }
  if (event.key === 'Enter' && state === 'confirmed') {
    event.preventDefault();
    event.stopPropagation();
    void confirmSelection();
  }
}

function handleScrollOrResize(): void {
  scheduleReposition();
}

function cancelSelection(): void {
  selectedElement = null;
  state = 'picking';
  if (confirmBar) confirmBar.style.display = 'none';
  if (highlightBox) highlightBox.classList.remove('anx-flash');
  positionHighlight();
}

/* -------------------------------------------------------------------------- */
/* 截图                                                                       */
/* -------------------------------------------------------------------------- */

interface VisibleTabCapture {
  dataUrl: string;
}

async function requestVisibleTab(): Promise<string | null> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'CAPTURE_VISIBLE_TAB',
    })) as { success?: boolean; dataUrl?: string; error?: string } | undefined;
    if (!response?.success || !response.dataUrl) return null;
    return response.dataUrl;
  } catch {
    return null;
  }
}

function loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

/**
 * 捕获元素完整截图：
 *   - 元素在视口内：单帧裁剪；
 *   - 元素超出视口：按视口分块滚动截图并在 canvas 拼接（上限 3×4 块）；
 *   - 分辨率压缩到 900×1400 以内，JPEG 0.82，避免 base64 体积过大。
 */
async function captureElementScreenshot(element: Element): Promise<string | null> {
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;

  const originalScrollX = window.scrollX;
  const originalScrollY = window.scrollY;
  const frameOffset = await resolveFrameOffset();

  const scale = Math.min(
    1,
    MAX_SCREENSHOT_WIDTH / rect.width,
    MAX_SCREENSHOT_HEIGHT / rect.height,
  );
  const outputWidth = Math.max(1, Math.round(rect.width * scale));
  const outputHeight = Math.max(1, Math.round(rect.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext('2d');
  if (!context) return null;

  const docLeft = rect.left + window.scrollX;
  const docTop = rect.top + window.scrollY;

  const viewportWidth = Math.max(1, window.innerWidth);
  const viewportHeight = Math.max(1, window.innerHeight);
  const tilesX = Math.min(MAX_TILES_X, Math.max(1, Math.ceil(rect.width / viewportWidth)));
  const tilesY = Math.min(MAX_TILES_Y, Math.max(1, Math.ceil(rect.height / viewportHeight)));

  let painted = false;

  for (let tileY = 0; tileY < tilesY; tileY += 1) {
    for (let tileX = 0; tileX < tilesX; tileX += 1) {
      try {
        window.scrollTo({
          left: docLeft + tileX * viewportWidth,
          top: docTop + tileY * viewportHeight,
          behavior: 'instant' as ScrollBehavior,
        });
        await nextFrame();
        await delay(60);

        const currentRect = element.getBoundingClientRect();
        const viewportLeft = frameOffset.x + currentRect.left;
        const viewportTop = frameOffset.y + currentRect.top;

        const clipLeft = Math.max(0, viewportLeft);
        const clipTop = Math.max(0, viewportTop);
        const clipRight = Math.min(window.innerWidth, viewportLeft + currentRect.width);
        const clipBottom = Math.min(window.innerHeight, viewportTop + currentRect.height);

        const clipWidth = clipRight - clipLeft;
        const clipHeight = clipBottom - clipTop;
        if (clipWidth < 1 || clipHeight < 1) continue;

        const screenshotUrl = await requestVisibleTab();
        if (!screenshotUrl) continue;

        const image = await loadImage(screenshotUrl);
        if (!image || !image.naturalWidth) continue;

        // 用实际截图与视口宽度比推导设备像素比（兼容系统缩放）
        const deviceScale = image.naturalWidth / Math.max(1, window.innerWidth);

        const elementLeft = viewportLeft;
        const elementTop = viewportTop;
        const destinationX = (clipLeft - elementLeft) * scale;
        const destinationY = (clipTop - elementTop) * scale;

        context.drawImage(
          image,
          clipLeft * deviceScale,
          clipTop * deviceScale,
          clipWidth * deviceScale,
          clipHeight * deviceScale,
          destinationX,
          destinationY,
          Math.max(1, clipWidth * scale),
          Math.max(1, clipHeight * scale),
        );
        painted = true;
      } catch {
        // 单块失败不阻断整体，继续尝试其余分块
      }
    }
  }

  try {
    window.scrollTo({ left: originalScrollX, top: originalScrollY, behavior: 'instant' as ScrollBehavior });
  } catch {
    // 忽略滚动恢复失败
  }

  if (!painted) return null;

  try {
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 捕获流程                                                                   */
/* -------------------------------------------------------------------------- */

function sendMessageSafely(message: unknown): void {
  try {
    void chrome.runtime.sendMessage(message)?.catch?.(() => undefined);
  } catch {
    // 扩展上下文失效（页面刷新 / 扩展重载）时静默丢弃
  }
}

async function confirmSelection(): Promise<void> {
  if (captureInFlight || !selectedElement || !selectedElement.isConnected) return;
  captureInFlight = true;

  const element = selectedElement;
  const selector = buildElementSelector(element);
  const descriptor = captureElementDescriptor(element);

  if (uiRoot) uiRoot.style.display = 'none';
  let screenshotDataUrl: string | null = null;
  try {
    screenshotDataUrl = await captureElementScreenshot(element);
  } finally {
    if (uiRoot) uiRoot.style.display = 'block';
  }

  captureInFlight = false;
  // 截图期间用户已按 Esc 退出：不再上报结果
  if (state === 'idle') return;

  sendMessageSafely({
    type: ELEMENT_CAPTURE_MESSAGE.RESULT,
    selector,
    descriptor,
    screenshotDataUrl,
    pageUrl: location.href,
    pageTitle: document.title,
  });

  cancelSelection();
}

/* -------------------------------------------------------------------------- */
/* 生命周期                                                                   */
/* -------------------------------------------------------------------------- */

const boundHandlers = {
  mousemove: handleMouseMove,
  mousedown: handleMouseDown,
  click: handleClick,
  keydown: handleKeyDown,
  scroll: handleScrollOrResize,
  resize: handleScrollOrResize,
};

function attachListeners(): void {
  window.addEventListener('mousemove', boundHandlers.mousemove, true);
  window.addEventListener('mousedown', boundHandlers.mousedown, true);
  window.addEventListener('click', boundHandlers.click, true);
  window.addEventListener('keydown', boundHandlers.keydown, true);
  window.addEventListener('scroll', boundHandlers.scroll, true);
  window.addEventListener('resize', boundHandlers.resize, true);
}

function detachListeners(): void {
  window.removeEventListener('mousemove', boundHandlers.mousemove, true);
  window.removeEventListener('mousedown', boundHandlers.mousedown, true);
  window.removeEventListener('click', boundHandlers.click, true);
  window.removeEventListener('keydown', boundHandlers.keydown, true);
  window.removeEventListener('scroll', boundHandlers.scroll, true);
  window.removeEventListener('resize', boundHandlers.resize, true);
}

function startCapture(): void {
  // 重复 START：捕获器已在运行也要回 READY。
  // 侧边栏可能因时序（START 早于内容脚本就绪 / READY 与超时竞争）而错过首次
  // 应答，重发 START 时必须有响应，否则会被误判为「页面没有捕获器」。
  if (state !== 'idle') {
    sendMessageSafely({
      type: ELEMENT_CAPTURE_MESSAGE.READY,
      isTopFrame: window.top === window,
      url: location.href,
    });
    return;
  }
  try {
    ensureUi();
    state = 'picking';
    hoveredElement = null;
    selectedElement = null;
    captureInFlight = false;
    attachListeners();
    sendMessageSafely({
      type: ELEMENT_CAPTURE_MESSAGE.READY,
      isTopFrame: window.top === window,
      url: location.href,
    });
  } catch (error) {
    state = 'idle';
    removeUi();
    sendMessageSafely({
      type: ELEMENT_CAPTURE_MESSAGE.FAILED,
      message: error instanceof Error ? error.message : '元素捕获器启动失败',
    });
  }
}

function stopCapture(options: { notify: boolean; reason?: 'user-cancel' | 'page-unload' | 'error' }): void {
  if (state === 'idle') return;
  state = 'idle';
  detachListeners();
  removeUi();
  hoveredElement = null;
  selectedElement = null;
  captureInFlight = false;

  if (options.notify) {
    sendMessageSafely({
      type: ELEMENT_CAPTURE_MESSAGE.CANCELLED,
      reason: options.reason || 'user-cancel',
    });
  }
}

function requestStop(reason: 'user-cancel' | 'page-unload' | 'error'): void {
  stopCapture({ notify: true, reason });
}

/** 安装内容脚本监听（每个 frame 一次，幂等） */
export function installElementPicker(): void {
  const globalScope = globalThis as unknown as Record<string, unknown>;
  if (globalScope[INSTALL_FLAG]) return;
  globalScope[INSTALL_FLAG] = true;

  installFrameOffsetBridge();

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;
    const type = (message as { type?: string }).type;

    if (type === ELEMENT_CAPTURE_MESSAGE.START) {
      startCapture();
      return undefined;
    }

    if (type === ELEMENT_CAPTURE_MESSAGE.STOP) {
      stopCapture({ notify: false });
      return undefined;
    }

    if (type === ELEMENT_CAPTURE_MESSAGE.VERIFY) {
      const request = message as ElementCaptureVerifyRequest;
      let response: ElementCaptureVerifyResponse;
      try {
        const resolved = resolveElementBySelector({
          css: request.css,
          shadowHosts: request.shadowHosts ?? [],
        });
        response = {
          ok: resolved.matchCount === 1,
          matchCount: resolved.matchCount,
          message: resolved.matchCount === 1 ? undefined : '选择器无法唯一命中元素，可能需要重新捕获',
        };
      } catch (error) {
        response = {
          ok: false,
          matchCount: 0,
          message: error instanceof Error ? error.message : '选择器校验失败',
        };
      }
      sendResponse(response);
      return undefined;
    }

    if (type === ELEMENT_CAPTURE_MESSAGE.HIGHLIGHT) {
      const request = message as ElementCaptureHighlightRequest;
      let response: ElementCaptureHighlightResponse;
      try {
        const css = typeof request.css === 'string' ? request.css.trim() : '';
        if (!css) {
          response = { ok: false, matchCount: 0, message: '缺少选择器' };
        } else {
          const resolved = resolveElementBySelector({
            css,
            shadowHosts: request.shadowHosts ?? [],
          });
          const target = resolved.matchCount === 1 ? resolved.element : null;
          if (!target || !target.isConnected) {
            response = {
              ok: false,
              matchCount: resolved.matchCount,
              message: '选择器无法唯一命中元素',
            };
          } else {
            const duration = Number.isFinite(request.durationMs)
              ? Number(request.durationMs)
              : VERIFY_DEFAULT_DURATION_MS;
            showVerifyHighlight(target, duration);
            response = { ok: true, matchCount: 1 };
          }
        }
      } catch (error) {
        response = {
          ok: false,
          matchCount: 0,
          message: error instanceof Error ? error.message : '元素校验失败',
        };
      }
      sendResponse(response);
      return undefined;
    }

    return undefined;
  });

  window.addEventListener('pagehide', () => {
    stopVerifyHighlight();
    if (state !== 'idle') {
      stopCapture({ notify: true, reason: 'page-unload' });
    }
  });
}

/** 当前是否处于捕获模式（供调试 / 测试使用） */
export function isElementPickerActive(): boolean {
  return state !== 'idle';
}

/** 当前捕获器所在 frame 的标识（仅用于日志） */
export function setElementPickerFrameId(frameId: number | null): void {
  uiFrameId = frameId;
}

export function getElementPickerFrameId(): number | null {
  return uiFrameId;
}

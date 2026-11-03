/**
 * ECharts 图表渲染器（沙箱 iframe 隔离，父页侧）
 *
 * markdown-renderer.ts 的 fence 规则产出「图表块」骨架（头部栏 + 占位 body +
 * 隐藏源码 pre，结构与 diagram-block 同构）；本模块在 v-html 注入后把骨架
 * 升级为「manifest 沙箱页 iframe」并把净化后的 option 下发渲染。
 *
 * ==================== 设计要点 ====================
 *
 * 1. **两级信任隔离**：模型 JSON 先经 echarts-option-sanitizer 净化（体积 /
 *    深度 / 节点数 / 数据点上限 + formatter HTML 转义 + 原型污染键剥离），
 *    再进入无任何 chrome.* 权限的沙箱页渲染——净化层收敛输入面，
 *    沙箱层兜住上游 ECharts 的未知 XSS 面。
 * 2. **可视区懒挂载**：IntersectionObserver（200px 预载边距）控制 iframe
 *    创建时机——长会话历史中的离屏图表块不产生运行时开销；折叠前奏里的
 *    图表块展开可见时才挂载。
 * 3. **生命周期回收**：每次扫描清理「块已脱离 DOM」的条目（取消观察 /
 *    清定时器）；iframe 随块 DOM 移除而销毁。会话切换（整表替换消息）后
 *    旧条目由该清扫路径全部回收。
 * 4. **流式安全**：直播流中的消息（[data-streaming]）跳过（v-html 逐 token
 *    重写会反复清掉产物），流结束后由 MutationObserver +
 *    isAiResponding watch 双保险补扫（接线同 diagram-renderer）。
 * 5. **失败降级且可分析**：净化失败 / 沙箱渲染失败 / 超时 → 错误摘要 +
 *    技术细节 + 自动切换源码视图，信息永不丢失；超时守卫防止沙箱页
 *    加载挂起时永远停在「渲染中」。
 * 6. **尺寸协商**：父页 ResizeObserver 观察块 body 宽度变化 → 通知沙箱
 *    chart.resize()（去抖 150ms），侧边栏拖宽 / 窗口缩放时图表自适应。
 * 7. **事件委托**：源码/图表切换按钮走 document 级委托（扩展 CSP 禁止
 *    内联脚本），与 code-copy / diagram-renderer 同构。
 */

import { t } from '@/utils/i18n';
import { escapeHtml } from './html-escape';
import { sanitizeEchartsOptionJson } from './echarts-option-sanitizer';

/** 消息协议常量（与 entrypoints/chart-sandbox/main.ts 严格对齐） */
const PARENT_SOURCE = 'an-chart-parent';
const SANDBOX_SOURCE = 'an-chart-sandbox';

/** 沙箱页 URL（manifest sandbox.pages 声明，输出名见 wxt.config.ts） */
const SANDBOX_PAGE = 'chart-sandbox.html';

/** 单块渲染超时：覆盖沙箱页加载 + ECharts 初始化的合理上限 */
const RENDER_TIMEOUT_MS = 15_000;

/** resize 通知去抖间隔 */
const RESIZE_DEBOUNCE_MS = 150;

/** 图表默认高度（iframe 高度 = 可视图表区高度） */
const CHART_HEIGHT_PX = 340;

/** IntersectionObserver 可视区预载边距：即将滚入视口的图表提前挂载 */
const VIEWPORT_ROOT_MARGIN = '200px';

/** 渲染失败时错误细节的展示截断长度（与 diagram-renderer 一致） */
const ERROR_DETAIL_MAX_LENGTH = 300;

// ==================== 条目跟踪 ====================

interface ChartEntry {
  id: string;
  block: HTMLElement;
  body: HTMLElement;
  iframe: HTMLIFrameElement | null;
  /** 沙箱页是否已发过 ready（决定 render 消息可否直发） */
  sandboxReady: boolean;
  /** 沙箱就绪前暂存的净化后 option JSON */
  pendingOptionJson: string | null;
  renderTimer: number | undefined;
  resizeTimer: number | undefined;
}

/** 图表块全局序号（协议消息中的 id，全局唯一） */
let chartSeq = 0;

const entries = new Map<string, ChartEntry>();

// ==================== 观察器（模块级单例，惰性创建） ====================

let visibilityObserver: IntersectionObserver | null = null;
let resizeObserver: ResizeObserver | null = null;

function ensureVisibilityObserver(): IntersectionObserver {
  if (!visibilityObserver) {
    visibilityObserver = new IntersectionObserver(
      records => {
        for (const record of records) {
          if (!record.isIntersecting) continue;
          const block = record.target as HTMLElement;
          visibilityObserver?.unobserve(block);
          const id = block.dataset.chartId;
          if (!id) continue;
          const entry = entries.get(id);
          if (entry && entry.pendingOptionJson !== null) {
            mountSandbox(entry);
          }
        }
      },
      { rootMargin: VIEWPORT_ROOT_MARGIN },
    );
  }
  return visibilityObserver;
}

function ensureResizeObserver(): ResizeObserver {
  if (!resizeObserver) {
    resizeObserver = new ResizeObserver(records => {
      for (const record of records) {
        const block = (record.target as HTMLElement).closest<HTMLElement>('.chart-block');
        const id = block?.dataset.chartId;
        if (!id) continue;
        const entry = entries.get(id);
        if (!entry || !entry.sandboxReady || !entry.iframe) continue;
        window.clearTimeout(entry.resizeTimer);
        entry.resizeTimer = window.setTimeout(() => {
          entry.iframe?.contentWindow?.postMessage(
            { source: PARENT_SOURCE, type: 'resize' },
            '*',
          );
        }, RESIZE_DEBOUNCE_MS);
      }
    });
  }
  return resizeObserver;
}

// ==================== 视图切换（图表 ↔ 源码） ====================

/** 切换块到源码/图表视图（同步更新切换按钮文案与 aria-pressed） */
function setSourceView(block: HTMLElement, sourceView: boolean): void {
  block.classList.toggle('show-source', sourceView);
  const toggle = block.querySelector<HTMLElement>('.chart-toggle-btn');
  if (toggle) {
    toggle.textContent = sourceView
      ? toggle.dataset.viewChartLabel || t('sidepanel.chat.chartViewChart')
      : toggle.dataset.viewSourceLabel || t('sidepanel.chat.chartViewSource');
    toggle.setAttribute('aria-pressed', String(sourceView));
  }
}

// ==================== 失败降级 ====================

/** 构造失败态 body 内容：错误摘要（i18n）+ 技术细节（截断） */
function buildErrorMarkup(detail: string): string {
  const summary = escapeHtml(t('sidepanel.chat.chartRenderFailed'));
  const clipped = detail.slice(0, ERROR_DETAIL_MAX_LENGTH);
  return (
    `<div class="chart-error">${summary}</div>` +
    `<div class="chart-error-detail">${escapeHtml(clipped)}</div>`
  );
}

/** 单块失败：置错误态、移除 iframe、降级为源码视图 */
function failChart(id: string, detail: string): void {
  const entry = entries.get(id);
  console.warn(`[ChartRenderer] 图表块 ${id} 渲染失败: ${detail}`);
  if (!entry) return;
  cleanupEntry(id, { keepEntry: true });
  entry.block.dataset.chartState = 'error';
  entry.body.innerHTML = buildErrorMarkup(detail);
  setSourceView(entry.block, true);
}

// ==================== 挂载与渲染 ====================

/** 创建沙箱 iframe 并挂到块 body（option 已在排队阶段净化暂存） */
function mountSandbox(entry: ChartEntry): void {
  if (entry.iframe) return;
  let src: string;
  try {
    src = chrome.runtime.getURL(SANDBOX_PAGE);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failChart(entry.id, `沙箱页地址解析失败：${detail}`);
    return;
  }

  entry.block.dataset.chartState = 'rendering';
  entry.renderTimer = window.setTimeout(() => {
    failChart(entry.id, `渲染超时（${RENDER_TIMEOUT_MS / 1000} 秒内沙箱页未响应）`);
  }, RENDER_TIMEOUT_MS);

  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.title = t('sidepanel.chat.chartEchartsLabel');
  iframe.setAttribute('aria-label', iframe.title);
  iframe.style.width = '100%';
  iframe.style.height = `${CHART_HEIGHT_PX}px`;
  iframe.style.border = '0';
  iframe.style.display = 'block';
  iframe.style.background = 'transparent';

  entry.iframe = iframe;
  entry.body.innerHTML = '';
  entry.body.appendChild(iframe);
  ensureResizeObserver().observe(entry.body);
}

/** 向沙箱下发渲染请求（未就绪则暂存，待 ready 信号补发） */
function dispatchRender(entry: ChartEntry): void {
  if (entry.pendingOptionJson === null) return;
  if (!entry.sandboxReady || !entry.iframe) return;
  try {
    entry.iframe.contentWindow?.postMessage(
      { source: PARENT_SOURCE, type: 'render', id: entry.id, optionJson: entry.pendingOptionJson },
      '*',
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failChart(entry.id, `渲染请求发送失败：${detail}`);
  }
}

// ==================== 生命周期清理 ====================

/**
 * 清理条目资源（定时器 / 观察器）。
 * keepEntry=true 时仅释放资源、保留 Map 条目（失败路径仍需引用 body 写错误态）。
 */
function cleanupEntry(id: string, options: { keepEntry?: boolean } = {}): void {
  const entry = entries.get(id);
  if (!entry) return;
  window.clearTimeout(entry.renderTimer);
  window.clearTimeout(entry.resizeTimer);
  visibilityObserver?.unobserve(entry.block);
  resizeObserver?.unobserve(entry.body);
  entry.iframe?.remove();
  entry.iframe = null;
  if (!options.keepEntry) {
    entries.delete(id);
  }
}

/** 扫描期清扫：块已脱离 DOM（会话切换 / 消息重写）的条目全部回收 */
function sweepDetachedEntries(): void {
  for (const id of [...entries.keys()]) {
    const entry = entries.get(id);
    if (entry && !entry.block.isConnected) {
      cleanupEntry(id);
    }
  }
}

// ==================== 对外入口 ====================

/**
 * 扫描并驱动容器内所有待处理图表块（幂等；可安全地被高频调用）。
 * 状态机：pending →（净化，失败即 error）→ queued（等待可视区）→
 * rendering（iframe 已挂载）→ done | error。
 * 直播流中的消息（[data-streaming]）跳过，等待流结束后的兜底扫描。
 */
export function processCharts(root: ParentNode): void {
  if (typeof document === 'undefined') return;

  sweepDetachedEntries();

  const pending = root.querySelectorAll<HTMLElement>(
    '.chart-block[data-chart-state="pending"]',
  );
  for (const block of pending) {
    if (block.closest('[data-streaming]')) continue;
    if (block.dataset.chartId) continue; // 已排队（扫描幂等保护）

    const code = block.querySelector('.chart-source code')?.textContent ?? '';
    const sanitized = sanitizeEchartsOptionJson(code);
    if (!sanitized.ok) {
      block.dataset.chartState = 'error';
      const body = block.querySelector<HTMLElement>('.chart-body');
      if (body) body.innerHTML = buildErrorMarkup(sanitized.error);
      setSourceView(block, true);
      continue;
    }

    const id = `an-chart-${++chartSeq}`;
    block.dataset.chartId = id;
    block.dataset.chartState = 'queued';
    const body = block.querySelector<HTMLElement>('.chart-body');
    if (!body) {
      console.warn('[ChartRenderer] 图表块结构异常：缺少 .chart-body');
      block.dataset.chartState = 'error';
      continue;
    }
    entries.set(id, {
      id,
      block,
      body,
      iframe: null,
      sandboxReady: false,
      pendingOptionJson: sanitized.json,
      renderTimer: undefined,
      resizeTimer: undefined,
    });
    ensureVisibilityObserver().observe(block);
  }
}

let handlerInstalled = false;

/**
 * 安装 document 级事件委托 + window 消息监听（幂等；仅 DOM 上下文生效）。
 * 消息来源校验：只信任 entries 中记录的沙箱 iframe（event.source 比对）。
 */
export function installChartRenderer(): void {
  if (handlerInstalled || typeof document === 'undefined') return;
  handlerInstalled = true;

  document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const toggle = target?.closest?.('.chart-toggle-btn') as HTMLElement | null;
    if (!toggle) return;
    const block = toggle.closest<HTMLElement>('.chart-block');
    if (!block) return;
    event.preventDefault();
    setSourceView(block, !block.classList.contains('show-source'));
  });

  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as
      | { source?: unknown; type?: unknown; id?: unknown; message?: unknown }
      | null;
    if (!data || data.source !== SANDBOX_SOURCE || typeof data.type !== 'string') return;

    // ready 消息不带 id：按 event.source 反查条目
    if (data.type === 'ready') {
      for (const entry of entries.values()) {
        if (entry.iframe && entry.iframe.contentWindow === event.source) {
          entry.sandboxReady = true;
          dispatchRender(entry);
          return;
        }
      }
      return;
    }

    const id = typeof data.id === 'string' ? data.id : '';
    const entry = id ? entries.get(id) : undefined;
    if (!entry) return;
    // 身份复核：id 匹配的条目还必须与消息来源 iframe 一致（防伪造 id）
    if (!entry.iframe || entry.iframe.contentWindow !== event.source) return;

    if (data.type === 'rendered') {
      window.clearTimeout(entry.renderTimer);
      entry.block.dataset.chartState = 'done';
      return;
    }
    if (data.type === 'error') {
      const detail = typeof data.message === 'string' ? data.message : '未知错误';
      failChart(entry.id, detail);
    }
  });
}

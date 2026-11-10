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
 * 7. **保存为图片**：块的头部动作是单个「保存」按钮（component-image-save.ts
 *    的委托），把当前渲染产物导出为高清 PNG。本模块注册产物解析器
 *    （registerChartImageSource）：用 entry 持有的净化后 option 在离屏
 *    画布上按 devicePixelRatio 重绘（矢量源，无级放大），不依赖 iframe
 *    的跨源画布（会污染）。渲染未完成时返回 null，保存侧回落源码文本成图。
 */

import { t } from '@/utils/i18n';
import { escapeHtml } from './html-escape';
import { sanitizeEchartsOptionJson } from './echarts-option-sanitizer';
import { parseRichEnvelope, deriveChartOption } from './rich-components';
import { registerChartImageSource, type ChartImageSource } from './component-image-save';

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
  // 源码没有切换入口，失败降级直接展开（错误摘要 + 原始代码互为印证）
  entry.block.classList.add('show-source');
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

// ==================== 信封输入路径（envelope → 派生 → 净化） ====================

/**
 * 统一信封源码 → 净化后的 option JSON。
 * 三步串联：信封解析（容错归一）→ 图表派生（宿主决策，结构保证）→
 * ECharts 净化（资源上限兜底）。任一步失败都以可读原因返回，
 * 渲染层据此降级为源码展示——模型原始输出对用户仍可见。
 */
function sanitizeDerivedOption(code: string): { ok: true; json: string } | { ok: false; error: string } {
  const parsed = parseRichEnvelope(code);
  if (!parsed.ok) {
    return { ok: false, error: `组件数据解析失败：${parsed.error}` };
  }
  const derived = deriveChartOption(parsed.envelope);
  if (!derived.ok) {
    return { ok: false, error: `图表派生失败：${derived.error}` };
  }
  return sanitizeEchartsOptionJson(JSON.stringify(derived.option));
}

// ==================== 保存为图片的产物解析 ====================

/**
 * 图表块 → 可栅格化产物（供 component-image-save 使用）。
 *
 * 沙箱 iframe 跨源、无法从父页取像素；而 option 的唯一事实源就在本模块
 * （entry.pendingOptionJson，净化后的 ECharts option）。因此在父页离屏
 * 画布上按 devicePixelRatio 重绘一次：矢量源，无级放大不糊，也不碰
 * iframe 的跨源画布。ECharts 本体经动态 import 拉取——只在用户首次点
 * 「保存」时才加载（约 1MB+），与沙箱页 / diagram-renderer 的懒加载同口径；
 * 与 chart-sandbox 共用同一 chunk 缓存。
 *
 * 「完整不截断」：离屏画布用**滚动宽度**（宽图表 / 窄侧边栏时图表的
 * 内容宽度）而不是可视宽度——否则侧边栏拖窄时保存出来会比图表实际
 * 内容更窄，裁掉右侧内容。
 *
 * 渲染未完成（无 entry / 未 done）或重绘失败 → null，保存侧回落源码文本。
 */
async function chartImageSource(block: HTMLElement): Promise<ChartImageSource | null> {
  const id = block.dataset.chartId;
  const entry = id ? entries.get(id) : undefined;
  if (!entry || block.dataset.chartState !== 'done' || !entry.pendingOptionJson) return null;

  try {
    const echarts = await import('echarts');
    const option = JSON.parse(entry.pendingOptionJson) as Record<string, unknown>;
    const body = block.querySelector<HTMLElement>('.chart-body');
    const width = Math.max(
      1,
      Math.round(Math.max(body?.getBoundingClientRect().width || 0, body?.scrollWidth || 0) || 640),
    );
    const height = CHART_HEIGHT_PX;

    const canvas = document.createElement('canvas');
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const chart = echarts.init(canvas, undefined, {
      width,
      height,
      devicePixelRatio: ratio,
      renderer: 'canvas',
    });
    try {
      // 与沙箱页同口径：setOption 即完成同步绘制（沙箱不额外调用 render）
      chart.setOption({ ...option, animation: false } as Parameters<typeof chart.setOption>[0], {
        notMerge: true,
      });
    } finally {
      chart.dispose();
    }
    return { kind: 'dataUrl', dataUrl: canvas.toDataURL('image/png') };
  } catch (error) {
    console.warn('[ChartRenderer] 离屏重绘失败，保存回落源码文本:', error);
    return null;
  }
}

registerChartImageSource(chartImageSource);

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
    // 直播跳过（带稳定区豁免）：活动尾部（[data-streaming] 且不在冻结段内）
    // 的块会被下一个 token 重写，挂载即被销毁——跳过等待流结束；MarkdownText
    // 增量渲染的 [data-md-stable] 冻结段不受尾部重写影响，围栏一闭合即可挂载
    if (block.closest('[data-streaming]') && !block.closest('[data-md-stable]')) continue;
    if (block.dataset.chartId) continue; // 已排队（扫描幂等保护）

    const code = block.querySelector('.chart-source code')?.textContent ?? '';
    // 输入模式：envelope = 统一信封（列式数据 → 派生 option）；option = legacy
    // 直连（源码即 option）。两条路径最终都过同一净化器——防御纵深不变
    const sanitized = block.dataset.chartInput === 'envelope'
      ? sanitizeDerivedOption(code)
      : sanitizeEchartsOptionJson(code);
    if (!sanitized.ok) {
      block.dataset.chartState = 'error';
      const body = block.querySelector<HTMLElement>('.chart-body');
      if (body) body.innerHTML = buildErrorMarkup(sanitized.error);
      // 源码没有切换入口，失败降级直接展开（错误摘要 + 原始代码互为印证）
      block.classList.add('show-source');
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
 * 扫描器入口 + 沙箱消息监听（幂等；仅 DOM 上下文生效）。
 * 消息来源校验：只信任 entries 中记录的沙箱 iframe（event.source 比对）。
 *
 * 块的头部动作只有一个「保存」按钮，其委托装在 component-image-save.ts
 * （与 markdown-renderer 同一处），本模块不再自带点击委托。
 */
export function installChartRenderer(): void {
  if (handlerInstalled || typeof document === 'undefined') return;
  handlerInstalled = true;

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

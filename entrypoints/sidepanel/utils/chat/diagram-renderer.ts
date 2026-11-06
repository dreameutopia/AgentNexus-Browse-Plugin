/**
 * 聊天图表渲染器（Mermaid / PlantUML）
 *
 * markdown-renderer.ts 的 fence 规则只负责产出「图表块」容器骨架（头部栏 +
 * 占位 body + 隐藏源码 pre）；真正的图表产物在本模块中于 v-html 注入后异步生成。
 *
 * ==================== 设计要点 ====================
 *
 * 1. **懒加载 + 失败可重试**：mermaid 本体约 1MB+，经动态 import 只在首块图表
 *    出现时才拉取；初始化失败（如 chunk 加载失败）不缓存 rejection，下次再试。
 * 2. **Mermaid 本地渲染**：mermaid.render 产出 SVG 字符串（securityLevel:
 *    'strict'，图表文本中的 HTML 标签会被转义），直接注入 body；并发渲染经
 *    串行队列执行（mermaid 内部依赖全局临时容器）；出错时防御性清理其在
 *    document.body 残留的临时测量元素。
 * 3. **PlantUML 远程渲染**：PlantUML 是 Java 实现，无法在浏览器本地渲染；
 *    以 plantuml-encoder 编码源码后从官方公共服务器加载 SVG 图片，带超时
 *    守卫（服务器挂起时不会永远停在「渲染中」）。
 *    注意：这会把图表源码发送到 plantuml.com（img 请求），无网络时自动降级显示源码。
 * 4. **流式安全**：处于直播流中的消息（[data-streaming] 标记，见
 *    ChatMessageList.vue）其 DOM 会被逐 token 重写，此时跳过渲染；
 *    流结束后由 MutationObserver（含 data-streaming 属性过滤）+
 *    isAiResponding watch 双保险兜底触发。未闭合的 ```mermaid 围栏在
 *    markdown-it 中不产生 fence token，天然不会出现半截图表块。
 * 5. **失败降级且可分析**：解析/网络失败 → body 显示错误摘要 + 技术细节
 *    （如 mermaid 的行号级解析错误），并自动切换到源码视图，信息永不丢失。
 * 6. **事件委托**：切换按钮（图表 ↔ 源码）走 document 级委托，符合扩展 CSP
 *    （无内联脚本），与 code-copy.ts / file-card.ts 同构；按钮同步维护
 *    aria-pressed 供辅助技术读取。
 * 7. **旧结构升级**：历史会话中旧版渲染器产出的裸 <div class="mermaid">，
 *    扫描时就地升级为新图表块，历史记录里的图表同样获得渲染能力。
 */

import { t } from '@/utils/i18n';
import { escapeHtml } from './html-escape';

/** PlantUML 官方公共渲染服务（SVG 格式；img 加载不受扩展 CSP 限制） */
const PLANTUML_SERVER = 'https://www.plantuml.com/plantuml/svg/';

/** PlantUML 图片加载超时：服务器挂起（不触发 onerror/onload）时的兜底 */
const PLANTUML_TIMEOUT_MS = 20_000;

/** 渲染失败时错误细节的展示截断长度（防止超长堆栈撑爆消息气泡） */
const ERROR_DETAIL_MAX_LENGTH = 300;

// ==================== Mermaid 懒加载（初始化一次 + 串行渲染队列） ====================

/** mermaid 单例（懒加载后持有） */
type MermaidModule = typeof import('mermaid')['default'];

let mermaidInitPromise: Promise<MermaidModule> | null = null;

/**
 * mermaid.render 内部依赖全局临时容器，并发调用可能互相污染产物；
 * 用 Promise 链把所有渲染任务排成串行队列。
 */
let renderQueueTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  // 前序任务无论成败都继续执行本任务（失败不应阻塞后续图表）
  const run = renderQueueTail.then(task, task);
  renderQueueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 加载并初始化 Mermaid（幂等；初始化失败不缓存，下次调用自动重试） */
function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidInitPromise) {
    mermaidInitPromise = (async () => {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({
        startOnLoad: false,
        // strict（默认）：图表文本中的 HTML 标签被转义，防注入
        securityLevel: 'strict',
        theme: 'default',
        fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
      });
      return mermaid;
    })();
    // 失败（chunk 加载失败等）时重置：rejection 不永久缓存，
    // 否则一次瞬时故障会让本会话内所有后续图表全部失败且无法恢复
    mermaidInitPromise.catch(() => {
      mermaidInitPromise = null;
    });
  }
  return mermaidInitPromise;
}

// ==================== 单块渲染 ====================

/** 图表块序号（Mermaid 渲染需要全局唯一 id） */
let diagramSeq = 0;

/** 从错误/未知值中提取可读文本 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** 清理 mermaid.render 出错时可能残留在 body 的临时测量容器 */
function cleanupMermaidTempNodes(id: string): void {
  document.getElementById(id)?.remove();
  document.getElementById(`d${id}`)?.remove();
}

/** Mermaid：本地渲染 SVG，并归一化尺寸以自适应消息宽度 */
async function renderMermaidInto(body: HTMLElement, code: string): Promise<void> {
  const mermaid = await loadMermaid();
  const id = `an-diagram-${++diagramSeq}`;

  let svg = '';
  try {
    ({ svg } = await mermaid.render(id, code));
  } finally {
    cleanupMermaidTempNodes(id);
  }

  // 空产物防御：按失败处理并降级展示源码
  if (!svg || !svg.trim()) {
    throw new Error('Mermaid 渲染返回了空 SVG');
  }

  body.innerHTML = svg;
  // 归一化：去掉固定宽高，限制最大宽度，等比自适应（mermaid 默认输出像素定宽）
  const svgEl = body.querySelector('svg');
  if (svgEl) {
    svgEl.removeAttribute('width');
    svgEl.removeAttribute('height');
    svgEl.style.maxWidth = '100%';
    svgEl.style.height = 'auto';
    svgEl.style.display = 'block';
    svgEl.style.margin = '0 auto';
  }
}

/** PlantUML：编码源码后从公共服务器加载 SVG 图片（带超时守卫与网络终止） */
async function renderPlantumlInto(body: HTMLElement, code: string): Promise<void> {
  const { encode64 } = await import('plantuml-encoder');
  const encoded = encode64(code);
  if (!encoded) {
    throw new Error('PlantUML 源码编码结果为空');
  }

  body.innerHTML = '';
  const img = document.createElement('img');
  img.alt = 'PlantUML diagram';

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      // 置空 src 终止仍挂起的网络请求，避免孤儿加载
      img.src = '';
      img.remove();
      reject(
        new Error(
          `PlantUML 服务器在 ${PLANTUML_TIMEOUT_MS / 1000} 秒内未响应（可能被网络策略拦截或服务不可用）`,
        ),
      );
    }, PLANTUML_TIMEOUT_MS);

    img.onload = () => {
      window.clearTimeout(timer);
      resolve();
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      img.remove();
      reject(new Error('PlantUML 服务器请求失败（网络不可达、服务拒绝或源码超出 URL 长度限制）'));
    };

    body.appendChild(img);
    img.src = `${PLANTUML_SERVER}${encoded}`;
  });
}

/**
 * 构造失败态 body 内容：错误摘要（i18n）+ 技术细节（截断），
 * 细节保留 mermaid 行号级解析信息等可分析线索。
 */
function buildErrorMarkup(detail: string): string {
  const summary = escapeHtml(t('sidepanel.chat.diagramRenderFailed'));
  const clipped = detail.slice(0, ERROR_DETAIL_MAX_LENGTH);
  return (
    `<div class="diagram-error">${summary}</div>` +
    `<div class="diagram-error-detail">${escapeHtml(clipped)}</div>`
  );
}

/** 渲染单个图表块（状态机推进 + 失败降级为源码视图） */
async function renderDiagramBlock(block: HTMLElement): Promise<void> {
  // kind 归一化：结构被篡改时按 mermaid 处理（与产出侧白名单一致）
  const kind = block.dataset.diagramKind === 'plantuml' ? 'plantuml' : 'mermaid';
  const body = block.querySelector<HTMLElement>('.diagram-body');
  if (!body) {
    // 结构损坏（无 body 可写）：仅置错误态并记录，无法进一步展示
    block.dataset.diagramState = 'error';
    console.warn('[DiagramRenderer] 图表块结构异常：缺少 .diagram-body');
    return;
  }

  const code = block.querySelector('.diagram-source code')?.textContent ?? '';
  if (!code.trim()) {
    block.dataset.diagramState = 'error';
    body.innerHTML = buildErrorMarkup('图表源码为空');
    return;
  }

  block.dataset.diagramState = 'rendering';
  try {
    if (kind === 'plantuml') {
      await renderPlantumlInto(body, code);
    } else {
      await enqueue(() => renderMermaidInto(body, code));
    }
    block.dataset.diagramState = 'done';
  } catch (error) {
    const detail = extractErrorMessage(error);
    console.warn(`[DiagramRenderer] ${kind} 图表渲染失败: ${detail}`);
    block.dataset.diagramState = 'error';
    body.innerHTML = buildErrorMarkup(detail);
    // 失败降级：自动切到源码视图，用户仍可读到完整图表代码
    setSourceView(block, true);
  }
}

// ==================== 视图切换（图表 ↔ 源码） ====================

/** 切换块到源码/图表视图（同步更新切换按钮文案与 aria-pressed） */
function setSourceView(block: HTMLElement, sourceView: boolean): void {
  block.classList.toggle('show-source', sourceView);
  const toggle = block.querySelector<HTMLElement>('.diagram-toggle-btn');
  if (toggle) {
    toggle.textContent = sourceView
      ? toggle.dataset.viewChartLabel || t('sidepanel.chat.diagramViewChart')
      : toggle.dataset.viewSourceLabel || t('sidepanel.chat.diagramViewSource');
    toggle.setAttribute('aria-pressed', String(sourceView));
  }
}

// ==================== 旧结构升级 ====================

/**
 * 就地升级旧版渲染器产出的裸 <div class="mermaid">源码</div>。
 * 新结构契约见 markdown-renderer.buildDiagramBlock；此处用 DOM API
 * 重建同构节点，升级后与新版消息走完全相同的渲染/切换/复制链路。
 */
function upgradeLegacyMermaidBlocks(root: ParentNode): void {
  // 新图表块内部不含 .mermaid 类名，命中即旧结构
  const legacyBlocks = root.querySelectorAll<HTMLElement>('.mermaid');
  for (const legacy of legacyBlocks) {
    const code = legacy.textContent ?? '';
    if (!code.trim()) {
      legacy.remove();
      continue;
    }
    const block = document.createElement('div');
    block.className = 'diagram-block';
    block.dataset.diagramKind = 'mermaid';
    block.dataset.diagramState = 'pending';

    const header = document.createElement('div');
    header.className = 'diagram-header';

    const label = document.createElement('span');
    label.className = 'diagram-lang-label';
    label.textContent = t('sidepanel.chat.diagramMermaidLabel');
    header.appendChild(label);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'code-copy-btn diagram-copy-btn';
    copy.dataset.copyIdleLabel = t('sidepanel.chat.copyLabel');
    copy.dataset.copyDoneLabel = t('sidepanel.chat.copiedLabel');
    copy.textContent = t('sidepanel.chat.copyLabel');
    header.appendChild(copy);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'diagram-toggle-btn';
    toggle.dataset.viewSourceLabel = t('sidepanel.chat.diagramViewSource');
    toggle.dataset.viewChartLabel = t('sidepanel.chat.diagramViewChart');
    toggle.textContent = t('sidepanel.chat.diagramViewSource');
    toggle.setAttribute('aria-pressed', 'false');
    header.appendChild(toggle);

    const body = document.createElement('div');
    body.className = 'diagram-body';
    body.textContent = t('sidepanel.chat.diagramRendering');

    const pre = document.createElement('pre');
    pre.className = 'diagram-source';
    const codeEl = document.createElement('code');
    codeEl.textContent = code; // textContent 赋值即转义
    pre.appendChild(codeEl);

    block.appendChild(header);
    block.appendChild(body);
    block.appendChild(pre);
    legacy.replaceWith(block);
  }
}

// ==================== 对外入口 ====================

/**
 * 扫描并渲染容器内所有待处理图表块（幂等；可安全地被高频调用）。
 * 直播流中的消息（[data-streaming]）会被跳过，等待流结束后的兜底扫描。
 */
export function processDiagrams(root: ParentNode): void {
  if (typeof document === 'undefined') return;

  upgradeLegacyMermaidBlocks(root);

  const pending = root.querySelectorAll<HTMLElement>('.diagram-block[data-diagram-state="pending"]');
  for (const block of pending) {
    // 直播跳过（带稳定区豁免，同 chart-renderer）：活动尾部的块会被 token
    // 重写销毁；MarkdownText 冻结段（[data-md-stable]）内的围栏闭合即渲染
    if (block.closest('[data-streaming]') && !block.closest('[data-md-stable]')) continue;
    // renderDiagramBlock 的同步前缀会立即把状态推进到 rendering，
    // 去抖期间再次扫描不会重复渲染同一块
    void renderDiagramBlock(block);
  }
}

let handlerInstalled = false;

/** 安装 document 级视图切换委托（幂等；仅 DOM 上下文生效） */
export function installDiagramRenderer(): void {
  if (handlerInstalled || typeof document === 'undefined') return;
  handlerInstalled = true;

  document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const toggle = target?.closest?.('.diagram-toggle-btn') as HTMLElement | null;
    if (!toggle) return;
    const block = toggle.closest<HTMLElement>('.diagram-block');
    if (!block) return;
    event.preventDefault();
    setSourceView(block, !block.classList.contains('show-source'));
  });
}

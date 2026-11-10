/**
 * 组件保存为图片（document 级事件委托）
 *
 * 覆盖消息容器内**所有**由模型输出触发、由侧边栏可信渲染的富组件：
 *   1. 信封组件（stat / table / timeline / tree / insight）——同步可信 HTML；
 *   2. 数据图表（ECharts，沙箱 iframe 渲染）；
 *   3. 图表（Mermaid / PlantUML，SVG / 远程 img）；
 *   4. diff 块（unified diff 行级着色）。
 *
 * 头部动作从「复制 + 查看源码」收敛为单个「保存」按钮：源码查看是
 * 调试面，保存图片是交付面——用户要把组件带走（发群里 / 贴文档 / 存档），
 * 图片才是跨环境可读的形态。
 *
 * ==================== 实现要点 ====================
 *
 * - **离屏序列化**：克隆节点到 off-screen 容器，按计算样式内联成自包含
 *   外壳（HTML + 全量 CSS），再栅格化。原地克隆不触碰页面上的活动节点
 *   （图表 iframe / Mermaid SVG 不会被销毁重建）。
 * - **图表换真身**：沙箱 iframe / 远程 img 在序列化里不带任何像素，必须
 *   由对应渲染器提供「已渲染产物」；本模块只定义注册契约（registerXxxRenderer），
 *   具体实现挂在 chart-renderer / diagram-renderer 内部（它们持有协议与
 *   option 的唯一事实源），由这两个模块在加载时注册到本模块。
 * - **高清**：canvas 按 devicePixelRatio 放大绘制（上限 3x，防 4K 屏上
 *   画布超限）；图表与 Mermaid SVG 按矢量源栅格化，天然无级放大。
 * - **完整不截断**：克隆体宽度按「可视宽度 → 滚动宽度」上取整（宽表 /
 *   宽图不再被容器裁掉），高度按 scrollHeight 取整（长表格整表入图）；
 *   宽表另把「展开态」一并复刻（容器与表格同时去 max-width），否则表格
 *   内部裁切仍会丢列。
 * - **CSP 安全**：扩展页 CSP 为 `script-src 'self'`，禁内联脚本——一切
 *   按钮走 document 级事件委托（与 code-copy / file-card 同构）。
 *
 * ==================== 不可序列化兜底 ====================
 *
 * 图表 / 图渲染器未注册或渲染未完成时，改存其**源码文本**（信息不丢，
 * 与降级源码视图同一哲学）；同步组件恒可序列化。
 */

import { t } from '@/utils/i18n';

/** 反馈态保持时长（与 code-copy 同口径） */
const FEEDBACK_DURATION_MS = 2000;

/** devicePixelRatio 上限：4K 屏上 3x 已远超「高清」，再大只烧内存 */
const MAX_PIXEL_RATIO = 3;

/** 离屏序列化外壳的内边距（px，与 .component-block / 图表块 padding 对齐） */
const SERIALIZE_PAD = 12;

/** 保存按钮类名（markdown-renderer 与 diagram-renderer 的旧结构升级共用） */
export const COMPONENT_SAVE_CLASS = 'component-save-btn';

// ==================== 渲染器注册契约 ====================

/**
 * 图表（沙箱 iframe）→ 可栅格化源。
 *
 * chart-renderer 持有净化后 option 的唯一事实源（envelope 派生 / legacy
 * 直连两条路径），因此由它在加载时注册；本模块只消费。返回值可为
 * Promise（如需动态 import 的 ECharts 重绘）。
 */
export type ChartImageSource = { kind: 'svg'; svg: string } | { kind: 'dataUrl'; dataUrl: string };

/** 信封/legacy 图表块 → 已渲染产物（未渲染完成返回 null） */
let chartImageSourceResolver: ((block: HTMLElement) => ChartImageSource | null | Promise<ChartImageSource | null>) | null = null;

/** 注册图表块的图片源解析器（幂等，由 chart-renderer 加载时调用） */
export function registerChartImageSource(
  resolver: (block: HTMLElement) => ChartImageSource | null | Promise<ChartImageSource | null>,
): void {
  chartImageSourceResolver = resolver;
}

/**
 * 图（Mermaid / PlantUML）→ 可栅格化源。
 *
 * diagram-renderer 持有渲染产物（本地 SVG / 远程 img）的唯一事实源，
 * 由它在加载时注册。
 */
export type DiagramImageSource = { kind: 'svg'; svg: string } | { kind: 'dataUrl'; dataUrl: string };

/** 图表块 → 已渲染产物（未渲染完成返回 null） */
let diagramImageSourceResolver: ((block: HTMLElement) => DiagramImageSource | null) | null = null;

/** 注册图表块的图片源解析器（幂等，由 diagram-renderer 加载时调用） */
export function registerDiagramImageSource(
  resolver: (block: HTMLElement) => DiagramImageSource | null,
): void {
  diagramImageSourceResolver = resolver;
}

// ==================== DOM → SVG 文档 ====================

/**
 * 组件根的**内容真实尺寸**（含横向滚动溢出部分）。
 *
 * 宽表 / 宽图在消息容器里是横向滚动的：外壳若按容器的可视宽度定尺寸，
 * 导出图会把右侧内容裁掉——表现为「只有白底、没有内容」。因此宽高一律
 * 取滚动尺寸（scrollWidth / scrollHeight）与矩形尺寸的较大者。
 *
 * 高度还要再考虑一层：`overflow: hidden` 的祖先会把 `scrollHeight` 也压到
 * 可视高度（表格外层容器就是如此），此时必须递归累加被裁掉的内容高度，
 * 否则导出图仍会在底部被截断。
 */
function contentSize(element: HTMLElement): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return {
    width: Math.max(1, Math.ceil(Math.max(rect.width, element.scrollWidth))),
    height: Math.max(
      1,
      Math.ceil(Math.max(rect.height, element.scrollHeight, clippedHeight(element))),
    ),
  };
}

/**
 * 递归累加被裁掉的内容高度：对每个「有溢出内容但高度被压住」的后代
 * （scrollHeight > clientHeight），把差值加回总高。只在确有溢出时才累加，
 * 避免把正常布局撑高。
 */
function clippedHeight(element: HTMLElement): number {
  let extra = 0;
  for (const child of Array.from(element.children) as HTMLElement[]) {
    if (child.scrollHeight > child.clientHeight + 1) {
      extra += child.scrollHeight - child.clientHeight;
    }
    extra += clippedHeight(child);
  }
  return extra;
}

/**
 * 把离屏克隆体包进自包含 SVG foreignObject 外壳。
 *
 * CSS 全量内联（document.styleSheets 遍历；跨源样式表读不到规则时跳过——
 * 消息容器样式全部来自扩展包内，不会跨源）。字体声明保留 @font-face 规则，
 * 字体文件按 URL 内联成 data URL，避免导出图里的文字回退到系统字体。
 *
 * 为什么必须把样式内联进 SVG：`<img src="…svg">` 加载时**不继承宿主文档
 * 的样式表**（SVG 里 `<style>` 之外的 CSS 对图片模式完全无效），不内联
 * 就会得到一张只有白底、没有任何文字/边框/着色的空图。
 *
 * 外壳尺寸必须按**滚动尺寸**给：消息里的宽表在容器内横向滚动，若按
 * 容器的可视宽度定外壳宽度，`<img>` 会把内容裁掉右半边——表现为「白图」。
 * 外壳与被渲染的克隆体同宽同高，再按像素比放大绘制，故无损。
 */
async function buildSvgShell(
  clone: HTMLElement,
  contentWidth: number,
  contentHeight: number,
  css: string,
): Promise<{ svg: string; width: number; height: number }> {
  const html = new XMLSerializer().serializeToString(clone);
  // 外壳尺寸 = 内容尺寸 + 内边距：外壳用滚动尺寸（内容真实尺寸）定边界，
  // 内层按内容尺寸铺开——两者差值正好是 SERIALIZE_PAD，否则内容会被裁掉右/下边
  const outerWidth = contentWidth + SERIALIZE_PAD * 2;
  const outerHeight = contentHeight + SERIALIZE_PAD * 2;
  // xmlns 必须显式声明：foreignObject 内的 HTML 按 XML 解析
  return {
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${outerWidth}" height="${outerHeight}" viewBox="0 0 ${outerWidth} ${outerHeight}">` +
      `<foreignObject width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${outerWidth}px;height:${outerHeight}px;background:#ffffff;box-sizing:border-box;padding:${SERIALIZE_PAD}px;">` +
      `<style>${css}</style>` +
      html +
      `</div></foreignObject></svg>`,
    width: outerWidth,
    height: outerHeight,
  };
}

/** 收集文档样式表文本（跨源样式表规则不可读则跳过） */
async function collectStyles(): Promise<string> {
  const parts: string[] = [];
  const sheets = Array.from(document.styleSheets);
  for (const sheet of sheets) {
    try {
      const rules = Array.from(sheet.cssRules);
      for (const rule of rules) parts.push(rule.cssText);
    } catch {
      // 跨源样式表：读取被浏览器拒绝，跳过（不阻断导出）
    }
  }
  return sanitizeStyles(parts.join('\n'));
}

/**
 * 样式净化：剔除一切会**污染画布**的外部引用。
 *
 * 这是「保存出白图」的根因之一：SVG 经 `<img>` 绘进 canvas 时，只要图里
 * 有任何跨源资源（远程字体、远程图片、@import），canvas 就被标记为
 * tainted，`toBlob()` 直接抛 SecurityError——整个保存静默失败，用户看到
 * 的就是「什么都没有」。
 *
 * 处理口径：
 *   - `url(...)` 指向 http(s):// 或 chrome-extension:// 的资源：整条
 *     声明删除（字体也一并去掉——组件正文用系统字体族，不依赖远程字体）；
 *   - `@import`：整条删除（会拉入外部样式表，同样污染画布）；
 *   - 本地相对路径（如 `fonts/KaTeX_*.woff2`）保持原样：它们解析到扩展
 *     自身 origin，不会跨源污染。
 */
function sanitizeStyles(css: string): string {
  // 1) @import 整条删除（跨源样式表拉入）
  let result = css.replace(/@import[^;]*;/g, '');

  // 2) 含远程 url(...) 的整条声明删除（含 @font-face 的 src）
  const remoteUrlPattern = /url\(\s*(['"]?)(?:(?:https?:)?\/\/|chrome-extension:)[^)]*\1\s*\)/gi;
  result = result.replace(/[^{};]*\{[^{}]*\}/g, block => {
    if (!remoteUrlPattern.test(block)) return block;
    remoteUrlPattern.lastIndex = 0;
    // 远程资源出现在 @font-face 里 → 删除整个 at-rule；否则只删该声明
    if (/^\s*@/.test(block)) return '';
    return block.replace(/[^{};]*url\(\s*(['"]?)(?:(?:https?:)?\/\/|chrome-extension:)[^)]*\1\s*\)[^{};]*;?/gi, '');
  });
  remoteUrlPattern.lastIndex = 0;

  // 3) 清掉被删空的 @font-face / @media / @supports 块
  result = result.replace(/@(?:font-face|media|supports)[^{]*\{\s*\}/g, '');
  return result;
}

/**
 * 临时把组件样式注入**活动文档**，让离屏克隆体在文档内就完成正确排版与测量。
 *
 * 为什么必须注入：克隆体虽然挂在 document.body 下，但它的祖先里没有
 * `.message-content` / `.message-body` 这类**结构性祖先类**，而组件的
 * 绝大多数样式都写在这些祖先选择器之下（如 `.message .component-block`）。
 * 不注入的话克隆体在活动文档里就是「未上样式」的裸 HTML——按未样式化的
 * 尺寸测量与序列化，导出图就是一张白底空图。
 *
 * 同一份文本随后进 SVG 外壳：`<img src="…svg">` 模式不继承宿主样式表，
 * 外壳内的 `<style>` 是它唯一能拿到的样式来源。
 */
async function withInjectedStyles<T>(work: (css: string) => Promise<T>): Promise<T> {
  const css = await collectStyles();
  const style = document.createElement('style');
  style.dataset.componentImageSave = '1';
  style.textContent = css;
  document.head.appendChild(style);
  try {
    return await work(css);
  } finally {
    style.remove();
  }
}


// ==================== 栅格化与下载 ====================

/**
 * SVG 文本 → PNG Blob（矢量源按像素比放大，天然高清）。
 *
 * SVG 必须走 **data URL**，不能走 blob URL：在扩展页里 `URL.createObjectURL`
 * 产出的 blob URL 属于不透明 origin，任何经它加载的图像都会把画布标记为
 * tainted，`toDataURL()` / `toBlob()` 直接抛 SecurityError——整个保存
 * 静默失败，用户看到的就是「一张纯白图」。
 *
 * data URL 没有跨源问题（它是内联数据），配合 sanitizeStyles 剔除一切远程
 * 资源后，画布保持干净，导出正常。
 */
/**
 * 导出像素密度：不低于 2x。
 *
 * 「保存为图片」是**交付**动作，不是截图——1x 屏上导出的图只有屏幕那么大，
 * 放大后必然发糊。统一按至少 2x 栅格化（小图 3x），观感与清晰度都更好。
 * 同时按画布面积与单边设上限，避免超大组件把内存吃满。
 */
export function exportPixelRatio(width: number, height: number): number {
  const maxArea = 40_000_000; // 像素点上限（约 160MB RGBA）
  const maxSide = 8000; // 单边上限（浏览器画布上限约 16384，留足余量）
  let ratio = Math.max(2, Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  while (
    ratio > 1 &&
    (width * ratio > maxSide ||
      height * ratio > maxSide ||
      width * height * ratio * ratio > maxArea)
  ) {
    ratio -= 0.5;
  }
  return Math.max(1, ratio);
}

/**
 * SVG 文本 → PNG Blob（矢量源按像素比放大，天然高清）。
 *
 * SVG 必须走 **data URL**，不能走 blob URL：在扩展页里 `URL.createObjectURL`
 * 产出的 blob URL 属于不透明 origin，任何经它加载的图像都会把画布标记为
 * tainted，`toDataURL()` / `toBlob()` 直接抛 SecurityError——整个保存
 * 静默失败，用户看到的就是「一张纯白图」。
 *
 * data URL 没有跨源问题（它是内联数据），配合 sanitizeStyles 剔除一切远程
 * 资源后，画布保持干净，导出正常。
 */
async function svgToPngBlob(svgText: string, width: number, height: number): Promise<Blob> {
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  const image = await loadImage(dataUrl);
  const ratio = exportPixelRatio(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建画布上下文');
  context.scale(ratio, ratio);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvasToBlob(canvas);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('画布导出失败'));
    }, 'image/png');
  });
}

/** 触发浏览器下载（与 file-card / ImageViewer 同构的 anchor 下载） */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 延迟释放：立即 revoke 会让部分浏览器的下载中断
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 保存文件名：component-YYYYMMDD-HHmmss.png（时间戳让连点不撞名） */
function buildFilename(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `component-${stamp}.png`;
}

// ==================== 目标识别与主流程 ====================

/** 按钮所属的「组件根」：按类名顺序匹配（chart-block / diagram-block …） */
const ROOT_SELECTORS = [
  '.chart-block',
  '.diagram-block',
  '.component-block',
  '.stat-card-block',
  '.diff-block',
] as const;

function findComponentRoot(button: HTMLElement): HTMLElement | null {
  for (const selector of ROOT_SELECTORS) {
    const root = button.closest<HTMLElement>(selector);
    if (root) return root;
  }
  return null;
}

/** 图表 / 图块的源码文本（降级兜底与「渲染未完成」提示用） */
function sourceTextOf(root: HTMLElement): string {
  return (
    root.querySelector('.chart-source code')?.textContent ??
    root.querySelector('.diagram-source code')?.textContent ??
    ''
  );
}

/** 把源码文本画进画布（渲染不可用时的降级：信息不丢，仍是一张图） */
async function sourceTextToPngBlob(text: string): Promise<Blob> {
  const width = 720;
  const lineHeight = 20;
  const padding = 16;
  const lines = text.split('\n');
  const height = Math.max(120, lines.length * lineHeight + padding * 2);
  const ratio = exportPixelRatio(width, height);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建画布上下文');
  context.scale(ratio, ratio);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#292824';
  context.font = "13px 'JetBrains Mono', 'Fira Code', Consolas, monospace";
  context.textBaseline = 'top';
  lines.forEach((line, index) => {
    context.fillText(line, padding, padding + index * lineHeight, width - padding * 2);
  });
  return canvasToBlob(canvas);
}

/**
 * 保存指定组件根为高清 PNG。
 *
 * 顺序：图表 / 图块优先取渲染产物（矢量，最清晰）；渲染器未注册或
 * 产物缺失时回落到 DOM 序列化；连 DOM 序列化都失败（极端环境）才降级
 * 为源码文本成图。
 */
async function saveComponentImage(root: HTMLElement): Promise<void> {
  if (root.classList.contains('chart-block') || root.classList.contains('diagram-block')) {
    const resolver =
      root.classList.contains('chart-block') ? chartImageSourceResolver : diagramImageSourceResolver;
    const source = resolver ? (await resolver(root)) ?? null : null;
    if (source) {
      if (source.kind === 'svg') {
        // SVG 源按其自身尺寸（viewBox）栅格化，不依赖页面布局
        const viewBox = parseViewBox(source.svg);
        const blob = await svgToPngBlob(source.svg, viewBox.width, viewBox.height);
        downloadBlob(blob, buildFilename());
        return;
      }
      // 产物已是高分辨率 PNG（图表侧按 renderWidth × 导出像素比离屏栅格化），
      // 这里**不再二次放大**——放大只会插值糊图。唯一要做的是把透明底
      // 铺成白色（离屏画布默认透明，直接保存会在深色背景上看不清）。
      const image = await loadImage(source.dataUrl);
      const width = image.naturalWidth || 640;
      const height = image.naturalHeight || 360;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建画布上下文');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      downloadBlob(await canvasToBlob(canvas), buildFilename());
      return;
    }
    // 渲染未完成 / 渲染器未注册：降级为源码文本成图（信息不丢）
    const text = sourceTextOf(root);
    if (text) {
      downloadBlob(await sourceTextToPngBlob(text), buildFilename());
      return;
    }
    throw new Error('图表尚未渲染完成');
  }

  // 序列化必须在 overlay 仍挂载时进行：离屏克隆体里的文字若触发了字体
  // 加载（document.fonts.load），只有节点在文档内才会等待字体就绪——
  // 先摘掉再序列化会得到「文字已画但字体尚未加载」的导出图。
  const { svg, width, height } = await serializeComponent(root);
  const blob = await svgToPngBlob(svg, width, height);
  downloadBlob(blob, buildFilename());
}

/**
 * 序列化组件根 → 自包含 SVG 文本（HTML + 全量 CSS + 内联字体）。
 *
 * 关键顺序：**先注入样式 → 再克隆挂载 → 量真实尺寸 → 序列化 → 清理**。
 * 克隆体必须在样式注入期间测量，否则会按「未上样式」的裸尺寸定外壳，
 * 导出图就会是一张白底空图（结构性祖先类在克隆体的祖先链上不存在）。
 *
 * 序列化也在 overlay 仍挂载时进行：克隆体里的文字若触发了字体加载
 * （document.fonts.load），只有节点在文档内才会等待字体就绪——先摘掉
 * 再序列化会得到「文字已画但字体尚未加载」的导出图。
 */
async function serializeComponent(root: HTMLElement): Promise<{ svg: string; width: number; height: number }> {
  return withInjectedStyles(async css => {
    const overlay = document.createElement('div');
    overlay.className = 'component-image-overlay';
    overlay.style.position = 'fixed';
    overlay.style.left = '-100000px';
    overlay.style.top = '0';
    overlay.style.visibility = 'hidden';
    overlay.style.pointerEvents = 'none';

    const clone = root.cloneNode(true) as HTMLElement;
    clone.style.maxWidth = 'none';
    // 定宽取「内容真实尺寸」（含滚动溢出）：克隆体定宽后若仍小于内容宽度，
    // 内部滚动容器会继续裁掉右侧内容，导出图就只剩白底
    clone.style.width = `${contentSize(root).width}px`;
    for (const table of clone.querySelectorAll<HTMLElement>('.component-data-table')) {
      table.style.maxWidth = 'none';
      table.style.width = '100%';
    }
    overlay.appendChild(clone);
    document.body.appendChild(overlay);

    try {
      const { width, height } = contentSize(clone);
      // buildSvgShell 自己把内边距加到外壳尺寸上，返回最终可栅格化的宽高
      const { svg, width: outerWidth, height: outerHeight } = await buildSvgShell(clone, width, height, css);
      return { svg, width: outerWidth, height: outerHeight };
    } finally {
      overlay.remove();
    }
  });
}

/** 从 SVG 文本里取 viewBox 尺寸（缺失时给保守默认，保证可栅格化） */
function parseViewBox(svg: string): { width: number; height: number } {
  const match = svg.match(/viewBox\s*=\s*"([^"]+)"/i);
  if (match) {
    const parts = match[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: Math.ceil(parts[2]), height: Math.ceil(parts[3]) };
    }
  }
  const widthMatch = svg.match(/\bwidth\s*=\s*"?(\d+(?:\.\d+)?)/i);
  const heightMatch = svg.match(/\bheight\s*=\s*"?(\d+(?:\.\d+)?)/i);
  const width = widthMatch ? Math.ceil(Number(widthMatch[1])) : 640;
  const height = heightMatch ? Math.ceil(Number(heightMatch[1])) : 360;
  return { width: Math.max(width, 1), height: Math.max(height, 1) };
}

/** 按钮反馈：保存中 → 已保存（复用 code-copy 的 .copied 样式语义） */
async function saveWithFeedback(button: HTMLElement): Promise<void> {
  if (button.dataset.componentSaveBusy === '1') return;
  button.dataset.componentSaveBusy = '1';

  const idleLabel = button.dataset.saveIdleLabel || t('sidepanel.chat.saveImageLabel');
  const doneLabel = button.dataset.saveDoneLabel || t('sidepanel.chat.saveImageDoneLabel');
  button.dataset.saveIdleLabel = idleLabel;
  button.dataset.saveDoneLabel = doneLabel;

  const root = findComponentRoot(button);
  if (!root) {
    delete button.dataset.componentSaveBusy;
    return;
  }

  try {
    await saveComponentImage(root);
    button.textContent = doneLabel;
    button.classList.add('copied');
  } catch (error) {
    console.warn('[ComponentSave] 保存组件图片失败:', error);
  } finally {
    window.setTimeout(() => {
      button.textContent = idleLabel;
      button.classList.remove('copied');
      delete button.dataset.componentSaveBusy;
    }, FEEDBACK_DURATION_MS);
  }
}

let handlerInstalled = false;

/** 安装 document 级保存委托（幂等；仅 DOM 上下文生效） */
export function installComponentImageSaveHandler(): void {
  if (handlerInstalled || typeof document === 'undefined') return;
  handlerInstalled = true;

  document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest?.<HTMLElement>(`.${COMPONENT_SAVE_CLASS}`);
    if (!button) return;
    event.preventDefault();
    void saveWithFeedback(button);
  });
}

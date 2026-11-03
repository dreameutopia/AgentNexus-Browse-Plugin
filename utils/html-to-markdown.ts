/**
 * HTML → Markdown 转换器
 *
 * 用于「右键保存页面」时把页面 DOM 转换为结构良好的 Markdown 文本。
 *
 * 设计要点：
 * - 代码块（pre/code）原样写入围栏代码块，内部文本（含 # 注释、缩进、空行、反引号）不做任何 Markdown 解释；
 * - 行内元素（链接、加粗、行内代码等）在原位输出行内语法，不再各自独占一行；
 * - 文本节点转义 Markdown 特殊字符（\ ` * [ ]），行首的块级标记（#、>、-、1. 等）单独转义，
 *   保证纯文本不会被误渲染为标题/列表（渲染端 MarkdownIt 渲染时反斜杠转义会被还原，显示无损）；
 * - 列表支持嵌套、保留 ol 的 start 编号，列表项内可包含段落、代码块、嵌套列表；
 * - 跳过导航、页眉页脚、按钮、隐藏元素等噪音，只保留正文内容；
 * - 图片输出占位符 [[IMG:base64(src)|alt]]，保持既有协议不变，由渲染端替换为 figure。
 */

/** 文本中出现的图片信息（供后续下载使用） */
export interface HtmlToMarkdownImage {
  src: string;
  alt: string;
  width: number;
  height: number;
}

export interface HtmlToMarkdownOptions {
  /** 收集正文中出现的图片（去重），用于后续下载转 base64 */
  imageCollector?: HtmlToMarkdownImage[];
}

interface ConvertContext {
  imageCollector?: HtmlToMarkdownImage[];
  collectedSrcs: Set<string>;
}

/** 完全跳过的标签（脚本、样式、嵌入内容、表单控件等噪音） */
const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'canvas',
  'video',
  'audio',
  'dialog',
  'form',
  'input',
  'select',
  'textarea',
  'button',
  'nav',
]);

/** 跳过的 ARIA 角色（导航、菜单、工具栏、标签页、弹层等界面元素） */
const SKIP_ROLES = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'search',
  'menu',
  'menubar',
  'toolbar',
  'tablist',
  'tab',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'complementary',
]);

/** 行内容器标签：参与行内文本流，不打断段落 */
const INLINE_TAGS = new Set([
  'span',
  'label',
  'abbr',
  'kbd',
  'samp',
  'var',
  'mark',
  'small',
  'u',
  'ins',
  's',
  'del',
  'strike',
  'time',
  'q',
  'cite',
  'dfn',
  'sub',
  'sup',
  'bdi',
  'bdo',
  'font',
  'big',
  'tt',
  'wbr',
  'output',
  'meter',
  'progress',
]);

/** 语义化行内标签（有专属 Markdown 语法或直接透传） */
const INLINE_SEMANTIC_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'strong',
  'i',
  'em',
  'code',
  'img',
  'br',
  'span',
]);

/** 含块级后代时应按容器处理的未知标签选择器 */
const BLOCK_DESCENDANT_SELECTOR =
  'p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,pre,table,figure,figcaption,section,article,header,footer,main,aside,hr,dl,dt,dd,details,summary';

/** 由本转换器生成、不能被再次转义的行内语法起始字符不在此列（* ` [ ] 已在文本层转义） */
const LEADING_MARKER_LINE =
  /^\s*(?:#{1,6}(?:\s|$)|>|[-+=~](?:\s|$)|\d{1,9}\.(?:\s|$)|(?:---+|\*\*\*+|___+|===+|~~~+)\s*$)/;

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === Node.ELEMENT_NODE;
}

/** 判断元素是否应被跳过（噪音或不可见） */
function shouldSkipElement(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return true;

  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role && SKIP_ROLES.has(role)) return true;

  if (el.hasAttribute('hidden')) return true;
  if ((el.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return true;

  // 页面级 chrome：nav / header / footer / aside。
  // header / aside 在正文（article / main 内部）中的保留；
  // footer 仅在 article 内保留——站点级页脚常嵌套在 main 里，按页面噪音跳过
  if (tag === 'footer') {
    if (!el.closest('article')) return true;
  } else if (tag === 'header' || tag === 'aside') {
    if (!el.closest('article, main, [role="main"]')) return true;
  }

  return isElementHidden(el);
}

/** 可见性检测：优先 checkVisibility（性能好、覆盖祖先隐藏），降级用 getComputedStyle */
function isElementHidden(el: HTMLElement): boolean {
  const anyEl = el as HTMLElement & {
    checkVisibility?: (options?: Record<string, boolean>) => boolean;
  };
  if (typeof anyEl.checkVisibility === 'function') {
    return !anyEl.checkVisibility({
      checkVisibilityCSS: true,
      visibilityProperty: true,
      opacityProperty: false,
      contentVisibilityAuto: false,
    });
  }
  const style = window.getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
}

/** 空白归一化（与浏览器渲染一致：连续空白折叠为单个空格） */
function normalizeWhitespace(text: string): string {
  return text.replace(/[\t\r\n\f ]+/g, ' ');
}

/**
 * CSS 计算样式为块级显示（display:block / flex / grid / list-item 等）。
 * 已知行内标签（span / strong / a …）常被 CSS 设为块级显示（标签行、面包屑、步骤标题），
 * 浏览器里各占一行，若按行内拼接会与相邻文本粘连。
 */
function isBlockDisplay(el: HTMLElement): boolean {
  const display = window.getComputedStyle(el).display;
  // display 为空视为行内（jsdom 未给行内标签计算默认值）；inline-* 与 contents 仍是行内流
  return !!display && display !== 'contents' && !display.startsWith('inline');
}

/** 伪元素 content 读取能力（jsdom 等环境忽略 pseudoElt 参数，读取结果与普通样式相同） */
let pseudoContentSupported: boolean | null = null;

function checkPseudoContentSupport(): boolean {
  if (pseudoContentSupported === null) {
    try {
      const probe = document.createElement('span');
      const direct = window.getComputedStyle(probe).content;
      const pseudo = window.getComputedStyle(probe, '::after').content;
      pseudoContentSupported = typeof pseudo === 'string' && pseudo !== direct;
    } catch {
      pseudoContentSupported = false;
    }
  }
  return pseudoContentSupported;
}

/**
 * 读取伪元素的引号 content（CSS 生成的面包屑分隔符、箭头等，如 `li + li::before { content: "/" }`）。
 * 只取纯字符串形式，counter()/attr()/url() 等非引号内容忽略；环境不支持时返回空串。
 */
function renderPseudoContent(el: HTMLElement, pseudo: '::before' | '::after'): string {
  if (!checkPseudoContentSupport()) return '';
  try {
    const content = window.getComputedStyle(el, pseudo).content;
    if (!content) return '';
    const match = content.match(/^(['"])([\s\S]*)\1$/);
    return match ? escapeMarkdownText(match[2]) : '';
  } catch {
    return '';
  }
}

/**
 * 转义文本节点中的 Markdown 行内特殊字符。
 * 渲染端（MarkdownIt）会把反斜杠转义还原为原字符，显示无损；
 * 复制文本时用 unescapeMarkdownText 还原。
 */
export function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*[\]])/g, '\\$1');
}

/** 还原 escapeMarkdownText 产生的转义（用于复制文本等场景） */
export function unescapeMarkdownText(text: string): string {
  // 围栏代码块内的反斜杠是原始内容，不做还原（与渲染端 unescapeMarkdownText 行为一致）
  const lines = text.split('\n');
  const result: string[] = [];
  let openFence: { char: string; length: number } | null = null;

  for (const line of lines) {
    const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    let inFence = openFence !== null;
    if (match) {
      const marker = match[1];
      const char = marker[0];
      if (!openFence) {
        openFence = { char, length: marker.length };
        inFence = true;
      } else if (char === openFence.char && marker.length >= openFence.length && !match[2].trim()) {
        // 闭合围栏标记后不允许有其他内容（与 CommonMark 规则一致）
        openFence = null;
        inFence = true;
      }
    }
    result.push(inFence ? line : line.replace(/\\(.)/g, '$1'));
  }

  return result.join('\n');
}

/** 转义行首会被解析为块级结构的标记（#、>、-、1.、--- 等） */
function escapeLeadingMarkers(text: string): string {
  return text
    .split('\n')
    .map((line) => (LEADING_MARKER_LINE.test(line) ? line.replace(/^(\s*)/, '$1\\') : line))
    .join('\n');
}

/** 生成图片占位符（编码协议与渲染端解码保持一致） */
function makeImageMarker(src: string, alt: string): string {
  let encoded = src;
  try {
    encoded = btoa(encodeURIComponent(src));
  } catch {
    // 极端情况下 btoa 失败时保留原始 src，渲染端同样支持按原始 src 匹配
  }
  return `[[IMG:${encoded}|${alt}]]`;
}

/** 从 class / data 属性中探测代码块语言 */
function detectCodeLanguage(el: HTMLElement | null): string {
  if (!el) return '';
  const attrLang =
    el.getAttribute('data-lang') ||
    el.getAttribute('data-language') ||
    el.getAttribute('data-highlight-lang') ||
    '';
  const fromAttr = sanitizeLang(attrLang);
  if (fromAttr) return fromAttr;

  const cls = el.getAttribute('class') || '';
  const match = cls.match(
    /(?:^|[\s-])(?:language|lang|highlight-source|source|brush|syntax)(?:[-_:]|\s)([A-Za-z0-9#+_-]{1,25})/i,
  );
  return match ? sanitizeLang(match[1]) : '';
}

function sanitizeLang(lang: string): string {
  const trimmed = (lang || '').trim();
  return /^[A-Za-z0-9#+_-]{1,25}$/.test(trimmed) ? trimmed : '';
}

/** 生成长度足够的围栏，避免代码内容中的反引号破坏围栏 */
function makeFence(content: string): string {
  const runs = content.match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  return '`'.repeat(longest + 1);
}

/**
 * 判断元素是否为「相邻重复克隆」（跑马灯无缝滚动、轮播克隆等场景）：
 * 与上一个保留的兄弟元素文本完全一致且文本较长时只保留一个。
 */
function isDuplicateSibling(el: HTMLElement, prevText: string | null): boolean {
  const text = (el.textContent || '').trim();
  return text.length >= 8 && text === prevText;
}

/** 行内内容渲染（返回 Markdown 行内字符串） */
function renderInlineNodes(nodes: ArrayLike<Node>, ctx: ConvertContext): string {
  let out = '';
  let lastKeptText: string | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalizeWhitespace(node.textContent || '');
      if (text) {
        out += escapeMarkdownText(text);
        if (text.trim()) lastKeptText = null;
      }
      continue;
    }

    if (!isElement(node)) continue;
    const el = node;
    if (shouldSkipElement(el)) continue;
    if (isDuplicateSibling(el, lastKeptText)) continue;
    lastKeptText = (el.textContent || '').trim();

    const tag = el.tagName.toLowerCase();

    // CSS 伪元素的引号 content（面包屑分隔符、箭头等）按原位拼接
    const before = renderPseudoContent(el, '::before');
    const after = renderPseudoContent(el, '::after');

    let piece = '';
    switch (tag) {
      case 'br':
        piece = '  \n';
        break;
      case 'img':
        piece = renderImage(el as HTMLImageElement, ctx);
        break;
      case 'code':
        piece = renderInlineCode(el);
        break;
      case 'a':
        piece = renderLink(el, ctx);
        break;
      case 'b':
      case 'strong': {
        const inner = renderInlineNodes(el.childNodes, ctx).trim();
        if (inner) piece = `**${inner}**`;
        break;
      }
      case 'i':
      case 'em': {
        const inner = renderInlineNodes(el.childNodes, ctx).trim();
        if (inner) piece = `*${inner}*`;
        break;
      }
      default:
        // 其余行内/未知容器：递归拼接行内内容
        piece = renderInlineNodes(el.childNodes, ctx);
        break;
    }
    out += before + piece + after;
  }
  return out;
}

function renderInlineCode(el: HTMLElement): string {
  const raw = (el.textContent || '').replace(/\r\n?/g, '\n').replace(/[\t\n]+/g, ' ').trim();
  if (!raw) return '';
  const runs = raw.match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(longest + 1);
  const pad = longest > 0 ? ' ' : '';
  return `${fence}${pad}${raw}${pad}${fence}`;
}

function renderLink(el: HTMLElement, ctx: ConvertContext): string {
  const inner = renderInlineNodes(el.childNodes, ctx).trim();
  if (!inner) return '';

  const hrefAttr = el.getAttribute('href') || '';
  const href = hrefAttr.trim();
  if (!href || href.startsWith('#') || /^(?:javascript|vbscript):/i.test(href)) {
    return inner;
  }

  // 解析为绝对地址（el.href 已由浏览器解析），并规范目的地写法
  let url = (el as HTMLAnchorElement).href || href;
  url = url.replace(/[\s<>]/g, (ch) => (ch === ' ' ? '%20' : ''));
  return `[${inner}](<${url}>)`;
}

function renderImage(img: HTMLImageElement, ctx: ConvertContext): string {
  const src = pickImageSrc(img);
  if (!src) return '';
  // 忽略 SVG data URL（多为图标）与超大 data URL
  if (src.startsWith('data:image/svg') || src.length > 500000) return '';

  const width = img.naturalWidth || img.width || parseInt(img.getAttribute('width') || '', 10) || 0;
  const height =
    img.naturalHeight || img.height || parseInt(img.getAttribute('height') || '', 10) || 0;
  // 已知尺寸且过小的图片（图标、装饰）跳过；尺寸未知（懒加载未进入视口）保留
  if (width > 0 && height > 0 && (width < 50 || height < 50)) return '';

  const alt = (img.getAttribute('alt') || '').replace(/[[\]|]/g, ' ').trim();

  if (ctx.imageCollector && !ctx.collectedSrcs.has(src)) {
    ctx.collectedSrcs.add(src);
    ctx.imageCollector.push({ src, alt, width, height });
  }

  return `\n${makeImageMarker(src, alt)}\n`;
}

function pickImageSrc(img: HTMLImageElement): string {
  const current = img.currentSrc || img.src;
  if (current) return current;

  for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc']) {
    const value = img.getAttribute(attr);
    if (value) return resolveUrl(value);
  }

  const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
  if (srcset) {
    const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
    if (first) return resolveUrl(first);
  }
  return '';
}

function resolveUrl(url: string): string {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

/** 块级收集：把子节点流拆分为「行内段落块」与「结构块」 */
function collectBlocks(nodes: ArrayLike<Node>, ctx: ConvertContext): string[] {
  const blocks: string[] = [];
  let run: Node[] = [];
  let lastKeptText: string | null = null;

  const flushRun = () => {
    if (!run.length) return;
    const currentRun = run;
    run = [];
    const inline = renderInlineNodes(currentRun, ctx).trim();
    if (!inline) return;

    // 图片占位符独立成块（渲染端整块替换为 figure）
    const parts = inline.split(/(\[\[IMG:[^\]]*\]\])/g);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (/^\[\[IMG:/.test(trimmed)) {
        blocks.push(trimmed);
      } else {
        blocks.push(escapeLeadingMarkers(trimmed));
      }
    }
  };

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    if (node.nodeType === Node.TEXT_NODE) {
      // 空白文本节点也要进入行内流（元素之间的空格有语义），空段落在 flushRun 中丢弃
      run.push(node);
      if ((node.textContent || '').trim()) lastKeptText = null;
      continue;
    }

    if (!isElement(node)) continue;
    const el = node;
    if (shouldSkipElement(el)) continue;

    const tag = el.tagName.toLowerCase();

    if (isInlineContextTag(tag, el)) {
      run.push(el);
      continue;
    }

    if (isDuplicateSibling(el, lastKeptText)) continue;
    lastKeptText = (el.textContent || '').trim();

    flushRun();
    blocks.push(...blocksFromElement(el, ctx));
  }
  flushRun();

  return blocks;
}

/** 判断元素在块级流中是否作为行内内容处理 */
function isInlineContextTag(tag: string, el: HTMLElement): boolean {
  // img/br/wbr 无子节点且由行内渲染器单独处理，始终按行内（转块级会因无子节点而丢失）
  if (tag === 'img' || tag === 'br' || tag === 'wbr') return true;
  const knownInline = INLINE_TAGS.has(tag) || INLINE_SEMANTIC_TAGS.has(tag);
  if (!knownInline) {
    // 未知自定义标签：没有块级后代时按行内处理，避免打散段落
    if (!tag.includes('-') || el.querySelector(BLOCK_DESCENDANT_SELECTOR)) return false;
  }
  // 已知行内标签可能被 CSS 设为块级显示（标签行、步骤标题等），按块级拆分避免文本粘连
  return !isBlockDisplay(el);
}

function blocksFromElement(el: HTMLElement, ctx: ConvertContext): string[] {
  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(tag[1]);
      const inner = renderInlineNodes(el.childNodes, ctx).trim().replace(/\s*\n\s*/g, ' ');
      return inner ? [`${'#'.repeat(level)} ${inner}`] : [];
    }
    case 'p':
      // 与块级流一致：p 内被 CSS 设为块级显示的行内标签（display:block 的 span 等）
      // 独立成块，避免与相邻文本粘连成一行
      return collectBlocks(el.childNodes, ctx);
    case 'hr':
      return ['---'];
    case 'pre': {
      const code = renderCodeBlock(el);
      return code ? [code] : [];
    }
    case 'blockquote':
      return renderQuote(el, ctx);
    case 'ul':
      return renderList(el, false, ctx);
    case 'ol':
      return renderList(el, true, ctx);
    case 'table':
      return renderTable(el, ctx);
    case 'figure':
      return collectBlocks(el.childNodes, ctx);
    case 'figcaption': {
      const inner = renderInlineNodes(el.childNodes, ctx).trim();
      return inner ? [escapeLeadingMarkers(inner)] : [];
    }
    case 'dl':
      return collectBlocks(el.childNodes, ctx);
    case 'dt': {
      const inner = renderInlineNodes(el.childNodes, ctx).trim();
      return inner ? [`**${inner}**`] : [];
    }
    case 'dd':
      return indentBlocks(collectBlocks(el.childNodes, ctx), '  ');
    case 'details':
      return renderDetails(el, ctx);
    case 'summary': {
      const inner = renderInlineNodes(el.childNodes, ctx).trim();
      return inner ? [`**${inner}**`] : [];
    }
    case 'br':
      return [];
    default:
      // div/section/article/未知块容器：递归子节点
      return collectBlocks(el.childNodes, ctx);
  }
}

/** pre 内按换行处理的子元素（br 与块级容器），兼容「一行一个块级元素」的代码展示结构 */
const CODE_LINE_BREAK_TAGS = new Set([
  'br',
  'div',
  'p',
  'li',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'section',
  'article',
  'dd',
  'dt',
]);

/**
 * 提取代码文本：
 * - 文本节点原样保留（不折叠空白、保留显式换行）；
 * - <br> 与块级子元素按换行处理，防止「一行一个元素」的代码结构被平铺成一行；
 * - 块级子元素独立成行（空块级元素保留为空行）。
 */
function extractCodeText(el: HTMLElement): string {
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent || '';
      return;
    }
    if (!isElement(node)) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') {
      out += '\n';
      return;
    }
    if (!CODE_LINE_BREAK_TAGS.has(tag)) {
      node.childNodes.forEach(walk);
      return;
    }
    // 块级子元素：确保从新行开始，结束后强制换行（空块保留为空行）
    if (out && !out.endsWith('\n')) out += '\n';
    node.childNodes.forEach(walk);
    out += '\n';
  };
  el.childNodes.forEach(walk);
  return out;
}

/** 代码块：内容原样进入围栏，不做任何 Markdown 解释 */
function renderCodeBlock(pre: HTMLElement): string {
  // 代码源优先取内部 code 元素（排除按钮、滚动条等非代码节点）
  const clone = pre.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll('button, [aria-hidden="true"], .copy, .copy-btn, .copy-button')
    .forEach((el) => el.remove());
  const codeEl = clone.querySelector('code');
  const source = codeEl || clone;

  const lang =
    detectCodeLanguage(pre) || detectCodeLanguage(codeEl) || detectCodeLanguage(pre.parentElement);
  let text = extractCodeText(source).replace(/\r\n?/g, '\n');
  text = text.replace(/^\n+/, '').replace(/\s+$/, '');
  if (!text) return '';

  const fence = makeFence(text);
  return `${fence}${lang}\n${text}\n${fence}`;
}

function renderQuote(el: HTMLElement, ctx: ConvertContext): string[] {
  const inner = collectBlocks(el.childNodes, ctx).join('\n\n');
  if (!inner.trim()) return [];
  const quoted = inner
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  return [quoted];
}

function renderList(el: HTMLElement, ordered: boolean, ctx: ConvertContext): string[] {
  const items = Array.from(el.children).filter(
    (child) => child.tagName === 'LI' && !shouldSkipElement(child as HTMLElement),
  ) as HTMLElement[];
  if (!items.length) return [];

  const startAttr = ordered ? parseInt(el.getAttribute('start') || '', 10) || 1 : 1;
  const lines: string[] = [];

  items.forEach((li, index) => {
    const marker = ordered ? `${startAttr + index}. ` : '- ';
    const pad = ' '.repeat(marker.length);
    const sub = collectBlocks(li.childNodes, ctx);

    if (!sub.length) {
      lines.push(marker.trim());
      return;
    }

    // 首块接在标记后，其余行（含后续块）统一缩进到内容列
    const contentLines = sub.join('\n\n').split('\n');
    lines.push(marker + contentLines[0]);
    for (const line of contentLines.slice(1)) {
      lines.push(line ? pad + line : '');
    }
  });

  return lines.length ? [lines.join('\n')] : [];
}

function renderTable(table: HTMLElement, ctx: ConvertContext): string[] {
  const rows = Array.from(table.querySelectorAll('tr')).filter(
    (tr) => tr.closest('table') === table && !shouldSkipElement(tr as HTMLElement),
  ) as HTMLElement[];
  if (!rows.length) return [];

  const matrix = rows.map((tr) =>
    Array.from(tr.children)
      .filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
      .map((cell) =>
        // 单元格内的多个块级子内容用空格分隔，避免文本粘连；随后压平为单行并转义竖线
        collectBlocks(cell.childNodes, ctx)
          .join(' ')
          .replace(/\s*\n\s*/g, ' ')
          .replace(/\|/g, '\\|')
          .trim(),
      ),
  );

  const columnCount = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  if (!columnCount) return [];

  const normalizeRow = (row: string[]): string[] => {
    const padded = [...row];
    while (padded.length < columnCount) padded.push('');
    return padded.slice(0, columnCount);
  };

  // GFM 表格必须有表头行：统一用首行作为表头，其余行为表体
  const header = normalizeRow(matrix[0]);
  const body = matrix.slice(1).map(normalizeRow);

  const toRow = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  const separator = `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`;

  return [[toRow(header), separator, ...body.map(toRow)].join('\n')];
}

function renderDetails(el: HTMLElement, ctx: ConvertContext): string[] {
  const summary = Array.from(el.children).find((child) => child.tagName === 'SUMMARY') as
    | HTMLElement
    | undefined;
  const blocks: string[] = [];
  if (summary) blocks.push(...blocksFromElement(summary, ctx));
  // 折叠内容仅在展开时保留（与页面视觉一致）
  if (el.hasAttribute('open')) {
    const contentNodes = Array.from(el.childNodes).filter((node) => node !== summary);
    blocks.push(...collectBlocks(contentNodes, ctx));
  }
  return blocks;
}

function indentBlocks(blocks: string[], pad: string): string[] {
  return blocks.map((block) =>
    block
      .split('\n')
      .map((line) => (line ? pad + line : line))
      .join('\n'),
  );
}

/**
 * 将 DOM（通常为 document.body）转换为 Markdown 文本。
 * 只读操作，不修改页面 DOM。
 */
export function htmlToMarkdown(
  root: HTMLElement,
  options: HtmlToMarkdownOptions = {},
): string {
  const ctx: ConvertContext = {
    imageCollector: options.imageCollector,
    collectedSrcs: new Set<string>(),
  };

  const blocks = collectBlocks(root.childNodes, ctx);
  return blocks.join('\n\n').trim();
}

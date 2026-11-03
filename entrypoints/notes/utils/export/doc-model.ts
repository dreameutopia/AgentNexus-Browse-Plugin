/**
 * 笔记正文（Tiptap HTML）→ 导出用文档模型（txt / md 渲染的共享解析层）
 *
 * 设计要点：
 * - 用 DOMParser 解析（笔记页运行在浏览器环境），标签语义映射为稳定的
 *   中间结构，txt / md 渲染器互不依赖正则各自的 HTML 假设；
 * - 未知标签按容器降级遍历、文本节点兜底成段落，任何畸形输入都不会
 *   让导出中断（解析层不抛错，最坏返回空数组）；
 * - 加粗 / 斜体 / 删除线沿树向下继承，链接、行内代码、图片、硬换行
 *   作为独立内联节点保留，供各渲染器选择性使用。
 *
 * DOCX / PDF 不走本模型：DOCX 由 docx/html 官方解析器直读 HTML，
 * PDF 走浏览器打印管线原样渲染 HTML（见 render-docx / render-pdf）。
 */

/** 行内样式标记（沿解析树继承） */
export interface ExportMarks {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
}

export type InlineNode =
  | { type: 'text'; text: string; marks: ExportMarks }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'image'; src: string; alt: string }
  | { type: 'break' };

export type BlockNode =
  | { type: 'heading'; level: number; children: InlineNode[] }
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'list'; ordered: boolean; items: BlockNode[][] }
  | { type: 'blockquote'; children: BlockNode[] }
  | { type: 'codeBlock'; code: string }
  | { type: 'image'; src: string; alt: string }
  | { type: 'hr' };

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const CONTAINER_TAGS = new Set([
  'div',
  'section',
  'article',
  'aside',
  'main',
  'header',
  'footer',
  'figure',
  'figcaption',
  'details',
  'summary',
]);

function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

function elementChildren(parent: Element | Node): Element[] {
  return Array.from(parent.childNodes).filter(isElement);
}

/** 解析块级内容（顶层与 blockquote / li 等容器共用） */
function parseBlocks(parent: Node, marks: ExportMarks): BlockNode[] {
  const blocks: BlockNode[] = [];
  /** 块级游离文本（不在任何块标签内的文字）先攒着，遇到块边界时落成段落 */
  let looseText = '';

  const flushLooseText = () => {
    const text = looseText.replace(/\s+$/, '');
    looseText = '';
    if (text.trim()) {
      blocks.push({ type: 'paragraph', children: parseInlineText(text, marks) });
    }
  };

  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      looseText += node.textContent ?? '';
      continue;
    }
    if (!isElement(node)) continue;

    const tag = node.tagName.toLowerCase();

    if (HEADING_TAGS.has(tag)) {
      flushLooseText();
      blocks.push({
        type: 'heading',
        level: Number(tag.slice(1)),
        children: parseInlines(node, marks),
      });
      continue;
    }

    if (tag === 'p') {
      flushLooseText();
      blocks.push({ type: 'paragraph', children: parseInlines(node, marks) });
      continue;
    }

    if (tag === 'ul' || tag === 'ol') {
      flushLooseText();
      blocks.push({
        type: 'list',
        ordered: tag === 'ol',
        items: elementChildren(node)
          .filter((li) => li.tagName.toLowerCase() === 'li')
          .map((li) => parseBlocks(li, marks)),
      });
      continue;
    }

    if (tag === 'blockquote') {
      flushLooseText();
      const children = parseBlocks(node, marks);
      blocks.push({
        type: 'blockquote',
        children: children.length ? children : [{ type: 'paragraph', children: [] }],
      });
      continue;
    }

    if (tag === 'pre') {
      flushLooseText();
      blocks.push({ type: 'codeBlock', code: (node.textContent ?? '').replace(/\n$/, '') });
      continue;
    }

    if (tag === 'hr') {
      flushLooseText();
      blocks.push({ type: 'hr' });
      continue;
    }

    if (tag === 'img') {
      flushLooseText();
      blocks.push({
        type: 'image',
        src: node.getAttribute('src') ?? '',
        alt: node.getAttribute('alt') ?? '',
      });
      continue;
    }

    if (CONTAINER_TAGS.has(tag) || tag === 'li' || tag === 'dd' || tag === 'td' || tag === 'th') {
      flushLooseText();
      blocks.push(...parseBlocks(node, marks));
      continue;
    }

    // 未知标签：有块级子元素按容器遍历，否则按内联文本收进游离文本
    if (elementChildren(node).some((child) => !isInlineTag(child.tagName.toLowerCase()))) {
      flushLooseText();
      blocks.push(...parseBlocks(node, marks));
    } else {
      looseText += node.textContent ?? '';
    }
  }

  flushLooseText();
  return blocks;
}

const INLINE_TAGS = new Set([
  'a',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'del',
  'strike',
  'code',
  'span',
  'small',
  'sup',
  'sub',
  'mark',
  'font',
  'br',
  'img',
  'ins',
  'kbd',
  'samp',
  'var',
  'abbr',
  'cite',
  'q',
  'time',
  'label',
]);

function isInlineTag(tag: string): boolean {
  return INLINE_TAGS.has(tag);
}

/** 解析内联内容（段落 / 标题等叶子块的子节点） */
function parseInlines(parent: Node, marks: ExportMarks): InlineNode[] {
  const nodes: InlineNode[] = [];

  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (text) nodes.push({ type: 'text', text, marks });
      continue;
    }
    if (!isElement(node)) continue;

    const tag = node.tagName.toLowerCase();
    const text = node.textContent ?? '';

    switch (tag) {
      case 'br':
        nodes.push({ type: 'break' });
        break;
      case 'strong':
      case 'b':
        nodes.push(...parseInlines(node, { ...marks, bold: true }));
        break;
      case 'em':
      case 'i':
        nodes.push(...parseInlines(node, { ...marks, italic: true }));
        break;
      case 's':
      case 'del':
      case 'strike':
        nodes.push(...parseInlines(node, { ...marks, strike: true }));
        break;
      case 'code':
        nodes.push({ type: 'code', text });
        break;
      case 'a': {
        const href = node.getAttribute('href') ?? '';
        const children = parseInlines(node, marks);
        if (href) nodes.push({ type: 'link', href, children });
        else nodes.push(...children);
        break;
      }
      case 'img':
        nodes.push({
          type: 'image',
          src: node.getAttribute('src') ?? '',
          alt: node.getAttribute('alt') ?? '',
        });
        break;
      default:
        // span / sup / sub 等：样式标记已由外层语义标签叠加，直接递归下钻
        nodes.push(...parseInlines(node, marks));
        break;
    }
  }

  return nodes;
}

/** 游离纯文本 → 内联节点（仅文本，无标记来源） */
function parseInlineText(text: string, marks: ExportMarks): InlineNode[] {
  return text ? [{ type: 'text', text, marks }] : [];
}

/**
 * 解析笔记 HTML 为文档模型。
 * 解析失败（无 DOMParser 等极端环境）时返回空数组，绝不抛错。
 */
export function parseNoteHtml(html: string): BlockNode[] {
  if (!html || typeof DOMParser === 'undefined') return [];
  try {
    const dom = new DOMParser().parseFromString(html, 'text/html');
    return parseBlocks(dom.body, {});
  } catch (error) {
    console.warn('[Notes][export] 正文解析失败，按空文档导出:', error);
    return [];
  }
}

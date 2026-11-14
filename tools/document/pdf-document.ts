/**
 * PDF 页面模板：把渲染好的 HTML 正文包成可打印的完整文档
 *
 * ==================== 设计要点 ====================
 *
 * 1. **打印 CSS 而非屏幕 CSS**：这是 PDF 产物与 DOCX 产物排版差异的主要来源。
 *    `@page` 声明纸张与页边距（配合 Page.printToPDF 的 preferCSSPageSize）；
 *    `break-after: avoid` 让标题不与正文分离；表格行、图片、代码块
 *    `break-inside: avoid` 防止跨页断裂（父仓库 PdfRenderer 的 checkPageSpace
 *    是手工分页，浏览器引擎的 CSS 分页更自然且覆盖了同样的诉求）。
 * 2. **矢量图内联**：HTML 里矢量图以占位地址（an-doc-vec-N）出现，
 *    PDF 侧渲染前替换为内联 <svg>——浏览器原生支持内联 SVG，
 *    PDF 里仍是矢量，不栅格化。
 * 3. **公式**：正文里的 KaTeX MathML 由 Chrome 内建 MathML Core 排版，
 *    不需要 KaTeX 的 CSS 与字体文件（避免打包 1.2MB 字体）。
 * 4. **代码高亮**：正文里的 hljs 类名需要对应 CSS 才有颜色。
 *    引入 highlight.js 的 github 主题（仓库已有该依赖）。
 * 5. **中文字体**：走系统字体栈（微软雅黑 / 苹方 / 思源黑体），
 *    零打包体积，且与用户本地 Word 打开 DOCX 时的观感一致。
 */

import type { VectorImage } from './markdown-render';
import { PDF_DEFAULT_MARGIN_INCHES, type PdfPaperSize } from './pdf-protocol';

/** 矢量图占位地址前缀（与 markdown-render.ts 保持一致） */
const VECTOR_IMAGE_ADDRESS_PREFIX = 'an-doc-vec-';

/** 打印样式表（PDF 专用） */
const PRINT_CSS = `
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: #1a1a1a;
  }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC",
                 "Noto Sans CJK SC", "Segoe UI", sans-serif;
    font-size: 11pt;
    line-height: 1.75;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1, h2, h3, h4, h5, h6 {
    font-weight: 600;
    color: #111;
    line-height: 1.35;
    break-after: avoid;
    page-break-after: avoid;
  }
  h1 { font-size: 21pt; margin: 0 0 12pt; padding-bottom: 6pt; border-bottom: 1px solid #e0e0e0; }
  h2 { font-size: 16.5pt; margin: 18pt 0 8pt; }
  h3 { font-size: 13.5pt; margin: 14pt 0 6pt; }
  h4, h5, h6 { font-size: 12pt; margin: 12pt 0 5pt; }
  p { margin: 0 0 9pt; orphans: 3; widows: 3; }
  ul, ol { margin: 0 0 9pt; padding-left: 22pt; }
  li { margin: 0 0 3pt; }
  li > ul, li > ol { margin: 3pt 0; }
  blockquote {
    margin: 10pt 0;
    padding: 2pt 0 2pt 12pt;
    border-left: 2pt solid #d0d0d0;
    color: #555;
    break-inside: avoid;
  }
  code {
    font-family: "Consolas", "SF Mono", "Courier New", monospace;
    font-size: 9.5pt;
    background: #f2f2f2;
    padding: 1pt 3pt;
    border-radius: 2pt;
  }
  pre {
    font-family: "Consolas", "SF Mono", "Courier New", monospace;
    font-size: 9.5pt;
    line-height: 1.55;
    background: #f6f6f6;
    border: 1px solid #e6e6e6;
    border-radius: 3pt;
    padding: 9pt 11pt;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
    break-inside: avoid;
    margin: 0 0 10pt;
  }
  pre code { background: transparent; padding: 0; border-radius: 0; font-size: inherit; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 0 0 11pt;
    font-size: 10pt;
  }
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  th {
    background: #f2f2f2;
    font-weight: 600;
    text-align: left;
    border: 0.5pt solid #c8c8c8;
    padding: 5pt 7pt;
  }
  td {
    border: 0.5pt solid #c8c8c8;
    padding: 5pt 7pt;
    vertical-align: top;
  }
  hr {
    border: none;
    border-top: 0.5pt solid #d8d8d8;
    margin: 14pt 0;
  }
  a { color: #1a1a1a; text-decoration: underline; }
  img { max-width: 100%; height: auto; break-inside: avoid; page-break-inside: avoid; }
  p.md-mermaid { text-align: center; margin: 0 0 11pt; }
  .md-vector-image { display: inline-block; }
  .md-vector-holder {
    display: inline-block;
    max-width: 100%;
    line-height: 0;
  }
  .md-vector-holder svg {
    max-width: 100%;
    height: auto;
  }
  .md-image-fallback { color: #888; font-style: italic; }
  .md-math-display { display: block; text-align: center; margin: 10pt 0; }
  .md-math-inline { display: inline; }
  .md-math-fallback {
    font-family: "Consolas", "SF Mono", monospace;
    color: #555;
    background: #f6f6f6;
    padding: 0 3pt;
  }
`;

/** 页面构建选项 */
export interface PdfPageOptions {
  /** 文档标题（同时作为 <title>） */
  title?: string;
  /** 矢量图表：占位地址 → SVG 原文 */
  vectorImages: Map<string, VectorImage>;
  /** 纸张尺寸（缺省 A4；与 CDP printToPDF 的参数保持一致） */
  paperSize?: PdfPaperSize;
  /** 额外样式（由调用方追加，如封面样式） */
  extraCss?: string;
}

/**
 * @page 规则（随纸张尺寸变化）。
 *
 * 页边距必须与 CDP `Page.printToPDF` 的 margin 参数一致：开了页眉页脚时
 * 浏览器以 CDP 参数为准，@page 的 margin 会被忽略——两处若不同，样式表就会
 * 描述出一个与实际打印结果不符的版式。这里统一用协议层的缺省边距换算。
 */
function buildPageCss(paperSize: PdfPaperSize): string {
  const marginMm = Math.round(PDF_DEFAULT_MARGIN_INCHES * 25.4);
  return `@page {\n    size: ${paperSize};\n    margin: ${marginMm}mm;\n  }`;
}

/**
 * 把 HTML 正文包成完整可打印文档。
 *
 * @param bodyHtml 正文 HTML
 * @param options 标题/矢量图/纸张/额外样式
 */
export function buildPdfDocument(bodyHtml: string, options: PdfPageOptions): string {
  const title = options.title?.trim() || '文档';
  const paperSize: PdfPaperSize = options.paperSize === 'Letter' ? 'Letter' : 'A4';

  // 矢量图占位地址 → 内联 SVG（PDF 里仍是矢量）
  let html = bodyHtml;
  for (const [address, vector] of options.vectorImages) {
    const svg = vector.svg.trim();
    if (!svg) continue;
    html = html.replace(
      new RegExp(`<img[^>]*src="${address}"[^>]*>`, 'g'),
      `<span class="md-vector-holder">${svg}</span>`,
    );
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(title)}</title>
<style>${buildPageCss(paperSize)}
${PRINT_CSS}</style>
${options.extraCss ? `<style>${options.extraCss}</style>` : ''}
</head>
<body>
${html}
</body>
</html>`;
}

/** HTML 文本转义 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

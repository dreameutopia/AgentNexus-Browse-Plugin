/**
 * 笔记 HTML → PDF（导出走浏览器打印管线：打印面板目标选「另存为 PDF」）
 *
 * 选型说明（对比 jsPDF + html2canvas 类方案后确定）：
 * - 打印管线由浏览器排版引擎原样渲染正文：文字可选中可检索、中文字体
 *   与代码块 / 图片 / 列表样式原样保留、分页遵循 CSS 断行规则，文件小；
 * - html2canvas 方案会把整页栅格化成图片：中文靠图片承载、文字不可搜、
 *   长代码行可能被分页切断、清晰度依赖倍率，观感明显更差；
 * - 该行为与 Notion / Obsidian 等笔记应用的「导出 PDF」一致。
 *
 * 实现要点：
 * - 正文渲染进隐藏容器 `.notes-print-doc`，@media print 时页面其余部分
 *   全部隐藏、仅打印容器可见（见 style.css 打印样式）；
 * - 打印前把 document.title 换成笔记标题：Chrome 打印面板默认以文档
 *   标题作为保存文件名，导出的 PDF 即以笔记标题命名；
 * - afterprint 后清理容器并复原标题（Chrome / Firefox / Safari 均会触发，
 *   保存或取消都会触发）；重复调用先清理上一次的残留容器。
 */

const PRINT_ROOT_CLASS = 'notes-print-doc';

export interface PdfExportInput {
  /** 笔记标题（同时作为打印页眉与保存文件名） */
  title: string;
  /** Tiptap 正文 HTML */
  html: string;
  /** 标题下的副信息（如「更新时间 …」），可省略 */
  subtitle?: string;
}

/** 打开打印面板（目标选「另存为 PDF」即完成导出） */
export function exportNoteAsPdf(input: PdfExportInput): void {
  // 清理上一次残留（极端：上一次 afterprint 未触发）
  document.querySelectorAll(`.${PRINT_ROOT_CLASS}`).forEach((el) => el.remove());

  const root = document.createElement('div');
  root.className = PRINT_ROOT_CLASS;

  const title = input.title.trim();
  const subtitle = input.subtitle?.trim();

  const header = document.createElement('header');
  header.className = 'print-doc-header';
  const heading = document.createElement('h1');
  heading.className = 'print-doc-title';
  heading.textContent = title;
  header.appendChild(heading);
  if (subtitle) {
    const meta = document.createElement('p');
    meta.className = 'print-doc-subtitle';
    meta.textContent = subtitle;
    header.appendChild(meta);
  }

  const body = document.createElement('div');
  body.className = 'print-doc-body';
  // 正文来自本页编辑器（自产 HTML），转义仅针对标题等外部拼接字段
  body.innerHTML = input.html || '';

  root.appendChild(header);
  root.appendChild(body);
  document.body.appendChild(root);

  const previousTitle = document.title;
  document.title = title || 'note';
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    window.removeEventListener('afterprint', cleanup);
    root.remove();
    document.title = previousTitle;
  };

  window.addEventListener('afterprint', cleanup);
  window.print();
}

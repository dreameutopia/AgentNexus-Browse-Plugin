/**
 * PDF 渲染通道协议（sidepanel ↔ background 的唯一事实源）
 *
 * ==================== 为什么单独一个模块 ====================
 *
 * 早先两端各写一份消息类型常量与接口定义——看着无害，实则是一颗定时炸弹：
 * 任何一侧改名而另一侧没跟上，PDF 通道会**静默失效**（消息发出去没人应，
 * 表现为「PDF 渲染失败」这种指向不明的结果）。
 *
 * 现在把常量、类型与版面几何全部收敛到这里：
 * - 消息类型常量：两侧引用同一份，不可能漂移；
 * - 纸张尺寸与页边距：PDF 模板里的 `@page` 与 CDP `printToPDF` 的参数
 *   必须一致，否则「样式表声明的页边距」与「实际打印的页边距」会对不上。
 *
 * ==================== 为什么共用它不会拖胖 background ====================
 *
 * 本模块**零依赖**（只有常量与类型），因此 background 侧引用它只是多带
 * 几百字节。真正要避开的是文档工具的重量级依赖（docx / katex / markdown-it /
 * highlight.js 约 2.7MB）：background 是 service worker 入口，Vite 对其强制
 * 内联动态 import，静态可达的重依赖拆不出按需加载的独立 chunk。
 * 本模块不含任何重量级引用，因此共享它是安全的。
 */

/** PDF 渲染消息类型（sidepanel → background） */
export const PDF_RENDER_MESSAGE = 'agentnexus:document-pdf-render';

/** 纸张尺寸 */
export type PdfPaperSize = 'A4' | 'Letter';

/** PDF 渲染请求 */
export interface PdfRenderRequest {
  /** 待渲染的完整 HTML 文档（含 <html>/<head>） */
  html: string;
  /** 纸张尺寸（缺省 A4） */
  paperSize?: PdfPaperSize;
  /** 页边距（英寸，缺省 {@link PDF_DEFAULT_MARGIN_INCHES}） */
  marginInches?: number;
  /** 页眉文本（印在每页顶部） */
  headerText?: string;
  /** 是否显示页码（页脚居中；缺省显示） */
  pageNumbers?: boolean;
}

/** PDF 渲染结果 */
export type PdfRenderResult =
  | { ok: true; base64: string }
  | { ok: false; error: string };

/** 纸张尺寸（英寸） */
export const PDF_PAPER_SIZES: Record<PdfPaperSize, { width: number; height: number }> = {
  A4: { width: 8.27, height: 11.69 },
  Letter: { width: 8.5, height: 11 },
};

/** 缺省页边距（英寸，≈2cm） */
export const PDF_DEFAULT_MARGIN_INCHES = 0.79;

/**
 * 单次 PDF 渲染的 HTML 体积上限（字节）。
 *
 * HTML 经消息通道进入 background，超大文档会把 service worker 的内存打满，
 * 拖垮整个扩展（background 一挂，所有工具都停）。8MB 足以覆盖带图表的长报告。
 */
export const PDF_MAX_HTML_BYTES = 8 * 1024 * 1024;

/** 判定纸张尺寸是否合法（防御外部传入的脏值） */
export function isPdfPaperSize(value: unknown): value is PdfPaperSize {
  return value === 'A4' || value === 'Letter';
}

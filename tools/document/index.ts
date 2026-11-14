/**
 * document 类工具注册
 *
 * ==================== 导出口径 ====================
 *
 * 这里只导出**文档工具自身**的入口与纯函数，不导出 background 侧的
 * PDF 渲染器（@/tools/browser/pdf-renderer）：那是 background 的实现，
 * 从这里转出去会把 CDP 会话管理拖进 sidepanel 的包体，而 sidepanel
 * 只会通过消息通道用它。
 */

import { toolRegistry } from '../registry';
import { DocumentTool } from './document-tool';

export function registerDocumentTools(): void {
  toolRegistry.register(new DocumentTool());
}

export { DocumentTool } from './document-tool';
export { DOCUMENT_TOOL_ID } from './document-tool';
export { renderMarkdownToHtml, isSafeImageProtocol, isSafeLinkProtocol } from './markdown-render';
export type { MarkdownRenderOptions, MarkdownRenderResult, RenderWarning, VectorImage } from './markdown-render';
export { buildDocx } from './docx-builder';
export type { DocxBuildOptions, DocxBuildResult } from './docx-builder';
export { buildPdfDocument } from './pdf-document';
export type { PdfPageOptions } from './pdf-document';
export { createImageResolver, detectImageFormat, isPrivateHost, parseIPv4 } from './image-resolver';
export { renderMermaidToSvg } from './mermaid-renderer';
export { rasterizeToPngDataUrl, svgToPngDataUrl } from './svg-raster';
export { requestPdfRender } from './pdf-client';
export {
  PDF_DEFAULT_MARGIN_INCHES,
  PDF_MAX_HTML_BYTES,
  PDF_PAPER_SIZES,
  PDF_RENDER_MESSAGE,
  isPdfPaperSize,
} from './pdf-protocol';
export type { PdfPaperSize, PdfRenderRequest, PdfRenderResult } from './pdf-protocol';

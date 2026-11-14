/**
 * PDF 渲染通道（background 侧服务端）
 *
 * ==================== 职责 ====================
 *
 * 接收 sidepanel 发来的 HTML，用 CDP `Page.printToPDF` 出图并回传 base64。
 * chrome.debugger 只在 background 可用，因此 PDF 渲染必须在此执行：
 * background 在一个**后台标签页**（active:false）里完成渲染，用户看不到
 * 打印对话框，也看不到打印预览页——产物直接落到会话工作区。
 *
 * 消息类型常量与请求/结果类型来自 tools/document/pdf-protocol.ts（唯一事实源，
 * 两端共用，零依赖；本模块不含重量级依赖，不会把文档工具的 2.7MB 拖进
 * background 主包）。
 */

import {
  PDF_MAX_HTML_BYTES,
  PDF_RENDER_MESSAGE,
  isPdfPaperSize,
  type PdfRenderRequest,
  type PdfRenderResult,
} from '@/tools/document/pdf-protocol';

export { PDF_RENDER_MESSAGE };
export type { PdfRenderRequest, PdfRenderResult };

/** 体积上限的可读表述（MB） */
const HTML_SIZE_LIMIT_MB = PDF_MAX_HTML_BYTES / (1024 * 1024);

/**
 * 在 background 侧注册 PDF 渲染通道。
 * 返回值是注销函数（测试与热重载用）。
 */
export function initPdfRenderChannel(): () => void {
  const listener = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean | undefined => {
    const request = message as Partial<PdfRenderRequest> & { type?: string } | undefined;
    if (request?.type !== PDF_RENDER_MESSAGE) return undefined;

    void (async () => {
      try {
        const html = typeof request.html === 'string' ? request.html : '';
        if (!html.trim()) {
          sendResponse({ ok: false, error: '待渲染的 HTML 为空' });
          return;
        }
        // 体积护栏：超大文档会打满 service worker 内存，拖垮整个扩展
        if (html.length > PDF_MAX_HTML_BYTES) {
          sendResponse({
            ok: false,
            error: `待渲染的 HTML 超过上限 ${Math.round(HTML_SIZE_LIMIT_MB)}MB，请拆分文档后再导出`,
          });
          return;
        }
        const { renderHtmlToPdf } = await import('@/tools/browser/pdf-renderer');
        const result: PdfRenderResult = await renderHtmlToPdf({
          html,
          paperSize: isPdfPaperSize(request.paperSize) ? request.paperSize : undefined,
          marginInches: typeof request.marginInches === 'number' ? request.marginInches : undefined,
          headerText: typeof request.headerText === 'string' ? request.headerText : undefined,
          pageNumbers: typeof request.pageNumbers === 'boolean' ? request.pageNumbers : undefined,
        });
        sendResponse(result);
      } catch (error) {
        sendResponse({
          ok: false,
          error: `PDF 渲染异常：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    })();
    return true; // 异步应答
  };

  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

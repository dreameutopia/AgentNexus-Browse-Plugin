/**
 * PDF 渲染客户端（sidepanel 等非 background 上下文）
 *
 * ==================== 为什么单独一个模块 ====================
 *
 * PDF 走 CDP `Page.printToPDF`（浏览器打印引擎：矢量文字可选中、中文系统
 * 字体直出、CSS 分页完整），而 chrome.debugger **只在 background 可用**。
 * 因此 sidepanel 侧要把 HTML 交给 background 渲染，本模块就是这个通道的
 * 客户端。
 *
 * 与后台侧（tools/browser/pdf-channel.ts）的分工：
 * - 本模块（客户端）：发消息、等结果、失败降级；
 * - pdf-channel（服务端）：background 侧监听消息并调用 CDP 渲染。
 *
 * 消息类型常量与请求/结果类型来自 tools/document/pdf-protocol.ts（唯一事实源，
 * 两端共用，零依赖）。
 */

import {
  PDF_RENDER_MESSAGE,
  type PdfRenderRequest,
  type PdfRenderResult,
} from './pdf-protocol';

export type { PdfRenderRequest, PdfRenderResult };

/**
 * 请求 background 渲染 PDF。
 *
 * @param request 渲染请求
 * @returns 成功返回 base64 PDF；失败返回可读原因（不抛错）
 */
export async function requestPdfRender(request: PdfRenderRequest): Promise<PdfRenderResult> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return { ok: false, error: '当前环境无法调用后台渲染通道' };
  }
  try {
    const response = await chrome.runtime.sendMessage({
      ...request,
      type: PDF_RENDER_MESSAGE,
    });
    if (!response || typeof response !== 'object') {
      return { ok: false, error: '后台未返回渲染结果（通道可能未就绪）' };
    }
    const result = response as PdfRenderResult;
    if (result.ok && typeof result.base64 === 'string') return result;
    return { ok: false, error: result.ok ? '后台返回的渲染结果缺少内容' : result.error };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `调用后台渲染通道失败：${message}` };
  }
}

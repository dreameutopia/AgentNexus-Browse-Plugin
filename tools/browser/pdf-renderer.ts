/**
 * HTML → PDF 渲染器（后台执行，全程无可见打印页面）
 *
 * ==================== 为什么走 CDP Page.printToPDF ====================
 *
 * 候选路径与取舍（2026-11 调研结论）：
 *
 * | 路径 | 质量 | 用户可见性 | 结论 |
 * |---|---|---|---|
 * | **chrome.debugger + Page.printToPDF** | ★★★★★ 矢量文字可选中、系统字体直接可用（中文零打包）、CSS 分页/页眉页脚齐全 | 仅一条 5 秒自动消失的调试提示条，**无打印对话框、无打印预览页** | **采用** |
 * | offscreen + window.print() | — | offscreen 是隐藏文档，打印管线走不通 | 排除 |
 * | chrome.printing | — | 仅 ChromeOS，且无 printToPDF | 排除 |
 * | jsPDF / pdfmake + 内嵌中文字体 | ★★☆～★★★☆ | 静默 | 次选：需打包 1-2MB 字体子集，且排版能力远弱于浏览器引擎 |
 * | Typst WASM | ★★★★★ | 静默 | 次选：+11MB wasm 体积，md→typst 需自写映射 |
 * | html2canvas + jsPDF（栅格化） | ★☆☆☆☆ | 静默 | 排除：文字不可选、发糊、分页差 |
 *
 * 浏览器打印引擎 = 与 Chrome「另存为 PDF」同一条渲染路径，矢量文字、
 * 可选中、可搜索、中文系统字体直出，产物与用户手动另存一致。
 *
 * ==================== 执行要点 ====================
 *
 * 1. **后台执行**：chrome.debugger 只在 background/service worker 可用
 *    （见 tools/browser/cdp-session.ts 的 isSupported 说明）。因此本模块
 *    由 background 侧调用，经消息协议把 HTML 送进去、取回 base64 PDF。
 * 2. **不弹窗**：用 chrome.tabs.create 建一个**后台标签页**（active:false），
 *    把 HTML 以 data: URL 载入后调 Page.printToPDF，再关掉标签页。
 *    全程没有 window.print()，用户看不到打印对话框，也看不到打印预览页。
 * 3. **不打扰用户**：标签页建在最后聚焦的普通窗口且不激活；渲染完成后立即
 *    关闭。若 CDP 附加失败（标签页被占用/被 DevTools 抢占），降级为明确报错。
 * 4. **页面就绪**：用 Runtime.evaluate 轮询 document.readyState 与
 *    document.fonts.ready，确保 KaTeX 字体与图片都已就绪再打印，避免空白页。
 * 5. **矢量图**：HTML 里矢量图以占位地址出现，PDF 侧渲染前先替换为内联 SVG
 *    （浏览器原生支持 SVG 内联，PDF 里仍是矢量，不栅格化）。
 * 6. **分页控制**：@page 声明纸张与页边距，CSS 控制标题不与正文分离、
 *    表格与图片不跨页断裂。
 */

import { cdpSession } from '@/tools/browser/cdp-session';
import {
  PDF_DEFAULT_MARGIN_INCHES,
  PDF_MAX_HTML_BYTES,
  PDF_PAPER_SIZES,
  isPdfPaperSize,
  type PdfRenderRequest,
  type PdfRenderResult,
} from '@/tools/document/pdf-protocol';

export type { PdfRenderRequest, PdfRenderResult };

/** 页面就绪轮询超时（毫秒） */
const PAGE_READY_TIMEOUT_MS = 20_000;

/** 页面就绪轮询间隔（毫秒） */
const PAGE_READY_POLL_MS = 120;

/**
 * 页眉页脚模板的上下留白（毫米）。
 *
 * CDP 的 header/footer 模板被渲染在页边距带内，紧贴页面边缘（默认 0 边距）
 * 会在部分阅读器里被裁掉，因此留出 10mm——正好落在 20mm 页边距带的中部。
 */
const HEADER_FOOTER_INSET_MM = 10;

/**
 * 渲染 HTML 为 PDF（base64）。
 *
 * @param request 渲染请求
 * @returns 成功返回 base64 PDF；失败返回可读原因（不抛错）
 */
export async function renderHtmlToPdf(request: PdfRenderRequest): Promise<PdfRenderResult> {
  if (!request.html || !request.html.trim()) {
    return { ok: false, error: '待渲染的 HTML 为空' };
  }
  if (request.html.length > PDF_MAX_HTML_BYTES) {
    return {
      ok: false,
      error: `待渲染的 HTML 超过上限 ${Math.round(PDF_MAX_HTML_BYTES / (1024 * 1024))}MB，请拆分文档后再导出`,
    };
  }

  // chrome.debugger 只在 background 可用；本模块只在 background 侧调用
  // （sidepanel 侧经 pdf-channel 的消息通道转交过来）。
  if (typeof chrome === 'undefined' || !chrome.debugger || !chrome.tabs) {
    return { ok: false, error: '当前上下文不支持 CDP（chrome.debugger 仅在后台可用）' };
  }

  const paperSize = isPdfPaperSize(request.paperSize) ? request.paperSize : 'A4';
  const paper = PDF_PAPER_SIZES[paperSize];
  const margin = normalizeMargin(request.marginInches);

  let tabId: number | undefined;
  try {
    // 1. 准备一个渲染用标签页（不激活，用户无感）
    tabId = await acquireRenderTab();
    if (typeof tabId !== 'number') {
      return { ok: false, error: '创建渲染标签页失败：未获得标签页 id' };
    }

    // 2. 附加 CDP 会话
    await cdpSession.attach(tabId);

    // 3. 载入 HTML：Page.setDocumentContent 直接替换文档内容，
    //    比导航到 data: URL 更快，也避免超长 data: URL 的长度问题。
    const frameId = await resolveMainFrameId(tabId);
    await sendCommand(tabId, 'Page.setDocumentContent', { frameId, html: request.html });

    // 4. 等待页面就绪（字体 + 图片加载完成）
    const ready = await waitForPageReady(tabId);
    if (!ready) {
      return { ok: false, error: '页面资源未能在时限内就绪（字体或图片加载超时）' };
    }

    // 5. 打印为 PDF
    const result = await sendCommand(tabId, 'Page.printToPDF', {
      landscape: false,
      printBackground: true,
      preferCSSPageSize: true,
      paperWidth: paper.width,
      paperHeight: paper.height,
      marginTop: margin,
      marginBottom: margin,
      marginLeft: margin,
      marginRight: margin,
      displayHeaderFooter: Boolean(request.headerText || request.pageNumbers !== false),
      headerTemplate: request.headerText
        ? `<div style="font-size:8px;width:100%;text-align:center;color:#888;margin-top:${HEADER_FOOTER_INSET_MM}mm;">${escapeHtmlForTemplate(request.headerText)}</div>`
        : undefined,
      footerTemplate:
        request.pageNumbers !== false
          ? `<div style="font-size:8px;width:100%;text-align:center;color:#888;margin-bottom:${HEADER_FOOTER_INSET_MM}mm;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`
          : undefined,
      transferMode: 'ReturnAsBase64',
    });

    const base64 = typeof result?.data === 'string' ? result.data : '';
    if (!base64) {
      return { ok: false, error: 'Page.printToPDF 未返回数据' };
    }
    return { ok: true, base64 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `PDF 渲染失败：${message}` };
  } finally {
    // 6. 清理：脱离 CDP 并关闭临时标签页（无论成功失败）
    if (tabId !== undefined) {
      try {
        await cdpSession.detach(tabId);
      } catch {
        // 脱离失败不影响主流程
      }
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // 标签页可能已被用户关闭
      }
    }
  }
}

/**
 * 归一化页边距（英寸）。
 *
 * CDP 只接受有限的正数：0 会被当成无边距（内容顶到纸边），负数与 NaN 会让
 * 打印命令直接报错。这里收敛到 [0.2, 2] 英寸。
 */
function normalizeMargin(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PDF_DEFAULT_MARGIN_INCHES;
  return Math.min(2, Math.max(0.2, value));
}

/**
 * 取得渲染用标签页。
 *
 * 刻意**新建**一个后台标签页，而不是复用用户已有的空白标签页：
 * 复用会把用户标签页的内容替换成文档，事后无法还原——那是擅自改动用户
 * 状态。新建的标签页不激活（用户看不到焦点被抢走），渲染结束即删除，
 * 全程没有打印对话框，也没有打印预览页。
 */
async function acquireRenderTab(): Promise<number | undefined> {
  const created = await chrome.tabs.create({ url: 'about:blank', active: false });
  return created.id;
}

/** 取标签页主框架 id（Page.setDocumentContent 需要） */
async function resolveMainFrameId(tabId: number): Promise<string> {
  const tree = await sendCommand(tabId, 'Page.getFrameTree', {});
  const frameId = tree?.frameTree?.frame?.id;
  if (typeof frameId !== 'string' || !frameId) {
    throw new Error('无法获取页面主框架 id');
  }
  return frameId;
}

/**
 * 等待页面就绪：document.readyState 为 complete 且字体已就绪。
 * 用 Runtime.evaluate 轮询（awaitPromise + fonts.ready）。
 */
async function waitForPageReady(tabId: number): Promise<boolean> {
  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const result = await sendCommand(tabId, 'Runtime.evaluate', {
        expression: `(() => {
          const images = Array.from(document.images || []);
          const pending = images.filter((img) => !img.complete).length;
          return {
            ready: document.readyState === 'complete',
            pendingImages: pending,
            fontsPending: document.fonts ? document.fonts.status !== 'loaded' : false,
          };
        })()`,
        returnByValue: true,
      });
      const value = result?.result?.value;
      if (value?.ready && !value.pendingImages && !value.fontsPending) {
        return true;
      }
    } catch {
      // 页面正在导航或已被关闭：继续轮询直到超时
    }
    await new Promise((resolve) => setTimeout(resolve, PAGE_READY_POLL_MS));
  }
  return false;
}

/** 发送 CDP 命令（带超时保护，避免后台无限等待） */
async function sendCommand(tabId: number, method: string, params: Record<string, unknown>): Promise<any> {
  const timeout = method === 'Page.printToPDF' ? 60_000 : 15_000;
  return Promise.race([
    chrome.debugger.sendCommand({ tabId }, method, params),
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${method} 超时（${timeout}ms）`)), timeout),
    ),
  ]);
}

/** 页眉模板的 HTML 转义（页眉文本会进 HTML 模板） */
function escapeHtmlForTemplate(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

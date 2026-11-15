/**
 * HTML 预览沙箱页（html-preview-sandbox.html）
 *
 * 本页面经 manifest "sandbox.pages" 声明（见 wxt.config.ts），由 Chrome 以
 * 独立源加载：无法访问任何 chrome.* 扩展 API、扩展存储与侧边栏 DOM。
 * 页面 CSP 由 content_security_policy.sandbox 指定——允许内联脚本与 eval，
 * 因此模型生成的 HTML（图表、交互脚本）能完整运行，而影响半径被限制在本页。
 *
 * 与父页（entrypoints/file-preview/main.ts）的消息协议：
 *   父 → 沙箱：{ source: 'an-file-preview-parent', type: 'render', html }
 *   沙箱 → 父：{ source: 'an-html-preview-sandbox', type: 'ready' }
 *             { source: 'an-html-preview-sandbox', type: 'rendered' }
 *             { source: 'an-html-preview-sandbox', type: 'error', message }
 *
 * 防御要点：
 *   - 只接受 window.parent 发来的消息，并校验 source 白名单与字段类型；
 *   - html 只作为 document.write 的文本入参，不参与任何模板 / eval 拼装；
 *   - document.open() 重置整个文档（本脚本与其监听器随之卸载），
 *     渲染完成后页面内不存在可被后续消息触达的长期入口；
 *   - 异常一律以 'error' 消息回传父页，由父页降级为错误文案。
 */

const PARENT_SOURCE = 'an-file-preview-parent';
const SANDBOX_SOURCE = 'an-html-preview-sandbox';

function post(type: string, payload: Record<string, unknown> = {}): void {
  try {
    window.parent.postMessage({ source: SANDBOX_SOURCE, type, ...payload }, '*');
  } catch (error) {
    console.warn('[HtmlPreviewSandbox] postMessage 发送失败:', error);
  }
}

function render(html: string): void {
  try {
    document.open();
    document.write(html);
    document.close();
    post('rendered');
  } catch (error) {
    post('error', { message: error instanceof Error ? error.message : String(error) });
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return;
  const data = event.data as { source?: unknown; type?: unknown; html?: unknown } | null;
  if (!data || data.source !== PARENT_SOURCE || data.type !== 'render') return;
  if (typeof data.html !== 'string') {
    post('error', { message: '预览内容必须是字符串' });
    return;
  }
  render(data.html);
});

// 就绪信号：父页据此下发待渲染的 HTML（父页监听器先于 iframe 建立）
post('ready');

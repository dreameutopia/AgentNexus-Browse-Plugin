/**
 * 工作区文件预览页（独立标签页，由文件卡片的「预览」按钮打开）
 *
 * URL 契约：file-preview.html?chat=<chatId>&path=<工作区相对路径>
 *   - chat / path 均按工作区契约校验；非 outputs/ 与 inputs/ 路径、或未知扩展名
 *     直接给出错误文案；
 *   - PDF：以 blob URL 交给浏览器内置阅读器（iframe 内展示，标签页 URL 保持稳定）；
 *   - HTML：交给 manifest 沙箱页（html-preview-sandbox）渲染 —— 模型生成的
 *     HTML 属于不可信内容：沙箱页以独立源加载，既能让页面自己的脚本运行，
 *     又不可能触达扩展存储 / chrome.* API（消费方见 html-preview-sandbox/main.ts）。
 *
 * 设计约束：
 *   - 本页只读当前会话工作区（读通道内部再次校验 outputs/ 与 inputs/ 前缀）；
 *   - 所有来自 URL / 文件名的文本只经 textContent 上屏，不拼 HTML；
 *   - 任何失败都落在可读的错误文案上，绝不白屏。
 */

import './style.css';
import { applyDomI18n, initLocale, t } from '@/utils/i18n/core';
import { isWorkspaceOutput, isWorkspaceUpload } from '@/utils/python-workspace/paths';
import { readWorkspaceOutput, readWorkspaceUpload } from '@/utils/python-workspace/store';

/** 预览渲染方式：pdf → 内置阅读器；html → 沙箱页 */
type PreviewKind = 'pdf' | 'html';

const PREVIEW_KIND_BY_EXTENSION: Readonly<Record<string, PreviewKind>> = {
  pdf: 'pdf',
  html: 'html',
  htm: 'html',
};

/** 沙箱页 URL（manifest sandbox.pages 声明，输出名见 wxt.config.ts） */
const HTML_SANDBOX_PAGE = 'html-preview-sandbox.html';

/** 与 entrypoints/html-preview-sandbox/main.ts 严格对齐的消息协议 */
const PREVIEW_SOURCE = 'an-file-preview-parent';
const SANDBOX_SOURCE = 'an-html-preview-sandbox';

/** 沙箱页就绪 / 渲染超时：超时即降级为错误文案，绝不无限等待 */
const SANDBOX_TIMEOUT_MS = 15_000;

const statusEl = document.getElementById('preview-status') as HTMLElement | null;
const hostEl = document.getElementById('preview-host') as HTMLElement | null;

function previewKindOf(path: string): PreviewKind | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return PREVIEW_KIND_BY_EXTENSION[path.slice(dot + 1).toLowerCase()] ?? null;
}

function showMessage(message: string, isError = false): void {
  hostEl?.replaceChildren();
  if (hostEl) hostEl.hidden = true;
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.hidden = false;
  statusEl.classList.toggle('is-error', isError);
}

function showFailure(message: string): void {
  showMessage(t('sidepanel.chat.filePreviewFailed', { message }), true);
}

function mountFrame(frame: HTMLIFrameElement): void {
  if (!hostEl) return;
  hostEl.replaceChildren(frame);
  hostEl.hidden = false;
  if (statusEl) statusEl.hidden = true;
}

/** PDF：显式标注 MIME，保证浏览器走内置阅读器而不是纯文本展示 / 下载 */
function renderPdf(blob: Blob, title: string): void {
  const url = URL.createObjectURL(
    blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' }),
  );
  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.title = title;
  frame.src = url;
  // 展示期间撤销会让阅读器白屏，只在页面关闭时回收
  window.addEventListener('pagehide', () => URL.revokeObjectURL(url), { once: true });
  mountFrame(frame);
}

/**
 * HTML：文本交给沙箱页 document.write 渲染。
 * 沙箱页完成渲染或报错都会回消息；父页只做一次性等待，失败即收掉 iframe。
 */
async function renderHtml(blob: Blob, title: string): Promise<void> {
  const html = await blob.text();
  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.title = title;

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('沙箱页响应超时')),
      SANDBOX_TIMEOUT_MS,
    );

    function cleanup(): void {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    }

    function onMessage(event: MessageEvent): void {
      if (event.source !== frame.contentWindow) return;
      const data = event.data as { source?: unknown; type?: unknown; message?: unknown } | null;
      if (!data || data.source !== SANDBOX_SOURCE) return;
      if (data.type === 'ready') {
        frame.contentWindow?.postMessage({ source: PREVIEW_SOURCE, type: 'render', html }, '*');
        return;
      }
      if (data.type === 'rendered') {
        cleanup();
        resolve();
        return;
      }
      if (data.type === 'error') {
        cleanup();
        reject(new Error(
          typeof data.message === 'string' && data.message ? data.message : '沙箱渲染失败',
        ));
      }
    }

    // 监听器先于 src 建立：沙箱页的 ready 消息不会早于本监听丢帧
    window.addEventListener('message', onMessage);
    frame.src = chrome.runtime.getURL(HTML_SANDBOX_PAGE);
    mountFrame(frame);
  }).catch((error: unknown) => {
    frame.remove();
    throw error;
  });
}

async function renderPreview(): Promise<void> {
  await initLocale();
  applyDomI18n();

  const params = new URLSearchParams(location.search);
  const chatId = params.get('chat') ?? '';
  const path = params.get('path') ?? '';
  const name = path.slice(path.lastIndexOf('/') + 1);
  document.title = name
    ? `${name} - ${t('sidepanel.chat.filePreviewTitle')}`
    : t('sidepanel.chat.filePreviewTitle');

  // 可预览范围：交付物（outputs/）与用户上传文件（inputs/）
  const readable = isWorkspaceOutput(path) || isWorkspaceUpload(path);
  const kind = chatId && readable ? previewKindOf(path) : null;
  if (!kind) {
    showMessage(t('sidepanel.chat.filePreviewUnsupported'), true);
    return;
  }

  let blob: Blob | null;
  try {
    blob = isWorkspaceUpload(path)
      ? await readWorkspaceUpload(chatId, path)
      : await readWorkspaceOutput(chatId, path);
  } catch (error) {
    showFailure(error instanceof Error ? error.message : String(error));
    return;
  }
  if (!blob) {
    showMessage(t('sidepanel.chat.filePreviewMissing'), true);
    return;
  }

  try {
    if (kind === 'pdf') renderPdf(blob, name);
    else await renderHtml(blob, name);
  } catch (error) {
    showFailure(error instanceof Error ? error.message : String(error));
  }
}

void renderPreview();

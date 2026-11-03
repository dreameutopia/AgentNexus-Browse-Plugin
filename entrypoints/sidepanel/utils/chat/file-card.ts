/**
 * 聊天文件卡片：[file:ID|文件名] 标记 → 可下载文件卡片
 *
 * 组成：
 * - renderFileCards(html)：渲染后处理，把 AI 回复中的文件标记替换为卡片 HTML
 *   （跳过 <pre>/<code> 代码段，避免代码示例中的标记被误渲染）；
 * - installFileCardHandler()：document 级事件委托（点击/键盘），解析文件并触发下载，
 *   覆盖聊天列表、历史抽屉等一切经 markdown 渲染输出卡片的容器。
 *
 * 文件解析顺序：fileManager 内存缓存 → chrome.storage 兜底
 * （文件可能由 background 上下文写入，本上下文的内存表尚未包含）。
 */

import { fileManager, type ManagedFile } from '@/utils/file-manager';
import { escapeHtml } from './html-escape';

/** 文件标记：[file:8位ID] 或 [file:8位ID|文件名]（ID 字符集与 fileManager 一致） */
const FILE_MARKER_RE = /\[file:([A-Za-z0-9]{8})(?:\|([^[\]<>]{1,120}))?\]/g;

/** 代码段（渲染产物中的 <pre>/<code>），其中的标记不处理 */
const CODE_SEGMENT_RE = /(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/g;

const FILE_MANAGER_STORAGE_KEY = 'file_manager_files';

/**
 * 还原 Markdown 渲染阶段对文本做的实体转义。
 * 文件名来自模型输出，经 markdown-it 后 & < > " 会被转义为实体；
 * 直接使用会把 "&amp;" 原样显示给用户，必须先还原再转义一次。
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

const XLSX_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<rect x="4" y="2.5" width="16" height="19" rx="2" fill="#E8F5E9" stroke="#2E7D32" stroke-width="1.4"/>' +
  '<rect x="7" y="7" width="10" height="2" rx="0.5" fill="#2E7D32"/>' +
  '<rect x="7" y="11" width="4.4" height="2" rx="0.5" fill="#66BB6A"/>' +
  '<rect x="12.6" y="11" width="4.4" height="2" rx="0.5" fill="#66BB6A"/>' +
  '<rect x="7" y="15" width="4.4" height="2" rx="0.5" fill="#66BB6A"/>' +
  '<rect x="12.6" y="15" width="4.4" height="2" rx="0.5" fill="#66BB6A"/>' +
  '</svg>';

function buildCardHtml(fileId: string, displayName?: string): string {
  const name = decodeHtmlEntities(displayName ?? '').trim() || `文件 ${fileId}`;
  const safeName = escapeHtml(name);
  return (
    `<span class="file-card" data-file-id="${fileId}"` +
    (displayName ? ` data-file-name="${safeName}"` : '') +
    ` role="button" tabindex="0" title="下载 ${safeName}">` +
    `<span class="file-card-icon">${XLSX_ICON_SVG}</span>` +
    '<span class="file-card-info">' +
    `<span class="file-card-name">${safeName}</span>` +
    '<span class="file-card-hint">点击下载</span>' +
    '</span></span>'
  );
}

/** 把 HTML 中的文件标记替换为文件卡片（代码段跳过；无标记时原样返回） */
export function renderFileCards(html: string): string {
  if (!html.includes('[file:')) return html;
  const segments = html.split(CODE_SEGMENT_RE);
  return segments
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(FILE_MARKER_RE, (_match, id: string, name?: string) => buildCardHtml(id, name)),
    )
    .join('');
}

// ──────────────────────────── 下载（事件委托） ────────────────────────────

/** 解析文件记录：内存缓存 → chrome.storage 兜底（跨上下文写入场景） */
async function resolveFile(fileId: string): Promise<ManagedFile | null> {
  const cached = await fileManager.getFile(fileId);
  if (cached) return cached;
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
    const stored = (await chrome.storage.local.get(FILE_MANAGER_STORAGE_KEY)) as Record<
      string,
      unknown
    >;
    const files = stored?.[FILE_MANAGER_STORAGE_KEY];
    if (!files || typeof files !== 'object') return null;
    const record = (files as Record<string, unknown>)[fileId];
    if (!record || typeof record !== 'object') return null;
    const candidate = record as Partial<ManagedFile>;
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return null;
    return candidate as ManagedFile;
  } catch (error) {
    console.warn('[FileCard] chrome.storage 兜底读取失败:', error);
    return null;
  }
}

function setHint(card: HTMLElement, text: string): void {
  const hint = card.querySelector('.file-card-hint');
  if (hint) hint.textContent = text;
}

function backfillName(card: HTMLElement, name: string): void {
  if (card.dataset.fileName) return;
  card.dataset.fileName = name;
  const nameEl = card.querySelector('.file-card-name');
  if (nameEl) nameEl.textContent = name;
  card.title = `下载 ${name}`;
}

async function handleCardClick(card: HTMLElement): Promise<void> {
  const fileId = card.dataset.fileId;
  if (!fileId || card.classList.contains('is-downloading')) return;

  card.classList.add('is-downloading');
  setHint(card, '下载中…');
  try {
    const record = await resolveFile(fileId);
    if (!record) {
      card.classList.remove('is-downloading');
      card.classList.add('is-missing');
      setHint(card, '文件已过期或被清理');
      return;
    }
    backfillName(card, record.name);

    const blob = new Blob([record.content], { type: record.type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = record.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);

    card.classList.remove('is-downloading');
    card.classList.add('is-done');
    setHint(card, '已开始下载 ✓');
    window.setTimeout(() => {
      card.classList.remove('is-done');
      if (!card.classList.contains('is-missing')) setHint(card, '点击下载');
    }, 2500);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[FileCard] 文件下载失败:', message);
    card.classList.remove('is-downloading');
    card.classList.add('is-missing');
    setHint(card, `下载失败：${message.slice(0, 80)}`);
  }
}

let handlerInstalled = false;

/** 安装 document 级文件卡片点击/键盘委托（幂等；仅 DOM 上下文生效） */
export function installFileCardHandler(): void {
  if (handlerInstalled || typeof document === 'undefined') return;
  handlerInstalled = true;

  document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const card = target?.closest?.('.file-card') as HTMLElement | null;
    if (!card) return;
    void handleCardClick(card);
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target as HTMLElement | null;
    const card = target?.closest?.('.file-card') as HTMLElement | null;
    if (!card) return;
    event.preventDefault();
    void handleCardClick(card);
  });
}

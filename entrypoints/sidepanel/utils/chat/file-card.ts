/**
 * 聊天文件卡片：当前会话的 workspace-file 标记 → 可下载文件卡片
 *
 * 组成：
 * - 文件标记在 Markdown 语法层识别，避免在链接属性或代码中注入卡片；
 * - installFileCardHandler()：document 级事件委托（点击/键盘），解析文件并触发下载，
 *   覆盖聊天列表、历史抽屉等一切经 markdown 渲染输出卡片的容器。
 *
 * 点击后按需读取当前会话工作区的 outputs/ 文件。
 */

import { escapeHtml } from './html-escape';
import { isWorkspaceOutput } from '@/utils/python-workspace/paths';
import { readWorkspaceOutput } from '@/utils/python-workspace/store';
import type MarkdownIt from 'markdown-it';

const WORKSPACE_TAG_RE = /<workspace-file[ \t]+path=(?:"([^"<>\r\n]{1,12288})"|'([^'<>\r\n]{1,12288})')[ \t]*\/>/g;

export function protectWorkspaceFileTags(source: string, protect: (tag: string) => string): string {
  return source.replace(WORKSPACE_TAG_RE, protect);
}

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

const FILE_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">' +
  '<path d="M6 3h8l4 4v14H6z M14 3v5h4 M12 10v7m-3-3 3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
  '</svg>';

function cardHtml(attributes: string, safeName: string, icon: string): string {
  return (
    `<span class="file-card" ${attributes}` +
    ` role="button" tabindex="0" title="下载 ${safeName}">` +
    `<span class="file-card-icon">${icon}</span>` +
    '<span class="file-card-info">' +
    `<span class="file-card-name">${safeName}</span>` +
    '<span class="file-card-hint">点击下载</span>' +
    '</span></span>'
  );
}

function buildWorkspaceCardHtml(path: string, chatId: string): string {
  const name = escapeHtml(path.slice(path.lastIndexOf('/') + 1));
  const attrs = `data-workspace-path="${escapeHtml(path)}" data-workspace-chat="${escapeHtml(chatId)}"`;
  return cardHtml(attrs, name, /\.xlsx$/i.test(path) ? XLSX_ICON_SVG : FILE_ICON_SVG);
}

/** Only recognize file references as text tokens. Raw HTML remains disabled. */
export function installFileCardSyntax(md: MarkdownIt): void {
  const tag = new RegExp('^' + WORKSPACE_TAG_RE.source);
  md.inline.ruler.before('link', 'file_card', (state, silent) => {
    if (silent || (state as typeof state & { linkLevel: number }).linkLevel > 0) return false;
    if (typeof state.env?.workspaceChatId !== 'string' || !state.env.workspaceChatId ||
        !state.src.startsWith('<workspace-file', state.pos)) return false;
    const match = tag.exec(state.src.slice(state.pos, Math.min(state.posMax, state.pos + 12350)));
    if (!match) return false;
    const path = md.utils.unescapeAll(match[1] ?? match[2]);
    if (!isWorkspaceOutput(path)) return false;
    state.push('workspace_file', '', 0).content = path;
    state.pos += match[0].length;
    return true;
  });
  md.renderer.rules.workspace_file = (tokens, index, _options, env) =>
    buildWorkspaceCardHtml(tokens[index].content, env.workspaceChatId);
}

/** Plain-text rendering follows the same file protocol, with all other text escaped. */
export function renderPlainFileCards(text: string, chatId?: string): string {
  const marker = new RegExp(WORKSPACE_TAG_RE.source, 'g');
  let result = '', offset = 0;
  for (const match of text.matchAll(marker)) {
    result += escapeHtml(text.slice(offset, match.index));
    {
      const path = decodeHtmlEntities(match[1] ?? match[2]);
      if (chatId && isWorkspaceOutput(path)) {
        result += buildWorkspaceCardHtml(path, chatId);
      } else result += escapeHtml(match[0]);
    }
    offset = match.index! + match[0].length;
  }
  return result + escapeHtml(text.slice(offset));
}

// ──────────────────────────── 下载（事件委托） ────────────────────────────

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
  const { workspaceChat, workspacePath } = card.dataset;
  if (!(workspaceChat && workspacePath) || card.classList.contains('is-downloading')) return;

  card.classList.add('is-downloading');
  card.classList.remove('is-missing', 'is-done');
  setHint(card, '下载中…');
  try {
    const file = await resolveDownload(workspaceChat, workspacePath);
    if (!file) {
      card.classList.remove('is-downloading');
      card.classList.add('is-missing');
      setHint(card, '文件已过期或被清理');
      return;
    }
    backfillName(card, file.name);
    const url = URL.createObjectURL(file.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    try {
      document.body.appendChild(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    card.classList.remove('is-downloading');
    card.classList.add('is-done');
    setHint(card, '已开始下载 ✓');
    window.setTimeout(() => {
      card.classList.remove('is-done');
      if (!card.classList.contains('is-missing') && !card.classList.contains('is-downloading')) {
        setHint(card, '点击下载');
      }
    }, 2500);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[FileCard] 文件下载失败:', message);
    card.classList.remove('is-downloading');
    card.classList.add('is-missing');
    setHint(card, `下载失败：${message.slice(0, 80)}`);
  }
}

async function resolveDownload(
  chatId?: string,
  path?: string,
): Promise<{ name: string; blob: Blob } | null> {
  if (!chatId || !path) return null;
  const blob = await readWorkspaceOutput(chatId, path);
  return blob ? { name: path.slice(path.lastIndexOf('/') + 1), blob } : null;
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

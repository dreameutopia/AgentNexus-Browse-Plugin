/**
 * 工具审批弹窗文案分档预览：把每个原因档位的真实标题/正文渲染出来。
 *
 * 文案取自生产路径（approval-copy.ts 选 key + utils/i18n/core 渲染），
 * 预览稿因此不会与线上漂移；弹窗结构/样式直接 link 生产的 app-dialog.css。
 *
 * 覆盖的分档（含 detail 缺失的降级路径——那条路径漏配会渲染出字面 {detail}）：
 *   dependency-install 有包名 / 未列包名
 *   action             delete
 *   confirm            命中字段 / confirm=true 无字段
 *   plugin-session / plugin-call
 *   tool / unknown
 *
 * 打包：node .preview/build-tool-approval-preview.mjs
 * 打开：node .preview/server.mjs . 4173 → /.preview/tool-approval-preview.html
 */
import { selectToolApprovalCopy, type ToolApprovalCopyInput } from '@/entrypoints/sidepanel/utils/tools/approval-copy';
import { setLocale, subscribeLocale, t, type Locale } from '@/utils/i18n/core';

interface PreviewCase {
  /** 预览用标签（非产品文案） */
  label: string;
  input: ToolApprovalCopyInput;
}

const ARGS = {
  pypi: '{"action":"run","path":"scripts/read_xls.py","requirements":["xlrd"],"dependencyMode":"pypi"}',
  pypiBare: '{"action":"run","path":"scripts/report.py","dependencyMode":"pypi"}',
  note: '{"action":"delete","noteId":"note_7f3a"}',
  click: '{"action":"click","description":"确认支付订单"}',
  confirm: '{"action":"run","path":"scripts/x.js","confirm":true}',
  plugin: '{"action":"read","path":"content/page.md"}',
  plain: '{"action":"run","path":"scripts/hello.py"}',
} as const;

const CASES: PreviewCase[] = [
  { label: 'dependency-install · 点名依赖包', input: { name: 'python_run', argumentsPreview: ARGS.pypi, reason: 'dependency-install', reasonDetail: 'xlrd' } },
  { label: 'dependency-install · 未列包名（降级）', input: { name: 'python_run', argumentsPreview: ARGS.pypiBare, reason: 'dependency-install' } },
  { label: 'action · note_tool delete', input: { name: 'note_tool', argumentsPreview: ARGS.note, reason: 'action', reasonDetail: 'delete' } },
  { label: 'confirm · 命中字段 description', input: { name: 'browser_interact', argumentsPreview: ARGS.click, reason: 'confirm', reasonDetail: 'description' } },
  { label: 'confirm · confirm=true 无字段（降级）', input: { name: 'js_run', argumentsPreview: ARGS.confirm, reason: 'confirm' } },
  { label: 'plugin-session · 本会话首次授权', input: { name: 'demo/read_page', argumentsPreview: ARGS.plugin, reason: 'plugin-session', reasonDetail: 'demo-plugin' } },
  { label: 'plugin-call · 每次调用都需批准', input: { name: 'demo/read_page', argumentsPreview: ARGS.plugin, reason: 'plugin-call', reasonDetail: 'demo-plugin' } },
  { label: 'tool · 工具自声明破坏性', input: { name: 'browser_history_bookmarks', argumentsPreview: '{"action":"clear"}', reason: 'tool' } },
  { label: 'unknown · 未分类兜底', input: { name: 'some_tool', argumentsPreview: ARGS.plain } },
];

/** 与 AppDialog.vue 的 warn 图标一致（预览只复刻展示，不复制样式） */
const WARN_ICON =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const gallery = document.getElementById('gallery');
const localeButton = document.getElementById('locale-toggle') as HTMLButtonElement | null;
if (!gallery) throw new Error('[tool-approval-preview] #gallery missing');

function render(): void {
  gallery!.innerHTML = '';
  for (const item of CASES) {
    const copy = selectToolApprovalCopy(item.input);
    const card = document.createElement('div');
    card.className = 'preview-case';
    card.dataset.reason = item.input.reason ?? 'unknown';
    card.dataset.hasDetail = String(!!(item.input.reasonDetail ?? '').trim());

    const label = document.createElement('div');
    label.className = 'preview-case-label';
    label.textContent = item.label;

    const dialog = document.createElement('div');
    dialog.className = 'app-dialog';
    dialog.innerHTML =
      `<div class="app-dialog-icon tone-warn">${WARN_ICON}</div>` +
      `<h4 class="app-dialog-title"></h4>` +
      `<p class="app-dialog-message"></p>` +
      '<div class="app-dialog-actions">' +
      `<button type="button" class="app-dialog-btn app-dialog-btn-secondary">${t('sidepanel.chat.toolApprovalDeny')}</button>` +
      `<button type="button" class="app-dialog-btn app-dialog-btn-primary">${t('sidepanel.chat.toolApprovalAllow')}</button>` +
      '</div>';
    (dialog.querySelector('.app-dialog-title') as HTMLElement).textContent = t(copy.titleKey);
    (dialog.querySelector('.app-dialog-message') as HTMLElement).textContent = t(copy.messageKey, copy.params);

    card.append(label, dialog);
    gallery!.append(card);
  }
}

let locale: Locale = 'zh-CN';
localeButton?.addEventListener('click', () => {
  locale = locale === 'zh-CN' ? 'en' : 'zh-CN';
  setLocale(locale);
  if (localeButton) localeButton.textContent = locale === 'zh-CN' ? '切换到 English' : 'Switch to 中文';
});
subscribeLocale(next => {
  locale = next;
  render();
});

render();

/**
 * 表格工具栏动作（document 级事件委托）
 *
 * 表格块由 markdown-renderer 生成（.table-block > .table-header > 按钮），
 * 扩展页 CSP 为 `script-src 'self'`（不含 'unsafe-inline'），内联 onclick 会被
 * 浏览器直接拦截——与代码复制（code-copy.ts）、文件卡片（file-card.ts）同构，
 * 统一走 document 级事件委托。
 *
 * 覆盖两个动作：
 *   1. 复制：把表格还原为 Markdown 表格文本写入剪贴板（可回粘到对话或编辑器）；
 *   2. 导出 xlsx：从 DOM 提取二维数据，经 tools/office/xlsx-builder 生成工作簿
 *      （默认表头蓝底白字、冻结表头、自动列宽、斑马纹），以 blob 触发本地下载。
 *
 * 数据来源是渲染后的 DOM（而非原始 Markdown）：单元格内的行内标记（强调/代码/
 * 链接）已被 markdown-it 渲染为元素，取 textContent 即为最终展示文本，
 * 与用户看到的表格内容一致。
 */

import { t } from '@/utils/i18n';

/** xlsx MIME */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 动作反馈（已复制/已导出/失败）的恢复时长（毫秒） */
const FEEDBACK_DURATION_MS = 2000;

/** 表格的 DOM 数据视图 */
interface ExtractedTable {
  /** 表头列（可能为空：模型输出的表格未必有表头行） */
  headers: string[];
  /** 数据行 */
  rows: string[][];
}

// ──────────────────────────── DOM → 数据 ────────────────────────────

/** 单元格纯文本：折叠换行/多余空白，去掉首尾空格 */
function cellText(cell: Element): string {
  return (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 单行的单元格文本（th/td 按文档序） */
function rowCells(row: Element): string[] {
  return Array.from(row.querySelectorAll('th, td')).map(cellText);
}

/** 参差行补齐 / 截断到表头列数（Excel 表格要求行列齐整） */
function normalizeRows(rows: string[][], width: number): string[][] {
  if (width <= 0) return rows;
  return rows.map(row => {
    const copy = [...row];
    while (copy.length < width) copy.push('');
    return copy.slice(0, width);
  });
}

/**
 * 从 DOM 提取表格数据：
 * - 有 thead：首行为表头，tbody 内各行为数据行；
 * - 无 thead：首行作表头（GFM 渲染器始终产出 thead/tbody，此处为兜底）。
 */
function extractTable(table: Element): ExtractedTable {
  const headRow = table.querySelector('thead tr');
  if (headRow) {
    const headers = rowCells(headRow);
    const rows = Array.from(table.querySelectorAll('tbody tr')).map(rowCells);
    return { headers, rows: normalizeRows(rows, headers.length) };
  }
  const allRows = Array.from(table.querySelectorAll('tr'));
  const [first, ...rest] = allRows;
  const headers = first ? rowCells(first) : [];
  return { headers, rows: normalizeRows(rest.map(rowCells), headers.length) };
}

// ──────────────────────────── 文本序列化 ────────────────────────────

/** 表格 → Markdown 文本（复制到剪贴板后仍是结构化表格，可直接回粘） */
function toMarkdownTable(table: ExtractedTable): string {
  const escapeCell = (text: string): string => text.replace(/\|/g, '\\|');
  const lines: string[] = [];
  if (table.headers.length > 0) {
    lines.push(`| ${table.headers.map(escapeCell).join(' | ')} |`);
    lines.push(`| ${table.headers.map(() => '---').join(' | ')} |`);
  }
  for (const row of table.rows) {
    lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
  }
  return lines.join('\n');
}

// ──────────────────────────── 命名（工作表名 / 文件名） ────────────────────────────

/**
 * 取表格之前最近的标题文本，作为工作表名与文件名的来源——
 * 导出的文件自带上下文（「第三章 价格对比.xlsx」比「表格_20261103.xlsx」可用得多）。
 */
function resolveTableTitle(block: Element): string {
  // 作用域：最近的 .message-content / .reasoning-content 容器（标题与表格同在其中）
  let scope: Element | null = block.parentElement;
  while (
    scope &&
    !scope.classList.contains('message-content') &&
    !scope.classList.contains('reasoning-content')
  ) {
    scope = scope.parentElement;
  }
  if (!scope) return '';

  let title = '';
  scope.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
    // 只采纳文档序在表格之前的标题（最后一个即最近的那个）
    if (heading.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING) {
      title = (heading.textContent ?? '').trim();
    }
  });
  return title;
}

/** Excel 工作表名合法化（≤31 字符、剔除 : \ / ? * [ ]、不得以单引号包裹） */
function toSheetName(raw: string): string {
  return raw
    .replace(/[:\\/?*[\]]/g, '')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31);
}

/** 文件名基名合法化（剔除文件系统非法字符与控制字符、结尾点号） */
function toFileName(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- 刻意匹配控制字符以清理文件名
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/:*?"<>|[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  return cleaned.slice(0, 80);
}

/** 时间戳后缀（本地时间，秒级）：20261103_142530 */
function timestampSuffix(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

// ──────────────────────────── 反馈与下载 ────────────────────────────

/** 按钮状态反馈：改写标题 + 打标（done/error），2 秒后复原 */
function flashButton(button: HTMLElement, label: string, state: 'done' | 'error'): void {
  const idleTitle = button.dataset.idleTitle ?? button.title;
  button.dataset.idleTitle = idleTitle;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.classList.toggle('done', state === 'done');
  button.classList.toggle('error', state === 'error');
  window.setTimeout(() => {
    button.title = idleTitle;
    button.setAttribute('aria-label', idleTitle);
    button.classList.remove('done', 'error');
  }, FEEDBACK_DURATION_MS);
}

/** 触发浏览器下载（blob URL + 临时 <a>，与文件卡片下载同构） */
function downloadBuffer(buffer: ArrayBuffer, filename: string): void {
  const url = URL.createObjectURL(new Blob([buffer], { type: XLSX_MIME }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ──────────────────────────── 动作 ────────────────────────────

/** 复制表格（Markdown 文本） */
async function handleCopy(button: HTMLElement): Promise<void> {
  const table = button.closest('.table-block')?.querySelector('table');
  if (!table) return;
  const text = toMarkdownTable(extractTable(table));
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    flashButton(button, t('sidepanel.chat.tableCopiedLabel'), 'done');
  } catch (error) {
    console.warn('[TableActions] 复制表格失败:', error);
    flashButton(button, t('sidepanel.chat.tableCopyFailedLabel'), 'error');
  }
}

/** 导出表格为 xlsx 并下载 */
async function handleExport(button: HTMLElement): Promise<void> {
  const block = button.closest('.table-block');
  const table = block?.querySelector('table');
  if (!block || !table) return;
  if (button.classList.contains('is-busy')) return;

  const data = extractTable(table);
  if (data.headers.length === 0 && data.rows.length === 0) return;

  button.classList.add('is-busy');
  try {
    // Excel 引擎按需加载（代码分割，避免常驻扩展包体积）
    const { buildWorkbook } = await import('@/tools/office/xlsx-builder');
    const title = resolveTableTitle(block);
    const { buffer } = await buildWorkbook([
      {
        name: toSheetName(title) || 'Sheet1',
        headers: data.headers,
        rows: data.rows,
        freeze: data.headers.length > 0 ? 'A2' : false,
        autoFilter: data.rows.length > 0,
        zebra: true,
      },
    ]);
    const baseName = toFileName(title) || t('sidepanel.chat.tableLabel');
    downloadBuffer(buffer, `${baseName}_${timestampSuffix()}.xlsx`);
    flashButton(button, t('sidepanel.chat.tableExportedLabel'), 'done');
  } catch (error) {
    console.warn('[TableActions] 导出 xlsx 失败:', error);
    flashButton(button, t('sidepanel.chat.tableExportFailedLabel'), 'error');
  } finally {
    button.classList.remove('is-busy');
  }
}

let handlerInstalled = false;

/** 安装 document 级表格工具栏点击委托（幂等；仅 DOM 上下文生效） */
export function installTableActionHandler(): void {
  if (handlerInstalled || typeof document === 'undefined') return;
  handlerInstalled = true;

  document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const copyButton = target?.closest?.('.table-copy-btn') as HTMLElement | null;
    if (copyButton) {
      event.preventDefault();
      void handleCopy(copyButton);
      return;
    }
    const exportButton = target?.closest?.('.table-export-btn') as HTMLElement | null;
    if (exportButton) {
      event.preventDefault();
      void handleExport(exportButton);
    }
  });
}

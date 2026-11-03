/**
 * Markdown 表格 → xlsx 工作表声明 解析器
 *
 * 支持一次粘贴多张表：
 * - 连续的 `|` 行构成一张表；第二行为对齐行（---/:---:/---:）时识别列对齐；
 * - 表块之前的最近标题行（# ~ ######）作为工作表名；无标题时按序命名 Sheet1/2/...；
 * - 单元格内的 Markdown 强调（**加粗**、*斜体*、`代码`）剥离为纯文本。
 */

import type { XlsxCellInput, XlsxColumnSpec, XlsxSheetSpec, XlsxStyleSpec } from './xlsx-builder';
import { XlsxBuildError, XLSX_LIMITS } from './xlsx-builder';

interface ParsedTable {
  /** 来自标题行的表名（未做 Excel 合法化） */
  heading: string | null;
  header: string[];
  rows: string[][];
  /** 列对齐（来自对齐行），长度与 header 对齐 */
  aligns: Array<'left' | 'center' | 'right' | null>;
}

/** 剥离行内 Markdown 标记 */
function stripInlineMarks(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .trim();
}

/** 转义竖线占位符（拆分单元格前保护 `\|`，拆分后还原为字面 `|`） */
const ESCAPED_PIPE_PLACEHOLDER = '\u0000PIPE\u0000';

function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body
    .replace(/\\\|/g, ESCAPED_PIPE_PLACEHOLDER)
    .split('|')
    .map(cell => stripInlineMarks(cell.replace(new RegExp(ESCAPED_PIPE_PLACEHOLDER, 'g'), '|')));
}

function isAlignRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));
}

function parseAlign(cells: string[]): Array<'left' | 'center' | 'right' | null> {
  return cells.map(c => {
    const t = c.replace(/\s/g, '');
    if (t.startsWith(':') && t.endsWith(':')) return 'center';
    if (t.endsWith(':')) return 'right';
    if (t.startsWith(':')) return 'left';
    return null;
  });
}

/** 工作表名合法化：截断 31 字符、剔除 Excel 非法字符 */
function toLegalSheetName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[:\\/?*[\]]/g, '')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31);
  return cleaned || fallback;
}

/**
 * 解析 markdown 文本中的全部表格为工作表声明。
 * @throws XlsxBuildError 文本中不含任何表格时
 */
export function parseMarkdownTables(input: {
  markdown: unknown;
  path?: string;
  defaultSheetName?: string;
}): XlsxSheetSpec[] {
  const path = input.path ?? 'markdown';
  if (typeof input.markdown !== 'string' || !input.markdown.trim()) {
    throw new XlsxBuildError(`${path}: 必须是包含 Markdown 表格的非空字符串`);
  }

  const lines = input.markdown.replace(/\r\n/g, '\n').split('\n');
  const tables: ParsedTable[] = [];
  let current: { heading: string | null; lines: string[] } | null = null;
  let lastHeading: string | null = null;

  const flush = () => {
    if (!current || current.lines.length === 0) {
      current = null;
      return;
    }
    const rawRows = current.lines.map(splitTableRow);
    let header: string[];
    let aligns: Array<'left' | 'center' | 'right' | null>;
    let dataRows: string[][];
    if (rawRows.length >= 2 && isAlignRow(rawRows[1])) {
      header = rawRows[0];
      aligns = parseAlign(rawRows[1]);
      dataRows = rawRows.slice(2);
    } else {
      header = rawRows[0];
      aligns = header.map(() => null);
      dataRows = rawRows.slice(1);
    }
    const width = header.length;
    if (width === 0) {
      current = null;
      return;
    }
    // 参差行补齐/截断到表头宽度
    const normalized = dataRows.map(r => {
      const copy = [...r];
      while (copy.length < width) copy.push('');
      return copy.slice(0, width);
    });
    tables.push({ heading: current.heading, header, rows: normalized, aligns });
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flush();
      lastHeading = stripInlineMarks(headingMatch[2]);
      continue;
    }
    if (trimmed.includes('|') && trimmed.length > 1) {
      if (!current) current = { heading: lastHeading, lines: [] };
      current.lines.push(trimmed);
    } else {
      flush();
    }
  }
  flush();

  if (tables.length === 0) {
    throw new XlsxBuildError(
      `${path}: 未在文本中找到 Markdown 表格（表格每行需以 | 分隔单元格，如 "| 名称 | 数量 |"）`,
    );
  }
  if (tables.length > XLSX_LIMITS.maxSheets) {
    throw new XlsxBuildError(
      `${path}: 表格数量 ${tables.length} 超过上限 ${XLSX_LIMITS.maxSheets} 张（可分多次生成）`,
    );
  }
  for (let i = 0; i < tables.length; i++) {
    if (tables[i].header.length > XLSX_LIMITS.maxColumnsPerSheet) {
      throw new XlsxBuildError(
        `${path}: 第 ${i + 1} 张表格的列数 ${tables[i].header.length} 超过上限 ${XLSX_LIMITS.maxColumnsPerSheet}`,
      );
    }
  }

  const defaultName = input.defaultSheetName?.trim();
  return tables.map((table, i) => {
    const fallback = defaultName && tables.length === 1
      ? defaultName
      : `Sheet${i + 1}`;
    const name = toLegalSheetName(table.heading ?? '', fallback);

    // 对齐行 → 列基准样式（作用该列数据格）
    const columns: XlsxColumnSpec[] = table.aligns.map(align => {
      const style: XlsxStyleSpec = {};
      if (align) style.hAlign = align;
      return Object.keys(style).length > 0 ? { style } : {};
    });
    const useColumns = columns.some(col => Object.keys(col).length > 0);

    const spec: XlsxSheetSpec = {
      name,
      headers: table.header as XlsxCellInput[],
      rows: table.rows as XlsxCellInput[][],
    };
    if (useColumns) spec.columns = columns;
    return spec;
  });
}

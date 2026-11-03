/**
 * 声明式 xlsx 工作簿构建器（纯逻辑，无 Chrome API 依赖）
 *
 * 输入：XlsxSheetSpec[]（声明式表格描述）
 * 输出：ArrayBuffer（xlsx 二进制）+ 各表摘要
 *
 * 设计要点：
 * - 全量参数校验前置且报错带「路径 + 实际值 + 期望」，供模型按报错自修复参数；
 * - 默认美化：表头蓝底白字加粗居中、全表细边框、自动列宽、(可选)冻结表头；
 * - 合并区域会为区域内所有格子补齐样式空格，保证合并后边框/底色完整；
 * - 任何校验失败抛 XlsxBuildError（message 即面向模型的精准原因），由工具层捕获。
 */

import type {
  ExcelJsAlignment,
  ExcelJsBorder,
  ExcelJsCell,
  ExcelJsColumn,
  ExcelJsFill,
  ExcelJsFont,
  ExcelJsRow,
  ExcelJsWorkbook,
} from 'exceljs/dist/exceljs.min.js';

// ──────────────────────────── 类型定义（工具入参契约） ────────────────────────────

export type XlsxBorderStyleName =
  | 'none'
  | 'hair'
  | 'thin'
  | 'medium'
  | 'thick'
  | 'double'
  | 'dashed'
  | 'dotted'
  | 'dashDot'
  | 'dashDotDot'
  | 'slantDashDot';

export interface XlsxBorderSpec {
  top?: XlsxBorderStyleName;
  bottom?: XlsxBorderStyleName;
  left?: XlsxBorderStyleName;
  right?: XlsxBorderStyleName;
  /** 四边统一颜色（#RGB/#RRGGBB/颜色名） */
  color?: string;
}

export interface XlsxStyleSpec {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** 字号（1-100） */
  fontSize?: number;
  fontName?: string;
  fontColor?: string;
  fillColor?: string;
  hAlign?: 'left' | 'center' | 'right';
  vAlign?: 'top' | 'middle' | 'bottom';
  wrap?: boolean;
  border?: XlsxBorderStyleName | XlsxBorderSpec;
  borderColor?: string;
  /** 数字/日期格式串，如 '0.00%'、'yyyy-mm-dd' */
  numFmt?: string;
}

export interface XlsxRichTextPart {
  text: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  size?: number;
}

/** 单元格声明：对象形态（值为 v/value，另有公式/富文本/超链接/日期变体） */
export interface XlsxCellSpec {
  v?: unknown;
  value?: unknown;
  /** Excel 公式（带不带等号均可），如 'SUM(A1:A10)' */
  formula?: string;
  richText?: XlsxRichTextPart[];
  /** 超链接 URL（http/https/mailto） */
  link?: string;
  /** ISO 日期字符串，如 '2026-10-30' 或 '2026-10-30 14:30:00' */
  date?: string;
  numFmt?: string;
  style?: XlsxStyleSpec;
}

export type XlsxCellInput = string | number | boolean | null | XlsxCellSpec;

/** 精确单元格放置（ref 如 'B3'），可与 rows 叠加（后写覆盖先写） */
export interface XlsxCellPlacement extends XlsxCellSpec {
  ref: string;
}

export interface XlsxColumnSpec {
  /** 显式列宽（字符单位）；缺省参与自动列宽 */
  width?: number;
  numFmt?: string;
  /** 该列数据单元格的基准样式（单元格自身 style 优先） */
  style?: XlsxStyleSpec;
}

export interface XlsxSheetSpec {
  /** 工作表名（≤31 字符，不含 : \ / ? * [ ]） */
  name: string;
  /** 大标题：置于表格上方，跨全部列合并、居中加粗放大 */
  title?: string;
  /** 表头行（启用后默认蓝底白字、冻结表头） */
  headers?: XlsxCellInput[];
  /** rows 存在且未提供 headers 时：是否把第一行当表头美化（默认 false） */
  firstRowAsHeader?: boolean;
  /** 数据行（二维数组，允许参差，自动补齐） */
  rows?: XlsxCellInput[][];
  /** 精确单元格（稀疏结构/复杂布局用） */
  cells?: XlsxCellPlacement[];
  /** 合并区域列表，如 ['A1:C1', 'A2:A5'] */
  merges?: string[];
  /** 按列序号的列定义（从 1 起） */
  columns?: XlsxColumnSpec[];
  colWidths?: {
    /** 是否自动列宽（默认 true） */
    auto?: boolean;
    minWidth?: number;
    maxWidth?: number;
  };
  /** 行号 → 行高（行号从 1 起） */
  rowHeights?: Record<string, number>;
  /** 冻结窗格，如 'A2'（冻结第 1 行）；提供 headers 时默认冻结表头，传 false 关闭 */
  freeze?: string | false;
  /** 自动筛选（默认 false） */
  autoFilter?: boolean;
  /** 斑马纹（偶数数据行浅色底，默认 false） */
  zebra?: boolean;
  /** 工作表标签颜色 */
  tabColor?: string;
  /** 横向打印 */
  landscape?: boolean;
}

export interface XlsxSheetSummary {
  name: string;
  rowCount: number;
  columnCount: number;
  mergeCount: number;
  hasHeader: boolean;
  frozen: boolean;
}

export interface XlsxBuildOutput {
  buffer: ArrayBuffer;
  sheets: XlsxSheetSummary[];
  totalCells: number;
}

// ──────────────────────────── 容量限制 ────────────────────────────

export const XLSX_LIMITS = {
  maxSheets: 16,
  maxRowsPerSheet: 5_000,
  maxTotalCells: 50_000,
  maxColumnsPerSheet: 256,
  maxMergesPerSheet: 200,
  maxCellTextLength: 32_000,
  /** 精确单元格放置 / 合并区域 / 行高允许的最大行号（防超大引用导致遍历失控挂起） */
  maxPlacementRow: 10_000,
  /** 单个合并区域的最大面积（格子数，防止全表级合并拖垮构建） */
  maxMergeArea: 10_000,
  /** 大标题最大长度（字符） */
  maxTitleLength: 200,
} as const;

// ──────────────────────────── 错误类型 ────────────────────────────

/** 构建失败：message 为面向调用方（模型）的精准原因（含参数路径） */
export class XlsxBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxBuildError';
  }
}

function fail(path: string, message: string): never {
  throw new XlsxBuildError(path ? `${path}: ${message}` : message);
}

/** Excel/XML 不允许的控制字符（\u0000-\u0008、\u000B、\u000C、\u000E-\u001F），写入会损坏整个文件 */
// eslint-disable-next-line no-control-regex -- 该正则的职责就是检测控制字符以拦截非法输入
const ILLEGAL_XML_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/** 文本安全性校验：控制字符直接拒绝（静默写入会产出打不开的损坏文件） */
function assertSafeText(text: string, path: string): void {
  if (ILLEGAL_XML_CHARS_RE.test(text)) {
    fail(path, '文本包含 Excel 不允许的控制字符（0x00-0x1F 区段的不可见字符），请移除后重试');
  }
}

/** 数值安全性校验：NaN/Infinity 无法写入 xlsx 数值类型 */
function assertFiniteNumber(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    fail(path, `数值必须是有限数字，实际收到 ${String(value)}`);
  }
}

/**
 * 布尔开关严格读取：缺省返回 undefined；非布尔值（如 'yes'/1）直接报错，
 * 避免「传了但被静默忽略」造成的歧义（模型以为生效、实际未生效）
 */
function readBoolFlag(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    fail(path, `必须是布尔值，实际收到 ${JSON.stringify(value) ?? String(value)}`);
  }
  return value;
}

// ──────────────────────────── 颜色解析 ────────────────────────────

const NAMED_COLORS: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  crimson: 'DC143C',
  pink: 'FFC0CB',
  orange: 'FFA500',
  yellow: 'FFFF00',
  gold: 'FFD700',
  brown: 'A52A2A',
  green: '008000',
  lime: '00FF00',
  olive: '808000',
  cyan: '00FFFF',
  blue: '0000FF',
  navy: '000080',
  teal: '008080',
  purple: '800080',
  violet: 'EE82EE',
  magenta: 'FF00FF',
  gray: '808080',
  grey: '808080',
  silver: 'C0C0C0',
};

/** 颜色入参 → ARGB（'FF' + RGB）。非法输入报精准错误。 */
function parseColorArgb(input: unknown, path: string): string {
  if (typeof input !== 'string' || !input.trim()) {
    fail(path, `颜色必须是字符串，实际收到 ${JSON.stringify(input) ?? String(input)}`);
  }
  const raw = input.trim();
  const named = NAMED_COLORS[raw.toLowerCase()];
  if (named) return `FF${named}`;
  const hex = raw.replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `FF${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `FF${hex.toUpperCase()}`;
  if (/^[0-9a-fA-F]{8}$/.test(hex)) return hex.toUpperCase();
  fail(
    path,
    `无效颜色 "${raw}"（支持 #RGB / #RRGGBB / #AARRGGBB 或常见英文颜色名，如 red、#4472C4）`,
  );
}

// ──────────────────────────── 引用解析（A1 ↔ 行列号） ────────────────────────────

const MAX_ROW_INDEX = 1_048_576;
const MAX_COL_INDEX = 16_384;

function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

function indexToCol(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseRef(ref: unknown, path: string): { row: number; col: number } {
  if (typeof ref !== 'string' || !/^[A-Za-z]{1,3}[0-9]{1,7}$/.test(ref.trim())) {
    fail(path, `无效单元格引用 ${JSON.stringify(ref)}（正确示例：'B3'、'AA12'）`);
  }
  const m = ref.trim().match(/^([A-Za-z]+)([0-9]+)$/)!;
  const col = colToIndex(m[1]);
  const row = Number(m[2]);
  if (row < 1 || row > MAX_ROW_INDEX || col < 1 || col > MAX_COL_INDEX) {
    fail(path, `单元格引用 ${ref} 超出 Excel 范围（行 ≤ ${MAX_ROW_INDEX}，列 ≤ ${MAX_COL_INDEX}）`);
  }
  return { row, col };
}

interface GridRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

function parseRange(range: unknown, path: string): GridRange {
  if (typeof range !== 'string' || !/^[A-Za-z]{1,3}[0-9]{1,7}:[A-Za-z]{1,3}[0-9]{1,7}$/.test(range.trim())) {
    fail(path, `无效合并区域 ${JSON.stringify(range)}（正确示例：'A1:C1'、'B2:B5'）`);
  }
  const [a, b] = range.trim().split(':');
  const start = parseRef(a, path);
  const end = parseRef(b, path);
  const normalized: GridRange = {
    r1: Math.min(start.row, end.row),
    c1: Math.min(start.col, end.col),
    r2: Math.max(start.row, end.row),
    c2: Math.max(start.col, end.col),
  };
  // 工具级实用边界：防止接近 Excel 全表尺度的区域（遍历/样式补齐会失控）
  if (normalized.r2 > XLSX_LIMITS.maxPlacementRow || normalized.c2 > XLSX_LIMITS.maxColumnsPerSheet) {
    fail(
      path,
      `合并区域 ${range} 超出工具支持范围（行 ≤ ${XLSX_LIMITS.maxPlacementRow}，列 ≤ ${XLSX_LIMITS.maxColumnsPerSheet}）`,
    );
  }
  const area = (normalized.r2 - normalized.r1 + 1) * (normalized.c2 - normalized.c1 + 1);
  if (area > XLSX_LIMITS.maxMergeArea) {
    fail(path, `合并区域 ${range} 面积 ${area} 格超过上限 ${XLSX_LIMITS.maxMergeArea} 格/区域`);
  }
  return normalized;
}

// ──────────────────────────── 内部网格模型 ────────────────────────────

type GridValueKind = 'empty' | 'plain' | 'formula' | 'richText' | 'link' | 'date';

interface GridCell {
  kind: GridValueKind;
  value?: string | number | boolean;
  formula?: string;
  richText?: XlsxRichTextPart[];
  link?: string;
  date?: Date;
  style: XlsxStyleSpec;
  /** 自动列宽估算用显示文本 */
  display: string;
}

interface SheetModel {
  name: string;
  cells: Map<string, GridCell>;
  maxRow: number;
  maxCol: number;
  headerRow: number | null;
  dataStartRow: number;
  titleRow: number | null;
  titleText: string | null;
  merges: GridRange[];
  mergeStrings: string[];
  columnWidths: Map<number, number>;
  rowHeights: Map<number, number>;
  freeze: { xSplit: number; ySplit: number } | null;
  autoFilter: { from: { row: number; column: number }; to: { row: number; column: number } } | null;
  zebra: boolean;
  tabColor: string | null;
  landscape: boolean;
}

const cellKey = (r: number, c: number) => `${r}:${c}`;

// ──────────────────────────── 默认美化样式 ────────────────────────────

/** 默认边框色（浅灰） */
const BORDER_ARGB = 'FFD9D9D9';

// ──────────────────────────── 样式校验 ────────────────────────────

const BORDER_STYLE_NAMES = new Set<XlsxBorderStyleName>([
  'none', 'hair', 'thin', 'medium', 'thick', 'double',
  'dashed', 'dotted', 'dashDot', 'dashDotDot', 'slantDashDot',
]);

function validateStyle(style: unknown, path: string): XlsxStyleSpec {
  if (style === undefined || style === null) return {};
  if (typeof style !== 'object' || Array.isArray(style)) {
    fail(path, `样式必须是对象，实际收到 ${Array.isArray(style) ? '数组' : typeof style}`);
  }
  const s = style as Record<string, unknown>;
  const out: XlsxStyleSpec = {};

  for (const key of ['bold', 'italic', 'underline', 'strike', 'wrap'] as const) {
    if (s[key] !== undefined) {
      if (typeof s[key] !== 'boolean') fail(`${path}.${key}`, `必须是布尔值，实际收到 ${JSON.stringify(s[key])}`);
      out[key] = s[key];
    }
  }
  if (s.fontSize !== undefined) {
    if (typeof s.fontSize !== 'number' || !Number.isFinite(s.fontSize) || s.fontSize < 1 || s.fontSize > 100) {
      fail(`${path}.fontSize`, `必须是 1-100 的数字，实际收到 ${JSON.stringify(s.fontSize)}`);
    }
    out.fontSize = s.fontSize;
  }
  if (s.fontName !== undefined) {
    if (typeof s.fontName !== 'string' || !s.fontName.trim()) fail(`${path}.fontName`, `必须是字符串`);
    out.fontName = s.fontName;
  }
  for (const key of ['fontColor', 'fillColor', 'borderColor'] as const) {
    if (s[key] !== undefined) {
      parseColorArgb(s[key], `${path}.${key}`); // 仅校验
      out[key] = s[key] as string;
    }
  }
  if (s.hAlign !== undefined) {
    if (!['left', 'center', 'right'].includes(s.hAlign as string)) {
      fail(`${path}.hAlign`, `必须是 'left'|'center'|'right'，实际收到 ${JSON.stringify(s.hAlign)}`);
    }
    out.hAlign = s.hAlign as XlsxStyleSpec['hAlign'];
  }
  if (s.vAlign !== undefined) {
    if (!['top', 'middle', 'bottom'].includes(s.vAlign as string)) {
      fail(`${path}.vAlign`, `必须是 'top'|'middle'|'bottom'，实际收到 ${JSON.stringify(s.vAlign)}`);
    }
    out.vAlign = s.vAlign as XlsxStyleSpec['vAlign'];
  }
  if (s.numFmt !== undefined) {
    if (typeof s.numFmt !== 'string' || !s.numFmt.trim() || s.numFmt.length > 100) {
      fail(`${path}.numFmt`, `必须是 1-100 字符的格式串（如 '0.00%'、'yyyy-mm-dd'），实际收到 ${JSON.stringify(s.numFmt)}`);
    }
    out.numFmt = s.numFmt;
  }
  if (s.border !== undefined) {
    if (typeof s.border === 'string') {
      if (!BORDER_STYLE_NAMES.has(s.border as XlsxBorderStyleName)) {
        fail(`${path}.border`, `无效线型 "${s.border}"（可选：${[...BORDER_STYLE_NAMES].join(' / ')}）`);
      }
      out.border = s.border as XlsxBorderStyleName;
    } else if (typeof s.border === 'object' && !Array.isArray(s.border)) {
      const b = s.border as Record<string, unknown>;
      const spec: XlsxBorderSpec = {};
      for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        if (b[side] !== undefined) {
          if (typeof b[side] !== 'string' || !BORDER_STYLE_NAMES.has(b[side] as XlsxBorderStyleName)) {
            fail(`${path}.border.${side}`, `无效线型 ${JSON.stringify(b[side])}（可选：${[...BORDER_STYLE_NAMES].join(' / ')}）`);
          }
          spec[side] = b[side] as XlsxBorderStyleName;
        }
      }
      if (b.color !== undefined) {
        parseColorArgb(b.color, `${path}.border.color`);
        spec.color = b.color as string;
      }
      out.border = spec;
    } else {
      fail(`${path}.border`, `必须是线型字符串或 {top,bottom,left,right,color} 对象`);
    }
  }
  return out;
}

// ──────────────────────────── 单元格归一化 ────────────────────────────

/** 估算显示宽度：ASCII 记 1，全角/中文记 2 */
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 2 : 1;
  }
  return w;
}

function normalizeCell(input: unknown, path: string): GridCell {
  const empty = (style: XlsxStyleSpec = {}): GridCell => ({ kind: 'empty', style, display: '' });

  if (input === undefined || input === null) return empty();

  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    if (typeof input === 'string') assertSafeText(input, path);
    if (typeof input === 'number') assertFiniteNumber(input, path);
    const display = String(input);
    if (display.length > XLSX_LIMITS.maxCellTextLength) {
      fail(path, `单元格文本长度 ${display.length} 超过上限 ${XLSX_LIMITS.maxCellTextLength}`);
    }
    return { kind: 'plain', value: input, style: {}, display };
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    fail(path, `单元格必须是值（string/number/boolean）或对象声明，实际收到 ${Array.isArray(input) ? '数组' : typeof input}`);
  }

  const c = input as Record<string, unknown>;
  const style = validateStyle(c.style, `${path}.style`);
  const cell: GridCell = { ...empty(style) };

  const hasV = c.v !== undefined && c.v !== null;
  const hasValue = c.value !== undefined && c.value !== null;
  const hasFormula = c.formula !== undefined && c.formula !== null;
  const hasRich = c.richText !== undefined && c.richText !== null;
  const hasLink = c.link !== undefined && c.link !== null;
  const hasDate = c.date !== undefined && c.date !== null;
  // 值形态互斥；唯一例外：link 可与 v/value 搭配（v 作为链接显示文字）
  const variantCount = [hasV || hasValue, hasFormula, hasRich, hasLink, hasDate].filter(Boolean).length;
  const isLinkWithDisplayText = hasLink && (hasV || hasValue) && variantCount === 2;
  if (variantCount > 1 && !isLinkWithDisplayText) {
    fail(path, `单元格只能声明一种值形态（v/value/formula/richText/link/date 只能选一个；仅 link 允许搭配 v 作显示文字），实际同时出现 ${variantCount} 种`);
  }

  if (c.numFmt !== undefined) {
    if (typeof c.numFmt !== 'string' || !c.numFmt.trim() || c.numFmt.length > 100) {
      fail(`${path}.numFmt`, `必须是 1-100 字符的格式串，实际收到 ${JSON.stringify(c.numFmt)}`);
    }
    style.numFmt = c.numFmt;
  }

  if (hasFormula) {
    if (typeof c.formula !== 'string' || !c.formula.trim()) {
      fail(`${path}.formula`, `公式必须是非空字符串，实际收到 ${JSON.stringify(c.formula)}`);
    }
    const formula = c.formula.trim().replace(/^=/, '');
    cell.kind = 'formula';
    cell.formula = formula;
    cell.display = formula;
    return cell;
  }

  if (hasRich) {
    if (!Array.isArray(c.richText) || c.richText.length === 0 || c.richText.length > 30) {
      fail(`${path}.richText`, `必须是 1-30 个 {text,...} 片段的数组`);
    }
    const parts: XlsxRichTextPart[] = c.richText.map((part, i) => {
      if (!part || typeof part !== 'object' || typeof (part as XlsxRichTextPart).text !== 'string') {
        fail(`${path}.richText[${i}]`, `片段必须是 { text: string, ... } 对象`);
      }
      const p = part as XlsxRichTextPart;
      assertSafeText(p.text, `${path}.richText[${i}].text`);
      if (p.color !== undefined) parseColorArgb(p.color, `${path}.richText[${i}].color`);
      if (p.size !== undefined && (typeof p.size !== 'number' || p.size < 1 || p.size > 100)) {
        fail(`${path}.richText[${i}].size`, `必须是 1-100 的数字`);
      }
      return p;
    });
    cell.kind = 'richText';
    cell.richText = parts;
    cell.display = parts.map(p => p.text).join('');
    if (cell.display.length > XLSX_LIMITS.maxCellTextLength) {
      fail(path, `富文本总长度 ${cell.display.length} 超过上限 ${XLSX_LIMITS.maxCellTextLength}`);
    }
    return cell;
  }

  if (hasLink) {
    if (typeof c.link !== 'string' || !/^(https?:|mailto:|ftp:)/i.test(c.link.trim())) {
      fail(`${path}.link`, `必须是 http(s)/mailto/ftp 链接，实际收到 ${JSON.stringify(c.link)}`);
    }
    const url = c.link.trim();
    // 显示文字：未提供或为空串时回落为 URL 本身（空文字的超链接单元格没有可点击区域）
    const rawText = hasV || hasValue ? String(c.v ?? c.value) : '';
    const text = rawText.length > 0 ? rawText : url;
    assertSafeText(text, path);
    cell.kind = 'link';
    cell.link = url;
    cell.value = text;
    cell.display = text;
    return cell;
  }

  if (hasDate) {
    if (typeof c.date !== 'string' || Number.isNaN(Date.parse(c.date))) {
      fail(`${path}.date`, `必须是可解析的日期字符串（如 '2026-10-30'），实际收到 ${JSON.stringify(c.date)}`);
    }
    cell.kind = 'date';
    cell.date = new Date(c.date);
    cell.display = c.date;
    if (!style.numFmt) {
      style.numFmt = /[T :]/.test(c.date) ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd';
    }
    return cell;
  }

  if (hasV || hasValue) {
    const v = (c.v ?? c.value) as unknown;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      if (typeof v === 'string') assertSafeText(v, path);
      if (typeof v === 'number') assertFiniteNumber(v, path);
      if (String(v).length > XLSX_LIMITS.maxCellTextLength) {
        fail(path, `单元格文本长度 ${String(v).length} 超过上限 ${XLSX_LIMITS.maxCellTextLength}`);
      }
      cell.kind = 'plain';
      cell.value = v;
      cell.display = String(v);
      return cell;
    }
    fail(path, `v/value 只能是 string/number/boolean，实际收到 ${v === null ? 'null' : typeof v}`);
  }

  return cell; // 仅样式的空单元格
}

// ──────────────────────────── 工作表名校验 ────────────────────────────

function validateSheetName(name: unknown, path: string): string {
  if (typeof name !== 'string' || !name.trim()) {
    fail(path, `工作表名必须是非空字符串，实际收到 ${JSON.stringify(name)}`);
  }
  const trimmed = name.trim();
  if (trimmed.length > 31) {
    fail(path, `工作表名 "${trimmed}" 长度 ${trimmed.length} 超过 Excel 上限 31 字符`);
  }
  if (/[:\\/?*[\]]/.test(trimmed)) {
    fail(path, `工作表名 "${trimmed}" 含非法字符（不能包含 : \\ / ? * [ ]）`);
  }
  if (/^'.*'$/.test(trimmed)) {
    fail(path, `工作表名 "${trimmed}" 不能以单引号开头/结尾`);
  }
  return trimmed;
}

// ──────────────────────────── 单表模型构建 ────────────────────────────

function buildSheetModel(spec: unknown, index: number): SheetModel {
  const path = `sheets[${index}]`;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    fail(path, `工作表必须是对象，实际收到 ${Array.isArray(spec) ? '数组' : typeof spec}`);
  }
  const s = spec as Record<string, unknown>;
  const name = validateSheetName(s.name, `${path}.name`);

  // 布尔开关严格校验（非布尔值直接报错，杜绝「传了但被静默忽略」的歧义）
  const zebraFlag = readBoolFlag(s.zebra, `${path}.zebra`) ?? false;
  const landscapeFlag = readBoolFlag(s.landscape, `${path}.landscape`) ?? false;
  const firstRowHeaderFlag = readBoolFlag(s.firstRowAsHeader, `${path}.firstRowAsHeader`) ?? false;
  const autoFilterFlag = readBoolFlag(s.autoFilter, `${path}.autoFilter`) ?? false;

  const model: SheetModel = {
    name,
    cells: new Map(),
    maxRow: 0,
    maxCol: 0,
    headerRow: null,
    dataStartRow: 1,
    titleRow: null,
    titleText: null,
    merges: [],
    mergeStrings: [],
    columnWidths: new Map(),
    rowHeights: new Map(),
    freeze: null,
    autoFilter: null,
    zebra: zebraFlag,
    tabColor: s.tabColor !== undefined && s.tabColor !== null ? parseColorArgb(s.tabColor, `${path}.tabColor`) : null,
    landscape: landscapeFlag,
  };

  const setCell = (r: number, c: number, cell: GridCell) => {
    model.cells.set(cellKey(r, c), cell);
    if (r > model.maxRow) model.maxRow = r;
    if (c > model.maxCol) model.maxCol = c;
  };
  const getCell = (r: number, c: number): GridCell | undefined => model.cells.get(cellKey(r, c));

  // 列定义（从 1 起的下标）
  const columnSpecs = new Map<number, XlsxColumnSpec>();
  if (s.columns !== undefined) {
    if (!Array.isArray(s.columns)) fail(`${path}.columns`, `必须是数组`);
    if (s.columns.length > XLSX_LIMITS.maxColumnsPerSheet) {
      fail(`${path}.columns`, `列定义数量 ${s.columns.length} 超过上限 ${XLSX_LIMITS.maxColumnsPerSheet}`);
    }
    s.columns.forEach((col, i) => {
      const colPath = `${path}.columns[${i}]`;
      if (!col || typeof col !== 'object' || Array.isArray(col)) fail(colPath, `列定义必须是对象`);
      const c = col as Record<string, unknown>;
      const specOut: XlsxColumnSpec = {};
      if (c.width !== undefined) {
        if (typeof c.width !== 'number' || !Number.isFinite(c.width) || c.width < 0 || c.width > 255) {
          fail(`${colPath}.width`, `列宽必须是 0-255 的数字，实际收到 ${JSON.stringify(c.width)}`);
        }
        specOut.width = c.width;
      }
      if (c.numFmt !== undefined) {
        if (typeof c.numFmt !== 'string' || !c.numFmt.trim()) fail(`${colPath}.numFmt`, `必须是格式串`);
        specOut.numFmt = c.numFmt;
      }
      if (c.style !== undefined) specOut.style = validateStyle(c.style, `${colPath}.style`);
      columnSpecs.set(i + 1, specOut);
    });
  }

  // 行高
  if (s.rowHeights !== undefined) {
    if (!s.rowHeights || typeof s.rowHeights !== 'object' || Array.isArray(s.rowHeights)) {
      fail(`${path}.rowHeights`, `必须是 { 行号: 行高 } 对象（如 { "1": 30 }）`);
    }
    const entries = Object.entries(s.rowHeights as Record<string, unknown>);
    if (entries.length > XLSX_LIMITS.maxPlacementRow) {
      fail(`${path}.rowHeights`, `行高条目数量 ${entries.length} 超过上限 ${XLSX_LIMITS.maxPlacementRow}`);
    }
    for (const [rowKey, height] of entries) {
      const row = Number(rowKey);
      if (!Number.isInteger(row) || row < 1 || row > XLSX_LIMITS.maxPlacementRow) {
        fail(`${path}.rowHeights["${rowKey}"]`, `行号必须是 1-${XLSX_LIMITS.maxPlacementRow} 的整数`);
      }
      if (typeof height !== 'number' || !Number.isFinite(height) || height < 0 || height > 409) {
        fail(`${path}.rowHeights["${rowKey}"]`, `行高必须是 0-409 的数字，实际收到 ${JSON.stringify(height)}`);
      }
      model.rowHeights.set(row, height);
    }
  }

  let cursor = 1;

  // 大标题（跨列合并在 maxCol 确定后补充）；空白标题视为未提供
  if (s.title !== undefined && s.title !== null) {
    if (typeof s.title !== 'string') fail(`${path}.title`, `大标题必须是字符串，实际收到 ${typeof s.title}`);
    const titleText = s.title.trim();
    if (titleText) {
      if (titleText.length > XLSX_LIMITS.maxTitleLength) {
        fail(`${path}.title`, `大标题长度 ${titleText.length} 超过上限 ${XLSX_LIMITS.maxTitleLength}`);
      }
      assertSafeText(titleText, `${path}.title`);
      model.titleRow = cursor;
      model.titleText = titleText;
      setCell(cursor, 1, {
        kind: 'plain',
        value: titleText,
        style: { bold: true, fontSize: 14, hAlign: 'center', vAlign: 'middle', fontColor: '#1F3864' },
        display: titleText,
      });
      model.rowHeights.set(cursor, model.rowHeights.get(cursor) ?? 30);
      cursor += 1;
    }
  }

  // 表头
  let headers: XlsxCellInput[] | null = null;
  if (s.headers !== undefined) {
    if (!Array.isArray(s.headers)) fail(`${path}.headers`, `表头必须是数组`);
    if (s.headers.length === 0) fail(`${path}.headers`, `表头数组不能为空（如不需要表头请省略该字段）`);
    if (s.headers.length > XLSX_LIMITS.maxColumnsPerSheet) {
      fail(`${path}.headers`, `表头列数 ${s.headers.length} 超过上限 ${XLSX_LIMITS.maxColumnsPerSheet}`);
    }
    headers = s.headers as XlsxCellInput[];
  }

  // 数据行
  let rows: XlsxCellInput[][] = [];
  if (s.rows !== undefined) {
    if (!Array.isArray(s.rows)) fail(`${path}.rows`, `数据行必须是二维数组`);
    rows = s.rows as XlsxCellInput[][];
    if (rows.length > XLSX_LIMITS.maxRowsPerSheet) {
      fail(`${path}.rows`, `数据行数 ${rows.length} 超过上限 ${XLSX_LIMITS.maxRowsPerSheet}（请分批或精简数据）`);
    }
  }

  // firstRowAsHeader：无 headers 时把第一行数据当表头
  let shiftedFirstRow = false;
  if (!headers && firstRowHeaderFlag && rows.length > 0) {
    headers = (rows.shift() as XlsxCellInput[]) ?? [];
    shiftedFirstRow = true;
  }

  if (!headers && rows.length === 0 && s.cells === undefined) {
    fail(path, `工作表没有任何内容（headers / rows / cells 至少提供一项）`);
  }

  if (headers) {
    model.headerRow = cursor;
    headers.forEach((h, i) => {
      const cell = normalizeCell(h, `${path}.headers[${i}]`);
      setCell(cursor, i + 1, cell);
    });
    cursor += 1;
  }
  model.dataStartRow = cursor;

  const rowIndexBase = shiftedFirstRow ? 1 : 0; // 报错路径对齐用户原始下标
  rows.forEach((row, r) => {
    const rowPath = `${path}.rows[${r + rowIndexBase}]`;
    if (!Array.isArray(row)) fail(rowPath, `数据行必须是数组，实际收到 ${typeof row}`);
    if (row.length > XLSX_LIMITS.maxColumnsPerSheet) {
      fail(rowPath, `行内列数 ${row.length} 超过上限 ${XLSX_LIMITS.maxColumnsPerSheet}`);
    }
    row.forEach((cellInput, c) => {
      const cell = normalizeCell(cellInput, `${rowPath}[${c}]`);
      // 列基准样式（宽度/格式/样式）作为底，单元格自身样式优先
      const colSpec = columnSpecs.get(c + 1);
      if (colSpec) {
        if (colSpec.numFmt && cell.style.numFmt === undefined) cell.style.numFmt = colSpec.numFmt;
        if (colSpec.style) cell.style = { ...colSpec.style, ...cell.style };
      }
      setCell(cursor, c + 1, cell);
    });
    cursor += 1;
  });

  // 精确单元格放置（覆盖同名位置）
  if (s.cells !== undefined) {
    if (!Array.isArray(s.cells)) fail(`${path}.cells`, `必须是 { ref, ...单元格声明 } 数组`);
    if (s.cells.length > XLSX_LIMITS.maxTotalCells) {
      fail(`${path}.cells`, `精确单元格数量 ${s.cells.length} 超过上限 ${XLSX_LIMITS.maxTotalCells}`);
    }
    s.cells.forEach((placement, i) => {
      const pPath = `${path}.cells[${i}]`;
      if (!placement || typeof placement !== 'object' || Array.isArray(placement)) {
        fail(pPath, `单元格放置必须是含 ref 字段的对象`);
      }
      const { ref, ...rest } = placement as XlsxCellPlacement;
      const { row, col } = parseRef(ref, `${pPath}.ref`);
      // 工具级实用边界：防止 row/col 接近 Excel 上限导致后续遍历（自动列宽等）失控
      if (row > XLSX_LIMITS.maxPlacementRow || col > XLSX_LIMITS.maxColumnsPerSheet) {
        fail(
          `${pPath}.ref`,
          `引用 ${JSON.stringify(ref)} 超出工具支持范围（行 ≤ ${XLSX_LIMITS.maxPlacementRow}，列 ≤ ${XLSX_LIMITS.maxColumnsPerSheet}）`,
        );
      }
      const cell = normalizeCell(rest, pPath);
      setCell(row, col, cell);
    });
  }

  if (model.maxRow === 0 || model.maxCol === 0) {
    // rows 全空行的极端情形
    if (model.titleRow === null) fail(path, `工作表没有任何有效内容`);
  }

  // 合并区域
  if (s.merges !== undefined) {
    if (!Array.isArray(s.merges)) fail(`${path}.merges`, `合并区域必须是字符串数组（如 ['A1:C1']）`);
    if (s.merges.length > XLSX_LIMITS.maxMergesPerSheet) {
      fail(`${path}.merges`, `合并区域数量 ${s.merges.length} 超过上限 ${XLSX_LIMITS.maxMergesPerSheet}`);
    }
    const seen = new Set<string>();
    s.merges.forEach((range, i) => {
      const r = parseRange(range, `${path}.merges[${i}]`);
      // 重叠检测（与已登记区域两两比较）
      for (const prev of model.merges) {
        if (r.r1 <= prev.r2 && r.r2 >= prev.r1 && r.c1 <= prev.c2 && r.c2 >= prev.c1) {
          const prevStr = `${indexToCol(prev.c1)}${prev.r1}:${indexToCol(prev.c2)}${prev.r2}`;
          fail(`${path}.merges[${i}]`, `合并区域 ${range} 与已存在区域 ${prevStr} 重叠`);
        }
      }
      // 非左上角单元格不允许携带数据（合并后会被清除，属静默数据丢失）
      for (let r2 = r.r1; r2 <= r.r2; r2++) {
        for (let c2 = r.c1; c2 <= r.c2; c2++) {
          if (r2 === r.r1 && c2 === r.c1) continue;
          const existing = getCell(r2, c2);
          if (existing && existing.kind !== 'empty') {
            fail(
              `${path}.merges[${i}]`,
              `合并区域 ${range} 内的非左上角单元格 ${indexToCol(c2)}${r2} 含有数据，合并后会被清除——请只保留区域左上角的数据`,
            );
          }
        }
      }
      const key = `${r.r1}:${r.c1}:${r.r2}:${r.c2}`;
      if (seen.has(key)) return; // 重复区域静默去重
      seen.add(key);
      model.merges.push(r);
      model.mergeStrings.push(`${indexToCol(r.c1)}${r.r1}:${indexToCol(r.c2)}${r.r2}`);
    });
  }

  // 大标题跨列合并
  if (model.titleRow !== null && model.maxCol > 1) {
    const r1 = model.titleRow;
    const r2 = model.titleRow;
    if (!model.merges.some(m => m.r1 === r1 && m.r2 === r2 && m.c1 === 1 && m.c2 === model.maxCol)) {
      const range = { r1, c1: 1, r2, c2: model.maxCol };
      // 标题合并区域与显式合并的重叠检测
      for (const prev of model.merges) {
        if (range.r1 <= prev.r2 && range.r2 >= prev.r1 && range.c1 <= prev.c2 && range.c2 >= prev.c1) {
          fail(`${path}.title`, `大标题跨列合并区域与显式合并区域 ${indexToCol(prev.c1)}${prev.r1}:${indexToCol(prev.c2)}${prev.r2} 重叠`);
        }
      }
      model.merges.push(range);
      model.mergeStrings.push(`A${r1}:${indexToCol(model.maxCol)}${r2}`);
    }
  }

  // 冻结：显式 freeze（字符串引用或 false 关闭）> headers 默认（冻结表头下方一行）；
  // 其它类型（数字/true/对象等）直接报错，避免静默歧义
  if (s.freeze === undefined || s.freeze === null) {
    if (model.headerRow !== null) model.freeze = { xSplit: 0, ySplit: model.headerRow };
  } else if (s.freeze === false) {
    model.freeze = null;
  } else if (typeof s.freeze === 'string') {
    const { row, col } = parseRef(s.freeze, `${path}.freeze`);
    model.freeze = { xSplit: col - 1, ySplit: row - 1 };
  } else {
    fail(`${path}.freeze`, `必须是单元格引用字符串（如 'A2'）或 false，实际收到 ${JSON.stringify(s.freeze) ?? String(s.freeze)}`);
  }

  // 自动筛选（作用于表头行（或首行）到已用区域末尾；仅一行内容时不生效）
  if (autoFilterFlag) {
    const fromRow = model.headerRow ?? 1;
    if (model.maxRow > fromRow && model.maxCol >= 1) {
      model.autoFilter = {
        from: { row: fromRow, column: 1 },
        to: { row: model.maxRow, column: model.maxCol },
      };
    }
  }

  // 列宽：显式 width 优先，否则自动
  const colWidthsSpec = ((): { auto?: boolean; minWidth?: number; maxWidth?: number } => {
    if (s.colWidths === undefined || s.colWidths === null) return {};
    if (typeof s.colWidths !== 'object' || Array.isArray(s.colWidths)) {
      fail(`${path}.colWidths`, `必须是 { auto?, minWidth?, maxWidth? } 对象`);
    }
    const cw = s.colWidths as Record<string, unknown>;
    const out: { auto?: boolean; minWidth?: number; maxWidth?: number } = {};
    if (cw.auto !== undefined) {
      if (typeof cw.auto !== 'boolean') fail(`${path}.colWidths.auto`, `必须是布尔值，实际收到 ${JSON.stringify(cw.auto)}`);
      out.auto = cw.auto;
    }
    for (const key of ['minWidth', 'maxWidth'] as const) {
      if (cw[key] === undefined) continue;
      if (typeof cw[key] !== 'number' || !Number.isFinite(cw[key]) || (cw[key] as number) < 1 || (cw[key] as number) > 255) {
        fail(`${path}.colWidths.${key}`, `必须是 1-255 的数字，实际收到 ${JSON.stringify(cw[key])}`);
      }
      out[key] = cw[key] as number;
    }
    if (out.minWidth !== undefined && out.maxWidth !== undefined && out.minWidth > out.maxWidth) {
      fail(`${path}.colWidths`, `minWidth(${out.minWidth}) 不能大于 maxWidth(${out.maxWidth})`);
    }
    return out;
  })();
  const autoWidths = colWidthsSpec.auto !== false;
  const minWidth = Math.max(1, colWidthsSpec.minWidth ?? 6);
  const maxWidth = Math.min(255, colWidthsSpec.maxWidth ?? 45);
  for (const [idx, spec] of columnSpecs) {
    if (spec.width !== undefined) model.columnWidths.set(idx, spec.width);
  }
  if (autoWidths) {
    for (let c = 1; c <= model.maxCol; c++) {
      if (model.columnWidths.has(c)) continue;
      let widest = 0;
      for (let r = 1; r <= model.maxRow; r++) {
        const cell = getCell(r, c);
        if (!cell) continue;
        if (model.titleRow === r) continue; // 合并大标题不参与列宽
        // 换行符按最长行估宽
        const lines = cell.display.split(/\n/);
        for (const line of lines) {
          const w = displayWidth(line);
          if (w > widest) widest = w;
        }
      }
      const width = Math.min(maxWidth, Math.max(minWidth, Math.ceil(widest * 1.1) + 2));
      model.columnWidths.set(c, width);
    }
  }

  return model;
}

// ──────────────────────────── ExcelJS 写入 ────────────────────────────

let excelJsModulePromise: Promise<{ Workbook: new () => ExcelJsWorkbook }> | null = null;

/**
 * 动态加载 exceljs 自包含浏览器构建（代码分割，避免常驻扩展包内存）。
 * 加载失败时清除缓存允许可重试，并以可行动的错误信息上抛（扩展文件缺失/损坏）。
 */
function loadExcelJS(): Promise<{ Workbook: new () => ExcelJsWorkbook }> {
  if (!excelJsModulePromise) {
    excelJsModulePromise = import('exceljs/dist/exceljs.min.js').then(
      mod => {
        // UMD 构建：命名空间挂在 default（ESM 互操作）或模块自身
        const namespace = (mod as { default?: unknown }).default ?? mod;
        const resolved = namespace as { Workbook?: unknown } | null | undefined;
        if (!resolved || typeof resolved.Workbook !== 'function') {
          throw new XlsxBuildError('Excel 引擎模块结构异常（缺少 Workbook 构造器）——请刷新或重新安装扩展后重试');
        }
        return resolved as { Workbook: new () => ExcelJsWorkbook };
      },
      error => {
        // 瞬态失败（网络/文件缺失）不缓存，允许下一次调用重试
        excelJsModulePromise = null;
        const reason = error instanceof Error ? error.message : String(error);
        throw new XlsxBuildError(`Excel 引擎加载失败（${reason}）——请刷新页面或重新安装扩展后重试`);
      },
    );
  }
  return excelJsModulePromise;
}

function styleToBorder(style: XlsxStyleSpec): ExcelJsBorder | undefined {
  if (style.border === undefined) return undefined;
  const colorArgb = style.borderColor !== undefined ? parseColorArgb(style.borderColor, 'style.borderColor') : BORDER_ARGB;
  const edge = (name: XlsxBorderStyleName) =>
    name === 'none' ? undefined : { style: name, color: { argb: colorArgb } };
  if (typeof style.border === 'string') {
    const e = edge(style.border);
    return e ? { top: e, bottom: e, left: e, right: e } : undefined;
  }
  const b = style.border;
  const out: ExcelJsBorder = {};
  if (b.top && b.top !== 'none') out.top = { style: b.top, color: { argb: colorArgb } };
  if (b.bottom && b.bottom !== 'none') out.bottom = { style: b.bottom, color: { argb: colorArgb } };
  if (b.left && b.left !== 'none') out.left = { style: b.left, color: { argb: colorArgb } };
  if (b.right && b.right !== 'none') out.right = { style: b.right, color: { argb: colorArgb } };
  return Object.keys(out).length > 0 ? out : undefined;
}

function applyStyleToCell(target: ExcelJsCell, style: XlsxStyleSpec): void {
  const font: Partial<ExcelJsFont> = {};
  if (style.bold !== undefined) font.bold = style.bold;
  if (style.italic !== undefined) font.italic = style.italic;
  if (style.underline !== undefined) font.underline = style.underline;
  if (style.strike !== undefined) font.strike = style.strike;
  if (style.fontSize !== undefined) font.size = style.fontSize;
  if (style.fontName !== undefined) font.name = style.fontName;
  if (style.fontColor !== undefined) font.color = { argb: parseColorArgb(style.fontColor, 'style.fontColor') };
  // ExcelJS 样式为赋值前 undefined 的 getter，统一采用合并赋值（保留可能存在的既有属性）
  if (Object.keys(font).length > 0) target.font = { ...(target.font ?? {}), ...font };

  if (style.fillColor !== undefined) {
    target.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: parseColorArgb(style.fillColor, 'style.fillColor') },
    };
  }

  const border = styleToBorder(style);
  if (border) target.border = { ...(target.border ?? {}), ...border };

  const alignment: Record<string, unknown> = {};
  if (style.hAlign !== undefined) alignment.horizontal = style.hAlign;
  if (style.vAlign !== undefined) alignment.vertical = style.vAlign;
  if (style.wrap !== undefined) alignment.wrapText = style.wrap;
  if (Object.keys(alignment).length > 0) {
    target.alignment = { ...(target.alignment ?? {}), ...(alignment as ExcelJsAlignment) };
  }

  if (style.numFmt) target.numFmt = style.numFmt;
}

/** 单元格最终样式 = 美化默认值(底) × 显式样式(顶) */
function mergeStyles(base: XlsxStyleSpec, override: XlsxStyleSpec): XlsxStyleSpec {
  return { ...base, ...override };
}

/**
 * 构建工作簿并输出 xlsx 二进制。
 * @param sheets 工作表声明数组（1-16 张）
 */
export async function buildWorkbook(sheets: unknown): Promise<XlsxBuildOutput> {
  if (!Array.isArray(sheets)) {
    fail('sheets', `必须是工作表对象数组，实际收到 ${sheets === null ? 'null' : typeof sheets}`);
  }
  if (sheets.length === 0) fail('sheets', `至少需要 1 张工作表`);
  if (sheets.length > XLSX_LIMITS.maxSheets) {
    fail('sheets', `工作表数量 ${sheets.length} 超过上限 ${XLSX_LIMITS.maxSheets}`);
  }

  // 工作表名前置校验 + 去重（大小写不敏感）：在逐项建模前先拦截结构性错误，报错顺序更友好
  const nameSet = new Set<string>();
  sheets.forEach((sheet, i) => {
    if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) {
      fail(`sheets[${i}]`, `工作表必须是对象，实际收到 ${Array.isArray(sheet) ? '数组' : typeof sheet}`);
    }
    const name = validateSheetName((sheet as Record<string, unknown>).name, `sheets[${i}].name`);
    const key = name.toLowerCase();
    if (nameSet.has(key)) fail(`sheets[${i}].name`, `工作表名 "${name}" 与前面的工作表重复`);
    nameSet.add(key);
  });

  const models = sheets.map((spec, i) => buildSheetModel(spec, i));

  // 总单元格数守卫
  const totalCells = models.reduce((sum, m) => sum + m.cells.size, 0);
  if (totalCells > XLSX_LIMITS.maxTotalCells) {
    fail('sheets', `总单元格数 ${totalCells} 超过上限 ${XLSX_LIMITS.maxTotalCells}（请精简数据或减少样式化空单元格）`);
  }

  const ExcelJS = await loadExcelJS();
  const workbook: ExcelJsWorkbook = new ExcelJS.Workbook();

  // ExcelJS 写入/序列化阶段的意外异常统一包裹为可读错误（XlsxBuildError 原样透传）
  let buffer: ArrayBuffer;
  try {
    for (const model of models) {
      renderSheetModel(workbook, model);
    }
    buffer = await workbook.xlsx.writeBuffer();
  } catch (error) {
    if (error instanceof XlsxBuildError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new XlsxBuildError(`工作簿写入失败：${reason}（常见原因：公式引用非法、样式值不受支持）`);
  }

  return {
    buffer,
    totalCells,
    sheets: models.map(m => ({
      name: m.name,
      rowCount: m.maxRow,
      columnCount: m.maxCol,
      mergeCount: m.merges.length,
      hasHeader: m.headerRow !== null,
      frozen: m.freeze !== null,
    })),
  };
}

// ──────────────────────────── 工作簿渲染（模型 → ExcelJS） ────────────────────────────

/** 数据单元格默认美化：细边框 + 垂直居中 */
const DATA_BASE_STYLE: XlsxStyleSpec = { border: 'thin', vAlign: 'middle' };
/** 表头默认美化：蓝底白字加粗居中 + 细边框 */
const HEADER_BASE_STYLE: XlsxStyleSpec = {
  border: 'thin',
  vAlign: 'middle',
  hAlign: 'center',
  bold: true,
  fontColor: '#FFFFFF',
  fillColor: '#4472C4',
};
/** 大标题默认底样式（其自身字体样式在模型层已带） */
const TITLE_BASE_STYLE: XlsxStyleSpec = { border: 'thin' };
/** 斑马纹底色（浅蓝灰） */
const ZEBRA_FILL = 'F4F8FC';

/** 把单张工作表模型渲染进工作簿（单元格 → 合并 → 行高列宽 → 视图/筛选/打印） */
function renderSheetModel(workbook: ExcelJsWorkbook, model: SheetModel): void {
  const ws = workbook.addWorksheet(model.name, {
    properties: model.tabColor ? { tabColor: { argb: model.tabColor } } : undefined,
  });

  // ── 写入单元格 ──
  for (const [key, cell] of model.cells) {
    const [r, c] = key.split(':').map(Number);
    const target = ws.getCell(r, c);
    let style: XlsxStyleSpec;

    if (model.headerRow === r) {
      style = mergeStyles(HEADER_BASE_STYLE, cell.style);
    } else if (model.titleRow === r && c === 1) {
      style = mergeStyles(TITLE_BASE_STYLE, cell.style);
    } else {
      // 链接单元格的默认蓝色下划线作为「基准样式的一部分」，确保边框/斑马纹等
      // 其它默认美化不被覆盖（整体替换 style 会导致链接格丢失边框）
      const linkDefaults: XlsxStyleSpec = cell.kind === 'link' ? { underline: true, fontColor: '#0563C1' } : {};
      style = mergeStyles(mergeStyles(DATA_BASE_STYLE, linkDefaults), cell.style);
      if (model.zebra) {
        const dataOffset = r - model.dataStartRow;
        if (dataOffset >= 0 && dataOffset % 2 === 1 && style.fillColor === undefined) {
          style = { ...style, fillColor: ZEBRA_FILL };
        }
      }
    }

    switch (cell.kind) {
      case 'empty':
        break;
      case 'plain':
        target.value = cell.value ?? null;
        break;
      case 'formula':
        target.value = { formula: cell.formula! };
        break;
      case 'richText':
        target.value = {
          richText: cell.richText!.map(part => ({
            text: part.text,
            font: {
              bold: part.bold,
              italic: part.italic,
              size: part.size,
              color: part.color !== undefined ? { argb: parseColorArgb(part.color, 'richText.color') } : undefined,
            },
          })),
        };
        break;
      case 'link':
        target.value = { text: String(cell.value ?? cell.link), hyperlink: cell.link! };
        break;
      case 'date':
        target.value = cell.date!;
        break;
    }

    applyStyleToCell(target, style);
  }

  // ── 合并区域：为区域内格子补齐样式空格（保证边框/底色完整）后执行合并 ──
  for (const range of model.merges) {
    const master = model.cells.get(cellKey(range.r1, range.c1));
    const masterStyle = master
      ? model.headerRow === range.r1
        ? mergeStyles(HEADER_BASE_STYLE, master.style)
        : mergeStyles(DATA_BASE_STYLE, master.style)
      : DATA_BASE_STYLE;
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c <= range.c2; c++) {
        if (model.cells.has(cellKey(r, c))) continue;
        applyStyleToCell(ws.getCell(r, c), masterStyle);
      }
    }
    ws.mergeCells(`${indexToCol(range.c1)}${range.r1}:${indexToCol(range.c2)}${range.r2}`);
  }

  // ── 行高 / 列宽 / 视图 / 筛选 / 打印 ──
  for (const [row, height] of model.rowHeights) {
    (ws.getRow(row) as ExcelJsRow).height = height;
  }
  for (const [col, width] of model.columnWidths) {
    (ws.getColumn(col) as ExcelJsColumn).width = width;
  }
  if (model.freeze) {
    ws.views = [{ state: 'frozen', xSplit: model.freeze.xSplit, ySplit: model.freeze.ySplit }];
  }
  if (model.autoFilter) {
    ws.autoFilter = model.autoFilter;
  }
  if (model.landscape) {
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  }
}

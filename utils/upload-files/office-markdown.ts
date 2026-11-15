/**
 * Office 文档 → Markdown 转换（DOM-free，service worker 可用）
 *
 * 为什么不用 DOMParser：file_util 在 background service worker 中执行，
 * 那里没有 DOM。本模块因此自带一个**最小 XML 扫描器**（不做 DOM 构建，
 * 只做事件流），配合 fflate 解包 OOXML（zip 容器），把
 * xlsx / docx / pptx 的完整正文抽取为 Markdown。
 *
 * 与旧版附件解析器（entrypoints/sidepanel/utils/chat/attachment-parser.ts，
 * 基于 DOMParser + TreeWalker）的差异与取舍：
 *   - DOM-free：换来「工具在后台执行时也能读 Office 文件」这一关键能力；
 *   - 结构保真度：段落顺序、标题层级、列表项、表格行列、幻灯片顺序
 *     全部保留（docx 的 w:pStyle / w:numPr、pptx 的 sldIdLst 顺序都被解析），
 *     而不是拍平成一坨纯文本——AI 要在这些文档里做检索与结构化提取。
 *
 * 失败语义：任何结构异常都抛 OfficeConversionError（携带可读的 reason），
 * 由工具层包装成「错误类型 + 原因 + 处置建议」；绝不静默返回空正文——
 * 空的 markdown 与「文档确实没有内容」必须可区分。
 */

import { strFromU8, unzipSync } from 'fflate';
import type { ExcelJsCellValue, ExcelJsWorkbook } from 'exceljs/dist/exceljs.min.js';

// ==================== 错误 ====================

/** Office 解析失败（reason 面向模型，可直接作为处置依据） */
export class OfficeConversionError extends Error {
  readonly reason: string;

  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason);
    this.name = 'OfficeConversionError';
    this.reason = reason;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

// ==================== 最小 XML 扫描器 ====================

interface XmlAttrs {
  [key: string]: string;
}

type XmlEvent =
  | { kind: 'open'; name: string; local: string; attrs: XmlAttrs }
  | { kind: 'close'; name: string; local: string }
  | { kind: 'text'; value: string };

/** 取 localName（去掉命名空间前缀）：w:p → p */
function localOf(name: string): string {
  const colon = name.indexOf(':');
  return colon >= 0 ? name.slice(colon + 1) : name;
}

/** XML 实体反转义（含十进制 / 十六进制数值引用） */
function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    switch (entity) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const hex = entity[1] === 'x' || entity[1] === 'X';
        const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
    }
  });
}

/** 解析标签属性 */
function parseAttributes(source: string): XmlAttrs {
  const attrs: XmlAttrs = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const raw = match[2] ?? match[3] ?? '';
    attrs[match[1]] = decodeEntities(raw);
  }
  return attrs;
}

/**
 * 取属性值（忽略命名空间前缀）。
 *
 * OOXML 的属性名带前缀（w:val / r:id / p:ph 的 type 等），生成器也可能
 * 使用不同前缀——按 localName 匹配让判定与前缀无关。
 */
function attrValue(attrs: XmlAttrs, name: string): string | undefined {
  const exact = attrs[name];
  if (typeof exact === 'string') return exact;
  for (const [key, value] of Object.entries(attrs)) {
    if (localOf(key) === name) return value;
  }
  return undefined;
}

/**
 * 取**带前缀**属性的值（r:id 这类关系引用专用）。
 *
 * 与 attrValue 的区别：刻意排除无前缀同名属性——`<p:sldId id="256"
 * r:id="rId2">` 里 `id` 是幻灯片标识、`r:id` 才是关系引用；按 localName
 * 匹配会先命中数字 id，把关系查找带偏（幻灯片顺序会退化成文件名排序）。
 */
function attrPrefixedValue(attrs: XmlAttrs, name: string): string | undefined {
  for (const [key, value] of Object.entries(attrs)) {
    if (key.includes(':') && localOf(key) === name) return value;
  }
  return undefined;
}

/**
 * 把 XML 文本扫成事件流（open / close / text）。
 *
 * 只做「标签级」扫描，不构建 DOM 树——OOXML 的结构语义由各转换器按
 * localName 自行解释。CDATA 原样保留；注释、处理指令、DOCTYPE 跳过。
 */
export function scanXml(xml: string): XmlEvent[] {
  const events: XmlEvent[] = [];
  let index = 0;
  const length = xml.length;
  while (index < length) {
    const lt = xml.indexOf('<', index);
    if (lt < 0) {
      const tail = xml.slice(index);
      if (tail) events.push({ kind: 'text', value: decodeEntities(tail) });
      break;
    }
    if (lt > index) {
      events.push({ kind: 'text', value: decodeEntities(xml.slice(index, lt)) });
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      index = end < 0 ? length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      events.push({ kind: 'text', value: xml.slice(lt + 9, end < 0 ? length : end) });
      index = end < 0 ? length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt);
      index = end < 0 ? length : end + 1;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt < 0) break;
    const inner = xml.slice(lt + 1, gt);
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      events.push({ kind: 'close', name, local: localOf(name) });
    } else {
      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const nameMatch = /^([^\s/>]+)/.exec(body);
      const name = nameMatch ? nameMatch[1] : '';
      const attrs = parseAttributes(body.slice(name.length));
      events.push({ kind: 'open', name, local: localOf(name), attrs });
      if (selfClosing) events.push({ kind: 'close', name, local: localOf(name) });
    }
    index = gt + 1;
  }
  return events;
}

// ==================== 通用 Markdown 渲染 ====================

/** 表格单元格转义：竖线与换行会破坏 Markdown 表格结构 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ').trim();
}

/** 二维数组 → Markdown 表格（首行作表头；无数据行时仅输出表头与分隔行） */
function renderTable(rows: string[][]): string[] {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width === 0) return [];
  const normalized = rows.map(row => {
    const cells = row.slice(0, width).map(escapeCell);
    while (cells.length < width) cells.push('');
    return cells;
  });
  const lines = [
    `| ${normalized[0].join(' | ')} |`,
    `| ${new Array(width).fill('---').join(' | ')} |`,
  ];
  for (const row of normalized.slice(1)) lines.push(`| ${row.join(' | ')} |`);
  return lines;
}

/** 连续空行折叠 + 去首尾空行 */
function collapseBlankLines(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed === '' && result.length > 0 && result[result.length - 1] === '') continue;
    result.push(trimmed);
  }
  while (result.length > 0 && result[result.length - 1] === '') result.pop();
  while (result.length > 0 && result[0] === '') result.shift();
  return result;
}

// ==================== zip 解包 ====================

/** 解包并按需筛选成员（不解压媒体目录，避免无谓的内存峰值） */
function unzipMembers(bytes: Uint8Array, accept: (name: string) => boolean): Record<string, string> {
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes, { filter: file => accept(file.name) });
  } catch (error) {
    throw new OfficeConversionError(
      `文件不是有效的 Office 包（zip 损坏或已加密）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const members: Record<string, string> = {};
  for (const [name, data] of Object.entries(raw)) {
    try {
      members[name] = strFromU8(data);
    } catch (error) {
      throw new OfficeConversionError(`成员 ${name} 解码失败：${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }
  return members;
}

// ==================== docx → Markdown ====================

interface ParagraphState {
  text: string;
  style: string;
  list: boolean;
}

/** w:pStyle → 标题层级（英文 HeadingN / 中文 Word 的数字样式 id / Title） */
function headingLevelOf(style: string): number {
  const value = style.trim();
  if (!value) return 0;
  const heading = /^heading\s*(\d)$/i.exec(value);
  if (heading) return Number.parseInt(heading[1], 10);
  if (/^title$/i.test(value)) return 1;
  if (/^subtitle$/i.test(value)) return 2;
  if (/^\d$/.test(value)) return Number.parseInt(value, 10);
  return 0;
}

/** docx 主文档 → Markdown（段落保序 + 标题层级 + 列表 + 表格） */
/** docx 表格构建帧（嵌套表格用栈隔离：内层的行/格不得污染外层的装配状态） */
interface TableFrame {
  rows: string[][];
  row: string[] | null;
  cellLines: string[];
}

function docxDocumentToMarkdown(xml: string): string {
  const events = scanXml(xml);
  const lines: string[] = [];
  const paragraphs: ParagraphState[] = [];
  let textDepth = 0;
  /** 表格帧栈：docx 允许单元格内嵌套表格，共享变量会互相踩踏 */
  const tables: TableFrame[] = [];

  const currentParagraph = (): ParagraphState | undefined => paragraphs[paragraphs.length - 1];
  const currentTable = (): TableFrame | undefined => tables[tables.length - 1];

  for (const event of events) {
    if (event.kind === 'open') {
      switch (event.local) {
        case 'p':
          paragraphs.push({ text: '', style: '', list: false });
          break;
        case 't':
          textDepth += 1;
          break;
        case 'tab': {
          const paragraph = currentParagraph();
          if (paragraph) paragraph.text += '\t';
          break;
        }
        case 'br':
        case 'cr': {
          const paragraph = currentParagraph();
          if (paragraph) paragraph.text += '\n';
          break;
        }
        case 'pStyle': {
          const paragraph = currentParagraph();
          const style = attrValue(event.attrs, 'val');
          if (paragraph && style) paragraph.style = style;
          break;
        }
        case 'numPr': {
          const paragraph = currentParagraph();
          if (paragraph) paragraph.list = true;
          break;
        }
        case 'tbl':
          tables.push({ rows: [], row: null, cellLines: [] });
          break;
        case 'tr': {
          const frame = currentTable();
          if (frame) frame.row = [];
          break;
        }
        case 'tc': {
          const frame = currentTable();
          if (frame) frame.cellLines = [];
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (event.kind === 'close') {
      switch (event.local) {
        case 't':
          textDepth = Math.max(0, textDepth - 1);
          break;
        case 'p': {
          const paragraph = paragraphs.pop();
          if (!paragraph) break;
          const rendered = renderDocxParagraph(paragraph);
          const frame = currentTable();
          if (frame) {
            if (rendered) frame.cellLines.push(rendered);
          } else {
            lines.push(rendered);
          }
          break;
        }
        case 'tc': {
          const frame = currentTable();
          if (frame?.row) {
            frame.row.push(frame.cellLines.join(' '));
            frame.cellLines = [];
          }
          break;
        }
        case 'tr': {
          const frame = currentTable();
          if (frame?.row && frame.row.length > 0) frame.rows.push(frame.row);
          if (frame) frame.row = null;
          break;
        }
        case 'tbl': {
          const frame = tables.pop();
          if (!frame) break;
          const rendered = renderTable(frame.rows);
          const parent = currentTable();
          if (parent) {
            // 嵌套表格：整表压平成所在单元格的一行文本（外层表格结构不被破坏）
            parent.cellLines.push(rendered.join(' '));
          } else if (rendered.length > 0) {
            lines.push('', ...rendered, '');
          }
          break;
        }
        default:
          break;
      }
      continue;
    }

    // 文本事件：只有位于 <w:t> 内部的文本才是正文（标签间的缩进空白必须忽略）
    if (textDepth > 0) {
      const paragraph = currentParagraph();
      if (paragraph) paragraph.text += event.value;
    }
  }

  return collapseBlankLines(lines).join('\n');
}

/** docx 段落 → Markdown 行（空段落返回空串，标题返回 '#' 前缀） */
function renderDocxParagraph(paragraph: ParagraphState): string {
  const text = paragraph.text.trim();
  if (!text) return '';
  const level = headingLevelOf(paragraph.style);
  if (level > 0) return `${'#'.repeat(Math.min(level, 6))} ${text}`;
  if (paragraph.list) return `- ${text}`;
  return text;
}

// ==================== pptx → Markdown ====================

/** 幻灯片形状内的文本（标题与正文分离） */
interface SlideShape {
  title: boolean;
  paragraphs: string[];
}

/** pptx 单页 → Markdown 行 */
function pptxSlideToMarkdown(xml: string): string[] {
  const events = scanXml(xml);
  const lines: string[] = [];
  const shapes: SlideShape[] = [];
  let textDepth = 0;
  let paragraphBuffer: string[] | null = null;
  /** 表格帧栈：与 docx 同构（嵌套表格隔离 + 单元格文本收集） */
  const tables: TableFrame[] = [];

  const currentTable = (): TableFrame | undefined => tables[tables.length - 1];

  for (const event of events) {
    if (event.kind === 'open') {
      switch (event.local) {
        case 'sp':
          shapes.push({ title: false, paragraphs: [] });
          break;
        case 'ph': {
          const shape = shapes[shapes.length - 1];
          const type = attrValue(event.attrs, 'type') ?? '';
          if (shape && (type === 'title' || type === 'ctrTitle')) shape.title = true;
          break;
        }
        case 'p':
          paragraphBuffer = [];
          break;
        case 't':
          textDepth += 1;
          break;
        case 'tbl':
          tables.push({ rows: [], row: null, cellLines: [] });
          break;
        case 'tr': {
          const frame = currentTable();
          if (frame) frame.row = [];
          break;
        }
        case 'tc': {
          const frame = currentTable();
          if (frame) frame.cellLines = [];
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (event.kind === 'close') {
      switch (event.local) {
        case 't':
          textDepth = Math.max(0, textDepth - 1);
          break;
        case 'p': {
          const text = (paragraphBuffer ?? []).join('').trim();
          paragraphBuffer = null;
          if (!text) break;
          const frame = currentTable();
          if (frame) {
            // 表格内段落 → 单元格文本（此前实现漏收，幻灯片表格会整体静默丢失）
            frame.cellLines.push(text);
            break;
          }
          const shape = shapes[shapes.length - 1];
          if (shape) shape.paragraphs.push(text);
          break;
        }
        case 'sp': {
          const shape = shapes.pop();
          if (!shape) break;
          const titleLines = shape.title ? shape.paragraphs : [];
          const bodyLines = shape.title ? [] : shape.paragraphs;
          if (titleLines.length > 0) lines.push(`**${titleLines[0]}**`);
          for (const text of bodyLines) lines.push(`- ${text}`);
          break;
        }
        case 'tc': {
          const frame = currentTable();
          if (frame?.row) {
            frame.row.push(frame.cellLines.join(' '));
            frame.cellLines = [];
          }
          break;
        }
        case 'tr': {
          const frame = currentTable();
          if (frame?.row && frame.row.length > 0) frame.rows.push(frame.row);
          if (frame) frame.row = null;
          break;
        }
        case 'tbl': {
          const frame = tables.pop();
          if (!frame) break;
          const rendered = renderTable(frame.rows);
          const parent = currentTable();
          if (parent) {
            parent.cellLines.push(rendered.join(' '));
          } else if (rendered.length > 0) {
            lines.push('', ...rendered, '');
          }
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (textDepth > 0 && paragraphBuffer) paragraphBuffer.push(event.value);
  }

  return lines;
}

/**
 * 幻灯片顺序：优先按 presentation.xml 的 sldIdLst + rels 映射（真实放映顺序），
 * 解析失败时回退到 slideN 编号升序（绝大多数生成器按编号顺序写出）。
 */
function resolveSlideOrder(
  presentationXml: string | undefined,
  relsXml: string | undefined,
  available: ReadonlySet<string>,
): string[] {
  if (presentationXml && relsXml) {
    const relTargets = new Map<string, string>();
    for (const event of scanXml(relsXml)) {
      if (event.kind !== 'open' || event.local !== 'Relationship') continue;
      const id = attrValue(event.attrs, 'Id');
      const target = attrValue(event.attrs, 'Target');
      if (!id || !target) continue;
      const normalized = target.replace(/^\.\//, '');
      relTargets.set(id, normalized.startsWith('ppt/') ? normalized : `ppt/${normalized}`);
    }
    const ordered: string[] = [];
    for (const event of scanXml(presentationXml)) {
      if (event.kind !== 'open' || event.local !== 'sldId') continue;
      // r:id 是关系引用（目标幻灯片），无前缀 id 是幻灯片标识（数字）——
      // 二者同 localName，必须优先取带前缀者，否则查不到关系映射
      const rid = attrPrefixedValue(event.attrs, 'id') ?? attrValue(event.attrs, 'id');
      if (!rid) continue;
      const target = relTargets.get(rid);
      if (target && available.has(target)) ordered.push(target);
    }
    if (ordered.length > 0) return ordered;
  }
  return [...available].sort((a, b) => slideNumberOf(a) - slideNumberOf(b));
}

/** slideN.xml 的 N（用于顺序排序的兜底） */
function slideNumberOf(name: string): number {
  const match = /slide(\d+)\.xml$/.exec(name);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

// ==================== xlsx → Markdown ====================

/** ExcelJS 动态加载（与 xlsx-builder 同源，避免双份加载） */
let excelJsModulePromise: Promise<{ Workbook: new () => ExcelJsWorkbook }> | null = null;

function loadExcelJS(): Promise<{ Workbook: new () => ExcelJsWorkbook }> {
  if (!excelJsModulePromise) {
    excelJsModulePromise = import('exceljs/dist/exceljs.min.js').then(
      mod => {
        const namespace = (mod as { default?: unknown }).default ?? mod;
        const resolved = namespace as { Workbook?: unknown } | null | undefined;
        if (!resolved || typeof resolved.Workbook !== 'function') {
          throw new OfficeConversionError('Excel 引擎模块结构异常（缺少 Workbook 构造器）');
        }
        return resolved as { Workbook: new () => ExcelJsWorkbook };
      },
      error => {
        excelJsModulePromise = null;
        throw new OfficeConversionError(
          `Excel 引擎加载失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      },
    );
  }
  return excelJsModulePromise;
}

/** 单元格值 → 纯文本（富文本拼接 / 公式取结果 / 超链接取显示文本 / 日期本地化） */
function cellValueToText(value: ExcelJsCellValue | unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (typeof value === 'object') {
    const cell = value as Record<string, unknown>;
    if (Array.isArray(cell.richText)) {
      return (cell.richText as Array<{ text?: string }>).map(run => run.text ?? '').join('');
    }
    if (typeof cell.formula === 'string' || typeof cell.sharedFormula === 'string') {
      if (cell.result !== undefined && cell.result !== null) return cellValueToText(cell.result);
      return `=${String(cell.formula ?? '')}`;
    }
    if (typeof cell.hyperlink === 'string') {
      return typeof cell.text === 'string' && cell.text ? cell.text : cell.hyperlink;
    }
    if (typeof cell.error === 'string') return `#${cell.error}`;
    if (typeof cell.text === 'string') return cell.text;
    if (cell.richText === undefined && cell.formula === undefined && cell.hyperlink === undefined && cell.error === undefined) {
      // 兜底：未知对象形态取 JSON 文本（截断，避免单格撑爆上下文）
      try {
        return JSON.stringify(value).slice(0, 200);
      } catch {
        return '';
      }
    }
    return '';
  }
  return String(value);
}

/** xlsx 单表最大单元格数（防止格式化的空表按 16384 列展开） */
const MAX_XLSX_COLUMNS = 512;
/** xlsx 单次转换的单元格总数上限（超出即截断并标注） */
const MAX_XLSX_CELLS = 500_000;

/** xlsx → Markdown（多工作表分节，每表一张 Markdown 表格） */
async function xlsxToMarkdown(bytes: Uint8Array): Promise<string> {
  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  try {
    await workbook.xlsx.load(buffer as ArrayBuffer);
  } catch (error) {
    throw new OfficeConversionError(
      `工作簿载入失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const sections: string[] = [];
  for (const sheet of workbook.worksheets) {
    const rows: string[][] = [];
    let width = 0;
    let truncated = false;
    sheet.eachRow({ includeEmpty: false }, row => {
      if (truncated) return;
      const cells: string[] = [];
      const limit = Math.min(sheet.columnCount || 1, MAX_XLSX_COLUMNS);
      for (let column = 1; column <= limit; column++) {
        cells.push(cellValueToText(row.getCell(column).value));
      }
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      if (rows.length * Math.max(cells.length, 1) > MAX_XLSX_CELLS) {
        truncated = true;
        return;
      }
      width = Math.max(width, cells.length);
      rows.push(cells);
    });

    const lines = [`## ${sheet.name}`];
    if (rows.length > 0) {
      const rendered = renderTable(rows);
      // 表头行之外的对齐行由 renderTable 生成；此处补齐列宽一致性
      lines.push('', ...rendered);
    } else {
      lines.push('', '（空工作表）');
    }
    if (truncated) lines.push('', `（表格过大，仅导出前 ${rows.length} 行）`);
    sections.push(lines.join('\n'));
  }

  if (sections.length === 0) {
    throw new OfficeConversionError('工作簿中没有可读取的工作表');
  }
  return collapseBlankLines(sections.flatMap(section => section.split('\n'))).join('\n');
}

// ==================== 对外入口 ====================

/** 支持转换的 Office 后缀 */
export type OfficeExtension = 'xlsx' | 'docx' | 'pptx';

/** 该后缀是否属于可转换的 Office 文档 */
export function isOfficeExtension(ext: string): boolean {
  const value = ext.toLowerCase();
  return value === 'xlsx' || value === 'docx' || value === 'pptx';
}

/**
 * Office 文档 → Markdown 全文。
 *
 * @param bytes 原始字节（zip 容器）
 * @param ext   文件后缀（xlsx / docx / pptx）
 * @throws OfficeConversionError 包损坏 / 结构缺失 / 引擎加载失败
 */
export async function officeToMarkdown(bytes: Uint8Array, ext: OfficeExtension): Promise<string> {
  if (ext === 'xlsx') return xlsxToMarkdown(bytes);

  if (ext === 'docx') {
    const members = unzipMembers(bytes, name => name === 'word/document.xml');
    const xml = members['word/document.xml'];
    if (!xml) throw new OfficeConversionError('docx 缺少主文档 word/document.xml');
    const markdown = docxDocumentToMarkdown(xml);
    if (!markdown.trim()) {
      throw new OfficeConversionError('docx 主文档正文为空（可能只有图片或空段落）');
    }
    return markdown;
  }

  const members = unzipMembers(
    bytes,
    name =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name) ||
      name === 'ppt/presentation.xml' ||
      name === 'ppt/_rels/presentation.xml.rels',
  );
  const slideNames = Object.keys(members).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  if (slideNames.length === 0) throw new OfficeConversionError('pptx 中没有找到任何幻灯片');

  const available = new Set(slideNames);
  const ordered = resolveSlideOrder(members['ppt/presentation.xml'], members['ppt/_rels/presentation.xml.rels'], available);

  const sections: string[] = [];
  ordered.forEach((name, index) => {
    const lines = pptxSlideToMarkdown(members[name]);
    sections.push([`## 幻灯片 ${index + 1}`, '', ...lines].join('\n'));
  });
  const markdown = collapseBlankLines(sections.flatMap(section => section.split('\n'))).join('\n');
  if (!markdown.trim()) {
    throw new OfficeConversionError('pptx 中没有任何可提取的文本（可能只有图片）');
  }
  return markdown;
}

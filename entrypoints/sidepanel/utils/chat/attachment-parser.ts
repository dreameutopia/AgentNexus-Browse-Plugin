/**
 * 附件文件解析（纯逻辑，无 Vue 依赖）
 *
 * 职责：输入区「附件栏」的文件级解析能力，全部在 sidepanel DOM 上下文内完成，
 * 不依赖任何外部服务：
 *   - classifyAttachmentFile：按扩展名（MIME 兜底）把文件分为
 *     文本 / 图片 / 可解析 Office（xlsx·docx·pptx）/ 旧版二进制 Office / 不支持；
 *   - decodeTextBuffer：文本解码阶梯（BOM → UTF-8 严格 → GBK 严格 → UTF-8 宽松）；
 *   - imageToDataUrl：图片 → data URL（多模态 image_url 直传）；
 *   - parseOfficeDocument：OOXML（zip 容器）→ 纯文本/CSV，
 *     xlsx 优先转 CSV 表格格式（多工作表 + 富文本/公式/超链接/日期单元格），
 *     docx 保留段落与表格结构，pptx 按幻灯片 × 形状提取文本；
 *   - 媒体检测：OOXML 内嵌图片（word/media 等目录）只报告存在，不提取。
 *
 * 防御约定：
 *   - 所有解析失败抛 AttachmentParseError（用户可读消息），绝不静默返回空文本；
 *   - 加密 / 损坏的 zip（含被误改扩展名的文件）在解包层统一拦截；
 *   - DOMParser / document.evaluate 仅在此 DOM 上下文可用（service worker 不可用，
 *     本模块不得被 background 引用）。
 */

import { unzipSync, strFromU8 } from 'fflate';
import { t } from '@/utils/i18n';
import { arrayBufferToBase64 } from '@/utils/shared/base64';

// ==================== 类型 ====================

/** 文件分类结果（决定后续处理链路） */
export type AttachmentFileKind =
  /** 纯文本（含代码 / 标记 / 数据文件）：直接解码为文本 */
  | 'text'
  /** 图片：转 data URL 走多模态（要求当前模型声明了视觉能力） */
  | 'image'
  /** 新版 Office（xlsx / docx / pptx）：本地解析为纯文本后按文本逻辑处理 */
  | 'office'
  /** 旧版二进制 Office（doc / ppt / xls）：无可靠的纯 JS 解析方案，明确拒绝 */
  | 'legacy-office'
  /** 其他格式：明确拒绝 */
  | 'unsupported';

export interface FileClassification {
  kind: AttachmentFileKind;
  /** 小写扩展名（无扩展名为空串） */
  ext: string;
}

/** Office 文档解析产物：纯文本 + 是否含内嵌图片（供 UI 决定是否提示） */
export interface ParsedDocument {
  text: string;
  hasEmbeddedImages: boolean;
}

/** 解析失败（用户可读；调用方据此弹窗提示） */
export class AttachmentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentParseError';
  }
}

// ==================== 扩展名注册表 ====================

/**
 * 文本类扩展名（含代码 / 标记 / 数据 / 配置 / 字幕）。
 * 分类只决定「能不能进」，体积与上下文预算守卫由 use-attachments 负责。
 */
const TEXT_EXTS = new Set([
  // 纯文本 / 笔记
  'txt', 'text', 'log', 'nfo', 'rst', 'adoc', 'asciidoc', 'tex', 'org',
  // 标记 / 数据
  'md', 'markdown', 'mdx', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'config', 'properties', 'env',
  'gitignore', 'dockerfile', 'makefile', 'editorconfig',
  // Web / 样式（svg 按文本处理：主流视觉接口不接受 image/svg+xml）
  'html', 'htm', 'xhtml', 'svg', 'css', 'scss', 'sass', 'less',
  // 编程语言（主流全量）
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'pyw', 'ipynb', 'java',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'cs', 'go', 'rs', 'rb', 'php',
  'swift', 'kt', 'kts', 'scala', 'dart', 'vue', 'svelte', 'astro',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'ps1m',
  'sql', 'r', 'rmd', 'lua', 'pl', 'pm', 'vim', 'graphql', 'gql',
  // 字幕
  'srt', 'vtt', 'ass', 'ssa',
]);

/** 图片扩展名（浏览器原生可解码、主流多模态接口接受的栅格格式） */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']);

/** 新版 Office（OOXML，zip 容器，本模块可解析） */
const OFFICE_EXTS = new Set(['xlsx', 'docx', 'pptx']);

/** 旧版二进制 Office：给用户专门的转存建议而不是笼统的「不支持」 */
const LEGACY_OFFICE_EXTS = new Set(['doc', 'ppt', 'xls']);

/** HEIC/HEIF：iPhone 实况图，Chrome 桌面不原生解码，给专门提示 */
const HEIC_EXTS = new Set(['heic', 'heif', 'avif']);

/**
 * 文件选择器 accept 属性值（仅便利过滤；最终准入以分类为准，
 * 用户仍可通过「所有文件」选择任意文件，由分类明确拒绝）。
 */
export const ATTACHMENT_ACCEPT = [
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.yml', '.yaml',
  '.log', '.html', '.htm', '.svg', '.css', '.js', '.ts', '.py', '.java', '.go',
  '.rs', '.sql', '.sh', '.docx', '.pptx', '.xlsx',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
].join(',');

/**
 * 文件分类：扩展名优先（大小写不敏感），MIME 兜底（无扩展名 / 未知扩展名）。
 * 优先级：显式黑名单（旧版 Office / HEIC）→ 扩展名白名单 → MIME 前缀。
 */
export function classifyAttachmentFile(fileName: string, mimeType: string): FileClassification {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  const normalizedExt = fileName.includes('.') ? ext : '';
  const mime = (mimeType || '').toLowerCase();

  if (LEGACY_OFFICE_EXTS.has(normalizedExt)) return { kind: 'legacy-office', ext: normalizedExt };
  if (HEIC_EXTS.has(normalizedExt)) return { kind: 'unsupported', ext: normalizedExt };

  if (TEXT_EXTS.has(normalizedExt)) return { kind: 'text', ext: normalizedExt };
  if (IMAGE_EXTS.has(normalizedExt)) return { kind: 'image', ext: normalizedExt };
  if (OFFICE_EXTS.has(normalizedExt)) return { kind: 'office', ext: normalizedExt };

  // MIME 兜底：text/* 一律按文本；image/svg+xml 例外（按文本）
  if (mime.startsWith('text/')) return { kind: 'text', ext: normalizedExt };
  if (mime === 'image/svg+xml') return { kind: 'text', ext: normalizedExt || 'svg' };
  if (mime.startsWith('image/')) return { kind: 'image', ext: normalizedExt };

  return { kind: 'unsupported', ext: normalizedExt };
}

// ==================== 文本解码 ====================

/**
 * 文本解码阶梯（对任意输入不静默产出乱码）：
 *   1. BOM 识别（UTF-8 / UTF-16LE / UTF-16BE）→ 按 BOM 指定编码解码；
 *   2. 无 BOM：UTF-8 严格解码（非法字节序列抛错）；
 *   3. GBK 严格解码（中文 Windows 环境导出的 txt 最常见编码）；
 *   4. 兜底 UTF-8 宽松解码（替换不可解码字符，绝无二次抛错）。
 *
 * @throws AttachmentParseError 全部候选编码严格解码失败（实践上不可达，防御保留）
 */
export function decodeTextBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);

  // BOM：UTF-8 (EF BB BF) / UTF-16LE (FF FE) / UTF-16BE (FE FF)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeWith('utf-8', bytes.subarray(3), false);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeWith('utf-16le', bytes.subarray(2), false);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeWith('utf-16be', bytes.subarray(2), false);
  }

  // 无 BOM：UTF-8 严格 → GBK 严格 → UTF-8 宽松
  try {
    return decodeWith('utf-8', bytes, true);
  } catch {
    /* 落入下一档 */
  }
  try {
    return decodeWith('gbk', bytes, true);
  } catch {
    /* 落入兜底 */
  }
  return decodeWith('utf-8', bytes, false);
}

/** 单编码解码：fatal 控制严格/宽松模式，宽松模式不可达异常路径 */
function decodeWith(encoding: string, bytes: Uint8Array, fatal: boolean): string {
  try {
    return new TextDecoder(encoding, { fatal }).decode(bytes);
  } catch (error) {
    throw new AttachmentParseError(
      t('sidepanel.attachments.decodeFailed', { encoding, reason: error instanceof Error ? error.message : String(error) }),
    );
  }
}

// ==================== 图片 → data URL ====================

/** 扩展名 → MIME（file.type 缺失时兜底；默认 png） */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** 图片 → data URL（多模态 image_url 直传格式；base64 编码复用共享实现） */
export function imageToDataUrl(buffer: ArrayBuffer, ext: string, mimeType?: string): string {
  const mime = (mimeType && mimeType !== '') || IMAGE_MIME_BY_EXT[ext] || 'image/png';
  return `data:${mime};base64,${arrayBufferToBase64(buffer)}`;
}

// ==================== OOXML 解析 ====================

/**
 * 解析 Office 文档（xlsx / docx / pptx）为纯文本。
 * xlsx 优先输出 CSV 表格格式（多工作表带 `# 工作表: 名` 分节头），
 * docx 保留段落与表格结构（单元格以 | 分隔），pptx 按幻灯片 × 段落提取。
 *
 * @throws AttachmentParseError zip 损坏/加密、关键 XML 缺失或解码失败
 */
export async function parseOfficeDocument(buffer: ArrayBuffer, ext: string): Promise<ParsedDocument> {
  const bytes = new Uint8Array(buffer);
  // 第一层：zip 完整性 + 内嵌媒体检测（不解压媒体内容，只记录存在性）
  const { entries, hasEmbeddedImages } = listZipEntries(bytes);

  if (ext === 'xlsx') {
    return { text: await parseXlsxToCsv(buffer), hasEmbeddedImages };
  }
  if (ext === 'docx') {
    return { text: parseDocxToText(entries), hasEmbeddedImages };
  }
  return { text: parsePptxToText(entries), hasEmbeddedImages };
}

interface ZipListing {
  /** 需要进一步解析的 XML 成员（path → 解码后文本） */
  entries: Record<string, string>;
  hasEmbeddedImages: boolean;
}

/**
 * 列出 zip 成员并检测内嵌媒体：
 * - 全成员只做目录级检查（filter 返回 false 不解压，开销与文件数线性），
 *   仅 docx 的 document.xml 与 pptx 的 slideN.xml 被解压并解码；
 * - 加密 / 非 zip 内容（改扩展名的假 Office 文件）在 unzip 层抛错，统一转可读错误。
 */
function listZipEntries(bytes: Uint8Array): ZipListing {
  const entries: Record<string, string> = {};
  let hasEmbeddedImages = false;

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: file => {
        const name = file.name;
        if (
          name.startsWith('word/media/') ||
          name.startsWith('ppt/media/') ||
          name.startsWith('xl/media/')
        ) {
          hasEmbeddedImages = true;
          return false;
        }
        return name === 'word/document.xml' || /^ppt\/slides\/slide\d+\.xml$/.test(name);
      },
    });
  } catch (error) {
    throw new AttachmentParseError(
      t('sidepanel.attachments.zipInvalid', { reason: error instanceof Error ? error.message : String(error) }),
    );
  }

  for (const [name, data] of Object.entries(files)) {
    try {
      entries[name] = strFromU8(data);
    } catch (error) {
      throw new AttachmentParseError(
        t('sidepanel.attachments.zipInvalid', { reason: error instanceof Error ? error.message : String(error) }),
      );
    }
  }
  return { entries, hasEmbeddedImages };
}

// ---------- xlsx → CSV（ExcelJS） ----------

/** ExcelJS 命名空间的最小结构声明（UMD 动态导入产物） */
interface ExcelJsNamespace {
  Workbook: new () => {
    xlsx: { load: (data: ArrayBuffer) => Promise<unknown> };
    worksheets: Array<{
      name: string;
      columnCount: number;
      eachRow: (options: { includeEmpty: boolean }, onRow: (row: { getCell: (col: number) => { value: unknown } }) => void) => void;
    }>;
  };
}

/** ExcelJS 动态导入缓存（UMD 命名空间解析与 xlsx-builder 同源，避免双份加载） */
let excelJsModulePromise: Promise<ExcelJsNamespace> | null = null;

function loadExcelJS(): Promise<ExcelJsNamespace> {
  if (!excelJsModulePromise) {
    excelJsModulePromise = import('exceljs/dist/exceljs.min.js').then(
      mod => {
        const namespace = (mod as { default?: unknown }).default ?? mod;
        const resolved = namespace as { Workbook?: unknown } | null | undefined;
        if (!resolved || typeof resolved.Workbook !== 'function') {
          throw new AttachmentParseError(t('sidepanel.attachments.excelEngineMissing'));
        }
        return resolved as ExcelJsNamespace;
      },
      error => {
        excelJsModulePromise = null; // 允许下次重试（模块加载失败可能是瞬时故障）
        throw new AttachmentParseError(
          t('sidepanel.attachments.excelLoadFailed', { reason: error instanceof Error ? error.message : String(error) }),
        );
      },
    );
  }
  return excelJsModulePromise;
}

/** 单元格值 → 纯文本（富文本拼接 / 公式取计算结果 / 超链接取显示文本 / 日期本地化） */
function cellValueToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return (v.richText as Array<{ text?: string }>).map(rt => rt.text ?? '').join('');
    }
    if (typeof v.formula === 'string' || typeof v.sharedFormula === 'string') {
      // 公式优先取缓存计算结果（模型要的是值，不是表达式）
      if (v.result !== undefined && v.result !== null) return cellValueToText(v.result);
      return `=${String(v.formula ?? v.sharedFormula)}`;
    }
    if (typeof v.hyperlink === 'string') {
      return typeof v.text === 'string' && v.text ? v.text : v.hyperlink;
    }
    if (typeof v.error === 'string') return `#${v.error}`;
    if (typeof v.text === 'string') return v.text;
    return '';
  }
  return String(value);
}

/** CSV 字段转义：含逗号/引号/换行时整体加引号，内部引号翻倍 */
function csvEscape(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/**
 * xlsx → CSV：多工作表分节（`# 工作表: 名` 头 + 空行分隔），
 * 每行按全表最大列数对齐输出（复杂表结构 / 稀疏行安全），行尾空列裁剪。
 */
async function parseXlsxToCsv(buffer: ArrayBuffer): Promise<string> {
  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (error) {
    throw new AttachmentParseError(
      t('sidepanel.attachments.officeParseFailed', { reason: error instanceof Error ? error.message : String(error) }),
    );
  }

  const sections: string[] = [];
  for (const sheet of workbook.worksheets) {
    const lines: string[] = [`# ${t('sidepanel.attachments.sheetHeader', { name: sheet.name })}`];
    const columnCount = sheet.columnCount;
    sheet.eachRow({ includeEmpty: false }, row => {
      const fields: string[] = [];
      for (let col = 1; col <= columnCount; col++) {
        fields.push(cellValueToText(row.getCell(col).value));
      }
      while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
      lines.push(fields.map(csvEscape).join(','));
    });
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

// ---------- docx → 文本（fflate + DOM 遍历） ----------

/** XML 文本 → Document（DOMParser 失败/产物含 parsererror/无根元素时抛可读错误） */
function parseXmlDocument(xml: string, what: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // Chrome 对非法 XML 的产物：根为 <parsererror> 或含其作为后代；空文档则无根元素。
  // documentElement 为 null 时后续 TreeWalker 构造会抛 TypeError，必须在此拦截。
  if (doc.documentElement === null || doc.getElementsByTagName('parsererror').length > 0) {
    throw new AttachmentParseError(t('sidepanel.attachments.xmlInvalid', { what }));
  }
  return doc;
}

/** XPath：按 localName 取满足前缀条件的成员名（无则空数组） */
function xmlChildrenByLocalName(element: Element, localName: string): Element[] {
  const result: Element[] = [];
  for (const child of Array.from(element.children)) {
    if (child.localName === localName) result.push(child);
  }
  return result;
}

/** 元素内所有指定 localName 的后代（文档顺序） */
function xmlDescendantsByLocalName(root: Element, localName: string): Element[] {
  const result: Element[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode() as Element | null;
  while (node) {
    if (node.localName === localName) result.push(node);
    node = walker.nextNode() as Element | null;
  }
  return result;
}

/** docx 段落（w:p）→ 行文本：w:t 拼接、w:tab → 制表符、w:br/w:cr → 换行 */
function docxParagraphText(paragraph: Element): string {
  let out = '';
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_ELEMENT);
  let node: Element | null = walker.currentNode as Element;
  while (node) {
    const local = node.localName;
    if (local === 't') out += node.textContent ?? '';
    else if (local === 'tab') out += '\t';
    else if (local === 'br' || local === 'cr') out += '\n';
    node = walker.nextNode() as Element | null;
  }
  return out;
}

/** docx 表格（w:tbl）→ 行文本数组：单元格以 | 分隔（只取直接子行/单元格，嵌套表格文本并入所在单元格的段落） */
function docxTableLines(table: Element): string[] {
  const lines: string[] = [];
  // localName 不含命名空间前缀：w:tr → 'tr'、w:tc → 'tc'
  for (const row of xmlChildrenByLocalName(table, 'tr')) {
    const cells = xmlChildrenByLocalName(row, 'tc');
    if (cells.length === 0) continue;
    const cellTexts = cells.map(cell =>
      xmlDescendantsByLocalName(cell, 'p')
        .map(docxParagraphText)
        .filter(text => text.trim() !== '')
        .join(' '),
    );
    lines.push(cellTexts.join(' | '));
  }
  return lines;
}

/** docx 主文档 → 结构化纯文本（段落保序、表格转 | 分隔行、连续空行折叠） */
function parseDocxToText(entries: Record<string, string>): string {
  const xml = entries['word/document.xml'];
  if (!xml) {
    throw new AttachmentParseError(t('sidepanel.attachments.xmlInvalid', { what: 'word/document.xml' }));
  }
  const doc = parseXmlDocument(xml, 'word/document.xml');
  const body = doc.documentElement && xmlDescendantsByLocalName(doc.documentElement, 'body')[0];
  if (!body) {
    throw new AttachmentParseError(t('sidepanel.attachments.xmlInvalid', { what: 'document body' }));
  }

  const lines: string[] = [];
  const walk = (parent: Element) => {
    for (const child of Array.from(parent.children)) {
      const local = child.localName;
      if (local === 'p') {
        lines.push(docxParagraphText(child));
      } else if (local === 'tbl') {
        lines.push('', ...docxTableLines(child), '');
      } else {
        walk(child); // sectPr 等容器下钻（防御非典型结构）
      }
    }
  };
  walk(body);

  // 连续空行折叠为一行，去首尾空白
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line.trim() === '' && collapsed.length > 0 && collapsed[collapsed.length - 1] === '') continue;
    collapsed.push(line.trimEnd());
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === '') collapsed.pop();
  return collapsed.join('\n');
}

// ---------- pptx → 文本 ----------

/** slideN.xml 的 N（用于幻灯片顺序排序，防御非数字命名的非常规包） */
function slideNumberOf(name: string): number {
  const match = /slide(\d+)\.xml$/.exec(name);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

/** pptx → 纯文本：按幻灯片顺序，每形状每段落一行（跳过空行） */
function parsePptxToText(entries: Record<string, string>): string {
  const slideNames = Object.keys(entries)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumberOf(a) - slideNumberOf(b));

  if (slideNames.length === 0) {
    throw new AttachmentParseError(t('sidepanel.attachments.xmlInvalid', { what: 'ppt/slides/slideN.xml' }));
  }

  const lines: string[] = [];
  for (const name of slideNames) {
    const doc = parseXmlDocument(entries[name], name);
    lines.push(`# ${t('sidepanel.attachments.slideHeader', { index: slideNumberOf(name) })}`);
    // localName 不含前缀：p:sp → 'sp'（形状）、a:p → 'p'（段落）、a:t → 't'（文本）
    for (const shape of xmlDescendantsByLocalName(doc.documentElement, 'sp')) {
      const paragraphs = xmlDescendantsByLocalName(shape, 'p');
      const targets = paragraphs.length > 0 ? paragraphs : [shape];
      for (const paragraph of targets) {
        const text = xmlDescendantsByLocalName(paragraph, 't')
          .map(node => node.textContent ?? '')
          .join('');
        if (text.trim() !== '') lines.push(text);
      }
    }
  }
  return lines.join('\n');
}

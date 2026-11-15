import { executeScriptBounded } from '../common/frame-read';
/**
 * 结构化数据提取工具（browser_extract_data）
 *
 * 面向 RPA 场景的页面结构化数据抓取：直接在隔离世界（ISOLATED）遍历 DOM，
 * 不依赖 eval/new Function，因此**天然免疫页面 CSP 限制**，在任何网站上都可用。
 *
 * 三种提取模式：
 * 1. table —— 抓取表格：表头 + 数据行，输出对象数组（表头缺失时按列序号命名）；
 * 2. list  —— 抓取重复列表项（商品卡片、评论、文章条目…），按字段映射
 *             { 字段名: {selector, attr} } 提取每个条目的文本/属性值；
 * 3. selector —— 通用选择器提取：直接取匹配元素的文本或指定属性。
 *
 * 落盘通道（本工具是「批量数据不进上下文」的入口之一）：
 * - 默认 save="auto"：行数 ≤ INLINE_ROW_LIMIT 直接内联返回（便于模型核对字段），
 *   超过即自动落为 results/ 下的独立数据文件并只回传预览与统计；
 * - saveTo 显式指定 outputs/ 下的交付文件（.json/.csv/.md），供用户下载；
 * - 落盘结果可被 xlsx_tool(sheets[].dataFiles) / data_ref_tool(files) 直接消费。
 *
 * 与 extract_data（AI 视觉提取）互补：本工具走 DOM 精确路径（结果稳定、
 * 置信度 1.0），视觉提取留给 DOM 结构不明确的页面。
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES, isRestrictedUrl } from '@/common/constants';
import {
  saveWorkspaceResultText,
  workspaceMimeForFormat,
  type WorkspaceResultFormat,
} from '@/utils/python-workspace/data-files';
import { assertPluginOrigin, pluginOriginOf } from '../common/plugin-origin';
import { saveWorkspaceOutput } from '@/utils/python-workspace/store';
import { isWorkspaceOutput } from '@/utils/python-workspace/paths';
import { serializeCsv } from '@/utils/python-workspace/tabular';
import {
  classifyInjectionError,
  noResultFailure,
  type InjectionFailure,
} from '../common/script-injection';

/** 单次提取的最大行数（防御超大页面撑爆消息通道） */
const MAX_ROWS = 500;
/** 列表模式默认最大条目数 */
const DEFAULT_LIST_LIMIT = 100;
/** auto 模式的落盘阈值：超过此行数不再内联返回全部数据 */
const INLINE_ROW_LIMIT = 20;
/** 落盘后回传的预览行数（默认/上限） */
const DEFAULT_PREVIEW_ROWS = 5;
const MAX_PREVIEW_ROWS = 20;
/** 支持的文件格式（result 通道仅 json/csv；md 仅用于 outputs 交付） */
const FILE_FORMATS: readonly WorkspaceResultFormat[] = ['json', 'csv', 'md'];

/** 字段提取映射项 */
interface FieldSpec {
  /** 子元素选择器（可省略：省略则作用于条目元素本身） */
  selector?: string;
  /** 取值来源：text=文本内容（默认）；其余视为属性名（如 href、src、value） */
  attr?: string;
}

interface ExtractParams {
  /** 提取模式：table=表格 / list=重复列表项 / selector=通用选择器 */
  mode?: 'table' | 'list' | 'selector';
  /** CSS 选择器：table 模式可省略（自动定位页面第一个表格）；list/selector 模式必填 */
  selector?: string;
  /** list 模式的字段映射：{ 字段名: { selector?, attr? } } */
  fields?: Record<string, FieldSpec>;
  /** selector 模式取值属性（省略取 textContent） */
  attr?: string;
  /** 最大提取行数/条目数（默认 100，上限 500） */
  limit?: number;
  /** 是否包含隐藏元素（默认 false，跳过不可见元素） */
  includeHidden?: boolean;
  /** 落盘策略：auto=超过 20 行自动落盘（默认）/ always=总是落盘 / never=只内联 */
  save?: 'auto' | 'always' | 'never';
  /** 显式交付路径（outputs/ 下，扩展名决定格式）；提供即视为总是落盘 */
  saveTo?: string;
  /** 落盘格式；saveTo 有扩展名时以扩展名为准（冲突即报错，不做静默改写） */
  format?: 'json' | 'csv' | 'md';
  /** 落盘后回传的预览行数（默认 5，上限 20） */
  previewRows?: number;
  /** 结果文件标签（进入文件名，便于按批次辨认） */
  label?: string;
  /** 目标标签页 ID（默认当前激活标签页） */
  tabId?: number;
}

/** 提取结果的统一表格形态（三种模式在此归一，序列化只面向这一形态） */
interface ExtractTable {
  headers: string[];
  /** 行数据（与 headers 顺序对齐，缺失单元格为空串） */
  rows: string[][];
}

/**
 * 页面内提取函数（必须完全自包含：会被序列化注入隔离世界执行）
 * 返回可结构化克隆的提取结果。matched = 命中元素总数（limit 截断前），
 * 供调用方判断「页面还有多少没取」，而不是只能看到截断后的行数。
 */
function extractStructuredDataInPage(
  mode: string,
  selector: string | null,
  fieldsJson: string | null,
  attr: string | null,
  limit: number,
  includeHidden: boolean,
): {
  ok: boolean;
  rows?: unknown[];
  headers?: string[];
  count?: number;
  matched?: number;
  truncated?: boolean;
  /** 合并单元格数量（rowspan/colspan）：逐格取值会错位，调用方据此提示降级方案 */
  mergedCells?: number;
  /** 表尾行数（tfoot）：合计/备注行，已从数据行排除 */
  footerRows?: number;
  error?: string;
} {
  /** 判断元素是否可见（无布局或 display:none 视为隐藏） */
  const isVisible = (el: Element): boolean => {
    if (includeHidden) return true;
    if (!el.getClientRects().length) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  /** 链接类属性统一解析为绝对地址：//host/x、/video/x 都能直接被后续导航使用 */
  const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'poster']);
  const absoluteUrl = (raw: string): string => {
    if (!raw) return raw;
    try {
      return new URL(raw, document.baseURI).href;
    } catch {
      return raw;
    }
  };
  /** 提取单个元素的文本或属性值（attr 为 null 表示取文本） */
  const readValue = (el: Element | null | undefined, valueAttr?: string | null): string => {
    if (!el) return '';
    if (!valueAttr || valueAttr === 'text') return (el.textContent || '').trim();
    if (valueAttr === 'html') return (el as HTMLElement).innerHTML || '';
    const raw = el.getAttribute(valueAttr) ?? '';
    return URL_ATTRIBUTES.has(valueAttr.toLowerCase()) ? absoluteUrl(raw) : raw;
  };

  try {
    // —— table 模式 ——
    if (mode === 'table') {
      const picked = selector ? document.querySelector(selector) : document.querySelector('table');
      if (!picked) {
        return { ok: false, error: selector ? `未找到表格元素: ${selector}` : '页面中没有 table 元素' };
      }
      // 选中容器（如 .table-wrap）时向下取第一张真实表格；取不到就明确说明，
      // 而不是拿容器里的任意行硬凑
      const tableEl: HTMLTableElement | null =
        picked.tagName === 'TABLE' ? (picked as HTMLTableElement) : picked.querySelector('table');
      if (!tableEl) {
        return {
          ok: false,
          error: `选择器 ${selector} 命中的是 <${picked.tagName.toLowerCase()}>，其内部没有 <table>；table 模式请直接指向表格元素（或用 list 模式抓卡片列表）`,
        };
      }

      // tableEl.rows 只包含本表的行（不含嵌套表格），避免嵌套表格把数据复制一份
      const allRows = Array.from(tableEl.rows);
      if (allRows.length === 0) {
        return { ok: false, error: '表格没有数据行（rows 为空）' };
      }

      // 表头行：thead 内的行；无 thead 时，首行单元格全为 th 也按表头处理
      const headerRows: HTMLTableRowElement[] = [];
      for (const tr of allRows) {
        if (tr.parentElement?.tagName === 'THEAD') headerRows.push(tr);
      }
      if (headerRows.length === 0) {
        const cells = Array.from(allRows[0].cells);
        if (cells.length > 0 && cells.every((cell) => cell.tagName === 'TH')) {
          headerRows.push(allRows[0]);
        }
      }

      // 表头去重：同名表头（如两个「价格」）若直接作 key 会互相覆盖导致静默丢列
      const usedHeaders = new Map<string, number>();
      const uniqueHeader = (raw: string, fallbackIndex: number): string => {
        const base = raw.trim() || `列${fallbackIndex}`;
        const seen = usedHeaders.get(base) ?? 0;
        usedHeaders.set(base, seen + 1);
        return seen === 0 ? base : `${base}(${seen + 1})`;
      };

      // 多行表头（分组表头）取最后一行作列名：那是叶子列，且避免同一列名被
      // 反复登记成「名字(2)」这类无意义后缀
      const headers: string[] = [];
      const leafHeaderRow = headerRows[headerRows.length - 1];
      if (leafHeaderRow) {
        Array.from(leafHeaderRow.cells).forEach((cell, index) => {
          headers[index] = uniqueHeader((cell.textContent || '').trim(), index + 1);
        });
      }

      // 单元格只取本行直属格（tr.cells），不把嵌套表格的文本混进来；
      // tfoot（合计/备注行）不是数据行，单独计数后由调用方告知已排除
      const footerRows = allRows.filter((tr) => tr.parentElement?.tagName === 'TFOOT');
      const extractableBody = allRows.filter(
        (tr) =>
          !headerRows.includes(tr) &&
          tr.parentElement?.tagName !== 'TFOOT' &&
          tr.cells.length > 0 &&
          isVisible(tr),
      );
      const rows: Record<string, string>[] = [];
      let truncated = false;
      for (const tr of extractableBody) {
        if (rows.length >= limit) {
          truncated = true;
          break;
        }
        const row: Record<string, string> = {};
        Array.from(tr.cells).forEach((cell, i) => {
          // 数据行比表头宽时补列名，保证多出来的单元格不被丢弃
          if (i >= headers.length) headers[i] = uniqueHeader(`列${i + 1}`, i + 1);
          row[headers[i]] = readValue(cell);
        });
        rows.push(row);
      }

      // 合并单元格检测：不在此实现网格展开（会把「按行取值」变成另一套语义），
      // 而是把风险上抛给调用方，避免错位数据被当成正确结果继续流转
      // 只看数据行：表头里的 colspan（分组表头）不会让数据行错位，不应误报
      let mergedCells = 0;
      for (const tr of allRows) {
        if (headerRows.includes(tr) || tr.parentElement?.tagName === 'TFOOT') continue;
        for (const cell of Array.from(tr.cells)) {
          if (cell.rowSpan > 1 || cell.colSpan > 1) mergedCells++;
        }
      }

      return {
        ok: true,
        headers,
        rows,
        count: rows.length,
        matched: extractableBody.length,
        truncated,
        mergedCells,
        footerRows: footerRows.length,
      };
    }

    // —— list 模式 ——
    if (mode === 'list') {
      if (!selector) {
        return { ok: false, error: 'list 模式必须提供 selector（重复条目的选择器）' };
      }
      let fieldMap: Record<string, FieldSpec> = {};
      if (fieldsJson) {
        try {
          fieldMap = JSON.parse(fieldsJson);
        } catch {
          return { ok: false, error: `fields 不是合法 JSON: ${fieldsJson.slice(0, 200)}` };
        }
      }
      const fieldEntries = Object.entries(fieldMap);
      if (fieldEntries.length === 0) {
        return { ok: false, error: 'list 模式必须提供 fields 字段映射，如 {"title":{"selector":"h2"},"link":{"selector":"a","attr":"href"}}' };
      }

      const items = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      const rows: Record<string, string>[] = [];
      let truncated = false;
      for (const item of items) {
        if (rows.length >= limit) {
          truncated = true;
          break;
        }
        const row: Record<string, string> = {};
        for (const [fieldName, spec] of fieldEntries) {
          const target = spec?.selector ? item.querySelector(spec.selector) : item;
          row[fieldName] = readValue(target, spec?.attr);
        }
        rows.push(row);
      }

      return { ok: true, rows, count: rows.length, matched: items.length, truncated };
    }

    // —— selector 模式 ——
    if (mode === 'selector') {
      if (!selector) {
        return { ok: false, error: 'selector 模式必须提供 selector' };
      }
      const elements = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      const rows: string[] = [];
      let truncated = false;
      for (const el of elements) {
        if (rows.length >= limit) {
          truncated = true;
          break;
        }
        rows.push(readValue(el, attr));
      }
      return { ok: true, rows, count: rows.length, matched: elements.length, truncated };
    }

    return { ok: false, error: `不支持的模式: ${mode}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 注入函数返回的载荷类型（单一来源：直接取函数返回值） */
type ExtractPayload = ReturnType<typeof extractStructuredDataInPage>;

/** Markdown 单元格转义：竖线与换行会破坏表格结构 */
function escapeMarkdownCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/**
 * 矩阵行 → 对象行。JSON 文件、落盘预览、内联 rows 共用同一映射，
 * 保证「同一次提取的三种输出形态字段完全一致」。
 */
function recordsOf(
  headers: string[],
  rows: string[][],
): Record<string, string>[] {
  return rows.map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = row[index] ?? '';
    });
    return record;
  });
}

/**
 * 表格 → 指定格式文本。
 * - json：对象数组（与 js_run 结果文件同形态，xlsx/data_ref 可直接消费）；
 * - csv：RFC 4180（tabular.ts 单一真相源）；
 * - md：GitHub 风格表格（仅交付用）。
 */
function serializeTable(table: ExtractTable, format: WorkspaceResultFormat): string {
  if (format === 'csv') return serializeCsv(table.headers, table.rows);
  if (format === 'md') {
    if (!table.headers.length) return '';
    const header = `| ${table.headers.map(escapeMarkdownCell).join(' | ')} |`;
    const divider = `| ${table.headers.map(() => '---').join(' | ')} |`;
    const body = table.rows.map(
      (row) => `| ${table.headers.map((_, i) => escapeMarkdownCell(row[i] ?? '')).join(' | ')} |`,
    );
    return [header, divider, ...body].join('\n') + '\n';
  }
  return JSON.stringify(recordsOf(table.headers, table.rows), null, 2);
}

/**
 * 结构化数据提取工具
 */
export class PageExtractDataTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.PAGE_EXTRACT_DATA;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.PAGE_EXTRACT_DATA,
    description:
      '从当前页面 DOM 精确提取结构化数据（表格/列表/选择器），免疫页面 CSP 限制；批量结果自动落为工作区数据文件',
    category: 'browser',
    version: '2.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'rpa', 'extract', 'scrape', 'data', 'chrome'],
    displayName: '结构化数据提取',
    permissions: ['scripting'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.PAGE_EXTRACT_DATA,
      description:
        '从当前页面 DOM 精确提取结构化数据（RPA 抓取首选，不受页面 CSP 限制）。' +
        '三种模式：table=抓取表格（表头+行）；list=抓取重复列表项（商品/评论/文章卡片，按字段映射取文本或属性）；selector=通用选择器直接取值。' +
        '落盘策略 save：auto（默认，超过 20 行自动保存为 results/ 数据文件，只回传预览与统计，批量数据不进上下文）/ always / never。' +
        'results/ 文件可被 xlsx_tool(sheets[].dataFiles) 与 data_ref_tool(files) 直接消费；需要给用户的交付文件时用 saveTo="outputs/xxx.csv|json|md"。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['table', 'list', 'selector'],
            description:
              '提取模式。table=表格（表头+行，自动处理 thead/多行表头）；list=重复列表条目（按 fields 映射）；selector=通用选择器取值（行形态为 {text: 值}，指定 attr 后为 {属性名: 值}）。默认 table',
            default: 'table',
          },
          selector: {
            type: 'string',
            description: 'CSS 选择器。table 模式可省略（自动取页面第一个表格）；list 模式为重复条目的选择器（如 ".comment-item"）；selector 模式为目标元素选择器',
          },
          fields: {
            type: 'object',
            description:
              'list 模式的字段映射：{字段名: {selector?, attr?}}。selector 为条目内子元素选择器（省略则取条目本身）；' +
              'attr 省略取文本，否则取该属性（如 href、src）。示例：{"title":{"selector":"h2"},"link":{"selector":"a","attr":"href"}}',
            additionalProperties: true,
          },
          attr: {
            type: 'string',
            description: 'selector 模式取值属性名（省略取 textContent；可用 href、src、value 等）',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_ROWS,
            description: `最大提取行数/条目数（默认 ${DEFAULT_LIST_LIMIT}，上限 ${MAX_ROWS}）。页面条目多于 limit 时响应会给出 matched 与截断提示`,
            default: DEFAULT_LIST_LIMIT,
          },
          includeHidden: {
            type: 'boolean',
            description: '是否包含隐藏元素（默认 false，跳过不可见元素）',
            default: false,
          },
          save: {
            type: 'string',
            enum: ['auto', 'always', 'never'],
            description:
              '落盘策略：auto=超过 20 行自动保存为 results/ 数据文件（默认，推荐）；always=总是保存；never=只内联返回全部行（数据量大时慎用，会占用上下文）',
            default: 'auto',
          },
          saveTo: {
            type: 'string',
            description:
              '交付文件路径（必须位于 outputs/ 下，扩展名 .json/.csv/.md 决定格式），如 "outputs/商品列表.csv"。提供后总是落盘并返回文件标记；数据管道场景不要用它，用默认 results/ 通道',
          },
          format: {
            type: 'string',
            enum: ['json', 'csv', 'md'],
            description:
              '落盘格式（默认 json）。saveTo 带扩展名时以扩展名为准，两者冲突会报错；md 只能配 saveTo 交付到 outputs/',
          },
          previewRows: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_PREVIEW_ROWS,
            description: `落盘后回传的预览行数（默认 ${DEFAULT_PREVIEW_ROWS}，上限 ${MAX_PREVIEW_ROWS}）；仅供核对字段，完整数据在文件里`,
            default: DEFAULT_PREVIEW_ROWS,
          },
          label: {
            type: 'string',
            description: '结果文件标签（进入 results/ 文件名，如 "第3页"），便于后续按批次辨认',
          },
          tabId: {
            type: 'number',
            description: '目标标签页 ID（可选，默认当前激活标签页）',
          },
        },
        required: [],
      },
    },
  };

  async execute(args: ExtractParams, context?: ToolExecutionContext): Promise<ToolResult> {
    this.ensureBackgroundContext();

    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return this.createErrorResponse('INVALID_ARGUMENT：参数必须是 JSON 对象');
    }

    const {
      mode = 'table',
      selector,
      fields,
      attr,
      limit = DEFAULT_LIST_LIMIT,
      includeHidden = false,
      save = 'auto',
      saveTo,
      format,
      previewRows = DEFAULT_PREVIEW_ROWS,
      label,
      tabId: requestedTabId,
    } = args;

    // ── 入参形态守卫（先于任何浏览器访问，参数错误不触碰页面） ──
    if (!['table', 'list', 'selector'].includes(mode)) {
      return this.createErrorResponse(
        `INVALID_ARGUMENT：mode 必须是 table/list/selector，实际收到 ${JSON.stringify(mode)}`,
      );
    }
    if (!['auto', 'always', 'never'].includes(save)) {
      return this.createErrorResponse(
        `INVALID_ARGUMENT：save 必须是 auto/always/never，实际收到 ${JSON.stringify(save)}`,
      );
    }
    if (selector !== undefined && typeof selector !== 'string') {
      return this.createErrorResponse('INVALID_ARGUMENT：selector 必须是字符串');
    }
    if (attr !== undefined && typeof attr !== 'string') {
      return this.createErrorResponse('INVALID_ARGUMENT：attr 必须是字符串');
    }
    if (selector !== undefined && !selector.trim()) {
      return this.createErrorResponse(
        'INVALID_ARGUMENT：selector 不能是空串（table 模式可省略 selector 走自动定位；list/selector 模式必须给出有效 CSS 选择器）',
      );
    }
    if (mode !== 'table' && !selector?.trim()) {
      return this.createErrorResponse(
        `INVALID_ARGUMENT：mode=${mode} 必须提供 selector（${mode === 'list' ? '重复条目的选择器，如 ".comment-item"' : '目标元素选择器'}）；table 模式才可省略`,
      );
    }
    if (format !== undefined && !(FILE_FORMATS as readonly string[]).includes(format)) {
      return this.createErrorResponse(
        `INVALID_ARGUMENT：format 必须是 ${FILE_FORMATS.join('/')}，实际收到 ${JSON.stringify(format)}`,
      );
    }
    // 模式专属参数的误用必须显式拒绝：静默忽略会让模型以为配置已生效
    if (fields !== undefined && mode !== 'list') {
      return this.createErrorResponse(
        `INVALID_ARGUMENT：fields 只用于 list 模式（当前 mode=${mode}）。表格字段由表头决定；单元素取值请用 mode="selector" + attr`,
      );
    }
    if (attr !== undefined && mode !== 'selector') {
      return this.createErrorResponse(
        `INVALID_ARGUMENT：attr 只用于 selector 模式（当前 mode=${mode}）。list 模式请把 attr 写在 fields.字段名.attr 中`,
      );
    }
    const fieldsError = this.validateFields(fields);
    if (fieldsError) return this.createErrorResponse(fieldsError);
    if (mode === 'list' && (!fields || Object.keys(fields).length === 0)) {
      return this.createErrorResponse(
        'INVALID_ARGUMENT：list 模式必须提供非空 fields 字段映射，如 {"title":{"selector":"h2"},"price":{"selector":".price"}}；只给 selector 无法确定要抓哪些列',
      );
    }
    if (saveTo !== undefined && typeof saveTo !== 'string') {
      return this.createErrorResponse('INVALID_ARGUMENT：saveTo 必须是字符串路径');
    }
    if (includeHidden !== undefined && typeof includeHidden !== 'boolean') {
      return this.createErrorResponse('INVALID_ARGUMENT：includeHidden 必须是布尔值');
    }
    if (
      requestedTabId !== undefined &&
      requestedTabId !== null &&
      (!Number.isSafeInteger(requestedTabId) || requestedTabId < 0)
    ) {
      return this.createErrorResponse(
        `INVALID_ARGUMENT：tabId 必须是非负整数（标签页 ID），实际收到 ${JSON.stringify(requestedTabId)}`,
      );
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS) {
      return this.createErrorResponse(
        `INVALID_ARGUMENT：limit 必须是 1-${MAX_ROWS} 的整数，实际收到 ${JSON.stringify(limit)}`,
      );
    }
    if (!Number.isSafeInteger(previewRows) || previewRows < 1 || previewRows > MAX_PREVIEW_ROWS) {
      return this.createErrorResponse(
        `INVALID_ARGUMENT：previewRows 必须是 1-${MAX_PREVIEW_ROWS} 的整数，实际收到 ${JSON.stringify(previewRows)}`,
      );
    }

    const rowLimit = Math.min(Math.max(limit ?? DEFAULT_LIST_LIMIT, 1), MAX_ROWS);
    const previewLimit = Math.min(
      Math.max(previewRows ?? DEFAULT_PREVIEW_ROWS, 1),
      MAX_PREVIEW_ROWS,
    );

    // ── 落盘目标与格式仲裁（冲突显式报错，绝不静默改写用户意图） ──
    const explicitSaveTo =
      typeof saveTo === 'string' && saveTo.trim() ? saveTo.trim() : undefined;
    let resolvedFormat: WorkspaceResultFormat = (format as WorkspaceResultFormat) ?? 'json';
    if (explicitSaveTo) {
      if (save === 'never') {
        return this.createErrorResponse(
          'INVALID_ARGUMENT：save="never" 与 saveTo 冲突——saveTo 即「总是保存为交付文件」。要交付就删除 save="never"，只要内联就删除 saveTo',
        );
      }
      if (typeof saveTo !== 'string' || !isWorkspaceOutput(explicitSaveTo)) {
        return this.createErrorResponse(
          `INVALID_ARGUMENT：saveTo 必须是 outputs/ 下的工作区相对路径（禁止 ..、盘符、反斜杠与首尾空白），实际收到 ${JSON.stringify(saveTo)}。` +
            '需要进入数据管道的结果不要指定 saveTo——默认的 results/ 通道会自动落盘并被 xlsx_tool/data_ref_tool 消费。',
        );
      }
      const extension = /\.([A-Za-z0-9]+)$/.exec(explicitSaveTo)?.[1]?.toLowerCase();
      if (!extension || !(FILE_FORMATS as readonly string[]).includes(extension)) {
        return this.createErrorResponse(
          `INVALID_ARGUMENT：saveTo 必须以 ${FILE_FORMATS.map((f) => '.' + f).join('/')} 结尾，实际收到 ${JSON.stringify(explicitSaveTo)}`,
        );
      }
      if (format !== undefined && format !== extension) {
        return this.createErrorResponse(
          `INVALID_ARGUMENT：format=${format} 与 saveTo 扩展名 .${extension} 冲突——删除 format 让扩展名决定格式，或改成一致的组合`,
        );
      }
      resolvedFormat = extension as WorkspaceResultFormat;
    } else if (resolvedFormat === 'md') {
      return this.createErrorResponse(
        'INVALID_ARGUMENT：md 只能作为交付物通过 saveTo="outputs/xxx.md" 写出；数据通道（results/）只接受 json/csv——需要表格交付请用 saveTo，需要数据管道请用 json 或 csv',
      );
    }

    // tabId 允许为 0：真值判断会把合法的 0 当作「未提供」而错选活动标签页
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab =
        requestedTabId !== undefined && requestedTabId !== null
          ? await chrome.tabs.get(requestedTabId)
          : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    } catch (error) {
      // 标签页已关闭/ID 失效：归类为 TAB_GONE，给出「重新选标签页」的下一步，
      // 而不是让原始 Chrome 文案落进 UNEXPECTED_ERROR
      return this.injectionFailure(
        classifyInjectionError(error, {
          operation: 'browser_extract_data',
          tabId: requestedTabId ?? undefined,
        }),
      );
    }
    if (!tab || typeof tab.id !== 'number') {
      return this.createErrorResponse(
        'TAB_NOT_FOUND：未找到目标标签页。显式传 tabId 时确认该标签页仍存在；省略 tabId 时当前窗口没有活动标签页，请先打开目标网页。',
      );
    }
    const tabId = tab.id;

    // 插件调用只允许读取 manifest network 声明内的页面
    if (context?.pluginKey) {
      try {
        assertPluginOrigin(pluginOriginOf(tab.url), context);
      } catch (error) {
        return this.createErrorResponse(
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // 受限页面统一口径判定（chrome://、about:、file:// 等，见 common/constants）
    if (isRestrictedUrl(tab.url)) {
      return this.createErrorResponse(
        `INJECTION_RESTRICTED_PAGE：当前页面（${tab.url || '无 URL'}）属于浏览器受保护页面，不允许注入提取脚本。请先导航到普通 http/https 页面。`,
      );
    }

    try {
      if (requestedTabId != null) context?.onTabTarget?.(tabId);

      this.log(`Extracting data (mode=${mode}, selector=${selector || 'auto'}) from tab ${tabId}`);

      // 隔离世界注入：纯 DOM 操作、无 eval，天然不受页面 CSP 限制。
      // args 序列化契约：chrome.scripting 的原生绑定序列化器会拒绝 undefined
      // （"Value is unserializable"），可选参数一律以 null 兜底（可结构化克隆），
      // 注入函数内用 != null 判空区分「未提供」与「显式空值」。
      // 载荷类型直接取自注入函数返回值，避免两处结构声明漂移。
      let results: Array<{ result?: ExtractPayload }>;
      try {
        results = await executeScriptBounded({
          target: { tabId },
          func: extractStructuredDataInPage,
          args: [
            mode,
            selector ?? null,
            fields ? JSON.stringify(fields) : null,
            attr ?? null,
            rowLimit,
            includeHidden,
          ],
          world: 'ISOLATED',
        },
          8_000,
          context?.signal,
        );
      } catch (error) {
        // 注入失败（权限/页面受限/页签关闭/参数不可序列化）交给共享分类层，
        // 输出稳定错误码 + 下一步，而不是把 Chrome 原文直接抛给模型
        return this.injectionFailure(
          classifyInjectionError(error, { operation: 'browser_extract_data', tabId }),
        );
      }

      const payload = results?.[0]?.result;
      if (!payload) {
        return this.injectionFailure(noResultFailure({ operation: 'browser_extract_data' }));
      }
      if (!payload.ok) {
        // 页面内提取函数抛出/主动报错：多为选择器与当前 DOM 不匹配，
        // 直接给出原始原因（其中已含可执行的修复方向）
        return this.createErrorResponse(
          `EXTRACTION_FAILED：${payload.error ?? '注入函数未返回原因（可能是页面结构变化）'}`,
        );
      }

      const table = this.toTable(payload, mode, attr);
      const matched = payload.matched ?? payload.count ?? table.rows.length;
      const count = table.rows.length;

      // ── 数据质量自检：把「静默空列/零行」变成可行动的告警 ──
      const warnings: string[] = [];
      if (count === 0) {
        warnings.push(
          mode === 'table'
            ? '未提取到任何表格行：确认页面确有 <table>（或提供更精确的 selector 指向表格），内容可能尚未渲染——先等待/滚动后重试，或改用 list 模式配合 browser_dom_explore(similar) 定位重复条目'
            : mode === 'list'
              ? `list 选择器 ${JSON.stringify(selector)} 未匹配任何可见条目：用 browser_dom_explore(action="similar") 复核选择器，或加 includeHidden=true 包含当前不可见的条目`
              : `selector ${JSON.stringify(selector)} 未匹配任何可见元素：复核选择器，或加 includeHidden=true`,
        );
      }
      // 字段级空值统计：整列为空几乎必然是选择器失配，必须显式提示
      const fieldStats = table.headers.map((name, index) => ({
        name,
        filled: table.rows.filter((row) => (row[index] ?? '').trim() !== '').length,
      }));
      for (const field of fieldStats) {
        if (count === 0 || field.filled > 0) continue;
        const advice =
          mode === 'list'
            ? `请检查 fields.${field.name}.selector 或改用 attr 取值`
            : mode === 'table'
              ? '该列在页面数据行里全为空：确认表头/列位置是否错位，或改用 list 模式按条目抓取'
              : '命中的元素在该属性上为空：确认 attr 名是否写错（取文本请省略 attr）';
        warnings.push(`字段 ${JSON.stringify(field.name)} 在全部 ${count} 行中都为空——${advice}`);
      }
      if (matched > count) {
        warnings.push(
          `页面共匹配 ${matched} 条，本次仅提取前 ${count} 条（limit=${rowLimit}）。需要全量时提高 limit（≤${MAX_ROWS}）或分页采集`,
        );
      }
      if ((payload.mergedCells ?? 0) > 0) {
        warnings.push(
          `表格含 ${payload.mergedCells} 个合并单元格（rowspan/colspan）：本工具按行逐格取值，合并单元格会让后续行错位。需要保留合并结构时改用 read_website（结构化表格），或把每行当独立卡片用 list 模式抓取；导出前先核对首尾若干行`,
        );
      }
      if ((payload.footerRows ?? 0) > 0) {
        warnings.push(
          `已排除 ${payload.footerRows} 行表尾（tfoot，通常是合计/备注）：若这些行也是数据，请改用 list 模式逐行抓取，避免把汇总行混进数据`,
        );
      }
      // ── 落盘判定：auto 以实际行数为准（参数校验阶段无法预知行数） ──
      // 零行不落盘：空结果写成文件只会让下游把「没抓到」误当成「抓到了空表」，
      // 这里改为内联返回空数组 + 上面的零行告警，把判读权交给模型
      const doSave =
        count > 0 &&
        (explicitSaveTo !== undefined ||
          save === 'always' ||
          (save === 'auto' && count > INLINE_ROW_LIMIT));

      if (doSave && !context?.chatId) {
        if (explicitSaveTo !== undefined || save === 'always') {
          return this.createErrorResponse(
            'SAVE_UNAVAILABLE：当前会话无法访问工作区，无法落盘。改为 save="never" 内联返回，或移除 saveTo；不要在无法保存时声称文件已生成。',
          );
        }
        warnings.push(
          `共 ${count} 行超过 ${INLINE_ROW_LIMIT} 行且工作区不可用，已内联返回全部行（注意上下文占用）`,
        );
      }

      const text = serializeTable(table, resolvedFormat);
      let saved:
        | { path: string; bytes: number; format: WorkspaceResultFormat; marker?: string }
        | undefined;
      /** auto 模式下落盘失败：兜底只回传有限行，避免一次失败把整批数据灌进上下文 */
      let inlineFallback = false;
      if (doSave && context?.chatId) {
        try {
          if (explicitSaveTo) {
            const blob = new Blob([text], { type: workspaceMimeForFormat(resolvedFormat) });
            const artifact = await saveWorkspaceOutput(context.chatId, explicitSaveTo, blob, context.signal);
            saved = { path: artifact.path, bytes: blob.size, format: resolvedFormat, marker: artifact.marker };
          } else {
            const result = await saveWorkspaceResultText(
              context.chatId,
              'extract',
              typeof label === 'string' ? label : selector || mode,
              text,
              resolvedFormat,
              context.signal,
            );
            saved = { path: result.path, bytes: result.bytes, format: result.format };
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (explicitSaveTo !== undefined || save === 'always') {
            return this.createErrorResponse(`SAVE_FAILED：数据已提取但落盘失败：${reason}`);
          }
          inlineFallback = true;
          warnings.push(
            `落盘失败（${reason}）：已改为内联返回前 ${Math.min(count, INLINE_ROW_LIMIT)} 行（共 ${count} 行）。请检查工作区配额/单文件上限后分批重试（降低 limit、按页用 label 标记），不要把这批数据当作完整结果交付`,
          );
        }
      }

      // CSV 公式注入可见性：数据保真优先（不改写单元格），但文件真的写出去时
      // 必须把风险讲清楚，由调用方决定是否改用 xlsx 或按文本导入
      if (saved && resolvedFormat === 'csv') {
        let formulaLike = 0;
        for (const row of table.rows) {
          for (const cell of row) if (/^[=+\-@\t\r]/.test(cell)) formulaLike++;
        }
        if (formulaLike > 0) {
          warnings.push(
            `有 ${formulaLike} 个单元格以 =/+/-/@ 开头：CSV 按原文写出（未做任何转义改写），用 Excel 直接打开可能被当作公式执行。若来源不可信，请改用 xlsx_tool 导出（字符串单元格不会执行），或以纯文本方式导入 CSV`,
          );
        }
      }

      const response: Record<string, unknown> = {
        tabId,
        url: tab.url,
        mode,
        selector: selector ?? (mode === 'table' ? 'table (auto)' : undefined),
        matched,
        count,
        truncated: payload.truncated === true || matched > count,
        source: 'dom_extraction',
        fields: fieldStats,
        warnings: warnings.length ? warnings : undefined,
      };

      if (saved) {
        response.saved = {
          path: saved.path,
          bytes: saved.bytes,
          format: saved.format,
          rows: count,
          ...(saved.marker ? { marker: saved.marker } : {}),
        };
        // 落盘后只回传预览：行数据已在文件里，重复回传只会撑爆上下文
        response.preview = recordsOf(table.headers, table.rows.slice(0, previewLimit));
        response.previewRows = Math.min(previewLimit, count);
        response.next =
          explicitSaveTo
            ? `交付文件已保存：${saved.path}（在回复中单独一行插入返回的 marker）`
            : `完整数据在 ${saved.path}：用 xlsx_tool(sheets[].dataFiles=["${saved.path}"]) 导出 Excel，或用 data_ref_tool(files=["${saved.path}"]) 整形；核对片段用 js_run(action="read",path="${saved.path}",index=N)`;
      } else {
        // 内联与落盘统一为对象行形态（selector 模式即 {text|attr: value}），
        // 下游 xlsx_tool/data_ref_tool 对两种通道的消费方式完全一致
        const inlineRows = inlineFallback ? table.rows.slice(0, INLINE_ROW_LIMIT) : table.rows;
        response.rows = recordsOf(table.headers, inlineRows);
        if (inlineFallback) response.truncated = true;
      }

      const summary = saved
        ? `Extracted ${count}/${matched} row(s) via DOM (${mode} mode) → ${saved.path}`
        : `Extracted ${count}/${matched} row(s) via DOM (${mode} mode, inline)`;
      return this.createSuccessResponse(response, summary);
    } catch (error) {
      // 兜底：未预期异常也要可分析（保留原始信息，便于用户定位与反馈）
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error && error.stack ? error.stack.split('\n')[1]?.trim() : '';
      return this.createErrorResponse(
        `UNEXPECTED_ERROR：${message}${stack ? `（${stack}）` : ''}\n` +
          `上下文：mode=${mode}，selector=${JSON.stringify(selector ?? null)}，tabId=${String(requestedTabId ?? 'active')}`,
      );
    }
  }

  /** 注入失败 → 稳定错误码 + 可读原因 + 下一步（共享注入安全层的统一口径） */
  private injectionFailure(failure: InjectionFailure): ToolResult {
    return this.createErrorResponse(
      `INJECTION_${failure.code}（${failure.reason}）：${failure.message}\n` +
        `下一步：${failure.recovery}` +
        (failure.outcomeUncertain ? '\n注意：结果状态不确定，重试前先核对页面当前状态。' : ''),
    );
  }

  /** fields 形态校验：字符串/数组是最常见的误用（把值当成 spec 直接传） */
  private validateFields(fields: unknown): string | undefined {
    if (fields === undefined) return undefined;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return (
        'INVALID_ARGUMENT：fields 必须是对象映射 {字段名: {selector?, attr?}}，' +
        `实际收到 ${Array.isArray(fields) ? '数组' : typeof fields}。` +
        '示例：{"title":{"selector":"h2"},"link":{"selector":"a","attr":"href"}}'
      );
    }
    for (const [name, spec] of Object.entries(fields as Record<string, unknown>)) {
      if (!name.trim()) {
        return 'INVALID_ARGUMENT：fields 的字段名不能为空串——字段名会成为 CSV 表头与 JSON 键';
      }
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        return (
          `INVALID_ARGUMENT：fields.${name} 必须是对象 {selector?, attr?}，实际收到 ${JSON.stringify(spec)}。` +
          '只写字段名不够——需要指定取值位置，如 {"title":{"selector":"h2"}}（取条目本身文本则用 {}）'
        );
      }
      const value = spec as Record<string, unknown>;
      if (value.selector !== undefined && typeof value.selector !== 'string') {
        return `INVALID_ARGUMENT：fields.${name}.selector 必须是字符串`;
      }
      if (typeof value.selector === 'string' && !value.selector.trim()) {
        return `INVALID_ARGUMENT：fields.${name}.selector 不能是空串——取条目元素本身请省略 selector（改为 {"${name}":{}} 或 {"${name}":{"attr":"href"}}）`;
      }
      if (value.attr !== undefined && typeof value.attr !== 'string') {
        return `INVALID_ARGUMENT：fields.${name}.attr 必须是字符串（如 "href"；取文本请省略）`;
      }
      if (typeof value.attr === 'string' && !value.attr.trim()) {
        return `INVALID_ARGUMENT：fields.${name}.attr 不能是空串——取文本请省略 attr（默认取文本），取属性请填 href/src 等属性名`;
      }
    }
    return undefined;
  }

  /**
   * 三种模式的返回结构 → 统一表格形态。
   * list 模式的表头取字段映射的并集（按首次出现顺序），缺失字段留空；
   * selector 模式单列（列名 = attr 或 text）。
   */
  private toTable(
    payload: { rows?: unknown[]; headers?: string[] },
    mode: string,
    attr?: string,
  ): ExtractTable {
    const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
    if (mode === 'selector') {
      return {
        headers: [attr && attr !== 'text' ? attr : 'text'],
        rows: rawRows.map((row) => [typeof row === 'string' ? row : String(row ?? '')]),
      };
    }
    if (mode === 'table' && Array.isArray(payload.headers) && payload.headers.length) {
      const headers = payload.headers.map((header, index) => String(header || `列${index + 1}`));
      return {
        headers,
        rows: rawRows.map((row) => {
          const record = (row ?? {}) as Record<string, unknown>;
          return headers.map((header) => String(record[header] ?? ''));
        }),
      };
    }
    // list（以及无表头的 table）：按对象键首次出现顺序求并集
    const headers: string[] = [];
    const seen = new Set<string>();
    for (const row of rawRows) {
      if (!row || typeof row !== 'object') continue;
      for (const key of Object.keys(row as Record<string, unknown>)) {
        if (seen.has(key)) continue;
        seen.add(key);
        headers.push(key);
      }
    }
    return {
      headers,
      rows: rawRows.map((row) => {
        const record = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
        return headers.map((header) => String(record[header] ?? ''));
      }),
    };
  }
}

// 导出工具实例
export const pageExtractDataTool = new PageExtractDataTool();

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
 * 与 extract_data（AI 视觉提取）互补：本工具走 DOM 精确路径（零 token、
 * 结果稳定、置信度 1.0），视觉提取留给 DOM 结构不明确的页面。
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES, isRestrictedUrl } from '@/common/constants';

/** 单次提取的最大行数（防御超大页面撑爆消息通道） */
const MAX_ROWS = 500;
/** 列表模式默认最大条目数 */
const DEFAULT_LIST_LIMIT = 100;

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
  /** 目标标签页 ID（默认当前激活标签页） */
  tabId?: number;
}

/**
 * 页面内提取函数（必须完全自包含：会被序列化注入隔离世界执行）
 * 返回可结构化克隆的提取结果。
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
  truncated?: boolean;
  error?: string;
} {
  /** 判断元素是否可见（无布局或 display:none 视为隐藏） */
  const isVisible = (el: Element): boolean => {
    if (includeHidden) return true;
    if (!el.getClientRects().length) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  /** 提取单个元素的文本或属性值（attr 为 null 表示取文本） */
  const readValue = (el: Element | null | undefined, valueAttr?: string | null): string => {
    if (!el) return '';
    if (!valueAttr || valueAttr === 'text') return (el.textContent || '').trim();
    if (valueAttr === 'html') return (el as HTMLElement).innerHTML || '';
    return el.getAttribute(valueAttr) ?? '';
  };

  try {
    // —— table 模式 ——
    if (mode === 'table') {
      const table = selector ? document.querySelector(selector) : document.querySelector('table');
      if (!table) {
        return { ok: false, error: selector ? `未找到表格元素: ${selector}` : '页面中没有 table 元素' };
      }

      const headerCells = Array.from(table.querySelectorAll('thead th'));
      const bodyRows = Array.from(table.querySelectorAll('tbody tr, tr')).filter(
        (tr) => !headerCells.includes(tr as any) && isVisible(tr),
      );

      const headers =
        headerCells.length > 0
          ? headerCells.map((th, i) => (th.textContent || '').trim() || `列${i + 1}`)
          : [];

      const rows: Record<string, string>[] = [];
      let truncated = false;
      for (const tr of bodyRows) {
        if (rows.length >= limit) {
          truncated = true;
          break;
        }
        const cells = Array.from(tr.querySelectorAll('td, th'));
        if (cells.length === 0) continue;
        const row: Record<string, string> = {};
        cells.forEach((cell, i) => {
          const key = headers[i] ?? `列${i + 1}`;
          row[key] = readValue(cell);
        });
        rows.push(row);
      }

      return { ok: true, headers, rows, count: rows.length, truncated };
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

      return { ok: true, rows, count: rows.length, truncated };
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
      return { ok: true, rows, count: rows.length, truncated };
    }

    return { ok: false, error: `不支持的模式: ${mode}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 结构化数据提取工具
 */
export class PageExtractDataTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.PAGE_EXTRACT_DATA;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.PAGE_EXTRACT_DATA,
    description: '从当前页面 DOM 精确提取结构化数据（表格/列表/选择器），免疫页面 CSP 限制',
    category: 'browser',
    version: '1.0.0',
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
        '从当前页面 DOM 精确提取结构化数据并返回 JSON（RPA 抓取首选）。' +
        '支持三种模式：table=抓取表格（表头+行）；list=抓取重复列表项（商品/评论/文章卡片，按字段映射取文本或属性）；' +
        'selector=通用选择器直接取值。走 DOM 精确路径，不受页面 CSP 限制，结果稳定且不消耗 token。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['table', 'list', 'selector'],
            description: '提取模式。table=表格；list=重复列表条目；selector=通用选择器取值。默认 table',
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
            type: 'number',
            description: '最大提取行数/条目数（默认 100，上限 500）',
            default: DEFAULT_LIST_LIMIT,
          },
          includeHidden: {
            type: 'boolean',
            description: '是否包含隐藏元素（默认 false，跳过不可见元素）',
            default: false,
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

    const {
      mode = 'table',
      selector,
      fields,
      attr,
      limit = DEFAULT_LIST_LIMIT,
      includeHidden = false,
      tabId: requestedTabId,
    } = args;

    const rowLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIST_LIMIT, 1), MAX_ROWS);

    try {
      // tabId 允许为 0：真值判断会把合法的 0 当作「未提供」而错选活动标签页
      const tab = requestedTabId !== undefined && requestedTabId !== null
        ? await chrome.tabs.get(requestedTabId)
        : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab || typeof tab.id !== 'number') {
        return this.createErrorResponse('No active tab found');
      }
      const tabId = tab.id;

      // 受限页面统一口径判定（chrome://、about:、file:// 等，见 common/constants）
      if (isRestrictedUrl(tab.url)) {
        return this.createErrorResponse(
          `Current page is a restricted URL (${tab.url || 'no URL'}) where DOM extraction is not permitted`,
        );
      }

      if (requestedTabId != null) context?.onTabTarget?.(tabId);

      this.log(`Extracting data (mode=${mode}, selector=${selector || 'auto'}) from tab ${tabId}`);

      // 隔离世界注入：纯 DOM 操作、无 eval，天然不受页面 CSP 限制。
      // args 序列化契约：chrome.scripting 的原生绑定序列化器会拒绝 undefined
      // （"Value is unserializable"），可选参数一律以 null 兜底（可结构化克隆），
      // 注入函数内用 != null 判空区分「未提供」与「显式空值」
      const results = await chrome.scripting.executeScript({
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
      });

      const payload = results?.[0]?.result;
      if (!payload) {
        return this.createErrorResponse('Extraction script returned no result');
      }
      if (!payload.ok) {
        return this.createErrorResponse(`Extraction failed: ${payload.error}`);
      }

      return this.createSuccessResponse(
        {
          tabId,
          url: tab.url,
          mode,
          selector: selector ?? (mode === 'table' ? 'table (auto)' : undefined),
          headers: payload.headers,
          rows: payload.rows,
          count: payload.count,
          truncated: payload.truncated === true,
          source: 'dom_extraction',
        },
        `Extracted ${payload.count ?? 0} row(s) via DOM (${mode} mode)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.createErrorResponse(`Extraction failed: ${message}`);
    }
  }
}

// 导出工具实例
export const pageExtractDataTool = new PageExtractDataTool();

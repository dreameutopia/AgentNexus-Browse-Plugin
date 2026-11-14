/**
 * 跨标签页内容检索工具（browser_vector_search）
 *
 * 旧实现是**空壳**：只枚举标签页元信息、score 恒为 0.5、query 从不参与
 * 计算、maxResults 截断的是「遍历的标签页数」而非「结果数」，而且它不在
 * 任何场景或工具组里——是一个注册了但模型永远拿不到的假能力。
 *
 * 现在真正实现：按关键词在所有已打开标签页的**页面文本**里检索，命中位置
 * 带上下文片段，按命中次数与命中位置排序。这是 Chrome 直接支持的能力
 * （chrome.tabs 枚举 + scripting 读页面文本），也是 agent 真实操作浏览器
 * 时反复需要的「我刚才在哪个页面看到过 X」。
 *
 * 实现要点：
 *   - 内容读取用轻量注入（只取可见文本，不走完整结构化 Markdown 管线），
 *     避免为一次检索付出全量解析的代价；
 *   - 受限页面（chrome:// 等）逐个跳过并计入 skipped，不影响其余标签页；
 *   - 每个标签页的文本读取有上限，超长页面按前缀截断（关键词若在截断之外
 *     则该页不会被命中——这在响应里如实标注，避免模型误判「没找到」）；
 *   - 结果按「命中次数 → 命中位置更靠前 → 标题匹配」排序，最相关在前。
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { isRestrictedUrl } from '@/common/constants';

const DEFAULT_MAX_RESULTS = 10;
/** 一次检索最多扫描多少个标签页（防在几十个标签页的窗口上空转） */
const MAX_TABS_SCANNED = 30;
/** 每个标签页最多读取多少字符 */
const MAX_TEXT_PER_TAB = 20_000;
/** 命中片段的上下文长度 */
const SNIPPET_CONTEXT = 80;

interface Match {
  tabId: number;
  title: string;
  url: string;
  /** 命中次数 */
  hits: number;
  /** 首次命中的字符位置 */
  firstHit: number;
  /** 命中位置的上下文片段 */
  snippet: string;
}

/**
 * 跨标签页内容检索工具
 */
export class VectorSearchTabsContentTool extends BaseBrowserTool {
  name = 'browser_vector_search';

  metadata: ToolMetadata = {
    name: 'browser_vector_search',
    description: '在所有已打开标签页的页面文本中检索关键词，返回带上下文片段的命中结果',
    category: 'browser',
    version: '2.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'search', 'tabs', 'content', 'chrome'],
    // 纯读（枚举标签页 + 读取页面文本）：不改活动标签、不动视口 → 视觉循环无需重拍
    noVisionRecapture: true,
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_vector_search',
      description:
        '在所有已打开标签页的**页面文本**中检索关键词（大小写不敏感），返回命中次数、' +
        '命中位置与上下文片段，按相关性排序。适合「我刚才在哪个页面看到过 X」「这些标签页里' +
        '哪一页提到了某产品」这类跨页面回忆。' +
        '只扫描普通网页（chrome:// 等受限页面会被跳过并计入 skipped）；单页读取上限 20000 字符，' +
        '关键词落在截断之外时该页不会命中（响应中标注 scanned 便于判断覆盖范围）。' +
        '要看某个页面的完整正文请用 browser_get_page_text。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description: '要检索的关键词（大小写不敏感）',
            placeholder: '搜索关键词'
          },
          maxResults: {
            type: 'number',
            description: `最多返回多少个命中的标签页（1~50，默认 ${DEFAULT_MAX_RESULTS}）`,
            default: DEFAULT_MAX_RESULTS
          },
          includeTitles: {
            type: 'boolean',
            description: '是否也把标签页标题算作可匹配文本（默认 true）',
            default: true
          },
        },
        required: ['query']
      }
    }
  };

  async execute(args: { query?: string; maxResults?: number; includeTitles?: boolean }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    try {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return this.createErrorResponse('query 必填且不能为空白字符串');
      }
      if (query.length > 200) {
        return this.createErrorResponse(`query 过长（${query.length} 字符，上限 200）`);
      }
      const maxResults = typeof args?.maxResults === 'number' && Number.isFinite(args.maxResults)
        ? Math.max(1, Math.min(50, Math.floor(args.maxResults)))
        : DEFAULT_MAX_RESULTS;
      const includeTitles = args?.includeTitles !== false;
      const needle = query.toLowerCase();

      const tabs = await chrome.tabs.query({});
      const candidates = tabs
        .filter(tab => typeof tab.id === 'number' && !!tab.url && !isRestrictedUrl(tab.url))
        .slice(0, MAX_TABS_SCANNED);

      const matches: Match[] = [];
      const skipped: Array<{ tabId: number; url: string; reason: string }> = [];
      let scanned = 0;

      for (const tab of candidates) {
        const text = await this.readTabText(tab.id!);
        if (text === null) {
          skipped.push({ tabId: tab.id!, url: tab.url!, reason: '页面文本读取失败（受限页面或注入被拒）' });
          continue;
        }
        scanned += 1;

        const haystack = includeTitles ? `${tab.title ?? ''}\n${text}` : text;
        const lower = haystack.toLowerCase();

        const firstHit = lower.indexOf(needle);
        if (firstHit < 0) continue;
        let hits = 0;
        let cursor = firstHit;
        while (cursor >= 0 && hits < 100) {
          hits += 1;
          cursor = lower.indexOf(needle, cursor + needle.length);
        }

        const start = Math.max(0, firstHit - SNIPPET_CONTEXT);
        const snippet = haystack.slice(start, firstHit + needle.length + SNIPPET_CONTEXT).replace(/\s+/g, ' ').trim();

        matches.push({
          tabId: tab.id!,
          title: tab.title ?? tab.url!,
          url: tab.url!,
          hits,
          firstHit,
          snippet,
        });
      }

      matches.sort((a, b) => b.hits - a.hits || a.firstHit - b.firstHit);

      const results = matches.slice(0, maxResults);
      return this.createSuccessResponse(
        {
          query,
          count: results.length,
          totalMatched: matches.length,
          results,
          scanned,
          scannedTabs: candidates.length,
          skipped,
          ...(candidates.length >= MAX_TABS_SCANNED
            ? { note: `标签页超过 ${MAX_TABS_SCANNED} 个，本次只扫描了前 ${MAX_TABS_SCANNED} 个` }
            : {}),
        },
        results.length > 0
          ? `在 ${scanned} 个标签页中命中 ${matches.length} 个（返回前 ${results.length} 个）`
          : `在 ${scanned} 个标签页中未命中「${query}」`,
      );
    } catch (error) {
      return this.createErrorResponse(
        `跨标签页检索失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 读取标签页的可见文本（只取可见正文，不做结构化解析）。
   * 读取失败返回 null（受限页面、注入被拒、页面已关闭）——由调用方计入 skipped。
   */
  private async readTabText(tabId: number): Promise<string | null> {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (limit: number) => {
          const body = document.body;
          if (!body) return '';
          const text = body.innerText || body.textContent || '';
          return text.length > limit ? text.slice(0, limit) : text;
        },
        args: [MAX_TEXT_PER_TAB],
      });
      const value = results?.[0]?.result;
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }
}

// 导出工具实例
export const vectorSearchTabsContentTool = new VectorSearchTabsContentTool();

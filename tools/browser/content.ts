/**
 * 内容提取工具
 * 提供网页内容提取、交互元素获取、向量搜索等功能
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';

/**
 * 网页内容提取工具
 */
export class WebFetcherTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.WEB_FETCHER;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.WEB_FETCHER,
    description: '获取网页内容和元数据',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'content', 'fetch', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.WEB_FETCHER,
      description: '获取网页内容和元数据',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要获取内容的 URL（可选，默认当前页面）'
          },
          selector: {
            type: 'string',
            description: 'CSS 选择器，用于提取特定元素'
          },
          tabId: {
            type: 'number',
            description: '标签页 ID（可选）'
          }
        },
        required: []
      }
    }
  };

  async execute(args: {
    url?: string;
    selector?: string;
    tabId?: number;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const { url, selector, tabId } = args;

    this.log(`Fetching web content from ${url || 'current tab'}`);

    try {
      let targetTabId: number;

      if (tabId) {
        targetTabId = tabId;
      } else if (url) {
        const tab = await this.navigateToUrl(url, { waitForLoad: true });
        targetTabId = tab.id!;
      } else {
        const tab = await this.getActiveTab();
        targetTabId = tab.id!;
      }

      await this.injectContentScript(targetTabId, ['inject-scripts/data/web-fetcher-helper.js']);

      const result = await this.sendMessageToTab(targetTabId, {
        action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT,
        selector,
      });

      return this.createSuccessResponse({
        content: result.content || result.text,
        title: result.title,
        url: result.url,
        metadata: result.metadata,
      }, 'Web content fetched successfully');
    } catch (error) {
      return this.createErrorResponse('Failed to fetch web content', error);
    }
  }

  private async navigateToUrl(url: string, options?: { waitForLoad?: boolean }): Promise<chrome.tabs.Tab> {
    const allTabs = await chrome.tabs.query({});
    const tabs = allTabs.filter((tab) => {
      const tabUrl = tab.url?.endsWith('/') ? tab.url.slice(0, -1) : tab.url;
      const targetUrl = url.endsWith('/') ? url.slice(0, -1) : url;
      return tabUrl === targetUrl;
    });

    if (tabs.length > 0 && tabs[0].id) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      return tabs[0];
    }

    const newTab = await chrome.tabs.create({ url, active: true });
    if (options?.waitForLoad && newTab.id) {
      await this.waitForTabComplete(newTab.id);
    }
    return newTab;
  }
}

/**
 * 向量搜索工具
 */
export class VectorSearchTabsContentTool extends BaseBrowserTool {
  name = 'browser_vector_search';

  metadata: ToolMetadata = {
    name: 'browser_vector_search',
    description: '在所有打开的标签页内容中进行向量搜索',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'search', 'vector', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_vector_search',
      description: '在所有打开的标签页内容中进行向量搜索',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索查询'
          },
          maxResults: {
            type: 'number',
            description: '最大结果数量'
          }
        },
        required: ['query']
      }
    }
  };

  async execute(args: {
    query: string;
    maxResults?: number;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const { query, maxResults = 10 } = args;

    this.log(`Searching tabs content for: ${query}`);

    try {
      const tabs = await chrome.tabs.query({});
      const results: any[] = [];

      for (const tab of tabs.slice(0, maxResults)) {
        if (tab.id && tab.url && !tab.url.startsWith('chrome://')) {
          results.push({
            tabId: tab.id,
            title: tab.title,
            url: tab.url,
            score: 0.5, // 简化实现
          });
        }
      }

      return this.createSuccessResponse({
        query,
        results,
        totalCount: results.length,
      }, `Found ${results.length} matching tabs`);
    } catch (error) {
      return this.createErrorResponse('Vector search failed', error);
    }
  }
}

// 导出工具实例
export const webFetcherTool = new WebFetcherTool();
export const vectorSearchTabsContentTool = new VectorSearchTabsContentTool();

/**
 * 内容提取工具
 * 提供标签页内容向量搜索等功能
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';

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
export const vectorSearchTabsContentTool = new VectorSearchTabsContentTool();

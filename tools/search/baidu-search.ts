/**
 * 百度搜索工具
 */

import { BaseSearchTool } from '../base-tool';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';

export class BaiduSearchTool extends BaseSearchTool {
  name = 'baidu_search';
  
  metadata: ToolMetadata = {
    name: 'baidu_search',
    description: '使用百度搜索引擎搜索信息',
    category: 'search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['search', 'baidu', 'chinese']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'baidu_search',
      description: 'Search for content on Baidu',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query'
          }
        },
        required: ['query']
      }
    }
  };

  protected getSearchEngine(): string {
    return '百度';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://www.baidu.com/s?wd=${encodedQuery}`;
  }
}
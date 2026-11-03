/**
 * Bing搜索工具
 */

import { BaseSearchTool } from '../base-tool';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';

export class BingSearchTool extends BaseSearchTool {
  name = 'bing_search';
  
  metadata: ToolMetadata = {
    name: 'bing_search',
    description: '使用Bing搜索引擎搜索信息',
    category: 'search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['search', 'bing', 'microsoft']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'bing_search',
      description: 'Search for content on Bing',
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
    return 'Bing';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://www.bing.com/search?q=${encodedQuery}`;
  }
}

/**
 * CSDN搜索工具
 */

import { BaseSearchTool } from '../base-tool';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';

export class CSDNSearchTool extends BaseSearchTool {
  name = 'csdn_search';
  
  metadata: ToolMetadata = {
    name: 'csdn_search',
    description: '在CSDN上搜索技术文章和解决方案',
    category: 'search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['search', 'csdn', 'programming', 'chinese', 'technical']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'csdn_search',
      description: '在CSDN上搜索技术文章和解决方案',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '要搜索的技术关键词或问题'
          }
        },
        required: ['query']
      }
    }
  };

  protected getSearchEngine(): string {
    return 'CSDN';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://so.csdn.net/so/search?q=${encodedQuery}&t=all&u=`;
  }
}
/**
 * MOOC搜索工具
 */

import { BaseSearchTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

export class MoocSearchTool extends BaseSearchTool {
  name = 'mooc_search';
  
  metadata: ToolMetadata = {
    name: 'mooc_search',
    description: '在MOOC平台上搜索课程和教育内容',
    category: 'search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['search', 'education', 'mooc', 'courses']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'mooc_search',
      description: '在MOOC平台上搜索课程和教育内容',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '要搜索的课程关键词或主题'
          }
        },
        required: ['query']
      }
    }
  };

  protected getSearchEngine(): string {
    return 'MOOC';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://www.icourse163.org/search.htm?search=${encodedQuery}`;
  }
}
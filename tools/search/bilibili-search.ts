/**
 * CSDN搜索工具
 */

import { BaseSearchTool } from '../base-tool';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';

export class BilibiliSearchTool extends BaseSearchTool {
  name = 'bilibili_search';
  
  metadata: ToolMetadata = {
    name: 'bilibili_search',
    description: '在bilibili上搜索技术文章和解决方案',
    category: 'search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['search', 'bilibili', 'programming', 'chinese', 'technical']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'bilibili_search',
      description: '在bilibili上搜索对应视频',
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
    return `https://search.bilibili.com/all?keyword=${encodedQuery}`;
  }
}
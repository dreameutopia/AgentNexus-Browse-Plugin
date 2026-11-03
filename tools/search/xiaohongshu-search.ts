/**
 * 小红书搜索工具
 */

import { BaseSearchTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

export class XiaohongshuSearchTool extends BaseSearchTool {
  name = 'xiaohongshu_search';
  
  metadata: ToolMetadata = {
    name: 'xiaohongshu_search',
    description: '在小红书平台上搜索内容和笔记',
    category: 'search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['search', 'social', 'xiaohongshu', 'lifestyle']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'xiaohongshu_search',
      description: '在小红书平台上搜索内容和笔记',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '要搜索的关键词或主题'
          }
        },
        required: ['query']
      }
    }
  };

  protected getSearchEngine(): string {
    return '小红书';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://www.xiaohongshu.com/search_result?keyword=${encodedQuery}`;
  }
}
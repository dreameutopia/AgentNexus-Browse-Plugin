/**
 * 知乎搜索工具
 * 提供知乎学术搜索功能
 */

import { BaseSearchTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

export class ZhihuSearchTool extends BaseSearchTool {
  name = 'zhihu_search';
  
  metadata: ToolMetadata = {
    name: 'zhihu_search',
    description: '在知乎上搜索指定问题或话题',
    category: 'search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['search', 'zhihu', 'academic', 'chinese']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'zhihu_search',
      description: '在知乎上搜索问题、文章或话题',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '要搜索的关键词或问题'
          }
        },
        required: ['query']
      }
    }
  };

  protected getSearchEngine(): string {
    return '知乎';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://www.zhihu.com/search?type=content&q=${encodedQuery}`;
  }

  async execute(args: { 
    query: string;
  }) {
    try {
      this.validateArgs(args, ['query']);
      
      const { query } = args;
      const searchUrl = this.getSearchUrl(query);
      
      this.log(`Searching "${query}" on 知乎 (content mode)`);
      
      const result = await this.navigateToUrl(searchUrl, { newTab: true });
      
      if (!result.success) {
        return result;
      }
      
      // 等待页面完全加载
      const loadResult = await this.waitForPageLoad();
      if (!loadResult.success) {
        return loadResult;
      }
      
      return this.createSuccessResponse({
        searchEngine: '知乎',
        query,
        searchType: 'content',
        url: searchUrl,
        description: this.getSearchTypeDescription('content')
      }, `Successfully searched "${query}" on 知乎 (content mode)`);
      
    } catch (error) {
      return this.createErrorResponse('知乎搜索失败', error);
    }
  }

  private getSearchTypeDescription(searchType: string): string {
    switch (searchType) {
      case 'scholar':
        return '学术搜索 - 搜索学术相关的问题和回答';
      case 'content':
        return '内容搜索 - 搜索所有相关内容';
      case 'people':
        return '用户搜索 - 搜索相关用户';
      case 'topic':
        return '话题搜索 - 搜索相关话题';
      default:
        return '默认搜索';
    }
  }
}
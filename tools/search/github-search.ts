/**
 * GitHub搜索工具
 */

import { BaseSearchTool } from '../base-tool';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';

export class GitHubSearchTool extends BaseSearchTool {
  name = 'github_search';
  
  metadata: ToolMetadata = {
    name: 'github_search',
    description: '在GitHub上搜索代码仓库、代码片段和开发者',
    category: 'search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['search', 'github', 'code', 'repository', 'developer']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'github_search',
      description: 'Search for repositories, code, or users on GitHub',
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
    return 'GitHub';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://github.com/search?q=${encodedQuery}&type=repositories`;
  }

  async execute(args: { 
    query: string; 
    newTab?: boolean;
  }) {
    try {
      this.validateArgs(args, ['query']);
      
      const { query, newTab = true } = args;
      const searchUrl = this.getSearchUrl(query);
      
      this.log(`Searching "${query}" on GitHub (repositories mode)`);
      
      const result = await this.navigateToUrl(searchUrl, { newTab });
      
      if (!result.success) {
        return result;
      }
      
      // 等待页面完全加载
      const loadResult = await this.waitForPageLoad();
      if (!loadResult.success) {
        return loadResult;
      }
      
      return this.createSuccessResponse({
        searchEngine: 'GitHub',
        query,
        searchType: 'repositories',
        url: searchUrl,
        description: '仓库搜索 - 搜索代码仓库'
      }, `Successfully searched "${query}" on GitHub (repositories mode)`);
      
    } catch (error) {
      return this.createErrorResponse('GitHub搜索失败', error);
    }
  }

  private getSearchTypeDescription(searchType: string): string {
    switch (searchType) {
      case 'repositories':
        return '仓库搜索 - 搜索代码仓库';
      case 'code':
        return '代码搜索 - 搜索代码片段';
      case 'users':
        return '用户搜索 - 搜索开发者';
      case 'issues':
        return '问题搜索 - 搜索Issues';
      case 'discussions':
        return '讨论搜索 - 搜索讨论话题';
      default:
        return '默认搜索';
    }
  }
}
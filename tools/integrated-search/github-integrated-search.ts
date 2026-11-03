/**
 * GitHub集成搜索工具
 * 整合 github_search 和 github_result_scraper
 */

import { BaseIntegratedSearchTool } from './base-integrated-search';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

interface GitHubRepository {
  repoName: string;
  link: string;
  description: string;
  topics: string[];
  language: string;
  stars: string;
  lastUpdate: string;
}

export class GitHubIntegratedSearchTool extends BaseIntegratedSearchTool {
  name = 'github_integrated_search';
  
  metadata: ToolMetadata = {
    name: 'github_integrated_search',
    description: '在GitHub上搜索仓库并自动提取结果，返回Markdown表格格式',
    category: 'integrated-search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['github', 'search', 'scraper', 'integrated', 'json', 'repository']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'github_integrated_search',
      description: '在GitHub上搜索代码仓库，自动跳转、等待加载并提取搜索结果，返回Markdown表格格式',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词'
          },
          waitTime: {
            type: 'number',
            description: '页面加载后额外等待时间（毫秒，默认3000）',
            default: 3000
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

  protected getScraperToolName(): string {
    return 'github_result_scraper';
  }
}

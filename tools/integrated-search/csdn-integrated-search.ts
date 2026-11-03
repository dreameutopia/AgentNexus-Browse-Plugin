/**
 * CSDN集成搜索工具
 * 整合 csdn_search 和 csdn_result_scraper
 */

import { BaseIntegratedSearchTool } from './base-integrated-search';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

interface CSDNArticle {
  title: string;
  link: string;
  summary: string;
  author: string;
  date: string;
  stats: {
    views: string;
    likes: string;
    comments: string;
  };
}

export class CSDNIntegratedSearchTool extends BaseIntegratedSearchTool {
  name = 'csdn_integrated_search';
  
  metadata: ToolMetadata = {
    name: 'csdn_integrated_search',
    description: '在CSDN上搜索技术文章并自动提取结果，返回Markdown表格格式',
    category: 'integrated-search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['csdn', 'search', 'scraper', 'integrated', 'json', 'technical']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'csdn_integrated_search',
      description: '在CSDN上搜索技术文章，自动跳转、等待加载并提取搜索结果，返回Markdown表格格式',
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
    return 'CSDN';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://so.csdn.net/so/search?q=${encodedQuery}&t=all&u=`;
  }

  protected getScraperToolName(): string {
    return 'csdn_result_scraper';
  }
}

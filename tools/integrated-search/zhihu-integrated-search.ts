/**
 * 知乎集成搜索工具
 * 整合 zhihu_search 和 zhihu_result_scraper
 */

import { BaseIntegratedSearchTool } from './base-integrated-search';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

interface ZhihuResult {
  title: string;
  link: string;
  summary: string;
  author: string;
  date: string;
  stats: {
    likes: string;
    comments: string;
  };
}

export class ZhihuIntegratedSearchTool extends BaseIntegratedSearchTool {
  name = 'zhihu_integrated_search';
  
  metadata: ToolMetadata = {
    name: 'zhihu_integrated_search',
    description: '在知乎上搜索并自动提取结果，返回Markdown表格格式',
    category: 'integrated-search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['zhihu', 'search', 'scraper', 'integrated', 'json', 'chinese']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'zhihu_integrated_search',
      description: '在知乎上搜索问题或话题，自动跳转、等待加载并提取搜索结果，返回Markdown表格格式',
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
    return '知乎';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://www.zhihu.com/search?type=content&q=${encodedQuery}`;
  }

  protected getScraperToolName(): string {
    return 'zhihu_result_scraper';
  }
}

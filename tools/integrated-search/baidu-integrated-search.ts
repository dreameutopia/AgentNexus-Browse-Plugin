/**
 * 百度集成搜索工具
 * 整合 baidu_search 和 baidu_result_scraper
 */

import { BaseIntegratedSearchTool } from './base-integrated-search';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

interface BaiduSearchResult {
  title: string;
  link: string;
  description: string;
  source?: string;
  time?: string;
}

export class BaiduIntegratedSearchTool extends BaseIntegratedSearchTool {
  name = 'baidu_integrated_search';
  
  metadata: ToolMetadata = {
    name: 'baidu_integrated_search',
    description: '在百度上搜索并自动提取结果，返回Markdown表格格式',
    category: 'integrated-search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['baidu', 'search', 'scraper', 'integrated', 'json', 'chinese']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'baidu_integrated_search',
      description: '在百度上搜索关键词，自动跳转、等待加载并提取搜索结果，返回Markdown表格格式',
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
    return '百度';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://www.baidu.com/s?wd=${encodedQuery}`;
  }

  protected getScraperToolName(): string {
    return 'baidu_result_scraper';
  }
}

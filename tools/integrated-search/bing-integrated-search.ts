/**
 * Bing集成搜索工具
 * 整合 bing_search 和 bing_result_scraper
 */

import { BaseIntegratedSearchTool } from './base-integrated-search';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

interface BingSearchResult {
  title: string;
  link: string;
  description: string;
  displayUrl?: string;
}

export class BingIntegratedSearchTool extends BaseIntegratedSearchTool {
  name = 'bing_integrated_search';
  
  metadata: ToolMetadata = {
    name: 'bing_integrated_search',
    description: '在Bing上搜索并自动提取结果，返回Markdown表格格式',
    category: 'integrated-search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['bing', 'search', 'scraper', 'integrated', 'json']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'bing_integrated_search',
      description: '在Bing上搜索关键词，自动跳转、等待加载并提取搜索结果，返回Markdown表格格式',
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
    return 'Bing';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://www.bing.com/search?q=${encodedQuery}`;
  }

  protected getScraperToolName(): string {
    return 'bing_result_scraper';
  }
}

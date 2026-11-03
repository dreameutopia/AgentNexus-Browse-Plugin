/**
 * Bilibili集成搜索工具
 * 整合 bilibili_search 和 bilibili_search_result_scraper
 */

import { BaseIntegratedSearchTool } from './base-integrated-search';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

interface BilibiliVideo {
  title: string;
  link: string;
  author: string;
  uploadDate: string;
  stats: {
    views: string;
    danmaku: string;
    duration: string;
  };
}

export class BilibiliIntegratedSearchTool extends BaseIntegratedSearchTool {
  name = 'bilibili_integrated_search';
  
  metadata: ToolMetadata = {
    name: 'bilibili_integrated_search',
    description: '在Bilibili上搜索并自动提取视频结果，返回Markdown表格格式',
    category: 'integrated-search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['bilibili', 'search', 'scraper', 'integrated', 'json', 'video']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'bilibili_integrated_search',
      description: '在Bilibili上搜索视频，自动跳转、等待加载并提取搜索结果，返回Markdown表格格式',
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
    return 'Bilibili';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://search.bilibili.com/all?keyword=${encodedQuery}`;
  }

  protected getScraperToolName(): string {
    return 'bilibili_search_result_scraper';
  }
}

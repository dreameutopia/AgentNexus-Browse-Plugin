/**
 * 小红书集成搜索工具
 * 整合 xiaohongshu_search 和 xiaohongshu_result_scraper
 */

import { BaseIntegratedSearchTool } from './base-integrated-search';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

interface XiaohongshuNote {
  title: string;
  link: string;
  author: string;
  description: string;
  stats: {
    likes: string;
    comments: string;
  };
}

export class XiaohongshuIntegratedSearchTool extends BaseIntegratedSearchTool {
  name = 'xiaohongshu_integrated_search';
  
  metadata: ToolMetadata = {
    name: 'xiaohongshu_integrated_search',
    description: '在小红书上搜索笔记并自动提取结果，返回Markdown表格格式',
    category: 'integrated-search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['xiaohongshu', 'search', 'scraper', 'integrated', 'json', 'social']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'xiaohongshu_integrated_search',
      description: '在小红书上搜索笔记内容，自动跳转、等待加载并提取搜索结果，返回Markdown表格格式',
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
    return '小红书';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://www.xiaohongshu.com/search_result?keyword=${encodedQuery}`;
  }

  protected getScraperToolName(): string {
    return 'xiaohongshu_result_scraper';
  }
}

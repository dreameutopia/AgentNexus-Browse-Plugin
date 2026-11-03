/**
 * 知网(CNKI)集成搜索工具
 * 整合 cnki_search 和 cnki_result_scraper
 */

import { BaseIntegratedSearchTool } from './base-integrated-search';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

interface CNKIPaper {
  title: string;
  link: string;
  authors: string[];
  source: string;
  publishDate: string;
  abstract: string;
  stats: {
    downloads: string;
    citations: string;
  };
}

export class CNKIIntegratedSearchTool extends BaseIntegratedSearchTool {
  name = 'cnki_integrated_search';
  
  metadata: ToolMetadata = {
    name: 'cnki_integrated_search',
    description: '在中国知网(CNKI)上搜索学术文献并自动提取结果，返回Markdown表格格式',
    category: 'integrated-search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['cnki', 'search', 'scraper', 'integrated', 'json', 'academic']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'cnki_integrated_search',
      description: '在中国知网(CNKI)上搜索学术论文和期刊文献，自动跳转、等待加载并提取搜索结果，返回Markdown表格格式',
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
    return '中国知网';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://kns.cnki.net/kns8/DefaultResult/Index?dbcode=SCDB&kw=${encodedQuery}`;
  }

  protected getScraperToolName(): string {
    return 'cnki_result_scraper';
  }
}

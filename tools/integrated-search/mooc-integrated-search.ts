/**
 * 中国大学MOOC集成搜索工具
 * 整合 mooc_search 和 mooc_result_scraper
 */

import { BaseIntegratedSearchTool } from './base-integrated-search';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

interface MOOCCourse {
  title: string;
  link: string;
  school: string;
  teacher: string;
  description: string;
  stats: {
    participants: string;
    rating: string;
  };
}

export class MOOCIntegratedSearchTool extends BaseIntegratedSearchTool {
  name = 'mooc_integrated_search';
  
  metadata: ToolMetadata = {
    name: 'mooc_integrated_search',
    description: '在中国大学MOOC上搜索课程并自动提取结果，返回Markdown表格格式',
    category: 'integrated-search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['mooc', 'search', 'scraper', 'integrated', 'json', 'education']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'mooc_integrated_search',
      description: '在中国大学MOOC上搜索在线课程，自动跳转、等待加载并提取搜索结果，返回Markdown表格格式',
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
    return '中国大学MOOC';
  }

  protected getSearchUrl(query: string): string {
    const encodedQuery = encodeURIComponent(query);
    return `https://www.icourse163.org/search.htm?search=${encodedQuery}`;
  }

  protected getScraperToolName(): string {
    return 'mooc_result_scraper';
  }
}

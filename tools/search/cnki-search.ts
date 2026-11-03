/**
 * 中国知网搜索工具
 */

import { BaseSearchTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

export class CNKISearchTool extends BaseSearchTool {
  name = 'cnki_search';
  
  metadata: ToolMetadata = {
    name: 'cnki_search',
    description: '在中国知网(CNKI)上搜索学术论文和期刊文献',
    category: 'search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['search', 'academic', 'cnki', 'research', 'paper']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'cnki_search',
      description: '在中国知网(CNKI)上搜索学术论文和期刊文献',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '要搜索的学术关键词或论文主题'
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
    return `https://kns.cnki.net/kns8s/defaultresult/index?kw=${encodedQuery}`;
  }
}
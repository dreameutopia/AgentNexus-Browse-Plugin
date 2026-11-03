/**
 * Bing搜索结果解析工具
 * 解析Bing搜索结果页面，提取搜索结果信息
 */

import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { resultsToMarkdownTable } from '../common/markdown-table';

// 定义搜索结果接口
interface BingSearchResult {
  title: string;
  link: string;
  description: string;
  displayUrl?: string;
}

export class BingResultScraperTool extends BaseTool {
  name = 'bing_result_scraper';
  
  metadata: ToolMetadata = {
    name: 'bing_result_scraper',
    description: '解析Bing搜索结果页面，提取搜索结果为Markdown表格格式',
    category: 'analyse',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['bing', 'scraper', 'search']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'bing_result_scraper',
      description: '解析Bing搜索结果页面，提取搜索结果为Markdown表格格式',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  };

  /**
   * 抓取Bing搜索结果
   */
  private async scrapeResults(): Promise<BingSearchResult[]> {
    const startTime = Date.now();
    this.log(`[${new Date().toISOString()}] 开始抓取Bing搜索结果`);
    
    try {
      // 获取当前标签页
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab.id) {
        throw new Error('无法获取当前标签页');
      }

      // 注入脚本提取Bing搜索结果
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const results: BingSearchResult[] = [];
          
          // Bing搜索结果在 #b_results 容器中
          const resultItems = document.querySelectorAll('#b_results .b_algo, #b_results li.b_algo');
          
          resultItems.forEach((item) => {
            try {
              // 提取标题和链接
              const titleEl = item.querySelector('h2 a, h3 a');
              const title = titleEl?.textContent?.trim() || '';
              const link = (titleEl as HTMLAnchorElement)?.href || '';
              
              // 提取描述
              const descEl = item.querySelector('.b_caption p, .b_algoSlug');
              const description = descEl?.textContent?.trim() || '';
              
              // 提取显示URL
              const urlEl = item.querySelector('.b_attribution cite, .tpcn a.tilk');
              const displayUrl = urlEl?.textContent?.trim() || '';
              
              if (title && link) {
                results.push({
                  title,
                  link,
                  description,
                  displayUrl
                });
              }
            } catch (err) {
              console.error('解析Bing搜索结果项失败:', err);
            }
          });
          
          return results;
        }
      });

      const searchResults = results[0]?.result || [];
      const duration = Date.now() - startTime;
      
      this.log(`[${new Date().toISOString()}] 抓取完成，共获取 ${searchResults.length} 条结果，耗时: ${duration}ms`);
      
      return searchResults;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      this.log(`[${new Date().toISOString()}] 抓取失败，耗时: ${duration}ms`, 'error');
      throw error;
    }
  }

  async execute(): Promise<ToolResult> {
    try {
      this.log('开始执行Bing搜索结果抓取');
      
      // 抓取搜索结果
      const results = await this.scrapeResults();
      
      const markdownTable = resultsToMarkdownTable(results);
      
      this.log(`成功抓取 ${results.length} 条Bing搜索结果`);
      
      return {
        success: true,
        message: `成功抓取 ${results.length} 条Bing搜索结果`,
        data: {
          results,
          count: results.length,
          markdown: markdownTable
        },
        content: [{
          type: 'text',
          text: markdownTable
        }]
      };
      
    } catch (error: any) {
      this.log(`Bing搜索结果抓取失败: ${error.message}`, 'error');
      
      return {
        success: false,
        message: `抓取失败: ${error.message}`,
        error: error.message,
        isError: true,
        content: [{
          type: 'text',
          text: `抓取失败: ${error.message}`
        }]
      };
    }
  }
}

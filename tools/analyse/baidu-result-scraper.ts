/**
 * 百度搜索结果解析工具
 * 解析百度搜索结果页面，提取搜索结果信息
 */

import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { resultsToMarkdownTable } from '../common/markdown-table';

// 定义搜索结果接口
interface BaiduSearchResult {
  title: string;
  link: string;
  description: string;
  source?: string;
  time?: string;
}

export class BaiduResultScraperTool extends BaseTool {
  name = 'baidu_result_scraper';
  
  metadata: ToolMetadata = {
    name: 'baidu_result_scraper',
    description: '解析百度搜索结果页面，提取搜索结果为Markdown表格格式',
    category: 'analyse',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['baidu', 'scraper', 'search']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'baidu_result_scraper',
      description: '解析百度搜索结果页面，提取搜索结果为Markdown表格格式',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  };

  /**
   * 抓取百度搜索结果
   */
  private async scrapeResults(): Promise<BaiduSearchResult[]> {
    const startTime = Date.now();
    this.log(`[${new Date().toISOString()}] 开始抓取百度搜索结果`);
    
    try {
      // 获取当前标签页
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab.id) {
        throw new Error('无法获取当前标签页');
      }

      // 注入脚本提取百度搜索结果
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const results: BaiduSearchResult[] = [];
          
          // 百度搜索结果主要在 #content_left 容器中
          const resultItems = document.querySelectorAll('#content_left .result, #content_left .c-container');
          
          resultItems.forEach((item) => {
            try {
              // 提取标题和链接
              const titleEl = item.querySelector('h3 a, .t a');
              const title = titleEl?.textContent?.trim() || '';
              const link = (titleEl as HTMLAnchorElement)?.href || '';
              
              // 提取描述
              const descEl = item.querySelector('.c-abstract, .c-span9, .c-span-last');
              const description = descEl?.textContent?.trim() || '';
              
              // 提取来源
              const sourceEl = item.querySelector('.c-color-gray, .c-showurl');
              const source = sourceEl?.textContent?.trim() || '';
              
              // 提取时间（如果有）
              const timeEl = item.querySelector('.c-color-gray2, .newTimeFactor_time_y9w3r');
              const time = timeEl?.textContent?.trim() || '';
              
              if (title && link) {
                results.push({
                  title,
                  link,
                  description,
                  source,
                  time
                });
              }
            } catch (err) {
              console.error('解析百度搜索结果项失败:', err);
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
      this.log('开始执行百度搜索结果抓取');
      
      // 抓取搜索结果
      const results = await this.scrapeResults();
      
      const markdownTable = resultsToMarkdownTable(results);
      
      this.log(`成功抓取 ${results.length} 条百度搜索结果`);
      
      return {
        success: true,
        message: `成功抓取 ${results.length} 条百度搜索结果`,
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
      this.log(`百度搜索结果抓取失败: ${error.message}`, 'error');
      
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

/**
 * 集成搜索工具基类
 * 整合搜索和结果抓取功能，提供统一的 Markdown 表格输出
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { toolRegistry } from '../registry';
import { resultsToMarkdownTable } from '../common/markdown-table';

/**
 * 集成搜索工具基类
 * 子类需要实现特定平台的搜索和抓取逻辑
 */
export abstract class BaseIntegratedSearchTool extends BaseTool {
  /**
   * 获取搜索URL
   */
  protected abstract getSearchUrl(query: string): string;

  /**
   * 获取搜索引擎名称
   */
  protected abstract getSearchEngine(): string;

  /**
   * 获取对应的 result_scraper 工具名称
   */
  protected abstract getScraperToolName(): string;

  /**
   * 等待页面加载完成
   * @param tabId 标签页ID
   * @param timeout 超时时间（毫秒）
   */
  protected async waitForPageLoad(tabId: number, timeout: number = 30000): Promise<void> {
    const startTime = Date.now();
    this.log(`等待页面加载，超时时间: ${timeout}ms`);

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(async () => {
        try {
          // 检查是否超时
          if (Date.now() - startTime > timeout) {
            clearInterval(checkInterval);
            reject(new Error(`页面加载超时 (${timeout}ms)`));
            return;
          }

          // 检查页面加载状态
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab && tab.status === 'complete') {
            clearInterval(checkInterval);
            // 额外等待一小段时间确保DOM完全渲染
            setTimeout(() => resolve(), 1000);
          }
        } catch (error) {
          clearInterval(checkInterval);
          reject(error);
        }
      }, 500);
    });
  }

  /**
   * 抓取搜索结果 - 调用对应的 result_scraper 工具
   */
  protected async scrapeResults(): Promise<any[]> {
    const scraperToolName = this.getScraperToolName();
    const scraperTool = toolRegistry.getTool(scraperToolName);
    
    if (!scraperTool) {
      throw new Error(`未找到抓取工具: ${scraperToolName}`);
    }
    
    this.log(`调用 ${scraperToolName} 工具抓取结果`);
    const result = await scraperTool.execute({});
    
    if (!result.success) {
      throw new Error(`抓取失败: ${result.message || result.error}`);
    }
    
    // 从 result.data 或 result.content 中提取结果数组
    if (result.data && Array.isArray(result.data.results)) {
      return result.data.results;
    }
    
    // 如果没有 results 字段，尝试直接返回 data
    if (Array.isArray(result.data)) {
      return result.data;
    }
    
    return [];
  }

  protected formatResultsAsMarkdownTable(results: any[]): string {
    return resultsToMarkdownTable(results);
  }

  /**
   * 执行集成搜索
   */
  async execute(params: { 
    query: string; 
    waitTime?: number;
  }): Promise<ToolResult> {
    const { query, waitTime = 3000 } = params;

    try {
      this.validateArgs(params, ['query']);
      this.log(`开始在 ${this.getSearchEngine()} 上搜索: "${query}"`);

      // 1. 构建搜索URL
      const searchUrl = this.getSearchUrl(query);
      this.log(`搜索URL: ${searchUrl}`);

      // 2. 导航到搜索页面
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) {
        throw new Error('无法获取当前标签页');
      }

      await chrome.tabs.update(tab.id, { url: searchUrl });
      this.log('已导航到搜索页面');

      // 3. 等待页面加载
      this.log(`等待页面加载...`);
      await this.waitForPageLoad(tab.id, 30000);
      
      // 额外等待以确保动态内容加载
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.log('页面加载完成');

      // 4. 调用对应的 result_scraper 工具抓取搜索结果
      this.log('开始抓取搜索结果...');
      const results = await this.scrapeResults();
      this.log(`成功抓取 ${results.length} 条结果`);

      // 5. 转换为 Markdown 表格
      const markdownTable = this.formatResultsAsMarkdownTable(results);

      return {
        success: true,
        message: `成功在 ${this.getSearchEngine()} 上搜索 "${query}"，找到 ${results.length} 条结果`,
        data: {
          searchEngine: this.getSearchEngine(),
          query,
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
      this.log(`搜索失败: ${error.message}`, 'error');
      
      return {
        success: false,
        message: `搜索失败: ${error.message}`,
        error: error.message,
        isError: true,
        content: [{
          type: 'text',
          text: `搜索失败: ${error.message}`
        }]
      };
    }
  }
}

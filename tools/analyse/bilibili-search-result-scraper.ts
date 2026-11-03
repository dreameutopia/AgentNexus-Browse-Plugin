/**
 * Bilibili搜索结果解析工具 (重构版 v3.0.0)
 * 使用新的注入脚本架构
 */

import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { resultsToMarkdownTable } from '../common/markdown-table';

// 定义视频信息接口
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

export class BilibiliSearchResultScraperTool extends BaseTool {
  name = 'bilibili_search_result_scraper';
  
  metadata: ToolMetadata = {
    name: 'bilibili_search_result_scraper',
    description: '解析Bilibili搜索结果页面，提取视频信息为Markdown表格格式',
    category: 'analyse',
    version: '3.0.0',
    author: 'AgentNexus',
    tags: ['bilibili', 'scraper', 'video', 'search']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'bilibili_search_result_scraper',
      description: '解析Bilibili搜索结果页面，提取视频信息为Markdown表格格式',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  };

  async execute(): Promise<ToolResult> {
    try {
      this.log(`[${new Date().toISOString()}] 开始执行Bilibili搜索结果抓取...`);
      
      const results = await this.scrapeResults();
      
      if (!results || results.length === 0) {
        return {
          success: true,
          data: {
            results: []
          },
          content: [{
            type: 'text',
            text: '未找到任何Bilibili视频，请确保您在Bilibili搜索结果页面'
          }],
          isError: false
        };
      }

      const markdownTable = resultsToMarkdownTable(results);

      return {
        success: true,
        data: {
          results,
          count: results.length,
          markdown: markdownTable
        },
        content: [{
          type: 'text',
          text: markdownTable
        }],
        isError: false
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`[${new Date().toISOString()}] 解析失败: ${errorMessage}`, 'error');
      this.log(`[${new Date().toISOString()}] 错误堆栈: ${error instanceof Error ? error.stack : 'N/A'}`, 'error');
      
      return {
        success: false,
        content: [{
          type: 'text',
          text: `抓取失败: ${errorMessage}`
        }],
        isError: true
      };
    }
  }

  /**
   * 抓取Bilibili搜索结果
   */
  private async scrapeResults(): Promise<BilibiliVideo[]> {
    try {
      // 1. 获取当前活动标签页ID
      const tabId = await this.getCurrentTabId();
      this.log(`获取到标签页ID: ${tabId}`);
      
      // 2. 注入Bilibili抓取脚本
      await this.injectBilibiliScript(tabId);
      
      // 3. 等待脚本初始化
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 4. 发送消息给注入的脚本并等待结果
      const videos = await this.sendMessageToScript(tabId);
      
      this.log(`成功抓取到 ${videos.length} 个Bilibili视频`);
      return videos;
      
    } catch (error) {
      this.log(`抓取Bilibili结果时发生错误: ${error}`, 'error');
      throw error;
    }
  }

  /**
   * 获取当前活动标签页ID
   */
  private async getCurrentTabId(): Promise<number> {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          reject(new Error(`获取标签页失败: ${chrome.runtime.lastError.message}`));
          return;
        }
        if (!tabs || tabs.length === 0) {
          reject(new Error('未找到活动标签页'));
          return;
        }
        resolve(tabs[0].id!);
      });
    });
  }

  /**
   * 注入Bilibili抓取脚本
   */
  private async injectBilibiliScript(tabId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          files: ['inject-scripts/scraper/bilibili.js']
        },
        (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(`脚本注入失败: ${chrome.runtime.lastError.message}`));
            return;
          }
          this.log(`Bilibili脚本已成功注入到标签页 ${tabId}`);
          resolve();
        }
      );
    });
  }

  /**
   * 向注入的脚本发送消息并等待结果
   */
  private async sendMessageToScript(tabId: number): Promise<BilibiliVideo[]> {
    return new Promise((resolve, reject) => {
      const timeout = 30000; // 30秒超时
      const timeoutId = setTimeout(() => {
        reject(new Error('等待脚本响应超时'));
      }, timeout);

      chrome.tabs.sendMessage(
        tabId,
        { action: 'scrapeBilibiliResults' },
        (response) => {
          clearTimeout(timeoutId);
          
         if (chrome.runtime.lastError) {
            reject(new Error(`消息发送失败: ${chrome.runtime.lastError.message}`));
            return;
          }
          
          if (!response) {
            reject(new Error('脚本未响应或页面不支持。可能需要刷新页面。'));
            return;
          }
          
          // 检查脚本是否返回了错误状态
          if (response.status === 'error') {
            reject(new Error(`脚本执行错误: ${response.message || '未知错误'}`));
            return;
          }
          
          // 检查脚本是否返回了成功状态，并且附带了 data
          if (response.status === 'success' && response.data !== undefined) {
            this.log(`成功获取到 ${response.data.length} 个Bilibili视频`);
            resolve(response.data);
            return;
          }
          
          reject(new Error('脚本返回无效或未知格式的数据'));
        }
      );
    });
  }
}
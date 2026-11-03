/**
 * GitHub搜索结果解析工具 (重构版 v3.0.0)
 * 使用新的注入脚本架构
 */

import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';

// 定义仓库信息接口
interface GitHubRepository {
  repoName: string;
  link: string;
  description: string;
  topics: string[];
  language: string;
  stars: string;
  lastUpdate: string;
}

export class GitHubResultScraperTool extends BaseTool {
  name = 'github_result_scraper';
  
  metadata: ToolMetadata = {
    name: 'github_result_scraper',
    description: '解析GitHub搜索结果页面，提取仓库信息为JSON格式',
    category: 'analyse',
    version: '3.0.0', // 重构版
    author: 'AgentNexus',
    tags: ['github', 'scraper', 'repository', 'search']
  }

  /**
   * 抓取GitHub搜索结果
   */
  private async scrapeResults(): Promise<GitHubRepository[]> {
    const startTime = Date.now();
    this.log(`[${new Date().toISOString()}] 开始抓取GitHub搜索结果`);
    
    try {
      // 1. 获取当前标签页ID
      const tabId = await this.getCurrentTabId();
      this.log(`[${new Date().toISOString()}] 当前标签页ID: ${tabId}`);
      
      // 2. 注入GitHub抓取脚本
      await this.injectGitHubScript(tabId);
      
      // 3. 发送抓取命令并等待结果
      const repositories = await this.sendMessageToScript(tabId);
      
      const duration = Date.now() - startTime;
      
      this.log(`[${new Date().toISOString()}] 抓取完成，共获取 ${repositories.length} 个仓库，耗时: ${duration}ms`);
      
      return repositories;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      this.log(`[${new Date().toISOString()}] 抓取失败，耗时: ${duration}ms`, 'error');
      throw error;
    }
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'github_result_scraper',
      description: '解析GitHub搜索结果页面，提取仓库信息为JSON格式',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  };

  async execute(): Promise<ToolResult> {
    try {
      this.log(`[${new Date().toISOString()}] 开始执行GitHub结果抓取...`);
      
      const results = await this.scrapeResults();
      
      if (!results || results.length === 0) {
        return {
          success: true,
          data: {
            results: []
          },
          content: [{
            type: 'text',
            text: '未找到任何GitHub仓库，请确保您在GitHub搜索结果页面'
          }],
          isError: false
        };
      }

      const resultText = `找到 ${results.length} 个GitHub仓库：\n\n` +
        results.map((repo, index) => 
          `${index + 1}. **${repo.repoName}**\n` +
          `   - 链接: ${repo.link}\n` +
          `   - 描述: ${repo.description}\n` +
          `   - 话题: ${repo.topics.join(', ')}\n` +
          `   - 语言: ${repo.language}\n` +
          `   - 星标: ${repo.stars}\n` +
          `   - 最后更新: ${repo.lastUpdate}\n\n`
        ).join('');

      return {
        success: true,
        data: {
          results: results
        },
        content: [{
          type: 'text',
          text: resultText
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
   * 注入GitHub抓取脚本
   */
  private async injectGitHubScript(tabId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          files: ['inject-scripts/scraper/github.js']
        },
        (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(`脚本注入失败: ${chrome.runtime.lastError.message}`));
            return;
          }
          this.log(`GitHub脚本已成功注入到标签页 ${tabId}`);
          resolve();
        }
      );
    });
  }

  /**
   * 向注入的脚本发送消息并等待结果
   */
  private async sendMessageToScript(tabId: number): Promise<GitHubRepository[]> {
    return new Promise((resolve, reject) => {
      const timeout = 30000; // 30秒超时
      const timeoutId = setTimeout(() => {
        reject(new Error('等待脚本响应超时'));
      }, timeout);

      chrome.tabs.sendMessage(
        tabId,
        { action: 'scrapeGitHubResults' },
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
            this.log(`成功获取到 ${response.data.length} 个GitHub仓库`);
            resolve(response.data);
            return;
          }
          
          reject(new Error('脚本返回无效或未知格式的数据'));
        }
      );
    });
  }
}
/**
 * 知乎搜索结果解析工具 (重构版 v4.0.0)
 * 使用inject-scripts/scraper/zhihu.js进行解析
 */

import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';

// 定义知乎内容信息接口
interface ZhihuResult {
  title: string;
  link: string;
  summary: string;
  author: string;
  date: string;
  stats: {
    likes: string;
    comments: string;
  };
}
export class ZhihuResultScraperTool extends BaseTool {
  name = 'zhihu_result_scraper';
  
  metadata: ToolMetadata = {
    name: 'zhihu_result_scraper',
    description: '解析知乎搜索结果页面，提取内容信息为JSON格式',
    category: 'analyse',
    version: '4.0.0', // 使用zhihu.js脚本版
    author: 'Assistant',
    tags: ['zhihu', 'scraper', 'search', 'analysis']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'zhihu_result_scraper',
      description: '解析知乎搜索结果页面，提取问题回答和文章列表',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  };
  

  /**
   * 抓取知乎搜索结果
   */
  private async scrapeResults(): Promise<ZhihuResult[]> {
    const startTime = Date.now();
    this.log(`[${new Date().toISOString()}] 开始抓取知乎搜索结果...`);

    try {
      // 1. 获取当前标签页ID
      const tabId = await this.getCurrentTabId();
      this.log(`[${new Date().toISOString()}] 当前标签页ID: ${tabId}`);

      // 2. 注入知乎抓取脚本 (假设脚本文件名为 zhihu.js)
      await this.injectZhihuScript(tabId);

      // 3. 发送抓取命令并等待结果
      const results = await this.sendMessageToScript(tabId);

      const duration = Date.now() - startTime;
      this.log(`[${new Date().toISOString()}] 抓取完成，共获取 ${results.length} 条结果，耗时: ${duration}ms`);

      return results;

    } catch (error) {
      const duration = Date.now() - startTime;
      this.log(`[${new Date().toISOString()}] 知乎抓取失败，耗时: ${duration}ms`, 'error');
      throw error;
    }
  }



  async execute(): Promise<ToolResult> {
    try {
      this.log(`[${new Date().toISOString()}] 开始执行知乎结果抓取...`);

      const results = await this.scrapeResults();

      if (!results || results.length === 0) {
        return {
          success: true,
          data: {
            results: []
          },
          content: [{
            type: 'text',
            text: '未找到任何知乎结果，请确保您在知乎搜索结果页面，并且页面已加载完毕。'
          }]
        };
      }

      const resultText = `找到 ${results.length} 条知乎结果：\n\n` +
        results.map((result, index) =>
          `${index + 1}. **${result.title}**\n` +
          `   - 作者: ${result.author}\n` +
          `   - 摘要: ${result.summary}\n` +
          `   - 统计: 赞同 ${result.stats.likes} | 评论 ${result.stats.comments} | 日期 ${result.date}\n` +
          `   - 链接: ${result.link}\n`
        ).join('\n');

      return {
        success: true,
        data: {
          results: results
        },
        content: [{
          type: 'text',
          text: resultText
        }]
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`[${new Date().toISOString()}] 解析失败: ${errorMessage}`, 'error');
      this.log(`[${new Date().toISOString()}] 错误堆栈: ${error instanceof Error ? error.stack : 'N/A'}`, 'error');

      return {
        success: false,
        content: [{
          type: 'text',
          text: `抓取知乎数据失败: ${errorMessage}`
        }],
        error: errorMessage
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
   * 注入知乎抓取脚本
   */
  private async injectZhihuScript(tabId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          // 注意：此处的文件名需要与您项目中的实际文件名一致
          files: ['inject-scripts/scraper/zhihu.js']
        },
        () => {
          if (chrome.runtime.lastError) {
            reject(new Error(`知乎脚本注入失败: ${chrome.runtime.lastError.message}`));
            return;
          }
          this.log(`知乎脚本已成功注入到标签页 ${tabId}`);
          resolve();
        }
      );
    });
  }

  /**
   * 向注入的脚本发送消息并等待结果
   */
  private async sendMessageToScript(tabId: number): Promise<ZhihuResult[]> {
    return new Promise((resolve, reject) => {
      const timeout = 30000; // 30秒超时
      const timeoutId = setTimeout(() => {
        reject(new Error('等待知乎脚本响应超时'));
      }, timeout);

      chrome.tabs.sendMessage(
        tabId,
        { action: 'scrapeZhihuResults' }, // 对应知乎注入脚本中的 action name
        (response) => {
          clearTimeout(timeoutId);

          if (chrome.runtime.lastError) {
            reject(new Error(`消息发送失败: ${chrome.runtime.lastError.message}. 可能是页面未加载完成或未响应。`));
            return;
          }

          if (!response) {
            reject(new Error('脚本未响应或页面不支持。可能需要刷新页面或检查注入脚本是否存在。'));
            return;
          }

          if (response.status === 'error') {
            reject(new Error(`脚本执行错误: ${response.message || '未知错误'}`));
            return;
          }

          if (response.status === 'success' && response.data !== undefined) {
            this.log(`成功获取到 ${response.data.length} 条知乎结果`);
            resolve(response.data as ZhihuResult[]);
            return;
          }

          reject(new Error('脚本返回无效或未知格式的数据'));
        }
      );
    });
  }
  
}
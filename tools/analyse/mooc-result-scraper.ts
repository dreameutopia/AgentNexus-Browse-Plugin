/**
 * MOOC搜索结果解析工具 (重构版 v3.0.0)
 * 使用新的注入脚本架构
 */

import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';

// 定义课程信息接口
interface MoocCourse {
  title: string;
  link: string;
  institution: string;
  instructors: string[];
  description: string;
  status: string;
  participants: string;
}

export class MoocResultScraperTool extends BaseTool {
  name = 'mooc_result_scraper';
  
  metadata: ToolMetadata = {
    name: 'mooc_result_scraper',
    description: '解析MOOC搜索结果页面，提取课程信息为JSON格式',
    category: 'analyse',
    version: '3.0.0', // 重构版
    author: 'AgentNexus',
    tags: ['mooc', 'scraper', 'course', 'search']
  }

  /**
   * 抓取MOOC搜索结果
   */
  private async scrapeResults(): Promise<MoocCourse[]> {
    const startTime = Date.now();
    this.log(`[${new Date().toISOString()}] 开始抓取MOOC搜索结果`);
    
    try {
      // 1. 获取当前标签页ID
      const tabId = await this.getCurrentTabId();
      this.log(`[${new Date().toISOString()}] 当前标签页ID: ${tabId}`);
      
      // 2. 注入MOOC抓取脚本
      await this.injectMoocScript(tabId);
      
      // 3. 发送抓取命令并等待结果
      const courses = await this.sendMessageToScript(tabId);
      
      const duration = Date.now() - startTime;
      
      this.log(`[${new Date().toISOString()}] 抓取完成，共获取 ${courses.length} 条课程，耗时: ${duration}ms`);
      
      return courses;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      this.log(`[${new Date().toISOString()}] 抓取失败，耗时: ${duration}ms`, 'error');
      throw error;
    }
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'mooc_result_scraper',
      description: '解析MOOC搜索结果页面，提取课程信息为JSON格式',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  };

  async execute(): Promise<ToolResult> {
    try {
      this.log(`[${new Date().toISOString()}] 开始执行慕课结果抓取...`);
      
      const results = await this.scrapeResults();
      
      if (!results || results.length === 0) {
        return {
          success: true,
          data: {
            results: []
          },
          content: [{
            type: 'text',
            text: '未找到任何慕课课程，请确保您在慕课搜索结果页面'
          }]
        };
      }

      const resultText = `找到 ${results.length} 门慕课课程：\n\n` +
        results.map((course, index) => 
          `${index + 1}. **${course.title}**\n` +
          `   - 链接: ${course.link}\n` +
          `   - 机构: ${course.institution}\n` +
          `   - 讲师: ${course.instructors.join(', ')}\n` +
          `   - 描述: ${course.description}\n` +
          `   - 状态: ${course.status}\n` +
          `   - 参与人数: ${course.participants}\n\n`
        ).join('');

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
          text: `抓取失败: ${errorMessage}`
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
   * 注入MOOC抓取脚本
   */
  private async injectMoocScript(tabId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          files: ['inject-scripts/scraper/mooc.js']
        },
        (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(`脚本注入失败: ${chrome.runtime.lastError.message}`));
            return;
          }
          this.log(`MOOC脚本已成功注入到标签页 ${tabId}`);
          resolve();
        }
      );
    });
  }

  /**
   * 向注入的脚本发送消息并等待结果
   */
  private async sendMessageToScript(tabId: number): Promise<MoocCourse[]> {
    return new Promise((resolve, reject) => {
      const timeout = 30000; // 30秒超时
      const timeoutId = setTimeout(() => {
        reject(new Error('等待脚本响应超时'));
      }, timeout);

      chrome.tabs.sendMessage(
        tabId,
        { action: 'scrapeMoocResults' },
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
            this.log(`成功获取到 ${response.data.length} 条MOOC课程`);
            resolve(response.data);
            return;
          }
          
          reject(new Error('脚本返回无效或未知格式的数据'));
        }
      );
    });
  }
}
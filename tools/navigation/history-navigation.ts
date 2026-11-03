/**
 * 历史导航工具
 * 提供浏览历史搜索和快速访问功能
 */

import { BaseNavigationTool } from '../base-tool';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';

export class HistoryNavigationTool extends BaseNavigationTool {
  name = 'history_navigation';
  
  metadata: ToolMetadata = {
    name: 'history_navigation',
    description: '搜索和导航到浏览历史',
    category: 'navigation',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['navigation', 'history', 'search']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'history_navigation',
      description: '搜索浏览历史并导航到指定的历史页面',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索历史的关键词'
          },
          limit: {
            type: 'number',
            description: '返回结果的最大数量',
            default: 10,
            minimum: 1,
            maximum: 50
          },
          startTime: {
            type: 'number',
            description: '搜索开始时间（Unix时间戳，毫秒）'
          },
          endTime: {
            type: 'number',
            description: '搜索结束时间（Unix时间戳，毫秒）'
          },
          autoNavigate: {
            type: 'boolean',
            description: '如果只有一个结果，是否自动导航到该页面',
            default: true
          },
          newTab: {
            type: 'boolean',
            description: '是否在现有窗口的新标签页中打开（默认 true）页面',
            default: true
          }
        },
        required: ['query']
      }
    }
  };

  async execute(args: {
    query: string;
    limit?: number;
    startTime?: number;
    endTime?: number;
    autoNavigate?: boolean;
    newTab?: boolean;
  }): Promise<ToolResult> {
    try {
      this.validateArgs(args, ['query']);
      
      const { 
        query, 
        limit = 10, 
        startTime, 
        endTime, 
        autoNavigate = true, 
        newTab = true 
      } = args;
      
      this.log(`Searching history for: "${query}"`);
      
      // 直接使用 Chrome API 搜索历史记录（工具运行在 background 上下文中）
      const historyItems = await chrome.history.search({
        text: query,
        startTime: startTime || Date.now() - 7 * 24 * 60 * 60 * 1000,
        endTime: endTime || Date.now(),
        maxResults: limit,
      });
      
      if (historyItems.length === 0) {
        return this.createSuccessResponse({
          query,
          historyItems: [],
          message: 'No history items found matching the query'
        }, `No history found for "${query}"`);
      }
      
      // 如果只有一个结果且启用自动导航，直接导航
      if (historyItems.length === 1 && autoNavigate) {
        const historyItem = historyItems[0];
        this.log(`Auto-navigating to history item: ${historyItem.title} (${historyItem.url})`);
        
        if (!historyItem.url) {
          return this.createErrorResponse(`History item "${historyItem.title}" has no URL`);
        }
        const navResult = await this.navigateToUrl(historyItem.url, { newTab });
        
        if (!navResult.success) {
          return navResult;
        }
        
        return this.createSuccessResponse({
          query,
          navigatedTo: {
            title: historyItem.title,
            url: historyItem.url,
            lastVisitTime: historyItem.lastVisitTime
          },
          totalFound: 1
        }, `Successfully navigated to history item: ${historyItem.title}`);
      }
      
      // 返回搜索结果列表
      return this.createSuccessResponse({
        query,
        historyItems: historyItems.map(item => ({
          title: item.title,
          url: item.url,
          lastVisitTime: item.lastVisitTime,
          visitCount: item.visitCount,
          typedCount: item.typedCount
        })),
        totalFound: historyItems.length,
        searchParams: {
          startTime: startTime ? new Date(startTime).toISOString() : null,
          endTime: endTime ? new Date(endTime).toISOString() : null
        },
        message: `Found ${historyItems.length} history item(s) matching "${query}"`
      }, `Found ${historyItems.length} history item(s) for "${query}"`);
      
    } catch (error) {
      return this.createErrorResponse('History navigation failed', error);
    }
  }
}
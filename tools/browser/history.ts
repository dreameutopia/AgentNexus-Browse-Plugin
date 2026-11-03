/**
 * 浏览器历史记录工具
 * 提供历史记录搜索功能
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';

/**
 * 历史记录工具
 */
export class HistoryTool extends BaseBrowserTool {
  name = 'browser_search_history';

  metadata: ToolMetadata = {
    name: 'browser_search_history',
    description: '搜索浏览器历史记录',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'history', 'search', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_search_history',
      description: '搜索浏览器历史记录',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '搜索文本'
          },
          startTime: {
            type: 'string',
            description: '开始时间（ISO 格式或相对时间，如 "1 day ago"）'
          },
          endTime: {
            type: 'string',
            description: '结束时间（ISO 格式或相对时间）'
          },
          maxResults: {
            type: 'number',
            description: '最大结果数量'
          },
          excludeCurrentTabs: {
            type: 'boolean',
            description: '是否排除当前打开的标签页'
          }
        },
        required: []
      }
    }
  };

  async execute(args: {
    text?: string;
    startTime?: string;
    endTime?: string;
    maxResults?: number;
    excludeCurrentTabs?: boolean;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const {
      text = '',
      maxResults = 100,
      excludeCurrentTabs = false,
    } = args;

    this.log(`Searching history for: ${text}`);

    try {
      const now = Date.now();
      const startTimeMs = args.startTime ? this.parseDateString(args.startTime) : now - 24 * 60 * 60 * 1000;
      const endTimeMs = args.endTime ? this.parseDateString(args.endTime) : now;

      if (startTimeMs === null || endTimeMs === null) {
        return createErrorResponse('Invalid date format');
      }

      if (startTimeMs > endTimeMs) {
        return createErrorResponse('Start time cannot be after end time');
      }

      const historyItems = await chrome.history.search({
        text,
        startTime: startTimeMs,
        endTime: endTimeMs,
        maxResults,
      });

      let filteredItems = historyItems;

      if (excludeCurrentTabs && historyItems.length > 0) {
        const currentTabs = await chrome.tabs.query({});
        const openUrls = new Set(currentTabs.map(tab => tab.url).filter(Boolean));

        filteredItems = historyItems.filter(item => !item.url || !openUrls.has(item.url));
      }

      return this.createSuccessResponse({
        items: filteredItems.map(item => ({
          id: item.id,
          url: item.url,
          title: item.title,
          lastVisitTime: item.lastVisitTime,
          visitCount: item.visitCount,
          typedCount: item.typedCount,
        })),
        totalCount: filteredItems.length,
        timeRange: {
          startTime: startTimeMs,
          endTime: endTimeMs,
          startTimeFormatted: new Date(startTimeMs).toISOString(),
          endTimeFormatted: new Date(endTimeMs).toISOString(),
        },
        query: text,
      }, `Found ${filteredItems.length} history items`);
    } catch (error) {
      return this.createErrorResponse('History search failed', error);
    }
  }

  private parseDateString(dateStr: string): number | null {
    const now = new Date();
    const lowerDateStr = dateStr.toLowerCase().trim();

    if (lowerDateStr === 'now') return now.getTime();
    if (lowerDateStr === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (lowerDateStr === 'yesterday') {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()).getTime();
    }

    const relativeMatch = lowerDateStr.match(/^(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago$/);
    if (relativeMatch) {
      const amount = parseInt(relativeMatch[1], 10);
      const unit = relativeMatch[2];
      const result = new Date(now);

      if (unit.startsWith('day')) {
        result.setDate(result.getDate() - amount);
      } else if (unit.startsWith('week')) {
        result.setDate(result.getDate() - amount * 7);
      } else if (unit.startsWith('month')) {
        result.setMonth(result.getMonth() - amount);
      } else if (unit.startsWith('year')) {
        result.setFullYear(result.getFullYear() - amount);
      }

      return result.getTime();
    }

    const parsedDate = new Date(dateStr);
    if (!isNaN(parsedDate.getTime())) {
      return parsedDate.getTime();
    }

    return null;
  }
}

// 导出工具实例
export const historyTool = new HistoryTool();

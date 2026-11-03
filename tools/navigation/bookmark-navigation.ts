/**
 * 书签导航工具
 * 提供书签搜索和快速访问功能
 */

import { BaseNavigationTool } from '../base-tool';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';

export class BookmarkNavigationTool extends BaseNavigationTool {
  name = 'bookmark_navigation';
  
  metadata: ToolMetadata = {
    name: 'bookmark_navigation',
    description: '搜索和导航到书签',
    category: 'navigation',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['navigation', 'bookmarks', 'search']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'bookmark_navigation',
      description: '搜索书签并导航到指定的书签页面',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索书签的关键词'
          },
          limit: {
            type: 'number',
            description: '返回结果的最大数量',
            default: 10,
            minimum: 1,
            maximum: 50
          },
          autoNavigate: {
            type: 'boolean',
            description: '如果只有一个结果，是否自动导航到该书签',
            default: true
          },
          newWindow: {
            type: 'boolean',
            description: '是否在新窗口中打开书签',
            default: false
          }
        },
        required: ['query']
      }
    }
  };

  async execute(args: {
    query: string;
    limit?: number;
    autoNavigate?: boolean;
    newWindow?: boolean;
  }): Promise<ToolResult> {
    try {
      this.validateArgs(args, ['query']);
      
      const { query, limit = 10, autoNavigate = true, newWindow = false } = args;
      
      this.log(`Searching bookmarks for: "${query}"`);
      
      // 直接使用 Chrome API 搜索书签（工具运行在 background 上下文中）
      const bookmarks = await chrome.bookmarks.search({ query });
      const limitedBookmarks = bookmarks.slice(0, limit);
      
      if (limitedBookmarks.length === 0) {
        return this.createSuccessResponse({
          query,
          bookmarks: [],
          message: 'No bookmarks found matching the query'
        }, `No bookmarks found for "${query}"`);
      }
      
      // 如果只有一个结果且启用自动导航，直接导航
      if (limitedBookmarks.length === 1 && autoNavigate) {
        const bookmark = limitedBookmarks[0];
        this.log(`Auto-navigating to bookmark: ${bookmark.title} (${bookmark.url})`);
        
        if (!bookmark.url) {
          return this.createErrorResponse(`Bookmark "${bookmark.title}" has no URL`);
        }
        const navResult = await this.navigateToUrl(bookmark.url, { newWindow });
        
        if (!navResult.success) {
          return navResult;
        }
        
        return this.createSuccessResponse({
          query,
          navigatedTo: {
            title: bookmark.title,
            url: bookmark.url
          },
          totalFound: 1
        }, `Successfully navigated to bookmark: ${bookmark.title}`);
      }
      
      // 返回搜索结果列表
      return this.createSuccessResponse({
        query,
        bookmarks: limitedBookmarks.map(bookmark => ({
          title: bookmark.title,
          url: bookmark.url,
          dateAdded: bookmark.dateAdded
        })),
        totalFound: limitedBookmarks.length,
        message: `Found ${limitedBookmarks.length} bookmark(s) matching "${query}"`
      }, `Found ${limitedBookmarks.length} bookmark(s) for "${query}"`);
      
    } catch (error) {
      return this.createErrorResponse('Bookmark navigation failed', error);
    }
  }
}
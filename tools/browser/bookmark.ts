/**
 * 书签管理工具
 * 提供书签搜索、添加、删除功能
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';

/**
 * 书签搜索工具
 */
export class BookmarkSearchTool extends BaseBrowserTool {
  name = 'browser_search_bookmarks';

  metadata: ToolMetadata = {
    name: 'browser_search_bookmarks',
    description: '搜索浏览器书签',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'bookmark', 'search', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_search_bookmarks',
      description: '搜索浏览器书签',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词'
          },
          maxResults: {
            type: 'number',
            description: '最大结果数量'
          }
        },
        required: []
      }
    }
  };

  async execute(args: {
    query?: string;
    maxResults?: number;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const { query = '', maxResults = 100 } = args;

    this.log(`Searching bookmarks for: ${query}`);

    try {
      const bookmarks = await chrome.bookmarks.search(query ? { query } : {});
      const results = bookmarks
        .filter(b => b.url) // 只包含实际的书签（不是文件夹）
        .slice(0, maxResults)
        .map(b => ({
          id: b.id,
          title: b.title,
          url: b.url,
          dateAdded: b.dateAdded,
        }));

      return this.createSuccessResponse({
        results,
        totalCount: results.length,
        query,
      }, `Found ${results.length} bookmarks`);
    } catch (error) {
      return this.createErrorResponse('Bookmark search failed', error);
    }
  }
}

/**
 * 书签添加工具
 */
export class BookmarkAddTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.BOOKMARK_CREATE;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.BOOKMARK_CREATE,
    description: '添加书签',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'bookmark', 'add', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.BOOKMARK_CREATE,
      description: '添加书签',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '书签 URL（可选，默认当前页面）'
          },
          title: {
            type: 'string',
            description: '书签标题（可选，默认页面标题）'
          },
          parentId: {
            type: 'string',
            description: '父文件夹 ID（可选）'
          }
        },
        required: []
      }
    }
  };

  async execute(args: {
    url?: string;
    title?: string;
    parentId?: string;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const { url, title, parentId } = args;

    this.log('Adding bookmark');

    try {
      let bookmarkUrl = url;
      let bookmarkTitle = title;

      if (!bookmarkUrl || !bookmarkTitle) {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab) {
          return createErrorResponse('No active tab found and no URL provided');
        }
        bookmarkUrl = bookmarkUrl || activeTab.url;
        bookmarkTitle = bookmarkTitle || activeTab.title;
      }

      if (!bookmarkUrl) {
        return createErrorResponse('URL is required');
      }

      const bookmark = await chrome.bookmarks.create({
        parentId: parentId || '1', // 默认添加到书签栏
        title: bookmarkTitle || bookmarkUrl,
        url: bookmarkUrl,
      });

      return this.createSuccessResponse({
        id: bookmark.id,
        title: bookmark.title,
        url: bookmark.url,
      }, `Bookmark added: ${bookmark.title}`);
    } catch (error) {
      return this.createErrorResponse('Failed to add bookmark', error);
    }
  }
}

/**
 * 书签删除工具
 */
export class BookmarkDeleteTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.BOOKMARK_DELETE;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.BOOKMARK_DELETE,
    description: '删除书签',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'bookmark', 'delete', 'chrome']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.BOOKMARK_DELETE,
      description: '删除书签',
      parameters: {
        type: 'object',
        properties: {
          bookmarkId: {
            type: 'string',
            description: '书签 ID'
          },
          url: {
            type: 'string',
            description: '书签 URL（如果未提供 ID）'
          }
        },
        required: []
      }
    }
  };

  async execute(args: {
    bookmarkId?: string;
    url?: string;
  }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const { bookmarkId, url } = args;

    this.log('Deleting bookmark');

    try {
      if (bookmarkId) {
        await chrome.bookmarks.remove(bookmarkId);
        return this.createSuccessResponse({
          deletedId: bookmarkId,
        }, 'Bookmark deleted successfully');
      } else if (url) {
        const bookmarks = await chrome.bookmarks.search({ url });
        if (bookmarks.length === 0) {
          return createErrorResponse(`No bookmark found with URL: ${url}`);
        }

        const deleteIds = [];
        for (const bookmark of bookmarks) {
          await chrome.bookmarks.remove(bookmark.id);
          deleteIds.push(bookmark.id);
        }

        return this.createSuccessResponse({
          deletedIds: deleteIds,
          deletedCount: deleteIds.length,
        }, `Deleted ${deleteIds.length} bookmark(s)`);
      } else {
        return createErrorResponse('Either bookmarkId or url is required');
      }
    } catch (error) {
      return this.createErrorResponse('Failed to delete bookmark', error);
    }
  }
}

// 导出工具实例
export const bookmarkSearchTool = new BookmarkSearchTool();
export const bookmarkAddTool = new BookmarkAddTool();
export const bookmarkDeleteTool = new BookmarkDeleteTool();

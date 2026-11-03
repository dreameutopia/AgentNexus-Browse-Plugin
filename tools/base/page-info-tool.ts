import { textContentPayload } from '../browser/text-content-payload';
/**
 * 页面信息工具
 * 提供获取当前页面文本、HTML、基本信息等功能
 */

import { BaseBrowserTool } from './browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';

/**
 * 获取页面文本工具
 */
export class GetPageTextTool extends BaseBrowserTool {
  name = 'browser_get_page_text';

  metadata: ToolMetadata = {
    name: 'browser_get_page_text',
    description: '获取当前页面的文本内容',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'content', 'text']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_get_page_text',
      description: '获取当前页面的可见文本内容',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '标签页 ID（可选，默认当前活动标签页）'
          }
        },
        required: []
      }
    }
  };

  async execute(args: { tabId?: number } = {}): Promise<ToolResult> {
    this.ensureBackgroundContext();

    try {
      const tab = typeof args?.tabId === 'number'
        ? await chrome.tabs.get(args.tabId)
        : await this.getActiveTab();

      if (!tab || typeof tab.id !== 'number') {
        return this.createErrorResponse('No active tab found');
      }

      const results = await chrome.scripting.executeScript({
        target:{tabId:tab.id,allFrames:true},world:'ISOLATED',func:textContentPayload,args:[12000],
      });
      const frames=results.filter(r=>r.result).map(r=>({frameId:r.frameId,...r.result}));
      const joined=frames.map(frame=>'[FrameId='+frame.frameId+']\n'+frame.text).join('\n');
      const textContent=joined.slice(0,24000);
      return this.createSuccessResponse({
        textContent,url:tab.url,title:tab.title,tabId:tab.id,length:textContent.length,
        coverage:{complete:false,frames:frames.map(({text,...frame})=>frame),truncated:joined.length>24000||frames.some(f=>f.truncated),missingResults:results.length-frames.length},
        hint:'仅 DOM 可见文本，含可注入 frame 和可访问 shadow roots；画布/未加载数据不保证覆盖。不足时用 browser_observe 的 structure/accessibility 或指定 frame 的脚本。',
      }, 'Page text retrieved successfully');
    } catch (error) {
      return this.createErrorResponse('Failed to get page text', error);
    }
  }
}

/**
 * 获取页面 HTML 工具
 */
export class GetPageHTMLTool extends BaseBrowserTool {
  name = 'browser_get_page_html';

  metadata: ToolMetadata = {
    name: 'browser_get_page_html',
    description: '获取当前页面的 HTML 源码',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'content', 'html']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_get_page_html',
      description: '获取当前页面的 HTML 源码',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '标签页 ID（可选，默认当前活动标签页）'
          }
        },
        required: []
      }
    }
  };

  async execute(args: { tabId?: number } = {}): Promise<ToolResult> {
    this.ensureBackgroundContext();

    try {
      const tab = typeof args?.tabId === 'number'
        ? await chrome.tabs.get(args.tabId)
        : await this.getActiveTab();

      if (!tab || typeof tab.id !== 'number') {
        return this.createErrorResponse('No active tab found');
      }

      // 执行脚本获取页面 HTML
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          return document.documentElement.outerHTML;
        }
      });

      const htmlContent = results?.[0]?.result || '';

      return this.createSuccessResponse({
        htmlContent,
        url: tab.url,
        title: tab.title,
        tabId: tab.id,
        length: htmlContent.length
      }, 'Page HTML retrieved successfully');
    } catch (error) {
      return this.createErrorResponse('Failed to get page HTML', error);
    }
  }
}

/**
 * 获取当前页面信息工具
 */
export class GetCurrentPageInfoTool extends BaseBrowserTool {
  name = 'browser_get_page_info';

  metadata: ToolMetadata = {
    name: 'browser_get_page_info',
    description: '获取当前页面的基本信息',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'info', 'page']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_get_page_info',
      description: '获取当前页面的基本信息（URL、标题、加载状态等）',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '标签页 ID（可选，默认当前活动标签页）'
          }
        },
        required: []
      }
    }
  };

  async execute(args: { tabId?: number } = {}): Promise<ToolResult> {
    this.ensureBackgroundContext();

    try {
      const tab = typeof args?.tabId === 'number'
        ? await chrome.tabs.get(args.tabId)
        : await this.getActiveTab();

      if (!tab || typeof tab.id !== 'number') {
        return this.createErrorResponse('No active tab found');
      }

      // 获取页面加载状态和其他信息
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          return {
            readyState: document.readyState,
            title: document.title,
            url: document.URL,
            referrer: document.referrer,
            lastModified: document.lastModified,
            characterSet: document.characterSet,
            contentType: document.contentType,
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
            visibleWidth: window.innerWidth,
            visibleHeight: window.innerHeight
          };
        }
      });

      const pageDetails = results?.[0]?.result || {};

      return this.createSuccessResponse({
        ...pageDetails,
        tabId: tab.id,
        windowId: tab.windowId,
        active: tab.active,
        status: tab.status,
        incognito: tab.incognito,
        pinned: tab.pinned,
        audible: tab.audible,
        mutedInfo: tab.mutedInfo
      }, 'Page info retrieved successfully');
    } catch (error) {
      return this.createErrorResponse('Failed to get page info', error);
    }
  }
}

/**
 * 获取所有标签页工具
 */
export class GetAllTabsTool extends BaseBrowserTool {
  name = 'browser_get_all_tabs';

  metadata: ToolMetadata = {
    name: 'browser_get_all_tabs',
    description: '获取所有打开的标签页信息',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'tabs', 'info']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_get_all_tabs',
      description: '获取所有打开的标签页信息',
      parameters: {
        type: 'object',
        properties: {
          currentWindow: {
            type: 'boolean',
            description: '是否只获取当前窗口的标签页（可选，默认所有窗口）'
          }
        },
        required: []
      }
    }
  };

  async execute(args: { currentWindow?: boolean }): Promise<ToolResult> {
    this.ensureBackgroundContext();

    try {
      const tabs = await chrome.tabs.query(
        args.currentWindow ? { currentWindow: true } : {}
      );

      const tabsInfo = tabs.map(tab => ({
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        status: tab.status,
        index: tab.index,
        pinned: tab.pinned,
        audible: tab.audible,
        incognito: tab.incognito
      }));

      return this.createSuccessResponse({
        count: tabsInfo.length,
        tabs: tabsInfo
      }, `Found ${tabsInfo.length} tabs`);
    } catch (error) {
      return this.createErrorResponse('Failed to get tabs', error);
    }
  }
}

// 导出工具实例
export const getPageTextTool = new GetPageTextTool();
export const getPageHTMLTool = new GetPageHTMLTool();
export const getCurrentPageInfoTool = new GetCurrentPageInfoTool();
export const getAllTabsTool = new GetAllTabsTool();

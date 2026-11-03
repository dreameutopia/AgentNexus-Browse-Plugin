import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { getSourcePayload } from '@/inject-scripts/core/get-source-payload';
export interface PageSourceParams {
  includeIframes?: boolean;
  format?: 'html' | 'text';
}

export class PageSourceTool extends BaseTool {
  name = 'page-source';
  
  metadata: ToolMetadata = {
    name: 'page-source',
    description: '获取页面源代码工具，支持获取当前页面的完整HTML源码，包括跨域iframe内容',
    category: 'base',
    version: '1.0.0',
    author: 'Chrome Extension',
    tags: ['source', 'html', 'iframe', 'page']
  };
  
  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'page-source',
      description: '获取页面源代码工具，支持获取当前页面的完整HTML源码，包括跨域iframe内容',
      parameters: {
        type: 'object',
        properties: {
          includeIframes: {
            type: 'boolean',
            description: '是否包含iframe内容，默认为true',
            default: true
          },
          format: {
            type: 'string',
            enum: ['html', 'text'],
            description: '返回格式：html（HTML源码）或text（纯文本），默认为html',
            default: 'html'
          }
        },
        required: []
      }
    }
  };

  async execute(params: PageSourceParams = {}): Promise<ToolResult> {
    try {
      const { includeIframes = true, format = 'html' } = params;
      
      // 获取当前活动标签页
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        return this.createErrorResponse('No active tab found');
      }

      const tab = tabs[0];
      if (!tab.id) {
        return this.createErrorResponse('Tab ID not found');
      }

      this.log(`Getting page source for: ${tab.url}`);

      // 注入脚本获取页面源码
      const injectionResults = await chrome.scripting.executeScript({
        target: {
          tabId: tab.id,
          allFrames: true, // 注入到所有 frames，包括跨域的
        },
        func: getSourcePayload, // 将 getSourcePayload 函数注入
      });
     

      let fullSource = '';
      for (const frameResult of injectionResults) {
        // 主 frame (frameId: 0) 的源码放在最前面
        if (frameResult.frameId === 0) {
          fullSource = frameResult.result + '\n\n' + fullSource;
        } else {
          fullSource += `\n`;
          fullSource += frameResult.result + '\n\n';
        }
      }

      this.log(fullSource)

      return this.createSuccessResponse({
        mainSource: fullSource,
        url: tab.url,
        title: tab.title,
        format,
        includeIframes
      }, `Successfully retrieved page source `);

    } catch (error) {
      return this.createErrorResponse('Failed to get page source', error);
    }
  }

  /**
   * 注入到页面中执行的脚本，获取页面源码
   */
  private getPageSourceScript(format: string, includeIframes: boolean): string {
    try {
      if (format === 'text') {
        // 返回纯文本内容
        return document.body ? document.body.innerText || document.body.textContent || '' : '';
      } else {
        // 返回HTML源码
        return document.documentElement.outerHTML;
      }
    } catch (error) {
      console.error('Error getting page source:', error);
      return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
}

export const pageSourceTool = new PageSourceTool();
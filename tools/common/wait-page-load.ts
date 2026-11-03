import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

export class WaitPageLoadTool extends BaseTool {
  name = 'wait_page_load';
  
  metadata: ToolMetadata = {
    name: 'wait_page_load',
    description: '等待页面完全加载完成',
    category: 'common',
    version: '1.0.0',
    author: 'Chrome Extension',
    tags: ['utility', 'wait', 'page-load']
  };
  
  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'wait_page_load',
      description: '等待页面完全加载完成',
      parameters: {
        type: 'object',
        properties: {
          timeout: {
            type: 'number',
            description: '超时时间（秒），默认30秒',
            default: 30,
            minimum: 1
          },
          checkInterval: {
            type: 'number',
            description: '检查间隔（秒），默认1秒',
            default: 1,
            minimum: 0.1
          }
        },
        required: []
      }
    }
  };

  async execute(): Promise<ToolResult> {
    const maxAttempts = 10;
    const intervalMs = 1000; // 1秒间隔
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // 直接使用 Chrome API 获取页面信息（工具运行在 background 上下文中）
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const pageInfo = tab ? {
          url: tab.url,
          title: tab.title,
          tabId: tab.id,
          loading: tab.status !== 'complete',
        } : null;
        
        // 检查页面是否完全加载
        if (pageInfo && !pageInfo.loading) {
          return {
            success: true,
            message: `页面已完全加载 (第${attempt}次检查)`,
            data: pageInfo
          };
        }
        
        // 如果不是最后一次尝试，等待1秒后继续
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
      } catch (error) {
        console.error(`第${attempt}次检查页面状态时出错:`, error);
        
        // 如果是最后一次尝试，返回错误
        if (attempt === maxAttempts) {
          return {
            success: false,
            message: `检查页面状态时出错: ${error instanceof Error ? error.message : String(error)}`
          };
        }
        
        // 等待后继续尝试
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
    
    return {
      success: false,
      message: `页面在${maxAttempts}次检查后仍然在加载中`
    };
  }
}

export const waitPageLoadTool = new WaitPageLoadTool();
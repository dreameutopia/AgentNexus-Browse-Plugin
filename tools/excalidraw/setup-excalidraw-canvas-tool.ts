/**
 * Excalidraw画布初始化工具 (Final Production Version)
 */
import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { waitPageLoadTool } from '../common/wait-page-load';

export class SetupExcalidrawCanvasTool extends BaseTool {
  name = 'setup_excalidraw_canvas';
  
  metadata: ToolMetadata = {
    name: 'setup_excalidraw_canvas',
    description: '初始化Excalidraw画布环境。在一个新的绘图会话开始时, 必须先调用此工具来创建全新的绘图环境，并等待控制脚本完全就绪。',
    category: 'excalidraw',
    version: 'Final',
    author: 'AgentNexus',
    tags: ['excalidraw', 'canvas', 'setup', 'initialization']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'setup_excalidraw_canvas',
      description: '初始化Excalidraw画布环境。在一个新的绘图会话开始时, 必须先调用此工具(reset=true)来注入控制脚本并准备画布。',
      parameters: {
        type: 'object',
        properties: {
          reset: {
            type: 'boolean',
            description: '是否重置画布环境，true表示关闭现有标签页并创建新的画布。为了保证环境干净，应始终使用true。',
            default: true
          }
        },
        required: ['reset']
      }
    }
  };

  private _sendMessageToTab<T>(tabId: number, message: any): Promise<T> {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message } as T);
        } else {
          resolve(response);
        }
      });
    });
  }

  private async _waitForScriptReady(tabId: number, maxAttempts: number = 20): Promise<boolean> {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          console.log(`正在确认脚本就绪状态... 尝试次数: ${attempt}`);
          // 使用桥接协议，向 MAIN 世界发送一个 getSceneElements 探测请求
          const response = await this._sendMessageToTab<{ data?: any; error?: string }>(tabId, { 
            action: 'getSceneElements', 
            // excalidraw.js 期望 payload 是字符串化的 JSON
            payload: '{}',
            targetWorld: 'MAIN'
          });
          if (response && !('error' in response) && response?.data !== undefined) {
              console.log('✅ 主世界控制脚本已就绪!');
              return true;
          }
          await new Promise(resolve => setTimeout(resolve, 1000)); 
      }
      return false;
  }

  async execute(params: { reset: boolean }): Promise<ToolResult> {
    try {
      console.log('开始初始化Excalidraw画布...', params);

      if (params.reset) {
        // 直接使用 Chrome API 关闭已有的 Excalidraw 标签页
        const allTabs = await chrome.tabs.query({});
        const excalidrawTabs = allTabs.filter((tab) => tab.url && tab.url.includes('excalidraw.com'));
        for (const tab of excalidrawTabs) {
          if (tab.id) {
            await chrome.tabs.remove(tab.id).catch(e => console.warn(`关闭标签页 ${tab.id} 失败:`, e));
          }
        }
      }

      // 直接使用 Chrome API 创建新标签页
      const newTab = await chrome.tabs.create({ url: 'https://excalidraw.com/', active: true });
      if (!newTab?.id) {
        return { success: false, error: '导航到Excalidraw失败: 未能获取新标签页ID' };
      }
      const targetTabId = newTab.id;
      console.log(`已导航至新的标签页: ${targetTabId}`);

      // 4. 等待页面加载完成
      this.log(`[${new Date().toISOString()}] 等待页面加载完成...`);
      const waitResult = await waitPageLoadTool.execute();
      if (!waitResult.success) {
        this.log(`[${new Date().toISOString()}] 页面加载等待失败: ${waitResult.message}`, 'warn');
        // 即使等待失败，也继续执行后续逻辑
      } else {
        this.log(`[${new Date().toISOString()}] 页面加载完成`);
      }
      
      // 注入通用桥接脚本至隔离世界
      this.log('正在注入通用桥接脚本 (core/inject-bridge.js)...');
      await new Promise<void>((resolve, reject) => {
        chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          files: ['inject-scripts/core/inject-bridge.js'],
          world: 'ISOLATED'
        }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(`桥接脚本注入失败: ${chrome.runtime.lastError.message}`));
          } else {
            resolve();
          }
        });
      });

      // 注入主世界控制脚本
      this.log('正在注入Excalidraw主世界控制脚本 (ui/excalidraw.js)...');
      await new Promise<void>((resolve, reject) => {
        chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          files: ['inject-scripts/ui/excalidraw.js'],
          world: 'MAIN'
        }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(`控制脚本注入失败: ${chrome.runtime.lastError.message}`));
          } else {
            resolve();
          }
        });
      });
      this.log('脚本注入命令已发送。');

      const isReady = await this._waitForScriptReady(targetTabId);
      if (!isReady) {
          return { success: false, error: '注入的脚本在20秒内未能成功初始化或找到API。页面可能加载缓慢或存在问题。' };
      }

      this.log('✅ Excalidraw画布初始化完成且脚本已就绪!');
      return {
        success: true,
        data: { message: 'Excalidraw画布环境初始化成功，已注入控制脚本并确认就绪，可以开始绘图操作。' }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`Excalidraw画布初始化失败: ${errorMessage}`, 'error');
      return { success: false, error: `Excalidraw画布初始化失败: ${errorMessage}` };
    }
  }
}

/**
 * Excalidraw 绘图工具 (vFinal - Blueprint Architecture)
 * 采用单一、自包含的工具模式，严格遵循经过验证的成功范例。
 */
import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

// Excalidraw元素骨架接口
interface ExcalidrawElementSkeleton {
  id?: string;
  type: 'rectangle' | 'ellipse' | 'diamond' | 'text' | 'arrow' | 'line' | 'frame';
  x: number;
  y: number;
  width: number;
  height: number;
  // ... (所有其他可选属性)
  [key: string]: any;
}

export class ExcalidrawTool extends BaseTool {
  name = 'excalidraw_tool';
  
  metadata: ToolMetadata = {
    name: 'excalidraw_tool',
    description: '在Excalidraw白板上执行一系列绘图指令。如果需要，会自动准备一个干净的绘图环境。',
    category: 'excalidraw',
    version: 'Final-Blueprint',
    author: 'AgentNexus',
    tags: ['excalidraw', 'draw', 'whiteboard', 'diagram']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'excalidraw_tool',
      description: '在Excalidraw白板上执行绘图操作，支持元素创建、修改、删除和关系建立。所有操作都在一次调用中完成。',
      parameters: {
        type: 'object',
        properties: {
          reset_environment: {
            type: 'boolean',
            description: '是否需要一个全新的、干净的白板。设置为true会关闭所有已有的Excalidraw标签页，并打开一个全新的页面。默认为false。',
          },
          cleanup: {
            type: 'boolean',
            description: '是否清空当前画布。如果reset_environment为true，则此项无效，因为总会得到一个干净的画布。',
          },
          add_elements: {
            type: 'array',
            description: '要添加到画布的元素骨架数组。',
            items: { type: 'object' }
          },
          update_elements: {
            type: 'array',
            description: '要更新的元素数组，每个对象必须包含id和要更新的属性。',
            items: { type: 'object' }
          },
          delete_element_id: {
            type: 'string',
            description: '要删除的单个元素的ID。'
          },
          get_scene: {
            type: 'boolean',
            description: '操作完成后，是否获取并返回当前画布上的所有元素。',
          }
        }
      }
    }
  };
  
  private async _getOrCreateTab(shouldReset: boolean): Promise<number> {
    const excalidrawUrl = 'https://excalidraw.com/';
    if (shouldReset) {
      this.log("正在重置环境：关闭所有已有的Excalidraw标签页...");
      const allTabs = await chrome.tabs.query({});
      const excalidrawTabs = allTabs.filter(tab => tab.url?.startsWith(excalidrawUrl));
      for (const tab of excalidrawTabs) {
        if (tab.id) await chrome.tabs.remove(tab.id);
      }
    } else {
        const existingTabs = await chrome.tabs.query({ url: `${excalidrawUrl}*` });
        if (existingTabs.length > 0 && existingTabs[0].id) {
            this.log(`发现已存在的Excalidraw标签页: ${existingTabs[0].id}，将在此页面操作。`);
            await chrome.tabs.update(existingTabs[0].id, { active: true });
            return existingTabs[0].id;
        }
    }
    this.log("正在创建新的Excalidraw标签页...");
    const newTab = await chrome.tabs.create({ url: excalidrawUrl, active: true });
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error("标签页加载超时(15秒)"));
        }, 15000);
        const listener = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
            if (tabId === newTab.id && changeInfo.status === 'complete') {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
    });
    this.log(`新标签页 ${newTab.id} 已加载完成。`);
    return newTab.id!;
  }

  // 等待页面完全加载并注入脚本 (桥接 + 主世界处理器)
  private async waitForPageAndInjectScript(tabId: number, timeout: number = 30000): Promise<void> {
    const pollInterval = 500;
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const poll = async () => {
        if (Date.now() - startTime > timeout) {
          return reject(new Error('等待页面加载超时'));
        }
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === 'complete' && tab.url?.includes('excalidraw.com')) {
            this.log(`页面加载完成，注入桥接脚本...`);
            // 1) 注入通用桥接脚本到隔离世界 (用于与主世界通讯)
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ['inject-scripts/core/inject-bridge.js'],
              world: 'ISOLATED',
            });

            this.log(`桥接脚本注入成功，注入主世界控制脚本(ui/excalidraw.js)...`);
            // 2) 在主世界注入 Excalidraw 控制脚本
            await new Promise<void>((res, rej) => {
              chrome.scripting.executeScript({
                target: { tabId },
                files: ['inject-scripts/ui/excalidraw.js'],
                // 强制在主世界注入以访问页面API
                world: 'MAIN',
              }, () => {
                if (chrome.runtime.lastError) {
                  return rej(new Error(`脚本注入失败: ${chrome.runtime.lastError.message}`));
                }
                res();
              });
            });

            this.log(`主世界控制脚本注入成功`);
            // 等待一小段时间，确保监听器已准备就绪
            await new Promise((r) => setTimeout(r, 300));
            resolve();
          } else {
            setTimeout(poll, pollInterval);
          }
        } catch (error) {
          reject(error);
        }
      };
      poll();
    });
  }

  private async _sendMessage(tabId: number, eventName: string, payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = 30000;
      const timeoutId = setTimeout(() => {
        reject(new Error(`等待脚本响应超时 (${timeout}ms) for event: ${eventName}`));
      }, timeout);
      
      // 通过通用桥接发送到主世界
      const serialized = payload ? JSON.stringify(payload) : '{}';
      chrome.tabs.sendMessage(tabId, { action: eventName, payload: serialized, targetWorld: 'MAIN' }, (response) => {
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          return reject(new Error(`消息发送失败: ${chrome.runtime.lastError.message}`));
        }
        if (!response) {
          return reject(new Error('脚本未响应。可能页面不支持或需要刷新。'));
        }
        // 优先处理桥接格式 { data, error }
        if ('data' in response || 'error' in response) {
          if (response.error) {
            return reject(new Error(`脚本执行错误: ${response.error}`));
          }
          return resolve(response.data);
        }
        // 兼容旧格式 { status: 'success' | 'error', data?, message? }
        if (response.status === 'error') {
          return reject(new Error(`脚本执行错误: ${response.message || '未知错误'}`));
        }
        if (response.status === 'success') {
          return resolve(response.data);
        }
        return reject(new Error('脚本返回无效或未知格式的数据'));
      });
    });
  }

  async execute(params: any): Promise<ToolResult> {
    try {
      this.log(`Executing Excalidraw command...`, params);
      
      const tabId = await this._getOrCreateTab(!!params.reset_environment);
      // 等待页面加载并注入桥接与主世界控制脚本
      await this.waitForPageAndInjectScript(tabId);

      const operations = [] as Array<{ eventName: string; payload?: any }>;
      if (params.cleanup || params.reset_environment) operations.push({ eventName: 'cleanup' });
      if (params.add_elements) operations.push({ eventName: 'addElement', payload: { eles: params.add_elements } });
      if (params.update_elements) operations.push({ eventName: 'updateElement', payload: params.update_elements });
      if (params.delete_element_id) operations.push({ eventName: 'deleteElement', payload: { id: params.delete_element_id } });
      
      const finalResult: any = { operations: [] };
      
      for(const op of operations) {
          this.log(`Sending command: ${op.eventName}...`);
          const result = await this._sendMessage(tabId, op.eventName, op.payload);
          finalResult.operations.push({ command: op.eventName, result });
      }

      if (params.get_scene) {
          this.log(`Sending command: getSceneElements...`);
          finalResult.sceneElements = await this._sendMessage(tabId, 'getSceneElements', {});
      }

      return { 
        success: true, 
        data: finalResult,
        content: [{ type: 'text', text: `Excalidraw 操作成功完成。` }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`Excalidraw tool failed: ${errorMessage}`, 'error');
      return { 
          success: false, 
          error: errorMessage,
          content: [{ type: 'text', text: `Excalidraw 操作失败: ${errorMessage}`}] }
    }
  }
}

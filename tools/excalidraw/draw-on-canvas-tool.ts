import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

interface DrawAction {
  type: 'add' | 'contain' | 'bind' | 'group' | 'frame';
  payload: any;
}

export class DrawOnCanvasTool extends BaseTool {
  name = 'draw_on_canvas';
  
  metadata: ToolMetadata = {
    name: 'draw_on_canvas',
    description: '在已初始化的画布上，以批处理方式执行一系列绘图指令。用于高效地添加元素、创建关系（连接、容纳）和组织图表结构。',
    category: 'excalidraw',
    version: 'Final',
    author: 'AgentNexus',
    tags: ['excalidraw', 'draw', 'canvas', 'batch']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'draw_on_canvas',
      description: '在已初始化的画布上，以批处理方式执行一系列绘图指令。用于高效地添加元素、创建关系（连接、容纳）和组织图表结构。',
      parameters: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            description: '一个按顺序执行的绘图指令对象数组。',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['add', 'contain', 'bind', 'group', 'frame']
                },
                payload: { type: 'object' }
              },
              required: ['type', 'payload']
            }
          }
        },
        required: ['actions']
      }
    }
  };

  private async _sendViaBridge<T = any>(tabId: number, action: string, payload?: any): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const serialized = payload ? JSON.stringify(payload) : '{}';
      chrome.tabs.sendMessage(tabId, { action, payload: serialized, targetWorld: 'MAIN' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(`向主世界脚本发送消息失败: ${chrome.runtime.lastError.message}`));
          return;
        }
        if (!response) {
          reject(new Error('主世界脚本未响应，可能未注入或页面不支持。'));
          return;
        }
        if ('error' in response && response.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response.data as T);
      });
    });
  }

  private async _sendCommandsToScript(actions: DrawAction[]): Promise<any> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]?.id) {
      throw new Error('无法获取当前活动标签页');
    }
    const tabId = tabs[0].id;

    // 健康检查：通过桥接调用 getSceneElements 确认主世界控制脚本已就绪
    this.log('正在检查控制脚本就绪状态...');
    try {
      await this._sendViaBridge(tabId, 'getSceneElements', {});
    } catch (_err) {
      throw new Error('Excalidraw控制脚本未就绪或未注入。请先调用初始化工具。');
    }
    this.log('控制脚本已就绪。');

    // 逐条执行，目前仅支持 add 指令，其它类型暂不支持（excalidraw-draw.js 已移除）
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (action.type !== 'add') {
        throw new Error(`第 ${i + 1} 个指令类型为 "${action.type}"，当前版本不再支持。请仅使用 'add' 指令，或改用 excalidraw_tool。`);
      }
      // 归一化 add 指令的元素数组
      const eles = Array.isArray(action.payload?.eles)
        ? action.payload.eles
        : Array.isArray(action.payload)
          ? action.payload
          : [action.payload];
      if (!eles || eles.length === 0) {
        throw new Error(`第 ${i + 1} 个 add 指令缺少有效的元素数据`);
      }
      await this._sendViaBridge(tabId, 'addElement', { eles });
    }

    return { message: `成功执行 ${actions.length} 个指令` };
  }
  
  private validateActions(actions: DrawAction[]): { valid: boolean; error?: string } {
    if (!Array.isArray(actions)) {
        return { valid: false, error: 'actions必须是一个数组' };
    }
    if (actions.length === 0) {
        return { valid: false, error: 'actions数组不能为空' };
    }
    const validTypes = ['add', 'contain', 'bind', 'group', 'frame'];
    for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        if (!action.type || !validTypes.includes(action.type)) {
            return { valid: false, error: `第${i + 1}个指令的type无效，必须是: ${validTypes.join(', ')}` };
        }
        if (!action.payload || typeof action.payload !== 'object') {
            return { valid: false, error: `第${i + 1}个指令的payload必须是一个对象` };
        }
    }
    return { valid: true };
  }

  async execute(params: { actions: DrawAction[] }): Promise<ToolResult> {
    try {
      this.log(`开始执行画布绘图... (${params.actions.length} 条指令)`, 'info');

      if (!params.actions) {
        return { success: false, error: '缺少必需的actions参数' };
      }

      const validation = this.validateActions(params.actions);
      if (!validation.valid) {
        return { success: false, error: `绘图指令验证失败: ${validation.error}` };
      }

      const drawResult = await this._sendCommandsToScript(params.actions);
      
      this.log('批量绘图执行成功', drawResult);
      return {
        success: true,
        data: {
          message: drawResult.message || `成功执行 ${params.actions.length} 个绘图指令`,
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`画布绘图执行失败: ${errorMessage}`, 'error');
      return {
        success: false,
        error: `画布绘图失败: ${errorMessage}`
      };
    }
  }
}

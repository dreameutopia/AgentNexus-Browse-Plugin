import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';

export interface VideoControlData {
  action?: string;
  currentTime?: number;
  formattedTime?: string;
  duration?: number;
  formattedDuration?: string;
  paused?: boolean;
  playbackRate?: number;
  volume?: number;
  muted?: boolean;
}

export class BilibiliJumpTool extends BaseTool {
  name = 'bilibili_jump_tool';
  
  metadata: ToolMetadata = {
    name: 'bilibili_jump_tool',
    displayName: 'B站视频控制',
    description: '控制B站视频播放，包括跳转、播放/暂停、调速等功能',
    category: 'bilibili',
    author: 'System',
    version: '1.0.0',
    tags: ['bilibili', 'video', 'control', 'jump'],
    permissions: ['tabs', 'activeTab'],
    supportedSites: ['bilibili.com']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'bilibili_jump_tool',
      description: '控制B站视频播放，支持跳转到指定时间、播放控制、调速等功能',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'jumpToTime',
              'getStatus',
              'play',
              'pause',
              'togglePlayPause',
              'fastForward',
              'rewind',
              'setSpeed',
              'setVolume',
              'toggleMute'
            ],
            description: '要执行的操作类型',
            default: 'jumpToTime'
          },
          time: {
            type: 'string',
            description: '跳转时间，支持格式：秒数(如"120")、MM:SS(如"2:30")、HH:MM:SS(如"1:30:45")，仅在action为jumpToTime时使用'
          },
          seconds: {
            type: 'number',
            description: '快进/快退的秒数，默认10秒，仅在action为fastForward或rewind时使用',
            default: 10
          },
          speed: {
            type: 'number',
            description: '播放速度，范围0.1-4.0，默认1.0，仅在action为setSpeed时使用',
            minimum: 0.1,
            maximum: 4.0,
            default: 1.0
          },
          volume: {
            type: 'number',
            description: '音量大小，范围0.0-1.0，默认1.0，仅在action为setVolume时使用',
            minimum: 0.0,
            maximum: 1.0,
            default: 1.0
          }
        },
        required: ['action']
      }
    }
  };

  private async _getOrCreateBilibiliTab(): Promise<chrome.tabs.Tab> {
    // 查找现有的B站标签页
    const tabs = await chrome.tabs.query({ url: '*://*.bilibili.com/*' });
    
    if (tabs.length > 0) {
      // 使用第一个找到的B站标签页
      const tab = tabs[0];
      if (tab.id) {
        await chrome.tabs.update(tab.id, { active: true });
        return tab;
      }
    }
    
    // 如果没有找到B站标签页，创建一个新的
    const newTab = await chrome.tabs.create({
      url: 'https://www.bilibili.com',
      active: true
    });
    
    if (!newTab.id) {
      throw new Error('无法创建B站标签页');
    }
    
    return newTab;
  }

  private async waitForPageAndInjectScript(tabId: number): Promise<void> {
    // 等待页面加载完成
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('页面加载超时'));
      }, 10000);

      const checkReady = () => {
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError) {
            clearTimeout(timeout);
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          
          if (tab.status === 'complete') {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(checkReady, 100);
          }
        });
      };
      
      checkReady();
    });

    // 注入桥接脚本（隔离世界）
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['inject-scripts/core/inject-bridge.js']
    });

    // 注入B站视频控制脚本（主世界）
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['inject-scripts/scraper/bilibili-jump.js'],
      world: 'MAIN'
    });

    // 等待脚本初始化
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  private async _sendMessage(tabId: number, action: string, payload?: any): Promise<any> {
    console.log('[BilibiliJumpTool] 发送消息:', { action, payload });
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`消息发送超时: ${action}`));
      }, 10000);

      const message = {
        action,
        targetWorld: 'MAIN',
        payload: payload ? JSON.stringify(payload) : undefined
      };
      
      console.log('[BilibiliJumpTool] 完整消息对象:', message);

      chrome.tabs.sendMessage(
        tabId,
        message,
        (response) => {
          clearTimeout(timeout);
          
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          
          if (response && response.error) {
            reject(new Error(response.error));
            return;
          }
          
          resolve(response?.data || response);
        }
      );
    });
  }

  async execute(params: {
    action: 'jumpToTime' | 'getStatus' | 'play' | 'pause' | 'togglePlayPause' | 'fastForward' | 'rewind' | 'setSpeed' | 'setVolume' | 'toggleMute';
    time?: string;
    seconds?: number;
    speed?: number;
    volume?: number;
  }): Promise<ToolResult> {
    // 参数验证和调试
    console.log('[BilibiliJumpTool] 接收到的参数:', params);
    
    if (!params || typeof params !== 'object') {
      throw new Error('参数格式错误：params必须是对象');
    }

    const {
      action = 'jumpToTime',
      time,
      seconds = 10,
      speed = 1.0,
      volume = 1.0
    } = params;
    
    console.log('[BilibiliJumpTool] 解构后的action:', action);

    try {
      // 获取或创建B站标签页
      const tab = await this._getOrCreateBilibiliTab();
      
      if (!tab.id) {
        throw new Error('无法获取标签页ID');
      }

      // 检查是否在B站视频页面
      if (!tab.url || !/bilibili\.com\/(video|list|bangumi\/play)\//.test(tab.url)) {
        throw new Error('请先打开B站视频页面');
      }

      // 等待页面加载并注入脚本
      await this.waitForPageAndInjectScript(tab.id);

      // 测试脚本是否可用
      try {
        await this._sendMessage(tab.id, 'ping');
      } catch (error) {
        throw new Error('视频控制脚本未正确加载');
      }

      // 准备参数
      let actionParams: any = {};
      
      switch (action) {
        case 'jumpToTime':
          if (!time) {
            throw new Error('跳转时间参数不能为空');
          }
          actionParams = { time };
          break;
        case 'fastForward':
        case 'rewind':
          actionParams = { seconds };
          break;
        case 'setSpeed':
          actionParams = { speed };
          break;
        case 'setVolume':
          actionParams = { volume };
          break;
        default:
          // 其他操作不需要额外参数
          break;
      }

      // 执行操作
      const result = await this._sendMessage(tab.id, action, actionParams);
      
      return {
        success: true,
        content: [{
          type: 'text',
          text: `视频控制操作 ${action} 执行成功`
        }],
        data: {
          action,
          ...result
        },
        // 业务事实（action + 操作回执）在 data 一份，content 是状态句——正题在 data
        primary: 'data'
      };

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        content: [{
          type: 'text',
          text: `视频控制操作 ${action} 执行失败: ${message}`
        }],
        error: message,
        // 失败原因只在 content 与 error 里，data 无载荷——正题在 content
        primary: 'content'
      };
    }
  }

  // 便捷方法：跳转到指定时间
  async jumpToTime(time: string): Promise<ToolResult> {
    return this.execute({ action: 'jumpToTime', time });
  }

  // 便捷方法：获取视频状态
  async getVideoStatus(): Promise<ToolResult> {
    return this.execute({ action: 'getStatus' });
  }

  // 便捷方法：播放视频
  async play(): Promise<ToolResult> {
    return this.execute({ action: 'play' });
  }

  // 便捷方法：暂停视频
  async pause(): Promise<ToolResult> {
    return this.execute({ action: 'pause' });
  }

  // 便捷方法：切换播放/暂停
  async togglePlayPause(): Promise<ToolResult> {
    return this.execute({ action: 'togglePlayPause' });
  }

  // 便捷方法：快进
  async fastForward(seconds: number = 10): Promise<ToolResult> {
    return this.execute({ action: 'fastForward', seconds });
  }

  // 便捷方法：快退
  async rewind(seconds: number = 10): Promise<ToolResult> {
    return this.execute({ action: 'rewind', seconds });
  }

  // 便捷方法：设置播放速度
  async setPlaybackSpeed(speed: number): Promise<ToolResult> {
    return this.execute({ action: 'setSpeed', speed });
  }

  // 便捷方法：设置音量
  async setVolume(volume: number): Promise<ToolResult> {
    return this.execute({ action: 'setVolume', volume });
  }

  // 便捷方法：切换静音
  async toggleMute(): Promise<ToolResult> {
    return this.execute({ action: 'toggleMute' });
  }

  // 便捷方法：跳转到视频开头
  async jumpToStart(): Promise<ToolResult> {
    return this.jumpToTime('0');
  }

  // 便捷方法：跳转到视频中间
  async jumpToMiddle(): Promise<ToolResult> {
    try {
      const status = await this.getVideoStatus();
      if (status.success && status.data && (status.data as any).duration) {
        const middleTime = Math.floor((status.data as any).duration / 2);
        return this.jumpToTime(middleTime.toString());
      } else {
        throw new Error('无法获取视频时长');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        content: [{
          type: 'text',
          text: `跳转到视频中间失败: ${message}`
        }],
        error: message,
        // 失败原因只在 content 与 error 里，data 无载荷——正题在 content
        primary: 'content'
      };
    }
  }

  // 便捷方法：常用播放速度设置
  async setSpeed0_5x(): Promise<ToolResult> {
    return this.setPlaybackSpeed(0.5);
  }

  async setSpeed0_75x(): Promise<ToolResult> {
    return this.setPlaybackSpeed(0.75);
  }

  async setSpeed1x(): Promise<ToolResult> {
    return this.setPlaybackSpeed(1.0);
  }

  async setSpeed1_25x(): Promise<ToolResult> {
    return this.setPlaybackSpeed(1.25);
  }

  async setSpeed1_5x(): Promise<ToolResult> {
    return this.setPlaybackSpeed(1.5);
  }

  async setSpeed2x(): Promise<ToolResult> {
    return this.setPlaybackSpeed(2.0);
  }
}
/**
 * 小智网页配置工具
 * 专门用于配置小智设备的WiFi和OTA设置
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';
import { enhanceClickTool } from '../base/enhance-click-tool';
import { enhanceFillTool } from '../base/enhance-fill-tool';

interface XiaozhiConfigParams {
  wifiSsid: string;      // WiFi SSID
  wifiPassword: string;  // WiFi 密码
  otaUrl: string;        // OTA 地址
  frameId?: number;      // Frame ID，默认为0（主页面）
}

export class XiaozhiConfigTool extends BaseTool {
  name = 'xiaozhi_config';
  
  metadata: ToolMetadata = {
    name: 'xiaozhi_config',
    description: '小智网页配置工具 - 自动配置WiFi和OTA设置',
    category: 'automation',
    tags: ['xiaozhi', 'config', 'wifi', 'ota', 'automation'],
    version: '1.0.0',
    author: 'System'
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'xiaozhi_config',
      description: '自动配置小智设备的WiFi和OTA设置，按顺序执行：1) 配置OTA地址 2) 配置WiFi连接',
      parameters: {
        type: 'object',
        properties: {
          wifiSsid: {
            type: 'string',
            description: 'WiFi网络名称 (SSID)'
          },
          wifiPassword: {
            type: 'string',
            description: 'WiFi密码'
          },
          otaUrl: {
            type: 'string',
            description: 'OTA升级地址URL'
          },
          frameId: {
            type: 'number',
            description: '目标元素所在的iframe的ID。主页面ID为0。默认为0'
          }
        },
        required: ['wifiSsid', 'wifiPassword', 'otaUrl']
      }
    }
  };

  async execute(args: XiaozhiConfigParams): Promise<ToolResult> {
    console.log('🤖 [小智配置工具] 开始执行');
    console.log('📥 [小智配置工具] 接收参数:', {
      wifiSsid: args.wifiSsid,
      wifiPassword: '***',
      otaUrl: args.otaUrl,
      frameId: args.frameId ?? 0
    });
    
    try {
      this.validateArgs(args, ['wifiSsid', 'wifiPassword', 'otaUrl']);
      
      const { wifiSsid, wifiPassword, otaUrl, frameId = 0 } = args;
      
      // 辅助函数：等待一段时间
      const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      
      console.log('📋 [小智配置工具] === 第1步: 配置OTA设置 ===');
      
      // 1. 点击高级选项按钮
      console.log('👆 [小智配置工具] 点击高级选项按钮');
      let result = await enhanceClickTool.execute({ 
        selector: 'div.tab[data-lang="advanced_tab"]',
        frameId 
      });
      if (!result.success) {
        console.error('❌ [小智配置工具] 点击高级选项按钮失败:', result.error);
        return this.createErrorResponse(`步骤1失败: 点击高级选项按钮 - ${result.error}`);
      }
      await wait(500);
      
      // 2. 填充OTA地址
      console.log('⌨️ [小智配置工具] 填充OTA地址');
      result = await enhanceFillTool.execute({
        selector: '#ota_url',
        value: otaUrl,
        frameId
      });
      if (!result.success) {
        console.error('❌ [小智配置工具] 填充OTA地址失败:', result.error);
        return this.createErrorResponse(`步骤2失败: 填充OTA地址 - ${result.error}`);
      }
      
      // 3. 点击保存按钮
      console.log('👆 [小智配置工具] 点击高级选项保存按钮');
      result = await enhanceClickTool.execute({
        selector: '#advanced_button',
        frameId
      });
      if (!result.success) {
        console.error('❌ [小智配置工具] 点击保存按钮失败:', result.error);
        return this.createErrorResponse(`步骤3失败: 点击保存按钮 - ${result.error}`);
      }
      await wait(500);
      
      console.log('📋 [小智配置工具] === 第2步: 配置WiFi设置 ===');
      
      // 4. 点击WiFi配置选项按钮
      console.log('👆 [小智配置工具] 点击WiFi配置选项按钮');
      result = await enhanceClickTool.execute({
        selector: 'div.tab[data-lang="wifi_tab"]',
        frameId
      });
      if (!result.success) {
        console.error('❌ [小智配置工具] 点击WiFi配置选项按钮失败:', result.error);
        return this.createErrorResponse(`步骤4失败: 点击WiFi配置选项按钮 - ${result.error}`);
      }
      await wait(500);
      
      // 5. 填充WiFi SSID
      console.log('⌨️ [小智配置工具] 填充WiFi SSID');
      result = await enhanceFillTool.execute({
        selector: '#ssid',
        value: wifiSsid,
        frameId
      });
      if (!result.success) {
        console.error('❌ [小智配置工具] 填充WiFi SSID失败:', result.error);
        return this.createErrorResponse(`步骤5失败: 填充WiFi SSID - ${result.error}`);
      }
      
      // 6. 填充WiFi密码
      console.log('⌨️ [小智配置工具] 填充WiFi密码');
      result = await enhanceFillTool.execute({
        selector: '#password',
        value: wifiPassword,
        frameId
      });
      if (!result.success) {
        console.error('❌ [小智配置工具] 填充WiFi密码失败:', result.error);
        return this.createErrorResponse(`步骤6失败: 填充WiFi密码 - ${result.error}`);
      }
      
      // 7. 点击连接按钮
      console.log('👆 [小智配置工具] 点击WiFi连接按钮');
      result = await enhanceClickTool.execute({
        selector: '#button',
        frameId
      });
      if (!result.success) {
        console.error('❌ [小智配置工具] 点击连接按钮失败:', result.error);
        return this.createErrorResponse(`步骤7失败: 点击连接按钮 - ${result.error}`);
      }
      
      console.log('🎉 [小智配置工具] 配置流程全部完成');
      this.log('小智配置完成');
      
      return this.createSuccessResponse(
        { 
          wifiSsid,
          otaUrl,
          configured: true,
          frameId
        },
        '小智配置成功完成：已设置OTA地址并配置WiFi连接'
      );
      
    } catch (error) {
      console.error('💥 [小智配置工具] 执行过程中发生错误:', error);
      return this.createErrorResponse('配置失败', error);
    }
  }
}

// 导出工具实例
export const xiaozhiConfigTool = new XiaozhiConfigTool();

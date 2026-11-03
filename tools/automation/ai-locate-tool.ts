/**
 * AI定位工具
 * 使用AI视觉能力定位页面元素
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';
import { aiChatApi } from '@/entrypoints/sidepanel/utils/ai/ai-chat-api';
import { modelRegistry } from '@/entrypoints/sidepanel/utils/channels';

interface LocateParams {
  description: string;
  highlight?: boolean;
  confidence?: number;
}

interface LocateResult {
  selector: string;
  confidence: number;
  element?: {
    tagName: string;
    text?: string;
    attributes?: Record<string, string>;
    position?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  };
}

export class AILocateTool extends BaseTool {
  name = 'ai_locate';
  
  metadata: ToolMetadata = {
    name: 'ai_locate',
    description: '使用AI视觉能力定位页面元素',
    category: 'automation',
    tags: ['ai', 'locate', 'element', 'vision'],
    version: '1.0.0',
    author: 'System'
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'ai_locate',
      description: '使用AI视觉能力根据描述定位页面元素',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: '要定位的元素描述，例如："登录按钮"、"搜索框"、"用户头像"等'
          },
          highlight: {
            type: 'boolean',
            description: '是否高亮显示找到的元素',
            default: true
          },
          confidence: {
            type: 'number',
            description: '最低置信度阈值（0-1），默认0.7',
            minimum: 0,
            maximum: 1,
            default: 0.7
          }
        },
        required: ['description']
      }
    }
  };

  async execute(args: LocateParams): Promise<ToolResult> {
    console.log('🎯 [AI定位工具] 开始执行');
    console.log('📥 [AI定位工具] 接收参数:', args);
    
    try {
      this.validateArgs(args, ['description']);
      
      const { description, highlight = true, confidence = 0.7 } = args;
      
      console.log(`🔍 [AI定位工具] 开始定位元素: "${description}"`);
      console.log(`⚙️ [AI定位工具] 配置 - 高亮显示: ${highlight}, 置信度阈值: ${confidence}`);
      
      this.log(`开始定位元素: ${description}`);
      
      // 获取当前页面截图
      console.log('📸 [AI定位工具] 正在获取页面截图...');
      const screenshot = await this.captureScreenshot();
      if (!screenshot.success) {
        console.error('❌ [AI定位工具] 获取页面截图失败:', screenshot.error);
        return this.createErrorResponse('获取页面截图失败', screenshot.error);
      }
      console.log('✅ [AI定位工具] 页面截图获取成功');
      
      // 使用AI视觉分析定位元素
      console.log('🤖 [AI定位工具] 正在使用AI视觉分析定位元素...');
      const locateResult = await this.aiLocate(screenshot.data.dataUrl, description, confidence);
      if (!locateResult.success) {
        console.error('❌ [AI定位工具] AI定位失败:', locateResult.error);
        return this.createErrorResponse('AI定位失败', locateResult.error);
      }
      console.log('✅ [AI定位工具] AI定位分析完成');
      
      const result = locateResult.data as LocateResult;
      console.log('📊 [AI定位工具] 定位结果:', {
        selector: result.selector,
        confidence: result.confidence,
        element: result.element
      });
      
      // 如果需要高亮显示
      if (highlight && result.selector) {
        console.log('🎨 [AI定位工具] 正在高亮显示元素...');
        await this.highlightElement(result.selector);
        console.log('✅ [AI定位工具] 元素高亮显示完成');
      }
      
      this.log(`成功定位元素: ${result.selector}, 置信度: ${result.confidence}`);
      
      const finalResult = {
        selector: result.selector,
        confidence: result.confidence,
        element: result.element,
        description
      };
      
      console.log('🎉 [AI定位工具] 执行成功完成');
      console.log('📤 [AI定位工具] 返回结果:', finalResult);
      
      return this.createSuccessResponse(finalResult, `成功定位元素: ${description}`);
      
    } catch (error) {
      console.error('💥 [AI定位工具] 执行过程中发生错误:', error);
      return this.createErrorResponse('定位元素失败', error);
    }
  }

  /**
   * 获取页面截图
   */
  private async captureScreenshot(): Promise<ToolResult> {
    try {
      console.log('🔍 [AI定位工具-截图] 查询活动标签页...');
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        console.error('❌ [AI定位工具-截图] 未找到活动标签页');
        throw new Error('未找到活动标签页');
      }
      console.log('✅ [AI定位工具-截图] 找到活动标签页:', tabs[0].url);
      
      console.log('📸 [AI定位工具-截图] 正在捕获可见区域...');
      const dataUrl = await chrome.tabs.captureVisibleTab(tabs[0].windowId, {
        format: 'png',
        quality: 90
      });
      console.log('✅ [AI定位工具-截图] 截图捕获成功，数据大小:', dataUrl.length, '字符');
      
      return this.createSuccessResponse({ dataUrl });
    } catch (error) {
      console.error('❌ [AI定位工具-截图] 截图失败:', error);
      return this.createErrorResponse('截图失败', error);
    }
  }

  /**
   * 使用AI视觉定位元素
   */
  private async aiLocate(imageDataUrl: string, description: string, minConfidence: number): Promise<ToolResult> {
    try {
      console.log('🤖 [AI定位工具-AI分析] 准备AI视觉分析请求');
      console.log('📝 [AI定位工具-AI分析] 目标描述:', description);
      console.log('🎯 [AI定位工具-AI分析] 最低置信度:', minConfidence);
      
      const base64Image = imageDataUrl.split(',')[1];
      console.log('🖼️ [AI定位工具-AI分析] 图片数据准备完成，Base64长度:', base64Image.length);

      // 端点快照 + 统一多协议请求层：协议适配（openai/claude/gemini/...）、
      // 重试、错误分类、密钥管理全部由统一层完成，不再持有任何硬编码端点。
      // 本工具也可能在 background（CALL_TOOL / WebSocket 通道）执行——那里渠道
      // 存储尚未加载，必须先幂等加载再解析，否则会把「已配置」误报成「尚无可用模型」
      if (!modelRegistry.isLoaded()) {
        await modelRegistry.load();
      }
      const endpoint = modelRegistry.resolveActive();
      console.log('🌐 [AI定位工具-AI分析] 使用协议:', endpoint.provider, '模型:', endpoint.model);

      const { finalMessage } = await aiChatApi.sendVisionMessage(
        [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `请分析这个网页截图，找到"${description}"对应的元素。\n\n要求：\n1. 返回CSS选择器\n2. 返回置信度（0-1）\n3. 如果置信度低于${minConfidence}，返回null\n4. 返回JSON格式：{"selector": "css选择器", "confidence": 0.95, "element": {"tagName": "button", "text": "按钮文本"}}\n\n注意：只返回JSON，不要其他文本。`
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageDataUrl,
                  detail: 'auto'
                }
              }
            ]
          }
        ],
        {},
        { endpoint, temperature: 0.1, maxTokens: 500 }
      );

      console.log('📥 [AI定位工具-AI分析] 收到AI响应');

      const content =
        typeof finalMessage.content === 'string' ? finalMessage.content.trim() : '';
      console.log('📄 [AI定位工具-AI分析] AI响应内容:', content);

      if (!content) {
        console.error('❌ [AI定位工具-AI分析] AI响应为空');
        throw new Error('AI响应为空');
      }
      
      // 解析AI返回的JSON
      console.log('🔍 [AI定位工具-AI分析] 正在解析AI响应JSON...');
      let result;
      try {
        result = this.extractJsonFromText(content);
        console.log('✅ [AI定位工具-AI分析] JSON解析成功:', result);
      } catch (parseError) {
        console.error('❌ [AI定位工具-AI分析] JSON解析失败:', parseError);
        console.error('🔍 [AI定位工具-AI分析] 原始内容:', content);
        throw new Error(`解析AI响应失败: ${content}`);
      }
      
      console.log('🎯 [AI定位工具-AI分析] 验证结果有效性...');
      console.log('📊 [AI定位工具-AI分析] 选择器:', result?.selector);
      console.log('📊 [AI定位工具-AI分析] 置信度:', result?.confidence);
      
      if (!result || !result.selector || result.confidence < minConfidence) {
        console.warn('⚠️ [AI定位工具-AI分析] 未找到符合要求的元素');
        console.warn('📊 [AI定位工具-AI分析] 当前置信度:', result?.confidence || 0);
        console.warn('🎯 [AI定位工具-AI分析] 要求置信度:', minConfidence);
        throw new Error(`未找到符合要求的元素，置信度: ${result?.confidence || 0}`);
      }
      
      console.log('🎉 [AI定位工具-AI分析] AI分析成功完成');
      return this.createSuccessResponse(result);
      
    } catch (error) {
      console.error('💥 [AI定位工具-AI分析] AI分析过程中发生错误:', error);
      return this.createErrorResponse('AI定位请求失败', error);
    }
  }

  // 提取并解析AI返回文本中的第一个JSON对象
  private extractJsonFromText(text: string): any {
    // 优先提取```json```代码块
    const fencedJson = text.match(/```json\s*([\s\S]*?)\s*```/i) || text.match(/```\s*([\s\S]*?)\s*```/);
    let candidate = fencedJson ? fencedJson[1] : null;

    if (!candidate) {
      // 直接整体解析（失败则回退到括号匹配提取）
      try {
        return JSON.parse(text.trim());
      } catch {
        // 文本不是合法 JSON，继续尝试提取首个 JSON 对象
      }

      // 使用括号匹配提取第一个完整JSON对象
      const start = text.indexOf('{');
      if (start !== -1) {
        let depth = 0, inString = false, escape = false, end = -1;
        for (let i = start; i < text.length; i++) {
          const ch = text[i];
          if (inString) {
            if (escape) {
              escape = false;
            } else if (ch === '\\') {
              escape = true;
            } else if (ch === '"') {
              inString = false;
            }
          } else {
            if (ch === '"') {
              inString = true;
            } else if (ch === '{') {
              depth++;
            } else if (ch === '}') {
              depth--;
              if (depth === 0) {
                end = i;
                break;
              }
            }
          }
        }
        if (end !== -1) {
          candidate = text.slice(start, end + 1);
        }
      }
    }

    if (!candidate) {
      throw new Error('未找到可解析的JSON');
    }

    return JSON.parse(candidate);
  }

  /**
   * 高亮显示元素
   * @param selector 元素选择器
   * @param options 高亮选项
   */
  private async highlightElement(selector: string, options: any = {}): Promise<void> {
    try {
      console.log('🎨 [AI定位工具-高亮] 开始高亮元素:', selector);
      
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        console.error('❌ [AI定位工具-高亮] 未找到活动标签页');
        throw new Error('未找到活动标签页');
      }
      
      console.log('💉 [AI定位工具-高亮] 注入AI高亮脚本...');
      // 注入AI高亮脚本
      await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id! },
        files: ['inject-scripts/vision/ai-highlight.js']
      });
      
      console.log('📤 [AI定位工具-高亮] 发送高亮指令...');
      // 发送高亮指令
      const response = await chrome.tabs.sendMessage(tabs[0].id!, {
        action: 'highlightElement',
        selector: selector,
        options: {
          style: 'pulse',
          color: '#ff4444',
          backgroundColor: 'rgba(255, 68, 68, 0.1)',
          label: '🎯 AI定位',
          duration: 5000,
          showLabel: true,
          borderWidth: '3px',
          ...options
        }
      });
      
      if (response?.status === 'success') {
        console.log('✅ [AI定位工具-高亮] 元素高亮成功');
        this.log('元素高亮成功', 'info');
      } else {
        console.warn('⚠️ [AI定位工具-高亮] 元素高亮失败:', response?.message);
        this.log(`元素高亮失败: ${response?.message}`, 'warn');
      }
    } catch (error) {
      console.error('❌ [AI定位工具-高亮] 高亮元素失败:', error);
      this.log(`高亮元素失败: ${error}`, 'warn');
    }
  }
}

// 导出工具实例
export const aiLocateTool = new AILocateTool();
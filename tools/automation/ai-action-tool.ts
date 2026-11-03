/**
 * AI操作工具
 * 使用AI视觉能力执行页面操作
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';
import { aiChatApi } from '@/entrypoints/sidepanel/utils/ai/ai-chat-api';
import { modelRegistry } from '@/entrypoints/sidepanel/utils/channels';

interface ActionParams {
  description: string;
  action: 'click' | 'input' | 'scroll' | 'hover' | 'select' | 'submit';
  value?: string;
  waitAfter?: number;
  screenshot?: boolean;
}

interface ActionResult {
  success: boolean;
  selector?: string;
  action: string;
  value?: string;
  message: string;
}

export class AIActionTool extends BaseTool {
  name = 'ai_action';
  
  metadata: ToolMetadata = {
    name: 'ai_action',
    description: '使用AI视觉能力执行页面操作',
    category: 'automation',
    tags: ['ai', 'action', 'automation', 'vision'],
    version: '1.0.0',
    author: 'System'
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'ai_action',
      description: '使用AI视觉能力根据描述执行页面操作',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: '要操作的元素描述，例如："点击登录按钮"、"在搜索框输入文本"等'
          },
          action: {
            type: 'string',
            enum: ['click', 'input', 'scroll', 'hover', 'select', 'submit'],
            description: '要执行的操作类型'
          },
          value: {
            type: 'string',
            description: '操作值（如输入的文本、选择的选项等）',
            default: ''
          },
          waitAfter: {
            type: 'number',
            description: '操作后等待时间（毫秒）',
            default: 1000
          },
          screenshot: {
            type: 'boolean',
            description: '操作后是否截图验证',
            default: false
          }
        },
        required: ['description', 'action']
      }
    }
  };

  async execute(args: ActionParams): Promise<ToolResult> {
    console.log('🎬 [AI操作工具] 开始执行');
    console.log('📥 [AI操作工具] 接收参数:', args);
    
    try {
      this.validateArgs(args, ['description', 'action']);
      
      const { description, action, value = '', waitAfter = 1000, screenshot = false } = args;
      
      console.log(`🎯 [AI操作工具] 开始执行操作: "${description}" (${action})`);
      console.log(`⚙️ [AI操作工具] 配置 - 操作值: "${value}", 等待时间: ${waitAfter}ms, 截图验证: ${screenshot}`);
      
      this.log(`开始执行操作: ${description} (${action})`);
      
      // 获取当前页面截图
      console.log('📸 [AI操作工具] 正在获取页面截图...');
      const screenshotResult = await this.captureScreenshot();
      if (!screenshotResult.success) {
        console.error('❌ [AI操作工具] 获取页面截图失败:', screenshotResult.error);
        return this.createErrorResponse('获取页面截图失败', screenshotResult.error);
      }
      console.log('✅ [AI操作工具] 页面截图获取成功');
      
      // 使用AI视觉分析并定位元素
      console.log('🤖 [AI操作工具] 正在使用AI视觉分析并定位元素...');
      const locateResult = await this.aiLocateForAction(screenshotResult.data.dataUrl, description, action);
      if (!locateResult.success) {
        console.error('❌ [AI操作工具] AI定位失败:', locateResult.error);
        return this.createErrorResponse('AI定位失败', locateResult.error);
      }
      console.log('✅ [AI操作工具] AI定位分析完成');
      
      const selector = locateResult.data.selector;
      console.log('📍 [AI操作工具] 定位到目标元素:', selector);
      
      // 执行操作
      console.log(`🎬 [AI操作工具] 正在执行${action}操作...`);
      const actionResult = await this.executeAction(selector, action, value);
      if (!actionResult.success) {
        console.error('❌ [AI操作工具] 执行操作失败:', actionResult.error);
        return this.createErrorResponse('执行操作失败', actionResult.error);
      }
      console.log('✅ [AI操作工具] 操作执行成功');
      
      // 等待操作完成
      if (waitAfter > 0) {
        console.log(`⏰ [AI操作工具] 等待操作完成: ${waitAfter}ms`);
        await new Promise(resolve => setTimeout(resolve, waitAfter));
        console.log('✅ [AI操作工具] 等待完成');
      }
      
      // 可选的操作后截图
      let afterScreenshot = null;
      if (screenshot) {
        console.log('📸 [AI操作工具] 正在获取操作后截图...');
        const afterResult = await this.captureScreenshot();
        if (afterResult.success) {
          afterScreenshot = afterResult.data.dataUrl;
          console.log('✅ [AI操作工具] 操作后截图获取成功');
        } else {
          console.warn('⚠️ [AI操作工具] 操作后截图获取失败');
        }
      }
      
      this.log(`成功执行操作: ${description}`);
      
      const finalResult = {
        selector,
        action,
        value,
        description,
        afterScreenshot
      };
      
      console.log('🎉 [AI操作工具] 执行成功完成');
      console.log('📤 [AI操作工具] 返回结果:', finalResult);
      
      return this.createSuccessResponse(finalResult, `成功执行操作: ${description}`);
      
    } catch (error) {
      console.error('💥 [AI操作工具] 执行过程中发生错误:', error);
      return this.createErrorResponse('执行操作失败', error);
    }
  }

  /**
   * 获取页面截图
   */
  private async captureScreenshot(): Promise<ToolResult> {
    try {
      console.log('🔍 [AI操作工具-截图] 查询活动标签页...');
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        console.error('❌ [AI操作工具-截图] 未找到活动标签页');
        throw new Error('未找到活动标签页');
      }
      console.log('✅ [AI操作工具-截图] 找到活动标签页:', tabs[0].url);
      
      console.log('📸 [AI操作工具-截图] 正在捕获可见区域...');
      const dataUrl = await chrome.tabs.captureVisibleTab(tabs[0].windowId, {
        format: 'png',
        quality: 90
      });
      console.log('✅ [AI操作工具-截图] 截图捕获成功，数据大小:', dataUrl.length, '字符');
      
      return this.createSuccessResponse({ dataUrl });
    } catch (error) {
      console.error('❌ [AI操作工具-截图] 截图失败:', error);
      return this.createErrorResponse('截图失败', error);
    }
  }

  /**
   * 提取并解析AI返回文本中的第一个JSON对象
   */
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
   * 使用AI视觉定位操作元素
   */
  private async aiLocateForAction(imageDataUrl: string, description: string, action: string): Promise<ToolResult> {
    try {
      console.log('🤖 [AI操作工具-AI分析] 准备AI视觉分析请求');
      console.log('📝 [AI操作工具-AI分析] 目标描述:', description);
      console.log('🎬 [AI操作工具-AI分析] 操作类型:', action);
      
      const base64Image = imageDataUrl.split(',')[1];
      console.log('🖼️ [AI操作工具-AI分析] 图片数据准备完成，Base64长度:', base64Image.length);

      // 端点快照 + 统一多协议请求层：协议适配（openai/claude/gemini/...）、
      // 重试、错误分类、密钥管理全部由统一层完成，不再持有任何硬编码端点。
      // 本工具也可能在 background（CALL_TOOL / WebSocket 通道）执行——那里渠道
      // 存储尚未加载，必须先幂等加载再解析，否则会把「已配置」误报成「尚无可用模型」
      if (!modelRegistry.isLoaded()) {
        await modelRegistry.load();
      }
      const endpoint = modelRegistry.resolveActive();
      console.log('🌐 [AI操作工具-AI分析] 使用协议:', endpoint.provider, '模型:', endpoint.model);

      const { finalMessage } = await aiChatApi.sendVisionMessage(
        [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `请分析这个网页截图，找到"${description}"对应的元素，准备执行"${action}"操作。\n\n要求：\n1. 返回最精确的CSS选择器\n2. 确保元素可以执行${action}操作\n3. 返回JSON格式：{"selector": "css选择器", "confidence": 0.95}\n\n注意：只返回JSON，不要其他文本。`
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
        { endpoint, temperature: 0.1, maxTokens: 300 }
      );

      console.log('📥 [AI操作工具-AI分析] 收到AI响应');

      const content =
        typeof finalMessage.content === 'string' ? finalMessage.content.trim() : '';
      console.log('📄 [AI操作工具-AI分析] AI响应内容:', content);

      if (!content) {
        console.error('❌ [AI操作工具-AI分析] AI响应为空');
        throw new Error('AI响应为空');
      }
      
      // 解析AI返回的JSON
      console.log('🔍 [AI操作工具-AI分析] 正在解析AI响应JSON...');
      let result;
      try {
        // 使用统一的JSON提取方法
        result = this.extractJsonFromText(content);
        console.log('✅ [AI操作工具-AI分析] JSON解析成功:', result);
      } catch (parseError) {
        console.error('❌ [AI操作工具-AI分析] JSON解析失败:', parseError);
        console.error('🔍 [AI操作工具-AI分析] 原始内容:', content);
        throw new Error(`解析AI响应失败: ${content}`);
      }
      
      console.log('🎯 [AI操作工具-AI分析] 验证结果有效性...');
      console.log('📊 [AI操作工具-AI分析] 选择器:', result?.selector);
      console.log('📊 [AI操作工具-AI分析] 置信度:', result?.confidence);
      
      if (!result || !result.selector) {
        console.error('❌ [AI操作工具-AI分析] 未找到可操作的元素');
        throw new Error('未找到可操作的元素');
      }
      
      console.log('🎉 [AI操作工具-AI分析] AI分析成功完成');
      return this.createSuccessResponse(result);
      
    } catch (error) {
      console.error('💥 [AI操作工具-AI分析] AI分析过程中发生错误:', error);
      return this.createErrorResponse('AI定位请求失败', error);
    }
  }

  /**
   * 执行具体操作
   */
  private async executeAction(selector: string, action: string, value: string): Promise<ToolResult> {
    try {
      console.log('🎬 [AI操作工具-执行] 开始执行操作');
      console.log('📍 [AI操作工具-执行] 目标选择器:', selector);
      console.log('🎯 [AI操作工具-执行] 操作类型:', action);
      console.log('📝 [AI操作工具-执行] 操作值:', value);
      
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        console.error('❌ [AI操作工具-执行] 未找到活动标签页');
        throw new Error('未找到活动标签页');
      }
      
      console.log('💉 [AI操作工具-执行] 向页面注入执行脚本...');
      const result = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id! },
        func: (sel: string, act: string, val: string) => {
          console.log('🎬 [页面脚本] 开始执行操作脚本');
          console.log('📍 [页面脚本] 选择器:', sel);
          console.log('🎯 [页面脚本] 操作:', act);
          console.log('📝 [页面脚本] 值:', val);
          
          try {
            let element = null;
            
            // 检查是否包含:contains()伪类，如果包含则直接处理
            if (sel.includes(':contains(')) {
              console.log('🔍 [页面脚本] 检测到:contains()选择器，直接处理');
              const match = sel.match(/^([^:]+):contains\((['"])(.*?)\2\)$/);
              if (match) {
                const [, baseSelector, , text] = match;
                console.log('🔍 [页面脚本] 基础选择器:', baseSelector, '文本:', text);
                const elements = document.querySelectorAll(baseSelector);
                for (const el of elements) {
                  if (el.textContent && el.textContent.includes(text)) {
                    element = el as HTMLElement;
                    console.log('✅ [页面脚本] 通过:contains()找到元素:', element);
                    break;
                  }
                }
              }
            } else {
              // 使用标准CSS选择器
              console.log('🔍 [页面脚本] 使用标准CSS选择器');
              element = document.querySelector(sel) as HTMLElement;
            }
            
            if (!element) {
              console.error('❌ [页面脚本] 未找到目标元素:', sel);
              return { success: false, message: `未找到元素: ${sel}` };
            }
            console.log('✅ [页面脚本] 找到目标元素:', element);
            
            // 滚动到元素可见
            console.log('📍 [页面脚本] 滚动到元素可见位置...');
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            
            // 等待一下再执行操作
            setTimeout(() => {
              try {
                console.log(`🎬 [页面脚本] 执行${act}操作...`);
                
                switch (act) {
                  case 'click':
                    console.log('👆 [页面脚本] 执行点击操作');
                    element.click();
                    break;
                    
                  case 'input':
                    console.log('⌨️ [页面脚本] 执行输入操作');
                    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
                      element.focus();
                      element.value = val;
                      element.dispatchEvent(new Event('input', { bubbles: true }));
                      element.dispatchEvent(new Event('change', { bubbles: true }));
                      console.log('✅ [页面脚本] 输入操作完成，值:', val);
                    } else {
                      console.error('❌ [页面脚本] 元素不支持输入操作');
                      throw new Error('元素不支持输入操作');
                    }
                    break;
                    
                  case 'hover':
                    console.log('🖱️ [页面脚本] 执行悬停操作');
                    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                    break;
                    
                  case 'select':
                    console.log('📋 [页面脚本] 执行选择操作');
                    if (element instanceof HTMLSelectElement) {
                      element.value = val;
                      element.dispatchEvent(new Event('change', { bubbles: true }));
                      console.log('✅ [页面脚本] 选择操作完成，值:', val);
                    } else {
                      console.error('❌ [页面脚本] 元素不支持选择操作');
                      throw new Error('元素不支持选择操作');
                    }
                    break;
                    
                  case 'submit':
                    console.log('📤 [页面脚本] 执行提交操作');
                    if (element instanceof HTMLFormElement) {
                      element.submit();
                    } else {
                      // 查找最近的表单
                      const form = element.closest('form');
                      if (form) {
                        console.log('📋 [页面脚本] 找到表单，执行提交');
                        form.submit();
                      } else {
                        console.log('⚠️ [页面脚本] 未找到表单，回退到点击操作');
                        element.click(); // fallback to click
                      }
                    }
                    break;
                    
                  case 'scroll': {
                    console.log('📜 [页面脚本] 执行滚动操作');
                    const scrollAmount = parseInt(val) || 300;
                    window.scrollBy(0, scrollAmount);
                    console.log('✅ [页面脚本] 滚动操作完成，距离:', scrollAmount);
                    break;
                  }
                    
                  default:
                    console.error('❌ [页面脚本] 不支持的操作类型:', act);
                    throw new Error(`不支持的操作类型: ${act}`);
                }
                
                console.log('🎉 [页面脚本] 操作执行成功');
              } catch (error) {
                console.error('💥 [页面脚本] 操作执行失败:', error);
              }
            }, 300); // 等待滚动完成
            
            return { success: true, message: `成功执行${act}操作` };
            
          } catch (error) {
            console.error('💥 [页面脚本] 脚本执行失败:', error);
            return { success: false, message: (error instanceof Error ? error.message : String(error)) || '操作执行失败' };
          }
        },
        args: [selector, action, value]
      });
      
      console.log('📥 [AI操作工具-执行] 收到脚本执行结果');
      const executeResult = result[0].result;
      
      // 检查结果是否为null或undefined
      if (!executeResult) {
        console.error('❌ [AI操作工具-执行] 脚本执行结果为空');
        throw new Error('脚本执行结果为空');
      }
      
      if (!executeResult.success) {
        console.error('❌ [AI操作工具-执行] 脚本执行失败:', executeResult.message);
        throw new Error(executeResult.message);
      }
      
      console.log('✅ [AI操作工具-执行] 操作执行成功:', executeResult.message);
      return this.createSuccessResponse(executeResult);
      
    } catch (error) {
      console.error('💥 [AI操作工具-执行] 执行操作过程中发生错误:', error);
      return this.createErrorResponse('执行操作失败', error);
    }
  }
}

// 导出工具实例
export const aiActionTool = new AIActionTool();
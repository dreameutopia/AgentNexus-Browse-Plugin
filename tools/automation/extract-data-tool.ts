/**
 * 数据提取工具
 * 使用AI视觉能力从页面提取结构化数据
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';
import { aiChatApi } from '@/entrypoints/sidepanel/utils/ai/ai-chat-api';
import { modelRegistry } from '@/entrypoints/sidepanel/utils/channels';

interface ExtractParams {
  description: string;
  dataType: 'string' | 'number' | 'boolean' | 'array' | 'object';
  schema?: any;
  selector?: string;
  multiple?: boolean;
}

interface ExtractResult {
  data: any;
  type: string;
  confidence: number;
  source: 'ai_vision' | 'dom_extraction';
  description: string;
}

export class ExtractDataTool extends BaseTool {
  name = 'extract_data';
  
  metadata: ToolMetadata = {
    name: 'extract_data',
    description: '使用AI视觉能力从页面提取结构化数据',
    category: 'automation',
    tags: ['ai', 'extract', 'data', 'vision', 'scraping'],
    version: '1.0.0',
    author: 'System'
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'extract_data',
      description: '使用AI视觉能力从页面提取结构化数据',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: '要提取的数据描述，例如："商品价格"、"用户评论列表"、"文章标题"等'
          },
          dataType: {
            type: 'string',
            enum: ['string', 'number', 'boolean', 'array', 'object'],
            description: '期望的数据类型'
          },
          schema: {
            type: 'object',
            description: '数据结构模式（当dataType为object或array时使用）',
            additionalProperties: true
          },
          selector: {
            type: 'string',
            description: '可选的CSS选择器，用于限定提取范围'
          },
          multiple: {
            type: 'boolean',
            description: '是否提取多个匹配项',
            default: false
          }
        },
        required: ['description', 'dataType']
      }
    }
  };

  async execute(args: ExtractParams): Promise<ToolResult> {
    console.log('📊 [数据提取工具] 开始执行');
    console.log('📥 [数据提取工具] 接收参数:', args);
    
    try {
      this.validateArgs(args, ['description', 'dataType']);
      
      const { description, dataType, schema, selector, multiple = false } = args;
      
      console.log(`🎯 [数据提取工具] 开始提取数据: "${description}" (${dataType})`);
      console.log(`⚙️ [数据提取工具] 配置 - 选择器: "${selector || '无'}", 多项: ${multiple}, 模式: ${schema ? JSON.stringify(schema) : '无'}`);
      
      this.log(`开始提取数据: ${description} (${dataType})`);
      
      // 如果提供了选择器，先尝试DOM提取
      if (selector) {
        console.log('🔍 [数据提取工具] 检测到选择器，优先尝试DOM提取...');
        const domResult = await this.extractFromDOM(selector, dataType, multiple);
        if (domResult.success) {
          console.log('✅ [数据提取工具] DOM提取成功');
          console.log('📤 [数据提取工具] DOM提取结果:', domResult.data.data);
          
          this.log(`通过DOM成功提取数据: ${description}`);
          
          const finalResult = {
            data: domResult.data.data,
            type: dataType,
            confidence: 1.0,
            source: 'dom_extraction',
            description
          };
          
          console.log('🎉 [数据提取工具] DOM提取完成');
          console.log('📤 [数据提取工具] 返回结果:', finalResult);
          
          return this.createSuccessResponse(finalResult, `成功提取数据: ${description}`);
        } else {
          console.warn('⚠️ [数据提取工具] DOM提取失败，转为AI视觉提取');
          console.warn('🔍 [数据提取工具] DOM提取错误:', domResult.error);
        }
      }
      
      // 获取页面截图进行AI分析
      console.log('📸 [数据提取工具] 正在获取页面截图...');
      const screenshotResult = await this.captureScreenshot();
      if (!screenshotResult.success) {
        console.error('❌ [数据提取工具] 获取页面截图失败:', screenshotResult.error);
        return this.createErrorResponse('获取页面截图失败', screenshotResult.error);
      }
      console.log('✅ [数据提取工具] 页面截图获取成功');
      
      // 使用AI视觉提取数据
      console.log('🤖 [数据提取工具] 正在使用AI视觉提取数据...');
      const aiResult = await this.aiExtractData(
        screenshotResult.data.dataUrl, 
        description, 
        dataType, 
        schema, 
        multiple
      );
      
      if (!aiResult.success) {
        console.error('❌ [数据提取工具] AI数据提取失败:', aiResult.error);
        return this.createErrorResponse('AI数据提取失败', aiResult.error);
      }
      console.log('✅ [数据提取工具] AI数据提取成功');
      
      const result = aiResult.data as ExtractResult;
      console.log('📊 [数据提取工具] 提取结果:', result.data);
      console.log('📊 [数据提取工具] 置信度:', result.confidence);
      
      this.log(`成功提取数据: ${description}, 置信度: ${result.confidence}`);
      
      const finalResult = {
        data: result.data,
        type: dataType,
        confidence: result.confidence,
        source: 'ai_vision',
        description
      };
      
      console.log('🎉 [数据提取工具] 执行成功完成');
      console.log('📤 [数据提取工具] 返回结果:', finalResult);
      
      return this.createSuccessResponse(finalResult, `成功提取数据: ${description}`);
      
    } catch (error) {
      console.error('💥 [数据提取工具] 执行过程中发生错误:', error);
      return this.createErrorResponse('数据提取失败', error);
    }
  }

  /**
   * 获取页面截图
   */
  private async captureScreenshot(): Promise<ToolResult> {
    try {
      console.log('🔍 [数据提取工具-截图] 查询活动标签页...');
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        console.error('❌ [数据提取工具-截图] 未找到活动标签页');
        throw new Error('未找到活动标签页');
      }
      console.log('✅ [数据提取工具-截图] 找到活动标签页:', tabs[0].url);
      
      console.log('📸 [数据提取工具-截图] 正在捕获可见区域...');
      const dataUrl = await chrome.tabs.captureVisibleTab(tabs[0].windowId, {
        format: 'png',
        quality: 90
      });
      console.log('✅ [数据提取工具-截图] 截图捕获成功，数据大小:', dataUrl.length, '字符');
      
      return this.createSuccessResponse({ dataUrl });
    } catch (error) {
      console.error('❌ [数据提取工具-截图] 截图失败:', error);
      return this.createErrorResponse('截图失败', error);
    }
  }

  /**
   * 从DOM直接提取数据
   */
  private async extractFromDOM(selector: string, dataType: string, multiple: boolean): Promise<ToolResult> {
    try {
      console.log('🔍 [数据提取工具-DOM] 开始DOM提取');
      console.log('📍 [数据提取工具-DOM] 选择器:', selector);
      console.log('🎯 [数据提取工具-DOM] 数据类型:', dataType);
      console.log('📊 [数据提取工具-DOM] 多项提取:', multiple);
      
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        console.error('❌ [数据提取工具-DOM] 未找到活动标签页');
        throw new Error('未找到活动标签页');
      }
      
      console.log('💉 [数据提取工具-DOM] 向页面注入提取脚本...');
      const result = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id! },
        func: (sel: string, type: string, multi: boolean) => {
          console.log('🔍 [页面脚本-DOM] 开始DOM提取脚本');
          console.log('📍 [页面脚本-DOM] 选择器:', sel);
          console.log('🎯 [页面脚本-DOM] 类型:', type);
          console.log('📊 [页面脚本-DOM] 多项:', multi);
          
          const elements = document.querySelectorAll(sel);
          console.log('🔍 [页面脚本-DOM] 找到元素数量:', elements.length);
          
          if (elements.length === 0) {
            console.error('❌ [页面脚本-DOM] 未找到匹配的元素:', sel);
            throw new Error(`未找到匹配的元素: ${sel}`);
          }
          
          const extractValue = (element: Element) => {
            console.log('📊 [页面脚本-DOM] 正在提取元素值:', element);
            let value: any;
            
            if (element instanceof HTMLInputElement) {
              value = element.value;
              console.log('📝 [页面脚本-DOM] 输入框值:', value);
            } else if (element instanceof HTMLSelectElement) {
              value = element.value;
              console.log('📋 [页面脚本-DOM] 选择框值:', value);
            } else if (element instanceof HTMLTextAreaElement) {
              value = element.value;
              console.log('📝 [页面脚本-DOM] 文本域值:', value);
            } else {
              value = element.textContent?.trim() || '';
              console.log('📄 [页面脚本-DOM] 文本内容值:', value);
            }
            
            console.log('🔄 [页面脚本-DOM] 原始值:', value, '类型转换目标:', type);
            
            // 类型转换
            switch (type) {
              case 'number': {
                const num = parseFloat(value.replace(/[^\d.-]/g, ''));
                const result = isNaN(num) ? 0 : num;
                console.log('🔢 [页面脚本-DOM] 数字转换:', value, '->', result);
                return result;
              }
              case 'boolean': {
                const boolResult = value.toLowerCase() === 'true' || value === '1' || value === 'yes';
                console.log('✅ [页面脚本-DOM] 布尔转换:', value, '->', boolResult);
                return boolResult;
              }
              case 'string':
              default:
                console.log('📝 [页面脚本-DOM] 字符串值:', value);
                return value;
            }
          };
          
          if (multi) {
            console.log('📊 [页面脚本-DOM] 多项提取模式');
            const results = Array.from(elements).map(extractValue);
            console.log('📤 [页面脚本-DOM] 多项提取结果:', results);
            return results;
          } else {
            console.log('🎯 [页面脚本-DOM] 单项提取模式');
            const singleResult = extractValue(elements[0]);
            console.log('📤 [页面脚本-DOM] 单项提取结果:', singleResult);
            return singleResult;
          }
        },
        args: [selector, dataType, multiple]
      });
      
      console.log('📋 [数据提取工具-DOM] 脚本执行结果:', result);
      
      console.log('✅ [数据提取工具-DOM] DOM提取成功');
      console.log('📤 [数据提取工具-DOM] 最终结果:', result[0].result);
      
      return this.createSuccessResponse({ data: result[0].result });
      
    } catch (error) {
      return this.createErrorResponse('DOM提取失败', error);
    }
  }

  /**
   * 使用AI视觉提取数据
   */
  private async aiExtractData(
    imageDataUrl: string, 
    description: string, 
    dataType: string, 
    schema?: any, 
    multiple?: boolean
  ): Promise<ToolResult> {
    try {
      console.log('🤖 [数据提取工具-AI] 开始AI数据提取');
      console.log('📝 [数据提取工具-AI] 描述:', description);
      console.log('🎯 [数据提取工具-AI] 数据类型:', dataType);
      console.log('📊 [数据提取工具-AI] 多项提取:', multiple);
      console.log('📋 [数据提取工具-AI] 模式:', schema);
      
      const base64Image = imageDataUrl.split(',')[1];
      
      let prompt = `请分析这个网页截图，提取"${description}"相关的数据。\n\n要求：\n`;
      prompt += `1. 数据类型: ${dataType}\n`;
      
      if (multiple) {
        prompt += `2. 提取多个匹配项，返回数组格式\n`;
      } else {
        prompt += `2. 提取单个值\n`;
      }
      
      if (schema) {
        prompt += `3. 数据结构: ${JSON.stringify(schema)}\n`;
      }
      
      prompt += `4. 返回JSON格式：{"data": 提取的数据, "confidence": 置信度(0-1)}\n\n`;
      prompt += `注意：只返回JSON，不要其他文本。如果无法提取，返回null。`;
      
      console.log('💬 [数据提取工具-AI] 构建的提示词:', prompt);

      // 端点快照 + 统一多协议请求层：协议适配（openai/claude/gemini/...）、
      // 重试、错误分类、密钥管理全部由统一层完成，不再持有任何硬编码端点。
      // 本工具也可能在 background（CALL_TOOL / WebSocket 通道）执行——那里渠道
      // 存储尚未加载，必须先幂等加载再解析，否则会把「已配置」误报成「尚无可用模型」
      if (!modelRegistry.isLoaded()) {
        await modelRegistry.load();
      }
      const endpoint = modelRegistry.resolveActive();
      console.log('🌐 [数据提取工具-AI] 使用协议:', endpoint.provider, '模型:', endpoint.model);

      const { finalMessage } = await aiChatApi.sendVisionMessage(
        [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt
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
        { endpoint, temperature: 0.1, maxTokens: 1000 }
      );

      console.log('📥 [数据提取工具-AI] 收到AI响应');

      const content =
        typeof finalMessage.content === 'string' ? finalMessage.content.trim() : '';
      console.log('📝 [数据提取工具-AI] AI响应内容:', content);

      if (!content) {
        console.error('❌ [数据提取工具-AI] AI响应为空');
        throw new Error('AI响应为空');
      }
      
      // 解析AI返回的JSON
      console.log('🔍 [数据提取工具-AI] 解析JSON响应...');
      let result;
      try {
        result = this.extractJsonFromText(content);
        console.log('✅ [数据提取工具-AI] JSON解析成功:', result);
      } catch (parseError) {
        console.error('❌ [数据提取工具-AI] JSON解析失败:', parseError);
        throw new Error(`解析AI响应失败: ${content}`);
      }
      
      if (!result || result.data === null || result.data === undefined) {
        console.error('❌ [数据提取工具-AI] 未能提取到有效数据');
        throw new Error('未能提取到有效数据');
      }
      
      // 数据类型验证和转换
      console.log('🔄 [数据提取工具-AI] 验证和转换数据...');
      const extractedData = this.validateAndConvertData(result.data, dataType);
      console.log('✅ [数据提取工具-AI] 数据验证成功:', extractedData);
      
      const finalResult = {
        data: extractedData,
        confidence: result.confidence || 0.8
      };
      
      console.log('🎉 [数据提取工具-AI] AI数据提取完成');
      console.log('📤 [数据提取工具-AI] 返回结果:', finalResult);
      
      return this.createSuccessResponse(finalResult);
      
    } catch (error) {
      console.error('❌ [数据提取工具-AI] AI数据提取失败:', error);
      return this.createErrorResponse('AI数据提取请求失败', error);
    }
  }

  /**
   * 验证和转换数据类型
   */
  private validateAndConvertData(data: any, expectedType: string): any {
    console.log('🔄 [数据提取工具-验证] 开始数据验证和转换');
    console.log('📥 [数据提取工具-验证] 输入数据:', data);
    console.log('🎯 [数据提取工具-验证] 目标类型:', expectedType);
    
    switch (expectedType) {
      case 'string': {
        const stringResult = String(data);
        console.log('📝 [数据提取工具-验证] 字符串转换:', data, '->', stringResult);
        return stringResult;
      }
        
      case 'number': {
        const num = typeof data === 'string' ? parseFloat(data.replace(/[^\d.-]/g, '')) : Number(data);
        const numberResult = isNaN(num) ? 0 : num;
        console.log('🔢 [数据提取工具-验证] 数字转换:', data, '->', numberResult);
        return numberResult;
      }
        
      case 'boolean': {
        let booleanResult;
        if (typeof data === 'boolean') {
          booleanResult = data;
        } else if (typeof data === 'string') {
          booleanResult = data.toLowerCase() === 'true' || data === '1' || data === 'yes';
        } else {
          booleanResult = Boolean(data);
        }
        console.log('✅ [数据提取工具-验证] 布尔转换:', data, '->', booleanResult);
        return booleanResult;
      }
        
      case 'array': {
        const arrayResult = Array.isArray(data) ? data : [data];
        console.log('📋 [数据提取工具-验证] 数组转换:', data, '->', arrayResult);
        return arrayResult;
      }
        
      case 'object': {
        const objectResult = typeof data === 'object' && data !== null ? data : { value: data };
        console.log('📦 [数据提取工具-验证] 对象转换:', data, '->', objectResult);
        return objectResult;
      }
        
      default:
        console.log('🔄 [数据提取工具-验证] 默认返回原数据:', data);
        return data;
    }
  }

  /**
   * 预定义的数据提取模板
   */
  static getCommonExtractionTemplates() {
    return {
      price: {
        description: '商品价格',
        dataType: 'number',
        commonSelectors: ['.price', '[data-price]', '.amount', '.cost']
      },
      title: {
        description: '页面标题',
        dataType: 'string',
        commonSelectors: ['h1', '.title', '[data-title]', '.heading']
      },
      description: {
        description: '描述文本',
        dataType: 'string',
        commonSelectors: ['.description', '.desc', '[data-description]', '.content']
      },
      rating: {
        description: '评分',
        dataType: 'number',
        commonSelectors: ['.rating', '.score', '[data-rating]', '.stars']
      },
      list: {
        description: '列表项',
        dataType: 'array',
        multiple: true,
        commonSelectors: ['li', '.item', '.list-item', '[data-item]']
      }
    };
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
}

// 导出工具实例
export const extractDataTool = new ExtractDataTool();
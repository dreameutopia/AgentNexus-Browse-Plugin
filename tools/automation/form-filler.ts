/**
 * 表单填充工具
 * 智能填充页面表单
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';

interface FormFillerParams {
  formData: string; // JSON格式的表单数据
  autoSubmit?: boolean; // 是否自动提交
}

interface FormFillerResult {
  success: boolean;
  filledFields: number;
  submittedForm: boolean;
  message: string;
}

export class FormFillerTool extends BaseTool {
  name = 'formFiller';
  
  metadata: ToolMetadata = {
    name: 'formFiller',
    description: '智能表单填充',
    category: 'automation',
    tags: ['form', 'fill', 'automation'],
    version: '1.0.0',
    author: 'System'
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'formFiller',
      description: '智能填充页面表单',
      parameters: {
        type: 'object',
        properties: {
          formData: {
            type: 'string',
            description: 'JSON格式的表单数据，例如: {"name": "张三", "email": "zhangsan@example.com"}'
          },
          autoSubmit: {
            type: 'boolean',
            description: '是否自动提交表单',
            default: false
          }
        },
        required: ['formData']
      }
    }
  };

  async execute(args: FormFillerParams): Promise<ToolResult> {
    console.log('📝 [表单填充工具] 开始执行');
    console.log('📥 [表单填充工具] 接收参数:', args);
    
    try {
      this.validateArgs(args, ['formData']);
      
      const { formData, autoSubmit = false } = args;
      
      // 解析表单数据
      let parsedFormData: Record<string, any>;
      try {
        parsedFormData = JSON.parse(formData);
      } catch (error) {
        console.error('❌ [表单填充工具] 表单数据JSON解析失败:', error);
        return this.createErrorResponse('表单数据格式错误，请提供有效的JSON格式', error);
      }
      
      console.log('📋 [表单填充工具] 解析的表单数据:', parsedFormData);
      
      // 获取当前活动标签页
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        console.error('❌ [表单填充工具] 未找到活动标签页');
        return this.createErrorResponse('未找到活动标签页');
      }
      
      const tabId = tabs[0].id!;
      console.log('🎯 [表单填充工具] 目标标签页ID:', tabId);
      
      // 注入表单填充脚本
      console.log('💉 [表单填充工具] 正在注入表单填充脚本...');
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: this.fillFormScript,
        args: [parsedFormData, autoSubmit]
      });
      
      if (!results || results.length === 0) {
        console.error('❌ [表单填充工具] 脚本执行失败');
        return this.createErrorResponse('脚本执行失败');
      }
      
      const result = results[0].result as FormFillerResult;
      console.log('📤 [表单填充工具] 脚本执行结果:', result);
      
      if (result.success) {
        this.log(`成功填充 ${result.filledFields} 个字段${result.submittedForm ? '，并提交了表单' : ''}`);
        return this.createSuccessResponse(result, result.message);
      } else {
        console.error('❌ [表单填充工具] 表单填充失败:', result.message);
        return this.createErrorResponse('表单填充失败', result.message);
      }
      
    } catch (error) {
      console.error('💥 [表单填充工具] 执行过程中发生错误:', error);
      return this.createErrorResponse('表单填充失败', error);
    }
  }

  /**
   * 在页面中执行的表单填充脚本
   */
  private fillFormScript(formData: Record<string, any>, autoSubmit: boolean): FormFillerResult {
    try {
      console.log('📝 [页面脚本] 开始填充表单:', formData);
      
      let filledFields = 0;
      const errors: string[] = [];
      
      // 遍历表单数据
      for (const [key, value] of Object.entries(formData)) {
        try {
          // 尝试多种选择器策略
          const selectors = [
            `input[name="${key}"]`,
            `input[id="${key}"]`,
            `textarea[name="${key}"]`,
            `textarea[id="${key}"]`,
            `select[name="${key}"]`,
            `select[id="${key}"]`,
            `input[placeholder*="${key}"]`,
            `input[aria-label*="${key}"]`
          ];
          
          let element: HTMLElement | null = null;
          
          // 尝试找到匹配的元素
          for (const selector of selectors) {
            element = document.querySelector(selector) as HTMLElement;
            if (element) break;
          }
          
          if (!element) {
            console.warn(`⚠️ [页面脚本] 未找到字段: ${key}`);
            errors.push(`未找到字段: ${key}`);
            continue;
          }
          
          // 根据元素类型填充值
          if (element instanceof HTMLInputElement) {
            const input = element as HTMLInputElement;
            
            if (input.type === 'checkbox' || input.type === 'radio') {
              input.checked = Boolean(value);
            } else {
              input.value = String(value);
            }
            
            // 触发change事件
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            
          } else if (element instanceof HTMLTextAreaElement) {
            const textarea = element as HTMLTextAreaElement;
            textarea.value = String(value);
            
            // 触发change事件
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            
          } else if (element instanceof HTMLSelectElement) {
            const select = element as HTMLSelectElement;
            select.value = String(value);
            
            // 触发change事件
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
          
          filledFields++;
          console.log(`✅ [页面脚本] 成功填充字段: ${key} = ${value}`);
          
        } catch (fieldError) {
          console.error(`❌ [页面脚本] 填充字段 ${key} 时出错:`, fieldError);
          errors.push(`填充字段 ${key} 时出错: ${fieldError}`);
        }
      }
      
      let submittedForm = false;
      
      // 自动提交表单
      if (autoSubmit && filledFields > 0) {
        try {
          console.log('🚀 [页面脚本] 正在自动提交表单...');
          
          // 尝试找到提交按钮
          const submitSelectors = [
            'input[type="submit"]',
            'button[type="submit"]',
            'button:contains("提交")',
            'button:contains("确定")',
            'button:contains("登录")',
            'button:contains("注册")',
            '.submit-btn',
            '.btn-submit'
          ];
          
          let submitButton: HTMLElement | null = null;
          
          for (const selector of submitSelectors) {
            submitButton = document.querySelector(selector) as HTMLElement;
            if (submitButton) break;
          }
          
          if (submitButton) {
            submitButton.click();
            submittedForm = true;
            console.log('✅ [页面脚本] 表单提交成功');
          } else {
            // 尝试直接提交表单
            const form = document.querySelector('form') as HTMLFormElement;
            if (form) {
              form.submit();
              submittedForm = true;
              console.log('✅ [页面脚本] 表单直接提交成功');
            } else {
              console.warn('⚠️ [页面脚本] 未找到可提交的表单或按钮');
            }
          }
          
        } catch (submitError) {
          console.error('❌ [页面脚本] 表单提交失败:', submitError);
          errors.push(`表单提交失败: ${submitError}`);
        }
      }
      
      const message = `成功填充 ${filledFields} 个字段${submittedForm ? '，并提交了表单' : ''}${errors.length > 0 ? `。错误: ${errors.join('; ')}` : ''}`;
      
      return {
        success: filledFields > 0,
        filledFields,
        submittedForm,
        message
      };
      
    } catch (error) {
      console.error('💥 [页面脚本] 表单填充脚本执行失败:', error);
      return {
        success: false,
        filledFields: 0,
        submittedForm: false,
        message: `表单填充失败: ${error}`
      };
    }
  }
}

// 导出工具实例
export const formFillerTool = new FormFillerTool();
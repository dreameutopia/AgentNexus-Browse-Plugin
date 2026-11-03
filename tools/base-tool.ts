/**
 * 基础工具类
 * 提供标准的工具实现模板
 */

import { ToolResult, createErrorResponse, buildSuccessPayload } from '@/common/tool-handler';
import { ExtendedTool, ToolMetadata, toolRegistry } from './registry';
import { OpenAITool } from '@/common/openai-types';

/**
 * 判定是否为「仅限 background 上下文」错误。
 * 这类错误必须向上抛出而非转为错误结果：tool-executor 依据该消息把整个工具
 * 调用转发到 background 执行；若在组合工具内部被吞掉（转为普通错误结果），
 * 转发时机将永远无法触发（bing_search 等依赖 browser_navigate 的工具即败于此）。
 */
function isBackgroundContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('background context');
}

/**
 * 抽象基础工具类
 */
export abstract class BaseTool implements ExtendedTool {
  abstract name: string;
  abstract metadata: ToolMetadata;
  abstract openaiSchema: OpenAITool;

  /**
   * 执行工具
   */
  abstract execute(args: any): Promise<ToolResult>;

  /**
   * 验证参数
   */
  protected validateArgs(args: any, required: string[]): void {
    for (const field of required) {
      if (args[field] === undefined || args[field] === null) {
        throw new Error(`Missing required parameter: ${field}`);
      }
    }
  }

  /**
   * 创建成功响应（拼装规则收敛到 common/tool-handler.buildSuccessPayload，
   * 与技能合成激活轮的 load_skill 结果逐字同源）
   */
  protected createSuccessResponse(data: any, message?: string): ToolResult {
    return {
      success: true,
      ...buildSuccessPayload(data, message),
    };
  }

  /**
   * 创建错误响应
   */
  protected createErrorResponse(message: string, error?: any): ToolResult {
    return createErrorResponse(`[${this.name}] ${message}${error ? `: ${error.message || error}` : ''}`);
  }

  /**
   * 记录日志
   */
  protected log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const logMessage = `[${this.name}] ${message}`;
    switch (level) {
      case 'info':
        console.log(logMessage);
        break;
      case 'warn':
        console.warn(logMessage);
        break;
      case 'error':
        console.error(logMessage);
        break;
    }
  }
}

/**
 * 导航类工具基类
 */
export abstract class BaseNavigationTool extends BaseTool {
  protected async navigateToUrl(url: string, options?: {
    newWindow?: boolean;
    waitForLoad?: boolean;
    timeout?: number;
  }): Promise<ToolResult> {
    try {
      this.log(`Navigating to: ${url}`);
      // 通过注册表获取 navigateTool，避免循环依赖
      const navTool = toolRegistry.get('browser_navigate');
      if (!navTool) {
        return this.createErrorResponse('Navigation tool not available');
      }
      return await navTool.execute({
        url,
        newWindow: false,
        waitForLoad: true,
        timeout: options?.timeout || 50000
      });
    } catch (error) {
      // 上下文错误上抛：交由 tool-executor 将本工具整体转发到 background 执行
      if (isBackgroundContextError(error)) throw error;
      return this.createErrorResponse('Navigation failed', error);
    }
  }
}

/**
 * 搜索类工具基类
 */
export abstract class BaseSearchTool extends BaseTool {
  protected abstract getSearchUrl(query: string): string;
  protected abstract getSearchEngine(): string;

  /**
   * 导航到指定 URL（与 BaseNavigationTool 相同的实现）
   */
  protected async navigateToUrl(url: string, options?: {
    newWindow?: boolean;
    waitForLoad?: boolean;
    timeout?: number;
  }): Promise<ToolResult> {
    try {
      this.log(`Navigating to: ${url}`);
      // 通过注册表获取 navigateTool，避免循环依赖
      const navTool = toolRegistry.get('browser_navigate');
      if (!navTool) {
        return this.createErrorResponse('Navigation tool not available');
      }
      return await navTool.execute({
        url,
        newWindow: false,
        waitForLoad: true,
        timeout: options?.timeout || 50000
      });
    } catch (error) {
      // 上下文错误上抛：交由 tool-executor 将本工具整体转发到 background 执行
      if (isBackgroundContextError(error)) throw error;
      return this.createErrorResponse('Navigation failed', error);
    }
  }

  /**
   * 等待页面加载完成
   */
  protected async waitForPageLoad(timeout?: number): Promise<ToolResult> {
    try {
      // 简单等待页面就绪
      await new Promise(resolve => setTimeout(resolve, 1000));
      return this.createSuccessResponse({ loaded: true }, 'Page loaded');
    } catch (error) {
      return this.createErrorResponse('Wait for page load failed', error);
    }
  }

  async execute(args: { query: string }): Promise<ToolResult> {
    try {
      this.validateArgs(args, ['query']);
      
      const { query } = args;
      const searchUrl = this.getSearchUrl(query);
      
      this.log(`Searching "${query}" on ${this.getSearchEngine()}`);
      
      // 通过注册表获取 navigateTool 导航并等待页面加载
      const navTool = toolRegistry.get('browser_navigate');
      if (!navTool) {
        return this.createErrorResponse('Navigation tool not available');
      }
      const result = await navTool.execute({
        url: searchUrl,
        newWindow: false,
        waitForLoad: true,
        timeout: 30000
      });
      
      if (!result.success) {
        return this.createErrorResponse('Navigation failed', result.error);
      }
      
      // 统一返回格式
      return this.createSuccessResponse(
        {
          url: searchUrl,
          query,
          searchEngine: this.getSearchEngine()
        },
        `已成功导航至:${searchUrl}，页面加载成功`
      );
      
    } catch (error) {
      // 上下文错误上抛：让 tool-executor 把整个搜索工具转发到 background 执行
      // （在 background 中 browser_navigate 原生可用），否则会以普通错误结果
      // 吞掉转发时机，导致 sidepanel 发起的搜索永远失败
      if (isBackgroundContextError(error)) throw error;
      return this.createErrorResponse('Search failed', error);
    }
  }
}

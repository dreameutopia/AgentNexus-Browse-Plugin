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
 * 转发时机将永远无法触发（依赖 browser_navigate 的组合工具即败于此）。
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
 *
 * 注：原 BaseSearchTool（9 个平台 *_search 纯导航工具的基类）已随统一搜索
 * web_search 的落地移除——新工具自带导航（chrome.tabs）与解析，不再经由
 * browser_navigate 组合，也不再需要 background 上下文转发舞蹈。
 */
export abstract class BaseNavigationTool extends BaseTool {
  protected async navigateToUrl(url: string, options?: {
    newTab?: boolean;
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
        newTab: options?.newTab ?? true,
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


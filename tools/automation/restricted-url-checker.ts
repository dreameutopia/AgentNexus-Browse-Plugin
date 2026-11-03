/**
 * 受限URL检查工具
 * 检查当前页面是否在 chrome:// 或 edge:// 等受限URL上
 * 如果是，则自动导航到 https://www.bing.com/
 */

import { BaseTool, BaseNavigationTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';
import { RESTRICTED_URL_PREFIXES } from '@/common/constants';

// 受限URL前缀列表（统一维护于 common/constants.ts，与页面执行引擎共享）

// 默认安全导航目标
const DEFAULT_SAFE_URL = 'https://www.bing.com/';

export class RestrictedUrlCheckerTool extends BaseNavigationTool {
  name = 'check_restricted_url';

  metadata: ToolMetadata = {
    name: 'check_restricted_url',
    description: '检查当前页面是否在受限URL（如 chrome://、edge:// 等），如果是则自动导航到安全页面',
    category: 'automation',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['url', 'navigation', 'restricted', 'permission', 'safety']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'check_restricted_url',
      description: 'Check if the current page is on a restricted URL (chrome://, edge://, etc.) where extension operations are not permitted. If on a restricted page, automatically navigates to a safe page (default: https://www.bing.com/). Returns the check result and navigation status.',
      parameters: {
        type: 'object',
        properties: {
          targetUrl: {
            type: 'string',
            description: 'Custom safe URL to navigate to if on restricted page (optional, default: https://www.bing.com/)',
            default: DEFAULT_SAFE_URL
          },
          autoNavigate: {
            type: 'boolean',
            description: 'Whether to automatically navigate away from restricted page (default: true)',
            default: true
          }
        },
        required: []
      }
    }
  };

  /**
   * 检查URL是否为受限URL
   */
  private isRestrictedUrl(url: string | undefined): boolean {
    if (!url) return true; // 无URL视为受限
    
    const lowerUrl = url.toLowerCase();
    return RESTRICTED_URL_PREFIXES.some(prefix => lowerUrl.startsWith(prefix));
  }

  /**
   * 获取URL的受限类型
   */
  private getRestrictedType(url: string): string {
    const lowerUrl = url.toLowerCase();
    for (const prefix of RESTRICTED_URL_PREFIXES) {
      if (lowerUrl.startsWith(prefix)) {
        return prefix.replace('://', '');
      }
    }
    return 'unknown';
  }

  async execute(args: {
    targetUrl?: string;
    autoNavigate?: boolean;
  }): Promise<ToolResult> {
    try {
      const {
        targetUrl = DEFAULT_SAFE_URL,
        autoNavigate = true
      } = args;

      this.log('Checking current page URL for restrictions...');

      // 获取当前活动标签页
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!activeTab) {
        return this.createErrorResponse('No active tab found');
      }

      const currentUrl = activeTab.url || '';
      const tabId = activeTab.id;
      const isRestricted = this.isRestrictedUrl(currentUrl);

      this.log(`Current URL: ${currentUrl}, Restricted: ${isRestricted}`);

      // 如果不是受限URL，直接返回
      if (!isRestricted) {
        return this.createSuccessResponse({
          isRestricted: false,
          currentUrl,
          tabId,
          message: 'Current page is accessible, no navigation needed'
        }, 'Page is accessible');
      }

      // 是受限URL
      const restrictedType = this.getRestrictedType(currentUrl);
      
      // 如果不自动导航，仅返回检测结果
      if (!autoNavigate) {
        return this.createSuccessResponse({
          isRestricted: true,
          restrictedType,
          currentUrl,
          tabId,
          navigated: false,
          message: `Current page (${restrictedType}://) is restricted. Auto-navigation disabled.`
        }, 'Restricted page detected');
      }

      // 执行导航到安全页面
      this.log(`Navigating from restricted page to: ${targetUrl}`);

      // 使用基类的导航方法
      const navigationResult = await this.navigateToUrl(targetUrl, {
        waitForLoad: true,
        timeout: 30000
      });

      if (!navigationResult.success) {
        return this.createErrorResponse(
          `Failed to navigate away from restricted page: ${navigationResult.data?.error || 'Unknown error'}`
        );
      }

      return this.createSuccessResponse({
        isRestricted: true,
        restrictedType,
        originalUrl: currentUrl,
        navigatedTo: targetUrl,
        tabId,
        navigated: true,
        message: `Successfully navigated from restricted ${restrictedType}:// page to ${targetUrl}`
      }, 'Navigation completed');

    } catch (error) {
      return this.createErrorResponse('Failed to check restricted URL', error);
    }
  }
}

// 导出工具实例
export const restrictedUrlCheckerTool = new RestrictedUrlCheckerTool();

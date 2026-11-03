/**
 * 快捷导航工具
 * 提供常用网站的快速访问功能
 */

import { BaseNavigationTool } from '../base-tool';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';

// 预定义的网站列表
const QUICK_SITES = {
  // 搜索引擎
  'google': 'https://www.google.com',
  'baidu': 'https://www.baidu.com',
  'bing': 'https://www.bing.com',
  
  // 学习平台
  'zhihu': 'https://www.zhihu.com',
  'csdn': 'https://www.csdn.net',
  'stackoverflow': 'https://stackoverflow.com',
  'github': 'https://github.com',
  'gitee': 'https://gitee.com',
  
  // 在线教育
  'mooc': 'https://www.icourse163.org',
  'coursera': 'https://www.coursera.org',
  'edx': 'https://www.edx.org',
  'udemy': 'https://www.udemy.com',
  
  // 文档和工具
  'mdn': 'https://developer.mozilla.org',
  'w3schools': 'https://www.w3schools.com',
  'runoob': 'https://www.runoob.com',
  'leetcode': 'https://leetcode.com',
  'leetcode-cn': 'https://leetcode.cn',
  
  // 社交和媒体
  'youtube': 'https://www.youtube.com',
  'bilibili': 'https://www.bilibili.com',
  'twitter': 'https://twitter.com',
  'reddit': 'https://www.reddit.com',
  
  // 工作和生产力
  'gmail': 'https://mail.google.com',
  'outlook': 'https://outlook.live.com',
  'notion': 'https://www.notion.so',
  'trello': 'https://trello.com',
  'slack': 'https://slack.com',
  
  // 云服务
  'aws': 'https://aws.amazon.com',
  'azure': 'https://portal.azure.com',
  'gcp': 'https://console.cloud.google.com',
  'vercel': 'https://vercel.com',
  'netlify': 'https://www.netlify.com'
} as const;

export class QuickNavigationTool extends BaseNavigationTool {
  name = 'quick_navigation';
  
  metadata: ToolMetadata = {
    name: 'quick_navigation',
    description: '快速导航到常用网站',
    category: 'navigation',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['navigation', 'quick', 'websites', 'shortcuts']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'quick_navigation',
      description: '快速导航到常用网站，支持预定义的网站快捷方式',
      parameters: {
        type: 'object',
        properties: {
          site: {
            type: 'string',
            enum: Object.keys(QUICK_SITES),
            description: `要访问的网站快捷名称。可选值：${Object.keys(QUICK_SITES).join(', ')}`
          },
          url: {
            type: 'string',
            description: '自定义URL地址（当site参数未提供时使用）'
          },
          newWindow: {
            type: 'boolean',
            description: '是否在新窗口中打开',
            default: false
          }
        },
        required: []
      }
    }
  };

  async execute(args: {
    site?: keyof typeof QUICK_SITES;
    url?: string;
    newWindow?: boolean;
  }): Promise<ToolResult> {
    try {
      const { site, url, newWindow = false } = args;
      
      let targetUrl: string;
      let siteName: string;
      
      if (site && QUICK_SITES[site]) {
        targetUrl = QUICK_SITES[site];
        siteName = site;
        this.log(`Quick navigating to ${siteName}: ${targetUrl}`);
      } else if (url) {
        targetUrl = url;
        siteName = 'custom URL';
        this.log(`Navigating to custom URL: ${targetUrl}`);
      } else {
        return this.createErrorResponse('Either site or url parameter must be provided');
      }
      
      const result = await this.navigateToUrl(targetUrl, { newWindow });
      
      if (!result.success) {
        return result;
      }
      
      return this.createSuccessResponse({
        site: siteName,
        url: targetUrl,
        newWindow,
        availableSites: Object.keys(QUICK_SITES)
      }, `Successfully navigated to ${siteName}`);
      
    } catch (error) {
      return this.createErrorResponse('Quick navigation failed', error);
    }
  }

  /**
   * 获取所有可用的快捷网站
   */
  getAvailableSites(): Record<string, string> {
    return { ...QUICK_SITES };
  }

  /**
   * 添加自定义快捷网站
   */
  addCustomSite(name: string, url: string): void {
    (QUICK_SITES as any)[name] = url;
    this.log(`Added custom site: ${name} -> ${url}`);
  }
}
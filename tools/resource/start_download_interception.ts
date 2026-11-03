// tools/start_download_interception.ts

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

// 默认拦截的文件类型列表
const DEFAULT_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'mp4', 'mp3', 'zip', 'rar', 'md', 'xlsx', 'xls'
];

/**
 * 开启下载拦截工具类
 */
export class StartDownloadInterceptionTool extends BaseTool {
  name = 'start_download_interception';

  metadata: ToolMetadata = {
    name: this.name,
    description: '开启文件下载拦截器，当用户下载指定类型文件时，插件将自动捕获一份副本。',
    category: 'resource',
    version: '1.0.0',
    author: 'Gemini',
    tags: ['download', 'interception', 'automation', 'file management']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description: '启动文件下载拦截功能。允许添加额外的文件扩展名到默认拦截列表。',
      parameters: {
        type: 'object',
        properties: {
          extra_extensions: {
            type: 'array',
            items: { type: 'string' },
            description: '需要额外拦截的文件扩展名数组，例如 ["jpg", "png"]',
          },
        },
        required: [],
      },
    },
  };

  async execute(args: { extra_extensions?: string[] } = {}): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      this.log(`开始执行下载拦截器启动流程...`);

      // 1. 计算最终需要拦截的扩展名列表
      const additionalExts = args.extra_extensions || [];
      const finalExtensions = [...new Set([...DEFAULT_EXTENSIONS, ...additionalExts.map(ext => ext.toLowerCase())])];
      
      this.log(`最终拦截列表: ${finalExtensions.join(', ')}`);

      // 2. 发送消息到后台脚本，要求更新拦截规则并启动监听器
      // 后台脚本需要监听此消息，并将规则和状态保存到 chrome.storage.local 中
      await chrome.runtime.sendMessage({
        command: 'startInterception',
        payload: {
          interceptExtensions: finalExtensions,
        },
      });

      const duration = Date.now() - startTime;
      this.log(`拦截器已成功启动并更新规则，耗时: ${duration}ms`);

      return this.createSuccessResponse(
        { status: 'enabled', activeExtensions: finalExtensions },
        `Download interception activated successfully for extensions: ${finalExtensions.join(', ')}.`
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.log(`启动拦截器失败，耗时: ${duration}ms`, 'error');
      return this.createErrorResponse('Failed to start download interception', error);
    }
  }
}

export const startDownloadInterceptionTool = new StartDownloadInterceptionTool();
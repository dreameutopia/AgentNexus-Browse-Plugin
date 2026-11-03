// tools/clear_captured_files.ts

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

/**
 * 清空所有已捕获的文件缓存工具类
 */
export class ClearCapturedFilesTool extends BaseTool {
  name = 'clear_captured_files';

  metadata: ToolMetadata = {
    name: this.name,
    description: '删除所有通过拦截器捕获并缓存在插件内部的文件数据。',
    category: 'resource',
    version: '1.0.0',
    author: 'Gemini',
    tags: ['download', 'cache', 'cleanup', 'file management']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description: '清空所有已捕获的文件缓存。这是一个不可逆操作。',
      parameters: { type: 'object', properties: {} },
    },
  };

  async execute(): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      this.log(`开始执行清空缓存操作...`);

      // 发送消息到后台脚本，要求清空 IndexedDB 数据库
      const response = await chrome.runtime.sendMessage({ command: 'clearAllCapturedFiles' });
      const clearedCount = response.clearedCount || 0;

      const duration = Date.now() - startTime;
      this.log(`缓存清空完毕，共删除 ${clearedCount} 个文件，耗时: ${duration}ms`);

      return this.createSuccessResponse(
        { clearedCount },
        `Successfully cleared ${clearedCount} captured files from cache.`
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.log(`清空缓存失败，耗时: ${duration}ms`, 'error');
      return this.createErrorResponse('Failed to clear captured files cache', error);
    }
  }
}
// tools/stop_download_interception.ts

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

/**
 * 停止下载拦截工具类，并获取已捕获文件列表
 */
export class StopDownloadInterceptionTool extends BaseTool {
  name = 'stop_download_interception';

  metadata: ToolMetadata = {
    name: this.name,
    description: '停止文件下载拦截器，并获取所有已捕获文件的列表摘要。',
    category: 'resource',
    version: '1.0.0',
    author: 'Gemini',
    tags: ['download', 'interception', 'automation', 'file management']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description: '关闭文件下载拦截功能，并返回当前缓存中所有已捕获文件的摘要列表。',
      parameters: { type: 'object', properties: {} },
    },
  };

  async execute(): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      this.log(`开始执行停止拦截并获取列表...`);

      // 1. 发送消息到后台脚本，要求停止监听器
      const stopResponse = await chrome.runtime.sendMessage({ command: 'stopInterception' });
      this.log(`停止拦截指令已发送，响应:`, stopResponse);
      
      if (!stopResponse || !stopResponse.success) {
        throw new Error(stopResponse?.error || 'Failed to stop interception');
      }

      // 2. 发送消息到后台脚本，请求获取文件列表
      // 后台脚本从 IndexedDB 读取元数据列表返回
      const listResponse = await chrome.runtime.sendMessage({ command: 'getCapturedFileList' });
      this.log(`获取文件列表响应:`, listResponse);
      
      if (!listResponse || !listResponse.success) {
        throw new Error(listResponse?.error || 'Failed to get captured file list');
      }
      
      const fileList = listResponse.fileList || [];
      const duration = Date.now() - startTime;
      this.log(`获取列表完成，共 ${fileList.length} 个文件，耗时: ${duration}ms`);

      return this.createSuccessResponse(
        { status: 'disabled', capturedFilesCount: fileList.length, files: fileList },
        `Interception stopped. Retrieved ${fileList.length} captured file records.`
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.log(`停止拦截或获取列表失败，耗时: ${duration}ms: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return this.createErrorResponse('Failed to stop interception or retrieve file list', error);
    }
  }
}
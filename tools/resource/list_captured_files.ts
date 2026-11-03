// tools/list_captured_files.ts

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

/**
 * 查看已捕获文件列表工具类（不停止拦截）
 */
export class ListCapturedFilesTool extends BaseTool {
  name = 'list_captured_files';

  metadata: ToolMetadata = {
    name: this.name,
    description: '查看当前缓存中所有已捕获文件的列表，不会停止正在进行的文件拦截。',
    category: 'resource',
    version: '1.0.0',
    author: 'Gemini',
    tags: ['download', 'file management', 'list', 'cache']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description: '获取当前缓存中所有已捕获文件的详细列表，包括文件名、大小、捕获时间等信息。此操作不会影响正在进行的文件拦截。',
      parameters: { type: 'object', properties: {} },
    },
  };

  async execute(): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      this.log(`开始获取已捕获文件列表...`);

      // 发送消息到后台脚本，请求获取文件列表
      const response = await chrome.runtime.sendMessage({ command: 'getCapturedFileList' });
      
      if (!response.success) {
        throw new Error(response.error || 'Failed to get captured file list');
      }
      
      const fileList = response.fileList || [];
      const duration = Date.now() - startTime;
      this.log(`获取文件列表完成，共 ${fileList.length} 个文件，耗时: ${duration}ms`);

      // 格式化文件信息以便显示
      const formattedFiles = fileList.map((file: any) => ({
        id: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : 'Unknown',
        capturedAt: new Date(file.capturedAt).toLocaleString(),
        sourcePageUrl: file.sourcePageUrl
      }));

      return this.createSuccessResponse(
        { 
          totalCount: fileList.length, 
          files: formattedFiles,
          timestamp: new Date().toISOString()
        },
        `Found ${fileList.length} captured files in cache. Interception remains active.`
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.log(`获取文件列表失败，耗时: ${duration}ms`, 'error');
      return this.createErrorResponse('Failed to retrieve captured file list', error);
    }
  }
}
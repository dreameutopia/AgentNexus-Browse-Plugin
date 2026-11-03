// tools/get_captured_file_by_id.ts

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

/**
 * 根据ID获取特定捕获文件的信息工具类
 */
export class GetCapturedFileTool extends BaseTool {
  name = 'get_captured_file_by_id';

  metadata: ToolMetadata = {
    name: this.name,
    description: '根据提供的ID检索特定捕获文件的详细信息（如文件名、来源等）。',
    category: 'resource',
    version: '1.0.0',
    author: 'Gemini',
    tags: ['download', 'retrieval', 'file management']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description: '根据文件ID获取已捕获文件的元数据，用于后续处理或上传。',
      parameters: {
        type: 'object',
        properties: {
          file_id: {
            type: 'string', // 或者 number，取决于您在后台生成ID的方式
            description: '要检索的文件的唯一ID。',
          },
        },
        required: ['file_id'],
      },
    },
  };

  async execute(args: { file_id: string }): Promise<ToolResult> {
    const startTime = Date.now();
    const { file_id } = args;

    if (!file_id) {
      return this.createErrorResponse('File ID parameter is missing');
    }

    try {
      this.log(`正在检索文件ID: ${file_id} ...`);

      // 发送消息到后台脚本，请求获取特定文件的元数据
      const response = await chrome.runtime.sendMessage({
        command: 'getFileDetailsById',
        payload: { id: file_id },
      });

      if (response.success && response.fileDetails) {
        const duration = Date.now() - startTime;
        this.log(`文件检索成功，耗时: ${duration}ms`);
        return this.createSuccessResponse(
          response.fileDetails,
          `File details retrieved successfully for ID: ${file_id}.`
        );
      } else {
        throw new Error(response.error || 'File not found or access denied.');
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.log(`检索文件 ${file_id} 失败，耗时: ${duration}ms`, 'error');
      return this.createErrorResponse(`Failed to retrieve file with ID ${file_id}`, error);
    }
  }
}

export const getCapturedFileTool = new GetCapturedFileTool();
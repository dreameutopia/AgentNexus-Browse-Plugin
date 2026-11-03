import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

export class GenericWaitTool extends BaseTool {
  name = 'generic_wait';
  
  metadata: ToolMetadata = {
    name: 'generic_wait',
    description: '通用等待工具，等待指定秒数后返回',
    category: 'common',
    version: '1.0.0',
    author: 'Chrome Extension',
    tags: ['utility', 'wait', 'delay']
  };
  
  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'generic_wait',
      description: '通用等待工具，等待指定秒数后返回',
      parameters: {
        type: 'object',
        properties: {
          waitSeconds: {
            type: 'number',
            description: '等待的秒数',
            minimum: 0
          }
        },
        required: ['waitSeconds']
      }
    }
  };

  async execute(params: { waitSeconds: number }): Promise<ToolResult> {
    const { waitSeconds } = params;
    
    if (waitSeconds < 0) {
      return {
        success: false,
        message: '等待时间不能为负数'
      };
    }

    // 等待指定的秒数
    await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
    
    return {
      success: true,
      message: `成功等待了 ${waitSeconds} 秒`
    };
  }
}

export const genericWaitTool = new GenericWaitTool();
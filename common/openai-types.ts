/**
 * OpenAI 工具类型定义
 * 独立模块，避免循环依赖
 */

// OpenAI工具格式定义
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      additionalProperties?: boolean;
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

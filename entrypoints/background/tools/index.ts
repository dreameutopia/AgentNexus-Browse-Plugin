import { createErrorResponse } from '@/common/tool-handler';
import { executeWithBrowserScope } from '@/tools/browser/browser-scope';
import { ERROR_MESSAGES } from '@/common/constants';
import { toolRegistry as highLevelToolRegistry, type ToolExecutionContext } from '@/tools/registry';

/**
 * Tool call parameter interface
 */
export interface ToolCallParam {
  name: string;
  args: any;
  context?: ToolExecutionContext;
}

/**
 * Handle tool execution
 * 所有工具现在统一通过 toolRegistry 管理
 */
export const handleCallTool = async (param: ToolCallParam) => {
  // 在统一的工具注册表中查找
  const tool = highLevelToolRegistry.getTool(param.name);
  if (tool) {
    try {
      return await executeWithBrowserScope(param.context, context => tool.execute(param.args, context));
    } catch (error) {
      console.error(`Tool execution failed for ${param.name}:`, error);
      return createErrorResponse(
        error instanceof Error ? error.message : ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
      );
    }
  }

  // 工具未找到
  return createErrorResponse(`Tool ${param.name} not found`);
};

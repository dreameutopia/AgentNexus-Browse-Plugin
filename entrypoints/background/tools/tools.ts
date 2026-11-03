/**
 * 工具调用处理器
 * 负责执行工具并返回标准格式的结果
 */

import { toolRegistry as highLevelToolRegistry } from '@/tools';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';

/**
 * 工具调用参数接口
 */
export interface ToolCallParams {
  name: string;
  args: any;
}

/**
 * 处理工具调用
 * @param params 工具调用参数
 * @returns 工具执行结果
 */
export async function handleCallTool(params: ToolCallParams): Promise<ToolResult> {
  const { name, args } = params;

  console.log(`[Tools] 执行工具: ${name}`, args);

  try {
    // 从高级工具注册表获取工具
    const tool = highLevelToolRegistry.get(name);

    if (!tool) {
      console.error(`[Tools] 工具不存在: ${name}`);
      return createErrorResponse(`工具不存在: ${name}`);
    }

    // 执行工具
    const result = await tool.execute(args || {});

    console.log(`[Tools] 工具执行完成: ${name}`, {
      success: result.success !== false,
      hasData: !!result.data,
      hasContent: !!result.content
    });

    return result;
  } catch (error) {
    console.error(`[Tools] 工具执行失败: ${name}`, error);
    return createErrorResponse(
      `工具执行失败: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

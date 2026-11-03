import type { CallToolResult, TextContent, ImageContent } from '@modelcontextprotocol/sdk/types.js';

/**
 * 工具执行结果。
 *
 * 注意：`content` 是可选的。项目中大量工具返回的是 `{ success, message|error, data }`
 * 这种「业务结果」形态，而没有携带 MCP 风格的 `content` 内容块（消费方
 * `formatToolResult` / `formatResult` 均已对 `content` 缺失做分支处理）。
 * 因此这里用 Omit 收窄基类的必填 `content`，避免类型与真实运行时不一致。
 */
export interface ToolResult extends Omit<CallToolResult, 'content'> {
  success: boolean;
  content?: CallToolResult['content'];
  /** MCP 错误标记（显式声明，避免 Omit 之后只剩索引签名而丢掉窄类型） */
  isError?: boolean;
  data?: any;
  error?: string;
  /** 部分工具用 message 而非 error 承载提示文案 */
  message?: string;
}

export interface ToolExecutor {
  execute(args: any): Promise<ToolResult>;
}

export const createErrorResponse = (
  message: string = 'Unknown error, please try again',
): ToolResult => {
  return {
    success: false,
    error: message,
    content: [
      {
        type: 'text',
        text: message
      }
    ]
  };
};

/**
 * 成功响应的 content / data 载荷（`BaseTool.createSuccessResponse` 与技能合成
 * 激活轮共用的唯一拼装规则）：
 *   - `data` = `{ message, ...业务数据 }`（message 缺省为通用成功文案）；
 *   - `content[0].text` = 同一份 data 的 pretty JSON。
 *
 * 抽成独立函数的原因：load_skill 有两条产出路径——模型自主调用（走 BaseTool）
 * 与用户预选技能时由系统代发的一轮合成调用（走
 * utils/skills/skill-instruction.skillLoadToolContent）。两侧必须逐字同源，
 * 模型才无法（也不需要）区分「谁加载的」。
 */
export function buildSuccessPayload(
  data: Record<string, unknown>,
  message?: string,
): { content: TextContent[]; data: Record<string, unknown> } {
  const merged: Record<string, unknown> = {
    message: message || 'Operation completed successfully',
    ...data,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(merged, null, 2) }],
    data: merged,
  };
}

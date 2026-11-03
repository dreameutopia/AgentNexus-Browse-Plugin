/**
 * 工具执行器
 *
 * 统一处理工具的查找与执行：
 * 1. 优先从新工具系统 (toolRegistry) 查找并执行
 * 2. 如果工具需要 background 上下文（如 browser_* 工具），
 *    直接通过 chrome.runtime.sendMessage 转发到 background 执行
 *
 * 不再维护任何工具名映射表或 switch 分发——background 端的
 * tools-manager-listener 已能根据工具名自动路由到 toolRegistry 对应工具。
 */

import { toolRegistry, type ToolExecutionContext } from '@/tools/registry';
import { ToolResult, createErrorResponse } from '@/common/tool-handler';

/** 执行上下文类型由 tools/registry 单一定义，此处转发导出保持导入路径兼容 */
export type { ToolExecutionContext } from '@/tools/registry';

/**
 * 执行指定工具
 *
 * 查找优先级：新工具系统 → chrome.runtime.sendMessage 转发到 background
 *
 * @param toolName  工具名称
 * @param parameters 工具参数
 * @param context 执行上下文（透传给工具本体；background 转发路径不携带——
 *   background 工具与会话无关，避免污染消息协议）
 * @returns 执行结果
 */
export async function executeTool(
  toolName: string,
  parameters: any,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  // 参数形态防御（前置）：OpenAI function calling 约定参数为 JSON 对象；
  // 字符串/数字/数组等非对象值经展开（...parameters）会静默丢失全部字段，
  // 必须在此以可读错误暴露，便于定位是模型输出还是调用方的问题
  if (
    parameters !== undefined &&
    parameters !== null &&
    (typeof parameters !== 'object' || Array.isArray(parameters))
  ) {
    const receivedType = Array.isArray(parameters) ? 'array' : typeof parameters;
    const preview = (() => {
      try {
        const text = JSON.stringify(parameters) ?? String(parameters);
        return text.length > 200 ? `${text.slice(0, 200)}…` : text;
      } catch {
        return String(parameters);
      }
    })();
    return createErrorResponse(
      `Tool ${toolName} 参数必须是 JSON 对象，实际收到 ${receivedType}: ${preview}`,
    );
  }

  // 1. 尝试从新工具系统执行
  const registeredTool = toolRegistry.getTool(toolName);
  if (registeredTool) {
    try {
      // context 为可选扩展参数：不感知会话的既有工具签名不受影响
      return await registeredTool.execute(parameters, context);
    } catch (err) {
      // 工具可能因上下文限制（如只能在 background 中运行）而抛出错误，
      // 此时通过 chrome.runtime.sendMessage 转发到 background 执行
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('background context')) {
        // 非上下文错误：就地封装为失败结果（含精准原因），不上抛——
        // 保证任何工具异常都不会中断对话流程，错误沿协议以 tool 消息回传给模型
        console.warn(`[tool-executor] ${toolName} 执行抛出异常（已封装为错误结果）:`, msg);
        return createErrorResponse(`工具 ${toolName} 执行异常: ${msg}`);
      }
      console.debug(`[tool-executor] ${toolName} 需要后台上下文，转发到 background`);
    }
  }

  // 2. 转发到 background 执行
  //    background 端的 tools-manager-listener 已注册所有 browser_* 消息类型，
  //    会自动路由到 toolRegistry 中对应的工具定义执行。
  //    不再需要为每个工具维护单独的 case 分支。
  try {
    const cancellableGui = toolName === 'browser_interact' || toolName === 'screenshot' || toolName.startsWith('vision_');
    const requestId = cancellableGui && context?.signal ? crypto.randomUUID() : undefined;
    const onAbort = () => {
      if (requestId) void chrome.runtime.sendMessage({ type: 'VISION_CANCEL_REQUEST', requestId }).catch(() => undefined);
    };
    if (context?.signal?.aborted) return createErrorResponse(`Tool ${toolName} cancelled before dispatch`);
    if (requestId) context?.signal?.addEventListener('abort', onAbort, { once: true });
    // type 放在展开之后：防止参数自带 type 字段覆盖路由键导致消息被误投递
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        ...(parameters ?? {}), type: toolName,
        ...(requestId ? { __visionRequestId: requestId } : {}),
      });
    } finally { if (requestId) context?.signal?.removeEventListener('abort', onAbort); }
    // background 端监听器对工具消息必然以 ToolResult 应答；
    // undefined 意味着无人处理——按「是否注册过」分诊出可分析的原因：
    //   - 已注册（background 上下文转发路径）→ 路由失败 / 后台未就绪；
    //   - 未注册（幻觉工具名 / 已下线工具的残留引用）→ 工具不存在。
    // 两种情形都如实报错，绝不误判成成功空结果
    if (response === undefined || response === null) {
      return createErrorResponse(
        registeredTool
          ? `Tool ${toolName} 后台无响应（消息未被处理，可能为路由失败或后台未就绪），请重试或反馈问题`
          : `Tool ${toolName} 不存在：未在工具注册表中注册（工具名拼写错误或该工具已下线），后台亦无对应处理器`,
      );
    }
    // 形态防御：运行时可能有其它监听器抢先应答非 ToolResult 载荷
    //（字符串/数字等）。异物一旦当结果返回，引擎的成功判定会把它标成
    // 「成功」造成状态分裂——如实报错才是可分析的收尾
    if (typeof response !== 'object' || Array.isArray(response)) {
      const shape = Array.isArray(response) ? 'array' : typeof response;
      return createErrorResponse(
        `Tool ${toolName} 后台返回了非 ToolResult 形态的响应（类型: ${shape}），请反馈该路由问题`,
      );
    }
    return response;
  } catch (error) {
    return createErrorResponse(
      `Tool ${toolName} execution failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

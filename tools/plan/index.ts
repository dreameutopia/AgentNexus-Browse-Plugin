/**
 * 计划工具模块
 *
 * plan_tool：会话级任务计划（create/add/edit/delete/read 五种 action），
 * 配套固定注入契约（PLAN_TOOL_ID / PLAN_SYSTEM_PROMPT_SECTION，见 plan-prompt.ts）
 * 由 runtime-builder 无条件并入所有会话。
 */

import { toolRegistry } from '../registry';
import { PlanTool, planTool } from './plan-tool';

/** 注册计划统一工具 */
export function registerPlanTools() {
  toolRegistry.register(planTool);
}

// 导出（PlanTool 类型供测试/扩展复用）
export { PlanTool, planTool };
export { PLAN_TOOL_ID, PLAN_SYSTEM_PROMPT_SECTION } from './plan-prompt';

import { startPluginClient } from '@/utils/plugins/client';
/**
 * OpenAI 格式工具转换器
 *
 * 将内部工具转换为 OpenAI 格式的 tool 请求 JSON。
 * 所有工具统一由 toolRegistry (tools/) 管理和查询。
 *
 * 重构后的职责分层：
 *   - tool-presets.ts   → 各场景的工具 ID 预设
 *   - tool-executor.ts  → 工具执行（toolRegistry → chrome.runtime.sendMessage）
 *   - 本文件            → 查询 API、配置构建、统计（对外入口不变）
 */

import { toolRegistry } from '@/tools/registry';
import { registerAllTools } from '@/tools';
import { requiresConfirmApproval } from '@/tools/confirm-guard';
import { OpenAITool } from '@/common/openai-types';

import {
  getPresetToolIds,
  executeTool,
  type ToolExecutionContext,
  type ToolScenario,
} from './openai-tools/index';
import type { ToolResult } from '@/common/tool-handler';

// 重新导出 OpenAITool 类型以保持向后兼容
export type { OpenAITool } from '@/common/openai-types';

/**
 * sidepanel 端工具注册表初始化
 *
 * toolRegistry 是模块级单例；registerAllTools() 只在 background 端被调用，
 * sidepanel 需要自行初始化以确保 getTool/getToolIds 等查询可用。
 * 注册本身无副作用（仅写入内存 Map），工具执行仍通过 tool-executor
 * 转发到 background。
 *
 * 使用 onModuleInitialized 模式：仅注册一次，且跳过 background 上下文。
 */
let _sidepanelToolsRegistered = false;
if (!_sidepanelToolsRegistered && typeof globalThis.document !== 'undefined') {
  void startPluginClient().catch(error => console.warn('[Plugins] Initialization failed', error));
  _sidepanelToolsRegistered = true;
  try {
    registerAllTools();
    console.log('[OpenAIToolsConverter] sidepanel 工具注册完成');
  } catch (e) {
    console.warn('[OpenAIToolsConverter] 工具注册失败，将仅使用遗留工具:', e);
  }
}

export class OpenAIToolsConverter {
  // ──── 工具查询 ────

  /**
   * 根据工具 ID 列表获取对应的 OpenAI 工具定义
   */
  static getToolsByIds(toolIds: string[]): OpenAITool[] {
    const tools: OpenAITool[] = [];

    for (const toolId of toolIds) {
      const registered = toolRegistry.getTool(toolId);
      if (registered) {
        tools.push(registered.openaiSchema);
      } else {
        console.warn(`工具 ${toolId} 未在 toolRegistry 中找到定义`);
      }
    }

    return tools;
  }

  /**
   * 查询工具（按本次执行参数）是否需要用户批准后才可执行（人审门）。
   * 会话引擎经此委托查询，保持对注册表细节零感知；未注册的工具无需批准
   * （其执行会在 tool-executor 处以「工具不存在」失败回传模型）。
   *
   * 三级判定（并集，任一命中即审批；实现见 tools/confirm-guard.ts）：
   *   - ToolMetadata.requiresApproval === true：整工具审批；
   *   - ToolMetadata.requiresApprovalActions 命中 args.action：action 级审批
   *     （「单工具多操作」的统一工具仅破坏性操作过人审，如 note_tool 的 delete）；
   *   - ToolMetadata.requiresConfirm：参数语义级审批——模型显式传 confirm=true，
   *     或可定位文本字段命中破坏性关键词（click/fill 类的兜底防线）。
   * args 缺省时只做整工具判定（兼容不带参数的调用方）。
   */
  static requiresApproval(toolName: string, args?: unknown): boolean {
    const metadata = toolRegistry.getTool(toolName)?.metadata;
    if (!metadata) return false;
    if (metadata.requiresApproval === true) return true;

    const record =
      args !== null && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : null;

    const actionList = metadata.requiresApprovalActions;
    if (actionList && actionList.length > 0 && record && typeof record.action === 'string') {
      if (actionList.includes(record.action)) return true;
    }

    const confirmApplies = !metadata.requiresConfirmActions ||
      !!record && typeof record.action === 'string' && metadata.requiresConfirmActions.includes(record.action);
    return requiresConfirmApproval(metadata.requiresConfirm && confirmApplies, args);
  }

  /**
   * 获取所有可用的工具定义
   */
  static getAllTools(): OpenAITool[] {
    return toolRegistry.getAllTools().map(t => t.openaiSchema);
  }

  /**
   * 获取所有可用的工具 ID 列表
   */
  static getAvailableToolIds(): string[] {
    return toolRegistry.getToolIds();
  }

  /**
   * 按类别获取工具（仅新工具系统）
   */
  static getToolsByCategory(category?: string): OpenAITool[] {
    if (!category) return this.getAllTools();
    return (toolRegistry.getByCategory(category) || []).map(t => t.openaiSchema);
  }

  // ──── 工具预设 ────

  /**
   * 获取推荐的工具集合
   * @param scenario 使用场景（须显式传入，避免隐式默认导致工具面不明的会话）
   */
  static getRecommendedTools(scenario: ToolScenario): string[] {
    return getPresetToolIds(scenario, () => this.getAvailableToolIds());
  }

  // ──── 工具执行 ────

  /**
   * 执行指定的工具
   * @param context 执行上下文（会话 id 等；透传给会话感知工具，如 plan_tool）
   */
  static async executeTool(
    toolName: string,
    parameters: any,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    return executeTool(toolName, parameters, context);
  }

  // ──── 配置构建 ────

  /**
   * 创建工具配置
   */
  static createToolsConfig(
    toolIds: string[] | ToolScenario,
    options: {
      tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
      maxTools?: number;
      priorityTools?: string[];
    } = {},
  ): {
    tools: OpenAITool[];
    tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  } {
    const { tool_choice = 'auto', maxTools, priorityTools = [] } = options;

    // 获取工具 ID 列表
    let finalToolIds: string[];
    if (Array.isArray(toolIds)) {
      finalToolIds = toolIds;
    } else {
      finalToolIds = this.getRecommendedTools(toolIds);
    }

    // 优先级排序
    if (priorityTools.length > 0) {
      const prioritySet = new Set(priorityTools);
      const priority = finalToolIds.filter(id => prioritySet.has(id));
      const others = finalToolIds.filter(id => !prioritySet.has(id));
      finalToolIds = [...priority, ...others];
    }

    // 数量限制
    if (maxTools && maxTools > 0) {
      finalToolIds = finalToolIds.slice(0, maxTools);
    }

    return {
      tools: this.getToolsByIds(finalToolIds),
      tool_choice,
    };
  }

  // ──── 统计 ────

  /**
   * 获取工具统计信息
   */
  static getToolsStats(): {
    totalTools: number;
    categories: Record<string, number>;
  } {
    const categories: Record<string, number> = {};
    for (const category of toolRegistry.getCategories()) {
      categories[category] = toolRegistry.getByCategory(category).length;
    }

    return {
      totalTools: toolRegistry.getAllTools().length,
      categories,
    };
  }
}

// 导出默认实例（保持向后兼容）
export const openaiToolsConverter = OpenAIToolsConverter;

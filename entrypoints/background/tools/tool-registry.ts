/**
 * 工具注册模块
 * 负责收集和转换所有工具为 WebSocket 格式
 */

import type { DynamicToolDefinition, DynamicToolParameter } from '../ws/websocket-types';
import { toolRegistry as highLevelToolRegistry, registerAllTools } from '@/tools';
import type { ExtendedTool } from '@/tools/registry';

/**
 * 从 ExtendedTool 的 openaiSchema 转换为 WebSocket 工具定义格式
 */
function convertExtendedToolToWebSocketFormat(tool: ExtendedTool): DynamicToolDefinition | null {
  try {
    if (!tool.openaiSchema || !tool.openaiSchema.function) {
      console.warn('[ToolRegistry] 工具缺少 openaiSchema:', tool.name);
      return null;
    }

    const schema = tool.openaiSchema.function;
    const parameters: DynamicToolParameter[] = [];

    // 从 OpenAI schema 转换参数
    if (schema.parameters && schema.parameters.properties) {
      const props = schema.parameters.properties;
      const required = schema.parameters.required || [];

      for (const [name, prop] of Object.entries(props)) {
        const propDef = prop as any;
        parameters.push({
          name,
          type: propDef.type || 'string',
          description: propDef.description || '',
          required: required.includes(name),
        });
      }
    }

    return {
      name: tool.name,
      description: schema.description || tool.metadata?.description || '',
      parameters,
      inputSchema: structuredClone(schema.parameters),
      ...(tool.metadata.plugin ? { source: tool.metadata.plugin } : {}),
    };
  } catch (error) {
    console.error(`[ToolRegistry] 转换高级工具失败:`, tool.name, error);
    return null;
  }
}

/**
 * 工具注册类
 */
export class ToolRegistry {
  constructor() { registerAllTools(); }

  /** Read the authoritative live registry, never a constructor-time copy. */
  getToolDefinitions(): DynamicToolDefinition[] {
    return highLevelToolRegistry.getAll().flatMap(tool => {
      const definition = convertExtendedToolToWebSocketFormat(tool);
      return definition ? [definition] : [];
    });
  }

  getTool(name: string): ExtendedTool | undefined { return highLevelToolRegistry.get(name); }
  hasTool(name: string): boolean { return !!highLevelToolRegistry.get(name); }
  getToolNames(): string[] { return highLevelToolRegistry.getToolIds(); }
}
export const toolRegistry = new ToolRegistry();

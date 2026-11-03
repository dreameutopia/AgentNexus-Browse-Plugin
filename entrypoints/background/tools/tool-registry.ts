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
  private tools: Map<string, any> = new Map();

  constructor() {
    this.collectTools();
  }

  /**
   * 收集所有工具
   */
  private collectTools(): void {
    // 注册所有工具（包括浏览器工具）
    registerAllTools();

    // 从高级工具注册表收集所有工具
    const allTools = highLevelToolRegistry.getAll();
    for (const tool of allTools) {
      if (tool && tool.name) {
        this.tools.set(tool.name, { type: 'extended', tool });
      }
    }

    console.log(`[ToolRegistry] 已收集 ${this.tools.size} 个工具`);
  }

  /**
   * 获取所有工具的 WebSocket 格式定义
   */
  public getToolDefinitions(): DynamicToolDefinition[] {
    const definitions: DynamicToolDefinition[] = [];

    for (const [name, toolWrapper] of this.tools.entries()) {
      let definition: DynamicToolDefinition | null = null;

      // 所有工具现在都是 extended 类型
      if (toolWrapper.type === 'extended') {
        definition = convertExtendedToolToWebSocketFormat(toolWrapper.tool);
      }

      if (definition) {
        definitions.push(definition);
      }
    }

    console.log(`[ToolRegistry] 已生成 ${definitions.length} 个工具定义`);
    return definitions;
  }

  /**
   * 根据名称获取工具
   */
  public getTool(name: string): any | undefined {
    const toolWrapper = this.tools.get(name);
    return toolWrapper ? toolWrapper.tool : undefined;
  }

  /**
   * 检查工具是否存在
   */
  public hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 获取所有工具名称
   */
  public getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}

// 导出单例
export const toolRegistry = new ToolRegistry();

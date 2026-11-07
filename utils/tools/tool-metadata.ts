/**
 * 工具元数据索引（工具名 → 定义）
 *
 * 管理中心（hub）在「查看工具详情」时需要工具的完整名称、介绍与输入参数说明。
 * 这些元数据原本只随工具实现（entrypoints/sidepanel/components/tool/tool-definitions.ts）
 * 一起提供，而那份模块会连带 page-exec / observe / interact / vision 等实现代码——
 * 管理页并不执行工具，把它们打进 bundle 纯属浪费。
 *
 * 因此这里做**按需加载**：动态 import 该模块并建索引，首次打开详情卡时才拉取，
 * 之后复用。管理页主 bundle 不含工具实现。
 */
import type { ToolDefinition } from '@/entrypoints/sidepanel/components/tool/types';

/** 已建立的索引（null = 尚未加载） */
let toolIndex: Record<string, ToolDefinition> | null = null;
/** 进行中的加载任务（避免并发重复 import） */
let pending: Promise<Record<string, ToolDefinition>> | null = null;

/**
 * 加载工具元数据索引；重复调用共享同一个加载任务。
 * 失败时清空 pending，允许下次重试（调用方需自行处理异常）。
 */
export async function loadToolDefinitions(): Promise<Record<string, ToolDefinition>> {
  if (toolIndex) return toolIndex;
  if (!pending) {
    pending = import('@/entrypoints/sidepanel/components/tool/tool-definitions')
      .then((module) => {
        const index: Record<string, ToolDefinition> = {};
        for (const category of module.categories) {
          for (const tool of category.tools) index[tool.name] = tool;
        }
        toolIndex = index;
        return index;
      })
      .catch((error) => {
        console.warn('[ToolMetadata] 工具元数据加载失败:', error);
        pending = null;
        return {} as Record<string, ToolDefinition>;
      });
  }
  return pending;
}

/**
 * 按名称取工具定义（未加载或未收录时返回 undefined）。
 * 插件提供的工具不在静态清单内，属正常情况。
 */
export function getToolDefinition(name: string): ToolDefinition | undefined {
  return toolIndex?.[name];
}

/**
 * openai-tools 子模块统一导出
 *
 * 所有工具定义现在统一由 toolRegistry (tools/) 管理，
 * 不再需要单独的遗留工具 Schema 定义。
 * tool-presets 已上移至根 utils/tools/（纯常量，供 hub 等跨入口共享），此处保持转发导出。
 */

export { getPresetToolIds, type ToolScenario } from '@/utils/tools/tool-presets';
export { executeTool, type ToolExecutionContext } from './tool-executor';

/**
 * 扩展工具管理器
 * 提供可扩展的工具注册和管理机制
 */

import { toolRegistry, ToolRegistry, ExtendedTool, ToolMetadata } from './registry';
import { registerSearchTools } from './search';
import { registerNavigationTools } from './navigation';
import { registerTextCompressionTools } from './text-compression';
import { registerAnalyseTools } from './analyse';
import { registerAutomationTools } from './automation';
import { registerCommonTools } from './common';
import { registerVisionTools } from './vision';
import { registerCodeTools } from './code';
import { registerNoteTools } from './note';
import { registerExcalidrawTools } from './excalidraw';
import { registerResourceTools } from './resource';
import { registerBilibiliTools } from './bilibili';
import { registerBrowserTools } from './browser';
import { registerBaseTools } from './base';
import { registerSkillTools } from './skill';
import { registerOfficeTools } from './office';
import { registerInteractTools } from './interact';
import { registerPythonTools } from './python';
import { registerPlanTools } from './plan';
import { registerDataTools } from './data';
import { registerLearnTools } from './learn';

/**
 * 注册所有工具（不包括需要 DOM 环境的工具）
 */
export function registerAllTools() {
  registerBaseTools();
  registerBrowserTools(); // 注册浏览器工具
  registerSearchTools();
  registerNavigationTools();
  registerTextCompressionTools();
  registerAnalyseTools();
  registerAutomationTools();
  registerCommonTools();
  registerVisionTools();
  registerCodeTools();
  registerNoteTools();
  registerExcalidrawTools();
  registerResourceTools();
  registerBilibiliTools();
  registerSkillTools(); // 注册技能（skill）加载与资源读取工具
  registerOfficeTools(); // 注册 office 类工具（xlsx_tool）
  registerInteractTools(); // 注册用户交互工具（interact：提问/授权征询）
  registerPythonTools(); // 注册 Python 沙箱工具（python_run，环境就绪后才实际可用）
  registerPlanTools(); // 注册会话任务计划工具（plan_tool：长难任务的步骤与状态跟踪）
  registerDataTools(); // 注册数据引用通道工具（data_ref_tool：批量抓取批次的盘点/合并/清理）
  registerLearnTools(); // 注册网站学习提交工具（submit_skill / submit_validation：终止型结束信号）
}

// 导出所有工具类型和实例
// 注意：为避免循环依赖，只导出类型定义，不导出实例
export type { PageSourceParams } from './base/page-source-tool';
export type { TaskSubmitParams, TaskSubmitResponse } from './base/task-submit-tool';
export type { TaskResultParams, TaskResultResponse } from './base/task-result-tool';
export { BaseBrowserTool } from './base/browser-tool';

export * from './browser'; // 导出浏览器工具
export * from './search';
export * from './navigation';
export * from './text-compression';
export * from './analyse';
export * from './automation';
export * from './common';
export * from './vision';
export * from './code';
export * from './note';
export * from './excalidraw';
export * from './resource';
export * from './bilibili';
export * from './skill'; // 导出技能（skill）工具
export * from './office'; // 导出 office 类工具（xlsx_tool）
export * from './interact'; // 导出用户交互工具（interact）
export * from './python'; // 导出 Python 沙箱工具（python_run）
export * from './plan'; // 导出会话任务计划工具（plan_tool）
export * from './data'; // 导出数据引用通道工具（data_ref_tool）
export * from './learn'; // 导出网站学习工具（submit_skill / submit_validation）
export * from './base-tool';

// ScreenshotTool 只存在于 vision 子模块（tools/browser/capture.ts 的旧版
// browser_screenshot 已下线），此处显式导出以保持对外入口稳定。
export { ScreenshotTool } from './vision';

// 导出工具注册表类型和实例
export { ToolRegistry, toolRegistry };
export type { ExtendedTool, ToolMetadata };

// 注意：不在这里立即调用 registerAllTools()
// 而是在需要时（如 background script 中）显式调用
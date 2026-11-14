/**
 * 扩展工具管理器
 * 提供可扩展的工具注册和管理机制
 */

import { toolRegistry, ToolRegistry, ExtendedTool, ToolMetadata } from './registry';
import { registerSearchTools } from './search';
import { registerTextCompressionTools } from './text-compression';
import { registerAutomationTools } from './automation';
import { registerCommonTools } from './common';
import { registerVisionTools } from './vision';
import { registerCodeTools } from './code';
import { registerNoteTools } from './note';
import { registerExcalidrawTools } from './excalidraw';
import { registerBilibiliTools } from './bilibili';
import { registerBrowserTools } from './browser';
import { registerBaseTools } from './base';
import { registerSkillTools } from './skill';
import { registerOfficeTools } from './office';
import { registerInteractTools } from './interact';
import { registerJavaScriptTools } from './javascript';
import { registerPythonTools } from './python';
import { registerPlanTools } from './plan';
import { registerDataTools } from './data';
import { registerLearnTools } from './learn';
import { registerUploadFileTools } from './upload-file';

/**
 * 注册所有工具（不包括需要 DOM 环境的工具）
 *
 * 上下文差异（document_tool）：
 *   文档工具（Markdown → Word/PDF）的重依赖（docx 1.6MB、katex 0.6MB、
 *   markdown-it、highlight.js）合计约 2.7MB。它**只在 sidepanel 注册**：
 *   工具执行器（tool-executor）先查当前上下文的注册表，命中即本地执行，
 *   不转发 background——因此 sidepanel 侧功能完整，而 background 不必为
 *   一个尚未关联任何智能体的工具背负 2.7MB 冷启动开销。
 *   background 的 WebSocket 工具清单因此不包含 document_tool（符合「先不
 *   关联给任何智能体」的定位）。
 */
export function registerAllTools() {
  registerBaseTools();
  registerBrowserTools(); // 注册浏览器工具
  registerSearchTools();
  registerTextCompressionTools();
  registerAutomationTools();
  registerCommonTools();
  registerVisionTools();
  registerCodeTools();
  registerNoteTools();
  registerExcalidrawTools();
  registerBilibiliTools();
  registerSkillTools(); // 注册技能（skill）加载与资源读取工具
  registerOfficeTools(); // 注册 office 类工具（xlsx_tool）
  registerInteractTools(); // 注册用户交互工具（interact：提问/授权征询）
  registerJavaScriptTools();
  registerPythonTools(); // 注册 Python 沙箱工具（python_run，环境就绪后才实际可用）
  registerPlanTools(); // 注册会话任务计划工具（plan_tool：长难任务的步骤与状态跟踪）
  registerDataTools(); // 注册数据引用通道工具（data_ref_tool：批量抓取批次的盘点/合并/清理）
  registerLearnTools(); // 注册网站学习提交工具（submit_skill / submit_validation：终止型结束信号）
  registerUploadFileTools(); // 注册上传文件分页读取工具（read_file：会话文件库的按页续读）
  // 注意：文档工具（document_tool）**不在此注册**——它只在 sidepanel 注册
  // （见 openai-tools-converter.ts）。原因：它的重依赖（docx 1.6MB、
  // katex 0.6MB、markdown-it、highlight.js）约 2.7MB，而 background 是
  // service worker 入口，Vite 对其强制 inlineDynamicImports——只要 background
  // 静态可达这些模块，就无法拆成按需加载的独立 chunk，会白白拖慢扩展冷启动。
  // 文档工具全程在 sidepanel 执行（工具执行器先查当前上下文注册表，命中即
  // 本地执行），因此不需要 background 注册它。
}

// 导出所有工具类型和实例
// 注意：为避免循环依赖，只导出类型定义，不导出实例
export type { TaskSubmitParams, TaskSubmitResponse } from './base/task-submit-tool';
export type { TaskResultParams, TaskResultResponse } from './base/task-result-tool';
export { BaseBrowserTool } from './base/browser-tool';

export * from './browser'; // 导出浏览器工具
export * from './search';
export * from './text-compression';
export * from './automation';
export * from './common';
export * from './vision';
export * from './code';
export * from './note';
export * from './excalidraw';
export * from './bilibili';
export * from './skill'; // 导出技能（skill）工具
export * from './office'; // 导出 office 类工具（xlsx_tool）
// 注意：document 工具**不在此再导出**——`export *` 是静态的，会把它的重依赖
// （docx/katex/markdown-it/highlight.js 约 2.7MB）拖进 background 主包。
// 需要它的模块请直接从 '@/tools/document' 导入（sidepanel 侧动态按需加载）。
export * from './interact'; // 导出用户交互工具（interact）
export * from './python'; // 导出 Python 沙箱工具（python_run）
export * from './plan'; // 导出会话任务计划工具（plan_tool）
export * from './data'; // 导出数据引用通道工具（data_ref_tool）
export * from './learn'; // 导出网站学习工具（submit_skill / submit_validation）
export * from './upload-file'; // 导出上传文件分页读取工具（read_file）
export * from './base-tool';

// ScreenshotTool 只存在于 vision 子模块（tools/browser/capture.ts 的旧版
// browser_screenshot 已下线），此处显式导出以保持对外入口稳定。
export { ScreenshotTool } from './vision';

// 导出工具注册表类型和实例
export { ToolRegistry, toolRegistry };
export type { ExtendedTool, ToolMetadata };

// 注意：不在这里立即调用 registerAllTools()
// 而是在需要时（如 background script 中）显式调用
export * from './javascript';

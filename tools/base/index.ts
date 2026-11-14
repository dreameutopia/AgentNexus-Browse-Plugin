/**
 * 基础工具集合
 */

import { toolRegistry } from '../registry';
import { TaskSubmitTool } from './task-submit-tool';
import { TaskResultTool } from './task-result-tool';
import {
  getPageTextTool,
  getPageHTMLTool,
  getCurrentPageInfoTool,
} from './page-info-tool';

// 导出基类
export { BaseBrowserTool } from './browser-tool';

// 创建工具实例的工厂函数
function createBaseTools() {
  return [
    new TaskSubmitTool(),
    new TaskResultTool(),
    getPageTextTool,
    getPageHTMLTool,
    getCurrentPageInfoTool,
  ];
}

// 注册函数
export function registerBaseTools() {
  const baseTools = createBaseTools();
  baseTools.forEach(tool => {
    toolRegistry.register(tool);
  });
}

export {
  TaskSubmitTool,
  TaskResultTool,
  getPageTextTool,
  getPageHTMLTool,
  getCurrentPageInfoTool,
};

// 导出类型定义
export type { TaskSubmitParams, TaskSubmitResponse } from './task-submit-tool';
export type { TaskResultParams, TaskResultResponse } from './task-result-tool';

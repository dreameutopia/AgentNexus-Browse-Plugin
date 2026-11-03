/**
 * 基础工具集合
 */

import { toolRegistry } from '../registry';
import { PageSourceTool } from './page-source-tool';
import { TaskSubmitTool } from './task-submit-tool';
import { TaskResultTool } from './task-result-tool';
import { 
  getPageTextTool, 
  getPageHTMLTool, 
  getCurrentPageInfoTool, 
  getAllTabsTool 
} from './page-info-tool';

// 导出基类
export { BaseBrowserTool } from './browser-tool';

// 创建工具实例的工厂函数
function createBaseTools() {
  return [
    new PageSourceTool(),
    new TaskSubmitTool(),
    new TaskResultTool(),
    getPageTextTool,
    getPageHTMLTool,
    getCurrentPageInfoTool,
    getAllTabsTool
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
  PageSourceTool,
  TaskSubmitTool,
  TaskResultTool,
  getPageTextTool,
  getPageHTMLTool,
  getCurrentPageInfoTool,
  getAllTabsTool
};

// 导出类型定义
export type { PageSourceParams }  from './page-source-tool';
export type { TaskSubmitParams, TaskSubmitResponse } from './task-submit-tool';
export type { TaskResultParams, TaskResultResponse } from './task-result-tool';
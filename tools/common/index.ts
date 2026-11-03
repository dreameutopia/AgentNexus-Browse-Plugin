/**
 * 通用工具集合
 * 包含各种通用功能工具
 */

import { toolRegistry } from '../registry';
import { GenericWaitTool } from './generic-wait';
import { WaitPageLoadTool } from './wait-page-load';

// 创建通用工具实例
function createCommonTools() {
  return [
    new GenericWaitTool(),
    new WaitPageLoadTool()
  ];
}

// 注册函数
export function registerCommonTools() {
  const commonTools = createCommonTools();
  commonTools.forEach(tool => {
    toolRegistry.register(tool);
  });
}

export {
  GenericWaitTool,
  WaitPageLoadTool
};
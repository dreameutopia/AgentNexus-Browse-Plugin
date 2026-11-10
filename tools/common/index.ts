/**
 * 通用工具集合
 * 包含各种通用功能工具
 */

import { toolRegistry } from '../registry';
import { GenericWaitTool } from './generic-wait';

// 创建通用工具实例
function createCommonTools() {
  return [
    new GenericWaitTool(),
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
};

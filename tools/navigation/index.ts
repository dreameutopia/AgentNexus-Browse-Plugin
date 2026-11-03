/**
 * 导航工具集合
 * 包含各种网站导航和快捷访问工具
 */

import { toolRegistry } from '../registry';
import { QuickNavigationTool } from './quick-navigation';
import { BookmarkNavigationTool } from './bookmark-navigation';
import { HistoryNavigationTool } from './history-navigation';

// 创建导航工具实例
function createNavigationTools() {
  return [
    new QuickNavigationTool(),
    new BookmarkNavigationTool(),
    new HistoryNavigationTool()
  ];
}

// 注册函数
export function registerNavigationTools() {
  const navigationTools = createNavigationTools();
  navigationTools.forEach(tool => {
    toolRegistry.register(tool);
  });
}

export {
  QuickNavigationTool,
  BookmarkNavigationTool,
  HistoryNavigationTool
};
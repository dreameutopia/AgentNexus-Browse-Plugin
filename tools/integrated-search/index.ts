/**
 * 集成搜索工具模块
 * 将搜索和结果抓取功能整合，提供一站式搜索解决方案
 */

import { toolRegistry } from '../registry';
import { BingIntegratedSearchTool } from './bing-integrated-search';
import { BaiduIntegratedSearchTool } from './baidu-integrated-search';
import { BilibiliIntegratedSearchTool } from './bilibili-integrated-search';
import { ZhihuIntegratedSearchTool } from './zhihu-integrated-search';
import { GitHubIntegratedSearchTool } from './github-integrated-search';
import { CSDNIntegratedSearchTool } from './csdn-integrated-search';
import { MOOCIntegratedSearchTool } from './mooc-integrated-search';
import { XiaohongshuIntegratedSearchTool } from './xiaohongshu-integrated-search';
import { CNKIIntegratedSearchTool } from './cnki-integrated-search';

// 创建集成搜索工具实例
function createIntegratedSearchTools() {
  return [
    new BingIntegratedSearchTool(),
    new BaiduIntegratedSearchTool(),
    new BilibiliIntegratedSearchTool(),
    new ZhihuIntegratedSearchTool(),
    new GitHubIntegratedSearchTool(),
    new CSDNIntegratedSearchTool(),
    new MOOCIntegratedSearchTool(),
    new XiaohongshuIntegratedSearchTool(),
    new CNKIIntegratedSearchTool()
  ];
}

// 注册函数
export function registerIntegratedSearchTools() {
  const integratedSearchTools = createIntegratedSearchTools();
  integratedSearchTools.forEach(tool => {
    toolRegistry.register(tool);
  });
}

// 导出工具类
export { BaseIntegratedSearchTool } from './base-integrated-search';
export { BingIntegratedSearchTool } from './bing-integrated-search';
export { BaiduIntegratedSearchTool } from './baidu-integrated-search';
export { BilibiliIntegratedSearchTool } from './bilibili-integrated-search';
export { ZhihuIntegratedSearchTool } from './zhihu-integrated-search';
export { GitHubIntegratedSearchTool } from './github-integrated-search';
export { CSDNIntegratedSearchTool } from './csdn-integrated-search';
export { MOOCIntegratedSearchTool } from './mooc-integrated-search';
export { XiaohongshuIntegratedSearchTool } from './xiaohongshu-integrated-search';
export { CNKIIntegratedSearchTool } from './cnki-integrated-search';

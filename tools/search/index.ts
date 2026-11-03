/**
 * 搜索工具集合
 * 包含各种搜索引擎和平台的搜索工具
 */

import { toolRegistry } from '../registry';
import { ZhihuSearchTool } from './zhihu-search';
import { BilibiliSearchTool } from './bilibili-search';
import { BaiduSearchTool } from './baidu-search';
import { BingSearchTool } from './bing-search';
import { CSDNSearchTool } from './csdn-search';
import { GitHubSearchTool } from './github-search';
import { MoocSearchTool } from './mooc-search';
import { XiaohongshuSearchTool } from './xiaohongshu-search';
import { CNKISearchTool } from './cnki-search';

// 创建工具实例的工厂函数
function createSearchTools() {
  return [
    new ZhihuSearchTool(),
    new BilibiliSearchTool(),
    new BaiduSearchTool(),
    new BingSearchTool(),
    new CSDNSearchTool(),
    new GitHubSearchTool(),
    new MoocSearchTool(),
    new XiaohongshuSearchTool(),
    new CNKISearchTool()
  ];
}

// 注册函数
export function registerSearchTools() {
  const searchTools = createSearchTools();
  searchTools.forEach(tool => {
    toolRegistry.register(tool);
  });
}

export {
  BilibiliSearchTool,
  ZhihuSearchTool,
  BaiduSearchTool,
  BingSearchTool,
  CSDNSearchTool,
  GitHubSearchTool,
  MoocSearchTool,
  XiaohongshuSearchTool,
  CNKISearchTool
};
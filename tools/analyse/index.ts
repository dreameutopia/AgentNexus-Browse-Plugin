/**
 * 分析工具集合
 * 包含各种内容分析和提取工具
 *
 * 原 9 个平台搜索结果抓取工具（*_result_scraper）已并入统一搜索工具
 * web_search（tools/search，website 枚举区分平台，导航 + 解析一步完成），
 * 本目录不再注册任何搜索结果抓取工具。
 */

import { toolRegistry } from '../registry';
import { GetPageMarkdownTool } from './get-page-markdown-tool';

// 创建分析工具实例
function createAnalyseTools() {
  return [new GetPageMarkdownTool()];
}

// 注册函数
export function registerAnalyseTools() {
  const analyseTools = createAnalyseTools();
  analyseTools.forEach(tool => {
    toolRegistry.register(tool);
  });
}

export { GetPageMarkdownTool };

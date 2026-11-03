/**
 * 分析工具集合
 * 包含各种内容分析和提取工具
 */

import { toolRegistry } from '../registry';
import { GetPageMarkdownTool } from './get-page-markdown-tool';
import { BaiduResultScraperTool } from './baidu-result-scraper';
import { BingResultScraperTool } from './bing-result-scraper';
import { BilibiliSearchResultScraperTool } from './bilibili-search-result-scraper';
import { CNKIResultScraperTool } from './cnki-result-scraper';
import { CSDNResultScraperTool } from './csdn-result-scraper';
import { XiaohongshuResultScraperTool } from './xiaohongshu-result-scraper';
import { GitHubResultScraperTool } from './github-result-scraper';
import { MoocResultScraperTool } from './mooc-result-scraper';
import { ZhihuResultScraperTool } from './zhihu-result-scraper';

// 创建分析工具实例
function createAnalyseTools() {
  return [
    new GetPageMarkdownTool(),
    new BaiduResultScraperTool(),
    new BingResultScraperTool(),
    new BilibiliSearchResultScraperTool(),
    new CNKIResultScraperTool(),
    new CSDNResultScraperTool(),
    new XiaohongshuResultScraperTool(),
    new GitHubResultScraperTool(),
    new MoocResultScraperTool(),
    new ZhihuResultScraperTool()
  ];
}

// 注册函数
export function registerAnalyseTools() {
  const analyseTools = createAnalyseTools();
  analyseTools.forEach(tool => {
    toolRegistry.register(tool);
  });
}

export {
  GetPageMarkdownTool,
  BaiduResultScraperTool,
  BingResultScraperTool,
  BilibiliSearchResultScraperTool,
  CNKIResultScraperTool,
  CSDNResultScraperTool,
  XiaohongshuResultScraperTool,
  GitHubResultScraperTool,
  MoocResultScraperTool,
  ZhihuResultScraperTool
};
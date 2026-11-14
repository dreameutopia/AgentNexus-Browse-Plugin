import { NetworkObserverTool } from './network-observer';
import { BrowserObserveTool } from './observe';
import { browserInteractTool } from './interact';
/**
 * 浏览器工具集合
 * 提供 Chrome 浏览器的底层操作能力
 */

import { toolRegistry } from '../registry';

// 导入所有浏览器工具
import { browserNavigationTool } from './navigation';
import { consoleTool } from './capture';
import { networkRequestTool } from './network';
import {
  vectorSearchTabsContentTool
} from './content';
import {
  sendCommandToInjectScriptTool
} from './script';
import { pageExecTool } from './page-exec-tool';
import { pageExtractDataTool } from './page-extract-tool';
import { pageCleanTool } from './page-clean-tool';
import { domExploreTool } from './dom-explore-tool';
import { browserHistoryBookmarksTool } from './history-bookmarks';
import { browserDownloadsTool } from './downloads';
import { browserResourcesTool } from './resources';
import { browserTabsTool } from './tab-management';
import { browserPageOpsTool } from './page-ops';

// 创建浏览器工具实例
function createBrowserTools() {
  return [
    // Navigation tools（统一导航 + 标签页/窗口管理）
    browserNavigationTool,
    browserTabsTool,

    // Interaction tools
    new BrowserObserveTool(),
    browserInteractTool,

    // Capture tools
    consoleTool,

    // Network tools
    networkRequestTool,
    new NetworkObserverTool(),
    // Content tools
    vectorSearchTabsContentTool,

    // Script tools
    sendCommandToInjectScriptTool,

    // 高权限页面执行引擎与页面级自动化工具
    pageExecTool,
    pageExtractDataTool,
    pageCleanTool,
    domExploreTool,

    // 历史与书签统一工具（检索/打开/增删改/最近/最常访问/文件夹结构）
    browserHistoryBookmarksTool,

    // 下载与资源工具（浏览器下载管理器 + 页面资源嗅探/下载/拦截捕获）
    browserDownloadsTool,
    browserResourcesTool,

    // 轻量页面操作（按屏滚动 / 等待元素出现，无需 DOM 引用）
    browserPageOpsTool,
  ];
}

/**
 * 注册所有浏览器工具
 */
export function registerBrowserTools() {
  console.log('[BrowserTools] Registering browser tools...');

  const browserTools = createBrowserTools();
  browserTools.forEach(tool => {
    toolRegistry.register(tool);
  });

  console.log(`[BrowserTools] Registered ${browserTools.length} browser tools`);
}

// 导出所有工具实例
export * from './navigation';
export * from './observe';
export * from './interact';
export * from './network-observer';
export * from './capture';
export * from './network';
export * from './content';
export * from './script';
export * from './page-exec-tool';
export * from './page-script-runner';
export * from './crawl-runner';
export * from './challenge-detect';
export * from './page-extract-tool';
export * from './page-clean-tool';
export * from './dom-explore-tool';
export * from './cdp-session';
export * from './history-bookmarks';
export * from './downloads';
export * from './resources';
export * from './tab-management';
export * from './page-load';
export * from './page-ops';

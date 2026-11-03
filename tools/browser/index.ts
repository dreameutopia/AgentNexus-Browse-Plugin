/**
 * 浏览器工具集合
 * 提供 Chrome 浏览器的底层操作能力
 */

import { toolRegistry } from '../registry';

// 导入所有浏览器工具
import { navigateTool, closeTabsTool, goBackOrForwardTool } from './navigation';
import { keyboardTool } from './interaction';
import { windowTool } from './window';
import { screenshotTool, consoleTool } from './capture';
import { 
  networkRequestTool, 
  networkCaptureStartTool, 
  networkCaptureStopTool,
  networkDebuggerStartTool,
  networkDebuggerStopTool 
} from './network';
import { 
  webFetcherTool, 
  vectorSearchTabsContentTool 
} from './content';
import { 
  injectScriptTool, 
  sendCommandToInjectScriptTool
} from './script';
import { pageExecTool } from './page-exec-tool';
import { pageExtractDataTool } from './page-extract-tool';
import { pageCleanTool } from './page-clean-tool';
import { historyTool } from './history';
import { 
  bookmarkSearchTool, 
  bookmarkAddTool, 
  bookmarkDeleteTool 
} from './bookmark';
import { 
  switchToTabTool, 
  closeTabTool, 
  createTabTool 
} from './tab-management';
import { 
  scrollTool, 
  waitForElementTool 
} from './page-operations';

// 创建浏览器工具实例
function createBrowserTools() {
  return [
    // Navigation tools
    navigateTool,
    closeTabsTool,
    goBackOrForwardTool,
    
    // Interaction tools
    keyboardTool,
    
    // Window tools
    windowTool,
    
    // Capture tools
    screenshotTool,
    consoleTool,
    
    // Network tools
    networkRequestTool,
    networkCaptureStartTool,
    networkCaptureStopTool,
    networkDebuggerStartTool,
    networkDebuggerStopTool,
    
    // Content tools
    webFetcherTool,
    vectorSearchTabsContentTool,
    
    // Script tools
    injectScriptTool,
    sendCommandToInjectScriptTool,
    
    // 高权限页面执行引擎与页面级自动化工具
    pageExecTool,
    pageExtractDataTool,
    pageCleanTool,
    
    // History tool
    historyTool,
    
    // Bookmark tools
    bookmarkSearchTool,
    bookmarkAddTool,
    bookmarkDeleteTool,
    
    // Tab management tools
    switchToTabTool,
    closeTabTool,
    createTabTool,
    
    // Page operation tools
    scrollTool,
    waitForElementTool,
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
export * from './interaction';
export * from './window';
export * from './capture';
export * from './network';
export * from './content';
export * from './script';
export * from './page-exec-tool';
export * from './page-extract-tool';
export * from './page-clean-tool';
export * from './cdp-session';
export * from './history';
export * from './bookmark';
export * from './tab-management';
export * from './page-operations';


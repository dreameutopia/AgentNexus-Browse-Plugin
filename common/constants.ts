/**
 * Chrome Extension Constants
 * Centralized configuration values and magic constants
 */

// Native Host Configuration
export const NATIVE_HOST = {
  NAME: 'com.chromemcp.nativehost',
  DEFAULT_PORT: 12306,
} as const;

// Chrome Extension Icons
export const ICONS = {
  NOTIFICATION: 'icon/48.png',
} as const;

// Timeouts and Delays (in milliseconds)
export const TIMEOUTS = {
  DEFAULT_WAIT: 1000,
  SCREENSHOT_DELAY: 100,
  KEYBOARD_DELAY: 50,
  CLICK_DELAY: 100,
} as const;

// Limits and Thresholds
export const LIMITS = {
  /** browser_network_capture 单轮请求上限（工具描述与提示词引用同一数字） */
  MAX_NETWORK_REQUESTS: 100,
  MAX_SEARCH_RESULTS: 50,
  MAX_BOOKMARK_RESULTS: 100,
  MAX_HISTORY_RESULTS: 100,
  SIMILARITY_THRESHOLD: 0.1,
  VECTOR_DIMENSIONS: 384,
} as const;

// Error Messages
export const ERROR_MESSAGES = {
  NATIVE_CONNECTION_FAILED: 'Failed to connect to native host',
  NATIVE_DISCONNECTED: 'Native connection disconnected',
  SERVER_STATUS_LOAD_FAILED: 'Failed to load server status',
  SERVER_STATUS_SAVE_FAILED: 'Failed to save server status',
  TOOL_EXECUTION_FAILED: 'Tool execution failed',
  INVALID_PARAMETERS: 'Invalid parameters provided',
  PERMISSION_DENIED: 'Permission denied',
  TAB_NOT_FOUND: 'Tab not found',
  ELEMENT_NOT_FOUND: 'Element not found',
  NETWORK_ERROR: 'Network error occurred',
} as const;

// Success Messages
export const SUCCESS_MESSAGES = {
  TOOL_EXECUTED: 'Tool executed successfully',
  CONNECTION_ESTABLISHED: 'Connection established',
  SERVER_STARTED: 'Server started successfully',
  SERVER_STOPPED: 'Server stopped successfully',
} as const;

// 扩展无法注入脚本/执行自动化的受限页面前缀
// （Chrome 保留页面：浏览器内部页、扩展页、本地文件、特殊 scheme 等）
export const RESTRICTED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'edge-extension://',
  'about:',
  'file://',
  'view-source:',
  'devtools://',
  'data:',
  'javascript:',
  'moz-extension://',
] as const;

/**
 * 判断 URL 是否为扩展无法注入脚本/无法访问的受限页面（chrome://、about: 等）。
 * 无 URL（undefined / 空串）视为受限——调用方通常此时也拿不到可操作的文档。
 * 受限前缀统一维护于 RESTRICTED_URL_PREFIXES，所有工具共用同一判定口径。
 */
export function isRestrictedUrl(url: string | undefined | null): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return RESTRICTED_URL_PREFIXES.some(prefix => lower.startsWith(prefix));
}

// File Extensions and MIME Types
export const FILE_TYPES = {
  STATIC_EXTENSIONS: [
    '.css',
    '.js',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.svg',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
  ],
  FILTERED_MIME_TYPES: ['text/html', 'text/css', 'text/javascript', 'application/javascript'],
  IMAGE_FORMATS: ['png', 'jpeg', 'webp'] as const,
} as const;

// Network Filtering
export const NETWORK_FILTERS = {
  EXCLUDED_DOMAINS: [
    'google-analytics.com',
    'googletagmanager.com',
    'facebook.com',
    'doubleclick.net',
    'googlesyndication.com',
  ],
  STATIC_RESOURCE_TYPES: ['stylesheet', 'image', 'font', 'media', 'other'],
} as const;

// Storage Keys
export const STORAGE_KEYS = {
  SERVER_STATUS: 'serverStatus',
  USER_PREFERENCES: 'userPreferences',
} as const;

// Notification Configuration
export const NOTIFICATIONS = {
  PRIORITY: 2,
  TYPE: 'basic' as const,
} as const;

export enum ExecutionWorld {
  ISOLATED = 'ISOLATED',
  MAIN = 'MAIN',
}

// Tool Names
// 仅登记「真实可调用」的规范名：已注册工具（tools/registry）或确实存在的内联消息
// 处理器（browser_set_zoom）。写入不存在的名字会让调用方误以为
// 能直接调用——tests/tools 契约测试对本表做 ⊆ 注册表 ∪ 内联处理器 的强制校验。
export const TOOL_NAMES = {
  BROWSER: {
    // Network tools
    NETWORK_REQUEST: 'browser_network_request',
    NETWORK_CAPTURE_START: 'browser_network_capture',
    
    // Script tools
    SEND_COMMAND_TO_INJECT_SCRIPT: 'browser_send_command_to_inject_script',
    
    // 高权限页面执行引擎与页面级自动化工具
    PAGE_EXEC: 'browser_page_exec',
    PAGE_EXTRACT_DATA: 'browser_extract_data',
    PAGE_CLEAN: 'browser_clean_page',
    // DOM 关系探索（重复结构识别 / 批量抓取入口发现）
    DOM_EXPLORE: 'browser_dom_explore',
    
    // Navigation tools（统一导航：open/refresh/back/forward/wait 五 action）
    NAVIGATION: 'browser_navigation',
    
    // 历史与书签统一工具（检索/打开/增删改/最近访问/最常访问/文件夹结构，八 action）
    HISTORY_BOOKMARKS: 'browser_history_bookmarks',

    // Content tools
    CONTENT_GET: 'browser_get_page_text',

    // 内容工具（extended）：跨标签页正文检索（真实实现：读页面文本并按命中排序）
    SEARCH_TABS_CONTENT: 'browser_vector_search',

    // Interaction tools (extended)
    
    // Capture tools (extended)
    CONSOLE: 'browser_console',
    
    // 轻量页面操作（按屏滚动 / 等待元素出现，无需 DOM 引用）
    PAGE_OPS: 'browser_page_ops',
    SET_ZOOM: 'browser_set_zoom',
    
    // Tab management tools（统一标签页与窗口：list/switch/close/create/windows 五 action）
    TABS: 'browser_tabs',
  }
} as const;

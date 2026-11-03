/**
 * 工具管理器监听器 - 处理来自侧边栏和其他页面的工具调用请求
 */

import { handleCallTool } from '.';
import { createErrorResponse } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { toolRegistry as highLevelToolRegistry } from '@/tools/registry';
import { cancelGuiRequest } from '@/tools/vision/gui-cancellation';

/**
 * 工具调用消息类型
 */
const TOOL_MESSAGE_TYPES = {
  // 浏览器工具
  BROWSER_NAVIGATE: 'browser_navigate',
  BROWSER_SCREENSHOT: 'browser_screenshot',
  BROWSER_KEYBOARD: 'browser_keyboard',
  BROWSER_WINDOW: 'browser_window',
  BROWSER_SEARCH_BOOKMARKS: 'browser_search_bookmarks',
  BROWSER_SEARCH_HISTORY: 'browser_search_history',
  BROWSER_NETWORK_REQUEST: 'browser_network_request',
  BROWSER_VECTOR_SEARCH: 'browser_vector_search',
  BROWSER_INJECT_SCRIPT: 'browser_inject_script',
  BROWSER_PAGE_EXEC: 'browser_page_exec',
  BROWSER_EXTRACT_DATA: 'browser_extract_data',
  BROWSER_CLEAN_PAGE: 'browser_clean_page',
  BROWSER_CONSOLE: 'browser_console',
  BROWSER_NETWORK_CAPTURE: 'browser_network_capture',
  BROWSER_GET_PAGE_INFO: 'browser_get_page_info',
  BROWSER_GET_ALL_TABS: 'browser_get_all_tabs',
  BROWSER_SWITCH_TAB: 'browser_switch_tab',
  BROWSER_CLOSE_TAB: 'browser_close_tab',
  BROWSER_CREATE_TAB: 'browser_create_tab',
  BROWSER_WAIT_FOR_ELEMENT: 'browser_wait_for_element',
  BROWSER_SCROLL: 'browser_scroll',
  BROWSER_GET_PAGE_TEXT: 'browser_get_page_text',
  BROWSER_GET_PAGE_HTML: 'browser_get_page_html',
  BROWSER_EXECUTE_SCRIPT: 'browser_execute_script',
  BROWSER_SET_ZOOM: 'browser_set_zoom',
  BROWSER_REFRESH: 'browser_refresh',
  BROWSER_GO_BACK: 'browser_go_back',
  BROWSER_GO_FORWARD: 'browser_go_forward',
  BROWSER_SEND_COMMAND_TO_INJECT_SCRIPT: 'browser_send_command_to_inject_script',
} as const;

/**
 * 工具名称映射 - 仅保留名称不一致的特殊映射
 * 绝大多数工具注册名已与消息类型一致，只有少数需要映射
 */
const TOOL_NAME_OVERRIDES: Record<string, string> = {
  [TOOL_MESSAGE_TYPES.BROWSER_EXECUTE_SCRIPT]: 'browser_inject_script',
  [TOOL_MESSAGE_TYPES.BROWSER_GO_BACK]: 'browser_go_back_or_forward',
  [TOOL_MESSAGE_TYPES.BROWSER_GO_FORWARD]: 'browser_go_back_or_forward',
};

/**
 * 需要参数转换的消息类型
 */
function transformParams(messageType: string, params: any): any {
  switch (messageType) {
    case TOOL_MESSAGE_TYPES.BROWSER_GO_BACK:
      return { ...params, isForward: false };
    case TOOL_MESSAGE_TYPES.BROWSER_GO_FORWARD:
      return { ...params, isForward: true };
    default:
      return params;
  }
}

/**
 * 处理 browser_refresh - 目前没有对应的注册工具，直接内联处理
 */
async function handleRefresh() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (typeof tabId !== 'number') {
      return createErrorResponse('No active tab found');
    }
    await chrome.tabs.reload(tabId);
    return { success: true, data: { tabId } };
  } catch (error) {
    return createErrorResponse(error instanceof Error ? error.message : 'Failed to refresh page');
  }
}

/**
 * 处理 browser_set_zoom - 目前没有对应的注册工具，直接内联处理
 */
async function handleSetZoom(params: any) {
  try {
    const { tabId, zoomFactor } = params;
    // typeof NaN 仍为 'number'，必须用 isFinite 排除 NaN/Infinity 脏值
    if (typeof zoomFactor !== 'number' || !Number.isFinite(zoomFactor)) {
      return createErrorResponse('zoomFactor is required and must be a finite number');
    }
    const tabs = tabId !== undefined && tabId !== null
      ? [await chrome.tabs.get(tabId)]
      : await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTabId = tabs[0]?.id;
    if (typeof activeTabId !== 'number') {
      return createErrorResponse('No active tab found');
    }
    await chrome.tabs.setZoom(activeTabId, zoomFactor);
    return { success: true, data: { tabId: activeTabId, zoomFactor } };
  } catch (error) {
    return createErrorResponse(error instanceof Error ? error.message : 'Failed to set zoom');
  }
}

/**
 * 初始化工具管理器监听器
 */
export const initToolsManagerListener = () => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (typeof message?.type !== 'string') return;

    // 白名单消息：browser_* 工具的既有快速路径（含 browser_refresh / browser_set_zoom
    // 两个内联处理器与 browser_go_back 等需要参数转换的别名）
    const isWhitelisted = Object.values(TOOL_MESSAGE_TYPES).includes(message.type as any);

    // 注册表兜底：type 恰为已注册工具名的消息同样按工具调用路由。
    // 两条路径缺一不可：
    //   - 白名单覆盖「未注册但有内联处理器/别名」的消息（browser_refresh 等）；
    //   - 注册表覆盖「全部已注册工具」——包括 sidepanel 转发过来的 browser_web_fetcher、
    //     browser_bookmark_create 等尚未登记进白名单的 browser_* 工具。此前对 browser_*
    //     前缀的排除让这类转发消息无人应答，调用方只能拿到 undefined 并误报
    //     「后台无响应」；按注册表判定则天然覆盖未来新增工具，无需再人工维护白名单。
    //   非工具消息（TEXT_SELECTED / WebSocket 控制等）不会命中注册表，行为不变。
    if (message.type === 'VISION_CANCEL_REQUEST') {
      cancelGuiRequest(message.requestId);
      sendResponse({ success: true });
      return;
    }
    const isRoutedToolMessage =
      isWhitelisted ||
      highLevelToolRegistry.getTool(message.type) !== undefined;

    if (!isRoutedToolMessage) return;

    const messageType = message.type;
    const params = message;

    // 移除type字段，避免传递给工具
    const { type, __visionRequestId, ...toolParams } = params;

    // 处理工具调用
    (async () => {
      try {
        let result;

        // browser_refresh / browser_set_zoom 目前没有对应的注册工具，直接内联处理
        if (messageType === TOOL_MESSAGE_TYPES.BROWSER_REFRESH) {
          result = await handleRefresh();
        } else if (messageType === TOOL_MESSAGE_TYPES.BROWSER_SET_ZOOM) {
          result = await handleSetZoom(toolParams);
        } else {
          // 消息类型直接作为工具名（绝大多数已统一），
          // 仅少数需要通过 TOOL_NAME_OVERRIDES 映射
          const toolName = TOOL_NAME_OVERRIDES[messageType] || messageType;
          const finalParams = transformParams(messageType, toolParams);

          result = await handleCallTool({
            name: toolName,
            args: finalParams,
            context: typeof __visionRequestId === 'string' && __visionRequestId.length <= 128 ? { requestId: __visionRequestId } : undefined,
          });
        }

        sendResponse(result);
      } catch (error) {
        console.error(`Tool execution failed for ${messageType}:`, error);
        sendResponse(createErrorResponse(
          error instanceof Error ? error.message : ERROR_MESSAGES.TOOL_EXECUTION_FAILED
        ));
      }
    })();

    return true; // 表示异步响应
  });
};

// 导出工具消息类型，供其他模块使用
export { TOOL_MESSAGE_TYPES };

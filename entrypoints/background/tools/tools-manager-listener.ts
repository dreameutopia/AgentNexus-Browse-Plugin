import { browserChrome, parseBrowserScope, browserErrorText } from '@/tools/browser/browser-scope';
/**
 * 工具管理器监听器 - 处理来自侧边栏和其他页面的工具调用请求
 */

import { JS_RUN_TOOL_ID } from '@/tools/javascript/js-contract';
import type { ToolExecutionContext } from '@/tools/registry';
import { handleCallTool } from '.';
import { createErrorResponse } from '@/common/tool-handler';
import { toolRegistry as highLevelToolRegistry } from '@/tools/registry';
import { cancelGuiRequest, withGuiCancellation } from '@/tools/vision/gui-cancellation';
import { PAGE_TOOL_TARGET_MESSAGE } from '@/entrypoints/sidepanel/core/conversation/runtime-protocol';

/**
 * 工具调用消息类型
 *
 * 只登记**没有注册工具**的内联处理器。已注册工具（browser_navigation、
 * browser_tabs、browser_page_exec 等全部）由下方「注册表兜底」按
 * message.type === 工具名 自动路由，无需在此重复维护白名单。
 */
const TOOL_MESSAGE_TYPES = {
  // 内联处理器（无同名注册工具）
  BROWSER_SET_ZOOM: 'browser_set_zoom',
} as const;

/**
 * 处理 browser_set_zoom - 目前没有对应的注册工具，直接内联处理
 */
async function handleSetZoom(params: any, context?: ToolExecutionContext) {
  try {
    const { tabId, zoomFactor } = params;
    // typeof NaN 仍为 'number'，必须用 isFinite 排除 NaN/Infinity 脏值
    if (typeof zoomFactor !== 'number' || !Number.isFinite(zoomFactor)) {
      return createErrorResponse('zoomFactor is required and must be a finite number');
    }
    const tabs = tabId !== undefined && tabId !== null
      ? [await browserChrome(context).tabs.get(tabId)]
      : await browserChrome(context).tabs.query({ active: true, currentWindow: true });
    const activeTabId = tabs[0]?.id;
    if (typeof activeTabId !== 'number') {
      return createErrorResponse('No active tab found');
    }
    await browserChrome(context).tabs.setZoom(activeTabId, zoomFactor);
    return { success: true, data: { tabId: activeTabId, zoomFactor } };
  } catch (error) {
    return createErrorResponse(browserErrorText(error));
  }
}

/**
 * 初始化工具管理器监听器
 */
export const initToolsManagerListener = () => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (typeof message?.type !== 'string') return;

    // 白名单消息：无注册工具的内联处理器（browser_set_zoom）
    const isWhitelisted = Object.values(TOOL_MESSAGE_TYPES).includes(message.type as any);

    // 注册表兜底：type 恰为已注册工具名的消息同样按工具调用路由。
    // 两条路径缺一不可：
    //   - 白名单覆盖「未注册但有内联处理器」的消息（browser_set_zoom）；
    //   - 注册表覆盖「全部已注册工具」——包括 sidepanel 转发过来的
    //     browser_navigation、browser_tabs、browser_vector_search 等未登记进
    //     白名单的工具。按注册表判定天然覆盖未来新增工具，无需人工维护白名单。
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
    const { type, __visionRequestId, __pageTargetRequestId, __scriptContext, __browserScope, ...toolParams } = params;
    const onTabTarget = typeof __pageTargetRequestId === 'string' && __pageTargetRequestId.length === 36 &&
      sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('sidepanel.html')
      ? (tabId: number) => {
          void chrome.runtime.sendMessage({
            type: PAGE_TOOL_TARGET_MESSAGE, requestId: __pageTargetRequestId, tabId,
          }).catch(() => undefined);
        }
      : undefined;

    // Script context is supplied only by an extension UI, never by page parameters.
    const scriptContext: ToolExecutionContext = messageType === JS_RUN_TOOL_ID && sender.id === chrome.runtime.id && !sender.tab &&
      typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL('')) &&
      __scriptContext && typeof __scriptContext === 'object'
      ? {
          ...(typeof __scriptContext.chatId === 'string' && __scriptContext.chatId.length <= 255 ? { chatId: __scriptContext.chatId } : {}),
          ...(__scriptContext.toolPolicy === 'vision-assistant' ? { toolPolicy: 'vision-assistant' } : {}),
          ...(__scriptContext.toolApproved === true ? { toolApproved: true } : {}),
        } : {};

    // 处理工具调用
    (async () => {
      try {
        let result;
        const trustedUi = sender.id === chrome.runtime.id && !sender.tab &&
          typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
        if (__browserScope !== undefined && !trustedUi)
          throw new Error('UNTRUSTED_BROWSER_SCOPE：窗口上下文只能由扩展运行时提供。');
        const browserScope = trustedUi ? parseBrowserScope(__browserScope) : undefined;
        const context: ToolExecutionContext = { ...scriptContext, ...(browserScope ? { browserScope } : {}) };

        const scopedRequest = browserScope && typeof __visionRequestId === 'string' && __visionRequestId.length <= 128
          ? __visionRequestId : undefined;
        const execute = async (signal?: AbortSignal) => {
          if (messageType === TOOL_MESSAGE_TYPES.BROWSER_SET_ZOOM)
            return handleSetZoom(toolParams, { ...context, ...(signal ? { signal } : {}) });
          // 消息类型直接作为工具名（已注册工具经注册表兜底路由到此处）
          return handleCallTool({
            name: messageType,
            args: toolParams,
            context: {
              ...context,
              ...(signal ? { signal } : {}),
              ...(!scopedRequest && typeof __visionRequestId === 'string' && __visionRequestId.length <= 128 ? { requestId: __visionRequestId } : {}),
              ...(onTabTarget ? { onTabTarget } : {}),
            },
          });
        };
        // The outer registry owns this ID; inner tools receive the AbortSignal
        // instead of re-registering the same ID and failing as a duplicate.
        result = scopedRequest ? await withGuiCancellation(scopedRequest, execute) : await execute();

        sendResponse(result);
      } catch (error) {
        console.error(`Tool execution failed for ${messageType}:`, error);
        sendResponse(createErrorResponse(
          browserErrorText(error)
        ));
      }
    })();

    return true; // 表示异步响应
  });
};

// 导出工具消息类型，供其他模块使用
export { TOOL_MESSAGE_TYPES };

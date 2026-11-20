/**
 * 扩展页面侧的剪贴板读取宿主（sidepanel）。
 *
 * 为什么要单独一个模块：service worker 里没有 DOM、没有焦点，
 * `navigator.clipboard.readText()` 在其中不可靠（离屏文档同样无焦点，
 * 见 tools/browser/clipboard-protocol.ts）。而 sidepanel 是运行在扩展进程里的
 * **真实文档**，有焦点、持 `clipboardRead` 权限，是唯一可靠的读取执行方。
 *
 * 读取的是**系统剪贴板**，内容可能是用户刚复制的凭据或隐私数据：
 *   - 读取请求只应答发起方（扩展自身消息通道），不写日志、不落结果文件；
 *   - 由 browser_input 的工具级审批规则（requiresConfirmActions）在**调用前**
 *     向用户确认——本模块不做二次授权判断，只负责执行已获批准的读取。
 */

import { clipboardInExtensionPage } from '@/tools/browser/clipboard-client';
import { CLIPBOARD_PAGE_MSG } from '@/tools/browser/clipboard-protocol';

/**
 * 注册剪贴板读取应答器。
 *
 * @returns 注销函数（便于测试与热重载时清理）
 */
export function registerClipboardReadHost(): () => void {
  const listener = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean | undefined => {
    if (
      !message ||
      typeof message !== 'object' ||
      (message as { type?: unknown }).type !== CLIPBOARD_PAGE_MSG.READ
    )
      return undefined;
    clipboardInExtensionPage('read')
      .then((response) => sendResponse(response))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error:
            'CLIPBOARD_READ_FAILED：扩展页面读取剪贴板失败：' +
            (error instanceof Error ? error.message : String(error)),
        }),
      );
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

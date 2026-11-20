const HOST_HTML = 'screen-share-offscreen.html';

let opening: Promise<void> | undefined;

/** Chrome exposes one offscreen document per profile. All offscreen consumers share this host. */
export async function ensureOffscreenHost(): Promise<void> {
  if (!opening) {
    const create = async () => {
      if (!chrome.offscreen?.createDocument) throw new Error('The browser does not support extension offscreen documents');
      const url = chrome.runtime.getURL(HOST_HTML);
      const hasHost = async () => {
        if (typeof chrome.runtime.getContexts !== 'function') {
          return typeof chrome.offscreen.hasDocument === 'function' && await chrome.offscreen.hasDocument();
        }
        const contexts = await chrome.runtime.getContexts({
          contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        }) as unknown as { documentUrl?: string }[];
        if (contexts.some(context => context.documentUrl === url)) return true;
        if (contexts.length) throw new Error('Another offscreen page owns the extension host. Reload the extension and retry.');
        return false;
      };
      if (await hasHost()) return;
      try {
        await chrome.offscreen.createDocument({
          url,
          reasons: [
            chrome.offscreen.Reason.WORKERS,
            chrome.offscreen.Reason.BLOBS,
            chrome.offscreen.Reason.DISPLAY_MEDIA,
            chrome.offscreen.Reason.USER_MEDIA,
            chrome.offscreen.Reason.WEB_RTC,
            // 扩展侧剪贴板：service worker 无 DOM 且 Chrome 157 前不能用
            // navigator.clipboard，需要一个带 DOM 的扩展上下文代为写入系统
            // 剪贴板（协议见 tools/browser/clipboard-protocol.ts）。
            chrome.offscreen.Reason.CLIPBOARD,
          ],
          justification:
            'Run the Python worker, render downloadable diagrams, handle active screen sharing, and write to the system clipboard from the extension side',
        });
      } catch (error) {
        // Another extension context may have created the same host during startup.
        if (!await hasHost()) throw error;
      }
    };
    const ensure = async () => {
      if (typeof navigator !== 'undefined' && navigator.locks) {
        await navigator.locks.request('agentnexus-offscreen-host', create);
      } else {
        await create();
      }
    };
    opening = ensure().finally(() => { opening = undefined; });
  }
  return opening;
}

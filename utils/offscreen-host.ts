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
          ],
          justification: 'Run the Python worker, render downloadable diagrams, and handle active screen sharing',
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

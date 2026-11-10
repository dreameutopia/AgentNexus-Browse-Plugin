(() => {
  // executeScript can revisit the same document on tab switches and BFCache restores.
  const key = Symbol.for('agentnexus.page-glow.v2');
  if (globalThis[key]) return;
  globalThis[key] = true;

  const html = 'http://www.w3.org/1999/xhtml';
  let sheet;

  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'agentnexus:page-glow-v2') return;

    let host;
    let closed = false;
    let shown = false;
    let repairs = 0;
    let lastRepairAt = -Infinity;
    const observer = new MutationObserver(() => {
      if (closed || !host || host.parentNode === document.documentElement) return;
      // Recover from DOM replacement without fighting a page that keeps removing the host.
      const now = performance.now();
      if (now - lastRepairAt > 1000) repairs = 0;
      lastRepairAt = now;
      if (++repairs > 4) fail('网页反复移除光晕节点，已暂停挂载');
      else safelyMount();
    });

    function mount() {
      observer.disconnect();
      observer.observe(document, { childList: true });
      const root = document.documentElement;
      if (!root || !host) return;
      // Keep the site's head/body adjacency and body position intact.
      if (host.parentNode !== root) root.prepend(host);
      observer.observe(root, { childList: true });
      // The top layer escapes page stacking contexts and transformed roots.
      // Older browsers still have the fixed, pointer-transparent overlay.
      if (typeof host.showPopover === 'function') {
        if (host.getAttribute('popover') !== 'manual') host.setAttribute('popover', 'manual');
        try {
          if (!host.matches(':popover-open')) host.showPopover();
        } catch {
          host.removeAttribute('popover');
        }
      }
      if (!shown) {
        const style = getComputedStyle(host);
        const bounds = host.getBoundingClientRect();
        if (style.display === 'none' || style.visibility !== 'visible' ||
            bounds.width <= 0 || bounds.height <= 0) {
          throw new Error('光晕节点已挂载，但网页没有提供可见的渲染区域');
        }
        shown = true;
        port.postMessage({ type: 'shown' });
      }
    }

    function fullscreenChanged() {
      if (!host || closed) return;
      host.remove();
      safelyMount();
    }

    function dispose(type) {
      if (closed) return;
      closed = true;
      observer.disconnect();
      document.removeEventListener('fullscreenchange', fullscreenChanged);
      window.removeEventListener('pagehide', pageHidden);
      port.onMessage.removeListener(receive);
      port.onDisconnect.removeListener(disconnected);
      host?.remove();
      host = undefined;
      if (!type) return;
      try {
        port.postMessage(type);
      } catch {
        // The worker or document can disappear while the renderer is cleaning up.
      }
    }

    function disconnected() {
      void chrome.runtime.lastError;
      dispose();
    }

    function pageHidden() {
      dispose();
      port.disconnect();
    }

    function fail(error) {
      dispose({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
    }

    function safelyMount() {
      try {
        mount();
      } catch (error) {
        fail(error);
      }
    }

    function receive(message) {
      if (message?.type === 'hide') {
        dispose({ type: 'hidden' });
      } else if (message?.type === 'show' && !host && !closed) {
        try {
          host = document.createElementNS(html, 'anx-activity-glow');
          host.setAttribute('data-agentnexus-page-glow', '');
          host.setAttribute('aria-hidden', 'true');
          host.setAttribute('inert', '');
          const shadow = host.attachShadow({ mode: 'closed' });
          // Constructed styles stay in the shadow root and work under strict page CSP.
          sheet ??= createSheet();
          shadow.adoptedStyleSheets = [sheet];
          for (const side of ['top', 'right', 'bottom', 'left']) {
            const edge = document.createElementNS(html, 'div');
            edge.className = side;
            shadow.append(edge);
          }
          safelyMount();
        } catch (error) {
          fail(error);
        }
      }
    }

    port.onMessage.addListener(receive);
    port.onDisconnect.addListener(disconnected);
    // A cached document must never bring an old run's overlay back with it.
    window.addEventListener('pagehide', pageHidden);
    document.addEventListener('fullscreenchange', fullscreenChanged);
    try {
      port.postMessage({ type: 'ready' });
    } catch {
      dispose();
    }
  });

  function createSheet() {
    const style = new CSSStyleSheet();
    style.replaceSync(`
      :host {
        all: initial !important;
        display: block !important;
        position: fixed !important;
        inset: 0 !important;
        overflow: hidden !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        direction: ltr !important;
        color-scheme: normal !important;
      }
      :host::backdrop { display: none !important; pointer-events: none !important; }
      div {
        position: absolute;
        overflow: hidden;
        pointer-events: none;
        background: linear-gradient(var(--inward), rgb(55 149 248 / .95) 0,
          rgb(78 174 252 / .72) 1px, rgb(116 197 255 / .32) 2.5px, transparent 100%);
        animation: breathe 4.2s ease-in-out infinite;
      }
      .top, .bottom { left: 0; right: 0; height: min(7px, 3vh); }
      .left, .right { top: 1px; bottom: 1px; width: min(7px, 3vw); }
      .top { top: 0; --inward: to bottom; --from: -100%, 0; --to: 100vw, 0; --delay: -1.1s; --origin: center top; }
      .right { right: 0; --inward: to left; --from: 0, -100%; --to: 0, 100vh; --delay: -9.2s; --origin: right center; }
      .bottom { bottom: 0; --inward: to top; --from: 100vw, 0; --to: -100%, 0; --delay: -6.5s; --origin: center bottom; }
      .left { left: 0; --inward: to right; --from: 0, 100vh; --to: 0, -100%; --delay: -3.8s; --origin: left center; }
      div::after {
        content: '';
        position: absolute;
        background: radial-gradient(ellipse at var(--origin),
          rgb(102 224 255 / .98) 3%, rgb(61 169 255 / .65) 29%,
          rgb(106 196 255 / .24) 53%, transparent 79%);
        animation: flow 10.8s linear var(--delay) infinite;
      }
      .top::after, .bottom::after { inset: 0 auto 0 0; width: 46%; }
      .left::after, .right::after { inset: 0 0 auto 0; height: 46%; }
      @keyframes breathe { 0%, 100% { opacity: .80; } 50% { opacity: 1; } }
      @keyframes flow {
        0% { transform: translate(var(--from)); }
        32%, 100% { transform: translate(var(--to)); }
      }
      @media (prefers-reduced-motion: reduce) {
        div { animation: none; }
        div::after { content: none; }
      }
      @media (forced-colors: active) {
        div { background: Highlight; animation: none; }
        .top, .bottom { height: 1px; }
        .left, .right { width: 1px; }
        div::after { content: none; }
      }
    `);
    return style;
  }
})();

// page-clean-helper.js
// 注入隔离世界运行的「页面净化守护」脚本：按规则隐藏广告/弹窗/追踪元素，
// 并通过 MutationObserver 持续拦截 SPA 动态注入的新弹窗（这是纯 CSS 静态
// 隐藏做不到的）。支持 clearClean 完整撤销（恢复元素显示与页面滚动）。
//
// 隐藏而非删除：所有命中元素被打上 data-agentnexus-cleaned 标记并由注入 CSS
// 统一置为 display:none（important），撤销时移除标记即可恢复，不破坏页面 DOM
// 结构与框架状态。

(() => {
  // 防止重复注入
  if (window.__AGENTNEXUS_PAGE_CLEAN_HELPER__) {
    return;
  }

  const MARK_ATTR = 'data-agentnexus-cleaned';
  const STORAGE_KEY = '__agentnexusCleanState';

  const state = {
    observer: null,
    /** 已隐藏元素计数 */
    hiddenCount: 0,
    /** 当前生效的规则集 */
    activeRules: null,
    /** 撤销时需要恢复的页面滚动样式快照 */
    scrollSnapshot: null,
  };
  window.__AGENTNEXUS_PAGE_CLEAN_HELPER__ = state;

  /**
   * 分级净化规则（保守优先，避免误伤正常内容）
   * light     —— 无歧义的广告位/追踪器标记（AdsSense、GPT 广告位、aria 广告标识）
   * standard  —— 常见广告联盟位、赞助内容、Cookie/隐私同意横幅（默认）
   * aggressive—— standard + 全屏遮罩弹窗启发式识别（固定定位、高 z-index、
   *              盖住大部分视口的顶层遮罩，通常为强制关注/下载类弹窗）
   */
  const RULE_SETS = {
    light: [
      '.adsbygoogle',
      'ins.adsbygoogle',
      '[data-ad-client]',
      '[data-ad-slot]',
      '[id^="div-gpt-ad"]',
      '[id*="google_ads"]',
      '[id*="googlesyndication"]',
      '[aria-label="advertisement"]',
      '[aria-label="Ad"]',
      '[class*="sponsored-content"]',
    ],
    standard: [
      // 广告联盟 / 程序化广告位
      '[id^="ad_"]',
      '[id$="_ad"]',
      '[class^="ad-"]',
      '[class*=" ad-"]',
      '[data-ad]',
      '[data-ad-placement]',
      '[data-testid*="ad-placement"]',
      '[class*="sponsored-"]',
      '[data-sponsored]',
      // Cookie / 隐私同意横幅（常见实现）
      '#onetrust-banner-sdk',
      '#onetrust-consent-sdk',
      '#CybotCookiebotDialog',
      '.qc-cmp2-container',
      '.cc-window',
      '.cc-banner',
      '[id*="cookie-banner"]',
      '[class*="cookie-consent"]',
      '[id*="gdpr-banner"]',
      '[aria-label*="cookie" i]',
      // 常见下载站/资讯站诱导浮层标记
      '[class*="download-guide"]',
      '[class*="float-ad"]',
      '[class*="popup-ad"]',
    ],
  };

  /** aggressive 模式的启发式遮罩识别参数 */
  const OVERLAY_HEURISTIC = {
    minZIndex: 900,
    minViewportRatio: 0.7,
    mustBeBodyChild: true,
  };

  /** 判断元素当前是否可见 */
  function isVisible(el) {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  }

  /** 收集当前命中的净化目标元素（去重） */
  function collectTargets(rules) {
    const targets = new Set();
    for (const selector of rules) {
      let matches;
      try {
        matches = document.querySelectorAll(selector);
      } catch {
        continue; // 非法选择器直接跳过
      }
      matches.forEach((el) => targets.add(el));
    }
    return targets;
  }

  /** aggressive：启发式识别全屏遮罩弹窗 */
  function collectOverlayHeuristic() {
    const overlays = new Set();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (!vw || !vh) return overlays;

    const candidates = document.querySelectorAll('body > *');
    for (const el of candidates) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.hasAttribute(MARK_ATTR)) continue;
      // 跳过页面主容器与脚本自身挂载节点
      if (el.id === 'agentnexus-root') continue;

      const style = window.getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'absolute') continue;
      const zIndex = parseInt(style.zIndex, 10);
      if (!Number.isNaN(zIndex) && zIndex < OVERLAY_HEURISTIC.minZIndex) continue;
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const ratio = (rect.width * rect.height) / (vw * vh);
      if (ratio >= OVERLAY_HEURISTIC.minViewportRatio) {
        overlays.add(el);
      }
    }
    return overlays;
  }

  /** 执行一轮净化：给命中元素打标记（由注入 CSS 统一隐藏） */
  function applyRules(rules, aggressive) {
    let hidden = 0;
    const targets = collectTargets(rules);
    if (aggressive) {
      collectOverlayHeuristic().forEach((el) => targets.add(el));
    }

    targets.forEach((el) => {
      if (el.hasAttribute(MARK_ATTR)) return;
      // 只隐藏可见元素，避免给已隐藏元素打标记导致撤销时误显示
      if (!isVisible(el)) return;
      el.setAttribute(MARK_ATTR, '1');
      hidden++;
    });

    // 弹窗常把 body 锁死滚动：记录并恢复，避免隐藏遮罩后页面仍不可滚动
    if (hidden > 0 && aggressive) {
      restoreScrollInternal();
      const bodyStyle = window.getComputedStyle(document.body);
      if (bodyStyle.overflow === 'hidden' || bodyStyle.overflowY === 'hidden') {
        if (!state.scrollSnapshot) {
          state.scrollSnapshot = {
            bodyOverflow: document.body.style.overflow,
            bodyOverflowY: document.body.style.overflowY,
            htmlOverflow: document.documentElement.style.overflow,
          };
        }
        document.body.style.setProperty('overflow', 'auto', 'important');
        document.body.style.setProperty('overflow-y', 'auto', 'important');
        document.documentElement.style.setProperty('overflow', 'auto', 'important');
      }
    }

    state.hiddenCount += hidden;
    return hidden;
  }

  /** 内部滚动恢复（撤销时复用） */
  function restoreScrollInternal() {
    if (!state.scrollSnapshot) return;
    document.body.style.removeProperty('overflow');
    document.body.style.removeProperty('overflow-y');
    document.documentElement.style.removeProperty('overflow');
    if (state.scrollSnapshot.bodyOverflow) {
      document.body.style.overflow = state.scrollSnapshot.bodyOverflow;
    }
    if (state.scrollSnapshot.bodyOverflowY) {
      document.body.style.overflowY = state.scrollSnapshot.bodyOverflowY;
    }
    if (state.scrollSnapshot.htmlOverflow) {
      document.documentElement.style.overflow = state.scrollSnapshot.htmlOverflow;
    }
    state.scrollSnapshot = null;
  }

  /** 启动持续守护（拦截 SPA 动态注入的新弹窗） */
  function startObserver(rules, aggressive) {
    stopObserver();
    state.observer = new MutationObserver((mutations) => {
      // 合并处理高频 DOM 变更：仅当有节点加入时才扫描
      let hasAddedNodes = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes && mutation.addedNodes.length > 0) {
          hasAddedNodes = true;
          break;
        }
      }
      if (!hasAddedNodes) return;
      applyRules(rules, aggressive);
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  }

  /** 撤销全部净化：移除所有标记并恢复滚动 */
  function clearAll() {
    stopObserver();
    const marked = document.querySelectorAll(`[${MARK_ATTR}]`);
    marked.forEach((el) => el.removeAttribute(MARK_ATTR));
    restoreScrollInternal();
    const restored = marked.length;
    state.hiddenCount = 0;
    state.activeRules = null;
    return restored;
  }

  // ──── 消息处理（background → 本脚本）────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.action !== 'string') return;

    // BaseBrowserTool.injectContentScript 及其它调用方的存活探测
    // （探测 action 形如 "<toolName>_ping"，统一应答 pong）
    if (message.action === 'page_clean_helper_ping' || message.action.endsWith('_ping')) {
      sendResponse({ status: 'pong' });
      return true;
    }

    if (message.action === 'applyClean') {
      const { rules = [], aggressive = false, persist = true } = message.payload || {};
      const hidden = applyRules(rules, aggressive);
      if (persist) {
        startObserver(rules, aggressive);
        state.activeRules = { rules, aggressive };
        try {
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ rules, aggressive, at: Date.now() }));
        } catch {
          // sessionStorage 不可用时忽略（守护仍随页面生命周期存活）
        }
      }
      sendResponse({ success: true, hidden, totalHidden: state.hiddenCount, observing: !!state.observer });
      return true;
    }

    if (message.action === 'clearClean') {
      const restored = clearAll();
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        // 忽略
      }
      sendResponse({ success: true, restored });
      return true;
    }

    if (message.action === 'getCleanStatus') {
      sendResponse({
        success: true,
        observing: !!state.observer,
        hiddenCount: state.hiddenCount,
        activeRules: state.activeRules,
      });
      return true;
    }
  });
})();

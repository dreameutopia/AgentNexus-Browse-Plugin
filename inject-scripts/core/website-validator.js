/**
 * 网站自动验证注入脚本（主世界）
 * 在页面中检测并调用 window.isFromLocalManage，一旦成功则通知扩展。
 */
(function () {
  'use strict';

  if (window.__websiteValidatorInjected) return;
  window.__websiteValidatorInjected = true;

  const MAX_ATTEMPTS = 30; // 最多尝试次数
  const INTERVAL_MS = 500; // 尝试间隔
  let attempts = 0;
  let timer = null;

  function sendSuccess(detail) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.sendMessage({
          type: 'WEBSITE_VALIDATION_SUCCESS',
          url: location.href,
          detail,
        });
      }
    } catch (e) {
      // 忽略消息发送错误
    }
  }

  async function tryValidate() {
    attempts++;
    try {
      const fn = window.isFromLocalManage;
      if (typeof fn === 'function') {
        let result;
        try {
          result = fn();
        } catch (e) {
          result = { error: e && e.message ? e.message : String(e) };
        }

        if (result && typeof result === 'object' && typeof result.then === 'function') {
          try {
            result = await result;
          } catch (e) {
            result = { error: e && e.message ? e.message : String(e) };
          }
        }

        const ok = !(result && typeof result === 'object' && 'error' in result);
        sendSuccess({ ok, result });
        if (timer) clearInterval(timer);
        return true;
      }
    } catch (err) {
      // 忽略单次失败
    }

    if (attempts >= MAX_ATTEMPTS) {
      if (timer) clearInterval(timer);
    }
    return false;
  }

  // 首次尝试 + 周期重试
  tryValidate();
  timer = setInterval(tryValidate, INTERVAL_MS);

  // 标签页变为可见时再尝试一次
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      tryValidate();
    }
  });

  // 页面卸载时清理
  window.addEventListener('beforeunload', () => {
    if (timer) clearInterval(timer);
  });

  // 暴露控制句柄
  window.__websiteValidator = {
    stop: function () {
      if (timer) clearInterval(timer);
    },
  };
})();
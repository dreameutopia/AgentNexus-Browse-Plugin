// entrypoints/permission/main.ts
import './style.css';
import { initLocale, t, applyDomI18n } from '@/utils/i18n/core';

document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const statusText = document.getElementById('status-text');

  // 先完成语言初始化并注入静态文案（[data-i18n] 节点），再揭开页面：
  // 避免用户先看到未本地化的原始 HTML 闪一下后才被替换。
  void initLocale()
    .catch(() => undefined)
    .finally(() => {
      applyDomI18n();

      if (urlParams.get('reason') === 'mic-permission') {
        if (statusText) {
          statusText.textContent = t('permission.requesting');
          statusText.style.color = '';
        }
        revealPage();
        requestMicrophoneAndRespond(statusText);
      } else {
        if (statusText) {
          statusText.textContent = t('permission.invalidPage');
          statusText.style.color = '#ff6b6b';
        }
        revealPage();
      }
    });
});

/** 给 <html> 标记 app-ready 以揭开正文（过渡样式见 index.html 内联样式），并淡出移除加载遮罩 */
function revealPage() {
  document.documentElement.classList.add('app-ready');
  const loading = document.getElementById('app-loading');
  if (!loading) return;
  loading.addEventListener(
    'transitionend',
    () => loading.remove(),
    { once: true },
  );
  // 兜底：页面被挂起等情况下 transitionend 可能不触发
  setTimeout(() => loading.remove(), 600);
}

async function requestMicrophoneAndRespond(statusEl: HTMLElement | null) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // 权限获取成功
    if (statusEl) {
      statusEl.textContent = t('permission.grantSuccess');
      statusEl.style.color = '#6ab04c'; // 绿色表示成功
    }
    
    // 告诉主应用权限已拿到
    chrome.runtime.sendMessage({ type: 'PERMISSION_RESULT', success: true });

    // 停止临时的音频流轨道
    stream.getTracks().forEach(track => track.stop());

  } catch (err) {
    console.error('在权限页面获取麦克风失败:', err);
    if (statusEl) {
      statusEl.textContent = t('permission.grantFailed');
      statusEl.style.color = '#ff6b6b'; // 红色表示失败
    }
    
    // 告诉主应用权限获取失败
    chrome.runtime.sendMessage({ type: 'PERMISSION_RESULT', success: false });

  } finally {
    // 延迟2秒后关闭此页面，让用户有时间看到结果
    setTimeout(() => {
      window.close();
    }, 2000);
  }
}
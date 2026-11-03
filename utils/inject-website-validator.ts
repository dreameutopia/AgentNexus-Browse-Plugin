/**
 * 注入网站验证脚本
 * 在所有匹配页面中加载 inject-scripts/core/website-validator.js
 */
export async function injectWebsiteValidator(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'INJECT_PAGE_SCRIPT',
      file: 'inject-scripts/core/website-validator.js'
    });

    if (!response?.success) {
      console.error('Failed to inject website validator script:', response?.error || 'unknown error');
    }
  } catch (e) {
    console.error('Exception while injecting website validator:', e);
  }
}
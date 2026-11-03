/**
 * 注入录制面板脚本（通过 background 使用 chrome.scripting.executeScript）
 */
export async function injectRecordingPanel(): Promise<void> {
  // 检查是否已经注入
  if (document.getElementById('workflow-recording-panel')) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'INJECT_PAGE_SCRIPT',
      file: 'inject-scripts/ui/recording-panel.js'
    });

    if (!response?.success) {
      console.error('Failed to inject recording panel script:', response?.error || 'unknown error');
    }
  } catch (error) {
    console.error('Failed to inject recording panel script:', error);
  }
}
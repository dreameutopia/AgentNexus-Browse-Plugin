/**
 * 下载测试相关逻辑 composable
 */
import { ref } from 'vue';

export function useDownloadTest() {
  const downloadTestInfo = ref<string>('');

  const triggerTestDownload = async () => {
    downloadTestInfo.value = '正在触发测试下载...';
    try {
      const testUrl = 'https://raw.githubusercontent.com/github/gitignore/main/Node.gitignore';
      await chrome.downloads.download({
        url: testUrl,
        filename: 'test-download-' + Date.now() + '.txt',
        saveAs: false
      });
      downloadTestInfo.value = '✅ 测试下载已触发，请点击"执行工具"查看下载状态';
    } catch (error: any) {
      downloadTestInfo.value = '❌ 下载触发失败: ' + error.message;
    }
  };

  /**
   * 刷新下载列表。
   * 调用方（ToolTestPanel 的 refreshDownloads 事件）不携带参数，
   * 因此 executeToolFn 为可选：没有就只刷新 UI 提示。
   */
  const refreshDownloads = async (executeToolFn?: () => Promise<void>) => {
    downloadTestInfo.value = '正在刷新下载列表...';
    try {
      if (executeToolFn) {
        await executeToolFn();
      }
      downloadTestInfo.value = '✅ 下载列表已刷新';
    } catch (error: any) {
      downloadTestInfo.value = '❌ 刷新失败: ' + error.message;
    }
  };

  return {
    downloadTestInfo,
    triggerTestDownload,
    refreshDownloads
  };
}

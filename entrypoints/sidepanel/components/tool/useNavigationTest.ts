/**
 * 导航压力测试相关逻辑 composable
 */
import { ref } from 'vue';
import type { NavigationTestResult } from './types';
import { testUrls } from './tool-definitions';

export function useNavigationTest() {
  const isNavigationTesting = ref(false);
  const testProgress = ref(0);
  const navigationTestResult = ref<NavigationTestResult | null>(null);

  const runNavigationTest = async () => {
    isNavigationTesting.value = true;
    testProgress.value = 0;
    navigationTestResult.value = null;

    const logs: Array<{ url: string; time: number; error?: string }> = [];
    const startTime = Date.now();
    let successCount = 0;
    let failedCount = 0;

    console.log('🚀 开始导航压力测试，共 ' + testUrls.length + ' 个 URL');
    console.log('⏱️ 请求间隔：100ms（模拟高并发场景）');

    for (let i = 0; i < testUrls.length; i++) {
      const url = testUrls[i];
      const requestStart = Date.now();

      try {
        console.log(`[${i + 1}/${testUrls.length}] 导航到: ${url}`);

        const response = await chrome.runtime.sendMessage({
          type: 'CALL_TOOL',
          tool: {
            name: 'browser_navigation',
            args: {
              action: 'open',
              url: url,
              waitForLoad: true,
              timeout: 30000
            }
          }
        });

        const requestTime = Date.now() - requestStart;

        if (response && response.success !== false) {
          successCount++;
          console.log(`✅ [${i + 1}] 成功 (${requestTime}ms): ${url}`);
          logs.push({ url, time: requestTime });
        } else {
          failedCount++;
          const errorMsg = response?.error || 'Unknown error';
          console.error(`❌ [${i + 1}] 失败 (${requestTime}ms): ${url}`, errorMsg);
          logs.push({ url, time: requestTime, error: errorMsg });
        }
      } catch (error: any) {
        const requestTime = Date.now() - requestStart;
        failedCount++;
        const errorMsg = error.message || String(error);
        console.error(`❌ [${i + 1}] 异常 (${requestTime}ms): ${url}`, errorMsg);
        logs.push({ url, time: requestTime, error: errorMsg });
      }

      testProgress.value = i + 1;

      if (i < testUrls.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    const totalTime = Date.now() - startTime;
    const avgTime = Math.round(logs.reduce((sum, log) => sum + log.time, 0) / logs.length);

    console.log('✨ 导航测试完成！');
    console.log(`📊 总耗时: ${totalTime}ms`);
    console.log(`📊 平均耗时: ${avgTime}ms`);
    console.log(`✅ 成功: ${successCount}`);
    console.log(`❌ 失败: ${failedCount}`);

    navigationTestResult.value = {
      total: testUrls.length,
      success: successCount,
      failed: failedCount,
      totalTime,
      avgTime,
      logs
    };

    isNavigationTesting.value = false;
  };

  const clearNavigationTest = () => {
    navigationTestResult.value = null;
    testProgress.value = 0;
  };

  return {
    testUrls,
    isNavigationTesting,
    testProgress,
    navigationTestResult,
    runNavigationTest,
    clearNavigationTest
  };
}

/**
 * 页面视觉效果管理 Composable
 * 管理AI响应时的页面光晕、边框效果等视觉反馈
 */

import { borderEffectManager } from '../utils/ui/border-effect-manager';

export function usePageEffects() {
  // 页面光晕效果
  const addPageGlow = () => {
    document.body.classList.add('ai-responding');
  };

  const removePageGlow = () => {
    document.body.classList.remove('ai-responding');
  };

  // 页面边框效果 - 使用新的BorderEffectManager
  const addPageBorderEffect = async () => {
    try {
      await borderEffectManager.addCurrentTabBorderEffect();
    } catch (error) {
      console.error('添加页面边框效果失败:', error);
      throw error;
    }
  };

  const removePageBorderEffect = async () => {
    try {
      await borderEffectManager.removeAllTabsBorderEffect();
    } catch (error) {
      console.error('移除页面边框效果失败:', error);
      throw error;
    }
  };

  // 开始边框效果管理（对话开始时调用）
  const startBorderEffectManagement = async () => {
    try {
      await borderEffectManager.startBorderEffect();
    } catch (error) {
      console.error('启动边框效果管理失败:', error);
      throw error;
    }
  };

  // 停止边框效果管理（对话结束时调用）
  const stopBorderEffectManagement = async () => {
    try {
      await borderEffectManager.stopBorderEffect();
    } catch (error) {
      console.error('停止边框效果管理失败:', error);
      throw error;
    }
  };

  // 获取当前活动标签页ID
  const getCurrentTabId = (): Promise<number> => {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          reject(new Error(`获取标签页失败: ${chrome.runtime.lastError.message}`));
          return;
        }
        if (!tabs || tabs.length === 0) {
          reject(new Error('未找到活动标签页'));
          return;
        }
        resolve(tabs[0].id!);
      });
    });
  };

  // 注入边框控制脚本
  const injectBorderControllerScript = (tabId: number): Promise<void> => {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          files: ['inject-scripts/vision/border-controller.js']
        },
        (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(`脚本注入失败: ${chrome.runtime.lastError.message}`));
            return;
          }
          console.log(`边框控制脚本已成功注入到标签页 ${tabId}`);
          resolve();
        }
      );
    });
  };

  // 发送边框控制消息
  const sendBorderMessage = (tabId: number, show: boolean): Promise<void> => {
    return new Promise((resolve, reject) => {
      const timeout = 5000; // 5秒超时
      const timeoutId = setTimeout(() => {
        reject(new Error('等待边框控制脚本响应超时'));
      }, timeout);

      chrome.tabs.sendMessage(
        tabId,
        { action: 'toggleBorder', show },
        (response) => {
          clearTimeout(timeoutId);

          if (chrome.runtime.lastError) {
            reject(new Error(`消息发送失败: ${chrome.runtime.lastError.message}`));
            return;
          }

          if (!response) {
            reject(new Error('边框控制脚本未响应'));
            return;
          }

          if (response.success) {
            console.log(`边框效果${show ? '显示' : '隐藏'}成功:`, response.message);
            resolve();
          } else {
            reject(new Error(`边框控制失败: ${response.message || '未知错误'}`));
          }
        }
      );
    });
  };

  return {
    addPageGlow,
    removePageGlow,
    addPageBorderEffect,
    removePageBorderEffect,
    startBorderEffectManagement,
    stopBorderEffectManagement,
    getCurrentTabId,
    injectBorderControllerScript,
    sendBorderMessage,
  };
}

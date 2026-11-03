// 验证当前活动页面并在检测到时触发调用 isFromLocalManage
// 以及提供基于标签页/网站变化的自动重复验证直到成功的监听器

export interface ValidationResult {
  matched: boolean;
  called: boolean;
  returnValue?: any;
  message: string;
  url: string;
  titleBefore: string;
  titleAfter: string;
}

// 单次验证：检测并在顶层主世界触发调用
export async function validateActiveTabAndTrigger(): Promise<ValidationResult | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (!tabId) {
      return {
        matched: false,
        called: false,
        message: '无法获取当前活动标签页',
        url: '',
        titleBefore: '',
        titleAfter: ''
      };
    }

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: async () => {
        try {
          if (window !== window.top) {
            return null;
          }
          const titleBefore = document.title;
          const exists = typeof (window as any).isFromLocalManage === 'function';
          let called = false;
          let returnValue: any = undefined;

          if (exists) {
            try {
              returnValue = (window as any).isFromLocalManage();
              called = true;
            } catch (e) {
              return {
                matched: true,
                called,
                message: '找到isFromLocalManage，但调用时发生错误: ' + ((e as any)?.message || String(e)),
                url: window.location.href,
                titleBefore,
                titleAfter: document.title,
              };
            }
            await new Promise(r => setTimeout(r, 150));
          }

          const titleAfter = document.title;
          return {
            matched: exists,
            called,
            returnValue,
            message: exists
              ? (called ? '已调用isFromLocalManage以触发页面状态更新' : '检测到isFromLocalManage但未触发调用')
              : '当前网站不匹配：未找到isFromLocalManage函数',
            url: window.location.href,
            titleBefore,
            titleAfter,
          };
        } catch (error: any) {
          return {
            matched: false,
            called: false,
            message: '检测/触发过程中发生错误：' + (error?.message || String(error)),
            url: window.location.href,
            titleBefore: document.title,
            titleAfter: document.title,
          };
        }
      },
    });

    const firstValid = injectionResults.find(r => r?.result)?.result as ValidationResult | null;
    return firstValid || null;
  } catch (error) {
    return {
      matched: false,
      called: false,
      message: '执行验证过程中发生错误：' + (error instanceof Error ? error.message : '未知错误'),
      url: '',
      titleBefore: '',
      titleAfter: '',
    };
  }
}

// 启动自动验证监听：浏览器插件加载后执行一次；随后监听标签/网站变化，直到成功一次为止
export function startWebsiteValidationWatcher(
  onSuccess: (result: ValidationResult) => void,
  options?: { initialRun?: boolean }
): { stop: () => void } {
  let stopped = false;
  let pending = false;

  const tryValidate = async () => {
    if (stopped || pending) return;
    pending = true;
    try {
      const result = await validateActiveTabAndTrigger();
      if (result && result.matched && result.called) {
        onSuccess(result);
        stop();
      }
    } catch {
      // 忽略错误，等待下一次事件
    } finally {
      pending = false;
    }
  };

  const onUpdated = async (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo, _tab: chrome.tabs.Tab) => {
    // URL变更或加载完成时重试
    if (stopped) return;
    if (changeInfo.status === 'complete' || (changeInfo as any).url) {
      tryValidate();
    }
  };

  const onActivated = async (_activeInfo: chrome.tabs.TabActiveInfo) => {
    if (stopped) return;
    tryValidate();
  };

  const onFocusChanged = async (_windowId: number) => {
    if (stopped) return;
    tryValidate();
  };

  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.windows.onFocusChanged.addListener(onFocusChanged);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.windows.onFocusChanged.removeListener(onFocusChanged);
    } catch {
      // 忽略移除监听错误
    }
  };

  if (options?.initialRun) {
    // 初次加载立即尝试一次
    tryValidate();
  }

  return { stop };
}
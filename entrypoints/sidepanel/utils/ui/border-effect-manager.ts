/**
 * 边框效果管理工具类
 * 负责统一管理标签页的边框效果，确保在对话过程中正确添加和移除边框效果
 */
export class BorderEffectManager {
  private isActive = false;
  private currentTabId: number | null = null;
  private tabUpdateListener: ((tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void) | null = null;
  private tabActivatedListener: ((activeInfo: chrome.tabs.TabActiveInfo) => void) | null = null;
  private windowFocusListener: ((windowId: number) => void) | null = null;

  /**
   * 开始边框效果管理
   * 添加当前标签页边框效果并启动标签页变化监听
   */
  async startBorderEffect(): Promise<void> {
    try {
      if (this.isActive) {
        console.log('BorderEffectManager: 边框效果管理已经激活');
        return;
      }

      this.isActive = true;
      
      // 首先移除所有可能存在的边框效果
      await this.removeAllTabsBorderEffect();
      
      // 添加当前标签页边框效果
      await this.addCurrentTabBorderEffect();
      
      // 启动监听器
      this.setupListeners();
      
      console.log('BorderEffectManager: 边框效果管理已启动');
    } catch (error) {
      console.error('BorderEffectManager: 启动边框效果管理失败:', error);
      this.isActive = false;
    }
  }

  /**
   * 停止边框效果管理
   * 移除所有边框效果并停止监听
   */
  async stopBorderEffect(): Promise<void> {
    try {
      if (!this.isActive) {
        console.log('BorderEffectManager: 边框效果管理未激活');
        return;
      }

      this.isActive = false;
      
      // 移除所有边框效果
      await this.removeAllTabsBorderEffect();
      
      // 移除监听器
      this.removeListeners();
      
      // 重置状态
      this.currentTabId = null;
      
      console.log('BorderEffectManager: 边框效果管理已停止');
    } catch (error) {
      console.error('BorderEffectManager: 停止边框效果管理失败:', error);
    }
  }

  /**
   * 给当前活动标签页添加边框效果
   */
  async addCurrentTabBorderEffect(): Promise<void> {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!activeTab || !activeTab.id) {
        console.warn('BorderEffectManager: 无法获取当前活动标签页');
        return;
      }

      // 如果当前标签页已经有边框效果，不重复添加
      if (this.currentTabId === activeTab.id) {
        console.log('BorderEffectManager: 当前标签页已有边框效果');
        return;
      }

      // 检查标签页是否可以注入脚本
      if (!this.canInjectScript(activeTab.url)) {
        console.warn('BorderEffectManager: 无法在此页面注入脚本:', activeTab.url);
        return;
      }

      // 注入边框效果样式
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: this.injectBorderEffect,
      });

      this.currentTabId = activeTab.id;
      console.log('BorderEffectManager: 已为标签页添加边框效果:', activeTab.id);
    } catch (error) {
      console.error('BorderEffectManager: 添加边框效果失败:', error);
    }
  }

  /**
   * 移除所有标签页的边框效果
   */
  async removeAllTabsBorderEffect(): Promise<void> {
    try {
      const tabs = await chrome.tabs.query({});
      
      const removePromises = tabs.map(async (tab) => {
        if (!tab.id || !this.canInjectScript(tab.url)) {
          return;
        }

        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: this.removeBorderEffect,
          });
        } catch (error) {
          // 忽略单个标签页的错误，可能是标签页已关闭或无法访问
        }
      });

      await Promise.allSettled(removePromises);
      this.currentTabId = null;
      console.log('BorderEffectManager: 已移除所有标签页的边框效果');
    } catch (error) {
      console.error('BorderEffectManager: 移除所有边框效果失败:', error);
    }
  }

  /**
   * 设置监听器
   */
  private setupListeners(): void {
    // 标签页更新监听器（处理页面刷新、导航等）
    this.tabUpdateListener = async (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (!this.isActive) return;

      // 当页面完成加载时，重新添加边框效果
      if (changeInfo.status === 'complete' && tab.active) {
        console.log('BorderEffectManager: 检测到页面加载完成，重新添加边框效果');
        await this.handleTabChange();
      }
    };

    // 标签页激活监听器（处理标签页切换）
    this.tabActivatedListener = async (activeInfo: chrome.tabs.TabActiveInfo) => {
      if (!this.isActive) return;

      console.log('BorderEffectManager: 检测到标签页切换');
      await this.handleTabChange();
    };

    // 窗口焦点监听器（处理窗口切换）
    this.windowFocusListener = async (windowId: number) => {
      if (!this.isActive || windowId === chrome.windows.WINDOW_ID_NONE) return;

      console.log('BorderEffectManager: 检测到窗口焦点变化');
      await this.handleTabChange();
    };

    // 注册监听器
    chrome.tabs.onUpdated.addListener(this.tabUpdateListener);
    chrome.tabs.onActivated.addListener(this.tabActivatedListener);
    chrome.windows.onFocusChanged.addListener(this.windowFocusListener);
  }

  /**
   * 移除监听器
   */
  private removeListeners(): void {
    if (this.tabUpdateListener) {
      chrome.tabs.onUpdated.removeListener(this.tabUpdateListener);
      this.tabUpdateListener = null;
    }

    if (this.tabActivatedListener) {
      chrome.tabs.onActivated.removeListener(this.tabActivatedListener);
      this.tabActivatedListener = null;
    }

    if (this.windowFocusListener) {
      chrome.windows.onFocusChanged.removeListener(this.windowFocusListener);
      this.windowFocusListener = null;
    }
  }

  /**
   * 处理标签页变化
   */
  private async handleTabChange(): Promise<void> {
    try {
      // 移除所有边框效果
      await this.removeAllTabsBorderEffect();
      
      // 短暂延迟后添加当前标签页边框效果
      setTimeout(async () => {
        if (this.isActive) {
          await this.addCurrentTabBorderEffect();
        }
      }, 100);
    } catch (error) {
      console.error('BorderEffectManager: 处理标签页变化失败:', error);
    }
  }

  /**
   * 检查是否可以在指定URL注入脚本
   */
  private canInjectScript(url?: string): boolean {
    if (!url) return false;
    
    // 不能在扩展页面、chrome://、about:// 等特殊页面注入脚本
    const restrictedProtocols = ['chrome:', 'chrome-extension:', 'moz-extension:', 'about:', 'edge:', 'opera:'];
    return !restrictedProtocols.some(protocol => url.startsWith(protocol));
  }

  /**
   * 注入边框效果的函数（在页面上下文中执行）
   */
  private injectBorderEffect(): void {
    // 移除可能存在的旧边框效果
    const existingBorder = document.getElementById('AgentNexus-page-border');
    if (existingBorder) {
      existingBorder.remove();
    }

    // 创建边框元素
    const borderElement = document.createElement('div');
    borderElement.id = 'AgentNexus-page-border';
    borderElement.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      border: 3px solid #4CAF50;
      pointer-events: none;
      z-index: 2147483647;
      box-sizing: border-box;
      border-radius: 8px;
      box-shadow: 0 0 20px rgba(76, 175, 80, 0.3);
      animation: AgentNexus-border-pulse 2s ease-in-out infinite;
    `;

    // 添加动画样式
    const styleElement = document.createElement('style');
    styleElement.textContent = `
      @keyframes AgentNexus-border-pulse {
        0%, 100% {
          border-color: #4CAF50;
          box-shadow: 0 0 20px rgba(76, 175, 80, 0.3);
        }
        50% {
          border-color: #66BB6A;
          box-shadow: 0 0 30px rgba(76, 175, 80, 0.5);
        }
      }
    `;
    
    document.head.appendChild(styleElement);
    document.body.appendChild(borderElement);
  }

  /**
   * 移除边框效果的函数（在页面上下文中执行）
   */
  private removeBorderEffect(): void {
    // 移除边框元素
    const borderElement = document.getElementById('AgentNexus-page-border');
    if (borderElement) {
      borderElement.remove();
    }

    // 移除动画样式
    const styles = document.querySelectorAll('style');
    styles.forEach(style => {
      if (style.textContent && style.textContent.includes('AgentNexus-border-pulse')) {
        style.remove();
      }
    });
  }
}

// 创建单例实例
export const borderEffectManager = new BorderEffectManager();
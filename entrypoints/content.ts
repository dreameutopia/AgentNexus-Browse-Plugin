import { injectWebsiteValidator } from '@/utils/inject-website-validator'
import { htmlToMarkdown } from '@/utils/html-to-markdown'
import { initLocale, t } from '@/utils/i18n/core'
import { readSelectedText } from '@/utils/selection/read-selection'

// 恢复用户语言（content script 与其它扩展上下文共享同一选择）
void initLocale()

// 保存页面提示 UI
let saveToastElement: HTMLElement | null = null;
let saveAbortController: AbortController | null = null;
let saveAborted = false; // 新增标志位，确保中止状态不会被重置

// 获取中止信号
function getSaveAbortSignal(): AbortSignal | null {
  return saveAbortController?.signal || null;
}

// 检查是否已中止
function isSaveAborted(): boolean {
  return saveAborted || (saveAbortController?.signal.aborted ?? false);
}

// 中止保存操作
function abortSave() {
  if (saveAbortController || !saveAborted) {
    saveAborted = true; // 设置标志位
    if (saveAbortController) {
      saveAbortController.abort();
      saveAbortController = null;
    }
    showSaveToast('error', t('content.cancelSave'));
  }
}

function showSaveToast(status: 'saving' | 'success' | 'error', message?: string, onAbort?: () => void) {
  // 移除旧的提示
  if (saveToastElement) {
    saveToastElement.remove();
    saveToastElement = null;
  }

  // 创建新的提示元素
  saveToastElement = document.createElement('div');
  saveToastElement.id = 'mcp-save-toast';
  
  const styles = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 24px;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.05);
    backdrop-filter: blur(10px);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    color: #fff;
    animation: mcp-toast-slide-in 0.3s ease-out;
  `;
  
  saveToastElement.setAttribute('style', styles);
  
  // 添加动画样式
  const styleSheet = document.createElement('style');
  styleSheet.textContent = `
    @keyframes mcp-toast-slide-in {
      from {
        opacity: 0;
        transform: translateX(-50%) translateY(-20px);
      }
      to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
    }
    @keyframes mcp-toast-slide-out {
      from {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      to {
        opacity: 0;
        transform: translateX(-50%) translateY(-20px);
      }
    }
    @keyframes mcp-spinner {
      to { transform: rotate(360deg); }
    }
    #mcp-save-abort-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      margin-left: 8px;
      padding: 0;
      background: rgba(239, 68, 68, 0.2);
      border: 1px solid rgba(239, 68, 68, 0.4);
      border-radius: 6px;
      color: #f87171;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    #mcp-save-abort-btn:hover {
      background: rgba(239, 68, 68, 0.3);
      border-color: rgba(239, 68, 68, 0.6);
      color: #fca5a5;
    }
  `;
  saveToastElement.appendChild(styleSheet);
  
  let iconHtml = '';
  let textContent = '';
  
  if (status === 'saving') {
    iconHtml = `<div style="
      width: 20px;
      height: 20px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: #60a5fa;
      border-radius: 50%;
      animation: mcp-spinner 0.8s linear infinite;
    "></div>`;
    textContent = t('content.savingPage');
  } else if (status === 'success') {
    iconHtml = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" style="color: #34d399;">
      <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
    </svg>`;
    textContent = message || t('content.saveSuccess');
  } else {
    iconHtml = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" style="color: #f87171;">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
      <path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
    textContent = message || t('content.saveFailed');
  }
  
  const iconSpan = document.createElement('span');
  iconSpan.innerHTML = iconHtml;
  saveToastElement.appendChild(iconSpan);
  
  const textSpan = document.createElement('span');
  textSpan.textContent = textContent;
  textSpan.style.cssText = 'font-weight: 500; letter-spacing: 0.3px;';
  saveToastElement.appendChild(textSpan);
  
  // 保存中状态添加中止按钮
  if (status === 'saving') {
    const abortBtn = document.createElement('button');
    abortBtn.id = 'mcp-save-abort-btn';
    abortBtn.title = t('content.abortSave');
    abortBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
      <path d="M18 6L6 18M6 6l12 12"/>
    </svg>`;
    abortBtn.onclick = (e) => {
      e.stopPropagation();
      abortSave();
    };
    saveToastElement.appendChild(abortBtn);
  }
  
  document.body.appendChild(saveToastElement);
  
  // 成功或失败后自动消失
  if (status === 'success' || status === 'error') {
    setTimeout(() => {
      if (saveToastElement) {
        saveToastElement.style.animation = 'mcp-toast-slide-out 0.3s ease-out forwards';
        setTimeout(() => {
          saveToastElement?.remove();
          saveToastElement = null;
        }, 300);
      }
    }, 2000);
  }
}

function hideSaveToast() {
  if (saveToastElement) {
    saveToastElement.style.animation = 'mcp-toast-slide-out 0.3s ease-out forwards';
    setTimeout(() => {
      saveToastElement?.remove();
      saveToastElement = null;
    }, 300);
  }
}

/**
 * V2026.09.24 前台中转：注入 relayPort 嗅探桥。
 *
 * 页面主世界的 window.getRelayPort()（trigger 页暴露）在 content script
 * 隔离世界不可直接访问，经注入的 <script> 读取后 postMessage 回传。
 */
function injectRelayPortSniffer() {
  const BRIDGE_EVENT = '__agentnexus_relay_port__';

  // 先监听主世界回传
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== BRIDGE_EVENT) {
      return;
    }
    const port = event.data.relayPort;
    if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536) {
      console.log('[RelayPortSniffer] 检测到 relayPort:', port);
      chrome.runtime.sendMessage({ type: 'RELAY_PORT_DETECTED', relayPort: port }).catch(() => {
        // background 可能未就绪，忽略（background 启动即用默认端口 52715）
      });
    }
  });

  // 注入主世界脚本读取页面 API
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      try {
        if (typeof window.getRelayPort === 'function') {
          var port = window.getRelayPort();
          if (port) {
            window.postMessage({ type: '${BRIDGE_EVENT}', relayPort: port }, '*');
          }
        }
      } catch (e) { /* 忽略 */ }
    })();
  `;
  try {
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch (e) {
    console.warn('[RelayPortSniffer] 注入失败:', e);
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  // 注入到所有子 frame（iframe 内选区此前完全收不到——覆盖缺口的大头）；
  // matchOriginAsFallback 覆盖 about:blank / about:srcdoc 继承父页来源的嵌入 frame
  // （评论框、编辑器 widget 常见形态）。既有职责（验证脚本注入、中转嗅探、
  // 消息应答）在下方用顶层 frame 判断保持原语义，子 frame 只承载选区监听。
  allFrames: true,
  matchOriginAsFallback: true,
  main() {
    // 子 frame（allFrames 注入）只做选区监听：验证脚本注入 / 中转嗅探 /
    // 验证标记落库等既有职责全部保持顶层 frame 语义，避免每个 iframe 重复
    // 注入主世界脚本、重复写 storage、在广播消息上抢先应答
    const isTopFrame = window.self === window.top;
    if (isTopFrame) {
      console.log('Content script loaded')

      // 注入网站验证脚本（所有站点）
      injectWebsiteValidator()

      // V2026.09.24 前台中转链路：trigger 页嗅探 relayPort 参数。
      // 桌面端打开诱导页（/trigger-connect?relayPort=52715）时，页面暴露
      // window.getRelayPort()；检测到后通知 background 以该端口连接桌面端
      // 本地 Server（而非直连后端）。页面 API 在主世界，content script
      // 隔离世界需经 injected script 转发——这里用 postMessage 桥接。
      injectRelayPortSniffer()

      // 监听验证成功消息并持久化标记
      chrome.runtime.onMessage.addListener((message) => {
        if (message && message.type === 'WEBSITE_VALIDATION_SUCCESS') {
          try {
            const ok = !!(message.detail && message.detail.ok);
            if (ok) {
              chrome.storage.local.set({ __websiteValidated: true, __websiteValidatedAt: Date.now(), __websiteValidatedUrl: message.url || location.href });
            }
          } catch (e) {
            console.warn('存储网站验证标记失败', e);
          }
        }
      });
    } // end isTopFrame：验证/嗅探职责到此为止

    // ── 文字选区 → 侧边栏「待引用」（**所有 frame**，含 iframe） ──
    // 覆盖面三处补强（此前只监听顶层 frame 的 getSelection，缺口很大）：
    //   1. iframe 内选区：随 allFrames 注入每帧独立监听；消息携带本帧
    //      url/title，侧边栏优先取 sender.tab 的顶层地址；
    //   2. 表单控件（input/textarea，含 open Shadow DOM 内的）：从深层
    //      activeElement 的 selectionStart/End 切片读值——getSelection 对
    //      表单内选区恒为空，在输入框、评论框里划词此前一律不同步；
    //   3. 读取实现收口在 utils/selection/read-selection（三段策略：表单切片
    //      → Selection.toString → Range 级克隆兜底，覆盖 Shadow DOM 跨根
    //      序列化返回空串的站点）；
    //   4. 事件四通道：selectionchange（拖选/键盘）+ select 捕获（不冒泡的
    //      表单选区）+ selectstart 捕获（选区起点，Shadow 边界外也可感知）
    //      + keyup（Shift/方向键划词的最后兜底）。通道只负责「触发读取」，
    //      读取结果按值去重——多通道重复触发零成本。
    // 拖选过程 selectionchange 高频触发：150ms 尾随防抖合并成一条消息；
    // mouseup 立即结算（松手即上屏的手感 + selectionchange 丢失时的清空兜底）。
    // console.debug 便于现场排查：页面控制台过滤 "PageQuote" 即可确认
    // 本帧是否真的发出过选区消息（云效/多维表格等站点排查的第一手信号）。

    let lastSelectedText = '';
    let selectionFlushTimer: ReturnType<typeof setTimeout> | null = null;

    /** 结算一次选区状态：值与上次一致则静默（多通道天然去重） */
    const flushSelection = (): void => {
      const text = readSelectedText();
      if (text === lastSelectedText) return;
      lastSelectedText = text;
      if (text.length > 0) {
        // 附带来源页面地址与标题：引用条与 <page_quote> 信封据此标注来源
        // （本 frame 的地址，侧边栏优先用 sender.tab 顶层地址）
        console.debug(`[PageQuote] 选区同步 → (${text.length}字)`, text.slice(0, 60));
        chrome.runtime.sendMessage({
          type: 'TEXT_SELECTED',
          text,
          url: location.href,
          title: document.title
        });
      } else {
        // 仅当此前有选区时才会走到这（上面的等值守卫挡掉了「本来就空」）
        console.debug('[PageQuote] 选区清空');
        chrome.runtime.sendMessage({
          type: 'TEXT_DESELECTED'
        });
      }
    };

    /** 尾随防抖：拖选高频变化只在最后一次变化后 150ms 结算一条 */
    const scheduleSelectionFlush = (): void => {
      if (selectionFlushTimer) clearTimeout(selectionFlushTimer);
      selectionFlushTimer = setTimeout(() => {
        selectionFlushTimer = null;
        flushSelection();
      }, 150);
    };

    document.addEventListener('selectionchange', scheduleSelectionFlush);
    // 表单控件的 select 不冒泡：必须在捕获期监听（selectionchange 对表单
    // 选区的支持随浏览器版本浮动，双通道互为兜底）
    document.addEventListener('select', scheduleSelectionFlush, true);
    // 选区起点：Shadow DOM 里开始的选区在宿主边界重定向，文档捕获期仍可感知
    document.addEventListener('selectstart', scheduleSelectionFlush, true);
    // 键盘划词（Shift+方向键 / 双击后 Shift+点击移动端点）的兜底触发
    document.addEventListener('keyup', scheduleSelectionFlush);
    document.addEventListener('mouseup', () => {
      if (selectionFlushTimer) {
        clearTimeout(selectionFlushTimer);
        selectionFlushTimer = null;
      }
      flushSelection();
    });
    
    // 监听来自sidepanel的消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // 子 frame 不应答：这些动作（截图 / 工作流 / 用户脚本）保持顶层 frame
      // 语义——allFrames 注入后每帧都注册了本监听，广播消息若由子 frame
      // 抢先应答会随机丢动作（Chrome「先应答者胜」）
      if (window.self !== window.top) return;
      if (message.type === 'START_SCREEN_CAPTURE') {
        startScreenCapture();
      } else if (message.type === 'WORKFLOW_ACTION') {
        // 处理工作流执行动作（异步响应）
        (async () => {
          try {
            const result = await handleWorkflowAction(message.action, message.params);
            sendResponse({ success: true, ...result });
          } catch (error) {
            sendResponse({ 
              success: false, 
              error: error instanceof Error ? error.message : String(error) 
            });
          }
        })();
        return true; // 保持消息通道开放
      } else if (message.type === 'EXECUTE_USERSCRIPT') {
        // 处理用户脚本执行（异步响应）
        (async () => {
          try {
            const result = await handleUserscriptExecution(message);
            sendResponse(result);
          } catch (error) {
            sendResponse({ 
              success: false, 
              error: error instanceof Error ? error.message : String(error) 
            });
          }
        })();
        return true; // 保持消息通道开放
      } else if (message.type === 'STOP_USERSCRIPT') {
        try {
          handleUserscriptStop(message.scriptId);
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ 
            success: false, 
            error: error instanceof Error ? error.message : t('content.stopScriptFailed') 
          });
        }
        return true;
      } else if (message.type === 'EXTRACT_PAGE_CONTENT') {
        // 处理页面内容提取请求
        (async () => {
          try {
            // 重置中止状态
            saveAborted = false;
            
            // 创建中止控制器
            saveAbortController = new AbortController();
            
            // 显示保存中提示
            showSaveToast('saving');
            
            const result = await extractPageContent();
            
            // 检查是否被中止（使用标志位，因为 controller 可能已被清空）
            if (isSaveAborted()) {
              console.log('[Content] 保存已被用户取消，不发送成功响应');
              sendResponse({ success: false, error: t('content.userCancelledSave') });
              return;
            }
            
            sendResponse({ success: true, data: result });
          } catch (error) {
            if (isSaveAborted()) {
              console.log('[Content] 保存已被用户取消');
              sendResponse({ success: false, error: t('content.userCancelledSave') });
            } else {
              sendResponse({ 
                success: false, 
                error: error instanceof Error ? error.message : t('content.extractFailed') 
              });
            }
          } finally {
            saveAbortController = null;
          }
        })();
        return true; // 保持消息通道开放
      } else if (message.type === 'SAVE_PAGE_STATUS') {
        // 处理保存状态更新
        if (message.status === 'success') {
          showSaveToast('success', message.message);
        } else if (message.status === 'error') {
          showSaveToast('error', message.message);
        } else if (message.status === 'hide') {
          hideSaveToast();
        }
        return false;
      }
    });

    // 提取页面内容的函数
    async function extractPageContent(): Promise<{
      title: string;
      textContent: string;
      images: Array<{ src: string; alt?: string; dataUrl?: string; width?: number; height?: number }>;
    }> {
      console.log('[Content] 开始提取页面内容');
      
      // 获取页面标题
      const title = document.title || t('content.untitledPage');
      
      // 收集文本内容中出现的图片
      const textImageUrls: Array<{ src: string; alt: string; width: number; height: number }> = [];
      
      // 获取纯文本内容（排除脚本、样式等），同时收集图片信息
      const textContent = extractTextContent(textImageUrls);
      
      // 只下载在文本内容中出现的图片
      const images = await extractImages(textImageUrls);
      
      console.log('[Content] 页面内容提取完成，图片数量:', images.length);
      
      return { title, textContent, images };
    }
    
    // 提取纯文本内容（转换为结构化 Markdown，见 utils/html-to-markdown.ts）
    function extractTextContent(imageCollector?: Array<{ src: string; alt: string; width: number; height: number }>): string {
      return htmlToMarkdown(document.body, { imageCollector });
    }
    
    // 提取并转换图片 - 只下载文本内容中出现的图片
    async function extractImages(imagesToDownload: Array<{ src: string; alt: string; width: number; height: number }>): Promise<Array<{
      src: string;
      alt?: string;
      dataUrl?: string;
      width?: number;
      height?: number;
    }>> {
      const images: Array<{
        src: string;
        alt?: string;
        dataUrl?: string;
        width?: number;
        height?: number;
      }> = [];
      
      // 限制最大图片数量
      const maxImages = 50;
      const imagesToProcess = imagesToDownload.slice(0, maxImages);
      
      console.log('[Content] 准备下载图片数量:', imagesToProcess.length);
      
      // 并发下载图片（每批5个，避免过载）
      const batchSize = 5;
      for (let i = 0; i < imagesToProcess.length; i += batchSize) {
        // 检查是否被中止
        if (isSaveAborted()) {
          console.log('[Content] 图片下载被用户中止');
          throw new Error(t('content.userCancelledSave'));
        }
        
        const batch = imagesToProcess.slice(i, i + batchSize);
        
        const results = await Promise.all(batch.map(async (imgInfo) => {
          let dataUrl: string | undefined;
          
          try {
            if (imgInfo.src.startsWith('data:')) {
              // 已经是 base64
              dataUrl = imgInfo.src;
            } else {
              // 通过 background script 下载图片，绕过 CORS
              const response = await chrome.runtime.sendMessage({
                type: 'DOWNLOAD_IMAGE',
                url: imgInfo.src
              });
              
              if (response && response.success) {
                dataUrl = response.dataUrl;
              } else {
                console.warn('[Content] 图片下载失败:', imgInfo.src, response?.error);
              }
            }
          } catch (error) {
            console.warn('[Content] 图片处理失败:', imgInfo.src, error);
          }
          
          return {
            src: imgInfo.src,
            alt: imgInfo.alt,
            dataUrl,
            width: imgInfo.width,
            height: imgInfo.height
          };
        }));
        
        images.push(...results);
      }
      
      return images;
    }
    
    // 处理工作流执行动作
    async function handleWorkflowAction(action: string, params: any): Promise<any> {
      switch (action) {
        case 'click':
          return await handleClickAction(params);
        case 'fill':
          return await handleFillAction(params);
        case 'screenshot':
          return await handleScreenshotAction(params);
        default:
          throw new Error(t('content.unsupportedAction', { action }));
      }
    }
    
    // 处理点击动作
    async function handleClickAction(params: any): Promise<any> {
      const { selector, xpath, text, position, doubleClick, rightClick } = params;
      
      let element: Element | null = null;
      
      if (selector) {
        element = document.querySelector(selector);
      } else if (xpath) {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        element = result.singleNodeValue as Element;
      } else if (text) {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null
        );
        let node;
        while ((node = walker.nextNode()) !== null) {
          if (node.textContent?.includes(text)) {
            element = (node as any).parentElement;
            break;
          }
        }
      }
      
      if (!element) {
        throw new Error(t('content.elementNotFound'));
      }
      
      // 检查元素是否可见
      const rect = (element as Element).getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        throw new Error(t('content.elementNotVisible'));
      }
      
      // 滚动到元素位置
      (element as Element).scrollIntoView({ behavior: 'smooth', block: 'center' });
      
      // 等待滚动完成
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 执行点击
      const clickEvent = new MouseEvent(doubleClick ? 'dblclick' : 'click', {
        bubbles: true,
        cancelable: true,
        button: rightClick ? 2 : 0
      });
      
      (element as Element).dispatchEvent(clickEvent);
      
      return { success: true, element: selector || xpath || text };
    }
    
    // 处理填写动作
    async function handleFillAction(params: any): Promise<any> {
      const { selector, xpath, value, clear, pressEnter } = params;
      
      let element: HTMLInputElement | HTMLTextAreaElement | null = null;
      
      if (selector) {
        element = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
      } else if (xpath) {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        element = result.singleNodeValue as HTMLInputElement | HTMLTextAreaElement;
      }
      
      if (!element) {
        throw new Error(t('content.inputNotFound'));
      }
      
      if (element.disabled || element.readOnly) {
        throw new Error(t('content.elementDisabled'));
      }
      
      // 聚焦元素
      element.focus();
      
      // 清空内容
      if (clear) {
        element.value = '';
      }
      
      // 输入内容
      element.value = value;
      
      // 触发输入事件
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      
      // 按回车
      if (pressEnter) {
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true
        });
        element.dispatchEvent(enterEvent);
      }
      
      return { success: true, value, element: selector || xpath };
    }
    
    // 处理截图动作
    async function handleScreenshotAction(params: any): Promise<any> {
      const { fullPage, element } = params;
      
      // 这里需要通过background script来处理截图
      // 因为content script无法直接访问chrome.tabs.captureVisibleTab API
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: 'CAPTURE_SCREENSHOT',
          fullPage,
          element
        }, (response) => {
          if (response && response.success) {
            resolve(response);
          } else {
            reject(new Error(response?.error || t('content.screenshotFailed')));
          }
        });
      });
    }
    
    // 存储运行中的脚本（以脚本原始ID为键，保存内部注入ID以便停止时映射）
    const runningScripts = new Map<string, { internalId: string, scriptElement?: HTMLScriptElement, cleanup?: () => void }>();

    // 处理用户脚本执行
    async function handleUserscriptExecution(message: any): Promise<any> {
      try {
        console.log('[Content Script] 开始执行用户脚本:', message.scriptInfo.metadata.name);
        
        const { scriptContent, scriptInfo, gmApis } = message;
        
        // 在页面中注入脚本
        const scriptElement = document.createElement('script');
        const internalId = `userscript_${scriptInfo.id}_${Date.now()}`;
        
        scriptElement.textContent = `
          (function() {
            try {
              // 设置GM API
              ${generateGMApiCode(gmApis)}
              
              // 执行用户脚本
              ${scriptContent}
              
              // 通知执行完成
              window.postMessage({
                type: 'USERSCRIPT_EXECUTION_RESULT',
                scriptId: '${internalId}',
                success: true,
                result: 'Script executed successfully'
              }, '*');
            } catch (error) {
              window.postMessage({
                type: 'USERSCRIPT_EXECUTION_RESULT',
                scriptId: '${internalId}',
                success: false,
                error: (error && error.message) ? error.message : String(error)
              }, '*');
            }
          })();
        `;
        
        // 监听执行结果
        return new Promise((resolve, reject) => {
          const messageHandler = (event: MessageEvent) => {
            if (event.data.type === 'USERSCRIPT_EXECUTION_RESULT' && 
                event.data.scriptId === internalId) {
              window.removeEventListener('message', messageHandler);
              
              // 清理脚本元素
              if (document.head.contains(scriptElement)) {
                document.head.removeChild(scriptElement);
              }
              
              // 从运行列表中移除
              runningScripts.delete(scriptInfo.id);
              
              if (event.data.success) {
                console.log('[Content Script] 用户脚本执行成功:', scriptInfo.metadata.name);
                resolve({ success: true, result: event.data.result });
              } else {
                console.error('[Content Script] 用户脚本执行失败:', event.data.error);
                resolve({ success: false, error: event.data.error });
              }
            }
          };
          
          const timeoutId = setTimeout(() => {
            window.removeEventListener('message', messageHandler);
            if (document.head.contains(scriptElement)) {
              document.head.removeChild(scriptElement);
            }
            runningScripts.delete(scriptInfo.id);
            resolve({ success: false, error: t('content.scriptTimeout') });
          }, 30000);
          
          // 记录运行中的脚本（用原始脚本ID作为键）
          runningScripts.set(scriptInfo.id, {
            internalId,
            scriptElement: scriptElement,
            cleanup: () => {
              clearTimeout(timeoutId);
              window.removeEventListener('message', messageHandler);
            }
          });
          
          window.addEventListener('message', messageHandler);
          document.head.appendChild(scriptElement);
        });
        
      } catch (error) {
        console.error('[Content Script] 处理用户脚本执行失败:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    
    // 处理用户脚本停止
    function handleUserscriptStop(scriptId: string): void {
      const scriptInfo = runningScripts.get(scriptId);
      if (scriptInfo) {
        // 执行清理函数
        if (scriptInfo.cleanup) {
          scriptInfo.cleanup();
        }
        
        // 清理脚本元素
        if (scriptInfo.scriptElement && document.head.contains(scriptInfo.scriptElement)) {
          document.head.removeChild(scriptInfo.scriptElement);
        }
        
        // 从运行列表中移除
        runningScripts.delete(scriptId);
        
        console.log(`[Content Script] 脚本已停止: ${scriptId}`);
      } else {
        console.warn(`[Content Script] 尝试停止不存在的脚本: ${scriptId}`);
      }
    }
    
    // 生成GM API代码
    function generateGMApiCode(gmApis: any): string {
      return `
        // GM API 实现
        const GM_info = ${JSON.stringify(gmApis)};
        
        // 存储相关API
        const GM_getValue = function(key, defaultValue) {
          try {
            const stored = localStorage.getItem('gm_' + key);
            return stored !== null ? JSON.parse(stored) : defaultValue;
          } catch (e) {
            return defaultValue;
          }
        };
        
        const GM_setValue = function(key, value) {
          try {
            localStorage.setItem('gm_' + key, JSON.stringify(value));
          } catch (e) {
            console.error('GM_setValue error:', e);
          }
        };
        
        const GM_deleteValue = function(key) {
          try {
            localStorage.removeItem('gm_' + key);
          } catch (e) {
            console.error('GM_deleteValue error:', e);
          }
        };
        
        const GM_listValues = function() {
          const keys = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('gm_')) {
              keys.push(key.substring(3));
            }
          }
          return keys;
        };
        
        // 网络请求API
        const GM_xmlhttpRequest = function(details) {
          const xhr = new XMLHttpRequest();
          xhr.open(details.method || 'GET', details.url, true);
          
          // 设置请求头
          if (details.headers) {
            Object.keys(details.headers).forEach(key => {
              try {
                xhr.setRequestHeader(key, details.headers[key]);
              } catch (e) {
                console.warn('Failed to set header:', key, e);
              }
            });
          }
          
          // 设置响应类型
          if (details.responseType) {
            xhr.responseType = details.responseType;
          }
          
          // 设置超时
          if (details.timeout) {
            xhr.timeout = details.timeout;
          }
          
          // 事件处理
          xhr.onload = function() {
            if (details.onload) {
              details.onload({
                status: xhr.status,
                statusText: xhr.statusText,
                responseText: xhr.responseText,
                responseHeaders: xhr.getAllResponseHeaders(),
                response: xhr.response,
                readyState: xhr.readyState,
                finalUrl: xhr.responseURL
              });
            }
          };
          
          xhr.onerror = function() {
            if (details.onerror) {
              details.onerror({
                status: xhr.status,
                statusText: xhr.statusText,
                responseText: xhr.responseText,
                error: 'Network error'
              });
            }
          };
          
          xhr.ontimeout = function() {
            if (details.ontimeout) {
              details.ontimeout({
                status: xhr.status,
                statusText: 'timeout',
                error: 'Request timeout'
              });
            }
          };
          
          xhr.onprogress = function(e) {
            if (details.onprogress) {
              details.onprogress(e);
            }
          };
          
          xhr.send(details.data || null);
          
          // 返回abort函数
          return {
            abort: function() {
              xhr.abort();
            }
          };
        };
        
        // 样式注入API
        const GM_addStyle = function(css) {
          const style = document.createElement('style');
          style.textContent = css;
          (document.head || document.documentElement).appendChild(style);
          return style;
        };
        
        // 通知API
        const GM_notification = function(details) {
          if (typeof details === 'string') {
            details = { text: details };
          }
          
          // 使用浏览器通知API
          if ('Notification' in window) {
            if (Notification.permission === 'granted') {
              const notification = new Notification(details.title || 'UserScript', {
                body: details.text,
                icon: details.image
              });
              
              if (details.onclick) {
                notification.onclick = details.onclick;
              }
              
              if (details.timeout) {
                setTimeout(() => notification.close(), details.timeout);
              }
              
              return notification;
            } else if (Notification.permission !== 'denied') {
              Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                  GM_notification(details);
                }
              });
            }
          }
          
          // 降级到console.log
          console.log('[GM_notification]', details.title || 'UserScript', details.text);
        };
        
        // 标签页操作API
        const GM_openInTab = function(url, options) {
          if (typeof options === 'boolean') {
            options = { active: !options };
          }
          options = options || {};
          
          const link = document.createElement('a');
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          
          if (!options.active) {
            link.style.display = 'none';
            document.body.appendChild(link);
          }
          
          link.click();
          
          if (!options.active && link.parentNode) {
            link.parentNode.removeChild(link);
          }
          
          return {
            close: function() {
              // 无法关闭外部标签页
              console.warn('GM_openInTab: Cannot close external tab');
            }
          };
        };
        
        // 剪贴板API
        const GM_setClipboard = function(data, info) {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(data).catch(e => {
              console.error('GM_setClipboard error:', e);
            });
          } else {
            // 降级方案
            const textArea = document.createElement('textarea');
            textArea.value = data;
            textArea.style.position = 'fixed';
            textArea.style.opacity = '0';
            document.body.appendChild(textArea);
            textArea.select();
            try {
              document.execCommand('copy');
            } catch (e) {
              console.error('GM_setClipboard fallback error:', e);
            }
            document.body.removeChild(textArea);
          }
        };
        
        // 资源获取API
        const GM_getResourceText = function(name) {
          // 简化实现，实际应该从扩展资源中获取
          console.warn('GM_getResourceText not fully implemented:', name);
          return '';
        };
        
        const GM_getResourceURL = function(name) {
          // 简化实现，实际应该从扩展资源中获取
          console.warn('GM_getResourceURL not fully implemented:', name);
          return '';
        };
        
        // 日志API
        const GM_log = console.log.bind(console);
        
        // 注册菜单命令API
        const GM_registerMenuCommand = function(name, fn, accessKey) {
          console.log('GM_registerMenuCommand:', name);
          // 简化实现，实际应该注册到扩展菜单
          return name;
        };
        
        const GM_unregisterMenuCommand = function(menuCmdId) {
          console.log('GM_unregisterMenuCommand:', menuCmdId);
        };
        
        // 下载API
        const GM_download = function(url, name, headers) {
          const link = document.createElement('a');
          link.href = url;
          if (name) {
            link.download = name;
          }
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        };
        
        // 将所有API绑定到window对象
        window.GM_info = GM_info;
        window.GM_getValue = GM_getValue;
        window.GM_setValue = GM_setValue;
        window.GM_deleteValue = GM_deleteValue;
        window.GM_listValues = GM_listValues;
        window.GM_xmlhttpRequest = GM_xmlhttpRequest;
        window.GM_addStyle = GM_addStyle;
        window.GM_notification = GM_notification;
        window.GM_openInTab = GM_openInTab;
        window.GM_setClipboard = GM_setClipboard;
        window.GM_getResourceText = GM_getResourceText;
        window.GM_getResourceURL = GM_getResourceURL;
        window.GM_log = GM_log;
        window.GM_registerMenuCommand = GM_registerMenuCommand;
        window.GM_unregisterMenuCommand = GM_unregisterMenuCommand;
        window.GM_download = GM_download;
        
        // Tampermonkey兼容性
        window.unsafeWindow = window;
        
        // Greasemonkey 4.0+ API兼容
        if (typeof GM === 'undefined') {
          window.GM = {
            info: GM_info,
            getValue: GM_getValue,
            setValue: GM_setValue,
            deleteValue: GM_deleteValue,
            listValues: GM_listValues,
            xmlHttpRequest: GM_xmlhttpRequest,
            addStyle: GM_addStyle,
            notification: GM_notification,
            openInTab: GM_openInTab,
            setClipboard: GM_setClipboard,
            getResourceText: GM_getResourceText,
            getResourceUrl: GM_getResourceURL,
            log: GM_log,
            registerMenuCommand: GM_registerMenuCommand,
            unregisterMenuCommand: GM_unregisterMenuCommand
          };
        }
      `;
    }
  },
});

// 区域截图功能
function startScreenCapture() {
  // 防止选中文本
  document.body.style.userSelect = 'none';
  
  // 创建截图选择覆盖层
  const overlay = document.createElement('div');
  overlay.id = 'screen-capture-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.3);
    cursor: crosshair;
    z-index: 999999;
    user-select: none;
    pointer-events: auto;
  `;
  
  // 创建选择区域的透明窗口
  const selectionWindow = document.createElement('div');
  selectionWindow.style.cssText = `
    position: fixed;
    background: transparent;
    border: 2px solid #007bff;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.3);
    pointer-events: none;
    z-index: 1000000;
    display: none;
  `;
  document.body.appendChild(selectionWindow);
  
  // 防止右键菜单弹出
  overlay.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  
  // 创建选择框
  const selectionBox = document.createElement('div');
  selectionBox.style.cssText = `
    position: absolute;
    border: 2px dashed #007bff;
    background: rgba(0, 123, 255, 0.1);
    display: none;
    pointer-events: none;
  `;
  overlay.appendChild(selectionBox);
  
  // 创建确认菜单
  const confirmMenu = document.createElement('div');
  confirmMenu.style.cssText = `
    position: absolute;
    background: white;
    border: 1px solid #ccc;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    padding: 8px;
    display: none;
    z-index: 1000000;
    user-select: none;
  `;
  
  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = t('common.confirm');
  confirmBtn.style.cssText = `
    background: #007AFF;
    color: white;
    border: none;
    padding: 6px 12px;
    margin-right: 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  `;
  
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = t('common.cancel');
  cancelBtn.style.cssText = `
    background: #f5f5f5;
    color: #333;
    border: 1px solid #ccc;
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  `;
  
  confirmMenu.appendChild(confirmBtn);
  confirmMenu.appendChild(cancelBtn);
  overlay.appendChild(confirmMenu);
  
  let isSelecting = false;
  let startX = 0;
  let startY = 0;
  let selectedArea: { x: number; y: number; width: number; height: number } | null = null;
  
  // 鼠标按下开始选择（只响应左键）
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === confirmBtn || e.target === cancelBtn) return;
    if (e.button !== 0) return; // 只响应左键点击
    
    e.preventDefault();
    e.stopPropagation();
    
    isSelecting = true;
    startX = e.clientX;
    startY = e.clientY;
    selectionBox.style.left = startX + 'px';
    selectionBox.style.top = startY + 'px';
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    selectionBox.style.display = 'block';
    confirmMenu.style.display = 'none';
  });
  
  // 鼠标移动更新选择框
  overlay.addEventListener('mousemove', (e) => {
    if (!isSelecting) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const currentX = e.clientX;
    const currentY = e.clientY;
    
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    
    selectionBox.style.left = left + 'px';
    selectionBox.style.top = top + 'px';
    selectionBox.style.width = width + 'px';
    selectionBox.style.height = height + 'px';
    
    // 更新透明窗口显示选择区域
    selectionWindow.style.left = left + 'px';
    selectionWindow.style.top = top + 'px';
    selectionWindow.style.width = width + 'px';
    selectionWindow.style.height = height + 'px';
    selectionWindow.style.display = 'block';
  });
  
  // 鼠标抬起完成选择（只响应左键）
  overlay.addEventListener('mouseup', (e) => {
    if (!isSelecting) return;
    if (e.target === confirmBtn || e.target === cancelBtn) return;
    if (e.button !== 0) return; // 只响应左键释放
    
    e.preventDefault();
    e.stopPropagation();
    
    isSelecting = false;
    const currentX = e.clientX;
    const currentY = e.clientY;
    
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    
    // 如果选择区域太小，提示用户重新选择
    if (width < 10 || height < 10) {
      selectionBox.style.display = 'none';
      // 不直接return，而是提示用户重新选择
      console.log('选择区域太小，请重新选择');
      return;
    }
    
    // 保存选择区域
    selectedArea = { x: left, y: top, width: width, height: height };
    
    // 显示确认菜单，位置在选择框上方
    const menuTop = Math.max(10, top - 50);
    const menuLeft = Math.min(window.innerWidth - 120, left);
    confirmMenu.style.top = menuTop + 'px';
    confirmMenu.style.left = menuLeft + 'px';
    confirmMenu.style.display = 'block';
  });
  
  // 确定按钮点击事件
  confirmBtn.addEventListener('click', () => {
    if (!selectedArea) return;
    // 取快照：下方嵌套回调里再读 selectedArea 会被 TS 判定为可能为 null
    const selectedAreaSnapshot = selectedArea;
    
    console.log('确定按钮被点击');
    
    // 使用chrome.tabs.captureVisibleTab API进行截图
    chrome.runtime.sendMessage({
      type: 'CAPTURE_VISIBLE_TAB',
      area: selectedArea
    }, (response) => {
      // 检查chrome.runtime.lastError
      if (chrome.runtime.lastError) {
        console.error('Runtime error:', chrome.runtime.lastError.message);
        // 清理UI
        document.body.style.userSelect = '';
        document.body.removeChild(overlay);
        if (selectionWindow && selectionWindow.parentNode) {
          selectionWindow.parentNode.removeChild(selectionWindow);
        }
        document.removeEventListener('keydown', handleKeyDown);
        chrome.runtime.sendMessage({
          type: 'SCREEN_CAPTURE_CANCELLED'
        });
        return;
      }
      
      if (response && response.success && response.dataUrl) {
        // 裁剪图片到选择区域
        cropImageToArea(response.dataUrl, selectedAreaSnapshot.x, selectedAreaSnapshot.y, selectedAreaSnapshot.width, selectedAreaSnapshot.height).then(croppedDataUrl => {
          // 清理UI
          document.body.style.userSelect = '';
          document.body.removeChild(overlay);
          if (selectionWindow && selectionWindow.parentNode) {
            selectionWindow.parentNode.removeChild(selectionWindow);
          }
          document.removeEventListener('keydown', handleKeyDown);
          
          // 发送裁剪后的截图数据到sidepanel
          chrome.runtime.sendMessage({
            type: 'SCREEN_CAPTURED',
            dataUrl: croppedDataUrl,
            area: selectedAreaSnapshot
          });
          
          console.log('截图成功，已发送到sidepanel');
        }).catch(error => {
          console.error('图片裁剪失败:', error);
          // 清理UI
          document.body.style.userSelect = '';
          document.body.removeChild(overlay);
          if (selectionWindow && selectionWindow.parentNode) {
            selectionWindow.parentNode.removeChild(selectionWindow);
          }
          document.removeEventListener('keydown', handleKeyDown);
          chrome.runtime.sendMessage({
            type: 'SCREEN_CAPTURE_CANCELLED'
          });
        });
      } else {
        console.error('截图API调用失败:', response);
        // 清理UI
        document.body.style.userSelect = '';
        document.body.removeChild(overlay);
        if (selectionWindow && selectionWindow.parentNode) {
          selectionWindow.parentNode.removeChild(selectionWindow);
        }
        document.removeEventListener('keydown', handleKeyDown);
        chrome.runtime.sendMessage({
          type: 'SCREEN_CAPTURE_CANCELLED'
        });
      }
    });
  });
  
  // 取消按钮点击事件
  cancelBtn.addEventListener('click', () => {
    // 恢复文本选择
    document.body.style.userSelect = '';
    document.body.removeChild(overlay);
    if (selectionWindow && selectionWindow.parentNode) {
      selectionWindow.parentNode.removeChild(selectionWindow);
    }
    document.removeEventListener('keydown', handleKeyDown);
    chrome.runtime.sendMessage({
      type: 'SCREEN_CAPTURE_CANCELLED'
    });
  });
  
  // ESC键取消截图
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // 恢复文本选择
      document.body.style.userSelect = '';
      document.body.removeChild(overlay);
      if (selectionWindow && selectionWindow.parentNode) {
        selectionWindow.parentNode.removeChild(selectionWindow);
      }
      document.removeEventListener('keydown', handleKeyDown);
      chrome.runtime.sendMessage({
        type: 'SCREEN_CAPTURE_CANCELLED'
      });
    }
  };
  
  document.addEventListener('keydown', handleKeyDown);
  document.body.appendChild(overlay);
}

// 图片裁剪函数
function cropImageToArea(dataUrl: string, x: number, y: number, width: number, height: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      if (!ctx) {
        reject(new Error(t('content.canvasContextFailed')));
        return;
      }
      
      // 设置canvas尺寸为裁剪区域大小
      canvas.width = width;
      canvas.height = height;
      
      // 计算设备像素比，确保高分辨率屏幕的截图正确裁剪
      const devicePixelRatio = window.devicePixelRatio || 1;
      
      // 裁剪图片到指定区域
      ctx.drawImage(
        img,
        x * devicePixelRatio, // 源图片x坐标
        y * devicePixelRatio, // 源图片y坐标
        width * devicePixelRatio, // 源图片宽度
        height * devicePixelRatio, // 源图片高度
        0, // 目标canvas x坐标
        0, // 目标canvas y坐标
        width, // 目标canvas宽度
        height // 目标canvas高度
      );
      
      // 转换为dataURL
      const croppedDataUrl = canvas.toDataURL('image/png', 0.9);
      resolve(croppedDataUrl);
    };
    
    img.onerror = () => {
      reject(new Error(t('content.imageLoadFailed')));
    };
    
    img.src = dataUrl;
  });
}

import { backgroundWebSocket } from './ws/websocket-background';
import { initToolsManagerListener } from './tools/tools-manager-listener';
import { downloadDB } from '@/utils/download-database';
import { initLocale, t } from '@/utils/i18n/core';
import { notesDB, broadcastNotesChanged } from '@/utils/notes-database';
import { webCaptureToNoteInput } from '@/utils/web-clip';
import { SCREEN_SHARE_MSG, OffscreenMsgType } from './screen-share/types';

// --- 文件拦截状态管理 ---
interface InterceptionState {
  isEnabled: boolean;
  extensionsToIntercept: string[];
}

const STORAGE_KEY = 'downloadInterceptionState';

// 获取当前拦截状态
async function getState(): Promise<InterceptionState> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || { isEnabled: false, extensionsToIntercept: [] };
}

// 保存拦截状态
async function setState(state: InterceptionState) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

// --- WebRequest 拦截逻辑 ---

/**
 * 注册 WebRequest 监听器
 */
async function registerInterceptor() {
  await removeInterceptor(); // 先移除旧的监听器确保唯一性

  const state = await getState();
  if (!state.isEnabled || state.extensionsToIntercept.length === 0) {
    console.log('Interceptor registration skipped: disabled or no extensions specified.');
    return;
  }

  console.log(`Registering interceptor for extensions: ${state.extensionsToIntercept.join(', ')}`);

  chrome.webRequest.onHeadersReceived.addListener(
    webRequestCallback,
    { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
    ["responseHeaders"]
  );
}

function removeInterceptor() {
  chrome.webRequest.onHeadersReceived.removeListener(webRequestCallback);
  console.log('Interceptor removed.');
}

/**
 * 核心拦截回调函数 - 并行下载策略
 */
function webRequestCallback(details: chrome.webRequest.WebResponseHeadersDetails): void {
  const contentDispositionHeader = details.responseHeaders?.find(
    header => header.name.toLowerCase() === 'content-disposition'
  );

  if (contentDispositionHeader?.value) {
    const filenameMatch = contentDispositionHeader.value.match(/filename\*?=['"]?([^'";]+)['"]?/);
    if (filenameMatch && filenameMatch[1]) {
      const filename = decodeURIComponent(filenameMatch[1]);
      
      // 并行执行副本抓取，不阻塞原始下载
      processDownloadAsync(details, filename);
      
      // 不返回cancel，让原始下载继续进行
    }
  }
}

/**
 * 异步处理下载：并行抓取副本并存库
 */
async function processDownloadAsync(details: chrome.webRequest.WebResponseHeadersDetails, filename: string) {
  try {
    const state = await getState();
    const extension = filename.split('.').pop()?.toLowerCase() || '';

    // 检查文件扩展名是否在拦截列表中
    if (!state.extensionsToIntercept.includes(extension)) {
      console.log(`Skipping capture for ${filename}: extension not in list.`);
      return; 
    }
    
    console.log(`Capturing file copy: ${filename} from ${details.url}`);

    // 并行抓取文件副本数据
    const response = await fetch(details.url);
    const blobData = await response.blob();
    const mimeType = blobData.type;

    // 存入 IndexedDB
    const fileId = await downloadDB.addFile({
      filename,
      sourcePageUrl: details.initiator || details.url,
      mimeType,
      capturedAt: Date.now(),
      blobData,
    });
    console.log(`File copy ${filename} saved to DB with ID: ${fileId}`);

  } catch (error) {
    console.error(`Error capturing file copy for ${filename}:`, error);
  }
}

/**
 * 强大的图片下载引擎 - 将图片 URL 转换为 base64
 * 支持跨域图片下载
 */
async function downloadImageToBase64(url: string): Promise<{
  success: boolean;
  dataUrl?: string;
  error?: string;
  width?: number;
  height?: number;
}> {
  // 跳过无效 URL
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) {
    if (url.startsWith('data:')) {
      return { success: true, dataUrl: url };
    }
    return { success: false, error: '无效的图片 URL' };
  }

  try {
    // 使用 fetch 下载图片（background script 有跨域权限）
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      headers: {
        'Accept': 'image/*,*/*;q=0.8',
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const blob = await response.blob();
    
    // 检查是否是有效的图片
    if (!blob.type.startsWith('image/') && blob.size < 100) {
      throw new Error('响应不是有效的图片');
    }

    // 将 blob 转换为 base64
    const dataUrl = await blobToBase64(blob);
    
    // 获取图片尺寸（可选，不影响主流程）
    let width: number | undefined;
    let height: number | undefined;
    
    try {
      const dimensions = await getImageDimensions(dataUrl);
      width = dimensions.width;
      height = dimensions.height;
    } catch {
      // 获取尺寸失败不影响主流程
    }

    return { success: true, dataUrl, width, height };

  } catch (error) {
    // 尝试备用方案：使用 XMLHttpRequest
    try {
      const dataUrl = await downloadImageWithXHR(url);
      return { success: true, dataUrl };
    } catch (xhrError) {
      console.warn(`[Background] 图片下载失败 ${url}:`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : '下载失败'
      };
    }
  }
}

/**
 * 使用 XMLHttpRequest 下载图片（备用方案）
 */
function downloadImageWithXHR(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';
    xhr.timeout = 30000; // 30秒超时

    xhr.onload = function() {
      if (xhr.status === 200) {
        const blob = xhr.response;
        const reader = new FileReader();
        reader.onloadend = () => {
          if (typeof reader.result === 'string') {
            resolve(reader.result);
          } else {
            reject(new Error('FileReader 返回非字符串结果'));
          }
        };
        reader.onerror = () => reject(new Error('FileReader 读取失败'));
        reader.readAsDataURL(blob);
      } else {
        reject(new Error(`XHR 请求失败: ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error('XHR 网络错误'));
    xhr.ontimeout = () => reject(new Error('XHR 请求超时'));
    xhr.send();
  });
}

/**
 * 将 Blob 转换为 base64 Data URL
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('FileReader 返回非字符串结果'));
      }
    };
    reader.onerror = () => reject(new Error('FileReader 读取失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 获取图片尺寸
 */
function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    // 在 Service Worker 中无法使用 Image，使用 createImageBitmap
    fetch(dataUrl)
      .then(res => res.blob())
      .then(blob => createImageBitmap(blob))
      .then(bitmap => {
        resolve({ width: bitmap.width, height: bitmap.height });
        bitmap.close();
      })
      .catch(reject);
  });
}

/**
 * 批量下载图片
 */
async function downloadImagesBatch(
  images: Array<{ src: string; alt?: string; width?: number; height?: number }>
): Promise<Array<{
  src: string;
  alt?: string;
  dataUrl?: string;
  width?: number;
  height?: number;
  error?: string;
}>> {
  const results: Array<{
    src: string;
    alt?: string;
    dataUrl?: string;
    width?: number;
    height?: number;
    error?: string;
  }> = [];

  // 并发限制，避免同时发起太多请求
  const concurrencyLimit = 5;
  const chunks: Array<typeof images> = [];
  
  for (let i = 0; i < images.length; i += concurrencyLimit) {
    chunks.push(images.slice(i, i + concurrencyLimit));
  }

  for (const chunk of chunks) {
    const chunkResults = await Promise.all(
      chunk.map(async (img) => {
        const downloadResult = await downloadImageToBase64(img.src);
        
        return {
          src: img.src,
          alt: img.alt,
          dataUrl: downloadResult.success ? downloadResult.dataUrl : undefined,
          width: downloadResult.width || img.width,
          height: downloadResult.height || img.height,
          error: downloadResult.error
        };
      })
    );
    
    results.push(...chunkResults);
  }

  return results;
}

/**
 * Background script entry point
 * Initializes all background services and listeners
 */
export default defineBackground(() => {
  // Initialize core services
  initToolsManagerListener();

  // --- 右键菜单：保存页面功能 ---
  const CONTEXT_MENU_ID = 'save-page-content';
  
  // 在扩展安装或更新时创建右键菜单（先恢复用户语言，保证菜单标题跟随语言）
  chrome.runtime.onInstalled.addListener(() => {
    void initLocale().finally(() => {
      chrome.contextMenus.create({
        id: CONTEXT_MENU_ID,
        title: t('background.contextMenuSavePage'),
        contexts: ['page', 'selection', 'image', 'link']
      }, () => {
        if (chrome.runtime.lastError) {
          console.log('Context menu already exists or error:', chrome.runtime.lastError.message);
        }
      });
    });
  });
  
  // 处理右键菜单点击
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) return;
    
    try {
      console.log('[Background] 开始保存页面:', tab.url);
      
      // 向 content script 请求页面内容
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'EXTRACT_PAGE_CONTENT'
      });
      
      if (response && response.success) {
        // 尝试下载 favicon 并转换为 base64
        let faviconDataUrl = '';
        if (tab.favIconUrl) {
          try {
            const faviconResult = await downloadImageToBase64(tab.favIconUrl);
            if (faviconResult.success && faviconResult.dataUrl) {
              faviconDataUrl = faviconResult.dataUrl;
            }
          } catch (e) {
            console.warn('[Background] Favicon 下载失败:', e);
          }
        }
        
        // 如果没有获取到 favicon，尝试从网站根目录获取
        if (!faviconDataUrl && tab.url) {
          try {
            const urlObj = new URL(tab.url);
            const rootFaviconUrl = `${urlObj.origin}/favicon.ico`;
            const faviconResult = await downloadImageToBase64(rootFaviconUrl);
            if (faviconResult.success && faviconResult.dataUrl) {
              faviconDataUrl = faviconResult.dataUrl;
            }
          } catch (e) {
            console.warn('[Background] 根目录 Favicon 下载失败:', e);
          }
        }
        
        // 采集内容 → 统一笔记（kind='webpage'，自动按站点派生分类）
        if (!tab.url) {
          throw new Error('无法获取当前页面网址，无法保存');
        }
        const noteInput = webCaptureToNoteInput({
          title: response.data.title || tab.title || '',
          url: tab.url,
          favicon: faviconDataUrl || tab.favIconUrl || '',
          markdown: response.data.textContent || '',
          images: response.data.images || [],
        });

        const note = await notesDB.createNote(noteInput);
        console.log('[Background] 网页已保存为笔记，ID:', note.id, '分类:', note.category);

        // 通知 content script 保存成功
        chrome.tabs.sendMessage(tab.id, {
          type: 'SAVE_PAGE_STATUS',
          status: 'success',
          message: '页面保存成功！'
        }).catch(() => {});

        // 通知笔记页等扩展上下文实时刷新
        broadcastNotesChanged('create', note.id);
      } else {
        throw new Error(response?.error || '提取页面内容失败');
      }
    } catch (error) {
      console.error('[Background] 保存页面失败:', error);
      
      // 通知 content script 保存失败
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'SAVE_PAGE_STATUS',
          status: 'error',
          message: error instanceof Error ? error.message : '保存失败'
        }).catch(() => {});
      }
    }
  });

  /**
   * 检查 URL 是否匹配 localhost:52725，如果匹配则尝试连接 WebSocket
   */
  const tryConnectIfLocalhost52725 = (url: string | undefined) => {
    if (!url) return;

    try {
      const urlObj = new URL(url);
      // 检查是否是 http://localhost:52725 或 http://localhost:52725/ 开头的 URL
      if (urlObj.protocol === 'http:' && urlObj.hostname === 'localhost' && urlObj.port === '52725') {
        console.log('[Background] 检测到 localhost:52725 页面，尝试连接 WebSocket');
        
        // 只在未连接且未正在连接时才尝试连接
        if (!backgroundWebSocket.isConnected() && !backgroundWebSocket.isConnecting()) {
          console.log('[Background] WebSocket 未连接且未正在连接，正在触发连接...');
          backgroundWebSocket.tryConnect().catch(error => {
            console.error('[Background] 自动连接失败:', error);
          });
        } else if (backgroundWebSocket.isConnected()) {
          console.log('[Background] WebSocket 已连接，无需重复连接');
        } else if (backgroundWebSocket.isConnecting()) {
          console.log('[Background] WebSocket 正在连接中，无需重复触发');
        }
      }
    } catch (error) {
      // URL 解析失败，忽略
      console.debug('[Background] URL 解析失败:', error);
    }
  };

  // 监听标签页更新（页面加载、导航等）
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
      tryConnectIfLocalhost52725(tab.url);
    }
  });

  // 监听标签页激活（用户切换到已存在的标签页）
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      tryConnectIfLocalhost52725(tab.url);
    } catch (error) {
      console.debug('[Background] 获取标签页信息失败:', error);
    }
  });

  // Handle extension icon click to open side panel
  chrome.action.onClicked.addListener(async (tab) => {
    try {
      if (tab.id) {
        await chrome.sidePanel.open({ tabId: tab.id });
      }
    } catch (error) {
      console.error('Failed to open side panel:', error);
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 处理页面脚本注入请求（用于绕过 CSP）
    if (message.type === 'INJECT_PAGE_SCRIPT') {
      (async () => {
        try {
          const file: string = message.file;
          if (!file || typeof file !== 'string' || !file.startsWith('inject-scripts/')) {
            sendResponse({ success: false, error: '非法脚本路径' });
            return;
          }

          const tabId = sender.tab?.id || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
          if (!tabId) {
            sendResponse({ success: false, error: '未找到目标标签页' });
            return;
          }

          await chrome.scripting.executeScript({
            target: { tabId },
            files: [file],
            world: 'MAIN'
          });

          sendResponse({ success: true });
        } catch (error) {
          console.error('注入页面脚本失败:', error);
          sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }

    // 处理工具调用请求
    if (message.type === 'CALL_TOOL') {
      (async () => {
        try {
          const { handleCallTool } = await import('./tools');
          const result = await handleCallTool(message.tool);
          sendResponse(result);
        } catch (error) {
          console.error('工具调用失败:', error);
          // ToolResult 形态完整应答（success + isError + content）：
          // 缺 success 会让按 success 判定成败的消费方读到 undefined
          sendResponse({
            success: false,
            isError: true,
            content: [{
              type: 'text',
              text: `工具调用失败: ${error instanceof Error ? error.message : String(error)}`
            }]
          });
        }
      })();
      return true; // 异步响应
    }
    
    // 处理 WebSocket 连接控制请求
    if (message.type === 'WEBSOCKET_CONNECT') {
      backgroundWebSocket.tryConnect();
      sendResponse({ success: true });
      return true;
    }

    // V2026.09.24 前台中转：trigger 页嗅探到 relayPort（桌面端诱导页携带），
    // 通知 WS 客户端以该端口连接桌面端本地 Server
    if (message.type === 'RELAY_PORT_DETECTED') {
      const port = Number(message.relayPort);
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        backgroundWebSocket.applyRelayPort(port);
      }
      sendResponse({ success: true });
      return true;
    }
    
    if (message.type === 'WEBSOCKET_DISCONNECT') {
      backgroundWebSocket.disconnect();
      sendResponse({ success: true });
      return true;
    }
    
    if (message.type === 'WEBSOCKET_GET_STATUS') {
      sendResponse({ 
        status: backgroundWebSocket.getStatus()
      });
      return true;
    }

    // 屏幕共享控制命令（SidePanel → Background）
    if (message.type === SCREEN_SHARE_MSG.START) {
      (async () => {
        try {
          const result = await backgroundWebSocket.getScreenShareHandler().startBroadcast();
          sendResponse(result);
        } catch (e) {
          sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return true;
    }

    if (message.type === SCREEN_SHARE_MSG.STOP) {
      (async () => {
        await backgroundWebSocket.getScreenShareHandler().stopBroadcast();
        sendResponse({ success: true });
      })();
      return true;
    }

    if (message.type === SCREEN_SHARE_MSG.GET_STATUS) {
      sendResponse({ success: true, status: backgroundWebSocket.getScreenShareHandler().getStatus() });
      return true;
    }

    // 屏幕共享 offscreen document → Background 信令转发
    // offscreen 无法直接访问专属类实例，需经由 background 转发给 ScreenShareSignalHandler
    if (
      message.type === OffscreenMsgType.SEND_OFFER ||
      message.type === OffscreenMsgType.ICE_TO_VIEWER ||
      message.type === OffscreenMsgType.STREAM_ENDED ||
      message.type === OffscreenMsgType.ERROR_REPORT
    ) {
      backgroundWebSocket.getScreenShareHandler().handleOffscreenMessage(message);
      return true;
    }
    if (message.type === 'DOWNLOAD_IMAGE') {
      (async () => {
        try {
          const result = await downloadImageToBase64(message.url);
          sendResponse(result);
        } catch (error) {
          sendResponse({ 
            success: false, 
            error: error instanceof Error ? error.message : '下载失败' 
          });
        }
      })();
      return true; // 保持消息通道开放
    }
    
    // 批量下载图片
    if (message.type === 'DOWNLOAD_IMAGES_BATCH') {
      (async () => {
        try {
          const results = await downloadImagesBatch(message.images);
          sendResponse({ success: true, results });
        } catch (error) {
          sendResponse({ 
            success: false, 
            error: error instanceof Error ? error.message : '批量下载失败' 
          });
        }
      })();
      return true;
    }
    
    if (message.type === 'CHECK_MIC_PERMISSION') {
      // Since microphone is declared in manifest, we assume it's granted
      // The actual permission check will happen when getUserMedia is called
      sendResponse({ hasPermission: true });
      return true; // Keep the message channel open for async response (harmless here)
    }
    
    // Handle screenshot capture requests from content script
    if (message.type === 'CAPTURE_SCREENSHOT') {
      (async () => {
        try {
          const { fullPage, element } = message;
          
          if (!sender.tab?.id) {
            sendResponse({ success: false, error: '无法获取标签页ID' });
            return;
          }
          
          // 捕获可见区域的截图
          const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, {
            format: 'png',
            quality: 90
          });
          
          sendResponse({ 
            success: true, 
            dataUrl,
            timestamp: Date.now()
          });
        } catch (error) {
          console.error('Screenshot capture failed:', error);
          sendResponse({ 
            success: false, 
            error: error instanceof Error ? error.message : '截图失败'
          });
        }
      })();
      return true; // Keep the message channel open for async response
    }
    
    // Handle area screenshot capture requests from content script
    if (message.type === 'CAPTURE_VISIBLE_TAB') {
      (async () => {
        try {
          if (!sender.tab?.id) {
            sendResponse({ success: false, error: '无法获取标签页ID' });
            return;
          }
          
          // 捕获可见区域的截图
          const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, {
            format: 'png',
            quality: 90
          });
          
          // 如果有区域信息，需要在前端进行裁剪
          // 这里只返回完整截图，裁剪将在content script中处理
          sendResponse({ 
            success: true, 
            dataUrl,
            area: message.area
          });
        } catch (error) {
          console.error('Area screenshot capture failed:', error);
          sendResponse({ 
            success: false, 
            error: error instanceof Error ? error.message : '区域截图失败'
          });
        }
      })();
      return true; // Keep the message channel open for async response
    }

    // 自动化：网站验证成功后，打开侧边栏以触发连接逻辑
    if (message.type === 'WEBSITE_VALIDATION_SUCCESS') {
      try {
        const ok = !!(message.detail && message.detail.ok);
        const url = message.url || sender.tab?.url || '';
        if (ok) {
          // 双保险：后台也写入验证标记，避免竞态
          chrome.storage.local.set({ __websiteValidated: true, __websiteValidatedAt: Date.now(), __websiteValidatedUrl: url }).catch(() => {});
        }
        if (ok && sender.tab?.id) {
          // 打开当前标签页的侧边栏，使其挂载并读取存储标记后自动连接
          chrome.sidePanel.open({ tabId: sender.tab.id }).catch(err => {
            console.warn('Failed to open side panel on validation success:', err);
          });
        }
      } catch (error) {
        console.warn('处理 WEBSITE_VALIDATION_SUCCESS 时发生异常:', error);
      }
      // 不需要保持消息通道
    }

    // Handle workflow recording messages from content script
    if (message.type === 'RECORDING_PAUSE' || 
        message.type === 'RECORDING_INSERT_AI' || 
        message.type === 'RECORDING_RESET' || 
        message.type === 'RECORDING_FINISH' ||
        message.type === 'RECORDING_STEP_ADDED') {
      // Forward the message to the sidepanel
      chrome.runtime.sendMessage(message).catch(error => {
        console.error('Failed to forward recording message to sidepanel:', error);
      });
      return true;
    }

    // Handle file interception commands
    switch (message.command) {
      case 'startInterception':
        setState({ isEnabled: true, extensionsToIntercept: message.payload.interceptExtensions })
          .then(registerInterceptor)
          .then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // 表示异步响应

      case 'stopInterception':
        (async () => {
          try {
            const currentState = await getState();
            await setState({ isEnabled: false, extensionsToIntercept: currentState.extensionsToIntercept || [] });
            removeInterceptor();
            sendResponse({ success: true });
          } catch (error) {
            sendResponse({ 
              success: false, 
              error: error instanceof Error ? error.message : String(error)
            });
          }
        })();
        return true;

      case 'getCapturedFileList':
        downloadDB.getFileList()
          .then(fileList => sendResponse({ success: true, fileList }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case 'clearAllCapturedFiles':
        downloadDB.clearAllFiles()
          .then(clearedCount => sendResponse({ success: true, clearedCount }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case 'getFileDetailsById':
        downloadDB.getFileById(message.payload.id)
          .then(fileDetails => sendResponse({ success: true, fileDetails }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }
  });

  // 启动时初始化拦截器
  chrome.runtime.onStartup.addListener(() => {
    console.log('Browser started. Re-registering interceptor if enabled.');
    registerInterceptor();
  });

  // 扩展启动时也需要初始化
  registerInterceptor().catch(error => {
    console.error('Failed to initialize interceptor on startup:', error);
  });
});

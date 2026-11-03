/**
 * useWebSocket - WebSocket 连接管理 composable
 * 
 * 负责 WebSocket 连接状态管理、自动连接触发、消息监听等
 */
import { ref, onMounted, onUnmounted } from 'vue';
import { ConnectionStatus } from '@/entrypoints/background/ws/websocket-types';

export function useWebSocket() {
  // WebSocket连接状态
  const wsConnectionStatus = ref<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  
  // 连接警告弹窗状态
  const showConnectionWarning = ref(false);
  
  // 断开确认弹窗状态
  const showDisconnectConfirm = ref(false);

  // 监听存储变化的回调引用
  let storageChangeListener: ((changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void) | null = null;

  // 消息监听器引用（用于 onUnmounted 移除）
  let messageListener: ((message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => void) | null = null;

  /**
   * 切换 WebSocket 连接状态
   * 已连接则弹出断开确认，未连接则发起连接
   */
  const toggleWebSocketConnection = async () => {
    if (wsConnectionStatus.value === ConnectionStatus.CONNECTED) {
      // 断开连接 - 显示确认弹窗
      showDisconnectConfirm.value = true;
      return;
    }

    // 避免重复连接
    if (wsConnectionStatus.value === ConnectionStatus.CONNECTING) return;

    // 连接 - 发送消息给 background
    chrome.runtime.sendMessage({ type: 'WEBSOCKET_CONNECT' });
  };

  /**
   * 确认断开 WebSocket 连接
   */
  const confirmDisconnect = () => {
    chrome.runtime.sendMessage({ type: 'WEBSOCKET_DISCONNECT' });
    showDisconnectConfirm.value = false;
  };

  /**
   * 获取连接按钮标题文本
   */
  const getConnectionButtonTitle = () => {
    switch (wsConnectionStatus.value) {
      case ConnectionStatus.CONNECTED:
        return '已连接 - 点击断开';
      case ConnectionStatus.CONNECTING:
        return '连接中...';
      case ConnectionStatus.DISCONNECTED:
        return '未连接 - 点击连接';
      default:
        return '连接状态未知';
    }
  };

  /**
   * 初始化 WebSocket 相关监听器
   * 应在 onMounted 中调用
   */
  const initWebSocketListeners = () => {
    // 1. 监听存储变化：当 __websiteValidated 变为 true 时，触发自动连接
    storageChangeListener = (changes, areaName) => {
      try {
        if (areaName === 'local' && changes.__websiteValidated && changes.__websiteValidated.newValue) {
          if (wsConnectionStatus.value !== ConnectionStatus.CONNECTED && wsConnectionStatus.value !== ConnectionStatus.CONNECTING) {
            toggleWebSocketConnection().catch(err => console.warn('存储触发自动连接失败:', err));
          }
          // 清理标记，避免重复触发
          chrome.storage.local.remove(['__websiteValidated']).catch(() => {});
        }
      } catch (err) {
        console.warn('处理存储变化失败:', err);
      }
    };
    chrome.storage.onChanged.addListener(storageChangeListener);

    // 2. 监听来自 background 的 WebSocket 状态变化
    messageListener = (message, sender, sendResponse) => {
      if (message.type === 'WEBSOCKET_STATUS_CHANGED') {
        wsConnectionStatus.value = message.status;
        console.log('[useWebSocket] WebSocket状态变化:', message.status);
      }
      
      // 监听网站验证成功消息，触发自动连接
      if (message.type === 'WEBSITE_VALIDATION_SUCCESS') {
        (async () => {
          try {
            if (wsConnectionStatus.value !== ConnectionStatus.CONNECTED) {
              await toggleWebSocketConnection();
            }
          } catch (e) {
            console.error('自动连接失败:', e);
          }
        })();
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    // 3. 查询当前 WebSocket 连接状态
    chrome.runtime.sendMessage({ type: 'WEBSOCKET_GET_STATUS' }, (response) => {
      if (response && response.status) {
        wsConnectionStatus.value = response.status;
        console.log('[useWebSocket] 初始WebSocket状态:', response.status);
      }
    });
  };

  /**
   * 检查网站验证存储标记，若已验证则尝试自动连接
   * 应在 onMounted 中调用
   */
  const checkWebsiteValidationAndConnect = async () => {
    try {
      const store = await chrome.storage.local.get(['__websiteValidated', '__websiteValidatedAt']);
      if (store.__websiteValidated) {
        // 标记存在，仅在未连接时发起连接
        if (wsConnectionStatus.value !== ConnectionStatus.CONNECTED && wsConnectionStatus.value !== ConnectionStatus.CONNECTING) {
          await toggleWebSocketConnection();
        }
        // 清理一次标记，避免重复连接
        chrome.storage.local.remove(['__websiteValidated']);
      }
    } catch (e) {
      console.warn('检查网站验证标记失败', e);
    }
  };

  /**
   * 清理所有 WebSocket 相关监听器
   * 应在 onUnmounted 中调用
   */
  const cleanupWebSocketListeners = () => {
    if (storageChangeListener) {
      try {
        chrome.storage.onChanged.removeListener(storageChangeListener);
      } catch (error) {
        // 清理阶段不应因单个监听器移除失败而中断，仅记录便于排查
        console.warn('移除 storage 变更监听器失败', error);
      }
      storageChangeListener = null;
    }
    if (messageListener) {
      try {
        chrome.runtime.onMessage.removeListener(messageListener);
      } catch (error) {
        // 清理阶段不应因单个监听器移除失败而中断，仅记录便于排查
        console.warn('移除 runtime 消息监听器失败', error);
      }
      messageListener = null;
    }
  };

  return {
    // 状态
    wsConnectionStatus,
    showConnectionWarning,
    showDisconnectConfirm,
    
    // 方法
    toggleWebSocketConnection,
    confirmDisconnect,
    getConnectionButtonTitle,
    initWebSocketListeners,
    checkWebsiteValidationAndConnect,
    cleanupWebSocketListeners,
  };
}

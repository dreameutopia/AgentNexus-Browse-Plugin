/**
 * Offscreen Document 生命周期管理器
 *
 * 负责：
 * 1. 创建 / 关闭 offscreen document（Chrome 116+ chrome.offscreen API）
 * 2. 向 offscreen document 发送命令消息
 *
 * 注意：offscreen document 只能通过 chrome.runtime.sendMessage 与
 *       background service worker 通信，不能直接与 sidepanel 通信。
 */

/** WXT 构建后 HTML 入口名称（entrypoints/screen-share-offscreen/index.html → screen-share-offscreen.html） */
const OFFSCREEN_HTML = 'screen-share-offscreen.html';

export class OffscreenBridge {
  private documentExists = false;

  /**
   * 确保 offscreen document 已创建，若已存在则跳过。
   * Chrome 同一时刻只允许一个 offscreen document。
   */
  async ensureDocument(): Promise<void> {
    // Chrome 116+ 提供 hasDocument()
    if (typeof chrome.offscreen?.hasDocument === 'function') {
      this.documentExists = await chrome.offscreen.hasDocument();
    }

    if (this.documentExists) {
      console.log('[OffscreenBridge] Offscreen document 已存在，跳过创建');
      return;
    }

    console.log('[OffscreenBridge] 正在创建 offscreen document...');
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_HTML),
      reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA],
      justification: 'Capture screen media for WebRTC LAN broadcasting',
    });

    this.documentExists = true;
    console.log('[OffscreenBridge] Offscreen document 创建完成');
  }

  /**
   * 关闭 offscreen document，释放媒体捕获资源。
   */
  async closeDocument(): Promise<void> {
    if (!this.documentExists) return;

    try {
      await chrome.offscreen.closeDocument();
      console.log('[OffscreenBridge] Offscreen document 已关闭');
    } catch (e) {
      console.warn('[OffscreenBridge] 关闭 offscreen document 时出错（可能已关闭）:', e);
    } finally {
      this.documentExists = false;
    }
  }

  /**
   * 向 offscreen document 发送消息，返回响应（如有）。
   * 若 offscreen 尚未创建或已关闭，会静默忽略错误。
   */
  async sendToOffscreen(message: Record<string, unknown>): Promise<any> {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      // offscreen document 可能还未就绪或已关闭
      console.warn('[OffscreenBridge] 发送消息到 offscreen 失败:', e);
      return undefined;
    }
  }

  /**
   * 当前 offscreen document 是否存在（已创建且未关闭）。
   */
  get isDocumentOpen(): boolean {
    return this.documentExists;
  }
}

/** 单例 */
export const offscreenBridge = new OffscreenBridge();

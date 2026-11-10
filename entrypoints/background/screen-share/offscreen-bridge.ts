import { ensureOffscreenHost } from '@/utils/offscreen-host';

/** 屏幕共享的离屏入口。STOP 释放媒体资源，宿主可继续服务其他工具。 */
export class OffscreenBridge {
  async ensureDocument(): Promise<void> {
    await ensureOffscreenHost();
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
}

/** 单例 */
export const offscreenBridge = new OffscreenBridge();

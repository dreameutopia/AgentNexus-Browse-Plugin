/**
 * 扩展侧剪贴板客户端（工具层入口）。
 *
 * 协议形状见 tools/browser/clipboard-protocol.ts；写入的离屏实现见
 * entrypoints/screen-share-offscreen/clipboard-host.ts。
 *
 * ==================== 为什么需要这一层 ====================
 *
 * 页面上下文的异步剪贴板 API 会挂在**浏览器级权限气泡**上（气泡在浏览器 UI 层，
 * 页面 DOM 工具观察不到 → 模型只看到脚本超时）。扩展侧通道没有这个问题：
 * manifest 的 clipboardWrite 权限让扩展页写入无需用户手势、也不触发气泡。
 *
 * ==================== 执行上下文的三条通路 ====================
 *
 * 浏览器工具运行在 **background（service worker）**——那里没有 DOM、没有焦点，
 * `navigator.clipboard` 在 Chrome 157 前不可用。因此按可用性依次降级：
 *
 *   1. **offscreen 文档**（首选）：有 DOM，固定用 execCommand('copy') 写入。
 *      读取在离屏文档不可靠（无焦点）→ 不在此通路读。
 *   2. **扩展页面上下文**（sidepanel）：持有用户焦点，可靠执行
 *      `navigator.clipboard.writeText/readText`。当离屏通路不可用时兜底。
 *   3. **失败**：给出可定位错误，绝不谎报成功。
 *
 * 读取另有一条更可靠的通路：让**页面**自己读（页面有焦点时
 * `navigator.clipboard.readText()` 可用且能拿到真实剪贴板），但同样受页面
 * 权限气泡影响——因此默认走扩展侧，只有用户显式要求读页面可见剪贴板时才考虑。
 */

import {
  CLIPBOARD_MSG,
  CLIPBOARD_MAX_CHARS,
  type ClipboardResponse,
} from './clipboard-protocol';
import { ensureOffscreenHost } from '@/utils/offscreen-host';
import { browserChrome } from './browser-scope';
import type { ToolExecutionContext } from '../registry';

/** 离屏宿主未就绪时的等待上限（毫秒）。
 *
 * 离屏文档是懒创建的：首次调用剪贴板时需要创建 + 加载宿主页面，
 * 这一步在冷启动下可能耗时（扩展包越大越慢）。超出即失败并给出可定位原因，
 * 而不是无限等待。 */
const OFFSCREEN_READY_TIMEOUT_MS = 15_000;

/** 单次消息往返上限（毫秒）——离屏文档崩溃/被回收时不至于永久挂起。 */
const CLIPBOARD_MESSAGE_TIMEOUT_MS = 10_000;

/** 超时助手：把 promise 竞速到超时拒绝。 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 经 offscreen 文档写入系统剪贴板。
 *
 * @throws 携带可定位原因的 Error（不吞异常：调用方需要区分失败原因）
 */
export async function writeClipboardViaOffscreen(
  text: string,
  context?: ToolExecutionContext,
): Promise<void> {
  await withTimeout(
    ensureOffscreenHost(),
    OFFSCREEN_READY_TIMEOUT_MS,
    'OFFSCREEN_UNAVAILABLE：离屏宿主在超时时间内未能就绪，无法写入剪贴板。',
  );
  let response: ClipboardResponse | undefined;
  try {
    response = await withTimeout(
      browserChrome(context).runtime.sendMessage({
        type: CLIPBOARD_MSG.WRITE,
        text,
      }),
      CLIPBOARD_MESSAGE_TIMEOUT_MS,
      'CLIPBOARD_TIMEOUT：离屏宿主未在超时时间内应答剪贴板写入请求。',
    );
  } catch (error) {
    // sendMessage 在没有接收方时会以 "Could not establish connection" 拒绝：
    // 这说明离屏文档尚未就绪（被回收或尚未创建）→ 重试一次创建流程。
    const message = error instanceof Error ? error.message : String(error);
    if (/receiving end does not exist|could not establish connection/i.test(message)) {
      await ensureOffscreenHost();
      response = await withTimeout(
        browserChrome(context).runtime.sendMessage({
          type: CLIPBOARD_MSG.WRITE,
          text,
        }),
        CLIPBOARD_MESSAGE_TIMEOUT_MS,
        'CLIPBOARD_TIMEOUT：离屏宿主重连后仍未应答剪贴板写入请求。',
      );
    } else {
      throw new Error(`CLIPBOARD_HOST_ERROR：剪贴板写入请求失败：${message}`);
    }
  }
  if (!response) {
    throw new Error('CLIPBOARD_NO_RESPONSE：离屏宿主未返回剪贴板写入结果。');
  }
  if (!response.ok) {
    throw new Error(response.error || 'CLIPBOARD_WRITE_FAILED：剪贴板写入失败。');
  }
}

/**
 * 在当前扩展页面上下文执行剪贴板操作（需要页面持有焦点）。
 *
 * sidepanel 是运行在扩展进程里的真实文档（不是 service worker），
 * 有 DOM 与焦点，`navigator.clipboard` 在其中可用。
 *
 * 该函数只能在**扩展页面上下文**调用；在 service worker 中调用会因缺少
 * `document` 立即失败——调用方负责选对上下文。
 */
export async function clipboardInExtensionPage(
  operation: 'write' | 'read',
  text?: string,
): Promise<ClipboardResponse> {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') {
    return {
      ok: false,
      error:
        'EXTENSION_PAGE_REQUIRED：当前上下文没有 DOM，无法使用扩展页面剪贴板通路。',
    };
  }
  if (operation === 'write') {
    if (typeof text !== 'string') {
      return { ok: false, error: 'INVALID_REQUEST：写入内容必须是字符串' };
    }
    if (text.length > CLIPBOARD_MAX_CHARS) {
      return {
        ok: false,
        error:
          `CONTENT_TOO_LARGE：剪贴板内容 ${text.length} 字符超过上限 ${CLIPBOARD_MAX_CHARS}。`,
      };
    }
    try {
      if (!navigator.clipboard?.writeText) {
        return { ok: false, error: 'CLIPBOARD_API_UNAVAILABLE：当前环境没有异步剪贴板 API。' };
      }
      await navigator.clipboard.writeText(text);
      return { ok: true, copied: true };
    } catch (error) {
      return {
        ok: false,
        error:
          'CLIPBOARD_WRITE_FAILED：扩展页面写入剪贴板失败：' +
          (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  try {
    if (!navigator.clipboard?.readText) {
      return { ok: false, error: 'CLIPBOARD_API_UNAVAILABLE：当前环境没有异步剪贴板读取 API。' };
    }
    const value = await navigator.clipboard.readText();
    return { ok: true, text: value };
  } catch (error) {
    return {
      ok: false,
      error:
        'CLIPBOARD_READ_FAILED：扩展页面读取剪贴板失败：' +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

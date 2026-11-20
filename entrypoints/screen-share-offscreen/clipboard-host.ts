/**
 * 扩展侧剪贴板离屏执行体（协议见 tools/browser/clipboard-protocol.ts）
 *
 * 回答 browser_input 的 clipboard_write / clipboard_read 在 service worker 里
 * 无法直接完成的问题：MV3 service worker 无 DOM，Chrome 157 之前也无法使用
 * `navigator.clipboard`；本模块运行在扩展的 offscreen document 中，由它代为
 * 触碰系统剪贴板。
 *
 * ==================== 通道选择与防御点 ====================
 *
 * 1. **写入固定走 execCommand('copy')**：offscreen 文档处于隐藏状态、无焦点，
 *    异步 Clipboard API 在其中不可靠（Chrome 要求文档聚焦）。隐藏 textarea +
 *    select() + execCommand('copy') 配合 manifest 的 `clipboardWrite` 权限，
 *    在扩展页上下文中无需用户手势即可写入，且不触发页面 origin 的权限气泡。
 * 2. **textarea 必须留在文档中**：execCommand 读取当前选区，节点一旦移除，
 *    选区随之失效 → 复制会静默失败。finally 中清理，且清理发生在 copy 之后。
 * 3. **选区必须可见且可聚焦**：隐藏到视口外（left:-9999px）而非
 *    `display:none`/`hidden` —— 后两者会让元素不可选中，复制静默失败。
 * 4. **失败绝不谎报成功**：execCommand 返回 false 时按失败上报，并把当时的
 *    焦点状态、权限线索写进 error，供上层定位（权限被拒 vs 无焦点）。
 * 5. **读取不放在本模块**：offscreen 文档无焦点时 `readText()` 不可靠，
 *    读取由持有焦点的扩展页面上下文承担（见 browser_input 的读路径）。
 */

import {
  CLIPBOARD_MSG,
  CLIPBOARD_MAX_CHARS,
  type ClipboardReadRequest,
  type ClipboardResponse,
  type ClipboardWriteRequest,
} from '@/tools/browser/clipboard-protocol';

/**
 * 通过隐藏 textarea + execCommand('copy') 写入系统剪贴板。
 *
 * @returns execCommand 的返回值（true 表示复制动作被接受）
 */
function copyViaExecCommand(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  // 移出视口而非 display:none —— 不可见的元素无法被 select() 选中。
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    // 部分内核要求选区覆盖整个值
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}

/** 处理一条剪贴板消息，返回统一应答。 */
export async function handleClipboardMessage(
  message: ClipboardWriteRequest | ClipboardReadRequest,
): Promise<ClipboardResponse> {
  if (message.type === CLIPBOARD_MSG.WRITE) {
    const text = message.text;
    if (typeof text !== 'string') {
      return { ok: false, error: 'INVALID_REQUEST：写入内容必须是字符串' };
    }
    if (text.length > CLIPBOARD_MAX_CHARS) {
      return {
        ok: false,
        error:
          `CONTENT_TOO_LARGE：剪贴板内容 ${text.length} 字符超过上限 ${CLIPBOARD_MAX_CHARS}。` +
          '大数据请用文件交付（outputs/*.csv）而不是剪贴板。',
      };
    }
    try {
      const copied = copyViaExecCommand(text);
      if (!copied) {
        return {
          ok: false,
          copied: false,
          error:
            'COPY_REJECTED：浏览器拒绝了复制动作（扩展剪贴板权限不可用或文档无焦点）。' +
            '请确认扩展已授予剪贴板权限且未在其它窗口将其禁用。',
        };
      }
      return { ok: true, copied: true };
    } catch (error) {
      return {
        ok: false,
        error:
          'COPY_FAILED：写入剪贴板时抛出异常：' +
          (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  // offscreen 文档无焦点，异步读取不可靠；此处明确拒绝而不是返回空串
  // （返回空串会被上层误判为「剪贴板确实是空的」）。
  return {
    ok: false,
    error:
      'READ_UNSUPPORTED：离屏文档无焦点，无法可靠读取剪贴板。' +
      '请在具备焦点的扩展页面上下文中读取。',
  };
}

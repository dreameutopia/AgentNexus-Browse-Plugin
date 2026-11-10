/**
 * 本轮模型用户消息的正文拼装（纯函数，无 IO）
 *
 * 唯一实现：正文 = 用户输入 → 网页引用信封 → 附件信封。
 *
 * 口径说明：
 *   - 用户输入是用户亲手敲的正文，永远在最前；
 *   - 网页引用信封（<page_quote>）与附件信封（<upload_file>）都是「模型面
 *     附加材料」，不进用户可见转录，只拼在本轮用户消息里；
 *   - 无引用信封时保持与既有实现逐字一致（`${userInput}\n\n${attachmentPrompt}`），
 *     系统前缀逐轮稳定，上下文缓存不因拼装方式变化而失效。
 *
 * 单一事实源：会话引擎（composeLlmUserMessage）与发送前上下文计量共用此函数，
 * 两侧逐字同源——计量口径与真实请求口径分叉会让预算判断失真。
 */

/** 拼装本轮用户消息正文（不含系统时间戳、不含多模态图片段） */
export function composeUserMessageBody(
  userInput: string,
  pageQuotePrompt = '',
  attachmentPrompt = '',
): string {
  if (pageQuotePrompt) {
    return [userInput, pageQuotePrompt, attachmentPrompt]
      .filter(part => part !== '')
      .join('\n\n');
  }
  return attachmentPrompt ? `${userInput}\n\n${attachmentPrompt}` : userInput;
}

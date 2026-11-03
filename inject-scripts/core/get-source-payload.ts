/**
 * 这是将被注入到每个 frame 中的“荷载”函数。
 * 它在目标 frame 的上下文中执行。
 * @returns 当前 frame 的完整 outerHTML。
 */
export function getSourcePayload(): string {
  // document.documentElement.outerHTML 获取从 <html> 标签开始的所有内容
  return document.documentElement.outerHTML;
}
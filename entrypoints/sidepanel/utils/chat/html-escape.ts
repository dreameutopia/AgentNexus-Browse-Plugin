/**
 * 纯文本 HTML 转义（不依赖 DOM，可在任意上下文使用）。
 *
 * chat 渲染链路的唯一转义实现：markdown-renderer / diagram-renderer /
 * file-card 共用同一份，避免多份拷贝漂移造成的安全差异
 * （任一拷贝漏转义某个字符类即成为注入入口）。
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

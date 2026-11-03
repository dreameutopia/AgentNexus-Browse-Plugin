/**
 * 测试标的汇总导出：
 * - htmlToMarkdown：抓取端 HTML → Markdown 转换器（utils/html-to-markdown.ts）
 * - captureMarkdownToHtml：剪藏端 Markdown → Tiptap HTML 渲染器
 *   （utils/web-clip.ts，随 saved-pages 合并入统一笔记迁移而来；
 *   渲染语义与既有回归测试对齐：代码围栏零污染、图片占位符还原等）
 */
export {
  htmlToMarkdown,
  escapeMarkdownText,
  unescapeMarkdownText,
  // 围栏感知的反转义（测试内以 unescapeForCopy 名义使用）
  unescapeMarkdownText as unescapeForCopy,
} from '../../utils/html-to-markdown';

export { captureMarkdownToHtml } from '../../utils/web-clip';

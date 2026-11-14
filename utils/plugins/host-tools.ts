/**
 * 显式公开的宿主工具 API。
 *
 * 只有这里列出的工具可以作为插件 host-alias 目标、智能体 builtin 引用或
 * Skill allowed-tools。内部控件/终端等工具永远不是插件目标——该集合必须在
 * 验包、启动对账与运行时三层同时生效，不能只依赖某一条链路。
 */
export const PUBLIC_HOST_TOOLS: ReadonlySet<string> = new Set([
  'browser_get_page_text',
  'browser_get_page_info',
  'browser_tabs',
  'browser_navigation',
  'browser_history_bookmarks',
]);

/** 判断 `builtin/<name>` 是否命中公开宿主工具白名单 */
export function isPublicHostTool(ref: string): boolean {
  return (
    typeof ref === 'string' &&
    ref.startsWith('builtin/') &&
    PUBLIC_HOST_TOOLS.has(ref.slice('builtin/'.length))
  );
}

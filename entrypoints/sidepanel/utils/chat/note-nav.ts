/**
 * 笔记详情导航（sidepanel 侧）
 *
 * 消息底部笔记卡片的点击动作：打开（或聚焦已有的）内置笔记页并通过
 * hash 深链定位到指定笔记（notes.html#note=<id>，页面监听 hashchange
 * 自动加载）。
 *
 * 标签页匹配规则沿用旧 create_note 工具的口径：仅当标签页 URL 精确等于
 * 扩展内 notes.html（允许携带 hash）时才视为「已打开的笔记页」——
 * 子串匹配会误命中 URL 恰好包含 notes.html 的普通网站。
 * 所有浏览器 API 异常就地消化并返回可读结果：卡片点击是导航性质的操作，
 * 失败只需提示，不应产生未处理的 Promise 拒绝。
 */

/** 打开（或聚焦）内置笔记页并定位到指定笔记；返回是否成功 */
export async function openNoteDetail(noteId: string): Promise<boolean> {
  if (!noteId) return false;
  try {
    const pageUrl = chrome.runtime.getURL('notes.html');
    const hash = `#note=${encodeURIComponent(noteId)}`;

    const tabs = await chrome.tabs.query({});
    const existingTab = tabs.find(
      tab => tab.url === pageUrl || tab.url?.startsWith(`${pageUrl}#`),
    );

    if (existingTab?.id !== undefined) {
      // 已有笔记页：聚焦并切换到该笔记（页面监听 hashchange 自动加载）
      await chrome.tabs.update(existingTab.id, { url: `${pageUrl}${hash}`, active: true });
      return true;
    }

    const newTab = await chrome.tabs.create({ url: `${pageUrl}${hash}`, active: true });
    return newTab?.id !== undefined;
  } catch (error) {
    console.warn('[NoteNav] 打开笔记详情失败:', error);
    return false;
  }
}

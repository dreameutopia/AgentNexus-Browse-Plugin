/** Always bind tab creation to an existing normal window. Calling tabs.create
 * without windowId can itself create a window when no browser window exists. */
export async function existingNavigationWindowId(): Promise<number> {
  const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  if (!Number.isSafeInteger(window?.id) || window.id! < 0 || (window.type !== undefined && window.type !== 'normal'))
    throw new Error('没有可用的现有浏览器窗口；请先打开浏览器窗口。本工具不会创建新窗口。');
  return window.id!;
}

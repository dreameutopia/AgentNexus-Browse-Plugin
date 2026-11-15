/**
 * 插件页面能力边界。
 *
 * 插件 manifest 的 `capabilities.network` 是页面读取、导航、请求的唯一
 * origin 白名单。只有调用上下文带有 `pluginKey`（插件工具或插件智能体）时
 * 才启用；普通内置智能体行为保持不变。
 */
import type { ToolExecutionContext } from '../registry';

export interface TabOrigin {
  tabId: number;
  url: string;
  /** 非 https 页面为 null；插件上下文下随后会被 assertPluginOrigin 拒绝 */
  origin: string | null;
}

export function pluginOriginOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function assertPluginOrigin(
  origin: string | null,
  context?: ToolExecutionContext,
): void {
  if (!context?.pluginKey) return;
  if (!origin)
    throw new Error(
      `PLUGIN_ORIGIN_DENIED: 插件 ${context.pluginKey} 只能访问 https 页面`,
    );
  const allowed = context.pluginOrigins ?? [];
  if (!allowed.includes(origin))
    throw new Error(
      `PLUGIN_ORIGIN_DENIED: ${origin} 不在插件 ${context.pluginKey} 的 network 声明中`,
    );
}

/** 解析目标标签页并校验其 origin；无插件上下文时仍返回标签页信息 */
export async function resolveTabOrigin(
  tabId: number | undefined,
  context?: ToolExecutionContext,
): Promise<TabOrigin> {
  let tab: chrome.tabs.Tab | undefined;
  if (tabId === undefined) {
    try {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      tab = tabs[0];
    } catch (error) {
      throw new Error(
        `TAB_NOT_FOUND: 无法查询活动标签页（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  } else {
    if (!Number.isSafeInteger(tabId) || tabId < 0)
      throw new Error(`INVALID_TAB_ID: ${String(tabId)}`);
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      throw new Error(
        `TAB_NOT_FOUND: ${tabId}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  }
  const url = tab?.url;
  if (typeof tab?.id !== 'number' || !url)
    throw new Error(
      tabId === undefined
        ? 'TAB_NOT_FOUND: 没有可用的活动标签页'
        : `TAB_NOT_FOUND: ${tabId} 没有可读取的 URL`,
    );
  const origin = pluginOriginOf(url);
  assertPluginOrigin(origin, context);
  return { tabId: tab.id, url, origin };
}

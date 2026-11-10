/**
 * Deep Search 站点注册表
 *
 * 单一事实来源：Deep Search 可检索站点的身份（id / 展示名 / platform 枚举值）
 * 与动态授权工具。UI 的站点开关列表与发送时的工具注入均由此派生，杜绝两处
 * 手工维护产生漂移。
 *
 * 检索工具按语义分两个（2026-11-10 由单一 web_search 拆分）：
 *   - web_search     —— 通用网页检索（engine 枚举 bing / baidu），恒定注入；
 *   - platform_search —— 站点平台检索（platform 枚举），任一站点启用即注入。
 * 「已开启站点」清单写入 supplementary-context，约束模型在 platform_search 的
 * platform 枚举中只选已开启站点对应的值（提示级约束，工具面不按站点拆分）。
 *
 * 新增站点步骤：
 *   1. 站点须先在 tools/search/search-targets.ts 注册为站点平台（platform
 *      必须是该注册表的合法枚举值——UI 键与枚举值不必同名，如知网 UI 键为
 *      zhiwang、枚举值为 cnki，模型经展示名对应到枚举值）；
 *   2. 在 DEEP_SEARCH_SITES 登记（id 唯一且保持稳定）；
 *   3. 在 use-deep-search-sites.ts 的 WEBSITE_UI_META 补充图标与 i18n 文案键。
 */

import { isSearchPlatformId } from '@/tools/search/search-targets';

/** Deep Search 恒定注入的通用检索工具（bing / baidu） */
export const DEEP_SEARCH_BASE_TOOL_IDS: readonly string[] = ['web_search'];

/** Deep Search 站点检索工具（任一站点启用即注入） */
export const DEEP_SEARCH_SITE_TOOL_IDS: readonly string[] = ['platform_search'];

/** 站点注册项 */
export interface DeepSearchSite {
  /** 站点唯一 ID（与 UI 开关关联的持久键，保持稳定） */
  id: string;
  /** 展示名（写入工作笔记与提示词，供模型识别平台） */
  label: string;
  /** platform_search 的 platform 枚举值（search-targets.ts 的合法站点平台 id） */
  platform: string;
}

/** 全部可检索站点（顺序即 UI 展示顺序） */
export const DEEP_SEARCH_SITES: readonly DeepSearchSite[] = [
  { id: 'csdn', label: 'CSDN', platform: 'csdn' },
  { id: 'mooc', label: 'MOOC', platform: 'mooc' },
  { id: 'zhihu', label: '知乎', platform: 'zhihu' },
  { id: 'xiaohongshu', label: '小红书', platform: 'xiaohongshu' },
  { id: 'zhiwang', label: '中国知网', platform: 'cnki' },
  { id: 'github', label: 'GitHub', platform: 'github' },
];

/** 按 id 查找已注册站点 */
export function getDeepSearchSite(id: string): DeepSearchSite | undefined {
  return DEEP_SEARCH_SITES.find(site => site.id === id);
}

/**
 * 按「已启用站点 id 列表」解析动态工具 ID：通用检索 web_search 恒定注入，
 * 站点检索 platform_search 在有合法已开启站点时注入（站点选择由 platform
 * 枚举 + 提示词中的已开启清单约束）。
 * 防御：未知 id、枚举值非法的站点一律记警并跳过（不中断发送），避免脏数据
 * 拖垮整个会话装配。
 */
export function resolveDeepSearchToolIds(enabledSiteIds: readonly string[]): string[] {
  const validIds = enabledSiteIds.filter(id => {
    const site = getDeepSearchSite(id);
    if (!site) {
      console.warn(`[DeepSearchSites] 未注册的站点 id: "${id}"，已跳过`);
      return false;
    }
    if (!isSearchPlatformId(site.platform)) {
      console.warn(
        `[DeepSearchSites] 站点 "${id}" 的 platform 枚举值非法: "${site.platform}"，已跳过`,
      );
      return false;
    }
    return true;
  });
  const toolIds = [...DEEP_SEARCH_BASE_TOOL_IDS];
  if (validIds.length > 0) toolIds.push(...DEEP_SEARCH_SITE_TOOL_IDS);
  return toolIds;
}

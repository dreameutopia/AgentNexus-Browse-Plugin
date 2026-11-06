/**
 * Deep Search 站点注册表
 *
 * 单一事实来源：Deep Search 可检索站点的身份（id / 展示名）与动态授权工具。
 * UI 的站点开关列表与发送时的工具注入均由此派生，杜绝两处手工维护产生漂移。
 *
 * 检索工具已统一为 web_search（website 枚举区分平台）：任一站点启用即注入
 * 该工具；「已开启站点」清单写入 supplementary-context 约束模型只在其中
 * 选择 website 枚举值（提示级约束，工具面不再按站点拆分）。
 *
 * 新增站点步骤：
 *   1. 站点须先在 tools/search/search-platforms.ts 注册为 web_search 平台
 *     （本表 id 是 UI 开关的持久键，不必与平台 id 同名——如知网为 zhiwang /
 *      cnki，模型经展示名对应到 website 枚举值）；
 *   2. 在 DEEP_SEARCH_SITES 登记（id 唯一且保持稳定）；
 *   3. 在 App.vue 的 WEBSITE_UI_META 补充图标与 i18n 文案键。
 */

/** Deep Search 动态授权的统一检索工具（website 枚举区分平台） */
export const DEEP_SEARCH_TOOL_IDS: readonly string[] = ['web_search'];

/** 站点注册项 */
export interface DeepSearchSite {
  /** 站点唯一 ID（与 UI 开关关联的持久键，保持稳定；模型经展示名对应 website 枚举） */
  id: string;
  /** 展示名（写入工作笔记与提示词，供模型识别平台） */
  label: string;
}

/** 全部可检索站点（顺序即 UI 展示顺序） */
export const DEEP_SEARCH_SITES: readonly DeepSearchSite[] = [
  { id: 'csdn', label: 'CSDN' },
  { id: 'mooc', label: 'MOOC' },
  { id: 'zhihu', label: '知乎' },
  { id: 'xiaohongshu', label: '小红书' },
  { id: 'zhiwang', label: '中国知网' },
  { id: 'github', label: 'GitHub' },
];

/** 按 id 查找已注册站点 */
export function getDeepSearchSite(id: string): DeepSearchSite | undefined {
  return DEEP_SEARCH_SITES.find(site => site.id === id);
}

/**
 * 按「已启用站点 id 列表」解析动态工具 ID：任一站点启用即注入统一
 * web_search（站点选择由 website 枚举 + 提示词中的已开启清单约束）。
 * 防御：未知 id 记警并跳过（不中断发送），避免脏数据拖垮整个会话装配。
 */
export function resolveDeepSearchToolIds(enabledSiteIds: readonly string[]): string[] {
  const validIds = enabledSiteIds.filter(id => {
    if (getDeepSearchSite(id)) return true;
    console.warn(`[DeepSearchSites] 未注册的站点 id: "${id}"，已跳过`);
    return false;
  });
  return validIds.length > 0 ? [...DEEP_SEARCH_TOOL_IDS] : [];
}

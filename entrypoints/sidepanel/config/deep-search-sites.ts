/**
 * Deep Search 站点注册表
 *
 * 单一事实来源：Deep Search 可检索站点的身份（id / 展示名）与
 * 「站点 → 动态授权工具」的映射。UI 的站点开关列表与发送时的工具注入
 * 均由此派生，杜绝两处手工维护产生漂移（如漏配 scraper、残留死映射）。
 *
 * 新增站点步骤：
 *   1. 在 DEEP_SEARCH_SITES 注册（id 唯一、工具名须与 toolRegistry 注册名一致）；
 *   2. 在 App.vue 的 WEBSITE_UI_META 补充图标与 i18n 文案键。
 */

/** 站点注册项 */
export interface DeepSearchSite {
  /** 站点唯一 ID（与 UI 开关关联，保持稳定） */
  id: string;
  /** 展示名（写入工作笔记与提示词，供模型识别平台） */
  label: string;
  /** 该站点启用后动态授权的工具 ID（解析时统一去重） */
  toolIds: readonly string[];
}

/** 全部可检索站点（顺序即 UI 展示顺序） */
export const DEEP_SEARCH_SITES: readonly DeepSearchSite[] = [
  {
    id: 'csdn',
    label: 'CSDN',
    toolIds: ['csdn_search', 'csdn_result_scraper'],
  },
  {
    id: 'mooc',
    label: 'MOOC',
    toolIds: ['mooc_search', 'mooc_result_scraper'],
  },
  {
    id: 'zhihu',
    label: '知乎',
    toolIds: ['zhihu_search', 'zhihu_result_scraper'],
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    toolIds: ['xiaohongshu_search', 'xiaohongshu_result_scraper'],
  },
  {
    id: 'zhiwang',
    label: '中国知网',
    toolIds: ['cnki_search', 'cnki_result_scraper'],
  },
  {
    id: 'github',
    label: 'GitHub',
    toolIds: ['github_search', 'github_result_scraper'],
  },
];

/** 按 id 查找已注册站点 */
export function getDeepSearchSite(id: string): DeepSearchSite | undefined {
  return DEEP_SEARCH_SITES.find(site => site.id === id);
}

/**
 * 按「已启用站点 id 列表」解析去重后的动态工具 ID。
 * 防御：未知 id 记警并跳过（不中断发送），避免脏数据拖垮整个会话装配。
 */
export function resolveDeepSearchToolIds(enabledSiteIds: readonly string[]): string[] {
  const toolIds = new Set<string>();
  for (const id of enabledSiteIds) {
    const site = getDeepSearchSite(id);
    if (!site) {
      console.warn(`[DeepSearchSites] 未注册的站点 id: "${id}"，已跳过其工具注入`);
      continue;
    }
    for (const toolId of site.toolIds) toolIds.add(toolId);
  }
  return [...toolIds];
}

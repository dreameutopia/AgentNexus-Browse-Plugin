/**
 * Deep Search 站点开关共享状态（模块级单例）
 *
 * 职责：
 *   - 持有「已登录网站」的启用状态，供两处消费：
 *       1. App.vue 发送装配（deep-search 智能体按启用站点注入工具）；
 *       2. 设置弹窗的「已登录网站」分区（开关 UI）。
 *   - 站点列表由 config/deep-search-sites 注册表派生（展示顺序 = 注册顺序），
 *     UI 元数据（图标与 i18n 文案键）从 App.vue 迁入，杜绝两处维护漂移。
 *   - 启用状态持久化到 chrome.storage.local（key: deepSearchSiteFlags，
 *     值为 { [siteId]: boolean }）：设置分区的开关跨会话生效；
 *     读取失败静默保持「全关」默认，写入失败不回滚（会话内仍生效）。
 */

import { computed, ref } from 'vue';
import type { MessageKey } from '@/utils/i18n';
import { DEEP_SEARCH_SITES } from '../config/deep-search-sites';

// ==================== 常量与类型 ====================

/** 启用状态的存储键（chrome.storage.local） */
const STORAGE_KEY = 'deepSearchSiteFlags';

/** 站点列表项（UI 视图模型：注册表数据 + 图标 + i18n 文案键 + 启用态） */
export interface WebsiteItem {
  id: string;
  name: string;
  /** platform_search 的 platform 枚举值（提示词与模型侧只认这个值，非 UI 键） */
  platform: string;
  labelKey: MessageKey;
  icon: string;
  enabled: boolean;
}

/**
 * 站点 UI 元数据（视图层关注点：图标与 i18n 文案键），
 * 按 id 与 config/deep-search-sites 注册表关联；新增站点时须同步补全。
 */
const WEBSITE_UI_META: Record<string, { labelKey: MessageKey; icon: string }> = {
  csdn: { labelKey: 'sidepanel.app.websiteCSDN', icon: chrome.runtime.getURL('web-icon/csdn.png') },
  mooc: { labelKey: 'sidepanel.app.websiteMOOC', icon: chrome.runtime.getURL('web-icon/mooc.png') },
  zhihu: { labelKey: 'sidepanel.app.websiteZhihu', icon: chrome.runtime.getURL('web-icon/zhihu.png') },
  xiaohongshu: { labelKey: 'sidepanel.app.websiteXiaohongshu', icon: chrome.runtime.getURL('web-icon/xiaohongshu.png') },
  zhiwang: { labelKey: 'sidepanel.app.websiteZhiwang', icon: chrome.runtime.getURL('web-icon/zhiwang.png') },
  github: { labelKey: 'sidepanel.app.websiteGithub', icon: chrome.runtime.getURL('web-icon/github.png') },
};

// ==================== 模块级单例状态 ====================

// 站点开关列表由注册表派生（展示顺序 = 注册顺序），杜绝 UI 与工具映射两处维护漂移
const websites = ref<WebsiteItem[]>(
  DEEP_SEARCH_SITES.map(site => {
    const meta = WEBSITE_UI_META[site.id];
    if (!meta) {
      // 注册表新增站点但 UI 元数据未补全：开发期立即暴露，运行时降级为占位渲染
      console.warn(`[DeepSearchSites] 站点 "${site.id}" 缺少 WEBSITE_UI_META 元数据，已用占位渲染`);
    }
    return {
      id: site.id,
      name: site.label,
      platform: site.platform,
      labelKey: (meta?.labelKey ?? '') as MessageKey,
      icon: meta?.icon ?? '',
      enabled: false,
    };
  }),
);

/** 已启用站点（发送装配深搜工具时的唯一读取口径） */
const enabledWebsites = computed<WebsiteItem[]>(() => websites.value.filter(site => site.enabled));

// ==================== 持久化 ====================

/** 水合标记：模块生命周期内只读一次存储（读取在模块加载即触发，发送装配前必已完成） */
let hydrated = false;

/** chrome.storage → 内存：恢复各站点持久化的启用态；存储故障静默保持全关默认 */
const hydrate = async (): Promise<void> => {
  if (hydrated) return;
  hydrated = true;
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const flags = (result?.[STORAGE_KEY] ?? {}) as Record<string, unknown>;
    for (const site of websites.value) {
      // 局部变量承接以获得 typeof 收窄（Record 索引访问不随变量键收窄）
      const stored = flags[site.id];
      if (typeof stored === 'boolean') site.enabled = stored;
    }
  } catch {
    // 存储读取失败：保持默认全关，不阻塞任何调用方
  }
};
void hydrate();

/**
 * 设置站点启用态：更新内存（立即对发送装配生效）并整体写回存储。
 * 写入失败不回滚——会话内仍生效，下次启动回落到上次成功写入的状态。
 */
const setWebsiteEnabled = (id: string, enabled: boolean): void => {
  const site = websites.value.find(item => item.id === id);
  if (!site || site.enabled === enabled) return;
  site.enabled = enabled;
  const flags: Record<string, boolean> = {};
  for (const item of websites.value) flags[item.id] = item.enabled;
  void chrome.storage.local.set({ [STORAGE_KEY]: flags }).catch(() => {
    // 写入失败静默：见函数注释的取舍
  });
};

// ==================== 导出 ====================

/** Deep Search 站点开关共享状态入口（两个消费方拿到同一份单例） */
export function useDeepSearchSites() {
  return { websites, enabledWebsites, setWebsiteEnabled };
}

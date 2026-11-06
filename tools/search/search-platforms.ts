/**
 * 统一搜索平台注册表（web_search 的单一事实源）
 *
 * 登记项 = 搜索入口（URL 模板）+ 结果解析器。解析器复用自原平台专属
 * result_scraper 工具的实现，分两类通道：
 *   - inline：chrome.scripting.executeScript({func}) 直接注入自包含解析函数
 *     （百度 / Bing）。函数体内**禁止引用任何外部作用域**——序列化后在页面
 *     上下文求值，闭包变量会直接丢失。
 *   - script：注入静态内容脚本（inject-scripts/scraper/*.js，wxt 静态资源）
 *     后经 chrome.tabs.sendMessage 以 action 触发，回包契约统一为
 *     { status: 'success', data } | { status: 'error', message }。
 *     （知乎 / GitHub / CSDN / MOOC / 小红书 / 知网 / Bilibili）
 *
 * 新增平台步骤：
 *   1. SearchPlatformId 增加 id；
 *   2. SEARCH_PLATFORMS 登记配置（URL 模板 + 解析通道 + 文案）；
 *   3. script 通道需在 inject-scripts/scraper/ 落解析脚本并在此登记 file/action；
 *   4. web-search-tool 的 openaiSchema website 枚举与工具描述同步（Schema
 *      枚举由本模块导出的 SEARCH_PLATFORM_IDS 派生的常量维护，见 web-search-tool）。
 */

/** 平台 id（website 参数的合法枚举值，小写） */
export type SearchPlatformId =
  | 'baidu'
  | 'bing'
  | 'zhihu'
  | 'github'
  | 'csdn'
  | 'mooc'
  | 'xiaohongshu'
  | 'cnki'
  | 'bilibili';

/** inline 通道的自包含解析函数（在页面上下文求值，返回结果条目数组） */
export type InlineResultExtractor = () => unknown[];

/** 结果解析通道配置 */
export interface SearchResultExtractor {
  /** 解析通道形态 */
  kind: 'inline' | 'script';
  /** inline：自包含解析函数（不得引用外部作用域） */
  func?: InlineResultExtractor;
  /** script：静态内容脚本路径（相对扩展根） */
  file?: string;
  /** script：触发解析的消息 action（内容脚本 onMessage 匹配值） */
  action?: string;
  /** script：注入后等待内容脚本完成监听注册的延迟（毫秒） */
  initDelayMs?: number;
}

/** 平台配置项 */
export interface SearchPlatformConfig {
  /** 平台 id（website 枚举值） */
  id: SearchPlatformId;
  /** 中文展示名（结果文案与错误提示用） */
  label: string;
  /** 引擎标识（回传模型，与原 searchEngine 字段口径一致） */
  engine: string;
  /** 结果条目量词（如「条结果」「个仓库」） */
  itemNoun: string;
  /** 构造搜索结果页 URL（query 已 encodeURIComponent） */
  buildSearchUrl: (encodedQuery: string) => string;
  /** 结果解析通道 */
  extractor: SearchResultExtractor;
}

export const SEARCH_PLATFORMS: Readonly<Record<SearchPlatformId, SearchPlatformConfig>> = {
  baidu: {
    id: 'baidu',
    label: '百度',
    engine: 'Baidu',
    itemNoun: '条结果',
    buildSearchUrl: q => `https://www.baidu.com/s?wd=${q}`,
    extractor: {
      kind: 'inline',
      // 逻辑逐行移植自原 baidu_result_scraper（tools/analyse，已下线）
      func: () => {
        const results: Array<{ title: string; link: string; description: string; source?: string; time?: string }> = [];
        const resultItems = document.querySelectorAll('#content_left .result, #content_left .c-container');
        resultItems.forEach(item => {
          try {
            const titleEl = item.querySelector('h3 a, .t a');
            const title = titleEl?.textContent?.trim() || '';
            const link = (titleEl as HTMLAnchorElement)?.href || '';
            const descEl = item.querySelector('.c-abstract, .c-span9, .c-span-last');
            const description = descEl?.textContent?.trim() || '';
            const sourceEl = item.querySelector('.c-color-gray, .c-showurl');
            const source = sourceEl?.textContent?.trim() || '';
            const timeEl = item.querySelector('.c-color-gray2, .newTimeFactor_time_y9w3r');
            const time = timeEl?.textContent?.trim() || '';
            if (title && link) results.push({ title, link, description, source, time });
          } catch { /* 单条解析失败跳过，不拖垮整页 */ }
        });
        return results;
      },
    },
  },
  bing: {
    id: 'bing',
    label: 'Bing',
    engine: 'Bing',
    itemNoun: '条结果',
    buildSearchUrl: q => `https://www.bing.com/search?q=${q}`,
    extractor: {
      kind: 'inline',
      // 逻辑逐行移植自原 bing_result_scraper（tools/analyse，已下线）
      func: () => {
        const results: Array<{ title: string; link: string; description: string; displayUrl: string }> = [];
        const resultItems = document.querySelectorAll('#b_results .b_algo, #b_results li.b_algo');
        resultItems.forEach(item => {
          try {
            const titleEl = item.querySelector('h2 a, h3 a');
            const title = titleEl?.textContent?.trim() || '';
            const link = (titleEl as HTMLAnchorElement)?.href || '';
            const descEl = item.querySelector('.b_caption p, .b_algoSlug');
            const description = descEl?.textContent?.trim() || '';
            const urlEl = item.querySelector('.b_attribution cite, .tpcn a.tilk');
            const displayUrl = urlEl?.textContent?.trim() || '';
            if (title && link) results.push({ title, link, description, displayUrl });
          } catch { /* 单条解析失败跳过，不拖垮整页 */ }
        });
        return results;
      },
    },
  },
  zhihu: {
    id: 'zhihu',
    label: '知乎',
    engine: 'Zhihu',
    itemNoun: '条结果',
    buildSearchUrl: q => `https://www.zhihu.com/search?type=content&q=${q}`,
    extractor: { kind: 'script', file: 'inject-scripts/scraper/zhihu.js', action: 'scrapeZhihuResults' },
  },
  github: {
    id: 'github',
    label: 'GitHub',
    engine: 'GitHub',
    itemNoun: '个仓库',
    buildSearchUrl: q => `https://github.com/search?q=${q}&type=repositories`,
    extractor: { kind: 'script', file: 'inject-scripts/scraper/github.js', action: 'scrapeGitHubResults' },
  },
  csdn: {
    id: 'csdn',
    label: 'CSDN',
    engine: 'CSDN',
    itemNoun: '篇文章',
    buildSearchUrl: q => `https://so.csdn.net/so/search?q=${q}&t=all&u=`,
    // 原 csdn_result_scraper 注入后等待 1s 让内容脚本完成监听注册
    extractor: { kind: 'script', file: 'inject-scripts/scraper/csdn.js', action: 'scrapeCSDNResults', initDelayMs: 1000 },
  },
  mooc: {
    id: 'mooc',
    label: '中国大学MOOC',
    engine: 'MOOC',
    itemNoun: '门课程',
    buildSearchUrl: q => `https://www.icourse163.org/search.htm?search=${q}`,
    extractor: { kind: 'script', file: 'inject-scripts/scraper/mooc.js', action: 'scrapeMoocResults' },
  },
  xiaohongshu: {
    id: 'xiaohongshu',
    label: '小红书',
    engine: 'Xiaohongshu',
    itemNoun: '篇笔记',
    buildSearchUrl: q => `https://www.xiaohongshu.com/search_result?keyword=${q}`,
    extractor: { kind: 'script', file: 'inject-scripts/scraper/xiaohongshu.js', action: 'scrapeXiaohongshuResults' },
  },
  cnki: {
    id: 'cnki',
    label: '中国知网',
    engine: 'CNKI',
    itemNoun: '篇文献',
    buildSearchUrl: q => `https://kns.cnki.net/kns8s/defaultresult/index?kw=${q}`,
    extractor: { kind: 'script', file: 'inject-scripts/scraper/cnki.js', action: 'scrapeCNKIResults' },
  },
  bilibili: {
    id: 'bilibili',
    label: 'Bilibili',
    engine: 'Bilibili',
    itemNoun: '个视频',
    buildSearchUrl: q => `https://search.bilibili.com/all?keyword=${q}`,
    extractor: { kind: 'script', file: 'inject-scripts/scraper/bilibili.js', action: 'scrapeBilibiliResults' },
  },
};

/** 全部平台 id（schema 枚举与文案派生的单一来源） */
export const SEARCH_PLATFORM_IDS: readonly SearchPlatformId[] = Object.keys(SEARCH_PLATFORMS) as SearchPlatformId[];

/** 判定值是否为合法平台 id */
export function isSearchPlatformId(value: unknown): value is SearchPlatformId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SEARCH_PLATFORMS, value);
}

/** 支持平台列表文案（错误提示用，如「baidu / bing / zhihu / …」） */
export function formatSupportedPlatforms(): string {
  return SEARCH_PLATFORM_IDS.join(' / ');
}

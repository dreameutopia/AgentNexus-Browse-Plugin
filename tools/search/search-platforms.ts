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
      // 实测驱动（2026-11 百度 SERP F12 实测）的三条设计：
      // 1. 容器 .c-container 与 h3 标题稳定；摘要/来源/时间的类名是
      //    「稳定前缀_hash」轮换制（content_MUfFD / source-text_1w-M9 /
      //    prefix-time_650Xx），叶子选择器因此走两条路：
      //    a. 按优先级逐个探测的选择器链——querySelector 逗号并集按文档序
      //       返回、无法表达优先级，链式探测才能保证「稳的先命中」；
      //    b. [class*="稳定前缀"] 子串匹配，哈希后缀轮换后仍能命中。
      // 2. 链接：锚点 href 是百度 link?url= 跳转串，真实目标 URL 在容器 mu
      //    属性——但 mu 可能是桩（nourl.ubs.baidu.com）或伪域名
      //    （*.recommend_list.baidu.com），必须校验为可解析的绝对 http(s)
      //    URL 且非桩域名才采用，否则回落跳转串（跳转串在浏览器里始终可导航）。
      // 3. 实测出现两类错位污染（时间混进来源列 / 来源挂进时间列），解析后
      //    做归一化：时间只保留可识别的发布时间形态，来源尾部挂时间时拆出。
      // 函数体必须自包含（chrome.scripting 序列化后在页面上下文求值，
      // 禁止引用任何外部作用域）。
      func: () => {
        /** 按优先级逐个尝试选择器，返回首个命中的非空文本（并集查询无法表达优先级） */
        const pickText = (root: Element, selectors: string[]): string => {
          for (const sel of selectors) {
            try {
              const el = root.querySelector(sel);
              const text = (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
              if (text) return text;
            } catch {
              /* 单级选择器异常不拖垮整条链 */
            }
          }
          return '';
        };
        // 可识别的发布时间形态（单一来源，供「时间列归一」与「来源尾部拆分」共用）
        const TIME_BODY =
          '(?:前天|昨天|今天|今日)\\s*\\d{1,2}:\\d{2}|' +
          '\\d{1,2}:\\d{2}|' +
          '\\d+\\s*(?:分钟|小时|天|周|个月|年)前|' +
          '\\d{4}[-/年]\\d{1,2}[-/月]\\d{1,2}日?(?:\\s+\\d{1,2}:\\d{2})?|' +
          '\\d{1,2}月\\d{1,2}日|' +
          '刚刚|前天|昨天|今天|今日';
        const timeLead = new RegExp('^(?:' + TIME_BODY + ')');
        const timeInSource = new RegExp('^(.*?)\\s*(' + TIME_BODY + ')$');

        const results: Array<{ title: string; link: string; description: string; source: string; time: string }> = [];
        const cards = document.querySelectorAll('#content_left .c-container, #content_left .result');
        cards.forEach(card => {
          try {
            // 「大家还在搜」等纯 UI 推荐卡不是搜索结果
            if ((card.getAttribute('tpl') ?? '') === 'recommend_list') return;

            // 标题：优先带 href 的锚点（标题与链接同源），逐级兜底到裸 h3
            const titleEl =
              card.querySelector('h3 a') ??
              card.querySelector('.c-title a') ??
              card.querySelector('.t a') ??
              card.querySelector('h3');
            const title = (titleEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (!title) return;

            // 链接：mu 真实直链（校验后）优先，否则锚点 href
            // （.href 属性天然把相对地址解析为绝对地址的百度跳转串）
            const rawAnchor = (titleEl as HTMLAnchorElement | null)?.href
              ? (titleEl as HTMLAnchorElement)
              : (card.querySelector('a') as HTMLAnchorElement | null);
            let link = rawAnchor?.href ?? '';
            const mu = card.getAttribute('mu');
            if (mu) {
              try {
                const u = new URL(mu);
                const usable =
                  (u.protocol === 'http:' || u.protocol === 'https:') &&
                  u.hostname.includes('.') &&
                  !/(^|\.)ubs\.baidu\.com$/.test(u.hostname) &&
                  !/(^|\.)recommend_list\.baidu\.com$/.test(u.hostname);
                if (usable) link = u.href;
              } catch {
                /* 非绝对 URL（相对串/乱码）→ 保留跳转串兜底 */
              }
            }
            if (!link) return;

            // 摘要：稳定 data 属性 → 旧版类 → 哈希轮换类前缀（见通道头部注释）
            let description = pickText(card, [
              '[data-module="abstract"]',
              '.c-abstract',
              '[class*="abstract"]',
              '.c-span-last',
              '.c-span9',
              '[class*="content_"]',
              '[class*="video-main-title"]',
            ]);

            // 行情卡没有文字摘要，数字才是正文：现价/涨跌/状态并入描述
            const quoteNum = pickText(card, ['[class*="cur-num"]']);
            if (quoteNum) {
              const quote = [quoteNum];
              const range = pickText(card, ['[class*="cur-range"]']);
              const ratio = pickText(card, ['[class*="cur-ratio"]']);
              const status = pickText(card, ['.update_6yJgf', '[class*="update_"]']);
              if (range) quote.push(range);
              if (ratio) quote.push(ratio);
              if (status) quote.push(status);
              const quoteLine = `实时行情：${quote.join(' · ')}`;
              description = description ? `${quoteLine}；${description}` : quoteLine;
            }

            // 来源与时间各自独立探测，再做错位归一
            let source = pickText(card, [
              '.cosc-source-text',
              '[class*="source-text"]',
              '.cosc-source',
              '.c-showurl',
            ]);
            let time = pickText(card, [
              '[class*="prefix-time"]',
              '.time_5bqZq',
              '.newTimeFactor_time_y9w3r',
              '.c-color-gray2',
              '[class*="time_"]',
              '.c-color-gray',
            ]);
            // 时间列只保留可识别的发布时间形态：识别不了宁可清空，
            // 也不把来源名等错位文本当时间回传（实测出现过「12小时前东方财富」整段错位）
            if (time) {
              const m = time.match(timeLead);
              time = m ? m[0] : '';
            }
            // 来源尾部挂时间（实测「东方财富网 前天12:22」来源与时间同一节点）：
            // 时间归一后仍为空则拆出补上，来源只留站点名
            if (source) {
              const m = source.match(timeInSource);
              if (m) {
                source = m[1].trim();
                if (!time) time = m[2];
              }
            }

            results.push({ title, link, description, source, time });
          } catch {
            /* 单卡解析失败跳过，不拖垮整页 */
          }
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

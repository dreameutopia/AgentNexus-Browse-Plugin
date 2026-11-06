/**
 * 统一多平台集成搜索工具（web_search）
 *
 * 取代并合并原三层 27 个平台专属工具（tools/search 的 9 个 *_search 纯导航、
 * tools/analyse 的 9 个 *_result_scraper 结果抓取、tools/integrated-search 的
 * 9 个 *_integrated_search 集成形态）。平台经 website 枚举区分，行为统一为
 * 集成语义：一次调用完成「导航到搜索结果页 → 等待加载 → 结构化解析 →
 * Markdown 表格」。
 *
 * 结果契约（两部分独立封装，解析失败绝不吞掉导航事实）：
 *   data.navigation —— 是否成功导航 + 当前实际网址（重定向后的最终 URL）+ 标签页；
 *   data.results    —— 解析产物（success/count/items/hint）；失败时 success=false
 *                      并给出提示（页面已就位，模型可用 browser_get_page_text
 *                      自行读取解析），不影响 navigation 的封装与整体 success。
 *   content[0].text —— 解析成功时为 Markdown 结果表（唯一一份），否则为状态消息。
 *
 * 执行上下文：sidepanel 与 background（service worker）均可运行——导航直接走
 * chrome.tabs（create/update），不经 browser_navigate，规避其上下文限制与
 * 整工具转发；chrome.scripting / chrome.tabs.sendMessage 两上下文同样原生可用。
 */

import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { resultsToMarkdownTable } from '../common/markdown-table';
import {
  SEARCH_PLATFORMS,
  SEARCH_PLATFORM_IDS,
  formatSupportedPlatforms,
  isSearchPlatformId,
  type SearchPlatformConfig,
} from './search-platforms';

/** query 长度上限（字符）：搜索关键词天然短，超长输入视为脏参数 */
const QUERY_MAX_LENGTH = 300;
/** 导航后等待页面 load 完成的轮询间隔 */
const LOAD_POLL_INTERVAL_MS = 400;
/** 页面加载等待上限（毫秒）：超时不判失败——页面可能仍可解析，如实上报状态 */
const LOAD_TIMEOUT_MS = 30_000;
/** 内容脚本消息响应等待上限（毫秒） */
const SCRIPT_MESSAGE_TIMEOUT_MS = 30_000;
/** waitTime 参数的合法区间 */
const WAIT_TIME_MIN_MS = 0;
const WAIT_TIME_MAX_MS = 10_000;
const WAIT_TIME_DEFAULT_MS = 3_000;

/** 导航结果（恒定封装，解析成败不影响其字段） */
interface NavigationOutcome {
  success: boolean;
  /**
   * complete：status 到达 complete；timeout：等待超时但标签页存活（页面可能仍可用）；
   * error：导航硬失败（标签页未创建/更新失败/标签页消失）
   */
  status: 'complete' | 'timeout' | 'error';
  /** 当前实际网址（重定向后的最终 URL；无法读取时回退 searchUrl） */
  url: string;
  /** 本工具构造的搜索 URL */
  searchUrl: string;
  tabId: number | null;
  newTab: boolean;
  /** 失败/超时的补充说明（面向模型） */
  note?: string;
}

/** 解析结果（失败时仅提示，不拖垮导航封装） */
interface ParseOutcome {
  success: boolean;
  count: number;
  items: unknown[];
  markdown?: string;
  /** 失败原因 / 空结果提示（面向模型） */
  hint?: string;
}

export class WebSearchTool extends BaseTool {
  name = 'web_search';

  metadata: ToolMetadata = {
    name: 'web_search',
    description: '统一多平台集成搜索：导航到指定平台的搜索结果页并解析返回结构化结果',
    displayName: '统一搜索',
    category: 'search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['search', 'integrated', 'multi-platform'],
    permissions: ['tabs', 'scripting'],
    // 搜索必然改变页面（导航到结果页）：视觉会话在工具批次后必须重拍截图
    visionRefresh: 'after',
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '统一多平台集成搜索入口：一次调用完成「导航到平台搜索结果页 → 等待加载 → 解析结构化结果 → Markdown 表格」。' +
        `website 枚举共 ${SEARCH_PLATFORM_IDS.length} 个平台：` +
        SEARCH_PLATFORM_IDS.map(id => `${id}（${SEARCH_PLATFORMS[id].label}）`).join('、') +
        '。传入不支持的 website 会直接返回错误并列出全部支持平台。\n' +
        '⚠ 本工具自带页面导航（效果等同调用 browser_navigate 打开搜索结果页，无需先手动导航）：会真实打开或跳转标签页并改变当前活动页面。' +
        '因此【禁止在同一轮里并发调用本工具】——多个导航会互相争抢活动标签页、解析到错误页面；需要搜索多个平台或换关键词时，逐个串行调用，每次依据上次返回决定下一步。\n' +
        '返回两部分：navigation（是否成功导航 + 当前实际网址）与 results（解析出的条目与 Markdown 表）。' +
        'results 解析失败时 navigation 仍有效——页面已就位，用 browser_get_page_text 读取当前页自行解析即可。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          website: {
            type: 'string',
            enum: [...SEARCH_PLATFORM_IDS],
            description:
              '目标搜索平台（枚举值，小写）：' +
              SEARCH_PLATFORM_IDS.map(id => `${id}=${SEARCH_PLATFORMS[id].label}`).join('、'),
          },
          query: {
            type: 'string',
            description: '搜索关键词（必填，去除首尾空白，最长 300 字符）',
          },
          newTab: {
            type: 'boolean',
            description: '是否在新标签页打开搜索结果（默认 true）。连续多轮搜索可传 false 直接复用当前标签页，避免标签页堆积',
          },
          waitTime: {
            type: 'integer',
            description: `页面加载完成后的额外等待毫秒数（0-${WAIT_TIME_MAX_MS}，默认 ${WAIT_TIME_DEFAULT_MS}）：动态内容较多的站点（如知网、Bilibili）可适当调大以保证结果渲染`,
          },
        },
        required: ['website', 'query'],
      },
    },
  };

  async execute(rawArgs: unknown): Promise<ToolResult> {
    // ── 参数防御：形态校验先于一切副作用 ──
    const args =
      rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : null;
    if (!args) {
      return this.createErrorResponse('参数必须是 JSON 对象（website / query 必填）');
    }
    const websiteRaw = typeof args.website === 'string' ? args.website.trim().toLowerCase() : '';
    if (!isSearchPlatformId(websiteRaw)) {
      return this.createErrorResponse(
        `不支持的搜索平台：${JSON.stringify(args.website ?? '')}。web_search 仅支持 ${formatSupportedPlatforms()}，请从中选择 website 的枚举值`,
      );
    }
    const platform = SEARCH_PLATFORMS[websiteRaw];
    if (typeof args.query !== 'string' || !args.query.trim()) {
      return this.createErrorResponse(`query 必填且为非空字符串（平台 ${platform.label}）`);
    }
    const query = args.query.trim();
    if (query.length > QUERY_MAX_LENGTH) {
      return this.createErrorResponse(`query 过长（${query.length} 字符，上限 ${QUERY_MAX_LENGTH}），请精简关键词`);
    }
    const newTab = args.newTab !== false;
    const waitTimeRaw = Number(args.waitTime);
    const waitTime = Number.isFinite(waitTimeRaw)
      ? Math.min(Math.max(Math.floor(waitTimeRaw), WAIT_TIME_MIN_MS), WAIT_TIME_MAX_MS)
      : WAIT_TIME_DEFAULT_MS;

    this.log(`在 ${platform.label} 搜索 "${query}"（newTab=${newTab}，waitTime=${waitTime}ms）`);
    const searchUrl = platform.buildSearchUrl(encodeURIComponent(query));

    // ── 导航（结果独立封装，解析成败不影响它） ──
    const navigation = await this.navigate(searchUrl, newTab);
    if (!navigation.success) {
      this.log(`导航失败: ${navigation.note ?? '未知原因'}`, 'error');
      return {
        success: false,
        error: `[web_search] 导航失败：${navigation.note ?? '未知原因'}`,
        data: { website: platform.id, query, searchEngine: platform.engine, navigation },
        content: [{ type: 'text', text: `导航失败：${navigation.note ?? '未知原因'}。可检查网络与站点可达性后重试，或改用 browser_navigate 手动打开 ${searchUrl}` }],
      };
    }

    // ── 解析（失败只提示，不拖垮整体结果） ──
    const parse = await this.parseResults(platform, navigation);
    const message = parse.success
      ? parse.count > 0
        ? `已在${platform.label}完成搜索「${query}」：导航成功（${navigation.url}），解析出 ${parse.count} ${platform.itemNoun}`
        : `已在${platform.label}完成搜索「${query}」：导航成功（${navigation.url}），未解析到结果条目（${parse.hint ?? '页面可能无匹配或结构变化'}）`
      : `已在${platform.label}完成搜索「${query}」：导航成功（${navigation.url}），但结果解析失败（${parse.hint ?? '未知原因'}）——页面已就位，可用 browser_get_page_text 读取当前页自行解析`;

    this.log(message);
    // Markdown 只经 content 承载一份（引擎会把整个结果连同 content 序列化回传
    // 模型——data 里再放一份即双份冗余）；data.results 保留结构化 items
    const { markdown: _markdown, ...results } = parse;
    return {
      success: true,
      message,
      data: {
        website: platform.id,
        query,
        searchEngine: platform.engine,
        navigation,
        results,
      },
      content: [{ type: 'text', text: _markdown ?? message }],
    };
  }

  /**
   * 导航到搜索结果页并等待加载。
   * 直接走 chrome.tabs（MV3 Promise 风格，sidepanel / background 双上下文原生
   * 可用），不经 browser_navigate——本工具即是导航的语义承载方，无需二次转发。
   */
  private async navigate(searchUrl: string, newTab: boolean): Promise<NavigationOutcome> {
    const base = { searchUrl, newTab };
    try {
      let tabId: number;
      if (newTab) {
        const created = await chrome.tabs.create({ url: searchUrl, active: true });
        if (!created?.id) throw new Error('新标签页创建失败（未返回 tabId）');
        tabId = created.id;
      } else {
        // lastFocusedWindow 而非 currentWindow：background service worker 没有
        // 「当前窗口」概念，currentWindow 在该上下文会查空；lastFocusedWindow
        // 在 sidepanel 与 background 双上下文都指向用户正在看的窗口
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!active?.id) throw new Error('未找到可导航的当前标签页（没有活动窗口？）');
        await chrome.tabs.update(active.id, { url: searchUrl });
        tabId = active.id;
      }

      const status = await this.waitForLoad(tabId);
      const currentUrl = await this.readTabUrl(tabId);
      return {
        success: true,
        status: status.timedOut ? 'timeout' : 'complete',
        url: currentUrl ?? searchUrl,
        tabId,
        ...base,
        ...(status.timedOut
          ? { note: `页面 ${LOAD_TIMEOUT_MS / 1000}s 内未到达 complete（可能仍在加载）` }
          : {}),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { success: false, status: 'error', url: searchUrl, tabId: null, note: reason, ...base };
    }
  }

  /** 轮询标签页 load 状态；标签页消失视为失败，超时视为软失败（不判导航失败） */
  private async waitForLoad(tabId: number): Promise<{ timedOut: boolean }> {
    // 以轮询次数而非墙钟为上限：对系统时钟跳变免疫，且行为可被测试精确驱动
    const maxPolls = Math.ceil(LOAD_TIMEOUT_MS / LOAD_POLL_INTERVAL_MS);
    for (let poll = 0; poll < maxPolls; poll++) {
      // Promise 风格：标签页不存在时 reject，消息即失败原因
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        throw new Error(`标签页 ${tabId} 已不存在或不可读（可能被关闭）`);
      }
      if (!tab) throw new Error(`标签页 ${tabId} 已不存在（可能被关闭）`);
      if (tab.status === 'complete') return { timedOut: false };
      await new Promise(resolve => setTimeout(resolve, LOAD_POLL_INTERVAL_MS));
    }
    return { timedOut: true };
  }

  /** 读取标签页当前 URL（重定向后的最终地址；读不到回退 null） */
  private async readTabUrl(tabId: number): Promise<string | null> {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab?.url || tab?.pendingUrl || null;
    } catch {
      return null;
    }
  }

  /**
   * 按平台解析当前搜索结果页。两类通道（配置见 search-platforms.ts）：
   *   inline —— chrome.scripting.executeScript 注入自包含函数；
   *   script —— 注入静态内容脚本 + sendMessage 触发（契约 status/data|message）。
   * 任何异常都收敛为 ParseOutcome（success=false + 提示），绝不向上抛。
   */
  private async parseResults(platform: SearchPlatformConfig, navigation: NavigationOutcome): Promise<ParseOutcome> {
    const tabId = navigation.tabId;
    if (tabId === null) {
      return { success: false, count: 0, items: [], hint: '导航未返回有效标签页，无法解析' };
    }
    try {
      const items = await this.runExtractor(platform, tabId);
      if (!Array.isArray(items)) {
        return {
          success: false,
          count: 0,
          items: [],
          hint: `解析器返回了非数组结果（${typeof items}），页面结构可能已变化`,
        };
      }
      if (items.length === 0) {
        return {
          success: true,
          count: 0,
          items: [],
          hint: `未解析到${platform.itemNoun}：可能无匹配结果、遇到登录墙/验证码或页面结构变化；页面已就位，可用 browser_get_page_text 读取当前页确认`,
        };
      }
      return { success: true, count: items.length, items, markdown: resultsToMarkdownTable(items) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        count: 0,
        items: [],
        hint: `${reason}。若标签页仍在，可用 browser_get_page_text 读取当前页自行解析（若已被关闭则重新调用本工具）`,
      };
    }
  }

  /** 执行平台解析通道，返回原始条目载荷（形态判定由 parseResults 收敛；异常上抛由 parseResults 捕获） */
  private async runExtractor(platform: SearchPlatformConfig, tabId: number): Promise<unknown> {
    const { extractor } = platform;
    if (extractor.kind === 'inline') {
      if (typeof extractor.func !== 'function') {
        throw new Error(`平台 ${platform.id} 的 inline 解析函数缺失（配置缺陷）`);
      }
      const injection = await chrome.scripting.executeScript({ target: { tabId }, func: extractor.func });
      // 形态判定统一交给 parseResults（非数组 → 可读的解析失败提示）
      return injection?.[0]?.result;
    }

    const file = extractor.file;
    const action = extractor.action;
    if (typeof file !== 'string' || typeof action !== 'string') {
      throw new Error(`平台 ${platform.id} 的 script 解析配置缺失（file/action）`);
    }
    await this.injectScriptFile(tabId, file);
    if (extractor.initDelayMs && extractor.initDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, extractor.initDelayMs));
    }
    const response = await this.sendScraperMessage(tabId, action);
    if (response.status === 'error') {
      throw new Error(`内容脚本解析失败：${response.message ?? '未知错误'}`);
    }
    if (response.status !== 'success' || !Array.isArray(response.data)) {
      throw new Error(`内容脚本返回无效响应（status=${String(response.status)}，data 应为条目数组）`);
    }
    return response.data;
  }

  /** 注入静态内容脚本（重复注入由浏览器按文件幂等处理；Promise 风格） */
  private async injectScriptFile(tabId: number, file: string): Promise<void> {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`内容脚本注入失败（${file}）：${reason}`);
    }
  }

  /** 向内容脚本发解析指令并等待响应（契约 {status:'success',data}|{status:'error',message}） */
  private async sendScraperMessage(
    tabId: number,
    action: string,
  ): Promise<{ status: string; data?: unknown[]; message?: string }> {
    let response: unknown;
    try {
      // 败者静默：超时胜出后 sendMessage 可能仍以拒绝收场（如接收端不存在），
      // 挂 no-op catch 防 unhandledrejection；timer 在成功路径显式清理不悬挂
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const messagePromise = chrome.tabs.sendMessage(tabId, { action });
      messagePromise.catch(() => undefined);
      response = await Promise.race([
        messagePromise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`等待内容脚本响应超时（${SCRIPT_MESSAGE_TIMEOUT_MS / 1000}s，action=${action}）`)),
            SCRIPT_MESSAGE_TIMEOUT_MS,
          );
        }),
      ]);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`消息通道失败：${reason}（页面可能未加载完成或未注入成功）`);
    }
    if (!response || typeof response !== 'object') {
      throw new Error('内容脚本未响应或响应非对象（可能未注入成功）');
    }
    return response as { status: string; data?: unknown[]; message?: string };
  }
}

/**
 * 页面净化工具（browser_clean_page）
 *
 * 强制去广告 / 去弹窗 / 去追踪，双层防护：
 *
 * 1. DOM 层（默认）—— 注入 page-clean-helper.js 到隔离世界：
 *    - 按分级规则集（light/standard/aggressive）隐藏广告位、赞助内容、
 *      Cookie 同意横幅、全屏遮罩弹窗（启发式识别固定定位高 z-index 遮罩）；
 *    - MutationObserver 持续守护，拦截 SPA 运行中动态注入的新弹窗
 *      （静态 CSS 注入做不到这一点）；
 *    - 弹窗锁滚动问题：识别 body overflow:hidden 并恢复页面可滚动；
 *    - 全程「隐藏而非删除」：通过 data-agentnexus-cleaned 标记 + 注入 CSS
 *      统一置空显示，restore 时一键完整撤销，不破坏页面框架状态；
 *
 * 2. 网络层（mode=network/both）—— declarativeNetRequest 会话规则：
 *    MV3 官方推荐的请求拦截方案（webRequest 同步阻断在 MV3 已移除），
 *    从源头拦截广告脚本、统计像素、推荐位请求，既提速又减少 DOM 层压力；
 *    会话规则仅在浏览器运行期内生效，重启即自动清除。
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES, isRestrictedUrl } from '@/common/constants';

/** DOM 隐藏规则：净化标记元素统一置空显示 */
const HIDE_CSS = '[data-agentnexus-cleaned="1"] { display: none !important; }';

/** 注入脚本（构建时随静态资源拷贝，已在 manifest 声明 web accessible） */
const CLEAN_HELPER_FILE = 'inject-scripts/interaction/page-clean-helper.js';

/** 分级规则集基础定义（light 保守、standard 标准） */
const BASE_RULE_SETS = {
  light: [
    '.adsbygoogle',
    'ins.adsbygoogle',
    '[data-ad-client]',
    '[data-ad-slot]',
    '[id^="div-gpt-ad"]',
    '[id*="google_ads"]',
    '[id*="googlesyndication"]',
    '[aria-label="advertisement"]',
    '[aria-label="Ad"]',
    '[class*="sponsored-content"]',
  ],
  standard: [
    '.adsbygoogle',
    'ins.adsbygoogle',
    '[data-ad-client]',
    '[data-ad-slot]',
    '[id^="div-gpt-ad"]',
    '[id*="google_ads"]',
    '[id*="googlesyndication"]',
    '[aria-label="advertisement"]',
    '[aria-label="Ad"]',
    '[class*="sponsored-content"]',
    '[id^="ad_"]',
    '[id$="_ad"]',
    '[class^="ad-"]',
    '[class*=" ad-"]',
    '[data-ad]',
    '[data-ad-placement]',
    '[data-testid*="ad-placement"]',
    '[class*="sponsored-"]',
    '[data-sponsored]',
    '#onetrust-banner-sdk',
    '#onetrust-consent-sdk',
    '#CybotCookiebotDialog',
    '.qc-cmp2-container',
    '.cc-window',
    '.cc-banner',
    '[id*="cookie-banner"]',
    '[class*="cookie-consent"]',
    '[id*="gdpr-banner"]',
    '[class*="download-guide"]',
    '[class*="float-ad"]',
    '[class*="popup-ad"]',
  ],
};

/**
 * 分级规则集合：
 * aggressive 复用 standard 全量规则，另在注入脚本内启用全屏遮罩弹窗启发式识别
 */
const SCOPE_RULE_SETS: Record<'light' | 'standard' | 'aggressive', string[]> = {
  light: BASE_RULE_SETS.light,
  standard: BASE_RULE_SETS.standard,
  aggressive: [...BASE_RULE_SETS.standard],
};

/**
 * 网络层拦截规则：常见广告联盟 / 统计分析 / 推荐位域名
 * 规则 ID 占用 91001–91099 保留区间，restore 时整段移除
 */
const NETWORK_BLOCK_RULES: { id: number; domain: string }[] = [
  { id: 91001, domain: 'doubleclick.net' },
  { id: 91002, domain: 'googlesyndication.com' },
  { id: 91003, domain: 'google-analytics.com' },
  { id: 91004, domain: 'googletagmanager.com' },
  { id: 91005, domain: 'googleadservices.com' },
  { id: 91006, domain: 'adservice.google.com' },
  { id: 91007, domain: 'facebook.net' },
  { id: 91008, domain: 'adnxs.com' },
  { id: 91009, domain: 'criteo.com' },
  { id: 91010, domain: 'criteo.net' },
  { id: 91011, domain: 'taboola.com' },
  { id: 91012, domain: 'outbrain.com' },
  { id: 91013, domain: 'scorecardresearch.com' },
  { id: 91014, domain: 'moatads.com' },
  { id: 91015, domain: 'pubmatic.com' },
  { id: 91016, domain: 'openx.net' },
  { id: 91017, domain: 'rubiconproject.com' },
  { id: 91018, domain: 'advertising.com' },
  { id: 91019, domain: 'hotjar.com' },
  { id: 91020, domain: 'mixpanel.com' },
  { id: 91021, domain: 'segment.io' },
  { id: 91022, domain: 'amplitude.com' },
  { id: 91023, domain: 'clarity.ms' },
  { id: 91024, domain: 'bidswitch.net' },
  { id: 91025, domain: 'smartadserver.com' },
  { id: 91026, domain: 'crazyegg.com' },
  { id: 91027, domain: 'fullstory.com' },
  { id: 91028, domain: 'optimizely.com' },
];

/** 网络拦截覆盖的子资源类型（排除 main_frame，避免影响正常导航） */
const BLOCK_RESOURCE_TYPES = [
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'media',
  'websocket',
] as chrome.declarativeNetRequest.ResourceType[];

interface CleanParams {
  /** 净化层面：dom=仅 DOM 隐藏（默认）/ network=仅网络拦截 / both=双层防护 */
  mode?: 'dom' | 'network' | 'both';
  /** DOM 规则强度：light=仅明确广告位 / standard=标准（默认）/ aggressive=标准+全屏遮罩弹窗启发式清除 */
  scope?: 'light' | 'standard' | 'aggressive';
  /** 追加自定义隐藏选择器（在所选 scope 基础上叠加） */
  customSelectors?: string[];
  /** 撤销之前的净化：移除 DOM 标记/注入样式与网络拦截规则 */
  restore?: boolean;
  /** 目标标签页 ID（默认当前激活标签页）；DOM 净化只作用于该页，网络拦截作用于整个浏览器会话 */
  tabId?: number;
}

/**
 * 页面净化工具
 */
export class PageCleanTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.PAGE_CLEAN;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.PAGE_CLEAN,
    description: '强制去广告/去弹窗/去追踪：DOM 隐藏 + 动态弹窗持续拦截 + 网络层请求阻断，可一键撤销',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'clean', 'ads', 'popup', 'block', 'rpa', 'chrome'],
    displayName: '页面净化（去广告弹窗）',
    permissions: ['scripting', 'declarativeNetRequest'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.PAGE_CLEAN,
      description:
        '强制清理当前页面的广告、弹窗、追踪器。' +
        'DOM 层：按规则隐藏广告位/赞助内容/Cookie 横幅/全屏遮罩弹窗，并通过 MutationObserver 持续拦截 SPA 动态注入的新弹窗、恢复被弹窗锁死的页面滚动；' +
        '网络层（mode=network/both）：用 declarativeNetRequest 会话规则从源头阻断广告与统计请求。' +
        '所有 DOM 净化均可通过 restore=true 完整撤销。当页面被弹窗完全遮挡无法操作时，推荐 mode=both + scope=aggressive。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['dom', 'network', 'both'],
            description: '净化层面。dom=DOM 隐藏+动态拦截（默认）；network=仅网络层阻断；both=双层防护（推荐用于强弹窗站点）',
            default: 'dom',
          },
          scope: {
            type: 'string',
            enum: ['light', 'standard', 'aggressive'],
            description: 'DOM 规则强度。light=仅无歧义广告位；standard=标准规则含 Cookie 横幅（默认）；aggressive=标准+启发式清除全屏遮罩弹窗并解锁滚动',
            default: 'standard',
          },
          customSelectors: {
            type: 'array',
            description: '追加自定义隐藏选择器（在所选规则集基础上叠加）',
            items: { type: 'string' },
          },
          restore: {
            type: 'boolean',
            description: '撤销之前的净化（移除 DOM 隐藏标记与网络拦截规则），默认 false',
            default: false,
          },
          tabId: {
            type: 'number',
            description: '目标标签页 ID（可选，默认当前激活标签页）',
          },
        },
        required: [],
      },
    },
  };

  async execute(args: CleanParams): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const {
      mode = 'dom',
      scope = 'standard',
      customSelectors = [],
      restore = false,
      tabId: requestedTabId,
    } = args;

    try {
      // tabId 允许为 0：真值判断会把合法的 0 当作「未提供」而错选活动标签页
      const tab = requestedTabId !== undefined && requestedTabId !== null
        ? await chrome.tabs.get(requestedTabId)
        : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab || typeof tab.id !== 'number') {
        return this.createErrorResponse('No active tab found');
      }
      const tabId = tab.id;

      // 受限页面统一口径判定（chrome://、about:、file:// 等，见 common/constants）
      if (isRestrictedUrl(tab.url)) {
        return this.createErrorResponse(
          `Current page is a restricted URL (${tab.url || 'no URL'}) where page cleanup is not permitted`,
        );
      }

      // —— 撤销路径 ——
      if (restore) {
        const domRestored = mode !== 'network' ? await this.restoreDom(tabId) : null;
        const netRestored = mode !== 'dom' ? await this.restoreNetwork() : null;
        return this.createSuccessResponse(
          {
            tabId,
            url: tab.url,
            restored: true,
            dom: domRestored,
            network: netRestored,
          },
          'Page cleanup restored',
        );
      }

      const result: Record<string, unknown> = { tabId, url: tab.url, mode, scope };

      // —— DOM 层净化 ——
      if (mode === 'dom' || mode === 'both') {
        result.dom = await this.applyDomCleanup(tabId, scope, customSelectors);
      }

      // —— 网络层拦截 ——
      if (mode === 'network' || mode === 'both') {
        result.network = await this.applyNetworkBlocking();
      }

      return this.createSuccessResponse(result, `Page cleanup applied (${mode} mode, ${scope} scope)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.createErrorResponse(`Page cleanup failed: ${message}`);
    }
  }

  /** DOM 层净化：注入守护脚本 + 隐藏样式 + 启动持续守护 */
  private async applyDomCleanup(
    tabId: number,
    scope: 'light' | 'standard' | 'aggressive',
    customSelectors: string[],
  ): Promise<Record<string, unknown>> {
    // 1. 注入隔离世界守护脚本（自带重复注入保护）
    await this.injectContentScript(tabId, [CLEAN_HELPER_FILE]);

    // 2. 注入统一隐藏样式（标记元素置空显示，author 级 !important 可覆盖行内样式）
    await chrome.scripting.insertCSS({
      target: { tabId },
      css: HIDE_CSS,
      origin: 'AUTHOR',
    });

    // 3. 下发净化指令：初始清扫 + MutationObserver 持续守护
    const rules = [...(SCOPE_RULE_SETS[scope] || SCOPE_RULE_SETS.standard), ...customSelectors];
    const response = await this.sendMessageToTab(tabId, {
      action: 'applyClean',
      payload: {
        rules,
        aggressive: scope === 'aggressive',
        persist: true,
      },
    });

    return {
      hidden: response?.hidden ?? 0,
      totalHidden: response?.totalHidden ?? 0,
      observing: response?.observing === true,
      ruleCount: rules.length,
    };
  }

  /** 撤销 DOM 层净化：停止守护 + 移除标记 + 移除注入样式 */
  private async restoreDom(tabId: number): Promise<Record<string, unknown>> {
    let restoredElements = 0;
    try {
      const response = await this.sendMessageToTab(tabId, {
        action: 'clearClean',
      });
      restoredElements = response?.restored ?? 0;
    } catch {
      // 守护脚本未注入过（如页面已刷新）：无 DOM 状态可恢复，继续移除样式即可
    }

    try {
      await chrome.scripting.removeCSS({
        target: { tabId },
        css: HIDE_CSS,
        origin: 'AUTHOR',
      });
    } catch {
      // 样式未注入过时 removeCSS 会抛错，忽略
    }

    return { restoredElements };
  }

  /** 网络层拦截：写入 declarativeNetRequest 会话规则 */
  private async applyNetworkBlocking(): Promise<Record<string, unknown>> {
    if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest) {
      return { applied: false, reason: 'declarativeNetRequest API 不可用（缺少权限）' };
    }

    const addRules: chrome.declarativeNetRequest.Rule[] = NETWORK_BLOCK_RULES.map(
      ({ id, domain }) => ({
        id,
        priority: 1,
        action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
        condition: {
          requestDomains: [domain],
          resourceTypes: BLOCK_RESOURCE_TYPES,
        },
      }),
    );

    await chrome.declarativeNetRequest.updateSessionRules({
      addRules,
      removeRuleIds: [],
    });

    return {
      applied: true,
      blockedDomains: NETWORK_BLOCK_RULES.length,
      note: '会话级规则，浏览器重启后自动失效；可传 restore=true 手动撤销',
    };
  }

  /** 撤销网络层拦截：移除保留区间的全部规则 */
  private async restoreNetwork(): Promise<Record<string, unknown>> {
    if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest) {
      return { applied: false, reason: 'declarativeNetRequest API 不可用（缺少权限）' };
    }

    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [],
      removeRuleIds: NETWORK_BLOCK_RULES.map(({ id }) => id),
    });

    return { applied: true, removedRules: NETWORK_BLOCK_RULES.length };
  }
}

// 导出工具实例
export const pageCleanTool = new PageCleanTool();

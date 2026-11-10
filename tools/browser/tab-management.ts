/**
 * 统一标签页与窗口工具（browser_tabs）
 *
 * 原 browser_get_all_tabs / browser_switch_tab / browser_close_tab /
 * browser_close_tabs / browser_create_tab / browser_window 六个工具已合并为
 * 本工具的五个 action（项目未发布，无兼容别名，旧名直接删除）：
 *   - list     枚举标签页（原 browser_get_all_tabs，flat 列表）
 *   - switch   切换并聚焦标签页（原 browser_switch_tab）
 *   - close    关闭标签页：单个 tabId / 批量 tabIds / URL 匹配 / 缺省关当前
 *              （原 browser_close_tab 与 browser_close_tabs 的并集）
 *   - create   新建标签页（原 browser_create_tab）
 *   - windows  窗口树枚举（原 browser_window）
 *
 * 防御性约定：
 *   - 五 action 共用一套参数矩阵校验：未知参数、张冠李戴（如 list 带 tabId）
 *     一律报可读错误，不静默失效；
 *   - close 的三种寻址方式（tabId / tabIds / url）互斥，同时给出即报错——
 *     静默挑一个执行会关错标签页；
 *   - create 绑定现有普通窗口，绝不隐式新建窗口（与 browser_navigation 同源
 *     的 existingNavigationWindowId 边界）。
 *
 * 视觉重拍口径（见 registry.ts noVisionRecapture 注释）：本工具各 action 的
 * 页面影响不同（list/windows 纯枚举、switch/close/create 改变活动标签页与
 * 视口），工具级无法用一个布尔表达——metadata 保持缺省（保守重拍），
 * 纯枚举 action 的豁免在 vision-feedback 按 action 判定。
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { existingNavigationWindowId } from './navigation-window';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';
import {
  checkActionMatrix,
  readBooleanField,
  readIntArrayField,
  readNonEmptyStringField,
  readNumberField,
} from './action-args';

/** 五个标签页 action（schema 枚举与运行期校验同源） */
export const TABS_ACTIONS = ['list', 'switch', 'close', 'create', 'windows'] as const;
export type TabsAction = (typeof TABS_ACTIONS)[number];

/** 每个 action 允许出现的参数（运行期矩阵，防拼写/张冠李戴静默失效） */
const ACTION_PARAMS: Record<TabsAction, readonly string[]> = {
  list: ['currentWindow'],
  switch: ['tabId'],
  close: ['tabId', 'tabIds', 'url'],
  create: ['url', 'active'],
  windows: [],
};

interface TabsArgs {
  action: TabsAction;
  currentWindow?: boolean;
  tabId?: number;
  tabIds?: number[];
  url?: string;
  active?: boolean;
}

type ValidationResult = { error: ToolResult; args?: never } | { error?: never; args: TabsArgs };

/**
 * 统一标签页与窗口工具：action 驱动的枚举/切换/关闭/创建
 */
export class BrowserTabsTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.TABS;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.TABS,
    description: '标签页与窗口管理：枚举/切换/关闭/创建标签页与窗口树（action 驱动）',
    category: 'browser',
    version: '3.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'tab', 'window', 'chrome'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.TABS,
      description:
        '标签页与窗口管理，action 五选一：' +
        'list=枚举标签页（缺省全部窗口，currentWindow=true 只看当前窗口）；' +
        'switch=切换到指定 tabId 并聚焦其窗口（切换后视图已变，引用需要重新观察）；' +
        'close=关闭标签页（tabId 单个 / tabIds 批量 / url 按地址匹配（忽略结尾斜杠时按前缀组匹配）三选一，都不传则关闭当前活动标签）；' +
        'create=新建标签页（active=false 时后台打开不夺取焦点）；' +
        'windows=窗口树枚举（每个窗口及其标签页）。' +
        'list 与 windows 是纯枚举只读；switch/close/create 会改变用户眼前的页面。' +
        'create 与 browser_navigation 一样绑定现有普通窗口，绝不创建新窗口。' +
        '需要页面内容/状态时用 browser_get_page_text / browser_get_page_info，本工具只管理标签页本身。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: [...TABS_ACTIONS],
            description: 'list=枚举标签页；switch=切换标签；close=关闭标签；create=新建标签；windows=窗口树枚举',
          },
          currentWindow: {
            type: 'boolean',
            description: '仅 action="list"：是否只枚举当前窗口的标签页（默认 false = 全部窗口）',
          },
          tabId: {
            type: 'number',
            description: 'switch 必填 / close 可选：目标标签页 ID（switch 与 close 的单个寻址）',
          },
          tabIds: {
            type: 'array',
            items: { type: 'number' },
            description: '仅 action="close"：批量关闭的标签页 ID 列表（与 tabId、url 互斥）',
          },
          url: {
            type: 'string',
            description: 'close=按 URL 匹配关闭（与 tabId、tabIds 互斥；不含结尾斜杠时按「路径/*」前缀组匹配）；create=新标签页要打开的 URL（可选）',
          },
          active: {
            type: 'boolean',
            default: true,
            description: '仅 action="create"：是否激活新标签页，默认 true；false 后台打开（不聚焦窗口）',
          },
        },
        required: ['action'],
      },
    },
  };

  async execute(rawArgs: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const validated = this.validate(rawArgs);
    if (validated.error) return validated.error;
    const args = validated.args;

    try {
      switch (args.action) {
        case 'list':
          return await this.handleList(args);
        case 'switch':
          return await this.handleSwitch(args);
        case 'close':
          return await this.handleClose(args);
        case 'create':
          return await this.handleCreate(args, context);
        case 'windows':
          return await this.handleWindows();
      }
    } catch (error) {
      return this.createErrorResponse(`Failed to ${args.action}`, error);
    }
  }

  // ──── 参数校验（共享矩阵 + 字段读取，见 ./action-args.ts） ────

  private validate(rawArgs: unknown): ValidationResult {
    const matrix = checkActionMatrix<TabsAction>(rawArgs, {
      actions: TABS_ACTIONS,
      params: ACTION_PARAMS,
    });
    if (!matrix.ok) return { error: this.createErrorResponse(matrix.error) };
    const { action, input } = matrix;

    const args: TabsArgs = { action };

    const currentWindow = readBooleanField(input, 'currentWindow');
    if (!currentWindow.ok) return { error: this.createErrorResponse(currentWindow.error) };
    if (currentWindow.value !== undefined) args.currentWindow = currentWindow.value;

    const tabId = readNumberField(input, 'tabId', { min: 0, integer: true });
    if (!tabId.ok) return { error: this.createErrorResponse(tabId.error) };
    if (tabId.value !== undefined) args.tabId = tabId.value;

    if (input.tabIds !== undefined) {
      // 去重保序：重复 id 会让底层对同一标签页二次操作（action-args 统一处理）
      const tabIds = readIntArrayField(input, 'tabIds', {
        min: 0,
        emptyError: 'tabIds 必须是非空数字数组',
      });
      if (!tabIds.ok) return { error: this.createErrorResponse(tabIds.error) };
      args.tabIds = tabIds.value;
    }

    const url = readNonEmptyStringField(input, 'url');
    if (!url.ok) return { error: this.createErrorResponse(url.error) };
    if (url.value !== undefined) args.url = url.value;

    const active = readBooleanField(input, 'active');
    if (!active.ok) return { error: this.createErrorResponse(active.error) };
    if (active.value !== undefined) args.active = active.value;

    // ── action 级必填与互斥 ──
    if (action === 'switch' && args.tabId === undefined) {
      return { error: this.createErrorResponse('action="switch" 需要 tabId（先用 list 或 browser_get_page_info 拿到目标 ID）') };
    }
    if (action === 'close') {
      const provided = [args.tabId !== undefined, args.tabIds !== undefined, args.url !== undefined].filter(Boolean).length;
      if (provided > 1) {
        return { error: this.createErrorResponse('close 的 tabId / tabIds / url 三种寻址互斥，一次只可提供一种（同时给出会关错标签页）') };
      }
    }
    return { args };
  }

  // ──── action 实现 ────

  /** list：枚举标签页（原 browser_get_all_tabs 语义） */
  private async handleList(args: TabsArgs): Promise<ToolResult> {
    const tabs = await chrome.tabs.query(args.currentWindow ? { currentWindow: true } : {});

    const tabsInfo = tabs.map(tab => ({
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title,
      active: tab.active,
      status: tab.status,
      index: tab.index,
      pinned: tab.pinned,
      audible: tab.audible,
      incognito: tab.incognito,
    }));

    return this.createSuccessResponse({
      count: tabsInfo.length,
      tabs: tabsInfo,
    }, `Found ${tabsInfo.length} tabs`);
  }

  /** switch：切换标签页并聚焦其窗口（原 browser_switch_tab 语义） */
  private async handleSwitch(args: TabsArgs): Promise<ToolResult> {
    const tabId = args.tabId as number;
    // 先核验存在性：真实 chrome.tabs.get 对缺失 id 会抛裸错，统一收敛为
    // 与 close / wait 同族的可读文案（不把 chrome 内部措辞抛给模型）
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      tab = undefined;
    }
    if (!tab) {
      return this.createErrorResponse(`标签页 ${tabId} 不存在（可能已关闭），请用 action="list" 核对`);
    }

    await chrome.tabs.update(tabId, { active: true });

    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }

    return this.createSuccessResponse({
      tabId,
      url: tab.url,
      title: tab.title,
      windowId: tab.windowId,
    }, 'Successfully switched to tab');
  }

  /**
   * 逐个关闭并收集明细：单个失败不拖垮整批——返回可分析的
   * closed（真正关掉的）与 failed（关闭动作被拒的，带底层原因）。
   */
  private async removeTabsResilient(
    ids: readonly number[],
  ): Promise<{ closed: number[]; failed: Array<{ tabId: number; reason: string }> }> {
    const settled = await Promise.allSettled(ids.map(id => chrome.tabs.remove(id)));
    const closed: number[] = [];
    const failed: Array<{ tabId: number; reason: string }> = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        closed.push(ids[index]);
      } else {
        failed.push({
          tabId: ids[index],
          reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
    return { closed, failed };
  }

  /** failed 明细拼进文案（错误/告警共用同一格式） */
  private formatFailures(failed: readonly { tabId: number; reason: string }[]): string {
    return failed.map(item => `#${item.tabId} ${item.reason}`).join('；');
  }

  /** close：单个 / 批量 / URL 匹配 / 缺省当前标签（原 close_tab 与 close_tabs 的并集） */
  private async handleClose(args: TabsArgs): Promise<ToolResult> {
    // ── URL 匹配关闭（原 close_tabs 语义：不含结尾斜杠按前缀组匹配） ──
    if (args.url !== undefined) {
      let urlPattern = args.url;
      if (!urlPattern.endsWith('/')) {
        urlPattern += '/*';
      }
      const tabs = await chrome.tabs.query({ url: urlPattern });

      if (!tabs || tabs.length === 0) {
        return this.createSuccessResponse({
          closedCount: 0,
          closedTabIds: [],
        }, `No tabs found with URL: ${args.url}`);
      }

      const tabIdsToClose = tabs
        .map((tab) => tab.id)
        .filter((id): id is number => id !== undefined);

      if (tabIdsToClose.length === 0) {
        return this.createErrorResponse('Found tabs but could not get their IDs');
      }

      const { closed, failed } = await this.removeTabsResilient(tabIdsToClose);
      if (closed.length === 0) {
        return this.createErrorResponse(
          `匹配 URL 的标签页全部关闭失败：${this.formatFailures(failed)}`,
        );
      }
      return this.createSuccessResponse(
        {
          closedCount: closed.length,
          closedTabIds: closed,
          ...(failed.length > 0
            ? { failedTabIds: failed.map(item => item.tabId), failureReasons: failed }
            : {}),
        },
        `Closed ${closed.length} tabs with URL: ${args.url}` +
          (failed.length > 0 ? `；${failed.length} 个关闭失败（${this.formatFailures(failed)}）` : ''),
      );
    }

    // ── 批量关闭（原 close_tabs 语义：逐个核验，报告不存在的 ID） ──
    if (args.tabIds !== undefined) {
      const existingTabs = await Promise.all(
        args.tabIds.map(async (tabId) => {
          try {
            const tab = await chrome.tabs.get(tabId);
            return tab ?? null;
          } catch {
            this.log(`Tab with ID ${tabId} not found`, 'warn');
            return null;
          }
        }),
      );

      const validTabIds = existingTabs
        .filter((tab): tab is chrome.tabs.Tab => tab !== null)
        .map((tab) => tab.id)
        .filter((id): id is number => id !== undefined);
      const invalidTabIds = args.tabIds.filter((id) => !validTabIds.includes(id));

      if (validTabIds.length === 0) {
        return this.createSuccessResponse({
          closedCount: 0,
          closedTabIds: [],
          invalidTabIds,
        }, 'None of the provided tab IDs exist');
      }

      const { closed, failed } = await this.removeTabsResilient(validTabIds);
      if (closed.length === 0) {
        // 存在性核验通过却全部关闭失败 → 异常态势，按失败返回可分析明细
        return this.createErrorResponse(
          `标签页关闭失败：${this.formatFailures(failed)}`,
        );
      }
      return this.createSuccessResponse(
        {
          closedCount: closed.length,
          closedTabIds: closed,
          invalidTabIds,
          ...(failed.length > 0
            ? { failedTabIds: failed.map(item => item.tabId), failureReasons: failed }
            : {}),
        },
        `Closed ${closed.length} tabs` +
          (invalidTabIds.length > 0 ? `，${invalidTabIds.length} 个 id 不存在` : '') +
          (failed.length > 0 ? `，${failed.length} 个关闭失败（${this.formatFailures(failed)}）` : ''),
      );
    }

    // ── 单个关闭（原 close_tab 语义：先核验存在性，给出可读错误而非 chrome 裸错） ──
    if (args.tabId !== undefined) {
      let existing: chrome.tabs.Tab | undefined;
      try {
        existing = await chrome.tabs.get(args.tabId);
      } catch {
        existing = undefined;
      }
      if (!existing) {
        return this.createErrorResponse(`标签页 ${args.tabId} 不存在（可能已关闭），请用 action="list" 核对`);
      }
      const { closed, failed } = await this.removeTabsResilient([args.tabId]);
      if (closed.length === 0) {
        return this.createErrorResponse(`标签页 ${args.tabId} 关闭失败：${failed[0]?.reason ?? '未知原因'}`);
      }
      return this.createSuccessResponse({
        tabId: args.tabId,
        closedCount: 1,
        closedTabIds: [args.tabId],
      }, 'Tab closed successfully');
    }

    // ── 缺省：关闭当前活动标签（原 close_tabs 的兜底行为） ──
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!activeTab || !activeTab.id) {
      return this.createErrorResponse('No active tab found');
    }

    const { closed, failed } = await this.removeTabsResilient([activeTab.id]);
    if (closed.length === 0) {
      return this.createErrorResponse(`关闭当前活动标签失败：${failed[0]?.reason ?? '未知原因'}`);
    }
    return this.createSuccessResponse({
      closedCount: 1,
      closedTabIds: [activeTab.id],
    }, 'Closed active tab');
  }

  /** create：新建标签页（原 create_tab 语义 + 激活时聚焦窗口） */
  private async handleCreate(args: TabsArgs, context?: ToolExecutionContext): Promise<ToolResult> {
    const active = args.active !== false;
    const windowId = await existingNavigationWindowId();
    const tab = await chrome.tabs.create({
      windowId,
      url: args.url,
      active,
    });
    // 防御：create 正常必返有效 id——取不到说明底层创建异常，不返回半残载荷
    if (typeof tab.id !== 'number') {
      return this.createErrorResponse('新建标签页未返回有效 id（浏览器拒绝了本次创建），请用 action="list" 核对现状');
    }

    if (!active) context?.onTabTarget?.(tab.id);
    // 激活的新标签要让用户看见（与 browser_navigation 的窗口聚焦边界一致）；
    // 后台打开（active=false）刻意不聚焦，不打断用户当前视线
    if (active) {
      try {
        await chrome.windows.update(windowId, { focused: true });
      } catch {
        // 聚焦失败（窗口最小化 / API 不可用）不阻断创建结果
      }
    }

    return this.createSuccessResponse({
      tabId: tab.id,
      url: tab.url,
      windowId: tab.windowId,
    }, 'Tab created successfully');
  }

  /** windows：窗口树枚举（原 browser_window 语义） */
  private async handleWindows(): Promise<ToolResult> {
    const windows = await chrome.windows.getAll({ populate: true });
    let tabCount = 0;

    const structuredWindows = windows.map((window) => {
      const tabs =
        window.tabs?.map((tab) => {
          tabCount++;
          return {
            tabId: tab.id || 0,
            url: tab.url || '',
            title: tab.title || '',
            active: tab.active || false,
          };
        }) || [];

      return {
        windowId: window.id || 0,
        tabs: tabs,
      };
    });

    return this.createSuccessResponse({
      windowCount: windows.length,
      tabCount: tabCount,
      windows: structuredWindows,
    }, `Found ${windows.length} windows with ${tabCount} tabs`);
  }
}

// 导出工具实例
export const browserTabsTool = new BrowserTabsTool();

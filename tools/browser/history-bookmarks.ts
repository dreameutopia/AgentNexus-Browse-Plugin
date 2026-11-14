/**
 * 统一浏览历史与书签工具（browser_history_bookmarks）
 *
 * 本工具把「我访问过 / 我收藏过的页面」这一整个域收敛为**一个工具 + 九个
 * action**（项目未发布，无兼容别名，旧名全部删除）：
 *   - search   关键词检索历史与书签（可限定来源 / 时间窗 / 排序，唯一命中可自动打开）
 *   - open     打开某条历史或书签（按 url 或 id 定位，复用 browser_navigation）
 *   - create   新增书签 / 新建书签文件夹
 *   - update   修改或移动书签（标题 / 地址 / 父目录）
 *   - delete   删除书签（按 id 或 url；文件夹连同其下书签一并删除）
 *   - clear    清理浏览历史（时间窗或 all；不可逆，需人审门）
 *   - recent   最近访问的页面（无需关键词，「我今天看了什么」）
 *   - top      最常访问站点榜（chrome.history.getMostVisited）
 *   - folders  书签文件夹结构（id / 路径 / 条目数，配合 update 的 parentId 移动）
 *
 * 合并掉的旧工具（**旧名全仓禁绝**，防回潮断言见 tests/tools/tools.test.ts）：
 *   - quick_navigation（常用站点硬编码跳转表）——删除后不影响能力：
 *     browser_navigation(action="open") 直接接受任意完整 URL，站点地址由模型
 *     自己给出即可，硬编码表只省一次查表。
 *   - history_navigation / bookmark_navigation（检索 + 单命中自动跳转）
 *   - browser_search_history / browser_search_bookmarks（纯检索）
 *   - browser_bookmark_create / browser_bookmark_delete（书签增删）
 *
 * 相对旧工具**扩展**的能力边界（旧能力一行未减）：
 *   1. 一次检索同时覆盖历史与书签，同 URL 自动合并成一条（source 标 both），
 *      并带上所属书签文件夹路径；
 *   2. 时间窗支持 "today" / "3 days ago" / "2w" / ISO 日期 / 毫秒时间戳五形态
 *      （旧检索工具只认其中一两种）；
 *   3. 排序新增 recent / visited（最常访问、最后访问）；
 *   4. 新增 recent（时间倒序浏览记录）与 top（最常访问站点榜）两个只读视角；
 *   5. 新增 update（改标题 / 改地址 / 移到别的文件夹）——旧工具只能增删不能改；
 *   6. 新增 folders（书签目录结构）——移动书签需要知道目标文件夹 id；
 *   7. 检索结果附带 id，后续 open / update / delete 可精确寻址，不必再猜 URL；
 *   8. 新增 clear（清理浏览历史）——此前整个扩展没有清理历史的入口；
 *      不可逆，故必须显式给范围（或 all=true）且走人审门。
 *
 * 分层（便于维护与扩展，改动只落在对应层）：
 *   - 本文件：工具契约 + 参数矩阵 + 动作编排 + 导航委托；
 *   - ./history-bookmarks-data.ts：纯函数（时间表达式、条目合并/排序、错误描述）；
 *   - ./history-bookmarks-bookmarks.ts：chrome.bookmarks 访问层（书签树/定位/目录）。
 *
 * 执行上下文：chrome.history / chrome.bookmarks 只在 background 服务工作
 * 器可用，因此本工具与 browser_* 家族一致地先调 ensureBackgroundContext()；
 * 非 background 上下文抛出的错误由 tool-executor 识别并把整次调用转发到
 * background 执行（错误文案必须含 "background context"，不得在组合工具内部
 * 吞掉——否则转发永远不触发）。这是协议信号，不是失败；除此之外本工具
 * **不向调用方抛出任何异常**：每个 action 的失败都以带精准原因的结果返回。
 *
 * 导航复用：open 与 search(autoOpen) 一律委托 browser_navigation(action="open")，
 * 因此同址标签页复用、全局导航锁、加载就绪等待与 loadStatus 回报与浏览器
 * 其它导航路径完全一致，本工具不自造第二套导航语义。
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata, type ToolExecutionContext, toolRegistry } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';
import {
  checkActionMatrix,
  readBooleanField,
  readNonEmptyStringField,
  readNumberField,
} from './action-args';
import {
  DAY_MS,
  HISTORY_BOOKMARK_SORTS,
  HISTORY_BOOKMARK_SOURCES,
  describeError,
  mergeRecallItems,
  readTimeField,
  sortRecallItems,
  type Field,
  type HistoryBookmarkSort,
  type HistoryBookmarkSource,
  type RecallItem,
} from './history-bookmarks-data';
import {
  collectBookmarkFolders,
  findBookmarkById,
  findBookmarksByUrl,
  loadBookmarkTree,
} from './history-bookmarks-bookmarks';

/** 九个 action（schema 枚举与运行期校验同源） */
export const HISTORY_BOOKMARK_ACTIONS = [
  'search',
  'open',
  'create',
  'update',
  'delete',
  'clear',
  'recent',
  'top',
  'folders',
] as const;
export type HistoryBookmarkAction = (typeof HISTORY_BOOKMARK_ACTIONS)[number];

/** 每个 action 允许出现的参数（运行期矩阵，防拼写错误与张冠李戴静默失效） */
const ACTION_PARAMS: Record<HistoryBookmarkAction, readonly string[]> = {
  search: ['query', 'source', 'since', 'until', 'limit', 'sort', 'excludeCurrentTabs', 'autoOpen'],
  open: ['url', 'id', 'source', 'newTab', 'waitForLoad', 'timeout'],
  create: ['url', 'title', 'parentId', 'folder'],
  update: ['bookmarkId', 'url', 'title', 'parentId'],
  delete: ['bookmarkId', 'url'],
  clear: ['since', 'until', 'all'],
  recent: ['limit', 'since', 'until'],
  top: ['limit'],
  folders: ['parentId'],
};

/** 默认与上限（限流 + 载荷有界的双重护栏） */
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_RECENT_LIMIT = 50;
const DEFAULT_TOP_LIMIT = 10;
const MAX_LIMIT = 100;
/** 检索时为支持排序而多取的条目倍数（上限有界，避免一次拉爆历史库） */
const SORT_FETCH_FACTOR = 3;
const MAX_SORT_FETCH = 500;
/** 历史默认检索窗口（天） */
const DEFAULT_SEARCH_WINDOW_DAYS = 30;
/** recent 默认检索窗口（天） */
const DEFAULT_RECENT_WINDOW_DAYS = 7;
/** open 按 id 反查历史时的扫描上限（有界扫描，超出即要求改用 url） */
const HISTORY_ID_SCAN_LIMIT = 500;
/** 书签栏 id（chrome.bookmarks 的约定值：1 = 书签栏） */
const DEFAULT_BOOKMARK_PARENT_ID = '1';

interface HistoryBookmarkArgs {
  action: HistoryBookmarkAction;
  query?: string;
  source?: HistoryBookmarkSource;
  since?: number;
  until?: number;
  limit?: number;
  sort?: HistoryBookmarkSort;
  excludeCurrentTabs?: boolean;
  autoOpen?: boolean;
  url?: string;
  id?: string;
  newTab?: boolean;
  waitForLoad?: boolean;
  timeout?: number;
  title?: string;
  parentId?: string;
  folder?: boolean;
  bookmarkId?: string;
  all?: boolean;
}

type ValidationResult = { error: ToolResult; args?: never } | { error?: never; args: HistoryBookmarkArgs };

/** chrome.history 不可用时的统一原因（权限 / 上下文缺失） */
function requireHistoryApi(): typeof chrome.history {
  const api = chrome.history;
  if (!api) {
    throw new Error(
      'chrome.history 不可用：历史 API 只在扩展 background 上下文可用（需 manifest 声明 history 权限）',
    );
  }
  return api;
}

/**
 * 统一浏览历史与书签工具
 */
export class BrowserHistoryBookmarksTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.HISTORY_BOOKMARKS;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.HISTORY_BOOKMARKS,
    description: '浏览历史与书签统一管理：检索/打开/增删改/清理历史/最近访问/最常访问/文件夹结构（action 驱动）',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'history', 'bookmark', 'navigation', 'chrome'],
    permissions: ['history', 'bookmarks'],
    // 删除书签 / 清理浏览历史都是不可逆的用户数据操作（与 note_tool 的 delete
    // 同一口径）：命中这两个 action 需用户放行，其余 action 直接执行。
    requiresApprovalActions: ['delete', 'clear'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.HISTORY_BOOKMARKS,
      description:
        '浏览历史与书签的统一入口，action 九选一：' +
        'search=按关键词检索历史与书签（source=history/bookmark/both，默认 both：历史与书签同 URL 自动合并成一条并标注来源；' +
        'since/until 限时间窗，支持 "today"/"yesterday"/"3 days ago"/"2w"/ISO 日期/毫秒时间戳；sort=relevance/recent/visited；' +
        'autoOpen=true 且唯一命中时直接打开该页面，省一次往返）；' +
        'open=打开某条历史或书签（url 直接给地址，或 id+source 指定条目；新标签页打开并等待页面就绪，复用 browser_navigation 的同址标签复用与加载等待）；' +
        'create=新增书签（url 必填、title 可选、parentId 缺省为书签栏）或新建文件夹（folder=true，只需 title）；' +
        'update=修改或移动书签（bookmarkId 或 url 定位，title/url/parentId 至少给一项；parentId 可把书签移到别的文件夹）；' +
        'delete=删除书签（bookmarkId 或 url 二选一；删文件夹会连同其下书签一并删除——破坏性操作需用户批准）；' +
        'clear=清理浏览历史（since 给时间窗起点，或 all=true 清空全部——不可逆，需用户批准）；' +
        'recent=最近访问的页面（无需关键词，按时间倒序，适合"我今天/最近看过什么"）；' +
        'top=最常访问站点榜；' +
        'folders=书签文件夹结构（id/标题/路径/条目数，配合 update 的 parentId 把书签搬到目标文件夹）。' +
        '只有书签可增删改，历史只读（历史仅能清理）；检索条目带 id，后续 open/update/delete 可精确寻址不必再猜 URL。' +
        '需要页面正文用 browser_get_page_text，本工具只管历史与书签本身。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: [...HISTORY_BOOKMARK_ACTIONS],
            description:
              'search=检索；open=打开；create=新增书签/文件夹；update=改/移书签；delete=删书签；clear=清理浏览历史；recent=最近访问；top=最常访问；folders=文件夹结构',
          },
          query: {
            type: 'string',
            description: '仅 action="search"：关键词（匹配标题或 URL，留空则取全部/最近条目）',
          },
          source: {
            type: 'string',
            enum: [...HISTORY_BOOKMARK_SOURCES],
            description:
              '仅 action="search"/"open"：检索来源 history=浏览历史、bookmark=书签、both=两者（默认 both，同 URL 合并）；open 时用于区分 id 的命名空间',
          },
          since: {
            type: 'string',
            description:
              '仅 action="search"/"recent"/"clear"：时间窗起点（"today"/"3 days ago"/"2w"/ISO/毫秒时间戳；search 默认最近 30 天，recent 默认最近 7 天）',
          },
          until: {
            type: 'string',
            description: '仅 action="search"/"recent"/"clear"：时间窗终点（缺省为现在）',
          },
          limit: {
            type: 'number',
            description: `仅 action="search"/"recent"/"top"：返回条数上限（1~${MAX_LIMIT}；search 默认 ${DEFAULT_SEARCH_LIMIT}，recent 默认 ${DEFAULT_RECENT_LIMIT}，top 默认 ${DEFAULT_TOP_LIMIT}）`,
          },
          sort: {
            type: 'string',
            enum: [...HISTORY_BOOKMARK_SORTS],
            description:
              '仅 action="search"：relevance=相关度（默认）、recent=最后访问优先、visited=访问次数优先（书签无访问次数，按收藏时间）',
          },
          excludeCurrentTabs: {
            type: 'boolean',
            description: '仅 action="search"：是否排除当前已打开的标签页地址（默认 false）',
          },
          autoOpen: {
            type: 'boolean',
            description: '仅 action="search"：唯一命中时是否直接打开该页面（默认 false；命中多条时不打开）',
          },
          url: {
            type: 'string',
            description:
              'action="open"：要打开的完整地址；action="create"：新书签地址；action="update"/"delete"：按地址定位已有书签',
          },
          id: {
            type: 'string',
            description: '仅 action="open"：条目 id（来自 search/recent/top 的结果；配合 source 区分历史 id 与书签 id）',
          },
          newTab: {
            type: 'boolean',
            default: true,
            description: '仅 action="open"：是否在现有窗口新建标签页（默认 true；false 只导航当前标签页）',
          },
          waitForLoad: {
            type: 'boolean',
            default: true,
            description: '仅 action="open"：是否等待页面就绪再返回（默认 true）',
          },
          timeout: {
            type: 'number',
            description: '仅 action="open"：等待页面就绪的上限（毫秒，缺省 30000）',
          },
          title: {
            type: 'string',
            description:
              'action="create"：书签标题（缺省用 URL；folder=true 时为文件夹名，必填）；action="update"：新标题',
          },
          parentId: {
            type: 'string',
            description:
              'action="create"：父文件夹 id（缺省 "1" = 书签栏）；action="update"：移到该文件夹下；action="folders"：只列该文件夹子树',
          },
          folder: {
            type: 'boolean',
            description: '仅 action="create"：true=新建文件夹（此时只需 title，不能带 url）',
          },
          bookmarkId: {
            type: 'string',
            description: 'action="update"/"delete"：书签 id（来自 search/folders 的结果，精确寻址）',
          },
          all: {
            type: 'boolean',
            description:
              '仅 action="clear"：true=清空全部浏览历史（不可逆，需用户批准）；否则必须给 since 指定时间窗',
          },
        },
        required: ['action'],
      },
    },
  };

  async execute(rawArgs: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    // chrome.history / chrome.bookmarks 只在 background 可用——非 background
    // 上下文必须抛出含 "background context" 的错误，让 tool-executor 把整次
    // 调用转发到 background；此处的错误不得在方法内部被吞成普通失败结果。
    this.ensureBackgroundContext();

    const validated = this.validate(rawArgs);
    if (validated.error) return validated.error;
    const args = validated.args;

    // 每个 action 独立包裹：任何失败都以带精准原因的结果返回，绝不把异常抛给调用方
    switch (args.action) {
      case 'search':
        return await this.guard('检索历史与书签', () => this.handleSearch(args, context));
      case 'open':
        return await this.guard('打开历史/书签条目', () => this.handleOpen(args, context));
      case 'create':
        return await this.guard('新增书签/文件夹', () => this.handleCreate(args));
      case 'update':
        return await this.guard('更新书签', () => this.handleUpdate(args));
      case 'delete':
        return await this.guard('删除书签', () => this.handleDelete(args));
      case 'clear':
        return await this.guard('清理浏览历史', () => this.handleClear(args));
      case 'recent':
        return await this.guard('读取最近访问', () => this.handleRecent(args));
      case 'top':
        return await this.guard('读取最常访问', () => this.handleTop(args));
      case 'folders':
        return await this.guard('读取书签文件夹', () => this.handleFolders(args));
    }
  }

  /** 动作级错误收口：把任何异常转成带原因说明的失败结果 */
  private async guard(label: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return await run();
    } catch (error) {
      return this.createErrorResponse(`${label}失败：${describeError(error)}`);
    }
  }

  // ──── 参数校验（共享矩阵 + 字段读取，见 ./action-args.ts） ────

  private validate(rawArgs: unknown): ValidationResult {
    const matrix = checkActionMatrix<HistoryBookmarkAction>(rawArgs, {
      actions: HISTORY_BOOKMARK_ACTIONS,
      params: ACTION_PARAMS,
    });
    if (!matrix.ok) return { error: this.createErrorResponse(matrix.error) };
    const { action, input } = matrix;

    const args: HistoryBookmarkArgs = { action };

    const query = readNonEmptyStringField(input, 'query');
    if (!query.ok) return { error: this.createErrorResponse(query.error) };
    if (query.value !== undefined) args.query = query.value;

    if (input.source !== undefined) {
      const source = input.source;
      if (typeof source !== 'string' || !(HISTORY_BOOKMARK_SOURCES as readonly string[]).includes(source)) {
        return {
          error: this.createErrorResponse(
            `source 必须是 ${HISTORY_BOOKMARK_SOURCES.map(s => `"${s}"`).join('/')} 之一，实际收到 ${JSON.stringify(source ?? null)}`,
          ),
        };
      }
      args.source = source as HistoryBookmarkSource;
    }

    if (input.sort !== undefined) {
      const sort = input.sort;
      if (typeof sort !== 'string' || !(HISTORY_BOOKMARK_SORTS as readonly string[]).includes(sort)) {
        return {
          error: this.createErrorResponse(
            `sort 必须是 ${HISTORY_BOOKMARK_SORTS.map(s => `"${s}"`).join('/')} 之一，实际收到 ${JSON.stringify(sort ?? null)}`,
          ),
        };
      }
      args.sort = sort as HistoryBookmarkSort;
    }

    const since: Field<number> = readTimeField(input, 'since', { isStart: true });
    if (!since.ok) return { error: this.createErrorResponse(since.error) };
    if (since.value !== undefined) args.since = since.value;

    const until: Field<number> = readTimeField(input, 'until', { isStart: false });
    if (!until.ok) return { error: this.createErrorResponse(until.error) };
    if (until.value !== undefined) args.until = until.value;

    const limit = readNumberField(input, 'limit', { min: 1, max: MAX_LIMIT, integer: true });
    if (!limit.ok) return { error: this.createErrorResponse(limit.error) };
    if (limit.value !== undefined) args.limit = limit.value;

    for (const key of ['excludeCurrentTabs', 'autoOpen', 'folder', 'newTab', 'waitForLoad', 'all'] as const) {
      const field = readBooleanField(input, key);
      if (!field.ok) return { error: this.createErrorResponse(field.error) };
      if (field.value !== undefined) args[key] = field.value;
    }

    const timeout = readNumberField(input, 'timeout', { min: 1, integer: true });
    if (!timeout.ok) return { error: this.createErrorResponse(timeout.error) };
    if (timeout.value !== undefined) args.timeout = timeout.value;

    for (const key of ['url', 'id', 'title', 'parentId', 'bookmarkId'] as const) {
      const field = readNonEmptyStringField(input, key);
      if (!field.ok) return { error: this.createErrorResponse(field.error) };
      if (field.value !== undefined) args[key] = field.value;
    }

    // ── action 级必填与互斥 ──
    switch (action) {
      case 'open': {
        if (args.url === undefined && args.id === undefined) {
          return { error: this.createErrorResponse('action="open" 需要 url 或 id 之一（id 来自 search/recent/top 的结果）') };
        }
        break;
      }
      case 'create': {
        if (args.folder === true) {
          if (args.url !== undefined) {
            return { error: this.createErrorResponse('action="create" folder=true 时不能带 url（新建文件夹不需要地址）') };
          }
          if (!args.title) {
            return { error: this.createErrorResponse('action="create" folder=true 时需要 title（文件夹名）') };
          }
        } else if (!args.url) {
          return { error: this.createErrorResponse('action="create" 需要 url（新建书签的地址）；要建文件夹请传 folder=true + title') };
        }
        break;
      }
      case 'update': {
        if (args.bookmarkId === undefined && args.url === undefined) {
          return { error: this.createErrorResponse('action="update" 需要 bookmarkId 或 url 之一（用于定位要改的书签）') };
        }
        if (args.bookmarkId !== undefined && args.url !== undefined) {
          return { error: this.createErrorResponse('action="update" 的 bookmarkId 与 url 两种定位方式互斥（同时给出会改错书签）') };
        }
        if (args.title === undefined && args.url === undefined && args.parentId === undefined) {
          return { error: this.createErrorResponse('action="update" 至少要改一项：title（新标题）/ url（新地址）/ parentId（移到别的文件夹）') };
        }
        break;
      }
      case 'delete': {
        if (args.bookmarkId === undefined && args.url === undefined) {
          return { error: this.createErrorResponse('action="delete" 需要 bookmarkId 或 url 之一（要删哪个书签）') };
        }
        if (args.bookmarkId !== undefined && args.url !== undefined) {
          return { error: this.createErrorResponse('action="delete" 的 bookmarkId 与 url 两种定位方式互斥（同时给出会删错书签）') };
        }
        break;
      }
      case 'clear': {
        // 清理浏览历史是不可逆的用户数据破坏：必须显式给范围（或显式 all=true），
        // 不允许「一句清空」式的模糊调用；执行还需经人审门（见 metadata）。
        if (args.all !== true && args.since === undefined) {
          return {
            error: this.createErrorResponse(
              'action="clear" 必须给出清理范围：since（时间窗起点，如 "7 days ago"）或显式 all=true（清空全部历史）',
            ),
          };
        }
        break;
      }
      default:
        break;
    }

    return { args };
  }

  // ──── action 实现 ────

  /** search：关键词检索历史与书签（同 URL 合并） */
  private async handleSearch(args: HistoryBookmarkArgs, context?: ToolExecutionContext): Promise<ToolResult> {
    const source = args.source ?? 'both';
    const query = args.query ?? '';
    const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;
    const sort = args.sort ?? 'relevance';
    const now = Date.now();
    const since = args.since ?? now - DEFAULT_SEARCH_WINDOW_DAYS * DAY_MS;
    const until = args.until ?? now;

    if (since > until) {
      return this.createErrorResponse(
        `时间窗无效：since(${new Date(since).toISOString()}) 晚于 until(${new Date(until).toISOString()})`,
      );
    }

    const items: RecallItem[] = [];
    if (source === 'history' || source === 'both') {
      items.push(...(await this.searchHistory(query, since, until, limit, args.excludeCurrentTabs === true)));
    }
    if (source === 'bookmark' || source === 'both') {
      items.push(...(await this.searchBookmarks(query, limit)));
    }

    const merged = mergeRecallItems(items);
    const sorted = sortRecallItems(merged, sort);
    const page = sorted.slice(0, limit);

    const payload: Record<string, unknown> = {
      source,
      query,
      sort,
      count: page.length,
      totalFound: merged.length,
      timeRange: {
        startTime: since,
        startTimeIso: new Date(since).toISOString(),
        endTime: until,
        endTimeIso: new Date(until).toISOString(),
      },
      items: page,
    };

    // autoOpen：唯一命中时直接打开（替代旧工具「单命中自动跳转」）
    if (args.autoOpen === true) {
      if (page.length === 1) {
        const opened = await this.openUrl(page[0].url, args.newTab ?? true, args.waitForLoad ?? true, args.timeout, context);
        if (!opened.success) return opened;
        payload.opened = opened.data;
        return this.createSuccessResponse(payload, `命中 1 条，已打开：${page[0].title || page[0].url}`);
      }
      payload.opened = null;
      payload.note =
        page.length === 0
          ? '没有命中任何条目（autoOpen 仅在唯一命中时生效）'
          : `命中 ${page.length} 条，autoOpen 仅在唯一命中时生效——请用 action="open" 配合 id/url 精确打开`;
      return this.createSuccessResponse(payload, payload.note as string);
    }

    return this.createSuccessResponse(payload, `命中 ${page.length} 条（总匹配 ${merged.length} 条）`);
  }

  /** open：打开某条历史或书签（url 或 id 定位） */
  private async handleOpen(args: HistoryBookmarkArgs, context?: ToolExecutionContext): Promise<ToolResult> {
    let targetUrl = args.url;
    let resolved: { url: string; title?: string; source?: 'history' | 'bookmark' } | undefined;

    if (!targetUrl) {
      const lookup = await this.resolveById(args.id!, args.source);
      if (!lookup.ok) return lookup.error;
      targetUrl = lookup.url;
      resolved = { url: lookup.url, title: lookup.title, source: lookup.source };
    }

    const opened = await this.openUrl(targetUrl, args.newTab ?? true, args.waitForLoad ?? true, args.timeout, context);
    if (!opened.success) return opened;

    return this.createSuccessResponse(
      {
        ...(opened.data as Record<string, unknown>),
        requestedUrl: targetUrl,
        ...(resolved ? { resolved } : {}),
      },
      `已打开：${targetUrl}`,
    );
  }

  /** create：新增书签或新建文件夹 */
  private async handleCreate(args: HistoryBookmarkArgs): Promise<ToolResult> {
    const parentId = args.parentId ?? DEFAULT_BOOKMARK_PARENT_ID;

    if (args.folder === true) {
      const folder = await chrome.bookmarks.create({ parentId, title: args.title! });
      return this.createSuccessResponse(
        {
          id: folder.id,
          title: folder.title,
          parentId: folder.parentId,
          isFolder: true,
        },
        `已创建文件夹「${folder.title}」`,
      );
    }

    const title = args.title ?? args.url!;
    const bookmark = await chrome.bookmarks.create({ parentId, title, url: args.url! });
    return this.createSuccessResponse(
      {
        id: bookmark.id,
        title: bookmark.title,
        url: bookmark.url,
        parentId: bookmark.parentId,
        dateAdded: bookmark.dateAdded,
        isFolder: false,
      },
      `已收藏「${bookmark.title}」`,
    );
  }

  /** update：修改或移动书签 */
  private async handleUpdate(args: HistoryBookmarkArgs): Promise<ToolResult> {
    const located = await this.locateBookmark(args.bookmarkId, args.url);
    if (!located.ok) return located.error;

    const changes: { title?: string; url?: string; parentId?: string } = {};
    if (args.title !== undefined) changes.title = args.title;
    if (args.url !== undefined) changes.url = args.url;
    if (args.parentId !== undefined) changes.parentId = args.parentId;

    const updated = await chrome.bookmarks.update(located.id, changes);
    return this.createSuccessResponse(
      {
        id: updated.id,
        title: updated.title,
        url: updated.url,
        parentId: updated.parentId,
        updatedFields: Object.keys(changes),
      },
      `已更新书签「${updated.title}」（${Object.keys(changes).join('/')}）`,
    );
  }

  /** delete：删除书签（按 id 或 url；文件夹连同其下书签一并删除） */
  private async handleDelete(args: HistoryBookmarkArgs): Promise<ToolResult> {
    if (args.bookmarkId !== undefined) {
      await chrome.bookmarks.remove(args.bookmarkId);
      return this.createSuccessResponse(
        { deletedIds: [args.bookmarkId], deletedCount: 1 },
        `已删除书签（id=${args.bookmarkId}）`,
      );
    }

    const matches = await findBookmarksByUrl(args.url!);
    if (matches.length === 0) {
      return this.createErrorResponse(`没有找到地址为 ${args.url} 的书签（可能已被删除或地址不完全一致）`);
    }
    const deletedIds: string[] = [];
    for (const match of matches) {
      await chrome.bookmarks.remove(match.id);
      deletedIds.push(match.id);
    }
    return this.createSuccessResponse(
      { deletedIds, deletedCount: deletedIds.length, url: args.url },
      `已删除 ${deletedIds.length} 个书签（地址 ${args.url}）`,
    );
  }

  /** clear：清理浏览历史（不可逆，需人审门；范围必须显式给出） */
  private async handleClear(args: HistoryBookmarkArgs): Promise<ToolResult> {
    const now = Date.now();
    const all = args.all === true;
    const startTime = all ? 0 : args.since!;
    const endTime = args.until ?? now;

    if (startTime > endTime) {
      return this.createErrorResponse(
        `时间窗无效：since(${new Date(startTime).toISOString()}) 晚于 until(${new Date(endTime).toISOString()})`,
      );
    }

    await requireHistoryApi().deleteRange({ startTime, endTime });

    return this.createSuccessResponse(
      {
        scope: all ? 'all' : 'range',
        startTime,
        startTimeIso: new Date(startTime).toISOString(),
        endTime,
        endTimeIso: new Date(endTime).toISOString(),
        deleted: true,
      },
      all ? '已清空浏览历史' : `已清理 ${new Date(startTime).toISOString()} 起的浏览历史`,
    );
  }

  /** recent：最近访问的页面（按时间倒序） */
  private async handleRecent(args: HistoryBookmarkArgs): Promise<ToolResult> {
    const limit = args.limit ?? DEFAULT_RECENT_LIMIT;
    const now = Date.now();
    const since = args.since ?? now - DEFAULT_RECENT_WINDOW_DAYS * DAY_MS;
    const until = args.until ?? now;

    if (since > until) {
      return this.createErrorResponse(
        `时间窗无效：since(${new Date(since).toISOString()}) 晚于 until(${new Date(until).toISOString()})`,
      );
    }

    const raw = await requireHistoryApi().search({
      text: '',
      startTime: since,
      endTime: until,
      maxResults: Math.min(MAX_SORT_FETCH, Math.max(limit, limit * 2)),
    });

    const items: RecallItem[] = raw
      .filter(item => !!item.url)
      .sort((a, b) => (b.lastVisitTime ?? 0) - (a.lastVisitTime ?? 0))
      .slice(0, limit)
      .map(item => ({
        url: item.url!,
        title: item.title ?? item.url!,
        source: 'history' as const,
        historyId: item.id,
        lastVisitTime: item.lastVisitTime,
        lastVisitIso: item.lastVisitTime ? new Date(item.lastVisitTime).toISOString() : undefined,
        visitCount: item.visitCount,
      }));

    return this.createSuccessResponse(
      {
        count: items.length,
        totalFound: raw.length,
        timeRange: {
          startTime: since,
          startTimeIso: new Date(since).toISOString(),
          endTime: until,
          endTimeIso: new Date(until).toISOString(),
        },
        items,
      },
      `最近访问 ${items.length} 条`,
    );
  }

  /** top：最常访问站点榜 */
  private async handleTop(args: HistoryBookmarkArgs): Promise<ToolResult> {
    const limit = args.limit ?? DEFAULT_TOP_LIMIT;
    const historyApi = requireHistoryApi() as typeof chrome.history & {
      getMostVisited?: (options: { maxResults: number }) => Promise<Array<{ url?: string; title?: string; visitCount?: number }>>;
    };

    // chrome.history.getMostVisited 是 Chromium 专有 API（Firefox 无此接口）：
    // 有则用宿主榜单，没有则回退为「按访问次数排序的检索结果」，两条路径都
    // 如实回传 ranking 来源，模型不会把回退结果误当成宿主榜单。
    if (typeof historyApi.getMostVisited === 'function') {
      const visited = await historyApi.getMostVisited({ maxResults: limit });
      const items: RecallItem[] = visited
        .filter(item => !!item.url)
        .map(item => ({
          url: item.url!,
          title: item.title ?? item.url!,
          source: 'history' as const,
          visitCount: item.visitCount,
        }));
      return this.createSuccessResponse(
        { ranking: 'getMostVisited', count: items.length, items },
        `最常访问 ${items.length} 个站点`,
      );
    }

    const raw = await historyApi.search({
      text: '',
      startTime: 0,
      endTime: Date.now(),
      maxResults: MAX_SORT_FETCH,
    });
    const items: RecallItem[] = raw
      .filter(item => !!item.url)
      .sort((a, b) => (b.visitCount ?? 0) - (a.visitCount ?? 0))
      .slice(0, limit)
      .map(item => ({
        url: item.url!,
        title: item.title ?? item.url!,
        source: 'history' as const,
        historyId: item.id,
        visitCount: item.visitCount,
        lastVisitTime: item.lastVisitTime,
        lastVisitIso: item.lastVisitTime ? new Date(item.lastVisitTime).toISOString() : undefined,
      }));
    return this.createSuccessResponse(
      { ranking: 'search-by-visit-count', count: items.length, items },
      `最常访问 ${items.length} 个站点（按访问次数排序）`,
    );
  }

  /** folders：书签文件夹结构 */
  private async handleFolders(args: HistoryBookmarkArgs): Promise<ToolResult> {
    const folders = await collectBookmarkFolders(args.parentId);
    return this.createSuccessResponse(
      { scope: args.parentId ? 'subtree' : 'all', parentId: args.parentId ?? null, count: folders.length, folders },
      `书签文件夹 ${folders.length} 个`,
    );
  }

  // ──── 检索与定位的内部实现 ────

  /** 历史检索（时间窗 + 关键词 + 可排除当前标签页） */
  private async searchHistory(
    query: string,
    since: number,
    until: number,
    limit: number,
    excludeCurrentTabs: boolean,
  ): Promise<RecallItem[]> {
    const raw = await requireHistoryApi().search({
      text: query,
      startTime: since,
      endTime: until,
      maxResults: Math.min(MAX_SORT_FETCH, Math.max(limit, limit * SORT_FETCH_FACTOR)),
    });

    let items = raw.filter(item => !!item.url);

    if (excludeCurrentTabs && items.length > 0) {
      const tabs = await chrome.tabs.query({});
      const openUrls = new Set(tabs.map(tab => tab.url).filter(Boolean) as string[]);
      items = items.filter(item => !item.url || !openUrls.has(item.url));
    }

    return items.map(item => ({
      url: item.url!,
      title: item.title ?? item.url!,
      source: 'history' as const,
      historyId: item.id,
      lastVisitTime: item.lastVisitTime,
      lastVisitIso: item.lastVisitTime ? new Date(item.lastVisitTime).toISOString() : undefined,
      visitCount: item.visitCount,
    }));
  }

  /** 书签检索（整棵树取节点后按关键词过滤，附带所属文件夹路径） */
  private async searchBookmarks(query: string, limit: number): Promise<RecallItem[]> {
    const { nodes } = await loadBookmarkTree();
    const keyword = query.trim().toLowerCase();

    const matched = nodes.filter(info => {
      if (!info.node.url) return false;
      if (!keyword) return true;
      const title = (info.node.title ?? '').toLowerCase();
      const url = (info.node.url ?? '').toLowerCase();
      return title.includes(keyword) || url.includes(keyword);
    });

    // 相关度：标题命中优先于仅 URL 命中；同级保持书签树原有顺序（用户自己的整理顺序）
    const scored = matched.map((info, index) => {
      const title = (info.node.title ?? '').toLowerCase();
      const url = (info.node.url ?? '').toLowerCase();
      const titleHit = keyword ? (title.includes(keyword) ? 0 : 1) : 0;
      const urlHit = keyword ? (url.includes(keyword) ? 0 : 1) : 1;
      return { info, rank: titleHit + urlHit, index };
    });
    scored.sort((a, b) => a.rank - b.rank || a.index - b.index);

    return scored.slice(0, Math.max(limit, limit * SORT_FETCH_FACTOR)).map(entry => ({
      url: entry.info.node.url!,
      title: entry.info.node.title || entry.info.node.url!,
      source: 'bookmark' as const,
      bookmarkId: entry.info.node.id,
      folderPath: entry.info.folderPath || undefined,
      dateAdded: entry.info.node.dateAdded,
    }));
  }

  /**
   * 按 id 反查条目地址。历史 id 只能靠有界扫描（chrome.history 没有按 id 查询的
   * 接口），超出扫描窗口时明确要求改用 url——不做「猜一个地址返回」的假成功。
   */
  private async resolveById(
    id: string,
    source?: HistoryBookmarkSource,
  ): Promise<
    { ok: true; url: string; title?: string; source: 'history' | 'bookmark' } | { ok: false; error: ToolResult }
  > {
    const tryBookmark = async (): Promise<{ url: string; title?: string } | null> => {
      const info = await findBookmarkById(id);
      if (!info) return null;
      return { url: info.node.url!, title: info.node.title };
    };

    const tryHistory = async (): Promise<{ url: string; title?: string } | null> => {
      const raw = await requireHistoryApi().search({
        text: '',
        startTime: 0,
        endTime: Date.now(),
        maxResults: HISTORY_ID_SCAN_LIMIT,
      });
      const found = raw.find(item => item.id === id && !!item.url);
      if (!found) return null;
      return { url: found.url!, title: found.title };
    };

    if (source === 'bookmark') {
      const hit = await tryBookmark();
      if (hit) return { ok: true, url: hit.url, title: hit.title, source: 'bookmark' };
      return { ok: false, error: this.createErrorResponse(`书签 id ${id} 不存在（可用 action="folders" 或 action="search" 查看现有 id）`) };
    }

    if (source === 'history') {
      const hit = await tryHistory();
      if (hit) return { ok: true, url: hit.url, title: hit.title, source: 'history' };
      return {
        ok: false,
        error: this.createErrorResponse(
          `历史 id ${id} 不在最近 ${HISTORY_ID_SCAN_LIMIT} 条历史中（chrome.history 不支持按 id 直查，请改用 url）`,
        ),
      };
    }

    const bookmarkHit = await tryBookmark();
    if (bookmarkHit) return { ok: true, url: bookmarkHit.url, title: bookmarkHit.title, source: 'bookmark' };
    const historyHit = await tryHistory();
    if (historyHit) return { ok: true, url: historyHit.url, title: historyHit.title, source: 'history' };
    return {
      ok: false,
      error: this.createErrorResponse(
        `id ${id} 在书签与最近 ${HISTORY_ID_SCAN_LIMIT} 条历史中均未找到，请改用 url`,
      ),
    };
  }

  /** 定位单个书签（按 id 或按地址；多地址命中时要求用 id 精确指定） */
  private async locateBookmark(
    bookmarkId?: string,
    url?: string,
  ): Promise<{ ok: true; id: string; title?: string } | { ok: false; error: ToolResult }> {
    if (bookmarkId !== undefined) {
      const info = await findBookmarkById(bookmarkId);
      if (!info) {
        return { ok: false, error: this.createErrorResponse(`书签 id ${bookmarkId} 不存在（可用 action="folders" 查看现有 id）`) };
      }
      return { ok: true, id: bookmarkId, title: info.node.title };
    }

    const matches = await findBookmarksByUrl(url!);
    if (matches.length === 0) {
      return { ok: false, error: this.createErrorResponse(`没有找到地址为 ${url} 的书签`) };
    }
    if (matches.length > 1) {
      const preview = matches.slice(0, 5).map(match => `${match.id}（${match.title}）`).join('、');
      return {
        ok: false,
        error: this.createErrorResponse(
          `有 ${matches.length} 个书签的地址都是 ${url}，无法确定改哪一个：请改用 bookmarkId（候选：${preview}）`,
        ),
      };
    }
    return { ok: true, id: matches[0].id, title: matches[0].title };
  }

  /** 委托 browser_navigation 打开地址（复用同址标签页 / 导航锁 / 加载等待） */
  private async openUrl(
    url: string,
    newTab: boolean,
    waitForLoad: boolean,
    timeout: number | undefined,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const navTool = toolRegistry.get(TOOL_NAMES.BROWSER.NAVIGATION);
    if (!navTool) {
      return this.createErrorResponse('导航工具 browser_navigation 不可用（注册表缺失）');
    }
    const result = await navTool.execute(
      {
        action: 'open',
        url,
        newTab,
        waitForLoad,
        ...(timeout !== undefined ? { timeout } : {}),
      },
      context,
    );
    // 目标标签页回报（宿主据此把页面高亮/引用指向真实标签页）
    const tabId = (result.data as { tabId?: number } | undefined)?.tabId;
    if (result.success && typeof tabId === 'number') {
      context?.onTabTarget?.(tabId);
    }
    return result;
  }
}

// 导出工具实例
export const browserHistoryBookmarksTool = new BrowserHistoryBookmarksTool();

// 纯函数与数据层再导出（供契约测试直接覆盖）
export {
  DAY_MS,
  HISTORY_BOOKMARK_SORTS,
  HISTORY_BOOKMARK_SOURCES,
  describeError,
  mergeRecallItems,
  normalizeUrlKey,
  parseTimeExpression,
  readTimeField,
  sortRecallItems,
} from './history-bookmarks-data';
export type { HistoryBookmarkSort, HistoryBookmarkSource, RecallItem } from './history-bookmarks-data';
export {
  collectBookmarkFolders,
  findBookmarkById,
  findBookmarksByUrl,
  loadBookmarkTree,
} from './history-bookmarks-bookmarks';
export type { BookmarkFolderInfo, BookmarkNodeInfo } from './history-bookmarks-bookmarks';

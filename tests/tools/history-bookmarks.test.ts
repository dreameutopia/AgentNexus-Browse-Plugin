/**
 * browser_history_bookmarks 契约测试（历史与书签统一工具）
 *
 * 覆盖：
 *   1. 注册与元数据：工具已注册、分类、删除动作走人审门；
 *   2. 参数矩阵：未知 action / 未知参数 / 张冠李戴参数 / 非法时间表达式；
 *   3. 检索：历史 + 书签同 URL 合并（source=both）、来源限定、时间窗
 *      （today / 3 days ago / 2w / 毫秒时间戳）、排序（recent / visited）、
 *      排除当前标签页；
 *   4. 打开：按 url 打开、按书签 id 打开、autoOpen 唯一命中自动打开
 *      （一律委托 browser_navigation，导航语义不另造）；
 *   5. 书签管理：新增书签 / 新建文件夹 / 改标题 / 移动 / 按 id 删 / 按 url 删；
 *   6. 只读视角：recent（时间倒序）、top（最常访问）、folders（目录结构）；
 *   7. 纯函数：同 URL 合并与排序的边界。
 *
 * 运行：由 tools.test.ts 末尾动态引入（chrome 全局桩已就位）。
 */

import assert from 'node:assert/strict';

import {
  BrowserHistoryBookmarksTool,
  mergeRecallItems,
  sortRecallItems,
} from '../../tools/browser/history-bookmarks';
import { toolRegistry } from '../../tools/registry';

// ==================== 桩：书签树 / 历史库 ====================

interface BookmarkFixture {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  dateAdded?: number;
  children?: BookmarkFixture[];
}

/** 书签树：根 → 书签栏（2 条） / 其它（1 条子文件夹） */
const BOOKMARK_TREE: BookmarkFixture[] = [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: 'Bookmarks bar',
        children: [
          { id: '11', parentId: '1', title: 'GitHub 收藏', url: 'https://github.com/', dateAdded: 100 },
          { id: '12', parentId: '1', title: '文档站', url: 'https://docs.example.com/guide', dateAdded: 200 },
        ],
      },
      {
        id: '2',
        title: '其它',
        children: [
          { id: '21', parentId: '2', title: '工作', url: 'https://work.example.com/', dateAdded: 50 },
          {
            id: '22',
            parentId: '2',
            title: '子文件夹',
            children: [
              { id: '221', parentId: '22', title: '深一层', url: 'https://deep.example.com/', dateAdded: 10 },
            ],
          },
        ],
      },
    ],
  },
];

interface HistoryFixture {
  id: string;
  url: string;
  title: string;
  lastVisitTime: number;
  visitCount: number;
}

/**
 * 历史库：与书签部分重合（github）、部分独有。
 * 时间戳取「现在」的相对值——工具的检索默认窗口是最近 30 天，
 * 固定的历史时刻会被时间窗过滤掉（那正是要测的行为）。
 */
const NOW = Date.now();
const HISTORY_ITEMS: HistoryFixture[] = [
  { id: 'h1', url: 'https://github.com', title: 'GitHub', lastVisitTime: NOW - 3 * 60 * 60 * 1000, visitCount: 7 },
  { id: 'h2', url: 'https://news.example.com', title: '新闻站', lastVisitTime: NOW - 1 * 60 * 60 * 1000, visitCount: 2 },
  { id: 'h3', url: 'https://old.example.com', title: '老页面', lastVisitTime: NOW - 5 * 60 * 60 * 1000, visitCount: 99 },
];

const chromeStub = (globalThis as Record<string, unknown>).chrome as Record<string, unknown>;
const originalHistory = chromeStub.history;
const originalBookmarks = chromeStub.bookmarks;
const originalTabs = chromeStub.tabs;
const originalWindows = chromeStub.windows;
const originalScripting = chromeStub.scripting;

interface StubState {
  createdUrls: string[];
  removedIds: string[];
  updates: Array<{ id: string; changes: Record<string, unknown> }>;
  createdNodes: Array<Record<string, unknown>>;
  lastHistoryQuery: { text?: string; startTime?: number; endTime?: number; maxResults?: number } | null;
  bookmarkSearchQueries: Array<{ query?: string; url?: string }>;
  deletedRanges: Array<{ startTime: number; endTime: number }>;
}

const state: StubState = {
  createdUrls: [],
  removedIds: [],
  updates: [],
  createdNodes: [],
  lastHistoryQuery: null,
  bookmarkSearchQueries: [],
  deletedRanges: [],
};

/** 扁平化书签树（测试与桩共用） */
function flattenBookmarks(nodes: BookmarkFixture[]): BookmarkFixture[] {
  const out: BookmarkFixture[] = [];
  for (const node of nodes) {
    out.push(node);
    if (node.children) out.push(...flattenBookmarks(node.children));
  }
  return out;
}

function installStubs(): void {
  chromeStub.history = {
    search: async (query: { text?: string; startTime?: number; endTime?: number; maxResults?: number }) => {
      state.lastHistoryQuery = query;
      const text = (query.text ?? '').toLowerCase();
      const matched = HISTORY_ITEMS.filter(item => {
        if (query.startTime !== undefined && item.lastVisitTime < query.startTime) return false;
        if (query.endTime !== undefined && item.lastVisitTime > query.endTime) return false;
        if (!text) return true;
        return item.url.toLowerCase().includes(text) || item.title.toLowerCase().includes(text);
      });
      return query.maxResults !== undefined ? matched.slice(0, query.maxResults) : matched;
    },
    getMostVisited: async ({ maxResults }: { maxResults: number }) =>
      [...HISTORY_ITEMS]
        .sort((a, b) => b.visitCount - a.visitCount)
        .slice(0, maxResults)
        .map(item => ({ url: item.url, title: item.title, visitCount: item.visitCount })),
    deleteRange: async (range: { startTime: number; endTime: number }) => {
      state.deletedRanges.push(range);
    },
  };

  chromeStub.bookmarks = {
    getTree: async () => JSON.parse(JSON.stringify(BOOKMARK_TREE)),
    search: async (query: { query?: string; url?: string }) => {
      state.bookmarkSearchQueries.push(query);
      const all = flattenBookmarks(BOOKMARK_TREE).filter(node => !!node.url);
      if (query.url) return all.filter(node => node.url === query.url);
      const keyword = (query.query ?? '').toLowerCase();
      if (!keyword) return all;
      return all.filter(
        node => node.title.toLowerCase().includes(keyword) || (node.url ?? '').toLowerCase().includes(keyword),
      );
    },
    create: async (props: { parentId?: string; title: string; url?: string }) => {
      state.createdNodes.push({ ...props });
      return {
        id: `new-${state.createdNodes.length}`,
        parentId: props.parentId ?? '1',
        title: props.title,
        url: props.url,
        dateAdded: 999,
      };
    },
    update: async (id: string, changes: Record<string, unknown>) => {
      state.updates.push({ id, changes });
      const node = flattenBookmarks(BOOKMARK_TREE).find(item => item.id === id);
      return {
        id,
        parentId: node?.parentId ?? '1',
        title: (changes.title as string) ?? node?.title ?? '',
        url: (changes.url as string) ?? node?.url,
      };
    },
    remove: async (id: string) => {
      state.removedIds.push(id);
    },
  };

  // 导航链路（open / autoOpen 委托 browser_navigation 时用）
  chromeStub.tabs = {
    ...(originalTabs as Record<string, unknown>),
    query: async () => [{ id: 1, url: 'https://example.com/', status: 'complete', windowId: 1 }],
    get: async (tabId: number) => ({ id: tabId, url: 'https://target.example/page', status: 'complete', windowId: 1 }),
    create: async (props: { url?: string }) => {
      state.createdUrls.push(props.url ?? '');
      return { id: 501, url: props.url, status: 'complete', windowId: 1 };
    },
    update: async (tabId: number, props: { url?: string }) => ({ id: tabId, url: props.url, status: 'complete' }),
    reload: async () => undefined,
    remove: async () => undefined,
  };
  chromeStub.windows = {
    ...(originalWindows as Record<string, unknown>),
    getLastFocused: async () => ({ id: 1, type: 'normal' }),
    update: async () => undefined,
  };
  chromeStub.scripting = {
    ...(originalScripting as Record<string, unknown>),
    executeScript: async () => [{ result: 'complete' }],
  };
}

function restoreStubs(): void {
  chromeStub.history = originalHistory;
  chromeStub.bookmarks = originalBookmarks;
  chromeStub.tabs = originalTabs;
  chromeStub.windows = originalWindows;
  chromeStub.scripting = originalScripting;
}

function resetState(): void {
  state.createdUrls = [];
  state.removedIds = [];
  state.updates = [];
  state.createdNodes = [];
  state.lastHistoryQuery = null;
  state.bookmarkSearchQueries = [];
  state.deletedRanges = [];
}

// ==================== 1. 注册与元数据 ====================

const tool = new BrowserHistoryBookmarksTool();

assert.ok(toolRegistry.getTool('browser_history_bookmarks'), 'browser_history_bookmarks 已注册');
assert.equal(tool.metadata.category, 'browser', '归入 browser 分类');
assert.equal(tool.metadata.name, 'browser_history_bookmarks', 'metadata.name 与工具名一致');
assert.ok(
  (tool.metadata.requiresApprovalActions ?? []).includes('delete'),
  '删除书签走人审门（与 note_tool 的 delete 同口径）',
);
assert.equal(
  tool.openaiSchema.function.parameters?.required?.length,
  1,
  '唯一必填参数是 action',
);
const actionEnum = (tool.openaiSchema.function.parameters?.properties?.action as { enum?: string[] }).enum ?? [];
assert.deepEqual(
  actionEnum,
  ['search', 'open', 'create', 'update', 'delete', 'clear', 'recent', 'top', 'folders'],
  '九个 action 与运行期矩阵同源',
);
assert.ok(
  (tool.metadata.requiresApprovalActions ?? []).includes('clear'),
  '清理浏览历史走人审门',
);

// ==================== 2. 参数矩阵 ====================

installStubs();
try {
  resetState();

  const badAction = await tool.execute({ action: 'nope' });
  assert.equal(badAction.success, false, '未知 action 被拒');
  assert.match(String(badAction.error), /action 必须是/, '未知 action 报错可读');

  const unknownParam = await tool.execute({ action: 'search', keyword: 'x' });
  assert.equal(unknownParam.success, false, '未知参数被拒');
  assert.match(String(unknownParam.error), /未知参数/, '未知参数报错可读');

  const mismatched = await tool.execute({ action: 'search', bookmarkId: '11' });
  assert.equal(mismatched.success, false, '张冠李戴参数被拒');
  assert.match(String(mismatched.error), /不适用于/, '张冠李戴参数报错可读');

  const badTime = await tool.execute({ action: 'search', since: '前天' });
  assert.equal(badTime.success, false, '无法解析的时间表达式被拒');
  assert.match(String(badTime.error), /无法解析为时间/, '非法时间报错可读');

  const badSource = await tool.execute({ action: 'search', source: 'favorites' });
  assert.equal(badSource.success, false, '未知 source 被拒');
  assert.match(String(badSource.error), /source 必须是/, '未知 source 报错可读');

  const badSort = await tool.execute({ action: 'search', sort: 'oldest' });
  assert.equal(badSort.success, false, '未知 sort 被拒');

  const openWithoutTarget = await tool.execute({ action: 'open' });
  assert.equal(openWithoutTarget.success, false, 'open 缺目标被拒');
  assert.match(String(openWithoutTarget.error), /url 或 id/, 'open 缺参报错可读');

  const updateNothing = await tool.execute({ action: 'update', bookmarkId: '11' });
  assert.equal(updateNothing.success, false, 'update 缺改动项被拒');
  assert.match(String(updateNothing.error), /至少要改一项/, 'update 缺改动报错可读');

  const updateBothTargets = await tool.execute({ action: 'update', bookmarkId: '11', url: 'https://x.example', title: 't' });
  assert.equal(updateBothTargets.success, false, 'update 两种定位方式互斥');
  assert.match(String(updateBothTargets.error), /互斥/, 'update 互斥报错可读');

  const deleteBothTargets = await tool.execute({ action: 'delete', bookmarkId: '11', url: 'https://x.example' });
  assert.equal(deleteBothTargets.success, false, 'delete 两种定位方式互斥');

  const createFolderWithUrl = await tool.execute({ action: 'create', folder: true, title: '文件夹', url: 'https://x.example' });
  assert.equal(createFolderWithUrl.success, false, '建文件夹时不允许带 url');

  const createFolderNoTitle = await tool.execute({ action: 'create', folder: true });
  assert.equal(createFolderNoTitle.success, false, '建文件夹必须给 title');

  const createNoUrl = await tool.execute({ action: 'create' });
  assert.equal(createNoUrl.success, false, '新增书签必须给 url');

  // ==================== 3. 检索 ====================

  const both = await tool.execute({ action: 'search', query: 'github' });
  assert.equal(both.success, true, 'search 成功');
  const bothItems = (both.data as { items: Array<Record<string, unknown>> }).items;
  assert.equal(bothItems.length, 1, '历史与书签的同一 URL 合并为一条');
  assert.equal(bothItems[0].source, 'both', '合并条目来源标 both');
  assert.equal(bothItems[0].historyId, 'h1', '合并条目保留历史 id');
  assert.equal(bothItems[0].bookmarkId, '11', '合并条目保留书签 id');
  assert.equal(bothItems[0].folderPath, 'Bookmarks bar', '合并条目带书签所属文件夹路径');
  assert.equal(bothItems[0].visitCount, 7, '合并条目保留访问次数');

  const historyOnly = await tool.execute({ action: 'search', source: 'history', query: 'example' });
  const historyItems = (historyOnly.data as { items: Array<Record<string, unknown>> }).items;
  assert.ok(
    historyItems.every(item => item.source === 'history'),
    'source=history 只回历史条目',
  );

  const bookmarkOnly = await tool.execute({ action: 'search', source: 'bookmark', query: 'example' });
  const bookmarkItems = (bookmarkOnly.data as { items: Array<Record<string, unknown>> }).items;
  assert.ok(
    bookmarkItems.every(item => item.source === 'bookmark'),
    'source=bookmark 只回书签条目',
  );

  // 时间窗：today → 今天零点起
  const today = await tool.execute({ action: 'search', source: 'history', since: 'today' });
  assert.equal(today.success, true, 'since="today" 可解析');
  const todayStart = state.lastHistoryQuery?.startTime ?? 0;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  assert.ok(
    Math.abs(todayStart - midnight.getTime()) < 1000,
    'since="today" 落到今天零点',
    { todayStart, midnight: midnight.getTime() },
  );

  // 相对时间：3 days ago / 2w / 毫秒时间戳
  const threeDays = await tool.execute({ action: 'search', source: 'history', since: '3 days ago' });
  assert.equal(threeDays.success, true, 'since="3 days ago" 可解析');
  const threeDaysStart = state.lastHistoryQuery?.startTime ?? 0;
  assert.ok(
    Math.abs(threeDaysStart - (Date.now() - 3 * 24 * 60 * 60 * 1000)) < 60_000,
    'since="3 days ago" 落到三天前',
    threeDaysStart,
  );

  const twoWeeks = await tool.execute({ action: 'search', source: 'history', since: '2w' });
  assert.equal(twoWeeks.success, true, 'since="2w" 可解析');
  const twoWeeksStart = state.lastHistoryQuery?.startTime ?? 0;
  assert.ok(
    Math.abs(twoWeeksStart - (Date.now() - 14 * 24 * 60 * 60 * 1000)) < 60_000,
    'since="2w" 落到两周前',
    twoWeeksStart,
  );

  const epoch = await tool.execute({ action: 'search', source: 'history', since: 1_700_000_000_000 });
  assert.equal(epoch.success, true, 'since 支持毫秒时间戳');
  assert.equal(state.lastHistoryQuery?.startTime, 1_700_000_000_000, '毫秒时间戳原样传入');

  const inverted = await tool.execute({
    action: 'search',
    source: 'history',
    since: 1_800_000_000_000,
    until: 1_700_000_000_000,
  });
  assert.equal(inverted.success, false, '时间窗倒置被拒');
  assert.match(String(inverted.error), /时间窗无效/, '时间窗倒置报错可读');

  // 排序：visited（访问次数）与 recent（最后访问）
  const visited = await tool.execute({ action: 'search', source: 'history', sort: 'visited' });
  const visitedItems = (visited.data as { items: Array<Record<string, unknown>> }).items;
  assert.equal(visitedItems[0].url, 'https://old.example.com', 'sort=visited 命中访问次数最多的条目');

  const recent = await tool.execute({ action: 'search', source: 'history', sort: 'recent' });
  const recentItems = (recent.data as { items: Array<Record<string, unknown>> }).items;
  assert.equal(recentItems[0].url, 'https://news.example.com', 'sort=recent 命中最后访问最新的条目');

  // 排除当前标签页
  const excluded = await tool.execute({ action: 'search', source: 'history', excludeCurrentTabs: true });
  assert.equal(excluded.success, true, 'excludeCurrentTabs 可用');

  // limit 生效
  const limited = await tool.execute({ action: 'search', source: 'history', limit: 1 });
  const limitedItems = (limited.data as { items: unknown[] }).items;
  assert.equal(limitedItems.length, 1, 'limit 生效');

  const badLimit = await tool.execute({ action: 'search', source: 'history', limit: 0 });
  assert.equal(badLimit.success, false, 'limit=0 被拒');
  const overLimit = await tool.execute({ action: 'search', source: 'history', limit: 5000 });
  assert.equal(overLimit.success, false, '超上限 limit 被拒');

  // ==================== 4. 打开 ====================

  resetState();
  const opened = await tool.execute({ action: 'open', url: 'https://target.example/page' });
  assert.equal(opened.success, true, 'open 成功');
  assert.deepEqual(state.createdUrls, ['https://target.example/page'], 'open 委托 browser_navigation 新建标签页');
  assert.equal((opened.data as { tabId?: number }).tabId, 501, 'open 回传目标 tabId');

  resetState();
  const openedById = await tool.execute({ action: 'open', id: '11', source: 'bookmark' });
  assert.equal(openedById.success, true, '按书签 id 打开成功');
  assert.deepEqual(state.createdUrls, ['https://github.com/'], '按 id 打开解析出书签地址');
  assert.equal((openedById.data as { resolved?: { source?: string } }).resolved?.source, 'bookmark', '回传解析来源');

  const unknownId = await tool.execute({ action: 'open', id: 'nope', source: 'bookmark' });
  assert.equal(unknownId.success, false, '不存在的书签 id 报错');
  assert.match(String(unknownId.error), /不存在/, '不存在的 id 报错可读');

  // autoOpen：唯一命中直接打开
  resetState();
  const autoOpened = await tool.execute({ action: 'search', source: 'bookmark', query: '文档站', autoOpen: true });
  assert.equal(autoOpened.success, true, 'autoOpen 检索成功');
  assert.deepEqual(state.createdUrls, ['https://docs.example.com/guide'], 'autoOpen 唯一命中直接打开');
  assert.ok((autoOpened.data as { opened?: unknown }).opened, 'autoOpen 回传打开结果');

  // autoOpen：多条命中不打开
  resetState();
  const autoSkipped = await tool.execute({ action: 'search', source: 'history', query: 'example', autoOpen: true });
  assert.equal(autoSkipped.success, true, 'autoOpen 多条命中仍成功');
  assert.deepEqual(state.createdUrls, [], 'autoOpen 多条命中不打开');
  assert.match(String((autoSkipped.data as { note?: string }).note ?? ''), /唯一命中/, 'autoOpen 多条命中给出说明');

  // ==================== 5. 书签管理 ====================

  resetState();
  const created = await tool.execute({ action: 'create', url: 'https://new.example.com', title: '新书签' });
  assert.equal(created.success, true, '新增书签成功');
  assert.equal(state.createdNodes.length, 1, '新增书签落到 chrome.bookmarks.create');
  assert.equal(state.createdNodes[0].url, 'https://new.example.com', '新增书签带上地址');
  assert.equal(state.createdNodes[0].parentId, '1', '未指定父目录时落在书签栏');

  const createdFolder = await tool.execute({ action: 'create', folder: true, title: '新文件夹' });
  assert.equal(createdFolder.success, true, '新建文件夹成功');
  assert.equal(state.createdNodes[1].title, '新文件夹', '新建文件夹带上标题');
  assert.equal(state.createdNodes[1].url, undefined, '新建文件夹不带地址');

  resetState();
  const updated = await tool.execute({ action: 'update', bookmarkId: '11', title: '改过的标题' });
  assert.equal(updated.success, true, '改书签标题成功');
  assert.equal(state.updates.length, 1, '改书签落到 chrome.bookmarks.update');
  assert.equal(state.updates[0].id, '11', '改书签命中目标 id');
  assert.equal(state.updates[0].changes.title, '改过的标题', '改书签带上新标题');

  const moved = await tool.execute({ action: 'update', bookmarkId: '11', parentId: '2' });
  assert.equal(moved.success, true, '移动书签成功');
  const lastUpdate = state.updates[state.updates.length - 1];
  assert.equal(lastUpdate.changes.parentId, '2', '移动书签带上目标父目录');

  resetState();
  const deleted = await tool.execute({ action: 'delete', bookmarkId: '11' });
  assert.equal(deleted.success, true, '按 id 删书签成功');
  assert.deepEqual(state.removedIds, ['11'], '按 id 删书签落到 chrome.bookmarks.remove');

  resetState();
  const deletedByUrl = await tool.execute({ action: 'delete', url: 'https://github.com/' });
  assert.equal(deletedByUrl.success, true, '按 url 删书签成功');
  assert.deepEqual(state.removedIds, ['11'], '按 url 删书签删掉匹配项');
  assert.equal((deletedByUrl.data as { deletedCount?: number }).deletedCount, 1, '按 url 删回传删除条数');

  const deleteMissing = await tool.execute({ action: 'delete', url: 'https://nothing.example.com' });
  assert.equal(deleteMissing.success, false, '删不存在的书签报错');
  assert.match(String(deleteMissing.error), /没有找到/, '删不存在的书签报错可读');

  // ==================== 6. 清理浏览历史（不可逆，需人审门） ====================

  resetState();
  const clearWithoutRange = await tool.execute({ action: 'clear' });
  assert.equal(clearWithoutRange.success, false, '清理历史缺范围被拒');
  assert.match(String(clearWithoutRange.error), /必须给出清理范围/, '清理历史缺范围报错可读');
  assert.equal(state.deletedRanges.length, 0, '清理历史缺范围不产生任何副作用');

  const cleared = await tool.execute({ action: 'clear', since: '7 days ago' });
  assert.equal(cleared.success, true, '按时间窗清理历史成功');
  assert.equal(state.deletedRanges.length, 1, '清理历史落到 chrome.history.deleteRange');
  const deletedRange = state.deletedRanges[0];
  assert.ok(
    Math.abs(deletedRange.startTime - (Date.now() - 7 * 24 * 60 * 60 * 1000)) < 60_000,
    '清理历史的时间窗起点按 "7 days ago" 解析',
    deletedRange,
  );

  const clearedAll = await tool.execute({ action: 'clear', all: true });
  assert.equal(clearedAll.success, true, '清空全部历史成功');
  assert.equal(state.deletedRanges[state.deletedRanges.length - 1].startTime, 0, 'all=true 从时间原点清空');
  assert.equal((clearedAll.data as { scope?: string }).scope, 'all', 'all=true 回传 scope=all');

  // ==================== 6. 只读视角 ====================

  const recentList = await tool.execute({ action: 'recent', limit: 2 });
  assert.equal(recentList.success, true, 'recent 成功');
  const recentListItems = (recentList.data as { items: Array<Record<string, unknown>> }).items;
  assert.equal(recentListItems.length, 2, 'recent 遵守 limit');
  assert.equal(recentListItems[0].url, 'https://news.example.com', 'recent 按最后访问倒序');

  const topList = await tool.execute({ action: 'top', limit: 2 });
  assert.equal(topList.success, true, 'top 成功');
  const topItems = (topList.data as { items: Array<Record<string, unknown>>; ranking?: string }).items;
  assert.equal((topList.data as { ranking?: string }).ranking, 'getMostVisited', 'top 走宿主榜单接口');
  assert.equal(topItems[0].url, 'https://old.example.com', 'top 按访问次数排序');

  const folders = await tool.execute({ action: 'folders' });
  assert.equal(folders.success, true, 'folders 成功');
  const folderItems = (folders.data as { folders: Array<Record<string, unknown>> }).folders;
  assert.deepEqual(
    folderItems.map(folder => folder.title),
    ['Bookmarks bar', '其它', '子文件夹'],
    'folders 列出文件夹（不含空标题根节点）',
  );
  assert.equal(folderItems[0].bookmarkCount, 2, 'folders 统计直接书签数');
  assert.equal(folderItems[1].folderCount, 1, 'folders 统计子文件夹数');
  assert.equal(folderItems[2].path, '其它 / 子文件夹', 'folders 给出文件夹路径');

  const subtree = await tool.execute({ action: 'folders', parentId: '2' });
  const subtreeItems = (subtree.data as { folders: Array<Record<string, unknown>> }).folders;
  assert.deepEqual(
    subtreeItems.map(folder => folder.title),
    ['其它', '子文件夹'],
    'folders 限定父目录时只列该子树',
  );
} finally {
  restoreStubs();
}

// ==================== 7. 纯函数边界 ====================

{
  const merged = mergeRecallItems([
    { url: 'https://a.example/', title: 'A', source: 'history', visitCount: 3 },
    { url: 'https://a.example', title: '', source: 'bookmark', dateAdded: 9 },
  ]);
  assert.equal(merged.length, 1, '尾斜杠不同的同 URL 合并为一条');
  assert.equal(merged[0].source, 'both', '合并后来源标 both');
  assert.equal(merged[0].title, 'A', '合并时保留非空标题');
  assert.equal(merged[0].visitCount, 3, '合并时保留访问次数');
  assert.equal(merged[0].dateAdded, 9, '合并时保留收藏时间');

  const sortedByVisited = sortRecallItems(
    [
      { url: 'https://a.example', title: 'A', source: 'history', visitCount: 1 },
      { url: 'https://b.example', title: 'B', source: 'history', visitCount: 5 },
    ],
    'visited',
  );
  assert.equal(sortedByVisited[0].url, 'https://b.example', 'sort=visited 按访问次数降序');

  const sortedByRecent = sortRecallItems(
    [
      { url: 'https://a.example', title: 'A', source: 'history', lastVisitTime: 10 },
      { url: 'https://b.example', title: 'B', source: 'history', lastVisitTime: 20 },
    ],
    'recent',
  );
  assert.equal(sortedByRecent[0].url, 'https://b.example', 'sort=recent 按最后访问降序');

  const untouched = sortRecallItems(
    [
      { url: 'https://a.example', title: 'A', source: 'history' },
      { url: 'https://b.example', title: 'B', source: 'history' },
    ],
    'relevance',
  );
  assert.equal(untouched[0].url, 'https://a.example', 'sort=relevance 保持检索原序');
}

console.log('[history-bookmarks] 检索/打开/增删改/只读视角/参数矩阵契约通过');

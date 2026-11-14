/**
 * browser_downloads / browser_resources 契约测试
 *
 * 覆盖两块（对应「按域合并 + 拓宽能力边界 + 健壮化」这一轮改造）：
 *   1. browser_downloads：action 矩阵校验、七个 action 行为、
 *      chrome.downloads 未用过的能力（cancel/pause/resume/erase/show/open）真的生效；
 *   2. browser_resources：action 矩阵校验、八个 action 行为、
 *      嗅探缓存与下载同实例（不再跨实例反查）、后台命令失败时的精准报错。
 *
 * 运行：由 tools.test.ts 末尾动态引入（chrome 全局桩已就位）。
 */

import assert from 'node:assert/strict';
import { chatDatabase } from '../../entrypoints/sidepanel/core/context/chat-database';
import { readWorkspaceOutput } from '../../utils/python-workspace/store';
import { BrowserDownloadsTool } from '../../tools/browser/downloads';
import { BrowserResourcesTool } from '../../tools/browser/resources';

const resourceChatId = 'resource-contract';
await chatDatabase.createSession({ chatId: resourceChatId, title: 'Resources', createdAt: 1, updatedAt: 1, messageCount: 0, lastMessagePreview: '', agentName: '', skillNames: [] });

// ==================== chrome 桩 ====================

interface DownloadStubItem {
  id: number;
  filename: string;
  url: string;
  finalUrl: string;
  state: 'in_progress' | 'interrupted' | 'complete';
  paused: boolean;
  bytesReceived: number;
  totalBytes: number;
  startTime: string;
  endTime?: string;
  mime: string;
  exists: boolean;
  danger: string;
  error?: string;
}

interface DownloadCall {
  method: string;
  args: unknown[];
}

const downloadCalls: DownloadCall[] = [];
let downloadItems: DownloadStubItem[] = [];
let nextDownloadId = 500;

const chromeStub = (globalThis as Record<string, unknown>).chrome as Record<string, unknown>;
const originalDownloads = chromeStub.downloads;
const originalTabs = chromeStub.tabs;
const originalScripting = chromeStub.scripting;
const originalRuntime = chromeStub.runtime;

function installStubs(): void {
  downloadCalls.length = 0;
  nextDownloadId = 500;
  downloadItems = [
    {
      id: 11,
      filename: '报告.pdf',
      url: 'https://example.com/报告.pdf',
      finalUrl: 'https://example.com/报告.pdf',
      state: 'complete',
      paused: false,
      bytesReceived: 2048,
      totalBytes: 2048,
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:05.000Z',
      mime: 'application/pdf',
      exists: true,
      danger: 'safe',
    },
    {
      id: 12,
      filename: 'big.zip',
      url: 'https://example.com/big.zip',
      finalUrl: 'https://example.com/big.zip',
      state: 'in_progress',
      paused: false,
      bytesReceived: 512,
      totalBytes: 4096,
      startTime: '2026-01-02T00:00:00.000Z',
      mime: 'application/zip',
      exists: true,
      danger: 'safe',
    },
  ];

  chromeStub.downloads = {
    search: async (query: chrome.downloads.DownloadQuery) => {
      downloadCalls.push({ method: 'search', args: [query] });
      let items = downloadItems.slice();
      if (query.state) items = items.filter(item => item.state === query.state);
      if (query.id !== undefined) items = items.filter(item => item.id === query.id);
      if (query.query?.length) {
        const needle = query.query[0].toLowerCase();
        items = items.filter(
          item => item.filename.toLowerCase().includes(needle) || item.url.toLowerCase().includes(needle),
        );
      }
      if (query.limit !== undefined) items = items.slice(0, query.limit);
      return items;
    },
    download: async (options: { url: string; filename?: string }) => {
      downloadCalls.push({ method: 'download', args: [options] });
      nextDownloadId += 1;
      return nextDownloadId;
    },
    cancel: async (id: number) => {
      downloadCalls.push({ method: 'cancel', args: [id] });
    },
    pause: async (id: number) => {
      downloadCalls.push({ method: 'pause', args: [id] });
    },
    resume: async (id: number) => {
      downloadCalls.push({ method: 'resume', args: [id] });
    },
    erase: async (query: { id?: number }) => {
      downloadCalls.push({ method: 'erase', args: [query] });
      if (query.id !== undefined) {
        downloadItems = downloadItems.filter(item => item.id !== query.id);
      }
      return query.id !== undefined ? [query.id] : [];
    },
    show: async (id: number) => {
      downloadCalls.push({ method: 'show', args: [id] });
    },
    open: async (id: number) => {
      downloadCalls.push({ method: 'open', args: [id] });
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  };

  chromeStub.tabs = {
    ...(originalTabs as Record<string, unknown>),
    query: async () => [{ id: 1, url: 'https://example.com/page', status: 'complete', windowId: 1 }],
    get: async (tabId: number) => ({ id: tabId, url: 'https://example.com/page', status: 'complete', windowId: 1 }),
  };

  chromeStub.scripting = {
    ...(originalScripting as Record<string, unknown>),
    executeScript: async () => [
      {
        frameId: 0,
        result: [
          { id: 'res_abc_1', url: 'https://example.com/a.pdf', filename: 'a.pdf', fileType: 'pdf', size: '', title: 'A', description: '', source: 'dom' },
          { id: 'res_def_2', url: 'https://example.com/b.zip', filename: 'b.zip', fileType: 'zip', size: '', title: 'B', description: '', source: 'dom' },
        ],
      },
    ],
  };

  chromeStub.runtime = {
    ...(originalRuntime as Record<string, unknown>),
    sendMessage: async (message: { command?: string; payload?: unknown }) => {
      downloadCalls.push({ method: 'message', args: [message] });
      switch (message.command) {
        case 'getInterceptionState':
          return { success: true, isEnabled: true, extensionsToIntercept: ['pdf', 'zip'] };
        case 'getCapturedFileList':
          return {
            success: true,
            totalCount: 2,
            fileList: [
              { id: 'cap-1', filename: 'a.pdf', mimeType: 'application/pdf', size: 1024, capturedAt: 1, sourcePageUrl: 'https://example.com' },
              { id: 'cap-2', filename: 'b.zip', mimeType: 'application/zip', size: 2048, capturedAt: 2, sourcePageUrl: 'https://example.com' },
            ],
          };
        case 'getFileDetailsById':
          return {
            success: true,
            fileDetails: {
              id: (message.payload as { id?: string } | undefined)?.id,
              filename: 'a.pdf',
              mimeType: 'application/pdf',
              size: 1024,
              capturedAt: 1,
              sourcePageUrl: 'https://example.com',
              contentLength: 1024,
            },
          };
        case 'clearAllCapturedFiles':
          return { success: true, clearedCount: 2 };
        case 'startInterception':
          return { success: true };
        case 'stopInterception':
          return { success: true };
        default:
          return { success: false, error: `未知命令 ${message.command}` };
      }
    },
  };
}

let resourceRestoreFetch = () => {};
function restoreStubs(): void {
  resourceRestoreFetch();
  chromeStub.downloads = originalDownloads;
  chromeStub.tabs = originalTabs;
  chromeStub.scripting = originalScripting;
  chromeStub.runtime = originalRuntime;
}

// ==================== 1. browser_downloads ====================

{
  installStubs();
  try {
    const tool = new BrowserDownloadsTool();

    // —— 注册与元数据 ——
    assert.equal(tool.name, 'browser_downloads', '工具名');
    assert.equal(tool.metadata.category, 'browser', '归 browser 分类');
    const actionEnum = (tool.openaiSchema.function.parameters?.properties?.action as { enum?: string[] }).enum ?? [];
    assert.deepEqual(
      actionEnum,
      ['list', 'cancel', 'pause', 'resume', 'erase', 'show', 'open'],
      '七个 action 与运行期矩阵同源',
    );

    // —— 参数矩阵 ——
    const badAction = await tool.execute({ action: 'nope' });
    assert.equal(badAction.success, false, '未知 action 被拒');
    assert.match(String(badAction.error), /action 必须是/, '未知 action 报错可读');

    const unknownParam = await tool.execute({ action: 'list', foo: 1 });
    assert.equal(unknownParam.success, false, '未知参数被拒');
    assert.match(String(unknownParam.error), /未知参数/, '未知参数报错可读');

    const mismatched = await tool.execute({ action: 'list', downloadId: 5 });
    assert.equal(mismatched.success, false, '张冠李戴参数被拒');
    assert.match(String(mismatched.error), /不适用于/, '张冠李戴参数报错可读');

    const missingId = await tool.execute({ action: 'cancel' });
    assert.equal(missingId.success, false, 'cancel 缺 downloadId 被拒');
    assert.match(String(missingId.error), /downloadId/, '缺参报错可读');

    const badState = await tool.execute({ action: 'list', state: 'paused' });
    assert.equal(badState.success, false, '未知 state 被拒');

    const badOrder = await tool.execute({ action: 'list', orderBy: 'name' });
    assert.equal(badOrder.success, false, '未知 orderBy 被拒');

    const badLimit = await tool.execute({ action: 'list', limit: 0 });
    assert.equal(badLimit.success, false, 'limit=0 被拒');

    // —— list ——
    const listed = await tool.execute({ action: 'list' });
    assert.equal(listed.success, true, 'list 成功');
    const listData = listed.data as { count: number; items: Array<{ id: string; progress: number }>; summary: { total: number } };
    assert.equal(listData.count, 2, 'list 返回全部条目');
    assert.equal(listData.items[0].id, '11', 'list 返回字符串化 id');
    assert.equal(listData.summary.total, 2, 'list 汇总统计');
    const searchCall = downloadCalls.find(call => call.method === 'search');
    assert.ok(searchCall, 'list 走了 chrome.downloads.search');
    assert.deepEqual((searchCall!.args[0] as chrome.downloads.DownloadQuery).orderBy, ['-startTime'], '默认按 startTime 降序');

    const filtered = await tool.execute({ action: 'list', state: 'in_progress' });
    assert.equal((filtered.data as { count: number }).count, 1, 'state 过滤生效');
    const queried = await tool.execute({ action: 'list', query: 'report' });
    assert.equal((queried.data as { count: number }).count, 0, 'query 按文件名过滤（大小写不敏感，报告 vs report）');
    const queriedEn = await tool.execute({ action: 'list', query: '报告' });
    assert.equal((queriedEn.data as { count: number }).count, 1, 'query 命中中文文件名');

    // —— 新能力：cancel / pause / resume / erase / show / open ——
    const cancelled = await tool.execute({ action: 'cancel', downloadId: 12 });
    assert.equal(cancelled.success, true, 'cancel 成功');
    assert.ok(downloadCalls.some(call => call.method === 'cancel' && call.args[0] === 12), 'cancel 真的调用了 chrome.downloads.cancel');

    const paused = await tool.execute({ action: 'pause', downloadId: 12 });
    assert.equal(paused.success, true, 'pause 成功');
    assert.ok(downloadCalls.some(call => call.method === 'pause'), 'pause 真的调用了 chrome.downloads.pause');

    const resumed = await tool.execute({ action: 'resume', downloadId: 12 });
    assert.equal(resumed.success, true, 'resume 成功');
    assert.ok(downloadCalls.some(call => call.method === 'resume'), 'resume 真的调用了 chrome.downloads.resume');

    const shown = await tool.execute({ action: 'show', downloadId: 11 });
    assert.equal(shown.success, true, 'show 成功');
    assert.ok(downloadCalls.some(call => call.method === 'show'), 'show 真的调用了 chrome.downloads.show');

    const opened = await tool.execute({ action: 'open', downloadId: 11 });
    assert.equal(opened.success, true, 'open 成功');
    assert.ok(downloadCalls.some(call => call.method === 'open'), 'open 真的调用了 chrome.downloads.open');

    const erased = await tool.execute({ action: 'erase', downloadIds: [11, 12] });
    assert.equal(erased.success, true, 'erase 成功');
    const eraseData = erased.data as { erasedCount: number; erasedIds: number[] };
    assert.equal(eraseData.erasedCount, 2, 'erase 清掉两条');
    assert.deepEqual(eraseData.erasedIds, [11, 12], 'erase 回传被清 id');

    const erasedNone = await tool.execute({ action: 'erase' });
    assert.equal(erasedNone.success, false, 'erase 缺 downloadIds 被拒');

    // —— 失败路径：底层 API 抛错时不得把异常抛给调用方 ——
    const brokenDownloads = chromeStub.downloads as Record<string, unknown>;
    const originalCancel = brokenDownloads.cancel;
    brokenDownloads.cancel = async () => {
      throw new Error('下载任务已结束，无法取消');
    };
    const cancelFailed = await tool.execute({ action: 'cancel', downloadId: 12 });
    assert.equal(cancelFailed.success, false, '底层失败时工具返回失败而不是抛错');
    assert.match(String(cancelFailed.error), /下载操作 cancel 失败/, '失败文案带动作名');
    assert.match(String(cancelFailed.error), /下载任务已结束/, '失败文案带底层原因');
    brokenDownloads.cancel = originalCancel;
  } finally {
    restoreStubs();
  }
}

// ==================== 2. browser_resources ====================

{
  installStubs();
  try {
    const actualTool = new BrowserResourcesTool();
    const tool = {
      name: actualTool.name,
      metadata: actualTool.metadata,
      openaiSchema: actualTool.openaiSchema,
      execute: (args: unknown) => actualTool.execute(args, { chatId: resourceChatId }),
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 255]), { headers: { 'content-type': 'application/pdf' } });
    const { downloadDB } = await import('../../utils/download-database');
    await downloadDB.addFile({ id: 'cap-1', filename: 'captured.pdf', sourcePageUrl: 'https://example.com', mimeType: 'application/pdf', capturedAt: 1, blobData: new Blob(['captured']) });
    // Restore even if the action contract fails.
    resourceRestoreFetch = () => { globalThis.fetch = originalFetch; };

    // —— 注册与元数据 ——
    assert.equal(tool.name, 'browser_resources', '工具名');
    assert.equal(tool.metadata.category, 'browser', '归 browser 分类');
    const actionEnum = (tool.openaiSchema.function.parameters?.properties?.action as { enum?: string[] }).enum ?? [];
    assert.deepEqual(
      actionEnum,
      ['sniff', 'list', 'download', 'fetch', 'intercept', 'captured', 'export', 'status'],
      '八个 action 与运行期矩阵同源',
    );
    assert.deepEqual(
      tool.metadata.requiresApprovalActions ?? [],
      ['clear'],
      '清空捕获库走人审门',
    );

    // —— 参数矩阵 ——
    const badAction = await tool.execute({ action: 'nope' });
    assert.equal(badAction.success, false, '未知 action 被拒');

    const unknownParam = await tool.execute({ action: 'sniff', foo: 1 });
    assert.equal(unknownParam.success, false, '未知参数被拒');

    const badIntercept = await tool.execute({ action: 'intercept', operation: 'list' });
    assert.equal(badIntercept.success, false, 'intercept 不接受 captured 的子动作');
    assert.match(String(badIntercept.error), /operation 必须是/, '子动作报错可读');

    const badCaptured = await tool.execute({ action: 'captured', operation: 'start' });
    assert.equal(badCaptured.success, false, 'captured 不接受 intercept 的子动作');

    const missingOp = await tool.execute({ action: 'intercept' });
    assert.equal(missingOp.success, false, 'intercept 缺 operation 被拒');

    const missingFileId = await tool.execute({ action: 'export' });
    assert.equal(missingFileId.success, false, 'export 缺 fileId 被拒');

    const missingUrl = await tool.execute({ action: 'fetch' });
    assert.equal(missingUrl.success, false, 'fetch 缺 url 被拒');

    const badIds = await tool.execute({ action: 'download', resourceIds: [] });
    assert.equal(badIds.success, false, 'download 空 resourceIds 被拒');

    // —— sniff：结果进缓存 ——
    const sniffed = await tool.execute({ action: 'sniff' });
    assert.equal(sniffed.success, true, 'sniff 成功');
    const sniffData = sniffed.data as { count: number; resources: Array<{ id: string }> };
    assert.equal(sniffData.count, 2, 'sniff 返回两条资源');
    assert.ok(sniffData.resources[0].id.startsWith('res_'), '资源带稳定 id');

    // —— list：缓存可读（旧的 getCachedResources 从未暴露过） ——
    const listed = await tool.execute({ action: 'list' });
    assert.equal(listed.success, true, 'list 成功');
    assert.equal((listed.data as { count: number }).count, 2, 'list 列出已嗅探缓存');

    // —— download：按 id 从**同一实例**的缓存取地址（旧实现跨实例反查会落空） ——
    const downloaded = await tool.execute({ action: 'download', resourceIds: ['res_abc_1'] });
    assert.equal(downloaded.success, true, 'download 成功');
    const downloadData = downloaded.data as { downloads: Array<{ url: string; downloadId: number }> };
    assert.equal(downloadData.downloads.length, 1, 'download 下载一条');
    assert.equal(downloadData.downloads[0].url, 'https://example.com/a.pdf', 'download 用的是嗅探到的真实地址');
    const downloadCall = downloadCalls.find(call => call.method === 'download');
    assert.equal(downloadCall, undefined, '默认只持久化工作区，卡片点击后才下载');
    assert.ok(await readWorkspaceOutput(resourceChatId, 'outputs/a.pdf'));

    const downloadMissing = await tool.execute({ action: 'download', resourceIds: ['res_not_exist'] });
    assert.equal(downloadMissing.success, false, '下载不存在的资源 id 报错');
    assert.match(String(downloadMissing.error), /不在缓存中/, '缺资源报错可读');

    // —— fetch：直链下载（无需先嗅探） ——
    const fetched = await tool.execute({ action: 'fetch', url: 'https://example.com/direct.bin' });
    assert.equal(fetched.success, true, 'fetch 成功');
    assert.equal((fetched.data as { filename: string }).filename, 'direct.bin', 'fetch 从 URL 推断文件名');

    // —— intercept ——
    const started = await tool.execute({ action: 'intercept', operation: 'start', extraExtensions: ['JPG', '.png'] });
    assert.equal(started.success, true, 'intercept start 成功');
    const startData = started.data as { activeExtensions: string[] };
    assert.ok(startData.activeExtensions.includes('jpg'), '扩展名归一化为小写');
    assert.ok(startData.activeExtensions.includes('png'), '扩展名归一化去点');
    assert.ok(startData.activeExtensions.includes('pdf'), '默认扩展名保留');

    const state = await tool.execute({ action: 'intercept', operation: 'state' });
    assert.equal(state.success, true, 'intercept state 成功');
    assert.equal((state.data as { enabled: boolean }).enabled, true, 'state 报告拦截开启');

    const stopped = await tool.execute({ action: 'intercept', operation: 'stop' });
    assert.equal(stopped.success, true, 'intercept stop 成功');

    // —— captured ——
    const capturedList = await tool.execute({ action: 'captured', operation: 'list' });
    assert.equal(capturedList.success, true, 'captured list 成功');
    const capturedData = capturedList.data as { count: number; totalCount: number; files: Array<{ sizeText: string }> };
    assert.equal(capturedData.count, 2, 'captured list 列出两份副本');
    assert.equal(capturedData.totalCount, 2, 'captured list 回传总数');
    assert.equal(capturedData.files[0].sizeText, '1 KB', '副本大小可读化');

    const capturedGet = await tool.execute({ action: 'captured', operation: 'get', fileId: 'cap-1' });
    assert.equal(capturedGet.success, true, 'captured get 成功');
    assert.equal((capturedGet.data as { id: string }).id, 'cap-1', 'captured get 回传副本元数据');

    const capturedClear = await tool.execute({ action: 'captured', operation: 'clear' });
    assert.equal(capturedClear.success, true, 'captured clear 成功');
    assert.equal((capturedClear.data as { clearedCount: number }).clearedCount, 2, 'captured clear 回传清理条数');

    // —— export：副本复制到当前会话工作区 ——
    const exported = await tool.execute({ action: 'export', fileId: 'cap-1' });
    assert.equal(exported.success, true, 'export 成功');
    const exportedFile = (exported.data as { file: { path: string; marker: string } }).file;
    assert.match(exportedFile.marker, /^<workspace-file /);
    assert.equal(await (await readWorkspaceOutput(resourceChatId, exportedFile.path))?.text(), 'captured');

    // —— status ——
    const status = await tool.execute({ action: 'status' });
    assert.equal(status.success, true, 'status 成功');
    const statusData = status.data as { interception: { enabled: boolean }; captured: { count: number }; sniffedCache: { count: number } };
    assert.equal(statusData.interception.enabled, true, 'status 报告拦截状态');
    assert.equal(statusData.captured.count, 2, 'status 报告副本数');
    assert.equal(statusData.sniffedCache.count, 2, 'status 报告嗅探缓存数');

    // —— 失败路径：后台命令失败时给出精准原因 ——
    const runtimeStub = chromeStub.runtime as { sendMessage: (message: unknown) => Promise<unknown> };
    const originalSend = runtimeStub.sendMessage;
    runtimeStub.sendMessage = async (message: unknown) =>
      (message as { command?: string }).command === 'getInterceptionState'
        ? { success: false, error: '存储读取失败' }
        : originalSend(message);

    const stateFailed = await tool.execute({ action: 'intercept', operation: 'state' });
    assert.equal(stateFailed.success, false, '后台命令失败时工具返回失败');
    assert.match(String(stateFailed.error), /查询拦截状态失败/, '失败文案带动作名');
    assert.match(String(stateFailed.error), /存储读取失败/, '失败文案带后台原因');

    runtimeStub.sendMessage = async () => undefined;
    const noResponse = await tool.execute({ action: 'captured', operation: 'list' });
    assert.equal(noResponse.success, false, '后台无响应时返回失败而不是抛错');
    assert.match(String(noResponse.error), /后台/, '无响应报错可读');

    runtimeStub.sendMessage = originalSend;
  } finally {
    restoreStubs();
  }
}

console.log('[downloads-resources] 下载管理器与资源捕获工具契约通过');

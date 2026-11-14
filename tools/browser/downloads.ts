/**
 * 统一下载工具（browser_downloads）
 *
 * 覆盖 Chrome 下载管理器（chrome.downloads）的完整生命周期。
 * 合并掉的旧工具（**旧名全仓禁绝**，防回潮断言见 tests/tools/tools.test.ts）：
 *   - get_downloads_status（只读下载历史/进度，Markdown 表格输出）
 *
 * 相对旧工具**扩展**的能力边界（全部是 Chrome 已支持、旧代码从未用过的 API）：
 *   - cancel   取消进行中的下载（chrome.downloads.cancel）
 *   - pause    暂停下载（chrome.downloads.pause）
 *   - resume   恢复下载（chrome.downloads.resume）
 *   - erase    清除下载历史条目（chrome.downloads.erase，只清记录不动磁盘文件）
 *   - show     在文件管理器中定位文件（chrome.downloads.show）
 *   - open     打开已下载的文件（chrome.downloads.open）
 *
 * 与其它下载域工具的边界（**刻意不合并**）：
 *   - browser_resources      页面里「有哪些文件可下」→ 嗅探 + 存盘
 *   - browser_download_capture 扩展私有的「下载副本库」→ 拦截 + IndexedDB
 *   - 本工具                浏览器下载管理器（chrome.downloads）→ 队列与历史
 *   三者是三个不同的存储域（DOM 资源 / 扩展 IndexedDB / Chrome 下载库），
 *   混在一个工具里会让模型把「扩展副本」误当成「用户下载目录里的文件」。
 *
 * 错误处理：任何失败都以带精准原因的结果返回，绝不向调用方抛出异常。
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import {
  checkActionMatrix,
  readBooleanField,
  readIntArrayField,
  readNonEmptyStringField,
  readNumberField,
} from './action-args';

/** 七个 action（schema 枚举与运行期校验同源） */
export const DOWNLOADS_ACTIONS = [
  'list',
  'cancel',
  'pause',
  'resume',
  'erase',
  'show',
  'open',
] as const;
export type DownloadsAction = (typeof DOWNLOADS_ACTIONS)[number];

/** 每个 action 允许出现的参数（运行期矩阵，防拼写错误与张冠李戴静默失效） */
const ACTION_PARAMS: Record<DownloadsAction, readonly string[]> = {
  list: ['state', 'limit', 'query', 'orderBy'],
  cancel: ['downloadId'],
  pause: ['downloadId'],
  resume: ['downloadId'],
  erase: ['downloadIds'],
  show: ['downloadId'],
  open: ['downloadId'],
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/** 下载状态枚举（与 chrome.downloads.DownloadItem.state 同名） */
const DOWNLOAD_STATES = ['in_progress', 'complete', 'interrupted', 'all'] as const;
/** 排序字段枚举 */
const DOWNLOAD_ORDER_FIELDS = ['startTime', 'bytesReceived', 'totalBytes'] as const;

interface DownloadsArgs {
  action: DownloadsAction;
  state?: (typeof DOWNLOAD_STATES)[number];
  limit?: number;
  query?: string;
  orderBy?: (typeof DOWNLOAD_ORDER_FIELDS)[number];
  downloadId?: number;
  downloadIds?: number[];
}

type ValidationResult = { error: ToolResult; args?: never } | { error?: never; args: DownloadsArgs };

/** 字节数 → 可读文本 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${Math.round((bytes / Math.pow(1024, index)) * 100) / 100} ${units[index]}`;
}

/**
 * 统一下载管理器工具
 */
export class BrowserDownloadsTool extends BaseBrowserTool {
  name = 'browser_downloads';

  metadata: ToolMetadata = {
    name: 'browser_downloads',
    description: '浏览器下载管理：查询/取消/暂停/恢复/清除历史/定位文件/打开文件（action 驱动）',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['download', 'chrome', 'file', 'manage'],
    permissions: ['downloads'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_downloads',
      description:
        '浏览器下载管理器（chrome.downloads），action 七选一：' +
        'list=查询下载历史与进行中任务（state=in_progress/complete/interrupted/all，query 按文件名或地址过滤，orderBy=startTime/bytesReceived/totalBytes 一律降序）；' +
        'cancel=取消进行中的下载（downloadId）；' +
        'pause=暂停下载（downloadId）；' +
        'resume=恢复已暂停的下载（downloadId）；' +
        'erase=清除下载历史条目（downloadIds 批量；只清浏览器的下载记录，**不删除磁盘上的文件**）；' +
        'show=在系统文件管理器中定位已下载的文件（downloadId）；' +
        'open=用系统默认程序打开已下载的文件（downloadId）。' +
        '下载 id 来自本工具 list 的返回（id 字段）或 browser_resources 的下载结果（downloadId 字段）——' +
        '两者共用同一个 chrome.downloads id 空间，可直接串联。' +
        '本工具管「浏览器下载管理器」；页面里有哪些文件可下走 browser_resources，' +
        '扩展私有的下载副本库走 browser_download_capture，三者是不同的存储域。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: [...DOWNLOADS_ACTIONS],
            description:
              'list=查询下载；cancel=取消；pause=暂停；resume=恢复；erase=清除历史记录；show=定位文件；open=打开文件',
          },
          state: {
            type: 'string',
            enum: [...DOWNLOAD_STATES],
            description: '仅 action="list"：按状态过滤（默认 all = 全部）',
          },
          limit: {
            type: 'number',
            description: `仅 action="list"：返回条数上限（1~${MAX_LIMIT}，默认 ${DEFAULT_LIMIT}）`,
          },
          query: {
            type: 'string',
            description: '仅 action="list"：按文件名或地址子串过滤（大小写不敏感）',
          },
          orderBy: {
            type: 'string',
            enum: [...DOWNLOAD_ORDER_FIELDS],
            description: '仅 action="list"：排序字段（一律降序，默认 startTime）',
          },
          downloadId: {
            type: 'number',
            description: 'cancel/pause/resume/show/open 必填：下载任务 ID（来自 list 的 id 字段）',
          },
          downloadIds: {
            type: 'array',
            items: { type: 'number' },
            description: '仅 action="erase"：要清除历史记录的下载 ID 列表（批量）',
          },
        },
        required: ['action'],
      },
    },
  };

  async execute(rawArgs: unknown): Promise<ToolResult> {
    const validated = this.validate(rawArgs);
    if (validated.error) return validated.error;
    const args = validated.args;

    try {
      switch (args.action) {
        case 'list':
          return await this.handleList(args);
        case 'cancel':
          return await this.handleCancel(args);
        case 'pause':
          return await this.handlePause(args);
        case 'resume':
          return await this.handleResume(args);
        case 'erase':
          return await this.handleErase(args);
        case 'show':
          return await this.handleShow(args);
        case 'open':
          return await this.handleOpen(args);
      }
    } catch (error) {
      return this.createErrorResponse(
        `下载操作 ${args.action} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ──── 参数校验 ────

  private validate(rawArgs: unknown): ValidationResult {
    const matrix = checkActionMatrix<DownloadsAction>(rawArgs, {
      actions: DOWNLOADS_ACTIONS,
      params: ACTION_PARAMS,
    });
    if (!matrix.ok) return { error: this.createErrorResponse(matrix.error) };
    const { action, input } = matrix;

    const args: DownloadsArgs = { action };

    if (input.state !== undefined) {
      const state = input.state;
      if (typeof state !== 'string' || !(DOWNLOAD_STATES as readonly string[]).includes(state)) {
        return {
          error: this.createErrorResponse(
            `state 必须是 ${DOWNLOAD_STATES.map(s => `"${s}"`).join('/')} 之一，实际收到 ${JSON.stringify(state ?? null)}`,
          ),
        };
      }
      args.state = state as (typeof DOWNLOAD_STATES)[number];
    }

    if (input.orderBy !== undefined) {
      const orderBy = input.orderBy;
      if (typeof orderBy !== 'string' || !(DOWNLOAD_ORDER_FIELDS as readonly string[]).includes(orderBy)) {
        return {
          error: this.createErrorResponse(
            `orderBy 必须是 ${DOWNLOAD_ORDER_FIELDS.map(s => `"${s}"`).join('/')} 之一，实际收到 ${JSON.stringify(orderBy ?? null)}`,
          ),
        };
      }
      args.orderBy = orderBy as (typeof DOWNLOAD_ORDER_FIELDS)[number];
    }

    const limit = readNumberField(input, 'limit', { min: 1, max: MAX_LIMIT, integer: true });
    if (!limit.ok) return { error: this.createErrorResponse(limit.error) };
    if (limit.value !== undefined) args.limit = limit.value;

    const query = readNonEmptyStringField(input, 'query');
    if (!query.ok) return { error: this.createErrorResponse(query.error) };
    if (query.value !== undefined) args.query = query.value;

    const downloadId = readNumberField(input, 'downloadId', { min: 0, integer: true });
    if (!downloadId.ok) return { error: this.createErrorResponse(downloadId.error) };
    if (downloadId.value !== undefined) args.downloadId = downloadId.value;

    if (input.downloadIds !== undefined) {
      const ids = readIntArrayField(input, 'downloadIds', {
        min: 0,
        emptyError: 'downloadIds 必须是非空的数字数组（下载 ID 列表）',
      });
      if (!ids.ok) return { error: this.createErrorResponse(ids.error) };
      args.downloadIds = ids.value;
    }

    // action 级必填
    if (action !== 'list' && action !== 'erase' && args.downloadId === undefined) {
      return {
        error: this.createErrorResponse(
          `action="${action}" 需要 downloadId（先用 action="list" 拿到下载任务的 id）`,
        ),
      };
    }
    if (action === 'erase' && args.downloadIds === undefined) {
      return { error: this.createErrorResponse('action="erase" 需要 downloadIds（要清除历史记录的下载 ID 列表）') };
    }

    return { args };
  }

  // ──── action 实现 ────

  /** list：查询下载历史与进行中任务 */
  private async handleList(args: DownloadsArgs): Promise<ToolResult> {
    const state = args.state ?? 'all';
    const limit = args.limit ?? DEFAULT_LIMIT;
    const query = args.query ?? '';
    const orderBy = args.orderBy ?? 'startTime';

    const searchQuery: chrome.downloads.DownloadQuery = {
      limit,
      orderBy: [`-${orderBy}`],
    };
    if (state !== 'all') searchQuery.state = state;
    if (query) searchQuery.query = [query];

    const downloads = await chrome.downloads.search(searchQuery);

    const items = downloads.map(item => ({
      id: String(item.id),
      filename: item.filename,
      url: item.url,
      finalUrl: item.finalUrl || item.url,
      state: item.state,
      paused: item.paused,
      bytesReceived: item.bytesReceived,
      totalBytes: item.totalBytes,
      fileSize: formatBytes(item.totalBytes || item.bytesReceived),
      progress: item.totalBytes > 0 ? Math.round((item.bytesReceived / item.totalBytes) * 100) : 0,
      startTime: item.startTime,
      endTime: item.endTime,
      mime: item.mime,
      exists: item.exists,
      danger: item.danger,
      error: item.error,
    }));

    return this.createSuccessResponse(
      {
        count: items.length,
        items,
        summary: {
          total: items.length,
          inProgress: items.filter(item => item.state === 'in_progress').length,
          completed: items.filter(item => item.state === 'complete').length,
          interrupted: items.filter(item => item.state === 'interrupted').length,
          totalSize: formatBytes(items.reduce((sum, item) => sum + item.totalBytes, 0)),
          downloadedSize: formatBytes(items.reduce((sum, item) => sum + item.bytesReceived, 0)),
        },
        filters: { state, limit, query, orderBy },
      },
      `共 ${items.length} 条下载记录`,
    );
  }

  /** cancel：取消进行中的下载 */
  private async handleCancel(args: DownloadsArgs): Promise<ToolResult> {
    await chrome.downloads.cancel(args.downloadId!);
    return this.createSuccessResponse(
      { downloadId: args.downloadId, cancelled: true },
      `已取消下载 ${args.downloadId}`,
    );
  }

  /** pause：暂停下载 */
  private async handlePause(args: DownloadsArgs): Promise<ToolResult> {
    await chrome.downloads.pause(args.downloadId!);
    return this.createSuccessResponse(
      { downloadId: args.downloadId, paused: true },
      `已暂停下载 ${args.downloadId}`,
    );
  }

  /** resume：恢复已暂停的下载 */
  private async handleResume(args: DownloadsArgs): Promise<ToolResult> {
    await chrome.downloads.resume(args.downloadId!);
    return this.createSuccessResponse(
      { downloadId: args.downloadId, resumed: true },
      `已恢复下载 ${args.downloadId}`,
    );
  }

  /** erase：清除下载历史条目（不动磁盘文件） */
  private async handleErase(args: DownloadsArgs): Promise<ToolResult> {
    const ids = args.downloadIds!;
    const erasedIds: number[] = [];
    const failures: Array<{ downloadId: number; reason: string }> = [];

    for (const id of ids) {
      try {
        // chrome.downloads.erase 的查询类型只暴露单个 id（批量 ids 变体不在
        // @types/chrome 里）——逐条清除，语义与批量一致，失败可精确定位到条目。
        await chrome.downloads.erase({ id });
        erasedIds.push(id);
      } catch (error) {
        failures.push({ downloadId: id, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    if (erasedIds.length === 0) {
      const reason = failures.map(item => `${item.downloadId}: ${item.reason}`).join('；');
      return this.createErrorResponse(`清除下载历史失败（未删除任何记录）——${reason}`);
    }

    return this.createSuccessResponse(
      { erasedIds, erasedCount: erasedIds.length, failures },
      `已清除 ${erasedIds.length} 条下载历史记录（磁盘文件未删除）`,
    );
  }

  /** show：在文件管理器中定位文件 */
  private async handleShow(args: DownloadsArgs): Promise<ToolResult> {
    await chrome.downloads.show(args.downloadId!);
    return this.createSuccessResponse(
      { downloadId: args.downloadId, shown: true },
      `已在文件管理器中定位下载 ${args.downloadId}`,
    );
  }

  /** open：用系统默认程序打开文件 */
  private async handleOpen(args: DownloadsArgs): Promise<ToolResult> {
    await chrome.downloads.open(args.downloadId!);
    return this.createSuccessResponse(
      { downloadId: args.downloadId, opened: true },
      `已打开下载 ${args.downloadId}`,
    );
  }
}

// 导出工具实例
export const browserDownloadsTool = new BrowserDownloadsTool();

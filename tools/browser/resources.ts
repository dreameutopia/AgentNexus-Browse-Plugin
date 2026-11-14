/**
 * Resource discovery and capture management. download/fetch/export persist deliverables
 * to the current chat's outputs/ and return WorkspaceArtifact descriptors. Capture records
 * remain a shared source library; browser_downloads manages the separate browser queue.
 * Only explicit openAfterDownload requests also export a browser download.
 */

import { saveWorkspaceOutput } from '@/utils/python-workspace/store';
import { requireWorkspaceChatId, type WorkspaceArtifact } from '@/utils/python-workspace/artifact-contract';
import { fetchArtifactBlob } from '@/utils/python-workspace/artifact-fetch';
import { downloadWorkspaceArtifact } from '@/utils/python-workspace/artifact-download';
import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import {
  checkActionMatrix,
  readBooleanField,
  readNonEmptyStringField,
  readNumberField,
  readStringArrayField,
} from './action-args';

/** 八个 action（schema 枚举与运行期校验同源） */
export const RESOURCES_ACTIONS = [
  'sniff',
  'list',
  'download',
  'fetch',
  'intercept',
  'captured',
  'export',
  'status',
] as const;
export type ResourcesAction = (typeof RESOURCES_ACTIONS)[number];

/** intercept / captured 的子动作 */
const INTERCEPT_ACTIONS = ['start', 'stop', 'state'] as const;
const CAPTURED_ACTIONS = ['list', 'get', 'clear'] as const;

/** 每个 action 允许出现的参数（运行期矩阵，防拼写错误与张冠李戴静默失效） */
const ACTION_PARAMS: Record<ResourcesAction, readonly string[]> = {
  sniff: ['fileTypes', 'maxResults', 'includeImages', 'tabId'],
  list: [],
  download: ['resourceIds', 'downloadPath', 'openAfterDownload'],
  fetch: ['url', 'filename', 'openAfterDownload'],
  intercept: ['operation', 'extraExtensions'],
  captured: ['operation', 'fileId', 'limit', 'offset'],
  export: ['fileId', 'filename'],
  status: [],
};

const DEFAULT_SNIFF_LIMIT = 10;
const MAX_SNIFF_LIMIT = 100;
const DEFAULT_CAPTURED_LIMIT = 50;
const MAX_CAPTURED_LIMIT = 200;

/** 默认拦截的文件类型（与旧拦截器同源） */
const DEFAULT_INTERCEPT_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'mp4', 'mp3', 'zip', 'rar', 'md', 'xlsx', 'xls',
];

/** 嗅探到的资源 */
interface ResourceInfo {
  id: string;
  url: string;
  filename: string;
  fileType: string;
  size?: string;
  title?: string;
  description?: string;
  source?: 'dom' | 'network' | 'platform';
}

/** 嗅探缓存条目 */
interface CachedResource {
  downloadUrl: string;
  info: ResourceInfo;
  timestamp: number;
}

interface ResourcesArgs {
  action: ResourcesAction;
  fileTypes?: string[];
  maxResults?: number;
  includeImages?: boolean;
  tabId?: number;
  resourceIds?: string[];
  downloadPath?: string;
  openAfterDownload?: boolean;
  url?: string;
  filename?: string;
  operation?: string;
  extraExtensions?: string[];
  fileId?: string;
  limit?: number;
  offset?: number;
}

type ValidationResult = { error: ToolResult; args?: never } | { error?: never; args: ResourcesArgs };

/**
 * 统一资源与下载捕获工具
 */
export class BrowserResourcesTool extends BaseBrowserTool {
  name = 'browser_resources';

  /** 嗅探缓存（实例内存；与下载动作共享，不再跨实例反查） */
  private cache = new Map<string, CachedResource>();

  metadata: ToolMetadata = {
    name: 'browser_resources',
    description:
      '页面资源与下载捕获：嗅探/列出/下载/直链下载/下载拦截/捕获副本/导出副本/状态（action 驱动）',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['resource', 'download', 'sniff', 'capture', 'file'],
    permissions: ['downloads', 'scripting'],
    // 清空捕获库需要审批；导出只向本会话工作区复制，不销毁源文件。
    requiresApprovalActions: ['clear'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_resources',
      description:
        '页面资源与下载捕获的统一入口，action 八选一：' +
        'sniff=嗅探当前页可下载的资源（fileTypes 支持扩展名或类别名 document/archive/video/audio/image/code/font/data；includeImages 默认不含图片；结果带 id 供后续 download 用）；' +
        'list=列出已嗅探到的资源缓存；' +
        'download=把嗅探到的资源保存到当前会话工作区 outputs/（resourceIds 来自 sniff/list）；' +
        'fetch=按 URL 获取文件并保存到当前会话工作区 outputs/（无需先嗅探；filename 指定保存名）；' +
        'intercept=下载拦截器开关（operation=start/stop/state；start 可用 extraExtensions 追加扩展名，state 查询当前是否开启与生效列表）——' +
        '开启后浏览器里触发的文件下载会被旁路复制一份到扩展私有库，原下载不受影响；' +
        'captured=已捕获副本库（operation=list/get/clear；get 按 fileId 取元数据）；' +
        'export=把某个捕获副本保存到当前会话工作区 outputs/（fileId；返回统一文件卡片标记）；' +
        'status=拦截器与捕获库的总体状态（是否开着、开着哪些扩展名、已捕获多少份）。' +
        '下载管理器本身的队列/历史/取消/暂停等操作走 browser_downloads（不同的存储域）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: [...RESOURCES_ACTIONS],
            description:
              'sniff=嗅探；list=列出缓存；download=下载嗅探结果；fetch=直链下载；intercept=拦截器开关；captured=捕获副本库；export=导出副本；status=总体状态',
          },
          fileTypes: {
            type: 'array',
            items: { type: 'string' },
            description:
              '仅 action="sniff"：要嗅探的类型（扩展名如 pdf，或类别名 document/archive/video/audio/image/code/font/data）；留空=全部',
          },
          maxResults: {
            type: 'number',
            description: `仅 action="sniff"：最多返回多少条（1~${MAX_SNIFF_LIMIT}，默认 ${DEFAULT_SNIFF_LIMIT}）`,
          },
          includeImages: {
            type: 'boolean',
            description: '仅 action="sniff"：是否包含图片类资源（默认 false）',
          },
          tabId: {
            type: 'number',
            description: '仅 action="sniff"：在指定标签页嗅探（缺省为当前活动标签页）',
          },
          resourceIds: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 action="download"：要下载的资源 id 列表（来自 sniff/list 的 id 字段）',
          },
          downloadPath: {
            type: 'string',
            description: '仅 action="download"：保存文件名（相对 outputs/，允许子目录；留空用资源原名）',
          },
          openAfterDownload: {
            type: 'boolean',
            description: '仅 action="download"/"fetch"：是否额外发起浏览器下载并在完成后打开（默认 false；工作区保存后默认用卡片交付）',
          },
          url: {
            type: 'string',
            description: '仅 action="fetch"：要下载的完整 URL',
          },
          filename: {
            type: 'string',
            description: '仅 action="fetch"/"export"：保存文件名（缺省按 URL 或副本原名推断）',
          },
          operation: {
            type: 'string',
            enum: [...INTERCEPT_ACTIONS, ...CAPTURED_ACTIONS],
            description:
              '仅 action="intercept"/"captured"：子动作。intercept=start/stop/state；captured=list/get/clear',
          },
          extraExtensions: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 action="intercept" operation=start：追加拦截的扩展名（如 ["jpg","png"]）',
          },
          fileId: {
            type: 'string',
            description: '仅 action="captured" operation=get 与 action="export"：捕获副本的 id',
          },
          limit: {
            type: 'number',
            description: `仅 action="captured" operation=list：返回条数上限（1~${MAX_CAPTURED_LIMIT}，默认 ${DEFAULT_CAPTURED_LIMIT}）`,
          },
          offset: {
            type: 'number',
            description: '仅 action="captured" operation=list：偏移量（分页用，默认 0）',
          },
        },
        required: ['action'],
      },
    },
  };

  async execute(rawArgs: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    const validated = this.validate(rawArgs);
    if (validated.error) return validated.error;
    const args = validated.args;

    try {
      switch (args.action) {
        case 'sniff':
          return await this.handleSniff(args);
        case 'list':
          return await this.handleList();
        case 'download':
          return await this.handleDownload(args, context);
        case 'fetch':
          return await this.handleFetch(args, context);
        case 'intercept':
          return await this.handleIntercept(args);
        case 'captured':
          return await this.handleCaptured(args);
        case 'export':
          return await this.handleExport(args, context);
        case 'status':
          return await this.handleStatus();
      }
    } catch (error) {
      return this.createErrorResponse(
        `资源操作 ${args.action} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ──── 参数校验 ────

  private validate(rawArgs: unknown): ValidationResult {
    const matrix = checkActionMatrix<ResourcesAction>(rawArgs, {
      actions: RESOURCES_ACTIONS,
      params: ACTION_PARAMS,
    });
    if (!matrix.ok) return { error: this.createErrorResponse(matrix.error) };
    const { action, input } = matrix;

    const args: ResourcesArgs = { action };

    if (input.fileTypes !== undefined) {
      const types = readStringArrayField(input, 'fileTypes', {
        emptyError: 'fileTypes 必须是非空字符串数组（扩展名或类别名）',
      });
      if (!types.ok) return { error: this.createErrorResponse(types.error) };
      args.fileTypes = types.value;
    }

    if (input.extraExtensions !== undefined) {
      const exts = readStringArrayField(input, 'extraExtensions', {
        emptyError: 'extraExtensions 必须是非空字符串数组（扩展名，如 ["jpg"]）',
      });
      if (!exts.ok) return { error: this.createErrorResponse(exts.error) };
      args.extraExtensions = exts.value;
    }

    if (input.resourceIds !== undefined) {
      const ids = readStringArrayField(input, 'resourceIds', {
        emptyError: 'resourceIds 必须是非空字符串数组（资源 id，来自 sniff/list）',
      });
      if (!ids.ok) return { error: this.createErrorResponse(ids.error) };
      args.resourceIds = ids.value;
    }

    const maxResults = readNumberField(input, 'maxResults', {
      min: 1,
      max: MAX_SNIFF_LIMIT,
      integer: true,
    });
    if (!maxResults.ok) return { error: this.createErrorResponse(maxResults.error) };
    if (maxResults.value !== undefined) args.maxResults = maxResults.value;

    const limit = readNumberField(input, 'limit', { min: 1, max: MAX_CAPTURED_LIMIT, integer: true });
    if (!limit.ok) return { error: this.createErrorResponse(limit.error) };
    if (limit.value !== undefined) args.limit = limit.value;

    const offset = readNumberField(input, 'offset', { min: 0, integer: true });
    if (!offset.ok) return { error: this.createErrorResponse(offset.error) };
    if (offset.value !== undefined) args.offset = offset.value;

    const tabId = readNumberField(input, 'tabId', { min: 0, integer: true });
    if (!tabId.ok) return { error: this.createErrorResponse(tabId.error) };
    if (tabId.value !== undefined) args.tabId = tabId.value;

    for (const key of ['includeImages', 'openAfterDownload'] as const) {
      const field = readBooleanField(input, key);
      if (!field.ok) return { error: this.createErrorResponse(field.error) };
      if (field.value !== undefined) args[key] = field.value;
    }

    for (const key of ['url', 'filename', 'fileId', 'downloadPath'] as const) {
      const field = readNonEmptyStringField(input, key);
      if (!field.ok) return { error: this.createErrorResponse(field.error) };
      if (field.value !== undefined) args[key] = field.value;
    }

    if (input.operation !== undefined) {
      const operation = input.operation;
      if (typeof operation !== 'string') {
        return { error: this.createErrorResponse('operation 必须是字符串') };
      }
      args.operation = operation;
    }

    // ── action 级必填与子动作校验 ──
    if (action === 'download' && !args.resourceIds?.length) {
      return { error: this.createErrorResponse('action="download" 需要 resourceIds（先用 action="sniff" 拿到资源 id）') };
    }
    if (action === 'fetch' && !args.url) {
      return { error: this.createErrorResponse('action="fetch" 需要 url（要下载的完整地址）') };
    }
    if (action === 'intercept') {
      if (!args.operation) {
        return { error: this.createErrorResponse('action="intercept" 需要 operation（start/stop/state）') };
      }
      if (!(INTERCEPT_ACTIONS as readonly string[]).includes(args.operation)) {
        return {
          error: this.createErrorResponse(
            `operation 必须是 ${INTERCEPT_ACTIONS.map(o => `"${o}"`).join('/')} 之一（action="intercept"），实际收到 ${JSON.stringify(args.operation)}`,
          ),
        };
      }
    }
    if (action === 'captured') {
      if (!args.operation) {
        return { error: this.createErrorResponse('action="captured" 需要 operation（list/get/clear）') };
      }
      if (!(CAPTURED_ACTIONS as readonly string[]).includes(args.operation)) {
        return {
          error: this.createErrorResponse(
            `operation 必须是 ${CAPTURED_ACTIONS.map(o => `"${o}"`).join('/')} 之一（action="captured"），实际收到 ${JSON.stringify(args.operation)}`,
          ),
        };
      }
      if (args.operation === 'get' && !args.fileId) {
        return { error: this.createErrorResponse('action="captured" operation="get" 需要 fileId（副本 id）') };
      }
    }
    if (action === 'export' && !args.fileId) {
      return { error: this.createErrorResponse('action="export" 需要 fileId（要导出的副本 id）') };
    }

    return { args };
  }

  // ──── action 实现 ────

  /** sniff：嗅探页面可下载资源 */
  private async handleSniff(args: ResourcesArgs): Promise<ToolResult> {
    const fileTypes = args.fileTypes ?? [];
    const maxResults = args.maxResults ?? DEFAULT_SNIFF_LIMIT;
    const includeImages = args.includeImages === true;

    const tab = args.tabId !== undefined
      ? await chrome.tabs.get(args.tabId)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

    if (!tab || tab.id === undefined) {
      return this.createErrorResponse(
        args.tabId !== undefined
          ? `标签页 ${args.tabId} 不存在或已关闭`
          : '没有可用的活动标签页（无法嗅探）',
      );
    }

    // 注入脚本扫描：与 browser_observe 同一注入通道（ISOLATED 世界）。
    // 用内联函数而非注入文件，保证扫描口径单一（旧的注入脚本与兜底函数
    // 覆盖面不一致：注入脚本不扫 <a> 与 [download]）。
    let resources: ResourceInfo[] = [];
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: sniffResourcesInPage,
        args: [{ fileTypes, maxResults, includeImages }],
      });
      const payload = results?.[0]?.result;
      if (Array.isArray(payload)) resources = payload as ResourceInfo[];
    } catch (error) {
      return this.createErrorResponse(
        `在标签页 ${tab.id} 嗅探资源失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 缓存（合并式，保留历史嗅探结果）
    const timestamp = Date.now();
    for (const resource of resources) {
      this.cache.set(resource.id, { downloadUrl: resource.url, info: resource, timestamp });
    }

    return this.createSuccessResponse(
      {
        count: resources.length,
        totalCached: this.cache.size,
        resources,
        filters: { fileTypes, maxResults, includeImages },
        tabId: tab.id,
        url: tab.url,
      },
      `嗅探到 ${resources.length} 个资源`,
    );
  }

  /** list：列出已嗅探的资源缓存 */
  private async handleList(): Promise<ToolResult> {
    const resources = [...this.cache.values()].map(entry => ({
      id: entry.info.id,
      url: entry.info.url,
      filename: entry.info.filename,
      fileType: entry.info.fileType,
      size: entry.info.size,
      title: entry.info.title,
      description: entry.info.description,
      source: entry.info.source,
      cachedAt: new Date(entry.timestamp).toISOString(),
    }));
    return this.createSuccessResponse(
      { count: resources.length, resources },
      `已缓存 ${resources.length} 个资源`,
    );
  }

  /** download：获取嗅探资源并持久化到当前会话 */
  private async handleDownload(args: ResourcesArgs, context?: ToolExecutionContext): Promise<ToolResult> {
    requireWorkspaceChatId(context?.chatId);
    const ids = args.resourceIds!;
    const downloads: Array<Record<string, unknown>> = [];
    const errors: string[] = [];

    for (const id of ids) {
      const entry = this.cache.get(id);
      if (!entry) {
        errors.push(`资源 ${id} 不在缓存中（请先 action="sniff" 重新嗅探）`);
        continue;
      }
      const filename = args.downloadPath || entry.info.filename;
      try {
        const saved = await this.acquireOutput(entry.downloadUrl, filename, args.openAfterDownload === true, context);
        downloads.push({
          id,
          filename: saved.file.name,
          url: entry.downloadUrl,
          ...saved,
          status: 'success',
        });
      } catch (error) {
        errors.push(`下载 ${entry.info.filename} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (downloads.length === 0 && errors.length > 0) {
      return this.createErrorResponse(`全部下载失败：${errors.join('；')}`);
    }

    return this.createSuccessResponse(
      {
        downloads,
        files: downloads.map(item => item.file),
        errors,
        summary: { total: ids.length, successful: downloads.length, failed: errors.length },
      },
      `已保存 ${downloads.length}/${ids.length} 个资源到当前会话工作区`,
    );
  }

  /** fetch：按 URL 获取文件并保存到当前会话工作区 outputs/ */
  private async handleFetch(args: ResourcesArgs, context?: ToolExecutionContext): Promise<ToolResult> {
    const url = args.url!;
    const filename = args.filename || filenameFromUrl(url);
    try {
      const saved = await this.acquireOutput(url, filename, args.openAfterDownload === true, context);
      return this.createSuccessResponse(
        { url, filename: saved.file.name, ...saved, files: [saved.file], status: 'success' },
        `已保存到当前会话工作区：${saved.file.path}`,
      );
    } catch (error) {
      return this.createErrorResponse(
        `下载 ${url} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** intercept：下载拦截器开关 */
  private async handleIntercept(args: ResourcesArgs): Promise<ToolResult> {
    const operation = args.operation!;

    if (operation === 'start') {
      const extensions = [...new Set([
        ...DEFAULT_INTERCEPT_EXTENSIONS,
        ...(args.extraExtensions ?? []).map(ext => ext.toLowerCase().replace(/^\./, '')),
      ])];
      const response = await this.sendBackground({ command: 'startInterception', payload: { interceptExtensions: extensions } });
      if (!response?.success) {
        return this.createErrorResponse(`开启下载拦截失败：${response?.error ?? '后台未返回成功状态'}`);
      }
      return this.createSuccessResponse(
        { status: 'enabled', activeExtensions: extensions },
        `下载拦截已开启（生效扩展名：${extensions.join(', ')}）`,
      );
    }

    if (operation === 'stop') {
      const response = await this.sendBackground({ command: 'stopInterception' });
      if (!response?.success) {
        return this.createErrorResponse(`停止下载拦截失败：${response?.error ?? '后台未返回成功状态'}`);
      }
      return this.createSuccessResponse({ status: 'disabled' }, '下载拦截已关闭');
    }

    // state
    const state = await this.sendBackground({ command: 'getInterceptionState' });
    if (!state?.success) {
      return this.createErrorResponse(`查询拦截状态失败：${state?.error ?? '后台未返回成功状态'}`);
    }
    const activeExtensions = Array.isArray(state.extensionsToIntercept)
      ? (state.extensionsToIntercept as string[])
      : [];
    return this.createSuccessResponse(
      {
        enabled: state.isEnabled === true,
        activeExtensions,
      },
      state.isEnabled
        ? `拦截已开启（${activeExtensions.length} 个扩展名）`
        : '拦截未开启',
    );
  }

  /** captured：已捕获副本库（list/get/clear） */
  private async handleCaptured(args: ResourcesArgs): Promise<ToolResult> {
    const operation = args.operation!;

    if (operation === 'list') {
      const limit = args.limit ?? DEFAULT_CAPTURED_LIMIT;
      const offset = args.offset ?? 0;
      const response = await this.sendBackground({
        command: 'getCapturedFileList',
        payload: { limit, offset },
      });
      if (!response?.success) {
        return this.createErrorResponse(`读取捕获副本列表失败：${response?.error ?? '后台未返回成功状态'}`);
      }
      const files = Array.isArray(response.fileList) ? response.fileList : [];
      return this.createSuccessResponse(
        {
          totalCount: response.totalCount ?? files.length,
          count: files.length,
          offset,
          limit,
          files: files.map((file: Record<string, unknown>) => ({
            id: file.id,
            filename: file.filename,
            mimeType: file.mimeType,
            size: file.size,
            sizeText: typeof file.size === 'number' ? formatBytes(file.size) : 'Unknown',
            capturedAt: file.capturedAt,
            capturedAtIso: typeof file.capturedAt === 'number' ? new Date(file.capturedAt).toISOString() : undefined,
            sourcePageUrl: file.sourcePageUrl,
          })),
        },
        `已捕获 ${files.length} 份副本（共 ${response.totalCount ?? files.length} 份）`,
      );
    }

    if (operation === 'get') {
      const response = await this.sendBackground({
        command: 'getFileDetailsById',
        payload: { id: args.fileId },
      });
      if (!response?.success) {
        return this.createErrorResponse(
          `读取副本 ${args.fileId} 失败：${response?.error ?? '后台未返回成功状态'}`,
        );
      }
      const details = response.fileDetails as Record<string, unknown> | undefined;
      if (!details || typeof details !== 'object') {
        return this.createErrorResponse(`副本 ${args.fileId} 不存在（可能已被清除）`);
      }
      const size = typeof details.size === 'number' ? details.size : undefined;
      return this.createSuccessResponse(
        {
          id: details.id,
          filename: details.filename,
          mimeType: details.mimeType,
          size,
          sizeText: size !== undefined ? formatBytes(size) : 'Unknown',
          capturedAt: details.capturedAt,
          sourcePageUrl: details.sourcePageUrl,
          contentLength: typeof details.contentLength === 'number' ? details.contentLength : undefined,
          note: '副本正文为二进制内容；用 action="export"（带 fileId）保存到当前会话工作区并交付文件卡片',
        },
        `副本 ${args.fileId} 元数据`,
      );
    }

    // clear
    const response = await this.sendBackground({ command: 'clearAllCapturedFiles' });
    if (!response?.success) {
      return this.createErrorResponse(`清空捕获副本失败：${response?.error ?? '后台未返回成功状态'}`);
    }
    return this.createSuccessResponse(
      { clearedCount: response.clearedCount ?? 0 },
      `已清空 ${response.clearedCount ?? 0} 份捕获副本`,
    );
  }

  /** export：复制捕获副本到当前会话，不经 JSON 消息传输文件正文 */
  private async handleExport(args: ResourcesArgs, context?: ToolExecutionContext): Promise<ToolResult> {
    const chatId = requireWorkspaceChatId(context?.chatId);
    // IndexedDB is shared across extension contexts; never send Blob bytes over JSON messaging.
    const { downloadDB } = await import('@/utils/download-database');
    const record = await downloadDB.getFileById(args.fileId!);
    if (!record) return this.createErrorResponse('捕获副本不存在：' + args.fileId);
    const file = await saveWorkspaceOutput(chatId, 'outputs/' + (args.filename || record.filename), record.blobData, context?.signal);
    return this.createSuccessResponse(
      { id: args.fileId, filename: file.name, file, files: [file], exported: true },
      '已保存到当前会话工作区：' + file.path,
    );
  }

  /** status：拦截器与捕获库总体状态 */
  private async handleStatus(): Promise<ToolResult> {
    const [state, list] = await Promise.all([
      this.sendBackground({ command: 'getInterceptionState' }),
      this.sendBackground({ command: 'getCapturedFileList' }),
    ]);

    const files = list?.success && Array.isArray(list.fileList) ? list.fileList : [];
    const totalBytes = files.reduce(
      (sum: number, file: Record<string, unknown>) => sum + (typeof file.size === 'number' ? file.size : 0),
      0,
    );

    return this.createSuccessResponse(
      {
        interception: {
          enabled: state?.success === true && state.isEnabled === true,
          activeExtensions: state?.success === true ? (state.extensionsToIntercept ?? []) : [],
          available: state?.success === true,
        },
        captured: {
          count: files.length,
          totalBytes,
          totalSizeText: formatBytes(totalBytes),
        },
        sniffedCache: { count: this.cache.size },
      },
      `拦截${state?.success === true && state.isEnabled === true ? '已开启' : '未开启'}，已捕获 ${files.length} 份副本`,
    );
  }

  // ──── 内部工具 ────

  /** 发消息到 background 并读取响应（统一处理「无响应」形态） */
  private async sendBackground(message: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    let response: unknown;
    try {
      response = await chrome.runtime.sendMessage(message);
    } catch (error) {
      throw new Error(
        `后台通信失败（${message.command ?? '未知命令'}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response || typeof response !== 'object') {
      throw new Error(`后台对 ${message.command ?? '未知命令'} 未返回有效响应`);
    }
    return response as Record<string, unknown>;
  }

  private async acquireOutput(url: string, name: string, open: boolean, context?: ToolExecutionContext): Promise<{
    file: WorkspaceArtifact; downloadId?: number; warning?: string;
  }> {
    const chatId = requireWorkspaceChatId(context?.chatId);
    const blob = await fetchArtifactBlob(url, context?.signal);
    const file = await saveWorkspaceOutput(chatId, 'outputs/' + name, blob, context?.signal);
    if (!open) return { file };
    try {
      context?.signal?.throwIfAborted();
      const downloadId = await downloadWorkspaceArtifact(file, blob);
      this.openWhenComplete(downloadId);
      return { file, downloadId };
    } catch (error) {
      return { file, warning: '文件已保存；额外下载未发起：' + (error instanceof Error ? error.message : String(error)) };
    }
  }

  /** 下载完成后打开文件（后台监听，最多等 60 秒） */
  private openWhenComplete(downloadId: number): void {
    const listener = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        chrome.downloads.onChanged.removeListener(listener);
        try {
          chrome.downloads.open(downloadId);
        } catch {
          // 打开失败不影响下载本身——下载已完成即达成目标
        }
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    setTimeout(() => chrome.downloads.onChanged.removeListener(listener), 60_000);
  }
}

/** 从 URL 推断文件名 */
function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').pop();
    return last && last.length > 0 ? decodeURIComponent(last) : 'download.bin';
  } catch {
    return 'download.bin';
  }
}

/** 字节数 → 可读文本 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${Math.round((bytes / Math.pow(1024, index)) * 100) / 100} ${units[index]}`;
}

/**
 * 页面内资源嗅探函数（注入执行，必须自包含——不能引用模块作用域变量）。
 */
function sniffResourcesInPage(options: {
  fileTypes: string[];
  maxResults: number;
  includeImages: boolean;
}): ResourceInfo[] {
  const { fileTypes, maxResults, includeImages } = options;
  const resources: ResourceInfo[] = [];
  const seenUrls = new Set<string>();

  const fileTypeMap: Record<string, string[]> = {
    document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
    video: ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp'],
    audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'],
    image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff'],
    code: ['js', 'css', 'html', 'json', 'xml', 'py', 'java', 'cpp', 'c', 'php', 'rb', 'go'],
    font: ['ttf', 'otf', 'woff', 'woff2', 'eot'],
    data: ['csv', 'sql', 'db', 'sqlite'],
  };

  const getExtension = (raw: string): string => {
    try {
      const parsed = new URL(raw, window.location.href);
      const path = parsed.pathname.split('?')[0];
      const dot = path.lastIndexOf('.');
      return dot > 0 ? path.substring(dot + 1).toLowerCase() : '';
    } catch {
      const match = raw.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
      return match ? match[1].toLowerCase() : '';
    }
  };

  const matchesType = (extension: string): boolean => {
    if (fileTypes.length === 0) return true;
    if (fileTypes.includes(extension)) return true;
    for (const category of fileTypes) {
      if (fileTypeMap[category]?.includes(extension)) return true;
    }
    return false;
  };

  /** 稳定的资源 id：URL 的哈希（同一 URL 恒定同 id，跨次嗅探可复用） */
  const makeId = (raw: string): string => {
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `res_${(hash >>> 0).toString(36)}_${raw.length.toString(36)}`;
  };

  const process = (
    raw: string,
    element?: Element | null,
    title?: string,
    description?: string,
    source: ResourceInfo['source'] = 'dom',
  ): void => {
    if (!raw || seenUrls.has(raw) || resources.length >= maxResults) return;
    if (raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('javascript:')) return;
    const extension = getExtension(raw);
    if (!extension) return;
    if (!includeImages && fileTypeMap.image.includes(extension)) return;
    if (!matchesType(extension)) return;

    let absolute = raw;
    try {
      absolute = new URL(raw, window.location.href).href;
    } catch {
      return;
    }
    if (seenUrls.has(absolute)) return;
    seenUrls.add(absolute);

    let filename = '';
    try {
      const parsed = new URL(absolute);
      filename = (parsed.pathname.split('/').pop() || `file.${extension}`).split('?')[0];
    } catch {
      filename = `file.${extension}`;
    }

    const sizeAttr = element?.getAttribute?.('data-size') || element?.getAttribute?.('data-filesize') || '';
    const elementTitle = element?.getAttribute?.('title') || element?.getAttribute?.('alt') || '';
    const elementText = element && 'textContent' in element ? (element.textContent || '').trim() : '';

    resources.push({
      id: makeId(absolute),
      url: absolute,
      filename,
      fileType: extension,
      size: sizeAttr,
      title: title || elementTitle || elementText.slice(0, 80) || filename,
      description: description || elementTitle,
      source,
    });
  };

  // 1. 普通链接
  document.querySelectorAll('a[href]').forEach(link => {
    const href = (link as HTMLAnchorElement).href;
    if (href && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
      process(href, link, (link.textContent || '').trim().slice(0, 80));
    }
  });

  // 2. 媒体元素
  document.querySelectorAll('img[src], video[src], audio[src], source[src]').forEach(media => {
    const src = (media as HTMLImageElement).src;
    if (src) process(src, media);
  });

  // 3. 嵌入对象
  document.querySelectorAll('embed[src], object[data], iframe[src]').forEach(embed => {
    const src = embed.getAttribute('src') || embed.getAttribute('data');
    if (src) process(src, embed);
  });

  // 4. 带下载标记或数据地址的元素
  document.querySelectorAll('[download], [data-download], [data-url], [data-href]').forEach(element => {
    const url =
      element.getAttribute('href') ||
      element.getAttribute('data-download') ||
      element.getAttribute('data-url') ||
      element.getAttribute('data-href');
    if (url) process(url, element);
  });

  // 5. CSS 背景图
  if (includeImages) {
    document.querySelectorAll('*').forEach(element => {
      const background = window.getComputedStyle(element as Element).backgroundImage;
      if (!background || background === 'none') return;
      const match = background.match(/url\(["']?([^"')]+)["']?\)/);
      if (match && match[1]) process(match[1], element, undefined, 'CSS background image');
    });
  }

  return resources;
}

// 导出工具实例
export const browserResourcesTool = new BrowserResourcesTool();

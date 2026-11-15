/**
 * 网页正文读取与落盘工具（read_website）
 *
 * 与浏览器内置文本通道共用同一提取引擎（tools/browser/page-doc-engine.ts），
 * 能力完全一致：多 frame + 开放 shadow root、结构化 Markdown（表格合并单元格还原/
 * 列表/代码块/链接）、人机验证页识别、单页 3000 字符（≈3000 token）分页。
 *
 * 唯一差异（也是本工具存在的理由）：
 *   - **不再把正文缓存为 dataRef 引用**，而是把完整正文写成会话工作区的
 *     `content/<url-slug>-<4位随机字母>.md` 交付物；
 *   - 返回 CSV 多列单行：`content,page,totalPages,path`；
 *   - 分页续读传 `path + page`（从工作区文件读取），与 js_run 的
 *     `read(path, index)` 规范一致——产物可下载、可编辑、可被 data_ref/xlsx
 *     等工具按路径消费。
 *
 * 落盘策略：正文非空且 ≥100 字符才落盘（过短内容没有归档价值，直接内联返回，
 * 避免产生大量几行的小文件）。落盘失败不阻断本次读取，降级为内联 + 明确告警。
 */

import { BaseBrowserTool } from './browser-tool';
import { isFrameReadReport, type FrameReadReport } from '../common/frame-read';
import type { ToolMetadata, ToolExecutionContext } from '../registry';
import { assertPluginOrigin, pluginOriginOf } from '../common/plugin-origin';
import type { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import {
  PAGE_CHARS_LIMIT,
  extractPageDoc,
  pageDelivery,
  pageFileSlug,
  resolvePageTarget,
  type PageDocSuccess,
} from '../browser/page-doc-engine';
import {
  WORKSPACE_CONTENT_DIR,
  WORKSPACE_READ_MAX_FILE_BYTES,
  readWorkspaceTextFile,
  writeToolWorkspaceFile,
} from '@/utils/python-workspace/workspace-files';

/** 低于该字符数的正文不落盘（直接内联返回） */
const MIN_ARCHIVE_CHARS = 100;
/** 文件名冲突时的重试次数（4 位随机字母空间 456,976） */
const FILE_NAME_RETRY = 5;
/** 随机文件名使用的字母表 */
const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

/** 生成 4 位随机字母后缀 */
function randomSuffix(): string {
  let suffix = '';
  for (let i = 0; i < 4; i++)
    suffix += RANDOM_ALPHABET[Math.floor(Math.random() * RANDOM_ALPHABET.length)];
  return suffix;
}

/** 工作区错误码（WorkspaceOperationError 结构化码） */
function workspaceErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code as string | undefined
    : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ReadWebsiteTool extends BaseBrowserTool {
  name = 'read_website';

  metadata: ToolMetadata = {
    name: 'read_website',
    description:
      '读取网页正文为结构化 Markdown 并落盘 content/*.md：多 frame + shadow root 覆盖，' +
      '单页 3000 字符，CSV（content,page,totalPages,path）返回，支持 path+page 续读',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'content', 'text', 'markdown', 'workspace', 'artifact'],
    // 纯读（不带 url/tabId 时不改变用户可见页面）；带 url 的前台打开或
    // 带 tabId 的标签页切换都会改变眼前页面，vision-feedback 的
    // FOREGROUND_SWITCHING_TOOLS 会按参数判定需要重拍
    noVisionRecapture: true,
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'read_website',
      description:
        '读取网页正文并落盘为可下载的 Markdown 产物（content/<url>-<随机4位>.md），同时返回当前页内容。\n' +
        '提取口径与内置文本通道完全一致：结构化 Markdown（标题层级/表格含合并单元格/列表/代码块及语言/链接/引用/图片/表单控件），' +
        '覆盖全部可注入 frame（iframe）与可访问 shadow root，剔除隐藏内容与脚本/样式/SVG/Canvas。\n' +
        '目标：默认读当前活动标签页；url=单个网址 时前台打开并等待加载完成（标签页保留在用户眼前，便于手动过验证）；tabId 可指定标签页（会先切换到该页）。\n' +
        '返回 CSV 多列单行：content,page,totalPages,path（path 为工作区相对路径，如 content/example-com-list-1-a1b2.md）。' +
        '单页最多 3000 字符，完整正文永远在 path 文件里；续读传 path + page（page 从 1 起，page < totalPages 表示还有下一页）。\n' +
        '正文为空或不足 100 字符时不落盘，直接把内容放在 CSV 的 content 列（path 为空）。\n' +
        '与其它工具的联动：path 文件可直接用 js_run(read)/data_ref_tool/xlsx_tool 按路径消费，也可作为交付物下载。\n' +
        '需要批量结构化抽取请用 browser_extract_data / js_run；需要元素级观察与交互请用 browser_observe / browser_interact。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: {
            type: 'string',
            description:
              '目标网址（可选，仅支持单个 http/https URL）。提供后在前台新建并激活标签页、等待加载完成再提取，标签页保留不关闭；与 tabId 互斥',
          },
          tabId: {
            type: 'integer',
            minimum: 0,
            description:
              '标签页 ID（可选，默认当前活动标签页；运行时也接受纯数字字符串）。显式传入会先核对存在性与可注入性，再切换到该标签页；与 url 互斥',
          },
          path: {
            type: 'string',
            description:
              '分页续读用：上一次返回的 content/*.md 工作区相对路径。提供时不再访问页面，只从该文件读取指定页；与 url、tabId 互斥',
          },
          page: {
            type: 'integer',
            minimum: 1,
            description: '页码（可选，默认 1，每页 3000 字符）。page < totalPages 表示还有下一页',
          },
        },
        required: [],
      },
    },
  };

  async execute(
    rawArgs: { url?: unknown; tabId?: unknown; path?: unknown; page?: unknown } = {},
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    this.ensureBackgroundContext();
    if (context?.signal?.aborted) return this.createErrorResponse('ABORTED：读取前已取消，未访问页面或工作区');

    if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      return this.createErrorResponse(
        `参数必须是对象 { url?, tabId?, path?, page? }，实际收到 ${Array.isArray(rawArgs) ? 'array' : typeof rawArgs}`,
      );
    }
    const args = rawArgs as Record<string, unknown>;
    const allowedKeys = ['url', 'tabId', 'path', 'page'];
    const unknownKeys = Object.keys(args).filter((key) => !allowedKeys.includes(key));
    if (unknownKeys.length > 0)
      return this.createErrorResponse(
        `存在未知参数：${unknownKeys.join('、')}。允许的参数：${allowedKeys.join('/')}（续读用 path + page；打开新页用 url；指定标签页用 tabId）。`,
      );

    // ── 参数归一与防御 ──
    if (args.url !== undefined && args.url !== null && typeof args.url !== 'string')
      return this.createErrorResponse('url 仅支持单个 URL 字符串（不支持数组批量）');
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (
      args.tabId !== undefined &&
      args.tabId !== null &&
      typeof args.tabId !== 'number' &&
      typeof args.tabId !== 'string'
    )
      return this.createErrorResponse(
        `tabId 必须是非负整数或纯数字字符串，实际收到 ${Array.isArray(args.tabId) ? 'array' : typeof args.tabId}`,
      );
    const tabId =
      args.tabId === undefined || args.tabId === null ? undefined : args.tabId;
    if (args.path !== undefined && args.path !== null && typeof args.path !== 'string')
      return this.createErrorResponse('path 必须是字符串（工作区相对路径）');
    const path = typeof args.path === 'string' ? args.path.trim() : '';

    let page = 1;
    if (args.page !== undefined && args.page !== null) {
      const parsed =
        typeof args.page === 'number'
          ? args.page
          : typeof args.page === 'string' && args.page.trim() !== ''
            ? Number(args.page)
            : NaN;
      if (!Number.isFinite(parsed) || parsed < 1)
        return this.createErrorResponse(
          `page 必须是 ≥1 的整数（页码），实际收到 ${String(args.page)}`,
        );
      page = Math.floor(parsed);
    }

    // ── 续读模式：只读工作区文件，不访问页面 ──
    if (path) {
      if (url) return this.createErrorResponse('path 与 url 互斥：续读模式不访问页面，请只提供 path + page');
      if (tabId !== undefined)
        return this.createErrorResponse('path 与 tabId 互斥：续读模式不访问标签页，请只提供 path + page');
      try { return await this.readSavedPage(path, page, context); }
      catch (error) { return this.createErrorResponse(`${context?.signal?.aborted ? 'ABORTED' : 'WORKSPACE_READ_FAILED'}：${errorText(error)}`); }
    }

    // ── 插件页面边界：先校验目标 URL，再决定是否打开/读取 ──
    if (context?.pluginKey) {
      try {
        if (url) assertPluginOrigin(pluginOriginOf(url), context);
      } catch (error) {
        return this.createErrorResponse(
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // ── 提取模式：url 前台打开 / tabId 切换 / 活动页 ──
    let target: Awaited<ReturnType<typeof resolvePageTarget>>;
    try {
      target = await resolvePageTarget(
        { url: url || undefined, tabId },
        { tool: 'read_website', context },
      );
    } catch (error) {
      return this.createErrorResponse(
        `${context?.signal?.aborted ? 'ABORTED' : 'UNEXPECTED_ERROR'}：解析目标标签页失败：${errorText(error)}。`,
        error,
      );
    }
    if (!target.ok) return this.createErrorResponse(target.error);
    if (context?.pluginKey) {
      try {
        assertPluginOrigin(pluginOriginOf(target.url), context);
      } catch (error) {
        return this.createErrorResponse(
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    let extracted: PageDocSuccess;
    try {
      const doc = await extractPageDoc(target.tabId, {
        requestedUrl: target.url,
        loadNote: target.loadNote,
        signal: context?.signal,
      });
      if (!doc.ok) return { ...this.createErrorResponse(doc.error), data: { frameDiagnostics: doc.frameDiagnostics } };
      extracted = doc;
    } catch (error) {
      return this.createErrorResponse(
        `UNEXPECTED_ERROR：读取正文时发生未预期异常：${errorText(error)}。请稍后重试；若页面正在导航，先等待加载完成。`,
        error,
      );
    }

    if (page > extracted.totalPages)
      return this.createErrorResponse(
        `page=${page} 超出范围：正文共 ${extracted.totalChars} 字符、${extracted.totalPages} 页` +
          `${extracted.totalPages > 1 ? `（1..${extracted.totalPages}）` : ''}`,
      );

    const warnings = [...extracted.warnings];

    // ── 落盘：正文非空且 ≥100 字符；验证页/风控页不归档（不是可用事实） ──
    let savedPath = '';
    let frameDiagnosticsPath: string | undefined;
    let archiveSkipped = '';
    if (extracted.challengeDetected) {
      archiveSkipped = '页面疑似人机验证/风控拦截，未落盘。';
    } else if (extracted.doc.trim() === '') {
      archiveSkipped = '正文为空，未落盘。';
    } else if (extracted.doc.length < MIN_ARCHIVE_CHARS) {
      archiveSkipped = `正文仅 ${extracted.doc.length} 字符（<${MIN_ARCHIVE_CHARS}），未落盘。`;
    } else if (!context?.chatId) {
      archiveSkipped =
        '缺少会话上下文，无法写入工作区——本次仅返回内容；需要落盘请在正常会话中使用。';
    } else {
      const written = await this.writeArchive(context.chatId, extracted, context.signal);
      if (written.ok) {
        savedPath = written.path;
        frameDiagnosticsPath = written.frameDiagnosticsPath;
        if (written.warning) warnings.push(written.warning);
      }
      else warnings.push(written.error);
    }

    const delivery = pageDelivery(extracted.doc, page, extracted.totalPages, {
      name: 'path',
      value: savedPath,
    });
    if (!delivery.ok) return this.createErrorResponse(delivery.error);
    // 直接按页码重取会生成第二个正文文件；提示后续用 path + page 复用，
    // 避免同一篇正文在 content/ 下留下多份拷贝
    const pagingNote =
      page > 1 && savedPath
        ? '本次按页重取已生成新的正文文件；后续续读请传 path + page 复用该文件，避免重复产物。'
        : '';
    const note = [extracted.loadNote, pagingNote].filter(Boolean).join(' ');
    const payload: Record<string, unknown> = {
      content: delivery.csv,
      frameDiagnostics: extracted.frameDiagnostics,
      ...(frameDiagnosticsPath ? { frameDiagnosticsPath } : {}),
      coverage: { complete: false, source: 'Currently rendered DOM in discovered documents', frames: extracted.frames, missingResults: extracted.missingResults },
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(extracted.challengeDetected ? { verificationRequired: true } : {}),
      ...(note ? { note } : {}),
      ...(archiveSkipped ? { archiveSkipped } : {}),
    };
    return this.createSuccessResponse(
      payload,
      extracted.challengeDetected
        ? '页面被人机验证 / 风控拦截，未取到正文。请在已打开的前台标签页手动完成验证后重试，或换来源。'
        : `已读取正文 ${extracted.totalChars} 字符（第 ${page}/${extracted.totalPages} 页）` +
            (savedPath ? `，已获取正文保存为 ${savedPath}` : `；${archiveSkipped || '未落盘'}`),
    );
  }

  /**
   * 写入 content/<slug>-<4位随机字母>.md。
   *
   * 文件名冲突时换随机后缀重试；非冲突错误（存储失败/超限/父路径被占）不重试，
   * 直接返回可读告警（调用方降级为内联返回，不阻断本次读取）。
   */
  private async writeArchive(
    chatId: string,
    extracted: PageDocSuccess,
    signal?: AbortSignal,
  ): Promise<{ ok: true; path: string; frameDiagnosticsPath?: string; warning?: string } | { ok: false; error: string }> {
    const slug = pageFileSlug(extracted.url, extracted.title);
    let lastError = '';
    for (let attempt = 0; attempt < FILE_NAME_RETRY; attempt++) {
      const path = `${WORKSPACE_CONTENT_DIR}/${slug}-${randomSuffix()}.md`;
      try {
        const written = await writeToolWorkspaceFile(chatId, path, extracted.doc, {
          mime: 'text/markdown;charset=utf-8',
          signal,
        });
        if (extracted.frameDiagnostics) {
          const metadataPath = written.path + '.frames.json';
          try {
            await writeToolWorkspaceFile(chatId, metadataPath, JSON.stringify({
              version: 1,
              contentSha256: await this.contentHash(extracted.doc),
              frameDiagnostics: extracted.frameDiagnostics,
              frames: extracted.frames,
            }), { mime: 'application/json;charset=utf-8', signal });
            return { ok: true, path: written.path, frameDiagnosticsPath: metadataPath };
          } catch (error) {
            return { ok: true, path: written.path, warning: `正文已保存，但采集诊断未能持久化：${errorText(error)}；续读文件无法恢复本次缺失范围，请保留当前 frameDiagnostics。` };
          }
        }
        return { ok: true, path: written.path };
      } catch (error) {
        lastError = errorText(error);
        if (workspaceErrorCode(error) === 'FILE_EXISTS') continue;
        break;
      }
    }
    return {
      ok: false,
      error:
        `正文落盘失败（${lastError || '未知原因'}）——本次仅返回当前页；` +
        `可稍后重试，或用 js_run 把正文写入 outputs/。`,
    };
  }

  private async contentHash(text: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  }

  /** 从已落盘的 content/*.md 分页读取（与 js_run read 的语义一致） */
  private async readSavedPage(
    path: string,
    page: number,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (!path.startsWith(`${WORKSPACE_CONTENT_DIR}/`))
      return this.createErrorResponse(
        `INVALID_ARGUMENT：续读只接受本工具产出的 ${WORKSPACE_CONTENT_DIR}/ 下 Markdown 文件，实际收到 ${JSON.stringify(path.slice(0, 200))}。` +
          `读取其它工作区文件请用 js_run(action="read", path, index)。`,
      );
    if (!context?.chatId)
      return this.createErrorResponse(
        '缺少会话上下文，无法读取工作区文件——请在正常会话中续读，或重新提供 url/tabId 提取。',
      );
    let text: string;
    try {
      const file = await readWorkspaceTextFile(
        context.chatId,
        path,
        context.signal,
        WORKSPACE_READ_MAX_FILE_BYTES,
      );
      text = file.content;
    } catch (error) {
      return this.createErrorResponse(
        `读取 ${path} 失败：${errorText(error)}。请确认路径来自本工具最近一次返回（文件可能已被移动/删除）。`,
        error,
      );
    }
    const totalPages = Math.max(1, Math.ceil(text.length / PAGE_CHARS_LIMIT));
    const delivery = pageDelivery(text, page, totalPages, { name: 'path', value: path });
    if (!delivery.ok) return this.createErrorResponse(delivery.error);
    let frameDiagnostics: FrameReadReport | undefined;
    let diagnosticNote = '此文件未附可验证的采集诊断，无法据文件正文判断原始页面覆盖是否完整。';
    try {
      const metadataFile = await readWorkspaceTextFile(context.chatId, path + '.frames.json', context.signal, WORKSPACE_READ_MAX_FILE_BYTES);
      const metadata = JSON.parse(metadataFile.content);
      if (!metadata || metadata.version !== 1 || !isFrameReadReport(metadata.frameDiagnostics)) {
        diagnosticNote = '采集诊断文件格式无效或版本不受支持，未将其作为当前覆盖信息。';
      } else if (metadata.contentSha256 === await this.contentHash(text)) {
        frameDiagnostics = metadata.frameDiagnostics;
        diagnosticNote = '';
      } else diagnosticNote = '正文文件已变化，原始采集诊断不再适用于当前文件。';
    } catch (error) {
      context.signal?.throwIfAborted();
      if (workspaceErrorCode(error) !== 'WORKSPACE_FILE_NOT_FOUND') diagnosticNote = `采集诊断无法读取或校验：${errorText(error)}；正文仍已返回。`;
    }
    return this.createSuccessResponse(
      { content: delivery.csv, ...(frameDiagnostics ? { frameDiagnostics } : {}), ...(diagnosticNote ? { diagnosticNote } : {}) },
      `已读取 ${path} 第 ${page}/${totalPages} 页（共 ${text.length} 字符${
        delivery.slice.hasMore ? `，下一页 page=${page + 1}` : '，已到末页'
      }）`,
    );
  }
}

export const readWebsiteTool = new ReadWebsiteTool();

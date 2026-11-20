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
 *   - 续读统一走 file_util(action="read", path=返回的 path, index=页码)——
 *     文件读取语义全仓只保留一份实现，本工具不再内置 path 读取模式。
 *
 * 落盘策略：正文非空且 ≥100 字符才落盘（过短内容没有归档价值，直接内联返回，
 * 避免产生大量几行的小文件）。落盘失败不阻断本次读取，降级为内联 + 明确告警。
 */

import { BaseBrowserTool } from './browser-tool';
import type { ToolMetadata, ToolExecutionContext } from '../registry';
import { assertPluginOrigin, pluginOriginOf } from '../common/plugin-origin';
import type { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import {
  extractPageDoc,
  pageDelivery,
  pageFileSlug,
  resolvePageTarget,
  type PageDocSuccess,
} from '../browser/page-doc-engine';
import {
  WORKSPACE_CONTENT_DIR,
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
      'parent*/frameId 容器范围提取，单页 3000 字符，CSV（content,page,totalPages,path）返回；续读用 file_util(action="read")',
    category: 'browser',
    version: '2.1.0',
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
        '范围提取（parentSelector/parentXPath/frameId，与 browser_observe 同名同义）：只输出命中容器子树的 Markdown，**包含容器自身的文本**' +
        '（与 observe 的「容器自身不进结果」相反——读语义里容器文本正是要读的内容）；容器在部分 frame 缺席时该 frame 静默跳过，所有 frame 均未命中报 PARENT_CONTAINER_NOT_FOUND，绝不回退整页。' +
        '作用域模式下人机验证页判定为弱信号（只依据标题与容器内文案）。字段化批量抽取用 browser_extract_data；本工具的强项是结构保真正文与落盘。\n' +
        '返回 CSV 多列单行：content,page,totalPages,path（path 为工作区相对路径，如 content/example-com-list-1-a1b2.md）。' +
        '单页最多 3000 字符，完整正文永远在 path 文件里；需要后续页或全文时用 file_util(action="read", path=该 path, index=页码) 按页读取（page < totalPages 表示还有下一页）。\n' +
        '正文为空或不足 100 字符时不落盘，直接把内容放在 CSV 的 content 列（path 为空）。\n' +
        '与其它工具的联动：path 文件可直接用 file_util(action="read") / data_ref_tool / xlsx_tool 按路径消费，也可作为交付物下载。\n' +
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
          page: {
            type: 'integer',
            minimum: 1,
            description: '页码（可选，默认 1，每页 3000 字符）。page < totalPages 表示还有下一页',
          },
          parentSelector: {
            type: 'string',
            maxLength: 2000,
            description:
              '仅提取：只把该 CSS 选择器命中的容器子树转为 Markdown（可选，与 parentXPath 互斥；与 browser_observe 的 parent* 同名同义）。' +
              '**包含容器自身的文本**；多容器按文档序合并、嵌套不重复；所有 frame 均未命中报 PARENT_CONTAINER_NOT_FOUND，不回退整页。' +
              '与 url/tabId 任意组合（如 url + selector = 只读单篇文章正文）。容器应短而稳（#main / .article-body）。',
          },
          parentXPath: {
            type: 'string',
            maxLength: 2000,
            description:
              '仅提取：只把该 XPath 1.0 命中的容器子树转为 Markdown（可选，与 parentSelector 互斥）。语义同 parentSelector：含容器自身文本、' +
              '未命中报错不回退；**仅**命中非元素节点时明确拒绝（容器必须是元素）。',
          },
          frameId: {
            type: 'integer',
            minimum: 0,
            description:
              '仅提取：限定在该 frame 内提取（可选，省略 = 全部可注入 frame）。frameId 不存在或不可注入报 FRAME_NOT_FOUND；运行时也接受纯数字字符串。',
          },
        },
        required: [],
      },
    },
  };

  async execute(
    rawArgs: {
      url?: unknown;
      tabId?: unknown;
      page?: unknown;
      parentSelector?: unknown;
      parentXPath?: unknown;
      frameId?: unknown;
    } = {},
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    this.ensureBackgroundContext();
    if (context?.signal?.aborted) return this.createErrorResponse('ABORTED：读取前已取消，未访问页面或工作区');

    if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      return this.createErrorResponse(
        `参数必须是对象 { url?, tabId?, page?, parentSelector?, parentXPath?, frameId? }，实际收到 ${Array.isArray(rawArgs) ? 'array' : typeof rawArgs}`,
      );
    }
    const args = rawArgs as Record<string, unknown>;
    const allowedKeys = ['url', 'tabId', 'page', 'parentSelector', 'parentXPath', 'frameId'];
    const unknownKeys = Object.keys(args).filter((key) => !allowedKeys.includes(key));
    if (unknownKeys.length > 0)
      return this.createErrorResponse(
        `存在未知参数：${unknownKeys.join('、')}。允许的参数：${allowedKeys.join('/')}（打开新页用 url；指定标签页用 tabId；容器范围用 parentSelector/parentXPath；限定 frame 用 frameId）。` +
          (unknownKeys.includes('path')
            ? 'path 续读模式已下线：请用 file_util(action="read", path=上次返回的 path, index=页码) 读取已落盘正文。'
            : ''),
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

    // ── 容器范围与 frame 范围（与 browser_observe 同名同义；先于一切页面访问拦截）──
    for (const key of ['parentSelector', 'parentXPath'] as const) {
      if (args[key] !== undefined && args[key] !== null && typeof args[key] !== 'string')
        return this.createErrorResponse(
          `${key} 必须是字符串（CSS 选择器 / XPath），实际收到 ${Array.isArray(args[key]) ? 'array' : typeof args[key]}`,
        );
    }
    const parentSelector = (typeof args.parentSelector === 'string' ? args.parentSelector : '').trim();
    const parentXPath = (typeof args.parentXPath === 'string' ? args.parentXPath : '').trim();
    if (parentSelector && parentXPath)
      return this.createErrorResponse(
        'INVALID_ARGUMENT：parentSelector 与 parentXPath 只能二选一。请删除其中一个后重试。',
      );
    for (const key of ['parentSelector', 'parentXPath'] as const) {
      const value = key === 'parentSelector' ? parentSelector : parentXPath;
      if (value.length > 2000)
        return this.createErrorResponse(
          `INVALID_ARGUMENT：${key} 过长（${value.length} 字符，上限 2000）。父容器应是短而稳的选择器（如 #main / .article-body）；需要复杂定位请先 browser_observe 确认容器。`,
        );
    }
    let frameId: number | undefined;
    if (args.frameId !== undefined && args.frameId !== null) {
      const parsed =
        typeof args.frameId === 'number'
          ? args.frameId
          : typeof args.frameId === 'string' && args.frameId.trim() !== ''
            ? Number(args.frameId)
            : NaN;
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0)
        return this.createErrorResponse(
          `INVALID_ARGUMENT：frameId 必须是非负整数（省略 = 全部可注入 frame），实际收到 ${JSON.stringify(args.frameId)}`,
        );
      frameId = parsed;
    }

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
        parentSelector,
        parentXPath,
        frameId,
      }, context);
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
    const pagingNote =
      page > 1 && savedPath
        ? '本次按页重取已生成新的正文文件；后续请用 file_util(action="read", path=该文件, index=下一页页码) 读取，避免重复提取。'
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
            return { ok: true, path: written.path, warning: `正文已保存，但采集诊断未能持久化：${errorText(error)}；后续用 file_util(action="read") 续读时无法恢复本次缺失范围，请保留当前 frameDiagnostics。` };
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
        `可稍后重试，或用 file_util(action="create", path="content/xxx.md", content=…) 保存正文，再用 document_tool 交付。`,
    };
  }

  private async contentHash(text: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  }
}

export const readWebsiteTool = new ReadWebsiteTool();

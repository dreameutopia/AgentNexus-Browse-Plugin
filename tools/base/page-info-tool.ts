import { browserChrome } from '@/tools/browser/browser-scope';
import { saveDataRefJson, getDataRef, listDataRefs } from '@/utils/data-ref-store';
import { readPageFrames, PageReadError, isFrameReadReport, withDeadline, addFrameIssue } from '../common/frame-read';
import { injectionErrorText } from '../common/script-injection';
import { trimDanglingSurrogate } from '@/utils/text/truncate';
import {
  PAGE_CHARS_LIMIT,
  pageDelivery,
  resolvePageTarget,
  extractPageDoc,
  type PageDocSuccess,
} from '../browser/page-doc-engine';
/**
 * 页面信息工具
 * 提供获取当前页面文本、HTML、基本信息等功能
 */

import { BaseBrowserTool } from './browser-tool';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';

/**
 * 获取页面文本工具（结构化 Markdown 正文）
 *
 * 能力（提取引擎见 tools/browser/page-doc-engine.ts，与 read_website 共用）：
 *   - 结构化提取：标题层级 / 表格（rowspan+colspan 还原）/ 列表（嵌套+任务项）/
 *     代码块+语言 / 链接目标 / 引用 / 图片 / 表单控件；
 *   - 覆盖面：全部可注入 frame（allFrames）+ 可访问 shadow root（slot 分发感知）；
 *     自动剔除 script/style/svg/canvas 等噪声、隐藏内容与无意义空白/编码串；
 *   - url 参数（单个，http/https）：**前台**打开目标页并等待加载完成后提取，
 *     标签页保留在用户眼前；页面弹出验证时可由用户手动完成后重试；
 *   - 分页：单页 ≤3000 字符（≈3000 token）；超长全文缓存为 dataRef（ref），
 *     用 ref + page 续读；
 *   - 输出：CSV 多列单行（content,page,totalPages,ref），正文中的逗号/引号/
 *     换行由 RFC 4180 转义，下游可直接解析。
 *
 * 注意：本工具已不再是全局默认注入工具（由 read_website 取代）；保留注册
 * 供显式调用与兼容既有会话，新链路请优先使用 read_website。
 */
export class GetPageTextTool extends BaseBrowserTool {
  name = 'browser_get_page_text';

  metadata: ToolMetadata = {
    name: 'browser_get_page_text',
    description:
      '读取页面为结构化 Markdown 正文，按 3000 字符分页并以 CSV（content,page,totalPages,ref）返回；' +
      '覆盖全部可注入 frame 与可访问 shadow root',
    category: 'browser',
    version: '3.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'content', 'text', 'markdown', 'structured'],
    // 纯读豁免重拍的前提是「不改变用户可见的页面」：不带 url/tabId 时只读
    // 当前标签页，视图未变可豁免；带 url 的前台打开或带 tabId 的切换都会改变
    // 用户眼前的页面，必须重拍（豁免口径见 vision-feedback.ts 的
    // FOREGROUND_SWITCHING_TOOLS：按调用参数判定）。
    noVisionRecapture: true
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_get_page_text',
      description:
        '读取页面正文并转为结构化 Markdown：保留标题层级、表格（含合并单元格）、列表、代码块及语言、链接目标、引用、图片与表单控件；' +
        '覆盖当前页全部可注入 frame（iframe）与可访问 shadow root，自动剔除隐藏内容、脚本/样式/SVG/Canvas 与无意义空白。' +
        '默认读当前活动标签页；url=单个网址 时前台打开该页面并等待加载完成后提取，标签页保留在用户眼前；tabId 可指定标签页（会先切换到该页）。' +
        '单页最多 3000 字符，返回 CSV 多列单行：content,page,totalPages,ref。' +
        '超出时全量缓存为引用 ID（ref），续读传 ref + page（缓存浏览器会话内约 12 小时有效）。' +
        '注意：本工具不是默认注入通道——正文读取与落盘产物优先用 read_website；本工具适合已有 ref 的缓存续读与历史兼容。' +
        '需要交互展开、批量抽取时用 browser_interact / js_run。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '目标网址（可选，仅支持单个 http/https URL）。提供后在前台新建并激活标签页打开、等待加载完成再提取，标签页保留不关闭；不提供则读当前标签页'
          },
          tabId: {
            type: 'integer',
            minimum: 0,
            description: '标签页 ID（可选，默认当前活动标签页；运行时也接受纯数字字符串；与 url 互斥）'
          },
          ref: {
            type: 'string',
            description: '分页引用 ID（可选，上次超长响应返回的 ref）。提供时不访问任何标签页，直接读缓存正文指定页；与 url、tabId 互斥'
          },
          page: {
            type: 'integer',
            minimum: 1,
            description: '页码（可选，默认 1，每页 3000 字符）。超长正文直接指定页码读取，或配合 ref 续读'
          }
        },
        required: []
      }
    }
  };

  async execute(rawArgs: { url?: unknown; tabId?: unknown; ref?: unknown; page?: unknown } = {}, context?: ToolExecutionContext): Promise<ToolResult> {
    this.ensureBackgroundContext();
    if (context?.signal?.aborted) return this.createErrorResponse('ABORTED：读取前已取消，未访问标签页');

    // 参数整体形态防御：非对象（含数组/字符串）按模型误用拒绝，
    // 错误信息里带实际类型便于自纠——静默当空对象处理会走错目标页
    if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      return this.createErrorResponse(
        `参数必须是对象 { url?, tabId?, ref?, page? }，实际收到 ${Array.isArray(rawArgs) ? 'array' : typeof rawArgs}`
      );
    }
    const args = rawArgs as Record<string, unknown>;
    const allowedKeys = ['url', 'tabId', 'ref', 'page'];
    const unknownKeys = Object.keys(args).filter((key) => !allowedKeys.includes(key));
    if (unknownKeys.length > 0)
      return this.createErrorResponse(
        `存在未知参数：${unknownKeys.join('、')}。允许的参数：${allowedKeys.join('/')}（分页续读用 ref + page；打开新页用 url；指定标签页用 tabId）。`
      );

    // ── 参数归一与防御 ──
    if (args.ref !== undefined && args.ref !== null && typeof args.ref !== 'string') {
      return this.createErrorResponse(
        `ref 必须是字符串（分页引用 ID），实际收到 ${Array.isArray(args.ref) ? 'array' : typeof args.ref}`
      );
    }
    const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
    if (args.url !== undefined && args.url !== null && typeof args.url !== 'string') {
      return this.createErrorResponse('url 仅支持单个 URL 字符串（不支持数组批量）');
    }
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    // tabId 允许纯数字字符串（模型常把 ID 写成 "1792865371"）；其余形态早失败
    const rawTabId = args.tabId;
    if (
      rawTabId !== undefined &&
      rawTabId !== null &&
      typeof rawTabId !== 'number' &&
      typeof rawTabId !== 'string'
    ) {
      return this.createErrorResponse(
        `tabId 必须是非负整数或纯数字字符串，实际收到 ${Array.isArray(rawTabId) ? 'array' : typeof rawTabId}`
      );
    }
    const requestedTabId =
      rawTabId === undefined || rawTabId === null ? undefined : rawTabId;

    let page = 1;
    if (args.page !== undefined && args.page !== null) {
      const parsed = typeof args.page === 'number'
        ? args.page
        : typeof args.page === 'string' && (args.page as string).trim() !== ''
          ? Number(args.page)
          : NaN;
      if (!Number.isFinite(parsed) || parsed < 1) {
        return this.createErrorResponse(`page 必须是 ≥1 的整数（页码），实际收到 ${String(args.page)}`);
      }
      page = Math.floor(parsed);
    }

    // ── 模式分诊 ──
    if (ref) {
      if (url) {
        return this.createErrorResponse('ref 与 url 互斥：分页读取缓存正文时不要同时提供 url（ref 模式不会访问页面）');
      }
      if (requestedTabId !== undefined && requestedTabId !== null) {
        return this.createErrorResponse('ref 与 tabId 互斥：ref 模式只读缓存、不访问任何标签页，请只提供 ref 与 page');
      }
      try { return await this.readCachedPage(ref, page); }
      catch (error) { return this.createErrorResponse(`CACHE_READ_FAILED：${injectionErrorText(error)}`); }
    }
    if (url && requestedTabId !== undefined && requestedTabId !== null) {
      return this.createErrorResponse('url 与 tabId 互斥：url 模式自行打开目标页面，请只提供其一');
    }

    // ── 解析目标标签页（url 前台打开 / tabId 校验并切换 / 活动页） ──
    let target: Awaited<ReturnType<typeof resolvePageTarget>>;
    try {
      target = await resolvePageTarget(
        { url: url || undefined, tabId: requestedTabId },
        { tool: 'browser_get_page_text', context },
      );
    } catch (error) {
      return this.createErrorResponse(
        `${context?.signal?.aborted ? 'ABORTED' : 'UNEXPECTED_ERROR'}：解析目标标签页失败：${injectionErrorText(error)}。`,
        error,
      );
    }
    if (!target.ok) return this.createErrorResponse(target.error);

    // ── 提取整篇正文（引擎与 read_website 共用） ──
    try {
    const extracted = await extractPageDoc(target.tabId, {
      requestedUrl: target.url,
      loadNote: target.loadNote,
      signal: context?.signal,
    }, context);
    if (!extracted.ok) return { ...this.createErrorResponse(extracted.error), data: { frameDiagnostics: extracted.frameDiagnostics } };
    return await this.buildResponse(extracted, page);
    } catch (error) { return this.createErrorResponse(`PAGE_TEXT_FAILED：${injectionErrorText(error)}`); }
  }

  /** 分页 + ref 缓存 + CSV 封装 */
  private async buildResponse(extracted: PageDocSuccess, page: number): Promise<ToolResult> {
    const { totalChars, totalPages } = extracted;
    // 越界必须在缓存前判定：避免把非法页码的请求也写进暂存区
    if (page > totalPages) {
      return this.createErrorResponse(
        `page=${page} 超出范围：正文共 ${totalChars} 字符、${totalPages} 页${totalPages > 1 ? `（1..${totalPages}）` : ''}`
      );
    }

    const warnings = [...extracted.warnings];
    // 超长正文缓存为 dataRef（与 browser_network_capture 同一暂存区），后续 ref+page 续读
    let refId: string | undefined;
    if (totalChars > PAGE_CHARS_LIMIT) {
      try {
        const saved = await saveDataRefJson(
          JSON.stringify({
            type: 'page-text',
            v: 2,
            url: extracted.url,
            title: extracted.title,
            markdown: extracted.doc,
            frames: extracted.frames,
            frameDiagnostics: extracted.frameDiagnostics,
          }),
          `页面正文·${(extracted.title || extracted.url || '').slice(0, 60)}`,
        );
        if (saved.ok) {
          refId = saved.meta.id;
        } else {
          warnings.push(
            `全文暂存失败（${saved.reason}）——本次仅返回第 ${page} 页且后续页无法用 ref 续读；` +
              `需要其它页时重新调用本工具（可带 page=N 按页重取）`,
          );
        }
      } catch (error) {
        warnings.push(
          `全文暂存失败（${error instanceof Error ? error.message : String(error)}）——` +
            `本次仅返回第 ${page} 页且后续页无法用 ref 续读；可带 page=N 按页重取`,
        );
      }
    }

    const delivery = pageDelivery(extracted.doc, page, totalPages, {
      name: 'ref',
      value: refId ?? '',
    });
    if (!delivery.ok) return this.createErrorResponse(delivery.error);
    const payload: Record<string, unknown> = {
      // 统一交付格式：CSV 多列单行（content,page,totalPages,ref）。
      // 单页正文无需 ref 时该列为空串，按 page/totalPages 判断是否还有后续页。
      content: delivery.csv,
      frameDiagnostics: extracted.frameDiagnostics,
      coverage: { complete: false, source: 'Currently rendered DOM in discovered documents', frames: extracted.frames, missingResults: extracted.missingResults },
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(extracted.challengeDetected ? { verificationRequired: true } : {}),
      ...(extracted.loadNote ? { note: extracted.loadNote } : {}),
    };
    return this.createSuccessResponse(
      payload,
      extracted.challengeDetected
        ? '页面被人机验证 / 风控拦截，未取到正文。请在已打开的前台标签页手动完成验证后重试，或换来源。'
        : totalChars === 0
          ? '页面没有可提取的可见文本（空白页或全部内容在画布/受限 frame 内）'
          : `已提取正文 ${totalChars} 字符（第 ${page}/${totalPages} 页）` +
            (refId ? `；续读用 ref="${refId}" + page=${delivery.slice.hasMore ? page + 1 : page}` : ''),
    );
  }

  /** ref 分页读取：只读暂存缓存，不访问任何标签页 */
  private async readCachedPage(refId: string, page: number): Promise<ToolResult> {
    const entry = await getDataRef(refId);
    if (!entry) {
      const existing = await listDataRefs();
      const hint =
        existing.length > 0
          ? `当前可用批次（最多列出 10 个）：${existing.slice(0, 10).map(meta => meta.id + (meta.label ? `「${meta.label}」` : '')).join('、')}`
          : '暂存区为空（缓存可能已随浏览器会话过期，请重新读取页面）。';
      return this.createErrorResponse(`ref "${refId}" 不存在或已过期。${hint}`);
    }
    let parsed: { type?: string; markdown?: unknown; url?: unknown; title?: unknown; frames?: unknown; frameDiagnostics?: unknown };
    try {
      parsed = JSON.parse(entry.json);
    } catch {
      return this.createErrorResponse(`ref "${refId}" 缓存数据损坏，无法分页读取——请重新读取页面`);
    }
    if (parsed.type !== 'page-text' || typeof parsed.markdown !== 'string') {
      return this.createErrorResponse(
        `ref "${refId}" 不是页面正文批次（data_ref 暂存区中还有其它工具的数据）；分页续读请使用 read_website 返回的 path，或本工具返回的 ref`
      );
    }
    const doc = parsed.markdown;
    const totalChars = doc.length;
    const totalPages = Math.max(1, Math.ceil(totalChars / PAGE_CHARS_LIMIT));
    const delivery = pageDelivery(doc, page, totalPages, { name: 'ref', value: entry.id });
    if (!delivery.ok) return this.createErrorResponse(delivery.error);
    return this.createSuccessResponse(
      { content: delivery.csv, ...(isFrameReadReport(parsed.frameDiagnostics) ? { frameDiagnostics: parsed.frameDiagnostics } : { diagnosticNote: '缓存未附有效采集诊断，不能据此判断原始页面覆盖完整性。' }) },
      `已读取缓存 ${entry.id}${entry.label ? `「${entry.label}」` : ''} 第 ${page}/${totalPages} 页` +
        `（共 ${totalChars} 字符${delivery.slice.hasMore ? `，下一页 page=${page + 1}` : '，已到末页'}）`,
    );
  }
}

/**
 * 获取页面 HTML 工具
 */
/**
 * 页面源码读取工具（browser_get_page_html）
 *
 * 合并掉了旧的两个工具（**旧名全仓禁绝**）：
 *   - page-source            取页面 HTML 源码（含 iframe），但 format/includeIframes
 *                             是**死参数**——注入荷载恒为 outerHTML，format='text'
 *                             也返回 HTML；且无长度上限，大页面直接撑爆消息通道。
 *   - browser_get_page_html  取主 frame 的 outerHTML，无 iframe 覆盖、无上限。
 *
 * 合并后的能力（两者能力并集 + 修掉死参数）：
 *   - includeIframes=true 覆盖全部 frame（主 frame 置首，含跨域 iframe）
 *   - format='text' 真正返回可见纯文本（旧实现的 text 分支是死代码）
 *   - maxChars 硬上限，超限截断并如实标注 truncated（默认 200000 字符）
 */
export class GetPageHTMLTool extends BaseBrowserTool {
  name = 'browser_get_page_html';

  metadata: ToolMetadata = {
    name: 'browser_get_page_html',
    description: '获取当前页面的 HTML 源码或可见纯文本（可含全部 iframe，带长度上限）',
    category: 'browser',
    version: '2.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'content', 'html', 'source']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_get_page_html',
      description:
        '获取页面的 HTML 源码或可见纯文本。format=html（默认）返回 outerHTML；' +
        'format=text 返回可见纯文本（不含脚本与样式）。includeIframes=true 时覆盖全部 frame' +
        '（含跨域 iframe），主 frame 置首。maxChars 为硬上限（默认 200000），超限截断并标注 truncated。' +
        '需要结构化 Markdown 正文请用 read_website（它会解析表格/列表/代码块并自动分页落盘）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: {
            type: 'number',
            description: '标签页 ID（可选，默认当前活动标签页）'
          },
          format: {
            type: 'string',
            enum: ['html', 'text'],
            description: '返回格式：html=源码（默认）；text=可见纯文本',
            default: 'html'
          },
          includeIframes: {
            type: 'boolean',
            description: '是否包含全部 iframe 的内容（默认 false=只取主 frame）',
            default: false
          },
          maxChars: {
            type: 'number',
            description: '返回内容的字符上限（默认 200000，超限截断并标注 truncated）',
            default: 200000
          }
        },
        required: []
      }
    }
  };

  async execute(args: { tabId?: number; format?: 'html' | 'text'; includeIframes?: boolean; maxChars?: number } = {}, context?: ToolExecutionContext): Promise<ToolResult> {
    this.ensureBackgroundContext();
    if (context?.signal?.aborted) return this.createErrorResponse('ABORTED：读取前已取消');

    try {
      const format = args?.format === 'text' ? 'text' : 'html';
      const includeIframes = args?.includeIframes === true;
      const maxChars = typeof args?.maxChars === 'number' && Number.isFinite(args.maxChars) && args.maxChars > 0
        ? Math.min(args.maxChars, 2_000_000)
        : 200_000;

      const tab = typeof args?.tabId === 'number'
        ? await withDeadline(() => browserChrome(context).tabs.get(args.tabId!), 5000, 'Read HTML target', context?.signal)
        : await withDeadline(() => this.getActiveTab(context), 5000, 'Read active HTML target', context?.signal);

      if (!tab || typeof tab.id !== 'number') {
        return this.createErrorResponse('No active tab found');
      }

      if (typeof args?.tabId === 'number') context?.onTabTarget?.(tab.id);

      const results = await readPageFrames({
        target: { tabId: tab.id, ...(includeIframes ? { allFrames: true } : {}) },
        func: (wantText: boolean, limit: number) => {
          const text = wantText ? (document.body?.innerText || document.body?.textContent || '') : (document.documentElement?.outerHTML || '');
          return { content: text.slice(0, limit + 1), totalLength: text.length };
        },
        args: [format === 'text', maxChars],
      }, { operation: 'page-source', signal: context?.signal, maxResultChars: Math.ceil(maxChars + 1),
        measureResult: (value: unknown) => typeof value === 'string' ? value.length : typeof (value as { content?: unknown } | null)?.content === 'string' ? (value as { content: string }).content.length : 0 }, context);

      // 多 frame 时按 frameId 排序：主 frame（frameId 0）置首，其余保持注入顺序
      const frames: Array<{ frameId: number; content: string; totalLength: number }> = [];
      for (const frame of results) {
        const payload: unknown = frame.result;
        if (typeof payload === 'string') { frames.push({ frameId: frame.frameId, content: payload, totalLength: payload.length }); continue; }
        const value = payload as { content?: unknown; totalLength?: unknown } | null;
        if (!value || typeof value.content !== 'string' || typeof value.totalLength !== 'number' || !Number.isSafeInteger(value.totalLength) || value.totalLength < value.content.length) {
          addFrameIssue(results.frameDiagnostics, { frameId: frame.frameId, stage: 'read', code: 'INVALID_RESULT', message: 'Frame returned an invalid source payload' });
          continue;
        }
        frames.push({ frameId: frame.frameId, content: value.content, totalLength: value.totalLength });
      }
      if (!frames.length) return { ...this.createErrorResponse('NO_RESULT：所有 frame 均未返回有效页面源码'), data: { frameDiagnostics: results.frameDiagnostics } };

      const full = frames.map(frame => frame.content).join('\n\n');
      const truncated = full.length > maxChars || frames.some(frame => frame.totalLength > frame.content.length) || results.frameDiagnostics.issues.some(i => i.code === 'RESULT_BUDGET_EXCEEDED');
      const content = truncated ? trimDanglingSurrogate(full, maxChars) : full;
      const totalLength = frames.reduce((sum, frame) => sum + frame.totalLength, 0) + Math.max(0, frames.length - 1) * 2;

      return this.createSuccessResponse({
        htmlContent: content,
        content,
        format,
        includeIframes,
        url: tab.url,
        title: tab.title,
        tabId: tab.id,
        length: content.length,
        totalLength,
        totalLengthIsLowerBound: results.frameDiagnostics.status !== 'complete',
        truncated,
        frameCount: frames.length,
        frameDiagnostics: results.frameDiagnostics,
        ...(truncated
          ? { note: `返回内容按 ${maxChars} 字符截断；已读取 frame 的原始长度合计 ${totalLength}，未读取部分见 frameDiagnostics。需要结构化正文分页请用 read_website` }
          : {}),
      }, 'Page source retrieved successfully');
    } catch (error) {
      return { ...this.createErrorResponse('Failed to get page HTML', error), ...(error instanceof PageReadError ? { data: { frameDiagnostics: error.frameDiagnostics } } : {}) };
    }
  }
}

/**
 * 获取当前页面信息工具
 */
export class GetCurrentPageInfoTool extends BaseBrowserTool {
  name = 'browser_get_page_info';

  metadata: ToolMetadata = {
    name: 'browser_get_page_info',
    description: '获取当前页面的基本信息',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'info', 'page'],
    // 纯读（chrome.tabs.query 元信息）：不触碰视口，视觉循环无需重拍
    noVisionRecapture: true
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_get_page_info',
      description: '获取当前页面的基本信息（URL、标题、加载状态等）',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '标签页 ID（可选，默认当前活动标签页）'
          }
        },
        required: []
      }
    }
  };

  async execute(args: { tabId?: number } = {}, context?: ToolExecutionContext): Promise<ToolResult> {
    this.ensureBackgroundContext();
    if (context?.signal?.aborted) return this.createErrorResponse('ABORTED：读取前已取消');

    try {
      const tab = typeof args?.tabId === 'number'
        ? await withDeadline(() => browserChrome(context).tabs.get(args.tabId!), 5000, 'Read page-info target', context?.signal)
        : await withDeadline(() => this.getActiveTab(context), 5000, 'Read active page-info target', context?.signal);

      if (!tab || typeof tab.id !== 'number') {
        return this.createErrorResponse('No active tab found');
      }

      if (typeof args?.tabId === 'number') context?.onTabTarget?.(tab.id);

      // 获取页面加载状态和其他信息
      const results = await readPageFrames({
        target: { tabId: tab.id },
        func: () => {
          return {
            readyState: document.readyState,
            title: document.title,
            url: document.URL,
            referrer: document.referrer,
            lastModified: document.lastModified,
            characterSet: document.characterSet,
            contentType: document.contentType,
            width: document.documentElement?.scrollWidth ?? 0,
            height: document.documentElement?.scrollHeight ?? 0,
            visibleWidth: window.innerWidth,
            visibleHeight: window.innerHeight
          };
        }
      }, { operation: 'page-info', signal: context?.signal }, context);

      const pageDetails = results?.[0]?.result || {};
      if (typeof pageDetails !== 'object' || Array.isArray(pageDetails) || typeof (pageDetails as { readyState?: unknown }).readyState !== 'string') {
        addFrameIssue(results.frameDiagnostics, { frameId: results[0]?.frameId, stage: 'read', code: 'INVALID_RESULT', message: 'Page-info injection returned malformed metadata' });
        return { ...this.createErrorResponse('INVALID_RESULT：页面信息格式异常'), data: { frameDiagnostics: results.frameDiagnostics } };
      }

      return this.createSuccessResponse({
        ...pageDetails,
        frameDiagnostics: results.frameDiagnostics,
        tabId: tab.id,
        windowId: tab.windowId,
        active: tab.active,
        status: tab.status,
        incognito: tab.incognito,
        pinned: tab.pinned,
        audible: tab.audible,
        mutedInfo: tab.mutedInfo
      }, 'Page info retrieved successfully');
    } catch (error) {
      return { ...this.createErrorResponse('Failed to get page info', error), ...(error instanceof PageReadError ? { data: { frameDiagnostics: error.frameDiagnostics } } : {}) };
    }
  }
}

// 导出工具实例
export const getPageTextTool = new GetPageTextTool();
export const getPageHTMLTool = new GetPageHTMLTool();
export const getCurrentPageInfoTool = new GetCurrentPageInfoTool();

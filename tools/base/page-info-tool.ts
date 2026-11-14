import { structuredPagePayload } from '../browser/structured-page-payload';
import { waitForTabReady } from '../browser/page-load';
import { detectChallengeFromText } from '../browser/challenge-detect';
import { saveDataRefJson, getDataRef, listDataRefs } from '@/utils/data-ref-store';
import { trimDanglingSurrogate } from '@/utils/text/truncate';
import { isRestrictedUrl } from '@/common/constants';
import { existingNavigationWindowId } from '../browser/navigation-window';
/**
 * 页面信息工具
 * 提供获取当前页面文本、HTML、基本信息等功能
 */

import { BaseBrowserTool } from './browser-tool';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';

/** 单次响应正文上限（字符）：超过即缓存全量并分页 */
const PAGE_CHARS_LIMIT = 15_000;
/** 整篇正文上限（字符）：防超大页撑爆注入回传与暂存区（8MB 字节配额按最坏 CJK 3 字节预留） */
const MAX_DOC_CHARS = 2_000_000;
/** url 模式前台标签页的加载等待上限 */
const URL_LOAD_TIMEOUT_MS = 30_000;
/** url 参数长度上限（超长必为误用） */
const MAX_URL_PARAM_CHARS = 8_192;
/** 响应内标题展示上限 */
const MAX_TITLE_CHARS = 300;
/** frame 标头中 URL 的展示上限 */
const MAX_FRAME_URL_CHARS = 200;

/**
 * 按页切片（代理项安全）：
 * - 末边界落在增补平面前半（高位代理）时回退一位，该字符归下一页；
 * - 起边界若恰好是上一页末边界回退遗留的高位代理的后半，回退一位与其前半配对，
 *   保证任何页都不出现孤立代理项、也不丢字符。
 */
function pageSlice(doc: string, page: number, limit: number): string {
  const rawStart = Math.min((page - 1) * limit, doc.length);
  let start = rawStart;
  if (start > 0) {
    const before = doc.charCodeAt(start - 1);
    if (before >= 0xd800 && before <= 0xdbff) start -= 1;
  }
  const rawEnd = Math.min(page * limit, doc.length);
  let end = rawEnd;
  if (end > start && end < doc.length) {
    const last = doc.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return doc.slice(start, end);
}

/**
 * 获取页面文本工具（结构化 Markdown 正文）
 *
 * 能力（原 getPageMarkdown 已并入本工具后下线）：
 *   - 结构化提取：标题层级 / 表格（rowspan+colspan 还原）/ 列表（嵌套+任务项）/
 *     代码块+语言 / 链接目标 / 引用 / 图片 / 表单控件；
 *   - 覆盖面：全部可注入 frame（allFrames）+ 可访问 shadow root（slot 分发感知）；
 *     自动剔除 script/style/svg/canvas 等噪声、隐藏内容与无意义空白/编码串；
 *   - url 参数（单个，http/https）：**前台**打开目标页（新建并激活标签页，等同
 *     browser_navigation 的 open + newTab=true），等待加载完成后再提取，标签页
 *     保留在用户**眼前**（不后台打开、不自动关闭）——后台加载拿不到真实浏览
 *     上下文，是触发人机验证（Cloudflare 等）的常见诱因；页面若弹出验证，
 *     用户可在该标签页手动完成后重试；
 *   - 分页：单次正文 ≤15k 字符；超长全文自动缓存为 dataRef（引用 ID + 页码续读，
 *     暂存区与 browser_network_capture 共用，同一 TTL）。
 */
export class GetPageTextTool extends BaseBrowserTool {
  name = 'browser_get_page_text';

  metadata: ToolMetadata = {
    name: 'browser_get_page_text',
    description:
      '读取页面为结构化 Markdown 正文：保留标题层级/表格/列表/代码块+语言/链接/引用结构，' +
      '覆盖全部可注入 frame 与可访问 shadow root；超 15k 字符自动缓存分页',
    category: 'browser',
    version: '2.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'content', 'text', 'markdown', 'structured'],
    // 纯读豁免重拍的前提是「不改变用户可见的页面」：不带 url 时只读当前标签页，
    // 视图未变可豁免；带 url 的前台打开会切换用户眼前的页面，必须重拍
    // （豁免口径见 vision-feedback.ts 的 FOREGROUND_OPENING_TOOLS：按调用参数判定）。
    noVisionRecapture: true
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_get_page_text',
      description:
        '读取页面正文并转为结构化 Markdown：保留标题层级、表格（含合并单元格）、列表、代码块及语言、链接目标、引用、图片与表单控件；' +
        '覆盖当前页全部可注入 frame（iframe）与可访问 shadow root，自动剔除隐藏内容、脚本/样式/SVG/Canvas 与无意义空白。' +
        '默认读当前活动标签页；url=单个网址 时**前台打开该页面**（新建并激活标签页，等同 browser_navigation(action="open")）并等待加载完成后提取，' +
        '标签页会保留在用户眼前（不后台打开、不自动关闭）——遇到人机验证可在该标签页手动完成后再重试；tabId 可指定标签页。' +
        '单次正文最多 15000 字符：超出时全量自动缓存并返回引用 ID（ref）与总页数，' +
        '用 ref+page 分页续读（缓存浏览器会话内约 12 小时有效），响应含 totalChars/hasMore/nextPage。' +
        '需要交互展开、批量抽取时用 browser_interact / js_run。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '目标网址（可选，仅支持单个 http/https URL）。提供后在前台新建并激活标签页打开、等待加载完成再提取，标签页保留不关闭；不提供则读当前标签页'
          },
          tabId: {
            type: 'number',
            description: '标签页 ID（可选，默认当前活动标签页；与 url 互斥）'
          },
          ref: {
            type: 'string',
            description: '分页引用 ID（可选，上次超长响应返回的 ref）。提供时不访问任何标签页，直接读缓存正文指定页；与 url、tabId 互斥'
          },
          page: {
            type: 'number',
            description: '页码（可选，默认 1，每页 15000 字符）。超长正文直接指定页码读取，或配合 ref 续读'
          }
        },
        required: []
      }
    }
  };

  async execute(rawArgs: { url?: unknown; tabId?: unknown; ref?: unknown; page?: unknown } = {}, context?: ToolExecutionContext): Promise<ToolResult> {
    this.ensureBackgroundContext();

    // 参数整体形态防御：非对象（含数组/字符串）按模型误用拒绝，
    // 错误信息里带实际类型便于自纠——静默当空对象处理会走错目标页
    if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      return this.createErrorResponse(
        `参数必须是对象 { url?, tabId?, ref?, page? }，实际收到 ${Array.isArray(rawArgs) ? 'array' : typeof rawArgs}`
      );
    }
    const args = rawArgs;

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
    if (args.tabId !== undefined && args.tabId !== null &&
      (!Number.isInteger(args.tabId) || (args.tabId as number) < 0)) {
      return this.createErrorResponse(`tabId 必须为非负整数，实际收到 ${String(args.tabId)}`);
    }
    const requestedTabId = args.tabId as number | undefined;
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
      return this.readCachedPage(ref, page);
    }
    if (url && requestedTabId !== undefined && requestedTabId !== null) {
      return this.createErrorResponse('url 与 tabId 互斥：url 模式自行打开目标页面，请只提供其一');
    }

    // ── 解析目标标签页 ──
    let targetTabId: number | undefined;
    let loadNote: string | undefined;
    let resolvedUrl: string | undefined;
    if (url) {
      if (url.length > MAX_URL_PARAM_CHARS) {
        return this.createErrorResponse(`url 过长（${url.length} 字符，上限 ${MAX_URL_PARAM_CHARS}）`);
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return this.createErrorResponse(`url 无法解析：${url.slice(0, 200)}`);
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return this.createErrorResponse(`url 仅支持 http/https 协议，实际收到 ${parsedUrl.protocol}`);
      }
      // 复用同址标签页：窗口内已有同 URL 的标签时直接切过去读，免开重复页面
      // （与 browser_navigation「新建或复用相同完整 URL 标签」同策略）。
      // 不做模糊归一——路径 / 查询的大小写与尾斜杠可能有业务含义。
      try {
        const windowId = await existingNavigationWindowId();
        const sameUrlTabs = await chrome.tabs.query({ windowId });
        const reusable = sameUrlTabs.find(tab => typeof tab.id === 'number' && tab.url === parsedUrl.href);
        if (reusable && typeof reusable.id === 'number') {
          await chrome.tabs.update(reusable.id, { active: true });
          // 复用来的标签页可能仍在加载（刚被打开过）——同样等就绪再提取；
          // 标签页在等待期间被用户关掉时**放弃复用**，转走新建分支——
          // 拿着已消失的 tabId 去注入只会得到一句无信息量的报错。
          const wait = await this.waitForUrlTab(reusable.id, URL_LOAD_TIMEOUT_MS);
          if (wait.ok) {
            targetTabId = reusable.id;
            resolvedUrl = reusable.url ?? url;
            context?.onTabTarget?.(reusable.id);
            loadNote = wait.note;
          }
        }
      } catch { /* 查询失败不阻断，走正常前台打开 */ }
      if (targetTabId === undefined) {
        try {
          // 前台打开（等同 browser_navigation 的 open + newTab=true 语义）：标签页可见、
          // 获得焦点并**保留在用户眼前**——后台打开的页面拿不到真实浏览上下文，
          // 正是人机验证（Cloudflare 等）最常见的触发原因。用户可在该标签页
          // 手动完成验证后重试，模型也不必猜内容。
          // 窗口边界与 browser_navigation 一致：绑定现有普通窗口，绝不隐式新建窗口。
          const windowId = await existingNavigationWindowId();
          const created = await chrome.tabs.create({ url, active: true, windowId });
          if (!created || typeof created.id !== 'number') {
            return this.createErrorResponse('目标标签页打开失败');
          }
          context?.onTabTarget?.(created.id);
          // 聚焦窗口，让用户看见这次跳转（与 navigate 的行为对齐）
          try {
            await chrome.windows.update(windowId, { focused: true });
          } catch {
            // 聚焦失败（窗口最小化 / API 不可用）不阻断提取
          }
          const wait = await this.waitForUrlTab(created.id, URL_LOAD_TIMEOUT_MS);
          if (!wait.ok) {
            return this.createErrorResponse(`目标页面加载失败：${wait.note ?? '未知原因'}`);
          }
          loadNote = wait.note;
          targetTabId = created.id;
          resolvedUrl = url;
        } catch (error) {
          return this.createErrorResponse('目标页面打开失败', error);
        }
      }
    } else {
      try {
        const tab = requestedTabId !== undefined && requestedTabId !== null
          ? await chrome.tabs.get(requestedTabId)
          : await this.getActiveTab();
        if (!tab || typeof tab.id !== 'number') {
          return this.createErrorResponse('No active tab found');
        }
        if (isRestrictedUrl(tab.url)) {
          return this.createErrorResponse(
            `Current page is a restricted URL (${tab.url}) where script injection is not permitted. Navigate to a normal web page first.`
          );
        }
        targetTabId = tab.id;
        resolvedUrl = tab.url ?? undefined;
      } catch (error) {
        return this.createErrorResponse('Failed to resolve target tab', error);
      }
    }
    // 两条分支之外仍无目标（理论不可达，防御性兜底）——不把 undefined 传给注入
    if (typeof targetTabId !== 'number') {
      return this.createErrorResponse('未能解析目标标签页（未提供可用 tabId/url，且无活动标签页）');
    }

    if (requestedTabId != null) context?.onTabTarget?.(targetTabId);

    // ── 注入提取（allFrames + shadow root 感知荷载）──
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: targetTabId, allFrames: true },
        world: 'ISOLATED',
        func: structuredPagePayload,
      });
      return this.assembleResponse(results ?? [], { targetTabId, requestedUrl: resolvedUrl, page, loadNote });
    } catch (error) {
      return this.createErrorResponse('Failed to get page text', error);
    }
  }

  /**
   * url 模式的前台标签页加载等待：完成 / 超时软失败（按已渲染内容继续）/ 标签页消失。
   *
   * 就绪判定委托 tools/browser/page-load.ts 的单一实现（status + readyState
   * 双检连续两次；受限页探测被拒时退化为只看 status）——与 browser_navigation
   * 同源，杜绝多份等待逻辑漂移。本方法只做策略映射：
   * 就绪 → ok；超时 → **软失败**（按已渲染内容继续提取，不阻断）；关闭 → 失败。
   */
  private async waitForUrlTab(tabId: number, timeoutMs: number): Promise<{ ok: boolean; note?: string }> {
    const outcome = await waitForTabReady(tabId, { timeoutMs, pollIntervalMs: 250 });
    if (outcome.ready) return { ok: true };
    if (outcome.reason === 'closed') return { ok: false, note: '标签页在加载期间被关闭' };
    return { ok: true, note: '页面加载超时，已按当前已渲染内容提取' };
  }

  /** 组装多 frame 结果 → 整篇正文 → 缓存与分页封装 */
  private async assembleResponse(
    results: Array<{ frameId?: number; result?: unknown }>,
    options: { targetTabId: number; requestedUrl?: string; page: number; loadNote?: string },
  ): Promise<ToolResult> {
    const { targetTabId, requestedUrl, page, loadNote } = options;
    const warnings: string[] = [];

    const frames = results
      .filter(entry => entry && entry.result && typeof entry.result === 'object')
      .map(entry => ({ frameId: entry.frameId ?? 0, ...(entry.result as ReturnType<typeof structuredPagePayload>) }))
      .filter(frame => typeof frame.markdown === 'string')
      // 主 frame（0）置首，其余按 frameId 升序——正文阅读顺序稳定
      .sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : a.frameId - b.frameId));
    const missingResults = results.length - frames.length;
    if (missingResults > 0) {
      warnings.push(`${missingResults} 个 frame 注入失败或未返回有效结果（受限/跨域 frame 不保证覆盖）`);
    }
    for (const frame of frames) {
      if (frame.error) warnings.push(`Frame ${frame.frameId} 提取异常：${frame.error}`);
    }
    if (frames.length === 0) {
      return this.createErrorResponse('页面注入成功但没有可提取的正文（可能是空白页或注入被拒绝）');
    }

    const mainFrame = frames.find(frame => frame.frameId === 0) ?? frames[0];
    const url = requestedUrl || mainFrame.url || '';
    // 标题收敛为单行（页面 <title> 可能含换行/多空格，直接拼进 # 标题行会破坏结构）
    const title = (mainFrame.title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);

    // 空正文 frame 不进入正文段（只保留在 coverage 里）——否则多 frame 页会
    // 产出只有标头的空段；有内容的 frame 数决定是否加 FrameId 标头
    const contentFrames = frames.filter(frame => frame.markdown.trim() !== '');
    const displayUrl = (frameUrl: string): string =>
      frameUrl.length > MAX_FRAME_URL_CHARS
        ? trimDanglingSurrogate(frameUrl, MAX_FRAME_URL_CHARS) + '…'
        : frameUrl;
    const sections = contentFrames.map(frame =>
      contentFrames.length > 1
        ? `[FrameId=${frame.frameId} | ${displayUrl(frame.url)}]\n\n${frame.markdown}`
        : frame.markdown,
    );
    let doc = (title ? `# ${title}\n\n` : '') + sections.join('\n\n');

    // ── 人机验证 / 风控拦截页识别 ──
    // 判定口径与 browser_crawl 共用（tools/browser/challenge-detect.ts）：
    // 同一验证页在两条路径上必须得到相同结论，否则模型会以为「单页读取
    // 正常」而继续在验证页上重试。
    const challenge = detectChallengeFromText(title, mainFrame.markdown);
    if (challenge.detected) {
      warnings.push(
        '页面疑似人机验证 / 风控拦截页（正文未加载）。请在刚打开的前台标签页手动完成验证后重试，或改用其它来源；不要把本页内容当作事实依据。',
      );
    }

    let docTruncated = false;
    if (doc.length > MAX_DOC_CHARS) {
      doc = trimDanglingSurrogate(doc, MAX_DOC_CHARS) + '\n\n…［全文超长已截断］';
      docTruncated = true;
      warnings.push(`正文超过 ${MAX_DOC_CHARS} 字符上限，已截断`);
    }

    const totalChars = doc.length;
    const totalPages = Math.max(1, Math.ceil(totalChars / PAGE_CHARS_LIMIT));
    if (page > totalPages) {
      return this.createErrorResponse(
        `page=${page} 超出范围：正文共 ${totalChars} 字符、${totalPages} 页${totalPages > 1 ? `（1..${totalPages}）` : ''}`
      );
    }

    // 超长正文缓存为 dataRef（与 browser_network_capture 同一暂存区），后续 ref+page 分页续读
    let refId: string | undefined;
    if (totalChars > PAGE_CHARS_LIMIT) {
      let saved: Awaited<ReturnType<typeof saveDataRefJson>>;
      try {
        saved = await saveDataRefJson(
          JSON.stringify({
            type: 'page-text',
            v: 1,
            url,
            title,
            markdown: doc,
            frames: frames.map(({ frameId, url: frameUrl, truncated, shadowRoots, markdown }) => ({
              frameId, url: frameUrl, truncated, shadowRoots, chars: markdown.length,
            })),
          }),
          `页面正文·${(title || url || '').slice(0, 60)}`,
        );
      } catch (error) {
        saved = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      if (saved.ok) {
        refId = saved.meta.id;
      } else {
        warnings.push(
          `全文暂存失败（${saved.reason}）——本次仅返回第 ${page} 页且后续页无法用 ref 续读；` +
            `需要其它页时重新调用本工具（可带 page=N 按页重取）`,
        );
      }
    }

    const content = pageSlice(doc, page, PAGE_CHARS_LIMIT);
    const hasMore = page < totalPages;
    const payload: Record<string, unknown> = {
      textContent: content,
      url,
      title,
      tabId: targetTabId,
      length: content.length,
      totalChars,
      page,
      totalPages,
      hasMore,
      ...(hasMore ? { nextPage: page + 1 } : {}),
      ...(refId ? { ref: refId } : {}),
      ...(refId && hasMore
        ? {
            refGuide:
              `全文已缓存（引用 ${refId}，浏览器会话内约 12 小时有效）：` +
              `续读用 browser_get_page_text(ref="${refId}", page=${page + 1})，共 ${totalPages} 页`,
          }
        : {}),
      coverage: {
        frames: frames.map(({ frameId, url: frameUrl, truncated, shadowRoots, markdown }) => ({
          frameId,
          url: frameUrl,
          chars: markdown.length,
          ...(truncated ? { truncated: true } : {}),
          ...(shadowRoots ? { shadowRoots } : {}),
        })),
        missingResults,
        ...(docTruncated ? { docTruncated: true } : {}),
      },
      ...(loadNote ? { note: loadNote } : {}),
      ...(challenge.detected ? { verificationRequired: true } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      hint:
        '结构化 Markdown 正文：保留标题/表格/列表/代码块/链接结构，覆盖全部可注入 frame 与可访问 shadow root；' +
        '已剔除隐藏内容与脚本/SVG/Canvas 等噪声。画布/未加载数据不保证覆盖；不足时改用本会话可用的观察类工具'
    };
    return this.createSuccessResponse(
      payload,
      challenge.detected
        ? '页面被人机验证 / 风控拦截，未取到正文。请在已打开的前台标签页手动完成验证后重试，或换来源。'
        : totalChars === 0
          ? '页面没有可提取的可见文本（空白页或全部内容在画布/受限 frame 内）'
          : `已提取结构化正文 ${totalChars} 字符` +
            `${contentFrames.length > 1 ? `（${contentFrames.length} 个 frame）` : ''}` +
            `${refId ? `，超长已缓存为 ${refId}（第 ${page}/${totalPages} 页）` : ''}`,
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
    let parsed: { type?: string; markdown?: unknown; url?: unknown; title?: unknown; frames?: unknown };
    try {
      parsed = JSON.parse(entry.json);
    } catch {
      return this.createErrorResponse(`ref "${refId}" 缓存数据损坏，无法分页读取——请重新读取页面`);
    }
    if (parsed.type !== 'page-text' || typeof parsed.markdown !== 'string') {
      return this.createErrorResponse(
        `ref "${refId}" 不是 browser_get_page_text 的页面正文批次（data_ref 暂存区中还有其它工具的数据）；分页续读请使用本工具返回的 ref`
      );
    }
    const doc = parsed.markdown;
    const totalChars = doc.length;
    const totalPages = Math.max(1, Math.ceil(totalChars / PAGE_CHARS_LIMIT));
    if (page > totalPages) {
      return this.createErrorResponse(
        `page=${page} 超出范围：该缓存正文共 ${totalChars} 字符、${totalPages} 页（1..${totalPages}）`
      );
    }
    const content = pageSlice(doc, page, PAGE_CHARS_LIMIT);
    const hasMore = page < totalPages;
    return this.createSuccessResponse(
      {
        source: 'ref',
        ref: entry.id,
        textContent: content,
        url: typeof parsed.url === 'string' ? parsed.url : '',
        title: typeof parsed.title === 'string' ? parsed.title : '',
        length: content.length,
        totalChars,
        page,
        totalPages,
        hasMore,
        ...(hasMore ? { nextPage: page + 1 } : {}),
        ...(Array.isArray(parsed.frames) ? { coverage: { frames: parsed.frames } } : {}),
      },
      `已读取缓存 ${entry.id}${entry.label ? `「${entry.label}」` : ''} 第 ${page}/${totalPages} 页` +
        `（共 ${totalChars} 字符${hasMore ? `，下一页 page=${page + 1}` : '，已到末页'}）`,
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
        '需要结构化 Markdown 正文请用 browser_get_page_text（它会解析表格/列表/代码块并自动分页）。',
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

    try {
      const format = args?.format === 'text' ? 'text' : 'html';
      const includeIframes = args?.includeIframes === true;
      const maxChars = typeof args?.maxChars === 'number' && Number.isFinite(args.maxChars) && args.maxChars > 0
        ? Math.min(args.maxChars, 2_000_000)
        : 200_000;

      const tab = typeof args?.tabId === 'number'
        ? await chrome.tabs.get(args.tabId)
        : await this.getActiveTab();

      if (!tab || typeof tab.id !== 'number') {
        return this.createErrorResponse('No active tab found');
      }

      if (typeof args?.tabId === 'number') context?.onTabTarget?.(tab.id);

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, ...(includeIframes ? { allFrames: true } : {}) },
        func: (wantText: boolean) => {
          if (wantText) {
            const body = document.body;
            return body ? (body.innerText || body.textContent || '') : '';
          }
          return document.documentElement ? document.documentElement.outerHTML : '';
        },
        args: [format === 'text'],
      });

      // 多 frame 时按 frameId 排序：主 frame（frameId 0）置首，其余保持注入顺序
      const frames = (results ?? [])
        .filter(frame => typeof frame.result === 'string')
        .sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : (a.frameId ?? 0) - (b.frameId ?? 0)));

      const full = frames.map(frame => frame.result as string).join('\n\n');
      const truncated = full.length > maxChars;
      const content = truncated ? full.slice(0, maxChars) : full;

      return this.createSuccessResponse({
        htmlContent: content,
        content,
        format,
        includeIframes,
        url: tab.url,
        title: tab.title,
        tabId: tab.id,
        length: content.length,
        totalLength: full.length,
        truncated,
        frameCount: frames.length,
        ...(truncated
          ? { note: `内容超过 ${maxChars} 字符，已截断（完整长度 ${full.length}）；需要全文请用 browser_get_page_text 的分页续读` }
          : {}),
      }, 'Page source retrieved successfully');
    } catch (error) {
      return this.createErrorResponse('Failed to get page HTML', error);
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

    try {
      const tab = typeof args?.tabId === 'number'
        ? await chrome.tabs.get(args.tabId)
        : await this.getActiveTab();

      if (!tab || typeof tab.id !== 'number') {
        return this.createErrorResponse('No active tab found');
      }

      if (typeof args?.tabId === 'number') context?.onTabTarget?.(tab.id);

      // 获取页面加载状态和其他信息
      const results = await chrome.scripting.executeScript({
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
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
            visibleWidth: window.innerWidth,
            visibleHeight: window.innerHeight
          };
        }
      });

      const pageDetails = results?.[0]?.result || {};

      return this.createSuccessResponse({
        ...pageDetails,
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
      return this.createErrorResponse('Failed to get page info', error);
    }
  }
}

// 导出工具实例
export const getPageTextTool = new GetPageTextTool();
export const getPageHTMLTool = new GetPageHTMLTool();
export const getCurrentPageInfoTool = new GetCurrentPageInfoTool();

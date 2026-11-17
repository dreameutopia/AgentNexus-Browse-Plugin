import { browserChrome } from '@/tools/browser/browser-scope';
/**
 * 页面正文提取引擎（read_website 与历史文本通道共用）
 *
 * 单一实现、两处消费，保证「同一页面在两条通道上得到完全一致的正文」：
 *   - 提取：全部可注入 frame（allFrames）+ 可访问 shadow root 的结构化 Markdown；
 *   - 组装：主 frame 置首，多 frame 时加 FrameId/URL 标头，空正文 frame 不入正文；
 *   - 判定：人机验证/风控页识别（与 browser_crawl 同源）；
 *   - 上限：单篇 2,000,000 字符（防撑爆注入回传与暂存区）；
 *   - 分页：单页 3,000 字符（≈3000 token），代理项安全切片；
 *   - 目标：url 前台打开（复用同址标签页，等待就绪）+ tabId/活动页解析。
 *
 * 本模块不持有任何缓存或文件语义：缓存留在历史文本通道，
 * 文件落盘留在 read_website，二者只共享「提取 + 切片 + CSV」。
 */

import { structuredPagePayload } from './structured-page-payload';
import { waitForTabReady } from './page-load';
import { detectChallengeFromText } from './challenge-detect';
import { existingNavigationWindowId } from './navigation-window';
import { resolveTabTarget } from './tab-target';
import { trimDanglingSurrogate } from '@/utils/text/truncate';
import type { ToolExecutionContext } from '../registry';
import { serializeCsv } from '@/utils/python-workspace/tabular';
import { readPageFrames, PageReadError, BrowserWaitError, withDeadline, addFrameIssue, type FrameReadReport, type FrameResults } from '../common/frame-read';
import { injectionErrorText } from '../common/script-injection';

/** 单页正文上限（字符）：≈3000 token（中英混排按 1 字符≈1 token 保守折算） */
export const PAGE_CHARS_LIMIT = 3_000;
/** 整篇正文上限（字符） */
export const MAX_DOC_CHARS = 2_000_000;
/** url 模式前台标签页的加载等待上限 */
const URL_LOAD_TIMEOUT_MS = 30_000;
/** url 参数长度上限（超长必为误用） */
const MAX_URL_PARAM_CHARS = 8_192;
/** 响应内标题展示上限 */
const MAX_TITLE_CHARS = 300;
/** frame 标头中 URL 的展示上限 */
const MAX_FRAME_URL_CHARS = 200;

/** 单个 frame 的覆盖信息（诊断用，不进入正文） */
export interface PageDocFrameInfo {
  frameId: number;
  documentId?: string;
  url: string;
  chars: number;
  truncated?: boolean;
  shadowRoots?: number;
}

export type PageDocFailure = { ok: false; error: string; frameDiagnostics?: FrameReadReport };

export interface PageDocSuccess {
  ok: true;
  /** 整篇结构化 Markdown（含标题与多 frame 标头） */
  doc: string;
  url: string;
  title: string;
  totalChars: number;
  totalPages: number;
  frames: PageDocFrameInfo[];
  missingResults: number;
  warnings: string[];
  frameDiagnostics?: FrameReadReport;
  /** 疑似人机验证/风控页 */
  challengeDetected: boolean;
  /** 全文触达 MAX_DOC_CHARS 被截断 */
  docTruncated: boolean;
  /** url 模式下的加载说明（超时软失败等） */
  loadNote?: string;
}

export type PageDocResult = PageDocSuccess | PageDocFailure;

export interface PageSlice {
  content: string;
  page: number;
  pageCount: number;
  totalChars: number;
  hasMore: boolean;
  nextPage?: number;
}

/**
 * 按页切片（代理项安全）：
 * - 末边界落在增补平面前半（高位代理）时回退一位，该字符归下一页；
 * - 起边界若恰好是上一页末边界回退遗留的高位代理的后半，回退一位与其前半配对，
 *   保证任何页都不出现孤立代理项、也不丢字符。
 */
export function pageSlice(doc: string, page: number, limit = PAGE_CHARS_LIMIT): PageSlice {
  // 防御：页码/页宽异常时收敛到合法值（调用方通常已校验，这里兜底防
  // 负下标切片返回文末内容、或 limit=0 导致除零）
  const safeLimit =
    Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : PAGE_CHARS_LIMIT;
  const safePage =
    Number.isSafeInteger(page) && page >= 1 ? page : 1;
  const pageCount = Math.max(1, Math.ceil(doc.length / safeLimit));
  const rawStart = Math.min((safePage - 1) * safeLimit, doc.length);
  let start = rawStart;
  if (start > 0) {
    const before = doc.charCodeAt(start - 1);
    if (before >= 0xd800 && before <= 0xdbff) start -= 1;
  }
  const rawEnd = Math.min(safePage * safeLimit, doc.length);
  let end = rawEnd;
  if (end > start && end < doc.length) {
    const last = doc.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  const hasMore = safePage < pageCount;
  return {
    content: doc.slice(start, end),
    page: safePage,
    pageCount,
    totalChars: doc.length,
    hasMore,
    ...(hasMore ? { nextPage: safePage + 1 } : {}),
  };
}

/**
 * 单页 + 元数据 → CSV（多列单行，RFC 4180 转义）。
 *
 * 统一格式：表头 content,page,totalPages,<tailName>，一行数据。
 * 正文中的逗号/引号/换行由 serializeCsv 正确转义，下游可直接 parseCsv。
 */
/**
 * 统一分页交付：越界校验 + CSV 封装。
 *
 * browser_get_page_text（tail=ref）与 read_website（tail=path）共用同一份
 * 切页/越界语义，避免两条链路出现「同一页数却一个报错一个返回空」的漂移。
 */
export function pageDelivery(
  doc: string,
  page: number,
  pageCount: number,
  tail: { name: 'ref' | 'path'; value: string },
): { ok: true; csv: string; slice: PageSlice } | { ok: false; error: string } {
  if (page > pageCount)
    return {
      ok: false,
      error: `page=${page} 超出范围：正文共 ${doc.length} 字符、${pageCount} 页（1..${pageCount}）`,
    };
  const slice = pageSlice(doc, page);
  return {
    ok: true,
    csv: pageCsv(slice.content, page, pageCount, tail),
    slice,
  };
}

export function pageCsv(
  content: string,
  page: number,
  totalPages: number,
  tail: { name: 'ref' | 'path'; value: string },
): string {
  return serializeCsv(['content', 'page', 'totalPages', tail.name], [
    [content, page, totalPages, tail.value],
  ]);
}

export interface PageTargetInput {
  url?: string;
  tabId?: number | string;
}

export type PageTargetResult =
  | { ok: true; tabId: number; url?: string; loadNote?: string }
  | PageDocFailure;

/**
 * 解析目标标签页。
 *
 * url 模式：校验协议/长度 → 复用窗口内同址标签页（切过去并等就绪）→ 否则
 * 前台新建并激活（与 browser_navigation 的 open+newTab 同语义），等待就绪；
 * 标签页保留不关闭，便于用户处理人机验证。
 * tabId 模式：统一走 resolveTabTarget（存在性/可注入性校验 + 切换到该页）。
 */
export async function resolvePageTarget(
  input: PageTargetInput,
  options: { tool: string; context?: ToolExecutionContext },
): Promise<PageTargetResult> {
  const { tool, context } = options;
  const signal = context?.signal;
  signal?.throwIfAborted();
  const notify = (tabId: number) => {
    try { context?.onTabTarget?.(tabId); }
    catch (error) { console.warn('[page-target] Target notification failed', injectionErrorText(error)); }
  };
  const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
  if (rawUrl) {
    if (input.tabId !== undefined && input.tabId !== null)
      return { ok: false, error: 'INVALID_ARGUMENT：url 与 tabId 互斥——url 模式会自行打开目标页面，请只提供其一。' };
    if (rawUrl.length > MAX_URL_PARAM_CHARS)
      return { ok: false, error: `INVALID_ARGUMENT：url 过长（${rawUrl.length} 字符，上限 ${MAX_URL_PARAM_CHARS}）。` };
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return { ok: false, error: `INVALID_ARGUMENT：url 无法解析：${rawUrl.slice(0, 200)}` };
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')
      return { ok: false, error: `INVALID_ARGUMENT：url 仅支持 http/https 协议，实际收到 ${parsedUrl.protocol}` };

    // 复用同址标签页（不做大小写/尾斜杠归一：路径可能带业务含义）
    try {
      const windowId = await withDeadline(() => existingNavigationWindowId(context), 5000, 'Resolve existing browser window', signal);
      const sameUrlTabs = await withDeadline(() => browserChrome(context).tabs.query({ windowId }), 5000, 'Find reusable page', signal);
      const reusable = sameUrlTabs.find(
        (tab) => typeof tab.id === 'number' && tab.url === parsedUrl.href,
      );
      if (reusable && typeof reusable.id === 'number') {
        await withDeadline(() => browserChrome(context).tabs.update(reusable.id!, { active: true }), 5000, 'Activate reusable page', signal);
        const wait = await waitForUrlTab(reusable.id, signal, context);
        if (wait.ok) {
          notify(reusable.id);
          return { ok: true, tabId: reusable.id, url: reusable.url ?? rawUrl, ...(wait.note ? { loadNote: wait.note } : {}) };
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof BrowserWaitError) return { ok: false, error: `TARGET_TIMEOUT：目标复用未确认：${injectionErrorText(error)}。未自动新建标签页，请先核对页面现状。` };
      // 查询失败不阻断：走前台新建
    }

    try {
      const windowId = await withDeadline(() => existingNavigationWindowId(context), 5000, 'Resolve existing browser window', signal);
      const created = await withDeadline(() => browserChrome(context).tabs.create({ url: rawUrl, active: true, windowId }), 5000, 'Create page tab', signal);
      if (!created || typeof created.id !== 'number')
        return { ok: false, error: 'TAB_CREATE_FAILED：目标标签页打开失败（浏览器未返回标签页 ID）。' };
      notify(created.id);
      try {
        await withDeadline(() => browserChrome(context).windows.update(windowId, { focused: true }), 3000, 'Focus page window', signal);
      } catch {
        signal?.throwIfAborted();
        // 聚焦失败（窗口最小化/API 不可用）不阻断提取
      }
      const wait = await waitForUrlTab(created.id, signal, context);
      if (!wait.ok)
        return { ok: false, error: `PAGE_LOAD_FAILED：目标页面加载失败：${wait.note ?? '未知原因'}。` };
      return { ok: true, tabId: created.id, url: rawUrl, ...(wait.note ? { loadNote: wait.note } : {}) };
    } catch (error) {
      signal?.throwIfAborted();
      return {
        ok: false,
        error: `${error instanceof BrowserWaitError ? 'TAB_CREATE_UNCONFIRMED' : 'TAB_CREATE_FAILED'}：目标页面打开未确认：${injectionErrorText(error)}。请先用 browser_tabs 核对是否已经创建，勿直接重复打开。`,
      };
    }
  }

  const target = await resolveTabTarget({ tabId: input.tabId, tool, context });
  if (!target.ok) return { ok: false, error: target.error };
  return { ok: true, tabId: target.tabId, url: target.url };
}

/** url 模式加载等待：就绪 → ok；超时 → 软失败（按已渲染内容继续）；关闭 → 失败 */
async function waitForUrlTab(tabId: number, signal?: AbortSignal, context?: ToolExecutionContext): Promise<{ ok: boolean; note?: string }> {
  const outcome = await waitForTabReady(tabId, {
    timeoutMs: URL_LOAD_TIMEOUT_MS,
    pollIntervalMs: 250,
    signal,
  }, context);
  if (outcome.ready) return { ok: true };
  if (outcome.reason === 'closed') return { ok: false, note: '标签页在加载期间被关闭' };
  return { ok: true, note: '页面加载超时，已按当前已渲染内容提取' };
}

/**
 * 提取整篇正文（allFrames + shadow root 感知），并完成组装/上限/验证页判定。
 *
 * 调用方只负责：ref 缓存（page_text）或文件落盘（read_website）。
 */
export async function extractPageDoc(
  tabId: number,
  options: { requestedUrl?: string; loadNote?: string; signal?: AbortSignal } = {}, context?: ToolExecutionContext
): Promise<PageDocResult> {
  let results: FrameResults<ReturnType<typeof structuredPagePayload>>;
  try {
    results = await readPageFrames({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      func: structuredPagePayload,
    }, { operation: 'page-text', signal: options.signal, maxResultChars: MAX_DOC_CHARS,
      measureResult: payload => typeof payload?.markdown === 'string' ? payload.markdown.length : 0 }, context);
  } catch (error) {
    return {
      ok: false,
      ...(error instanceof PageReadError ? { frameDiagnostics: error.frameDiagnostics } : {}),
      error: `INJECTION_FAILED：页面注入失败（标签页可能已关闭/正在导航，或页面受限）：${
        error instanceof Error ? error.message : String(error)
      }。请确认页面可读后用 browser_tabs 重试。`,
    };
  }

  const frameDiagnostics = results.frameDiagnostics;
  const warnings: string[] = [];
  const frames: Array<ReturnType<typeof structuredPagePayload> & { frameId: number; documentId?: string }> = [];
  for (const row of results) {
    const payload = row.result;
    if (payload?.error) addFrameIssue(frameDiagnostics, { frameId: row.frameId, stage: 'read', scope: typeof payload.markdown === 'string' && payload.markdown.length ? 'coverage' : 'frame', code: 'PAYLOAD_ERROR', message: injectionErrorText(payload.error) });
    if (!payload || typeof payload.markdown !== 'string') {
      addFrameIssue(frameDiagnostics, { frameId: row.frameId, stage: 'read', code: 'INVALID_RESULT', message: 'Frame did not return a Markdown string' });
      continue;
    }
    if (payload.truncated) addFrameIssue(frameDiagnostics, { frameId: row.frameId, stage: 'read', scope: 'coverage', code: 'CONTENT_TRUNCATED', message: typeof payload.truncationReason === 'string' ? payload.truncationReason : 'Frame content reached traversal, time, depth, or character budget; returned content is partial' });
    frames.push({ ...payload, frameId: row.frameId, documentId: row.documentId,
      url: typeof payload.url === 'string' ? payload.url : '',
      title: typeof payload.title === 'string' ? payload.title : '',
    });
  }
  const missingResults = new Set(frameDiagnostics.issues.filter(i => i.frameId !== undefined && !i.code.includes('TRUNCATED')).map(i => i.frameId)).size;
  if (missingResults > 0) warnings.push(`${missingResults} 个 frame 未完整获取，原因见 frameDiagnostics`);
  warnings.push(...frameDiagnostics.issues.map(i => `${i.stage}${i.frameId !== undefined ? ` frame=${i.frameId}` : ''}: ${i.code}: ${i.message}`));
  if (frames.length === 0) {
    return {
      ok: false,
      frameDiagnostics,
      error: 'EMPTY_EXTRACTION：页面注入成功但没有可提取的正文（可能是空白页、全部内容在画布内，或注入被拒绝）。',
    };
  }

  const mainFrame = frames.find((frame) => frame.frameId === 0) ?? frames[0];
  const url = (mainFrame.frameId === 0 ? mainFrame.url : '') || options.requestedUrl || mainFrame.url || '';
  const title = (mainFrame.title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);

  const contentFrames = frames.filter((frame) => frame.markdown.trim() !== '');
  // 全部 frame 都是空正文：标题-only 的结果会误导模型继续基于它推理，
  // 直接给出可执行的替代方案（截图/等待渲染）比返回一个空页面更有用
  if (contentFrames.length === 0) {
    return {
      ok: false,
      frameDiagnostics,
      error:
        `EMPTY_TEXT：页面没有可提取的正文${title ? `（标题「${title}」）` : ''}——` +
        '内容可能在 canvas/图片/视频内、仍在渲染骨架屏，或正文位于跨域受限 frame。' +
        '可先用 screenshot 查看实际画面，等待渲染完成后重试。',
    };
  }
  const displayUrl = (frameUrl: string): string =>
    frameUrl.length > MAX_FRAME_URL_CHARS
      ? trimDanglingSurrogate(frameUrl, MAX_FRAME_URL_CHARS) + '…'
      : frameUrl;
  const sections = contentFrames.map((frame) =>
    contentFrames.length > 1 || frame.frameId !== 0
      ? `[FrameId=${frame.frameId} | ${displayUrl(frame.url)}]\n\n${frame.markdown}`
      : frame.markdown,
  );
  let doc = (title ? `# ${title}\n\n` : '') + sections.join('\n\n');

  // 人机验证/风控页判定（与 browser_crawl 同源，保证两条路径结论一致）
  const challenge = detectChallengeFromText(title, mainFrame.markdown);
  if (challenge.detected)
    warnings.push(
      '页面疑似人机验证 / 风控拦截页（正文未加载）。请在刚打开的前台标签页手动完成验证后重试，或改用其它来源；不要把本页内容当作事实依据。',
    );

  let docTruncated = false;
  if (doc.length > MAX_DOC_CHARS) {
    doc = trimDanglingSurrogate(doc, MAX_DOC_CHARS) + '\n\n…［全文超长已截断］';
    docTruncated = true;
    addFrameIssue(frameDiagnostics, { stage: 'read', scope: 'coverage', code: 'DOCUMENT_TRUNCATED', message: `Combined document exceeded ${MAX_DOC_CHARS} characters; remaining text omitted` });
    warnings.push(`正文超过 ${MAX_DOC_CHARS} 字符上限，已截断`);
  }

  const totalChars = doc.length;
  return {
    ok: true,
    doc,
    url,
    title,
    totalChars,
    totalPages: Math.max(1, Math.ceil(totalChars / PAGE_CHARS_LIMIT)),
    frames: frames.map(({ frameId, documentId, url: frameUrl, truncated, shadowRoots, markdown }) => ({
      frameId,
      ...(documentId ? { documentId } : {}),
      url: frameUrl,
      chars: markdown.length,
      ...(truncated ? { truncated: true } : {}),
      ...(shadowRoots ? { shadowRoots } : {}),
    })),
    missingResults,
    warnings,
    frameDiagnostics,
    challengeDetected: challenge.detected,
    docTruncated,
    ...(options.loadNote ? { loadNote: options.loadNote } : {}),
  };
}

/** 文件名安全 slug（用于 read_website 的 content/*.md 命名） */
export function pageFileSlug(url: string, title: string): string {
  let source = '';
  try {
    const parsed = new URL(url);
    source = `${parsed.hostname}${parsed.pathname}`;
  } catch {
    source = url || title;
  }
  const cleaned = source
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'page';
}

/**
 * 工作区内容正则搜索（file_util action="grep" 的唯一实现）
 *
 * ==================== 职责边界 ====================
 *
 * - 只读：读取指定文件列表的文本内容，返回命中行、行号、页码与命中数；
 * - 不做替换、不落盘、不修改任何条目；
 * - 不做递归发现：文件列表由调用方显式给出（递归找文件请用
 *   workspace-listing 的 searchWorkspacePaths）。
 *
 * ==================== 页码契约 ====================
 *
 * 返回的 index 与 file_util(action="read") 的页一致（3000 字符/页），
 * 因此模型可以拿「相对路径 + index」直接精确续读，不必从第 1 页翻起。
 * 页码由 workspace-files.pageIndexForOffset 计算——与 read 共用同一套
 * 代理对安全的页边界算法，禁止在此另写一份。
 *
 * ==================== 防御性边界 ====================
 *
 * - 文件数上限、单文件字节上限、整次扫描总字节上限：避免宽正则 + 大文件
 *   把后台线程拖死；
 * - 非文本 / 不存在 / 目录 / 链接 / 超大 / 非 UTF-8 均**逐文件跳过**并回报
 *   原因，不让一个坏路径毁掉整次搜索；
 * - 正则编译失败在读取任何存储之前报错；
 * - 行文本截断到 400 字符，避免压缩包式超长单行撑爆上下文。
 */

import { WorkspaceOperationError } from '@/utils/shared/error-details';
import {
  parseWorkspaceFilePath,
  pageIndexForOffset,
  readWorkspaceSnapshot,
  WORKSPACE_READ_MAX_FILE_BYTES,
  WORKSPACE_TOOL_READ_PAGE_CHARS,
} from './workspace-files';
import { isTextFilePath } from '@/utils/upload-files/file-kinds';
import { decodeTextBytes } from '@/utils/upload-files/text-decode';

/** 单次内容搜索允许的文件数上限（递归发现不在本模块，列表必须显式且有限） */
export const CONTENT_SEARCH_MAX_FILES = 50;

/** 内容搜索结果每页命中行上限 */
export const CONTENT_SEARCH_PAGE_MAX = 30;

/** 单次内容搜索允许解码的总字节上限（防止多个大文件累计拖死后台线程） */
export const CONTENT_SEARCH_TOTAL_BYTES = 32 * 1024 * 1024;

/** 单行回传的最大字符数（超出截断，避免超长单行占用上下文） */
export const CONTENT_SEARCH_LINE_MAX_CHARS = 400;

/** 一条命中：文件相对路径 + 行号 + 页码 + 行内容 */
export interface WorkspaceContentMatch {
  path: string;
  /** 1 起的行号 */
  line: number;
  /** 该行在 file_util read 中的页码（1 起，3000 字符/页） */
  index: number;
  /** 命中行内容（最多 CONTENT_SEARCH_LINE_MAX_CHARS 字符） */
  text: string;
  /** 该行内正则命中次数 */
  matchCount: number;
}

/** 被跳过的文件及原因（逐文件隔离，不让坏输入中断整次搜索） */
export interface WorkspaceContentSkip {
  path: string;
  reason: string;
}

export interface WorkspaceContentSearchResult {
  matches: WorkspaceContentMatch[];
  /** 命中行总数（跨所有页） */
  total: number;
  nextOffset: number;
  hasMore: boolean;
  /** 实际读取并搜索的文件数 */
  scannedFiles: number;
  /** 被跳过的文件 */
  skipped: WorkspaceContentSkip[];
  /** 是否因总字节上限提前停止（结果只覆盖已扫描部分） */
  truncatedScan: boolean;
}

function fail(code: string, message: string): never {
  throw new WorkspaceOperationError(code, message);
}

/** 统计一行内的非重叠命中次数（零长度匹配也计入，且保证不死循环）。 */
function countMatches(line: string, globalMatcher: RegExp): number {
  globalMatcher.lastIndex = 0;
  let count = 0;
  let guard = 0;
  while (globalMatcher.exec(line) !== null) {
    count++;
    // 零长度匹配不会推进 lastIndex（如 pattern="^"）：手动前进一位，
    // 否则同一位置会被反复计数到 guard 上限，回报出虚高的命中数。
    if (globalMatcher.lastIndex === 0) globalMatcher.lastIndex++;
    if (++guard > 10_000) break;
  }
  return count;
}

/** 行文本截断（保留可读前缀 + 明确省略号；绝不切断代理对） */
function clipLine(line: string): string {
  if (line.length <= CONTENT_SEARCH_LINE_MAX_CHARS) return line;
  let end = CONTENT_SEARCH_LINE_MAX_CHARS;
  const code = line.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--; // 高代理项：向前收缩，保留完整代理对
  return line.slice(0, end) + '…';
}

/**
 * 在给定文件列表中做逐行正则搜索。
 *
 * @param rawFiles 工作区相对路径数组（1~CONTENT_SEARCH_MAX_FILES 个，自动去重）
 * @param rawPattern 正则表达式字符串（无 flags；忽略大小写请用字符类或内联分组）
 */
export async function searchWorkspaceFileContents(
  chatId: string,
  rawFiles: unknown,
  rawPattern: unknown,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<WorkspaceContentSearchResult> {
  if (typeof rawPattern !== 'string' || rawPattern.length === 0) {
    fail('INVALID_ARGUMENTS', 'grep 需要 pattern（非空正则表达式字符串，如 TODO|FIXME）');
  }
  if (rawPattern.length > 500) {
    fail('INVALID_ARGUMENTS', `pattern 长度 ${rawPattern.length} 超过 500 字符上限——请缩短 pattern 后重试`);
  }
  let matcher: RegExp;
  let globalMatcher: RegExp;
  try {
    matcher = new RegExp(rawPattern);
    globalMatcher = new RegExp(rawPattern, 'g');
  } catch (error) {
    fail(
      'INVALID_ARGUMENTS',
      `pattern 不是合法正则：${error instanceof Error ? error.message : String(error)}。请修正后重试（例如 TODO|FIXME）`,
    );
  }
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    fail(
      'INVALID_ARGUMENTS',
      'grep 需要 files（非空的工作区相对路径数组）。先用 list/search 找到目标文件，再传入本参数',
    );
  }
  if (rawFiles.length > CONTENT_SEARCH_MAX_FILES) {
    fail(
      'INVALID_ARGUMENTS',
      `files 数量 ${rawFiles.length} 超过上限 ${CONTENT_SEARCH_MAX_FILES}——请缩小文件列表后分批搜索`,
    );
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawFiles.length; i++) {
    const raw = rawFiles[i];
    if (typeof raw !== 'string' || !raw) {
      fail('INVALID_ARGUMENTS', `files[${i}] 必须是非空字符串（工作区相对路径，如 results/run-xxx.json）`);
    }
    const path = parseWorkspaceFilePath(raw);
    if (!seen.has(path)) {
      seen.add(path);
      files.push(path);
    }
  }

  const entries = await readWorkspaceSnapshot(chatId, signal);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));

  const matches: WorkspaceContentMatch[] = [];
  const skipped: WorkspaceContentSkip[] = [];
  let total = 0;
  let scannedFiles = 0;
  let scannedBytes = 0;
  let truncatedScan = false;

  for (const path of files) {
    signal?.throwIfAborted();
    const entry = byPath.get(path);
    // 链接条目没有 blob：必须先判链接，否则会被误报成「文件不存在」
    if (entry?.link) {
      skipped.push({ path, reason: '是符号链接——内容搜索只接受普通文件' });
      continue;
    }
    if (!entry?.blob) {
      skipped.push({
        path,
        reason: entry
          ? '是目录而不是文件——请用 list 展开目录，或把目录下的具体文件传给 files'
          : '文件不存在——先用 list/search 确认路径',
      });
      continue;
    }
    if (!isTextFilePath(path)) {
      skipped.push({
        path,
        reason: '不是文本文件——内容搜索仅支持文本；Office 文档请用 file_util(action="read") 转 Markdown 后搜索',
      });
      continue;
    }
    if (entry.blob.size > WORKSPACE_READ_MAX_FILE_BYTES) {
      skipped.push({
        path,
        reason: `文件 ${entry.blob.size} 字节超过单文件搜索上限 ${WORKSPACE_READ_MAX_FILE_BYTES}，请缩小文件或改用脚本处理`,
      });
      continue;
    }
    if (scannedBytes + entry.blob.size > CONTENT_SEARCH_TOTAL_BYTES) {
      truncatedScan = true;
      break;
    }
    scannedBytes += entry.blob.size;

    let text: string;
    try {
      const buffer = await entry.blob.arrayBuffer();
      signal?.throwIfAborted();
      text = decodeTextBytes(new Uint8Array(buffer)).text;
    } catch (error) {
      skipped.push({
        path,
        reason: `读取失败：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    scannedFiles++;

    const linePattern = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
    let lineNumber = 0;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = linePattern.exec(text)) !== null) {
      if (lineMatch[0].length === 0 && lineMatch.index >= text.length) break;
      lineNumber++;
      // 单文件可能是 16MB：每 2048 行检查一次取消信号，避免长扫描无法中断
      if ((lineNumber & 0x7ff) === 0) signal?.throwIfAborted();
      const lineText = lineMatch[0].replace(/(?:\r\n|\r|\n)$/, '');
      if (!matcher.test(lineText)) continue;
      total++;
      if (total <= offset || matches.length >= limit) continue;
      matches.push({
        path,
        line: lineNumber,
        index: pageIndexForOffset(text, lineMatch.index, WORKSPACE_TOOL_READ_PAGE_CHARS),
        text: clipLine(lineText),
        matchCount: countMatches(lineText, globalMatcher),
      });
    }
  }

  return {
    matches,
    total,
    nextOffset: Math.min(offset + limit, total),
    hasMore: offset + limit < total,
    scannedFiles,
    skipped,
    truncatedScan,
  };
}

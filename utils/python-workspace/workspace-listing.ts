/**
 * 会话工作区浏览语义（file_util 的 list / search 唯一实现）
 *
 * ==================== 为什么独立成模块 ====================
 *
 * 「盘点工作区某个目录」「按路径正则搜索」是模型定位文件的核心入口。
 * file_util 统一文件入口后，list/search/read 共用同一份快照与分页口径：
 * 若各 action 各写一份，目录缺失文案、条目字段、分页上限会逐渐漂移，
 * 模型会在同一工作区里看到互相矛盾的结果。
 *
 * 本模块把浏览语义收敛为**唯一实现**：字段形状、报错文案（含错误码）、
 * 分页口径、回执句式逐字一致。
 *
 * ==================== 语义要点 ====================
 *
 * - 只盘点**已存在**的目录：目录不存在显式报错（不返回空列表）——把拼写错误
 *   静默成「没有数据」会让模型在错误路径上继续推断。
 * - 报错必须带**可执行的下一步**：回显当前根目录概览 + 「省略 path 列根目录」。
 * - 文件路径不能当目录盘点：明确区分「是文件不是目录」，并给出对应的
 *   read 调用（模型的下一步通常是读文件内容，而不是继续盘点）。
 * - 分页：offset/limit 是**条目**维度（不是字节、不是目录深度）。
 *
 * ==================== 错误风格（领域约定） ====================
 *
 * 与 workspace-files.ts 同构：全部经 WorkspaceOperationError 抛出
 * （[WORKSPACE_*] 前缀），由工具边界统一映射为 file_util 的错误码。
 * **禁止裸 Error**——裸错误走到工具层会被归类为「未预期异常」，一个
 * 可预期的「目录不存在」会被模型当成工具坏了。
 */

import type { WorkspaceEntry } from './paths';
import { WorkspaceOperationError } from '@/utils/shared/error-details';
import {
  parseWorkspaceFilePath,
  readWorkspaceSnapshot,
} from './workspace-files';

/** 领域错误（与 workspace-files.ts 的 fail 同构：[WORKSPACE_<code>] 前缀） */
function fail(code: string, message: string): never {
  throw new WorkspaceOperationError(code, message);
}

/** list 根目录概览的展示上限（缺失路径提示用：避免超长工作区撑爆错误信息） */
export const LIST_ROOT_PREVIEW_MAX = 20;

/** 每页返回的条目数上限 */
export const LIST_MAX_PAGE = 200;

/** 文件搜索（路径正则）每页返回的条目数上限 */
export const SEARCH_MAX_PAGE = 30;

/** 单条盘点条目 */
export interface WorkspaceListingEntry {
  /** 工作区相对路径 */
  path: string;
  /** 条目类型 */
  kind: 'link' | 'file' | 'directory';
  /** 文件字节数（目录恒为 0） */
  bytes: number;
}

/** 盘点结果 */
export interface WorkspaceListing {
  /** 当前页条目 */
  entries: WorkspaceListingEntry[];
  /** 匹配条目总数（跨所有页） */
  total: number;
  /** 下一页的 offset（= min(offset+limit, total)） */
  nextOffset: number;
  /** 是否还有后续页 */
  hasMore: boolean;
}

/** 文件所在目录（根目录返回空串；用于「把文件当目录」时的修复指引） */
function parentDirectory(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/**
 * list 目标目录缺失时的可执行提示：回显根目录概览与约定目录的生命周期。
 *
 * 不把「目录不存在」放宽成空列表——那会把拼写错误静默成「没有数据」。
 * 但错误不能只说「不存在」：模型需要知道下一步（列根目录 / 先执行一次
 * run 生成 results/），否则只能反复猜测同一路径。
 */
function describeMissingListPath(
  path: string,
  entries: readonly { path: string }[],
): string {
  const roots = [
    ...new Set(
      entries
        .map((entry) => entry.path.split('/')[0])
        .filter((root) => !!root),
    ),
  ].sort();
  const preview = roots
    .slice(0, LIST_ROOT_PREVIEW_MAX)
    .map((root) => `${root}/`)
    .join('、');
  const rootText = preview
    ? `当前根目录：${preview}${roots.length > LIST_ROOT_PREVIEW_MAX ? '…' : ''}`
    : '当前工作区为空';
  return (
    `list 的 path="${path}" 不存在。${rootText}。` +
    'list 只盘点已存在目录，不会创建目录；写入文件时其父目录会自动创建，results/ 由首次 run/crawl 或数据治理写入时自动创建。' +
    '可省略 path（或传 "."）列出根目录，或直接 read/search 已知路径。'
  );
}

/**
 * 分页参数归一（非法值显式报错，绝不静默收敛）。
 *
 * 错误点名**具体参数与具体约束**（而不是笼统的「参数非法」）：模型看到
 * 「limit 必须是 ≥1 的安全整数（最多 200），实际收到 -1」就能一步改对。
 */
export function listPageParams(
  offset: unknown,
  limit: unknown,
  max: number = LIST_MAX_PAGE,
  defaultLimit: number = 100,
): { offset: number; limit: number } {
  const readInteger = (
    key: 'offset' | 'limit',
    value: unknown,
    fallback: number,
    minimum: number,
  ): number => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
      fail(
        'INVALID_ARGUMENTS',
        `${key} 必须是 ≥${minimum} 的安全整数${key === 'limit' ? `（最多 ${max}）` : ''}，实际收到 ${JSON.stringify(value)}`,
      );
    }
    return value as number;
  };
  const resolvedLimit = readInteger(
    'limit',
    limit,
    Math.min(defaultLimit, max),
    1,
  );
  if (resolvedLimit > max) {
    fail(
      'INVALID_ARGUMENTS',
      `limit 最多 ${max}，实际收到 ${resolvedLimit}——请缩小单页条目数并按 nextOffset 分页续查`,
    );
  }
  return {
    offset: readInteger('offset', offset, 0, 0),
    limit: resolvedLimit,
  };
}

function entryKind(entry: WorkspaceEntry): WorkspaceListingEntry['kind'] {
  return entry.link ? 'link' : entry.blob ? 'file' : 'directory';
}

function toListingEntry(entry: WorkspaceEntry): WorkspaceListingEntry {
  return { path: entry.path, kind: entryKind(entry), bytes: entry.blob?.size ?? 0 };
}

/** 目录优先、同类按路径排序（保证分页结果稳定，模型不会因顺序抖动漏读）。 */
function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  const rank = (entry: WorkspaceEntry): number => (entry.blob || entry.link ? 1 : 0);
  return entries.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

/** 条目分页（list 与 search 共用同一套账目，避免两处漂移）。 */
function paginate(
  entries: WorkspaceEntry[],
  offset: number,
  limit: number,
): WorkspaceListing {
  return {
    entries: entries.slice(offset, offset + limit).map(toListingEntry),
    total: entries.length,
    nextOffset: Math.min(offset + limit, entries.length),
    hasMore: offset + limit < entries.length,
  };
}

/**
 * 校验目标目录存在且确实是目录（缺失/文件当目录都给可执行提示）。
 */
function assertDirectory(entries: readonly WorkspaceEntry[], requested: string): void {
  if (!requested) return;
  const entry = entries.find((item) => item.path === requested);
  if (!entry) {
    fail('DIR_NOT_FOUND', describeMissingListPath(requested, entries));
  }
  if (entry.blob || entry.link) {
    const parent = parentDirectory(requested);
    fail(
      'NOT_A_DIRECTORY',
      `path="${requested}" 是${entry.link ? '链接' : '文件'}而不是目录。` +
        `查看所在目录用 list${parent ? ` path="${parent}"` : ''}；读取文件内容用 file_util(action="read", path="${requested}")。`,
    );
  }
}

/**
 * 盘点某个目录的**直接子项**（不递归）：目录在前、文件在后，同类按路径排序。
 *
 * 这是 file_util 的 list 语义——模型通常先看一层再决定进入哪个子目录；
 * 递归展开会把整棵工作区一次性倒进上下文。需要递归找文件请用 search。
 */
export async function listWorkspaceChildren(
  chatId: string,
  path: unknown,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<WorkspaceListing> {
  const requested =
    path === undefined || path === '' || path === '.'
      ? ''
      : parseWorkspaceFilePath(path);
  const prefix = requested ? requested + '/' : '';
  const snapshotEntries = await readWorkspaceSnapshot(chatId, signal);
  assertDirectory(snapshotEntries, requested);
  const entries = sortEntries(
    snapshotEntries.filter((item) => {
      if (!item.path.startsWith(prefix) || item.path === requested) return false;
      return !item.path.slice(prefix.length).includes('/');
    }),
  );
  return paginate(entries, offset, limit);
}

/**
 * 递归搜索工作区条目的**相对路径**（文件名与目录名都参与匹配）。
 *
 * - 正则只作用于路径字符串，不读取文件正文（正文搜索见 content-search）；
 * - 目录在前、文件在后，同类按路径排序，分页稳定；
 * - 根目录不存在 / 指向文件时给可执行报错，不静默返回空结果。
 */
export async function searchWorkspacePaths(
  chatId: string,
  path: unknown,
  rawPattern: unknown,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<WorkspaceListing> {
  if (typeof rawPattern !== 'string' || rawPattern.length === 0) {
    fail('INVALID_ARGUMENTS', 'search 需要 pattern（非空正则表达式字符串，匹配工作区相对路径）');
  }
  if (rawPattern.length > 500) {
    fail('INVALID_ARGUMENTS', `pattern 长度 ${rawPattern.length} 超过 500 字符上限`);
  }
  let matcher: RegExp;
  try {
    matcher = new RegExp(rawPattern);
  } catch (error) {
    fail(
      'INVALID_ARGUMENTS',
      `pattern 不是合法正则：${error instanceof Error ? error.message : String(error)}。` +
        '请修正后重试（例如 ^docs/.*\\.md$）',
    );
  }
  const requested =
    path === undefined || path === '' || path === '.'
      ? ''
      : parseWorkspaceFilePath(path);
  const prefix = requested ? requested + '/' : '';
  const snapshotEntries = await readWorkspaceSnapshot(chatId, signal);
  assertDirectory(snapshotEntries, requested);
  const entries = sortEntries(
    snapshotEntries.filter(
      (item) =>
        item.path !== requested &&
        item.path.startsWith(prefix) &&
        matcher.test(item.path),
    ),
  );
  return paginate(entries, offset, limit);
}

/**
 * 盘点回执（只报账目，不复述条目值）。
 *
 * 条目明细在 data.entries 里——回执正文若把每个条目再抄一遍，模型上下文里
 * 同一份事实出现两次（正文 + data），纯浪费。回执只回答「列了哪、多少、
 * 还有没有」，让模型知道去 data 里翻。
 */
export function describeWorkspaceListing(
  listing: WorkspaceListing,
  path: unknown,
): string {
  const scope = !path || path === '.' ? '根目录' : `目录 ${path}`;
  const more = listing.hasMore ? `，还有更多，用 offset=${listing.nextOffset} 续查` : '';
  return `已列出${scope}的 ${listing.entries.length} 项（共 ${listing.total} 项${more}）。完整条目见 data.entries。`;
}

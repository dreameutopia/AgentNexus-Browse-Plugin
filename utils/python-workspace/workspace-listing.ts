/**
 * 会话工作区目录盘点（js_run 与 python_run 共用）
 *
 * ==================== 为什么独立成模块 ====================
 *
 * 「盘点工作区某个目录」这件事此前只存在于 tools/javascript/js-run-tool.ts
 * 内部（inline 实现）。python_run 同样操作同一个会话工作区，若各自实现一份，
 * 两处很快会漂移出不同语义——目录缺失时报错文案不同、返回的条目字段不同、
 * 分页上限不同。模型在同一会话里先用 js_run 盘点、再用 python_run 盘点时，
 * 会看到两种形状，于是怀疑「是不是两个不同的存储」。
 *
 * 本模块把盘点语义收敛为**唯一实现**：js_run 与 python_run 都调用它，
 * 字段形状、报错文案、分页口径逐字一致。
 *
 * ==================== 语义要点 ====================
 *
 * - 只盘点**已存在**的目录：目录不存在显式报错（不返回空列表）——把拼写错误
 *   静默成「没有数据」会让模型在错误路径上继续推断。
 * - 报错必须带**可执行的下一步**：回显当前根目录概览 + 「省略 path 列根目录」。
 * - 文件路径不能当目录盘点：明确区分「是文件不是目录」，并给出对应的
 *   read 调用（模型的下一步通常是读文件内容，而不是继续盘点）。
 * - 分页：offset/limit 是**条目**维度（不是字节、不是目录深度）。
 */

import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { parseWorkspaceFilePath } from './workspace-files';

/** list 根目录概览的展示上限（缺失路径提示用：避免超长工作区撑爆错误信息） */
export const LIST_ROOT_PREVIEW_MAX = 20;

/** 每页返回的条目数上限 */
export const LIST_MAX_PAGE = 200;

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
export function describeMissingListPath(
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
    "list 只盘点已存在目录，不会创建目录；results/ 由首次 js_run(action=\"run\") 或数据治理写入时自动创建。" +
    '可省略 path（或传 "."）列出根目录，或先执行一次 run 再盘点。'
  );
}

/** 分页参数归一：非法值显式报错（与 js_run 的 integer 口径一致） */
export function listPageParams(
  offset: unknown,
  limit: unknown,
): { offset: number; limit: number } {
  const readInteger = (value: unknown, fallback: number, minimum: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
      throw new Error('offset/limit 必须是范围内的安全整数');
    }
    return value as number;
  };
  return {
    offset: readInteger(offset, 0, 0),
    limit: Math.min(readInteger(limit, 100, 1), LIST_MAX_PAGE),
  };
}

/**
 * 盘点工作区某个目录下的条目。
 *
 * @param chatId 会话 id（工作区隔离键）
 * @param path   目标目录；undefined 或 "." 表示根目录
 * @param offset 分页偏移（条目维度）
 * @param limit  每页条目数（上限 LIST_MAX_PAGE）
 */
export async function listWorkspaceEntries(
  chatId: string,
  path: unknown,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<WorkspaceListing> {
  const requested =
    path === undefined || path === '.'
      ? ''
      : parseWorkspaceFilePath(path);
  const prefix = requested ? requested + '/' : '';
  const snapshot = await chatDatabase.readWorkspace(chatId, signal);
  if (prefix) {
    const entry = snapshot?.entries.find((item) => item.path === requested);
    if (!entry) {
      throw new Error(describeMissingListPath(requested, snapshot?.entries ?? []));
    }
    if (entry.blob || entry.link) {
      const parent = parentDirectory(requested);
      throw new Error(
        `list 的 path="${requested}" 是${entry.link ? '链接' : '文件'}而不是目录。` +
          `查看所在目录用 list${parent ? ` path="${parent}"` : ''}；读取文件内容用 read path="${requested}"。`,
      );
    }
  }
  const entries = (snapshot?.entries ?? [])
    .filter((item) => item.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    entries: entries.slice(offset, offset + limit).map((item) => ({
      path: item.path,
      kind: item.link ? 'link' : item.blob ? 'file' : 'directory',
      bytes: item.blob?.size ?? 0,
    })),
    total: entries.length,
    nextOffset: Math.min(offset + limit, entries.length),
    hasMore: offset + limit < entries.length,
  };
}

/**
 * 书签树访问层（chrome.bookmarks 的唯一入口）
 *
 * 职责边界：
 *   - 取整棵书签树并扁平化（书签节点 + 文件夹节点，附祖先文件夹路径）；
 *   - 按 id / 地址定位书签；
 *   - 汇总文件夹结构（id / 路径 / 直接条目数 / 子文件夹数）。
 *
 * 统一收口的意义：书签树在 chrome.bookmarks API 里是「递归树」形态，
 * 每处自己走一遍树必然写出三套路径拼接与计数口径；这里收口后，
 * 检索、打开、移动、目录列举共用同一套路径与计数定义。
 *
 * 错误处理：所有 chrome.* 调用都可能因权限不足 / 扩展上下文缺失而抛错，
 * 本模块把异常转成带中文原因的 Error，由调用方转成工具失败结果——
 * 工具层永远不会把原始异常抛给调用方。
 */

import { describeError } from './history-bookmarks-data';

/** 书签树节点 + 其所在文件夹路径 */
export interface BookmarkNodeInfo {
  node: chrome.bookmarks.BookmarkTreeNode;
  /** 祖先文件夹标题链（不含自身标题） */
  folderPath: string;
}

/** 文件夹条目（对外结构） */
export interface BookmarkFolderInfo {
  id: string;
  title: string;
  parentId?: string;
  /** 完整路径（含自身标题） */
  path: string;
  /** 直接挂在该文件夹下的书签数 */
  bookmarkCount: number;
  /** 直接挂在该文件夹下的子文件夹数 */
  folderCount: number;
}

/** 书签树快照：原树 + 扁平节点 + id 索引 */
export interface BookmarkTreeSnapshot {
  tree: chrome.bookmarks.BookmarkTreeNode[];
  nodes: BookmarkNodeInfo[];
  byId: Map<string, BookmarkNodeInfo>;
}

/** chrome.bookmarks 不可用时的统一原因（权限 / 上下文缺失） */
function requireBookmarksApi(): typeof chrome.bookmarks {
  const api = chrome.bookmarks;
  if (!api) {
    throw new Error(
      'chrome.bookmarks 不可用：书签 API 只在扩展 background 上下文可用（需 manifest 声明 bookmarks 权限）',
    );
  }
  return api;
}

/** 取整棵书签树并扁平化（失败时抛出带中文原因的 Error） */
export async function loadBookmarkTree(): Promise<BookmarkTreeSnapshot> {
  const api = requireBookmarksApi();
  let tree: chrome.bookmarks.BookmarkTreeNode[];
  try {
    tree = await api.getTree();
  } catch (error) {
    throw new Error(`读取书签树失败：${describeError(error)}`);
  }
  if (!Array.isArray(tree)) {
    throw new Error('读取书签树失败：chrome.bookmarks.getTree 返回了非法形态');
  }

  const nodes: BookmarkNodeInfo[] = [];
  const byId = new Map<string, BookmarkNodeInfo>();

  const walk = (list: chrome.bookmarks.BookmarkTreeNode[], ancestors: string[]): void => {
    for (const node of list) {
      if (!node || typeof node.id !== 'string') continue;
      const info: BookmarkNodeInfo = { node, folderPath: ancestors.filter(Boolean).join(' / ') };
      nodes.push(info);
      byId.set(node.id, info);
      if (Array.isArray(node.children)) walk(node.children, [...ancestors, node.title ?? '']);
    }
  };
  walk(tree, []);

  return { tree, nodes, byId };
}

/** 按 id 定位书签节点（文件夹节点返回 null） */
export async function findBookmarkById(id: string): Promise<BookmarkNodeInfo | null> {
  const { byId } = await loadBookmarkTree();
  const info = byId.get(id);
  if (!info || !info.node.url) return null;
  return info;
}

/** 按地址定位书签（可能命中多个——同名同址的书签在 Chrome 里合法存在） */
export async function findBookmarksByUrl(url: string): Promise<chrome.bookmarks.BookmarkTreeNode[]> {
  const api = requireBookmarksApi();
  let matches: chrome.bookmarks.BookmarkTreeNode[];
  try {
    matches = await api.search({ url });
  } catch (error) {
    throw new Error(`按地址查找书签失败：${describeError(error)}`);
  }
  return Array.isArray(matches) ? matches.filter(match => !!match.url) : [];
}

/**
 * 汇总文件夹结构。parentId 缺省时列全树；给了则只列该文件夹及其子树
 * （祖先链命中即在范围内）。书签树的根节点标题为空，不作为文件夹暴露。
 */
export async function collectBookmarkFolders(parentId?: string): Promise<BookmarkFolderInfo[]> {
  const { tree } = await loadBookmarkTree();
  const folders: BookmarkFolderInfo[] = [];

  const walk = (
    list: chrome.bookmarks.BookmarkTreeNode[],
    ancestors: Array<{ id: string; title: string }>,
  ): void => {
    for (const node of list) {
      if (!node || typeof node.id !== 'string' || node.url) continue;
      const title = node.title ?? '';
      if (title) {
        const inScope = !parentId || node.id === parentId || ancestors.some(ancestor => ancestor.id === parentId);
        if (inScope) {
          const children = Array.isArray(node.children) ? node.children : [];
          folders.push({
            id: node.id,
            title,
            parentId: node.parentId,
            path: [...ancestors.map(ancestor => ancestor.title), title].filter(Boolean).join(' / '),
            bookmarkCount: children.filter(child => !!child?.url).length,
            folderCount: children.filter(child => !child?.url && !!child?.title).length,
          });
        }
      }
      if (Array.isArray(node.children)) walk(node.children, [...ancestors, { id: node.id, title }]);
    }
  };
  walk(tree, []);

  return folders;
}

/**
 * 文件夹登记表（localStorage 持久化）
 *
 * 笔记的「文件夹」只是 note.category 字符串 —— 空文件夹（无任何笔记）
 * 在数据层没有载体。本模块登记所有出现过的文件夹名，保证：
 * - 手动新建的空文件夹立即出现在侧边栏；
 * - 笔记被移走 / 删除后，空文件夹仍保留（不随笔记消失）；
 * - 重命名同步改登记、删除文件夹时注销。
 *
 * 防御策略与 useTheme 一致：localStorage 在隐私模式 / 存储受限环境可能
 * 抛异常，读写均 try/catch 降级（登记失败只影响空文件夹保留，
 * 绝不阻断笔记读写主流程）。
 */
import { normalizeCategory } from '@/utils/notes-database';

const STORAGE_KEY = 'notes-folders';

/** 安全读取登记表（JSON 解析 + 清洗去重；失败返回空表） */
export function loadFolders(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const result: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const name = normalizeCategory(item, '');
      if (name && !result.includes(name)) result.push(name);
    }
    return result;
  } catch (error) {
    console.warn('[Notes] 读取文件夹登记失败（localStorage 不可用）:', error);
    return [];
  }
}

/** 安全写入登记表（失败仅告警：本次会话的文件夹列表仍然生效） */
export function saveFolders(folders: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(folders));
  } catch (error) {
    console.warn('[Notes] 保存文件夹登记失败（localStorage 不可用）:', error);
  }
}

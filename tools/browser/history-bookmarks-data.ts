/**
 * 历史与书签统一工具的纯函数层（无 Chrome API 依赖，可独立测试）
 *
 * 职责边界：
 *   - 时间表达式的解析与归一（"today" / "3 days ago" / "2w" / ISO / 毫秒时间戳）；
 *   - 检索条目的统一形态与合并/排序（同 URL 合并、来源标注）。
 *
 * 这一层刻意不碰 chrome.*，因此任何一条规则都能被单元测试直接覆盖，
 * 不会因为桩实现变化而失去回归保护。
 */

/** 一天毫秒数 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 检索来源枚举（schema 枚举与运行期校验同源） */
export const HISTORY_BOOKMARK_SOURCES = ['history', 'bookmark', 'both'] as const;
export type HistoryBookmarkSource = (typeof HISTORY_BOOKMARK_SOURCES)[number];

/** 排序方式枚举 */
export const HISTORY_BOOKMARK_SORTS = ['relevance', 'recent', 'visited'] as const;
export type HistoryBookmarkSort = (typeof HISTORY_BOOKMARK_SORTS)[number];

/** 字段校验结果：值可选（字段缺省时不出现），错误时只带可读文案 */
export type Field<T> =
  | { ok: true; value?: T }
  | { ok: false; error: string };

/** 时间边界角色：起点（today → 今天 00:00）/ 终点（today → 今天 23:59:59.999） */
export interface TimeBoundRole {
  isStart: boolean;
}

/**
 * 解析时间表达式为毫秒时间戳；无法解析返回 null。
 *
 * 支持五形态：
 *   - 毫秒时间戳（纯数字字符串或 number）
 *   - "now" / "today" / "yesterday"
 *   - "3 days ago" / "2 weeks ago" / "1 month ago" / "1 year ago"
 *   - 简写 "3d" / "2w" / "6m" / "1y"
 *   - ISO / 常规日期字符串（Date 解析）
 */
export function parseTimeExpression(raw: string, role: TimeBoundRole): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  const now = Date.now();

  // 纯数字 → 毫秒时间戳
  if (/^\d{10,}$/.test(text)) return Number(text);

  if (text === 'now') return now;

  if (text === 'today') {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    return role.isStart ? day.getTime() : day.getTime() + DAY_MS - 1;
  }

  if (text === 'yesterday') {
    const day = new Date();
    day.setDate(day.getDate() - 1);
    day.setHours(0, 0, 0, 0);
    return role.isStart ? day.getTime() : day.getTime() + DAY_MS - 1;
  }

  // "3 days ago" / "2 weeks ago" / "1 month ago" / "1 year ago"
  const agoMatch = text.match(/^(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago$/);
  if (agoMatch) {
    const amount = Number(agoMatch[1]);
    const unit = agoMatch[2];
    const result = new Date(now);
    if (unit.startsWith('day')) result.setDate(result.getDate() - amount);
    else if (unit.startsWith('week')) result.setDate(result.getDate() - amount * 7);
    else if (unit.startsWith('month')) result.setMonth(result.getMonth() - amount);
    else if (unit.startsWith('year')) result.setFullYear(result.getFullYear() - amount);
    return result.getTime();
  }

  // 简写 "3d" / "2w" / "6m" / "1y"
  const shortMatch = text.match(/^(\d+)\s*([dwmy])$/);
  if (shortMatch) {
    const amount = Number(shortMatch[1]);
    switch (shortMatch[2]) {
      case 'd':
        return now - amount * DAY_MS;
      case 'w':
        return now - amount * 7 * DAY_MS;
      case 'm':
        return now - amount * 30 * DAY_MS;
      case 'y':
        return now - amount * 365 * DAY_MS;
    }
  }

  // ISO / 常规日期字符串
  const parsed = Date.parse(raw.trim());
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 时间字段读取：字符串或毫秒时间戳均可，返回归一后的毫秒时间戳。
 * 非法值一律给可读错误（期望什么 / 收到什么 / 怎么改），不静默回落。
 */
export function readTimeField(
  input: Record<string, unknown>,
  key: string,
  role: TimeBoundRole,
): Field<number> {
  const value = input[key];
  if (value === undefined) return { ok: true };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, error: `${key} 必须是正的毫秒时间戳，实际收到 ${JSON.stringify(value)}` };
    }
    return { ok: true, value };
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = parseTimeExpression(value, role);
    if (parsed === null) {
      return {
        ok: false,
        error:
          `${key} 无法解析为时间（收到 ${JSON.stringify(value)}）：支持 "now" / "today" / "yesterday" / ` +
          '"3 days ago" / "2w" / ISO 日期 / 毫秒时间戳',
      };
    }
    return { ok: true, value: parsed };
  }
  return { ok: false, error: `${key} 必须是时间字符串或毫秒时间戳` };
}

/**
 * URL 归一（仅用于同 URL 合并：去尾斜杠 + 主机小写，路径与查询保持原样——
 * 路径大小写与查询串可能有业务含义，绝不归一掉）。
 */
export function normalizeUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return url.trim();
  }
}

/** 检索条目（历史与书签统一形态） */
export interface RecallItem {
  url: string;
  title: string;
  source: 'history' | 'bookmark' | 'both';
  historyId?: string;
  bookmarkId?: string;
  /** 书签所在文件夹路径（书签栏 / 工作 / …） */
  folderPath?: string;
  /** 最后访问时间（毫秒） */
  lastVisitTime?: number;
  /** 最后访问时间的 ISO 文本（便于模型直接阅读） */
  lastVisitIso?: string;
  /** 访问次数 */
  visitCount?: number;
  /** 收藏时间（毫秒） */
  dateAdded?: number;
}

/**
 * 同 URL 合并：历史与书签指向同一页时合成一条（source 标 both，元数据取并集）。
 * 合并是幂等的：同一批输入再合并一次结果不变。
 */
export function mergeRecallItems(items: RecallItem[]): RecallItem[] {
  const byUrl = new Map<string, RecallItem>();
  for (const item of items) {
    const key = normalizeUrlKey(item.url);
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, { ...item });
      continue;
    }
    const merged: RecallItem = {
      ...existing,
      source: existing.source === item.source ? existing.source : 'both',
      title: item.title || existing.title,
      historyId: existing.historyId ?? item.historyId,
      bookmarkId: existing.bookmarkId ?? item.bookmarkId,
      folderPath: existing.folderPath ?? item.folderPath,
      lastVisitTime: Math.max(existing.lastVisitTime ?? 0, item.lastVisitTime ?? 0) || undefined,
      visitCount: Math.max(existing.visitCount ?? 0, item.visitCount ?? 0) || undefined,
      dateAdded: existing.dateAdded ?? item.dateAdded,
    };
    if (merged.lastVisitTime) merged.lastVisitIso = new Date(merged.lastVisitTime).toISOString();
    byUrl.set(key, merged);
  }
  return [...byUrl.values()];
}

/** 排序：relevance 保持检索原序 / recent 按最后访问 / visited 按访问次数 */
export function sortRecallItems(items: RecallItem[], sort: HistoryBookmarkSort): RecallItem[] {
  if (sort === 'recent') {
    return [...items].sort((a, b) => (b.lastVisitTime ?? b.dateAdded ?? 0) - (a.lastVisitTime ?? a.dateAdded ?? 0));
  }
  if (sort === 'visited') {
    return [...items].sort((a, b) => {
      const byVisits = (b.visitCount ?? 0) - (a.visitCount ?? 0);
      if (byVisits !== 0) return byVisits;
      return (b.lastVisitTime ?? b.dateAdded ?? 0) - (a.lastVisitTime ?? a.dateAdded ?? 0);
    });
  }
  return items;
}

/**
 * 抽取可读的错误原因（Chrome API 抛的多为 Error，也可能是字符串或
 * 带 message 的普通对象）——统一成一句话，供错误文案拼接。
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

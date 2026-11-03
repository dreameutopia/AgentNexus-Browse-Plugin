/**
 * 统一笔记数据库（插件托管存储 · 单一事实来源）
 *
 * 模型：「已保存的网页」与「AI/用户创建的笔记」统一为同一种实体（Note），
 * 差异仅在 kind / source / 自动分类：
 * - kind='note'     用户或智能体创建的普通笔记；
 * - kind='webpage'  右键「保存页面」剪藏的网页（source 携带原始网址与图标）。
 *
 * 正文格式：Tiptap（ProseMirror）HTML —— 编辑器直接读写该 HTML，
 * 智能体经 append_note 追加的纯文本会被转义并组装为段落/代码块 HTML。
 * 每条记录冗余存储派生纯文本 `text`（写入时提取）：列表预览、搜索与
 * get_note_content 共用，避免每次读取重新解析 HTML，也保证 base64 图片
 * 数据绝不会泄漏进模型上下文。
 *
 * 健壮性设计：
 * - 所有读写都走 runTx：以事务 oncomplete（而非单个请求成功）作为落盘判定点，
 *   统一处理 request error / transaction error / transaction abort；
 * - updateNote / appendToNote 在同一读写事务内完成「读-改-写」，避免并发丢更新；
 * - init 并发去重、onversionchange 让位、onblocked 告警，多上下文安全；
 * - 错误统一包装为 NotesDatabaseError（operation / cause / hint），
 *   参数错误为 NotesParamError（字段级可读），API 端可直接分析定位；
 * - v2 起数据库结构与旧版（纯文本笔记 / 已保存页面独立库）完全不兼容，
 *   升级时丢弃旧 store 重建（产品决策：不迁移旧数据）。
 */

import type { Note, NoteKind, NoteSource } from '@/types';

export type { Note, NoteKind, NoteSource };

// ──── 存储常量 ────

export const NOTES_DB_NAME = 'AgentNexusNotesDB';
export const NOTES_DB_VERSION = 2;
const NOTES_STORE = 'notes';

/** 保留分类 ID：显示时经 i18n 映射，其余分类字符串原样展示（用户自定义/站点名） */
export const CATEGORY_INBOX = 'inbox';
export const CATEGORY_AI = 'ai';

/** 防御性上限 */
const MAX_TITLE_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 50;
const MAX_TAG_LENGTH = 100;
const MAX_TAGS_COUNT = 50;
const MAX_NOTE_ID_LENGTH = 128;
const MAX_URL_LENGTH = 2048;
const PREVIEW_LENGTH = 160;

// ──── 错误类型（API 端可分析的结构化错误） ────

/** 参数错误：调用方（模型/页面）传入的参数不合法，字段级可读 */
export class NotesParamError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`参数 "${field}" ${message}`);
    this.name = 'NotesParamError';
    this.field = field;
  }
}

/** 存储错误：携带失败的操作名与排查建议 */
export class NotesDatabaseError extends Error {
  readonly operation: string;
  readonly hint?: string;

  constructor(operation: string, cause: unknown, hint?: string) {
    const causeMessage =
      cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : '未知原因';
    super(`笔记数据库 ${operation} 失败: ${causeMessage}`);
    this.name = 'NotesDatabaseError';
    this.operation = operation;
    this.hint = hint;
    if (cause instanceof Error) (this as { cause?: unknown }).cause = cause;
  }
}

// ──── 输入校验 / 归一化（工具层与存储层共用的防御层） ────

function previewValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  let text: string;
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : String(value);
  } catch {
    text = Object.prototype.toString.call(value);
  }
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** 校验笔记 ID 形态（UUID；宽容字符集以兼容未来导入的数据） */
export function isNoteId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_NOTE_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/** 必填字符串（空白视为缺失） */
export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new NotesParamError(field, `必须为字符串，实际收到: ${previewValue(value)}`);
  }
  if (!value.trim()) {
    throw new NotesParamError(field, '不能为空或纯空白');
  }
  return value;
}

/** 必填字符串（允许空串） */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new NotesParamError(field, `必须为字符串，实际收到: ${previewValue(value)}`);
  }
  return value;
}

/** 可选字符串（undefined / null 视为未提供） */
export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field);
}

/** 必填笔记 ID */
export function requireNoteId(value: unknown, field: string): string {
  if (!isNoteId(value)) {
    throw new NotesParamError(
      field,
      `必须为有效的笔记ID（UUID），实际收到: ${previewValue(value)}；` +
        `请使用 create_note 返回的 Note ID`,
    );
  }
  return value;
}

/** 标签列表归一化：仅接受字符串数组；去空白项、去重、限制数量与长度 */
export function normalizeTags(value: unknown, field = 'tags'): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new NotesParamError(field, `必须为字符串数组，实际收到: ${previewValue(value)}`);
  }

  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (typeof entry !== 'string') {
      throw new NotesParamError(
        `${field}[${i}]`,
        `必须为字符串，实际收到: ${previewValue(entry)}`,
      );
    }
    const tag = entry.trim().replace(/^#+/, '');
    if (!tag || tag.length > MAX_TAG_LENGTH) continue;
    if (!result.includes(tag)) result.push(tag);
    if (result.length >= MAX_TAGS_COUNT) break;
  }
  return result;
}

/** 分类归一化：trim + 控制字符剔除 + 长度截断；空值回退到默认分类 */
export function normalizeCategory(value: unknown, fallback: string = CATEGORY_INBOX): string {
  const raw = optionalString(value, 'category');
  if (raw === undefined) return fallback;
  // 剔除控制字符，防止分类名污染侧边栏渲染
  // eslint-disable-next-line no-control-regex -- 刻意匹配控制字符本身以完成清洗（此处是唯一入口，非误用）
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return fallback;
  return cleaned.length > MAX_CATEGORY_LENGTH ? cleaned.slice(0, MAX_CATEGORY_LENGTH) : cleaned;
}

/** 标题归一化：trim + 空值回退 + 超长截断 */
export function normalizeTitle(value: unknown, fallback: string): string {
  const title = optionalString(value, 'title');
  const trimmed = (title ?? '').trim();
  if (!trimmed) return fallback;
  return trimmed.length > MAX_TITLE_LENGTH ? trimmed.slice(0, MAX_TITLE_LENGTH) : trimmed;
}

/** 笔记形态归一化 */
function normalizeKind(value: unknown): NoteKind {
  if (value === undefined || value === null || value === 'note') return 'note';
  if (value === 'webpage') return 'webpage';
  throw new NotesParamError('kind', `必须为 "note" 或 "webpage"，实际收到: ${previewValue(value)}`);
}

/** 来源信息归一化（webpage 必填 url） */
function normalizeSource(value: unknown, kind: NoteKind): NoteSource | undefined {
  if (value === undefined || value === null) {
    if (kind === 'webpage') {
      throw new NotesParamError('source', 'kind 为 webpage 时必须提供来源 url');
    }
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new NotesParamError('source', `必须为 { url, favicon? } 对象，实际收到: ${previewValue(value)}`);
  }
  const raw = value as { url?: unknown; favicon?: unknown };
  const url = requireNonEmptyString(raw.url, 'source.url');
  if (url.length > MAX_URL_LENGTH) {
    throw new NotesParamError('source.url', `长度不能超过 ${MAX_URL_LENGTH} 字符`);
  }
  const favicon = optionalString(raw.favicon, 'source.favicon');
  return favicon ? { url, favicon } : { url };
}

// ──── HTML 正文工具（写入时派生，纯 JS、无 DOM，后台/页面通用） ────

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};

/** 安全码点解码：越界（>0x10FFFF）或非法输入抛 RangeError 时回退原文，
 *  保证畸形实体不会让正文派生（extractNoteText）炸掉整个写入链路 */
function safeFromCodePoint(code: number, original: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return original;
  try {
    return String.fromCodePoint(code);
  } catch {
    return original;
  }
}

/** HTML 实体解码（预览文本用，覆盖常用实体 + 数字实体） */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (m, code: string) => safeFromCodePoint(Number(code), m))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (m, code: string) =>
      safeFromCodePoint(parseInt(code, 16), m),
    )
    .replace(/&(amp|lt|gt|quot|nbsp|#39|#x27);/g, (m) => HTML_ENTITY_MAP[m] ?? m);
}

/**
 * 从 Tiptap HTML 提取可读纯文本（预览 / 搜索 / get_note_content 共用）。
 * - 图片 → 「[图片]」占位（base64 数据绝不进入结果）；
 * - 标题 → Markdown # 前缀；列表项 → - 前缀；
 * - 块级标签 → 换行；连续空行收敛。
 */
export function extractNoteText(html: string): string {
  if (!html) return '';

  let text = html
    // 移除脚本/样式整块
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // 图片 → 占位符（含 alt 信息时保留）
    .replace(/<img\b[^>]*?\salt=(["'])([\s\S]*?)\1[^>]*?>/gi, (_m, _q, alt: string) =>
      alt.trim() ? `[图片: ${alt.trim()}]` : '[图片]',
    )
    .replace(/<img\b[^>]*?>/gi, '[图片]')
    // 标题 → Markdown 前缀
    .replace(/<h([1-6])[^>]*>/gi, (_m, level: string) => `${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]>/gi, '\n\n')
    // 列表项 → 前缀
    .replace(/<li[^>]*>/gi, '- ')
    // 块级元素 → 换行
    .replace(
      /<\/?(p|div|ul|ol|blockquote|pre|table|tr|section|article|figure|figcaption|hr)[^>]*>/gi,
      '\n',
    )
    .replace(/<br\s*\/?>/gi, '\n')
    // 剩余行内标签剥除
    .replace(/<[^>]+>/g, '')
    // 代码块围栏包裹（pre 内文本已是实体转义，解码一次保持可读）
    .replace(/\n{3,}/g, '\n\n');

  text = decodeEntities(text);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

/** 纯文本 → 段落/代码块 HTML（append_note 追加内容时使用；全部转义，无注入面） */
export function plainTextToHtml(text: string): string {
  if (!text.trim()) return '';

  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const parts: string[] = [];
  // 先按代码围栏切分：围栏内绝不做段落/换行解释
  const fenceRe = /```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushTextSegment = (segment: string) => {
    // 段落按空行切分；段内单换行 → <br>
    for (const block of segment.split(/\n{2,}/)) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const inner = escapeHtml(trimmed).replace(/\n/g, '<br>');
      parts.push(`<p>${inner}</p>`);
    }
  };

  while ((match = fenceRe.exec(text)) !== null) {
    pushTextSegment(text.slice(lastIndex, match.index));
    const lang = match[1] ? ` class="language-${escapeHtml(match[1])}"` : '';
    parts.push(`<pre><code${lang}>${escapeHtml(match[2].replace(/\n$/, ''))}</code></pre>`);
    lastIndex = fenceRe.lastIndex;
  }
  pushTextSegment(text.slice(lastIndex));

  return parts.join('');
}

// ──── 列表条目与输入形态 ────

/** 列表页展示用的轻量条目（不含正文全文） */
export interface NoteListItem {
  id: string;
  kind: NoteKind;
  title: string;
  category: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  source?: NoteSource;
  /** 派生纯文本预览（空白折叠后前 160 字） */
  textPreview: string;
}

export interface CreateNoteInput {
  kind?: NoteKind;
  title?: string;
  /** Tiptap HTML 正文；缺省为空文档占位 */
  content?: string;
  category?: string;
  tags?: string[];
  source?: NoteSource;
}

export interface UpdateNoteInput {
  title?: string;
  content?: string;
  category?: string;
  tags?: string[];
}

/** 构造可写入的部分更新（严格校验字段类型） */
function buildUpdatePatch(updates: UpdateNoteInput | undefined): UpdateNoteInput {
  if (updates === undefined || updates === null || typeof updates !== 'object') {
    throw new NotesParamError('updates', `必须为对象，实际收到: ${previewValue(updates)}`);
  }
  const patch: UpdateNoteInput = {};
  const title = optionalString(updates.title, 'title');
  if (title !== undefined) patch.title = title;
  const content = optionalString(updates.content, 'content');
  if (content !== undefined) patch.content = content;
  const category = optionalString(updates.category, 'category');
  if (category !== undefined) patch.category = category;
  const tags = normalizeTags(updates.tags, 'tags');
  if (tags !== undefined) patch.tags = tags;
  return patch;
}

/** 把校验后的补丁合并进现有笔记（标题全空白保留原标题；正文变更时重派生 text） */
function mergeNote(existing: Note, patch: UpdateNoteInput): Note {
  const trimmedTitle =
    patch.title !== undefined ? patch.title.trim() || existing.title : existing.title;
  const content = patch.content !== undefined ? patch.content : existing.content;
  return {
    ...existing,
    title: trimmedTitle,
    content,
    text: patch.content !== undefined ? extractNoteText(content) : existing.text,
    ...(patch.category !== undefined
      ? { category: normalizeCategory(patch.category, existing.category) }
      : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    updatedAt: new Date().toISOString(),
  };
}

/** 正文预览：折叠空白便于卡片单行展示 */
function buildPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH);
}

// ──── 变更广播（跨上下文实时同步） ────

/** 变更广播消息类型（工具/页面/后台写入后通知其它扩展上下文刷新） */
export const NOTES_CHANGED_MESSAGE = 'NOTES_CHANGED';

export type NotesChangeAction = 'create' | 'update' | 'append' | 'delete';

/**
 * 广播笔记变更（同一扩展内的其它上下文：笔记页、侧边栏等）。
 * 无接收者或非扩展上下文时静默降级，广播失败绝不影响写操作本身。
 */
export function broadcastNotesChanged(action: NotesChangeAction, noteId?: string): void {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    void chrome.runtime
      .sendMessage({ type: NOTES_CHANGED_MESSAGE, payload: { action, noteId } })
      .catch(() => undefined);
  } catch {
    // 同步异常同样降级
  }
}

/** 生成 UUID 主键（扩展上下文均为安全环境，crypto.randomUUID 可用） */
function generateNoteId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 将任意入参收敛为合法整数（防御 NaN / 负数 / 非数字） */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), min), max);
}

// ──── 数据库实现 ────

class NotesDatabase {
  private db: IDBDatabase | null = null;
  /** 并发 init 去重：多个上下文同时首访只发起一次 open */
  private opening: Promise<IDBDatabase> | null = null;

  /** 兼容显式初始化入口 */
  async init(): Promise<void> {
    await this.ensureDB('init');
  }

  /**
   * 统一事务执行器：
   * - 以 tx.oncomplete 作为成功判定点（请求成功 ≠ 事务已提交）；
   * - request error / transaction error / transaction abort 全部收敛为
   *   NotesDatabaseError（含 operation 与可读 cause）。
   */
  private runTx<T>(
    operation: string,
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore, setResult: (value: T) => void) => void,
  ): Promise<T> {
    return this.ensureDB(operation).then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          let settled = false;
          let result: T | undefined;
          let hasResult = false;

          const succeed = () => {
            if (settled) return;
            settled = true;
            resolve(result as T);
          };
          const fail = (cause: unknown, hint?: string) => {
            if (settled) return;
            settled = true;
            console.error(`[NotesDB] ${operation} 事务失败:`, cause);
            reject(new NotesDatabaseError(operation, cause, hint));
          };

          let tx: IDBTransaction;
          try {
            tx = db.transaction([NOTES_STORE], mode);
          } catch (cause) {
            fail(cause, '无法开启数据库事务，浏览器存储可能不可用（隐私模式/策略限制）或数据已损坏');
            return;
          }

          tx.oncomplete = () => {
            if (hasResult) succeed();
            else fail(new Error('事务完成但未取得结果'));
          };
          tx.onerror = () =>
            fail(tx.error, '存储事务执行出错，可在扩展管理页检查浏览器存储权限与剩余空间');
          tx.onabort = () =>
            fail(
              tx.error ?? new DOMException('Transaction aborted', 'AbortError'),
              '存储事务被中止（可能是约束冲突或存储不可用）',
            );

          try {
            body(tx.objectStore(NOTES_STORE), (value) => {
              result = value;
              hasResult = true;
            });
          } catch (cause) {
            fail(cause);
          }
        }),
    );
  }

  /** 获取（并按需打开）数据库连接；并发去重 + 版本协商让位 */
  private ensureDB(operation: string): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    if (!this.opening) {
      this.opening = this.open(operation).finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  private open(operation: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(
          new NotesDatabaseError(
            operation,
            new Error('indexedDB 不存在'),
            '浏览器可能处于隐私模式或禁用了本地存储，请切换到普通窗口重试',
          ),
        );
        return;
      }

      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(NOTES_DB_NAME, NOTES_DB_VERSION);
      } catch (cause) {
        reject(
          new NotesDatabaseError(operation, cause, '无法发起数据库打开请求，浏览器存储策略可能受限'),
        );
        return;
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // v2：统一笔记模型与旧结构完全不兼容（产品决策：不迁移旧数据），
        // 升级时丢弃旧 store 按新 schema 重建
        if (db.objectStoreNames.contains(NOTES_STORE)) {
          db.deleteObjectStore(NOTES_STORE);
        }
        const store = db.createObjectStore(NOTES_STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('category', 'category', { unique: false });
        store.createIndex('kind', 'kind', { unique: false });
        store.createIndex('tags', 'tags', { unique: false, multiEntry: true });
      };

      // 被其它未关闭的旧版本页面阻塞：仅告警并继续等待（打开仍可能成功）
      request.onblocked = () => {
        console.warn(
          `[NotesDB] 数据库 ${NOTES_DB_NAME} 升级被已打开的旧版本页面阻塞，` +
            '请关闭其它笔记页/扩展页面后重试',
        );
      };

      request.onerror = () =>
        reject(
          new NotesDatabaseError(
            operation,
            request.error,
            `数据库 ${NOTES_DB_NAME} 打开失败，可能被浏览器禁用或数据已损坏`,
          ),
        );

      request.onsuccess = () => {
        const db = request.result;
        // 其它上下文发起升级时主动让位，避免互相阻塞
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            // 关闭失败可忽略
          }
          this.db = null;
        };
        this.db = db;
        resolve(db);
      };
    });
  }

  // ──── CRUD ────

  /**
   * 创建笔记（UUID 主键；正文写入时同步派生纯文本）
   */
  async createNote(params: CreateNoteInput = {}): Promise<Note> {
    if (params === undefined || params === null || typeof params !== 'object') {
      throw new NotesParamError('params', `必须为对象，实际收到: ${previewValue(params)}`);
    }
    const kind = normalizeKind(params.kind);
    const content = optionalString(params.content, 'content') ?? '';
    const source = normalizeSource(params.source, kind);

    const note: Note = {
      id: generateNoteId(),
      kind,
      title: normalizeTitle(params.title, '新笔记'),
      content,
      text: extractNoteText(content),
      category: normalizeCategory(params.category, CATEGORY_INBOX),
      tags: normalizeTags(params.tags, 'tags') ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(source ? { source } : {}),
    };

    await this.runTx<void>('createNote', 'readwrite', (store, setResult) => {
      const request = store.add(note);
      request.onsuccess = () => setResult();
    });
    return note;
  }

  /**
   * 获取完整笔记（不存在返回 null；ID 非法直接抛 NotesParamError）
   */
  async getNote(id: string): Promise<Note | null> {
    const noteId = requireNoteId(id, 'noteId');
    return this.runTx<Note | null>('getNote', 'readonly', (store, setResult) => {
      const request = store.get(noteId);
      request.onsuccess = () => setResult((request.result as Note | undefined) ?? null);
    });
  }

  /**
   * 仅获取笔记纯文本（不存在时返回 null）
   */
  async getNoteText(id: string): Promise<string | null> {
    const note = await this.getNote(id);
    return note ? note.text : null;
  }

  /**
   * (覆盖式)更新笔记字段；笔记不存在时返回 null。
   * 读-改-写在同一事务内完成，避免与并发写入互相覆盖。
   */
  async updateNote(id: string, updates: UpdateNoteInput): Promise<Note | null> {
    const noteId = requireNoteId(id, 'noteId');
    const patch = buildUpdatePatch(updates);

    return this.runTx<Note | null>('updateNote', 'readwrite', (store, setResult) => {
      const getReq = store.get(noteId);
      getReq.onsuccess = () => {
        const existing = getReq.result as Note | undefined;
        if (!existing) {
          setResult(null);
          return;
        }
        const updated = mergeNote(existing, patch);
        const putReq = store.put(updated);
        putReq.onsuccess = () => setResult(updated);
      };
    });
  }

  /**
   * (追加式)向笔记末尾追加内容（入参为纯文本，自动转义并组装为段落/代码块 HTML）。
   * 同一事务内读-改-写：智能体高频追加与用户保存并发时不会互相丢失。
   */
  async appendToNote(id: string, text: string): Promise<Note | null> {
    const noteId = requireNoteId(id, 'noteId');
    const content = requireString(text, 'content');
    const appendedHtml = plainTextToHtml(content);
    if (!appendedHtml) {
      // 空内容追加：无需写入，直接返回当前笔记（不存在则 null）
      return this.getNote(noteId);
    }

    return this.runTx<Note | null>('appendToNote', 'readwrite', (store, setResult) => {
      const getReq = store.get(noteId);
      getReq.onsuccess = () => {
        const existing = getReq.result as Note | undefined;
        if (!existing) {
          setResult(null);
          return;
        }
        const nextContent = existing.content
          ? `${existing.content}${appendedHtml}`
          : appendedHtml;
        const updated: Note = {
          ...existing,
          content: nextContent,
          text: extractNoteText(nextContent),
          updatedAt: new Date().toISOString(),
        };
        const putReq = store.put(updated);
        putReq.onsuccess = () => setResult(updated);
      };
    });
  }

  /**
   * 删除笔记（不存在时静默成功）
   */
  async deleteNote(id: string): Promise<void> {
    const noteId = requireNoteId(id, 'noteId');
    await this.runTx<void>('deleteNote', 'readwrite', (store, setResult) => {
      const request = store.delete(noteId);
      request.onsuccess = () => setResult();
    });
  }

  /**
   * 重命名分类（文件夹）：单事务内游标遍历该分类下全部笔记并改写为目标名。
   * - 不 bump updatedAt：改文件夹名不是内容变更，避免全部笔记跳到列表顶部；
   * - 目标名与原名相同（或清洗后相同）直接返回 0，不产生写入；
   * - 目标名已存在时允许合并（两文件夹的笔记归入同一新名），与主流笔记应用一致。
   *
   * @returns 实际改写的笔记数量
   */
  async renameCategory(oldCategory: string, newCategory: string): Promise<number> {
    const from = normalizeCategory(oldCategory, CATEGORY_INBOX);
    const to = normalizeCategory(newCategory, from);
    if (from === to) return 0;

    return this.runTx<number>('renameCategory', 'readwrite', (store, setResult) => {
      const request = store.index('category').openCursor(IDBKeyRange.only(from));
      let updated = 0;

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          setResult(updated);
          return;
        }
        const note = cursor.value as Note;
        cursor.update({ ...note, category: to });
        updated += 1;
        cursor.continue();
      };
    });
  }

  /**
   * 删除分类（文件夹）及其下全部笔记（不可恢复，调用方需先二次确认）。
   *
   * @returns 实际删除的笔记数量
   */
  async deleteCategory(category: string): Promise<number> {
    const target = normalizeCategory(category, CATEGORY_INBOX);

    return this.runTx<number>('deleteCategory', 'readwrite', (store, setResult) => {
      const request = store.index('category').openCursor(IDBKeyRange.only(target));
      let deleted = 0;

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          setResult(deleted);
          return;
        }
        cursor.delete();
        deleted += 1;
        cursor.continue();
      };
    });
  }

  /**
   * 列出笔记（完整对象，按更新时间倒序，支持分页；参数自动收敛为合法整数）
   */
  async listNotes(limit = 100, offset = 0): Promise<Note[]> {
    const take = clampInt(limit, 1, 10000, 100);
    const skip = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);

    return this.runTx<Note[]>('listNotes', 'readonly', (store, setResult) => {
      const index = store.index('updatedAt');
      const request = index.openCursor(null, 'prev');

      const notes: Note[] = [];
      let skipped = 0;

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          setResult(notes);
          return;
        }
        if (skipped < skip) {
          skipped += 1;
          cursor.continue();
          return;
        }
        if (notes.length >= take) {
          setResult(notes);
          return;
        }
        notes.push(cursor.value as Note);
        cursor.continue();
      };
    });
  }

  /**
   * 列表页用轻量条目（按更新时间倒序）。
   * 游标流式生成，只保留轻量条目、不驻留正文，避免大笔记拖垮列表页内存。
   */
  async listNotePreviews(): Promise<NoteListItem[]> {
    return this.runTx<NoteListItem[]>('listNotePreviews', 'readonly', (store, setResult) => {
      const index = store.index('updatedAt');
      const request = index.openCursor(null, 'prev');

      const items: NoteListItem[] = [];

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          setResult(items);
          return;
        }
        const note = cursor.value as Note;
        items.push({
          id: note.id,
          kind: note.kind,
          title: note.title,
          category: note.category,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          tags: note.tags ?? [],
          ...(note.source ? { source: note.source } : {}),
          textPreview: buildPreview(note.text || ''),
        });
        cursor.continue();
      };
    });
  }
}

export const notesDB = new NotesDatabase();

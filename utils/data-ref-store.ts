/**
 * 数据引用暂存区（data-ref store）
 *
 * 「脚本抓取 → 暂存 → 直接导出」通道的共享底座，解决 AI 手工转抄批量数据
 * 导致的丢失/捏造/输错问题：
 *
 *   browser_page_exec（saveResult 默认开启）──┐
 *   （页面内全量 JSON 落暂存区）               ├──▶ dataRef（8 位 ID）
 *                                          │      ├─ data_ref_tool：info/merge/list/delete
 *                                          │      └─ xlsx_tool(create_from_data)：按 ID 直接生成 Excel
 *                                          └──── 数据全程不经过模型上下文
 *
 * 存储选型：
 *   - 首选 chrome.storage.session：仅存于内存、浏览器退出即清空（抓取的页面
 *     数据不落盘、不进扩展文件库，隐私友好），且 Service Worker 被回收后仍在；
 *   - 不可用时回退 chrome.storage.local（同名 key，行为一致仅多一层持久化）。
 *
 * 与 file-manager 同构的并发约定：整表读入内存 Map、整表写回（扩展各上下文
 * 同源但内存互不可见，实际写入方几乎总是 background 单点，竞态窗口可忽略）。
 */

// ──── 领域类型 ────

/** 数据形态：records=对象数组（每行一条记录）/ matrix=二维数组 / value=其它单值 */
export type DataRefKind = 'records' | 'matrix' | 'value';

/** 暂存条目的元数据（list/info 场景只回传这一层，不带全量数据） */
export interface DataRefMeta {
  /** 8 位随机 ID，即模型侧的 dataRef */
  id: string;
  /** 保存时的语义标签（如「第1页-商品列表」） */
  label?: string;
  kind: DataRefKind;
  /** 行数（records/matrix 有意义） */
  rowCount?: number;
  /** 矩阵最大列数 */
  cols?: number;
  /** records 字段并集（首见顺序，已截断到上限） */
  fields?: string[];
  /** 序列化后的字节数 */
  bytes: number;
  createdAt: number;
  /** 首行预览（截断的紧凑 JSON，供模型快速核对） */
  preview?: string;
}

/** 完整暂存条目 */
export interface DataRefEntry extends DataRefMeta {
  /** 全量数据的 JSON 文本（导出时才解析，list/info 永不返回） */
  json: string;
}

export type SaveDataRefResult =
  | { ok: true; meta: DataRefMeta }
  | { ok: false; reason: string };

// ──── 上限常量 ────

/** 暂存区总容量（chrome.storage.session 默认配额 10MB，留出余量） */
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
/** 单条目上限（超过则引导模型在脚本内先筛选/精简） */
const MAX_ENTRY_BYTES = MAX_TOTAL_BYTES;
/** records 字段并集上限（xlsx 单表列上限为 256，超出部分无导出意义）。
 *  导出为共享常量：xlsx_tool 的 fields 校验据此判断「字段并集是否被截断」，
 *  截断时跳过拼写校验以免误伤合法字段。 */
export const MAX_FIELDS = 256;
/** 预览字符数 */
const PREVIEW_CHARS = 300;
/** 条目存活时长：超时在下次打开时惰性清除（会话内数据，过期即失效）。
 *  12 小时：覆盖「上午抓取、下午核对/导出」的工作节奏；仍短于浏览器会话
 *  的物理上限（session 存储浏览器退出即清），隐私边界不变。 */
const ENTRY_TTL_MS = 12 * 60 * 60 * 1000;

const STORAGE_KEY = 'agentNexusDataRefs';
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

// ──── 纯函数：形态分析与元数据 ────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON 文本字节数（UTF-8，避免多字节中文按字符数误判容量） */
function byteLength(json: string): number {
  try {
    return new TextEncoder().encode(json).length;
  } catch {
    return json.length;
  }
}

/** 截断到指定字符数并追加省略标记 */
function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/**
 * 分析值形态并计算元数据。
 * 对象数组=records；数组行/标量数组=matrix；其余=value（不计行数）。
 */
function analyzeValue(value: unknown): Pick<DataRefMeta, 'kind' | 'rowCount' | 'cols' | 'fields' | 'preview'> {
  const previewOf = (sample: unknown): string | undefined => {
    try {
      const text = JSON.stringify(sample ?? null);
      return typeof text === 'string' ? truncate(text, PREVIEW_CHARS) : undefined;
    } catch {
      return undefined;
    }
  };

  if (Array.isArray(value)) {
    const allObjects = value.length > 0 && value.every(isPlainObject);
    const allArrays = value.length > 0 && value.every(Array.isArray);
    const allPrimitives = value.every(v => v === null || ['string', 'number', 'boolean'].includes(typeof v));

    if (allObjects) {
      const fields: string[] = [];
      const seen = new Set<string>();
      for (const item of value) {
        for (const key of Object.keys(item)) {
          if (seen.has(key)) continue;
          seen.add(key);
          if (fields.length < MAX_FIELDS) fields.push(key);
        }
      }
      return { kind: 'records', rowCount: value.length, fields, preview: previewOf(value[0]) };
    }
    if (allArrays) {
      const cols = value.reduce((max, row) => Math.max(max, row.length), 0);
      return { kind: 'matrix', rowCount: value.length, cols, preview: previewOf(value[0]) };
    }
    if (allPrimitives) {
      return { kind: 'matrix', rowCount: value.length, cols: 1, preview: previewOf(value[0]) };
    }
    return { kind: 'value', preview: previewOf(value) };
  }
  return { kind: 'value', preview: previewOf(value) };
}

// ──── 存储引擎 ────

class DataRefStoreEngine {
  private static instance: DataRefStoreEngine;
  private entries = new Map<string, DataRefEntry>();
  private initialized = false;
  /** 实际使用的存储区（session 优先，local 兜底） */
  private useSession = true;

  private constructor() {}

  static getInstance(): DataRefStoreEngine {
    if (!DataRefStoreEngine.instance) {
      DataRefStoreEngine.instance = new DataRefStoreEngine();
    }
    return DataRefStoreEngine.instance;
  }

  /** 打开存储（幂等）：装载 + 惰性过期清理 */
  private async ensureOpen(): Promise<void> {
    if (this.initialized) return;
    try {
      if (typeof chrome === 'undefined' || !chrome.storage) {
        this.initialized = true; // 无扩展环境（测试/降级）：仅内存态
        return;
      }
      let stored: Record<string, unknown> | undefined;
      if (chrome.storage.session) {
        stored = (await chrome.storage.session.get(STORAGE_KEY)) as Record<string, unknown>;
      }
      if (!stored || stored[STORAGE_KEY] === undefined) {
        this.useSession = false;
        stored = (await chrome.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
      }
      const raw = stored?.[STORAGE_KEY];
      if (Array.isArray(raw)) {
        const now = Date.now();
        for (const item of raw) {
          if (!item || typeof item !== 'object') continue;
          const entry = item as DataRefEntry;
          if (typeof entry.id !== 'string' || typeof entry.json !== 'string') continue;
          if (now - (entry.createdAt || 0) > ENTRY_TTL_MS) continue; // 惰性过期
          this.entries.set(entry.id, entry);
        }
      }
      this.initialized = true;
      if (this.entries.size > 0) await this.persist();
    } catch (error) {
      console.warn('[DataRefStore] 打开存储失败，退化为仅内存态:', error);
      this.initialized = true;
    }
  }

  /** 整表写回（选用的存储区不可用时降级到另一存储区） */
  private async persist(): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    const data = { [STORAGE_KEY]: [...this.entries.values()] };
    try {
      if (this.useSession && chrome.storage.session) {
        await chrome.storage.session.set(data);
      } else {
        await chrome.storage.local.set(data);
      }
    } catch (error) {
      if (this.useSession) {
        // session 配额不足等：降级 local 继续服务，保证数据不丢
        this.useSession = false;
        try {
          await chrome.storage.local.set(data);
          return;
        } catch (fallbackError) {
          console.warn('[DataRefStore] 写入存储失败:', fallbackError);
          return;
        }
      }
      console.warn('[DataRefStore] 写入存储失败:', error);
    }
  }

  /** 生成 8 位唯一 ID */
  private generateId(): string {
    let id: string;
    do {
      id = '';
      for (let i = 0; i < 8; i++) id += ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length));
    } while (this.entries.has(id));
    return id;
  }

  /** 总字节数 */
  private totalBytes(): number {
    let sum = 0;
    for (const entry of this.entries.values()) sum += entry.bytes;
    return sum;
  }

  // ──── 对外 API ────

  /** 保存已序列化的 JSON 文本（调用方已完成 stringify，避免大对象二次序列化） */
  async saveJson(json: string, label?: string): Promise<SaveDataRefResult> {
    await this.ensureOpen();

    if (typeof json !== 'string' || json === '') {
      return { ok: false, reason: '数据为空：脚本没有产生可保存的结果' };
    }
    const bytes = byteLength(json);
    if (bytes > MAX_ENTRY_BYTES) {
      const mb = (bytes / 1024 / 1024).toFixed(1);
      return {
        ok: false,
        reason: `单次数据 ${mb}MB 超过暂存上限 ${MAX_ENTRY_BYTES / 1024 / 1024}MB——请在脚本内先筛选字段、限制条数或分批保存`,
      };
    }

    // 先校验 JSON 再做任何容量淘汰：淘汰是破坏性副作用，
    // 绝不能因为一批非法数据被解析拒绝而误删仍然有效的旧批次
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      return { ok: false, reason: `数据不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
    }

    // 容量守卫：超限时按创建时间从旧到新淘汰，保证新数据总能落盘
    let evicted = 0;
    while (this.totalBytes() + bytes > MAX_TOTAL_BYTES && this.entries.size > 0) {
      let oldestId: string | null = null;
      let oldestAt = Infinity;
      for (const entry of this.entries.values()) {
        if (entry.createdAt < oldestAt) {
          oldestAt = entry.createdAt;
          oldestId = entry.id;
        }
      }
      if (!oldestId) break;
      this.entries.delete(oldestId);
      evicted++;
    }
    if (this.totalBytes() + bytes > MAX_TOTAL_BYTES) {
      return {
        ok: false,
        reason: `暂存区已满（${MAX_TOTAL_BYTES / 1024 / 1024}MB）且无可淘汰数据——请用 data_ref_tool(action="delete") 清理后重试`,
      };
    }

    const meta: DataRefMeta = {
      id: this.generateId(),
      ...(label && typeof label === 'string' ? { label: label.slice(0, 120) } : {}),
      ...analyzeValue(parsed),
      bytes,
      createdAt: Date.now(),
    };
    this.entries.set(meta.id, { ...meta, json });
    await this.persist();
    if (evicted > 0) {
      console.log(`[DataRefStore] 容量守卫淘汰 ${evicted} 条最旧数据以容纳新数据`);
    }
    return { ok: true, meta };
  }

  /** 保存任意可 JSON 化的值（便捷包装） */
  async save(value: unknown, label?: string): Promise<SaveDataRefResult> {
    if (value === undefined) {
      return { ok: false, reason: '数据为空：脚本返回 undefined（请确保脚本 return 了数据）' };
    }
    let json: string;
    try {
      const text = JSON.stringify(value);
      if (typeof text !== 'string') {
        // JSON.stringify 对函数 / Symbol / undefined 顶层值返回 undefined——
        // 这类值没有 JSON 形态，如实报错而不是静默存成 "null" 造成数据错觉
        return {
          ok: false,
          reason: `数据没有 JSON 形态（返回值类型为 ${Object.prototype.toString.call(value)}）——请在脚本内转换为纯数据结构（对象/数组/原始值）后再返回`,
        };
      }
      json = text;
    } catch (error) {
      return {
        ok: false,
        reason: `数据无法序列化为 JSON（${error instanceof Error ? error.message : String(error)}）——请在脚本内转换为纯数据结构后再返回`,
      };
    }
    return this.saveJson(json, label);
  }

  /** 按 ID 取完整条目（xlsx 导出用） */
  async get(id: string): Promise<DataRefEntry | null> {
    await this.ensureOpen();
    return (typeof id === 'string' && this.entries.get(id)) || null;
  }

  /** 全部条目元数据（新→旧；不携带 json） */
  async list(): Promise<DataRefMeta[]> {
    await this.ensureOpen();
    return [...this.entries.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ json: _json, ...meta }) => meta);
  }

  /** 删除指定条目（ids='all' 清空）；返回实际删除数 */
  async remove(ids: string[] | 'all'): Promise<number> {
    await this.ensureOpen();
    if (ids === 'all') {
      const count = this.entries.size;
      this.entries.clear();
      await this.persist();
      return count;
    }
    let count = 0;
    for (const id of ids) {
      if (typeof id === 'string' && this.entries.delete(id)) count++;
    }
    if (count > 0) await this.persist();
    return count;
  }

  /**
   * 合并多个条目为新条目（按给定顺序拼接）：
   * records + records → 数组拼接（字段并集自动重算）；matrix + matrix → 行拼接。
   * 形态混用/含 value 时拒绝并说明原因。
   */
  async merge(ids: string[], label?: string): Promise<SaveDataRefResult> {
    await this.ensureOpen();
    if (!Array.isArray(ids) || ids.length === 0) {
      return { ok: false, reason: '缺少要合并的引用 ID（refs 至少 1 个）' };
    }

    const parts: unknown[][] = [];
    for (const id of ids) {
      const entry = typeof id === 'string' ? this.entries.get(id) : undefined;
      if (!entry) return { ok: false, reason: `引用 "${id}" 不存在或已过期（可用 action="list" 查看现存引用）` };
      let value: unknown;
      try {
        value = JSON.parse(entry.json);
      } catch {
        return { ok: false, reason: `引用 "${id}" 数据已损坏，无法合并` };
      }
      if (!Array.isArray(value)) {
        return { ok: false, reason: `引用 "${id}" 不是数组数据（kind=${entry.kind}），无法与数组批次合并` };
      }
      parts.push(value);
    }

    const kinds = new Set(parts.map(p => analyzeValue(p).kind));
    if (kinds.size > 1) {
      return { ok: false, reason: '待合并数据形态不一致（对象数组与二维数组不能混拼）——请统一脚本输出结构' };
    }
    const merged = ([] as unknown[]).concat(...(parts as unknown[][]));
    const kind = analyzeValue(merged).kind;
    if (kind === 'value') {
      return { ok: false, reason: '合并结果不是可按行拼接的数据形态' };
    }

    const defaultLabel = ids.length > 1 ? `合并${ids.length}批` : `合并自${ids[0]}`;
    return this.save(merged, label || defaultLabel);
  }
}

// 导出单例与便捷函数
export const dataRefStore = DataRefStoreEngine.getInstance();

export const saveDataRef = (value: unknown, label?: string) => dataRefStore.save(value, label);
export const saveDataRefJson = (json: string, label?: string) => dataRefStore.saveJson(json, label);
export const getDataRef = (id: string) => dataRefStore.get(id);
export const listDataRefs = () => dataRefStore.list();
export const deleteDataRefs = (ids: string[] | 'all') => dataRefStore.remove(ids);
export const mergeDataRefs = (ids: string[], label?: string) => dataRefStore.merge(ids, label);

/**
 * 数据引用暂存区（data-ref store）
 *
 * 「脚本抓取 → 暂存 → 直接导出」通道的共享底座，解决 AI 手工转抄批量数据
 * 导致的丢失/捏造/输错问题：
 *
 *   browser_page_exec（saveResult 默认开启）──┐
 *   （页面内全量 JSON 落暂存区）               ├──▶ dataRef（8 位 ID）
 *   browser_network_capture（响应正文落盘）────┘      ├─ data_ref_tool：list/info/merge/extract/dedupe/delete
 *                                                 └─ xlsx_tool(create_from_data)：按 ID 直接生成 Excel
 *                                                 数据全程不经过模型上下文
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

/** 去重结果：除新批次元数据外携带行级统计，供模型在汇报中给出可核验的数字 */
export type DedupeDataRefResult =
  | {
      ok: true;
      meta: DataRefMeta;
      /** 参与去重的原始总行数 */
      originalRows: number;
      /** 去重后保留行数 */
      uniqueRows: number;
      /** 因与更早行重复而删除的行数 */
      removed: number;
      /** 因缺少 by 指定字段、无法判定重复而原样保留的行数 */
      keptWithoutKey: number;
    }
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
/** dedupe 键的字段分隔符（控制字符，不与字段名/JSON 值文本重叠，杜绝键拼接歧义） */
const DEDUPE_KEY_SEP = String.fromCharCode(1);

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
   * 载入并校验「按行操作」（merge/dedupe 共用）的输入批次：
   * 逐个解析为行数组，拒绝不存在/损坏/非数组的引用与形态混用。
   * verb 进入错误文案（merge='合并' / dedupe='去重'），保证两条通路提示一致。
   */
  private async collectRowParts(
    ids: unknown,
    verb: string,
  ): Promise<{ ok: true; parts: unknown[][] } | { ok: false; reason: string }> {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { ok: false, reason: `缺少要${verb}的引用 ID（refs 至少 1 个）` };
    }
    const parts: unknown[][] = [];
    for (const id of ids) {
      const entry = typeof id === 'string' ? this.entries.get(id) : undefined;
      if (!entry) {
        return {
          ok: false,
          reason: `引用 "${id}" 不存在或已过期（可用 action="list" 查看现存引用）`,
        };
      }
      let value: unknown;
      try {
        value = JSON.parse(entry.json);
      } catch {
        return { ok: false, reason: `引用 "${id}" 数据已损坏，无法${verb}` };
      }
      if (!Array.isArray(value)) {
        return {
          ok: false,
          reason: `引用 "${id}" 不是数组数据（kind=${entry.kind}），无法与数组批次${verb}`,
        };
      }
      parts.push(value);
    }
    const kinds = new Set(parts.map(p => analyzeValue(p).kind));
    if (kinds.size > 1) {
      return {
        ok: false,
        reason: `待${verb}数据形态不一致（对象数组与二维数组不能混拼）——请统一脚本输出结构`,
      };
    }
    return { ok: true, parts };
  }

  /**
   * 合并多个条目为新条目（按给定顺序拼接）：
   * records + records → 数组拼接（字段并集自动重算）；matrix + matrix → 行拼接。
   * 形态混用/含 value 时拒绝并说明原因。
   */
  async merge(ids: string[], label?: string): Promise<SaveDataRefResult> {
    await this.ensureOpen();
    const collected = await this.collectRowParts(ids, '合并');
    if (!collected.ok) return collected;

    const merged = ([] as unknown[]).concat(...collected.parts);
    const kind = analyzeValue(merged).kind;
    if (kind === 'value') {
      return { ok: false, reason: '合并结果不是可按行拼接的数据形态' };
    }

    const idList = ids as string[];
    const defaultLabel = idList.length > 1 ? `合并${idList.length}批` : `合并自${idList[0]}`;
    return this.save(merged, label || defaultLabel);
  }

  /**
   * 按顺序拼接多个批次并去重（滚动增量抓取产生重复行的治理通道）：
   *   - by 缺省：整行 JSON 作为去重键（records/matrix 通用）；
   *   - by 给定：仅 records，用指定字段值序列化拼接作键；字段并集与 xlsx
   *     同口径校验（并集被 MAX_FIELDS 截断时跳过，避免误伤合法字段）；
   *   - 缺少 by 字段的行无法判定重复，一律原样保留（宁可留重，绝不误删）；
   *   - 保留首次出现的行，顺序稳定。
   * 单批次且无重复时不产生新批次（避免无谓的存储翻倍），meta 原样返回。
   */
  async dedupe(
    ids: string[],
    by?: string[],
    label?: string,
  ): Promise<DedupeDataRefResult> {
    await this.ensureOpen();
    // by 形状校验先于数据校验：纯参数错误不应被引用/数据错误掩盖
    if (
      by !== undefined &&
      (!Array.isArray(by) ||
        by.length === 0 ||
        !by.every(k => typeof k === 'string' && k.trim().length > 0))
    ) {
      return {
        ok: false,
        reason: 'by 必须是非空字符串数组（去重字段名列表，如 ["id"]）——整行去重请省略 by',
      };
    }
    const collected = await this.collectRowParts(ids, '去重');
    if (!collected.ok) return collected;

    const rows = ([] as unknown[]).concat(...collected.parts);
    const kind = analyzeValue(rows).kind;
    if (kind === 'value') {
      return { ok: false, reason: '去重结果不是可按行拼接的数据形态' };
    }

    // by 字段存在性校验（与 xlsx fields 同口径）
    let byFields: string[] | null = null;
    if (by !== undefined) {
      if (kind !== 'records') {
        return {
          ok: false,
          reason: 'by 仅适用于对象数组批次（二维数组请省略 by，按整行去重）',
        };
      }
      byFields = by.map(k => k.trim());
      // 字段并集校验：仅当并集未被 MAX_FIELDS 截断时才可信（口径同 xlsx fields）
      const union = new Set<string>();
      let unionTruncated = false;
      for (const id of ids) {
        const entry = this.entries.get(id as string);
        for (const f of entry?.fields ?? []) union.add(f);
        if ((entry?.fields?.length ?? 0) >= MAX_FIELDS) unionTruncated = true;
      }
      if (!unionTruncated && union.size > 0) {
        const unknownKeys = byFields.filter(f => !union.has(f));
        if (unknownKeys.length > 0) {
          return {
            ok: false,
            reason:
              `by 字段 ${unknownKeys.map(k => JSON.stringify(k)).join('、')} 不在批次字段列表中（可能拼写有误）。` +
              `批次实际字段：${[...union].join('、')}`,
          };
        }
      }
    }

    const originalRows = rows.length;
    const seen = new Set<string>();
    const kept: unknown[] = [];
    let removed = 0;
    let keptWithoutKey = 0;

    for (const row of rows) {
      let key: string | null;
      if (byFields) {
        // 缺任一 by 字段 → 无法判定重复 → 保留（绝不因键缺失而误删）
        if (
          !isPlainObject(row) ||
          byFields.some(f => !Object.prototype.hasOwnProperty.call(row, f))
        ) {
          kept.push(row);
          keptWithoutKey++;
          continue;
        }
        key = byFields
          .map(f => `${f}=${JSON.stringify(row[f] ?? null)}`)
          .join(DEDUPE_KEY_SEP);
      } else {
        try {
          const text = JSON.stringify(row);
          key = typeof text === 'string' ? text : null;
        } catch {
          key = null;
        }
      }
      if (key === null) {
        // 键序列化失败（理论上 JSON 数据不会发生）：保守保留
        kept.push(row);
        keptWithoutKey++;
        continue;
      }
      if (seen.has(key)) {
        removed++;
        continue;
      }
      seen.add(key);
      kept.push(row);
    }

    // 单批次且无删除：不产生新批次（meta 原样回传，避免存储翻倍）
    if (ids.length === 1 && removed === 0) {
      const source = this.entries.get(ids[0]);
      if (source) {
        const { json: _json, ...meta } = source;
        return {
          ok: true,
          meta,
          originalRows,
          uniqueRows: originalRows,
          removed: 0,
          keptWithoutKey,
        };
      }
      return { ok: false, reason: `引用 "${ids[0]}" 不存在或已过期（可用 action="list" 查看现存引用）` };
    }

    const defaultLabel = ids.length > 1 ? `去重${ids.length}批` : `去重自${ids[0]}`;
    const saved = await this.save(kept, label || defaultLabel);
    if (!saved.ok) return saved;
    return {
      ok: true,
      meta: saved.meta,
      originalRows,
      uniqueRows: kept.length,
      removed,
      keptWithoutKey,
    };
  }

  /**
   * 从信封响应中按点分路径提取列表为新批次（capture 被动收割的配套能力：
   * 接口响应常为 {data:{items:[...]}} 包装，merge/xlsx 只接受表格形态批次）。
   * 路径支持对象键与数组下标（a.b.0.c）；目标必须是表格形态数组。
   * 非破坏性：原批次保留；路径不存在时回显该层可用键，便于模型自助修正。
   */
  async extract(
    id: string,
    path: string,
    label?: string,
  ): Promise<SaveDataRefResult> {
    await this.ensureOpen();
    // 参数形状先于存在性校验（纯参数错误不被引用错误掩盖）
    if (typeof id !== 'string' || !id.trim()) {
      return { ok: false, reason: 'extract 需要非空字符串引用 ID（ref）' };
    }
    if (typeof path !== 'string') {
      return { ok: false, reason: 'path 必须是字符串（点分路径，如 "data.list"）' };
    }
    // 规范化：整体 trim 后再切段——首尾空白不参与键匹配；
    // 空段（连续点/首尾点）显式拒绝而不是静默折叠，避免 "a..b" 被悄悄当作 "a.b"
    const normalized = path.trim();
    if (!normalized || normalized.length > 200) {
      return { ok: false, reason: 'path 必须是非空字符串（点分路径，如 "data.list"，≤200 字符）' };
    }
    const segments = normalized.split('.');
    if (segments.some(s => s.length === 0)) {
      return {
        ok: false,
        reason: 'path 含空段（连续点或首尾点）——请给出完整点分路径，如 "data.list"',
      };
    }
    if (segments.length > 12) {
      return { ok: false, reason: 'path 层级数需在 1-12 之间（点分段数）' };
    }
    if (!this.entries.has(id.trim())) {
      return { ok: false, reason: `引用 "${id.trim()}" 不存在或已过期（可用 action="list" 查看现存引用）` };
    }

    const refId = id.trim();
    const entry = this.entries.get(refId)!;
    let current: unknown;
    try {
      current = JSON.parse(entry.json);
    } catch {
      return { ok: false, reason: `引用 "${refId}" 数据已损坏，无法提取` };
    }

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const at = segments.slice(0, i + 1).join('.');
      if (Array.isArray(current)) {
        // 下标段必须是纯数字串（拒绝 "1e0"/" 1" 等会被 Number 静默接受的写法）
        if (!/^\d+$/.test(seg)) {
          return {
            ok: false,
            reason: `路径 "${at}" 无效：上一层是长度 ${current.length} 的数组，"${seg}" 不是有效下标（须为纯数字）`,
          };
        }
        const idx = Number(seg);
        if (idx >= current.length) {
          return {
            ok: false,
            reason: `路径 "${at}" 无效：上一层是长度 ${current.length} 的数组，下标 ${idx} 越界`,
          };
        }
        current = current[idx];
      } else if (isPlainObject(current)) {
        if (!Object.prototype.hasOwnProperty.call(current, seg)) {
          const allKeys = Object.keys(current);
          const keys = allKeys.slice(0, 30);
          const more = allKeys.length > 30 ? '…' : '';
          return {
            ok: false,
            reason: `路径 "${at}" 不存在——该层可用字段：${keys.join('、')}${more}`,
          };
        }
        current = current[seg];
      } else {
        return {
          ok: false,
          reason: `路径 "${at}" 无法继续：上一层是 ${current === null ? 'null' : typeof current}（非对象/数组）`,
        };
      }
    }

    if (!Array.isArray(current)) {
      const actual = current === null ? 'null' : typeof current;
      return {
        ok: false,
        reason: `路径 "${normalized}" 指向的值是 ${actual}——extract 只接受数组（列表）目标`,
      };
    }
    const analyzed = analyzeValue(current);
    if (analyzed.kind === 'value') {
      return {
        ok: false,
        reason: `路径 "${normalized}" 的提取结果不是表格形态（对象数组或二维数组），无法作为批次导出`,
      };
    }

    const defaultLabel = `提取自${refId}:${normalized}`;
    return this.save(current, label || defaultLabel);
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
export const dedupeDataRefs = (ids: string[], by?: string[], label?: string) =>
  dataRefStore.dedupe(ids, by, label);
export const extractDataRef = (id: string, path: string, label?: string) =>
  dataRefStore.extract(id, path, label);

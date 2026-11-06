/**
 * 统一信封（```component 围栏内容）解析与归一化
 *
 * 模型只被要求写「一张表」：{"type":...,"title":...,"columns":[...],"rows":[[...]]}。
 * 本模块负责把各种合理偏差归一到同一份 NormalizedEnvelope——净化、校验、
 * 兜底全在此层完成，下游（derive-chart / component-blocks）拿到的数据
 * 恒定干净，不再各自防御。
 *
 * ==================== 容错策略（宽容输入 / 严格输出） ====================
 *
 * 解析（两级）：
 *   1. 严格 JSON.parse（合格模型的主路径，字节零改动）；
 *   2. 失败后做两类最小修复再解析一次：
 *      a. 尾逗号剔除（",[}]" 形态，正则替换安全——字符串内的 ",]" 组合
 *         在合法 JSON 中不可能出现于该位置而不先被引号保护）；
 *      b. 单引号字符串转双引号——仅当整串不含任何双引号时启用：
 *         全单引号风格（Python 习惯）整体转换是安全的；混合风格下
 *         （如 "it's"）跨词配对会篡改数据，宁可解析失败降级源码视图。
 *
 * 归一（不失败，尽量保住模型想表达的数据）：
 *   - 顶层 {data:{columns,rows}} / {headers} 包装自动解包提级；
 *   - rows 为对象数组时按列名映射回数组；rows 为 {名:值} 映射时转二元组；
 *   - 行长与 columns 不齐：短补 null、长截断；
 *   - 单元格对象/数组 JSON.stringify 兜底；超长字符串截断；
 *   - rows 超上限截断保留前缀（数据主体不丢）。
 *
 * 硬失败（返回 ok:false，渲染侧降级源码视图）：
 *   空 / 超长 / 解析失败 / 非对象 / type 未知 / columns 超上限或缺位。
 */

import { ENVELOPE_COMPONENT_TYPES } from './registry';

// ==================== 资源上限（提示词不教模型记上限；超限由此层兜底） ====================

/** 围栏源码最大字符数（信封数据以表格为主，20K 已远超「一屏可读」上限） */
const MAX_SOURCE_CHARS = 20_000;
/** 列数上限（超出判结构性失败：过宽表格是建模错误，截断反而误导） */
const MAX_COLUMNS = 12;
/** 行数上限（超出截断保留前缀——时间序列多给一些行属正常） */
const MAX_ROWS = 200;
/** 单元格字符串上限（超出截断；表格/图表展示均不需要更长） */
const MAX_CELL_CHARS = 500;
/** 标题上限（超出截断） */
const MAX_TITLE_CHARS = 80;
/** kind / unit 上限（超出截断；kind 非法值由派生层回落） */
const MAX_AUX_CHARS = 20;

// ==================== 类型 ====================

export type RichCell = string | number | boolean | null;

export type RichEnvelopeType = 'chart' | 'stat' | 'table' | 'timeline' | 'tree';

/** 归一化后的信封：下游可信任的结构（字段齐全、行列对齐、单元格类型收敛） */
export interface NormalizedEnvelope {
  type: RichEnvelopeType;
  title: string;
  /** chart 可选图型偏好（未经合法性校验，由 derive-chart 决定采纳与否） */
  kind: string;
  /** 数值轴单位（chart 轴名 / 展示后缀；空串 = 未提供） */
  unit: string;
  columns: string[];
  rows: RichCell[][];
}

export type EnvelopeParseResult =
  | { ok: true; envelope: NormalizedEnvelope }
  | { ok: false; error: string };

// ==================== 工具 ====================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** 宽容数值解析：容忍千分位逗号、"12.3%"、"≈12" 等展示型前后缀（派生层使用） */
export function coerceNumber(value: RichCell): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return null;
  const match = value.trim().replace(/,/g, '').match(/^[+-]?(\d+(\.\d+)?|\.\d+)/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

// ==================== 容错 JSON ====================

/**
 * 字符串感知的最小修复：单遍扫描（非正则替换），逐字符跟踪字符串边界，
 * 修复只发生在字符串之外——字符串内容里的 ",]"、撇号永远不被触碰：
 *   1. 尾逗号剔除：字符串外的逗号后若紧跟 } / ]（允许中间空白）则丢弃；
 *   2. 单引号字符串转双引号（Python 习惯）：逐串转换，串内双引号转义、
 *      \' 收敛为 '；混合引号风格同样安全（逐串判定，无跨词配对风险）。
 * 未终止字符串 / 其他语法损伤不修复，交由 JSON.parse 失败 → 源码降级。
 */
function repairJsonText(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  /** 字符串外的悬置逗号：见到 } / ] 丢弃，见到其他非空白内容 flush */
  let pendingComma = false;

  const flushComma = (): void => {
    if (pendingComma) {
      out += ',';
      pendingComma = false;
    }
  };

  while (i < n) {
    const ch = text[i];

    if (ch === '"') {
      flushComma();
      // 双引号字符串：原样拷贝（尊重转义序列）
      let j = i + 1;
      out += '"';
      while (j < n) {
        const c = text[j];
        if (c === '\\' && j + 1 < n) {
          out += c + text[j + 1];
          j += 2;
          continue;
        }
        out += c;
        j++;
        if (c === '"') break;
      }
      i = j;
      continue;
    }

    if (ch === "'") {
      flushComma();
      // 单引号字符串 → 双引号：串内双引号转义，\' 收敛，其余原样
      let j = i + 1;
      out += '"';
      while (j < n) {
        const c = text[j];
        if (c === '\\' && j + 1 < n && text[j + 1] === "'") {
          out += "'";
          j += 2;
          continue;
        }
        if (c === "'") {
          j++;
          break;
        }
        out += c === '"' ? '\\"' : c;
        j++;
      }
      out += '"';
      i = j;
      continue;
    }

    if (ch === ',') {
      flushComma();
      pendingComma = true;
      i++;
      continue;
    }

    if (ch === '}' || ch === ']') {
      pendingComma = false; // 尾逗号：丢弃
      out += ch;
      i++;
      continue;
    }

    flushComma();
    out += ch;
    i++;
  }
  // 末尾悬置逗号（EOF 前的逗号）：丢弃（无闭合结构，本就非法）
  return out;
}

/**
 * 两级解析：严格 → 字符串感知修复 → 严格。
 * 修复不触碰字符串内容（见 repairJsonText），修复后仍失败则放弃。
 */
function tolerantJsonParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    /* 落入修复路径 */
  }
  try {
    return JSON.parse(repairJsonText(text));
  } catch {
    return undefined;
  }
}

// ==================== 归一化 ====================

/** 单元格收敛：对象/数组 stringify 兜底、超长截断、undefined → null */
function normalizeCell(value: unknown): RichCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return clampText(value, MAX_CELL_CHARS);
  try {
    return clampText(JSON.stringify(value) ?? '', MAX_CELL_CHARS);
  } catch {
    return null;
  }
}

/** 列名收敛：String + 截断（列名进 HTML 表头与图例，必须收敛长度） */
function normalizeColumn(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return clampText(value, MAX_CELL_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * 解析并归一化 ```component 围栏源码。
 * 失败原因面向源码降级展示（用户与模型都可读），不外泄异常对象。
 */
export function parseRichEnvelope(raw: string): EnvelopeParseResult {
  const text = (raw ?? '').trim();
  if (!text) {
    return { ok: false, error: '组件数据为空' };
  }
  if (text.length > MAX_SOURCE_CHARS) {
    return { ok: false, error: `组件数据超过 ${MAX_SOURCE_CHARS} 字符上限` };
  }

  const parsed = tolerantJsonParse(text);
  if (parsed === undefined) {
    return { ok: false, error: 'JSON 解析失败（存在无法自动修复的语法错误）' };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: '组件数据必须是单个 JSON 对象' };
  }

  // 包装解包：{data:{...}} / {chart:{...}} 提级（模型偶发的双层包装习惯）。
  // 合并而非替换：外层的 type / title 等元字段在内层缺失时保留
  let root = parsed as Record<string, unknown>;
  if (!root.columns && !root.rows) {
    for (const wrapper of ['data', 'chart', 'component']) {
      const inner = root[wrapper];
      if (isPlainObject(inner) && (inner.columns !== undefined || inner.rows !== undefined)) {
        root = { ...root, ...inner };
        break;
      }
    }
  }

  // type：合法枚举白名单（未知值整体拒绝——类型决定渲染器，猜错不如降级源码）
  const rawType = root.type;
  const type = typeof rawType === 'string' ? rawType.trim().toLowerCase() : '';
  if (!ENVELOPE_COMPONENT_TYPES.has(type)) {
    return { ok: false, error: `未知组件类型 "${clampText(type || '(缺失)', 40)}"` };
  }

  // columns：接受 columns / headers / cols 别名
  const rawColumns = root.columns ?? root.headers ?? root.cols;
  if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
    return { ok: false, error: 'columns（列名数组）缺失或为空' };
  }
  if (rawColumns.length > MAX_COLUMNS) {
    return { ok: false, error: `列数 ${rawColumns.length} 超过上限 ${MAX_COLUMNS}` };
  }
  const columns = rawColumns.map(normalizeColumn);

  // rows：数组 / 对象数组 / 名值映射 三种形态收敛
  const rawRows = root.rows;
  let rowSources: unknown[] = [];
  if (Array.isArray(rawRows)) {
    rowSources = rawRows;
  } else if (isPlainObject(rawRows)) {
    // {"苹果":3,"香蕉":5} → [[苹果,3],[香蕉,5]]（占比/单系列数据的常见写法）
    rowSources = Object.entries(rawRows).map(([key, value]) => [key, value]);
  } else {
    return { ok: false, error: 'rows（数据行数组）缺失或类型错误' };
  }
  if (rowSources.length === 0) {
    return { ok: false, error: 'rows（数据行数组）为空' };
  }
  rowSources = rowSources.slice(0, MAX_ROWS);

  // 对象数组 rows：无 columns 时以首次出现的键序生成列名（弱模型兜底）
  const objectRows = rowSources.filter(isPlainObject);
  if (objectRows.length > 0 && objectRows.length === rowSources.length && columns.every(c => !c)) {
    const keyOrder: string[] = [];
    for (const row of objectRows) {
      for (const key of Object.keys(row)) {
        if (!keyOrder.includes(key)) keyOrder.push(key);
      }
    }
    for (let i = 0; i < Math.min(keyOrder.length, MAX_COLUMNS); i++) columns[i] = keyOrder[i];
  }

  const rows: RichCell[][] = rowSources.map(rowSource => {
    let cells: unknown[];
    if (Array.isArray(rowSource)) {
      cells = rowSource;
    } else if (isPlainObject(rowSource)) {
      cells = columns.map(col => (col in rowSource ? rowSource[col] : null));
    } else {
      cells = [rowSource];
    }
    // 行长对齐：短补 null、长截断（与 columns 严格同宽——下游派生无需再判）
    const aligned: RichCell[] = [];
    for (let i = 0; i < columns.length; i++) {
      aligned.push(normalizeCell(cells[i]));
    }
    return aligned;
  });

  const title = typeof root.title === 'string' ? clampText(root.title.trim(), MAX_TITLE_CHARS) : '';
  const kind = typeof root.kind === 'string' ? clampText(root.kind.trim().toLowerCase(), MAX_AUX_CHARS) : '';
  const unit = typeof root.unit === 'string' ? clampText(root.unit.trim(), MAX_AUX_CHARS) : '';

  return {
    ok: true,
    envelope: {
      type: type as RichEnvelopeType,
      title,
      kind,
      unit,
      columns,
      rows,
    },
  };
}

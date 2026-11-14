/**
 * 行数据处理引擎（纯函数）
 *
 * 「数据源 → 行数据 → 治理 → 导出」通道的共享内核：同一套合并/去重/投影
 * 语义同时服务于两代数据源——data_ref_tool 的暂存批次（refs）与工作区
 * 数据文件（files，见 python-workspace/data-files.ts）。存储 I/O 不在此层：
 * 函数只做行的解析、拼接、去重与投影，读写由调用方（store / 工作区）完成。
 *
 * 形态约定（与 analyzeValue 同源）：
 *   records = 对象数组（每行一条记录）；matrix = 二维数组/标量数组；
 *   value   = 其它单值（不可按行治理/导出）。
 */

/** records 字段并集上限（xlsx 单表列上限 256，超出部分无导出意义）。
 *  导出为共享常量：xlsx_tool 的 fields 校验据此判断「字段并集是否被截断」。 */
export const MAX_FIELDS = 256;

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 去重键的字段分隔符（控制字符，不与字段名/JSON 值文本重叠，杜绝键拼接歧义） */
const DEDUPE_KEY_SEP = String.fromCharCode(1);

export type DataShape = "records" | "matrix" | "value";

/** 行数（records/matrix 有意义时的统计口径） */
export interface ShapeMeta {
  kind: DataShape;
  rowCount?: number;
  cols?: number;
  fields?: string[];
}

/**
 * 分析值形态并计算元数据。
 * 对象数组=records；数组行/标量数组=matrix；其余=value（不计行数）。
 */
export function analyzeValue(value: unknown): ShapeMeta {
  if (Array.isArray(value)) {
    const allObjects = value.length > 0 && value.every(isPlainObject);
    const allArrays = value.length > 0 && value.every(Array.isArray);
    const allPrimitives = value.every(
      (v) => v === null || ["string", "number", "boolean"].includes(typeof v),
    );

    if (allObjects) {
      const [fields] = collectRecordFields(value as Record<string, unknown>[]);
      return { kind: "records", rowCount: value.length, fields };
    }
    if (allArrays) {
      const cols = value.reduce((max, row) => Math.max(max, row.length), 0);
      return { kind: "matrix", rowCount: value.length, cols };
    }
    if (allPrimitives) {
      return { kind: "matrix", rowCount: value.length, cols: 1 };
    }
    return { kind: "value" };
  }
  return { kind: "value" };
}

/**
 * 计算对象数组的字段并集（首见顺序，截断到 MAX_FIELDS）。
 * 返回 [字段列表, 是否截断]——截断标志供 fields/by 校验跳过误伤判断。
 */
export function collectRecordFields(
  rows: readonly Record<string, unknown>[],
): [string[], boolean] {
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (fields.length < MAX_FIELDS) fields.push(key);
    }
  }
  return [fields, seen.size > fields.length];
}

/**
 * 多源行数组拼接（merge / dedupe 的共同前置）：
 * 形态必须一致（records 与 matrix 不能混拼），否则治理语义不成立。
 * 空数据源（零行，如某轮抓取无结果）不参与形态判定——零行数据不构成
 * 混拼冲突，允许与任意形态拼接。
 */
export function concatRowParts(
  parts: readonly unknown[][],
  verb: string,
): { ok: true; rows: unknown[] } | { ok: false; reason: string } {
  const rows = ([] as unknown[]).concat(...parts);
  const kinds = new Set(
    parts
      .filter((part) => part.length > 0)
      .map((part) => analyzeValue(part).kind),
  );
  if (kinds.size > 1) {
    return {
      ok: false,
      reason: `待${verb}数据形态不一致（对象数组与二维数组不能混拼）——请统一脚本输出结构或分开治理`,
    };
  }
  if (kinds.has("value")) {
    return {
      ok: false,
      reason: `待${verb}数据里有行的形态不统一（对象行与其它类型行混杂）——请先用 data_ref_tool(action="project") 整形为纯对象数组`,
    };
  }
  return { ok: true, rows };
}

export interface DedupeStats {
  kept: unknown[];
  /** 参与去重的原始总行数 */
  originalRows: number;
  /** 保留行数 */
  uniqueRows: number;
  /** 因与更早行重复而删除的行数 */
  removed: number;
  /** 因缺少 by 指定字段、无法判定重复而原样保留的行数 */
  keptWithoutKey: number;
}

/**
 * 按序去重（纯核心）：
 *   - byFields=null：整行 JSON 作为去重键（records/matrix 通用）；
 *   - byFields 给定：用指定字段值序列化拼接作键；
 *   - 缺少任一 by 字段的行无法判定重复，一律原样保留（宁可留重，绝不误删）；
 *   - 保留首次出现的行，顺序稳定。
 */
export function dedupeRows(
  rows: readonly unknown[],
  byFields: readonly string[] | null,
): DedupeStats {
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
        byFields.some((f) => !Object.prototype.hasOwnProperty.call(row, f))
      ) {
        kept.push(row);
        keptWithoutKey++;
        continue;
      }
      key = byFields
        .map((f) => `${f}=${JSON.stringify(row[f] ?? null)}`)
        .join(DEDUPE_KEY_SEP);
    } else {
      try {
        const text = JSON.stringify(row);
        key = typeof text === "string" ? text : null;
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

  return {
    kept,
    originalRows: rows.length,
    uniqueRows: kept.length,
    removed,
    keptWithoutKey,
  };
}

/**
 * by 字段存在性校验（与 xlsx fields 同口径）：
 * 仅当所有源的字段并集都未被 MAX_FIELDS 截断时才可信，截断时跳过以免误伤。
 */
export function validateByFields(
  by: readonly string[],
  sources: readonly { fields?: string[] }[],
): string | null {
  const union = new Set<string>();
  let unionTruncated = false;
  for (const source of sources) {
    for (const field of source.fields ?? []) union.add(field);
    if ((source.fields?.length ?? 0) >= MAX_FIELDS) unionTruncated = true;
  }
  if (unionTruncated || union.size === 0) return null;
  const unknownKeys = by.filter((f) => !union.has(f));
  if (unknownKeys.length === 0) return null;
  return (
    `by 字段 ${unknownKeys.map((k) => JSON.stringify(k)).join("、")} 不在数据字段列表中（可能拼写有误）。` +
    `数据实际字段：${[...union].join("、")}`
  );
}

// ==================== 点分路径解析（project 专用） ====================

/** 点分路径的形态上限（避免模型构造畸形/超深路径） */
const PROJECT_PATH_MAX_CHARS = 200;
const PROJECT_PATH_MAX_SEGMENTS = 12;

/**
 * 规范化点分路径 → 段列表。
 *
 * 规范化规则（确定性，错误即时报）：
 *   - 整体 trim 后再切段（首尾空白不参与键匹配）；
 *   - 空段（连续点 / 首尾点）显式拒绝而不是静默折叠，避免 "a..b" 被
 *     悄悄当作 "a.b"；
 *   - 层级数与总长度有上限。
 */
export function normalizeProjectPath(
  path: unknown,
): { ok: true; segments: string[] } | { ok: false; reason: string } {
  if (typeof path !== "string") {
    return {
      ok: false,
      reason: 'path 必须是字符串（点分路径，如 "data.items"）',
    };
  }
  const normalized = path.trim();
  if (!normalized || normalized.length > PROJECT_PATH_MAX_CHARS) {
    return {
      ok: false,
      reason: `path 必须是非空字符串（点分路径，如 "data.items"，≤${PROJECT_PATH_MAX_CHARS} 字符）`,
    };
  }
  const segments = normalized.split(".");
  if (segments.some((s) => s.length === 0)) {
    return {
      ok: false,
      reason:
        'path 含空段（连续点或首尾点）——请给出完整点分路径，如 "data.items"',
    };
  }
  if (segments.length > PROJECT_PATH_MAX_SEGMENTS) {
    return {
      ok: false,
      reason: `path 层级数需在 1-${PROJECT_PATH_MAX_SEGMENTS} 之间（点分段数）`,
    };
  }
  return { ok: true, segments };
}

/**
 * 按段列表解析点分路径。
 *
 * 数组层的段必须是纯数字下标（拒绝 "1e0" / " 1" 等会被 Number 静默
 * 接受的写法）；对象层的段不存在时回显该层可用键，便于模型自助修正。
 */
export function resolvePathSegments(
  root: unknown,
  segments: readonly string[],
): { ok: true; value: unknown } | { ok: false; reason: string } {
  let current: unknown = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const at = segments.slice(0, i + 1).join(".");
    if (Array.isArray(current)) {
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
        const more = allKeys.length > 30 ? "…" : "";
        return {
          ok: false,
          reason: `路径 "${at}" 不存在——该层可用字段：${keys.join("、")}${more}`,
        };
      }
      current = current[seg];
    } else {
      return {
        ok: false,
        reason: `路径 "${at}" 无法继续：上一层是 ${current === null ? "null" : typeof current}（非对象/数组）`,
      };
    }
  }
  return { ok: true, value: current };
}

/**
 * 把子记录的字段收进输出行。
 *
 * flatten=false：字段原样保留（嵌套对象整体作为一个值）。
 * flatten=true ：嵌套对象展开为点号列（`meta.author`），数组保持原样
 *                （数组不是列——xlsx 会以紧凑 JSON 文本写入单元格）。
 *
 * `prefix` 是当前递归层已累积的列名前缀：顶层为空，嵌套层为
 * `父键.子键`——点号列必须保留完整来源路径，否则同名字段会互相覆盖。
 */
function collectChildColumns(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  flatten: boolean,
  prefix = "",
): void {
  for (const [key, value] of Object.entries(source)) {
    const columnName = prefix ? `${prefix}.${key}` : key;
    if (flatten && isPlainObject(value)) {
      collectChildColumns(value, target, true, columnName);
      continue;
    }
    target[columnName] = value;
  }
}

export interface ProjectRowsOptions {
  /** 点分路径：指向对象或对象数组；缺省 = 记录本身 */
  path?: string;
  /** 父级字段的点分路径列表：解析结果按来源路径命名为列附在每行上 */
  carry?: string[];
  /** 是否把行内嵌套对象展开为点号列（默认 false：嵌套值原样保留） */
  flatten?: boolean;
}

export interface ProjectRowsResult {
  rows: Record<string, unknown>[];
  /** 逐行解析中路径无值的行数（结果全空时随错误回报） */
  missingCount: number;
  /** 被跳过的非对象元素计数 */
  nonObjectCount: number;
  firstFailureReason: string | null;
}

/**
 * 关系化投影（纯核心）：把复合数据整形为**一张关系表**。
 *
 *   1. **对象 → 单行记录**：路径指向对象时提升为一行记录（字段即列）；
 *   2. **子数组 → 多行 + 父键携带**：路径指向数组时每个元素成为一行；
 *      carry 列出的父级路径按**来源路径**命名为列附在每行上（外键）；
 *   3. **嵌套对象 → 点号列**：flatten 把行内嵌套对象展开为 `a.b` 形式列。
 *
 * 列命名规则（确定性，无隐式约定）：子记录字段按其原名；携带的父级字段
 * 按来源路径命名（如 `base.listSku`），与子字段冲突时显式报错绝不覆盖。
 *
 * 源行归一：records 源逐行解析（各行同构，允许个别行缺字段）；
 * 单对象源视为唯一一行。源数据非破坏——投影产出新行。
 */
export function projectRows(
  sourceValue: unknown,
  options: ProjectRowsOptions,
): { ok: true; result: ProjectRowsResult } | { ok: false; reason: string } {
  // ── 源行归一：records 逐行；单对象视为唯一一行 ──
  const sourceRows: Record<string, unknown>[] = [];
  if (Array.isArray(sourceValue)) {
    for (let index = 0; index < sourceValue.length; index++) {
      const row = sourceValue[index];
      if (!isPlainObject(row)) {
        return {
          ok: false,
          reason:
            `第 ${index} 行不是对象——project 只支持对象数组或单对象数据` +
            `（当前形态：${analyzeValue(sourceValue).kind}）`,
        };
      }
      sourceRows.push(row);
    }
  } else if (isPlainObject(sourceValue)) {
    sourceRows.push(sourceValue);
  } else {
    return {
      ok: false,
      reason:
        `不是可投影的数据（形态：${analyzeValue(sourceValue).kind}）——` +
        "project 需要对象数组或单对象数据",
    };
  }

  // ── 参数规范化 ──
  let pathSegments: string[] | undefined;
  if (options.path !== undefined && options.path !== null) {
    const normalized = normalizeProjectPath(options.path);
    if (!normalized.ok) return { ok: false, reason: normalized.reason };
    pathSegments = normalized.segments;
  }

  const carrySegments: string[][] = [];
  if (options.carry !== undefined && options.carry !== null) {
    if (
      !Array.isArray(options.carry) ||
      !options.carry.every((p) => typeof p === "string")
    ) {
      return {
        ok: false,
        reason: "carry 必须是字符串数组（父级字段的点分路径列表）",
      };
    }
    for (const raw of options.carry) {
      const normalized = normalizeProjectPath(raw);
      if (!normalized.ok) {
        return {
          ok: false,
          reason: `carry 路径 "${raw}" 非法：${normalized.reason}`,
        };
      }
      carrySegments.push(normalized.segments);
    }
  }
  const flatten = options.flatten === true;

  // ── 逐行投影 ──
  const outputRows: Record<string, unknown>[] = [];
  let firstFailureReason: string | null = null;
  let missingCount = 0;
  let nonObjectCount = 0;

  for (const sourceRow of sourceRows) {
    // 子记录来源：路径缺省 = 源行本身；否则按路径解析
    let childSource: unknown = sourceRow;
    if (pathSegments) {
      const resolved = resolvePathSegments(sourceRow, pathSegments);
      if (!resolved.ok) {
        // 逐行解析允许个别行缺字段：记录首个原因，结果全空时再回报
        if (!firstFailureReason) firstFailureReason = resolved.reason;
        missingCount++;
        continue;
      }
      childSource = resolved.value;
    }

    const children: Record<string, unknown>[] = [];
    if (Array.isArray(childSource)) {
      for (const element of childSource) {
        if (isPlainObject(element)) children.push(element);
        else nonObjectCount++;
      }
    } else if (isPlainObject(childSource)) {
      children.push(childSource);
    } else if (childSource === undefined || childSource === null) {
      missingCount++;
      continue;
    } else {
      // 标量目标：路径指到了非对象值——明确报错（与「路径不存在」区分）
      return {
        ok: false,
        reason:
          `路径 "${options.path}" 指向的是 ${childSource === null ? "null" : typeof childSource}` +
          "——project 的路径须指向对象或对象数组",
      };
    }

    for (const child of children) {
      const row: Record<string, unknown> = {};
      collectChildColumns(child, row, flatten);

      // 父键携带：解析结果按来源路径命名为列（保留可追溯性）
      for (const segments of carrySegments) {
        const resolved = resolvePathSegments(sourceRow, segments);
        // 父级字段缺失：该列留空（父级可有可无，行内缺失是常态）
        if (!resolved.ok) continue;
        const columnName = segments.join(".");
        const value = resolved.value;
        if (isPlainObject(value) && flatten) {
          const nested: Record<string, unknown> = {};
          collectChildColumns(value, nested, true);
          for (const [key, nestedValue] of Object.entries(nested)) {
            const fullName = `${columnName}.${key}`;
            if (fullName in row) {
              return {
                ok: false,
                reason:
                  `列名冲突：携带字段 "${fullName}" 与子记录字段同名——` +
                  "请调整 carry 路径或改用 flatten=false",
              };
            }
            row[fullName] = nestedValue;
          }
        } else {
          if (columnName in row) {
            return {
              ok: false,
              reason:
                `列名冲突：携带字段 "${columnName}" 与子记录字段同名——` +
                "请调整 carry 路径使其与子字段不同名",
            };
          }
          row[columnName] = value;
        }
      }
      outputRows.push(row);
    }
  }

  return {
    ok: true,
    result: {
      rows: outputRows,
      missingCount,
      nonObjectCount,
      firstFailureReason,
    },
  };
}

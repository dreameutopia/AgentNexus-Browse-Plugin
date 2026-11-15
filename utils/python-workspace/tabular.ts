/**
 * 表格文本编解码（CSV）
 *
 * 数据通道的统一真相源：browser_extract_data 落盘与 readWorkspaceDataFile
 * 读取共用同一套规则，保证「工具写出的 CSV」一定能被数据文件通道读回。
 *
 * 约定：
 * - 编码遵循 RFC 4180：含逗号、双引号、CR/LF 的单元格用双引号包裹，内部
 *   双引号双写；换行统一为 \n（跨平台可读，Excel/Numbers/pandas 均可解析）。
 * - 解码容忍真实世界的脏数据：UTF-8 BOM、CRLF/CR/LF 混用、引号内的换行、
 *   末尾空行、空表头；不做类型推断（一律字符串，交由消费方决定）。
 * - 嵌套对象/数组单元格按 JSON 文本写入，保证信息不丢失且可反解。
 */

/** 解析后的表格形态：表头 + 数据行（行列等长由解码保证） */
export interface CsvTable {
  headers: string[];
  rows: string[][];
}

/** 单元格 → 文本（null/undefined 为空串；对象/数组保留 JSON 结构） */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 单元格是否需要引号包裹 */
// eslint-disable-next-line no-control-regex -- 控制字符必须包裹，避免破坏行结构
const NEEDS_QUOTE = /[",\r\n\t\u0000-\u001F]/;

/**
 * 序列化为 CSV 文本。
 *
 * @param headers 表头（空数组 = 无表头，纯矩阵）
 * @param rows    数据行；行长度不做强制补齐（缺列按空单元格写出，多列原样保留）
 */
export function serializeCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  const line = (values: readonly string[]): string =>
    values
      .map((value) => (NEEDS_QUOTE.test(value) ? `"${value.replace(/"/g, '""')}"` : value))
      .join(",");
  const lines: string[] = [];
  if (headers.length) lines.push(line(headers.map(cellText)));
  for (const row of rows) lines.push(line(Array.from(row, cellText)));
  return lines.length ? lines.join("\n") + "\n" : '';
}

/**
 * 解析 CSV 文本（RFC 4180 + 常见脏数据容忍）。
 *
 * 返回的表头去重：空表头命名为「列N」，重名追加 (2)、(3)…——下游按对象
 * 键消费时不会静默丢列。
 */
export function parseCsv(text: string): CsvTable {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      // 仅字段起始处的引号进入引号态：兼容 `a"b` 这类未转义脏数据
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      records.push(record);
      record = [];
    } else {
      field += char;
    }
  }
  // 收尾：文件末尾缺换行时仍要收下最后一条记录
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }

  // 末尾空行（含仅空白）不构成数据行
  while (records.length && records[records.length - 1].every((cell) => cell.trim() === ''))
    records.pop();
  if (!records.length) return { headers: [], rows: [] };

  const used = new Map<string, number>();
  const uniqueName = (raw: string, index: number): string => {
    const base = raw.trim() || `列${index + 1}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}(${seen + 1})`;
  };

  const headers = records[0].map((raw, index) => uniqueName(raw, index));
  // 数据行比表头宽时补列：直接截断会静默丢数据（用户手写/外部导出的 CSV 常见）
  const width = records.reduce((max, cells) => Math.max(max, cells.length), 0);
  for (let index = headers.length; index < width; index++)
    headers.push(uniqueName('', index));
  const rows = records.slice(1).map((cells) => {
    const row = cells.slice();
    while (row.length < width) row.push('');
    return row;
  });
  return { headers, rows };
}

/** CSV 表 → 对象行数组（数据文件通道的标准形态） */
export function csvToRecords(table: CsvTable): Record<string, string>[] {
  return table.rows.map((cells) => {
    const record: Record<string, string> = {};
    table.headers.forEach((header, index) => {
      record[header] = cells[index] ?? '';
    });
    return record;
  });
}

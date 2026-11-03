function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\n|\r/g, '<br>');
}

function serializeCellValue(value: unknown): string {
  if (value === undefined) {
    return '';
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractColumns(rows: unknown[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();

  rows.forEach((row) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      Object.keys(row as Record<string, unknown>).forEach((key) => {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      });
    }
  });

  return columns;
}

/**
 * 将 JSON 结果数组按原始数据完整映射为 Markdown 表格
 * - 顶层数组的每个元素对应一行
 * - 顶层对象的每个字段对应一列
 * - 嵌套对象/数组以 JSON 字符串完整保留
 */
export function resultsToMarkdownTable(results: unknown[]): string {
  if (!Array.isArray(results) || results.length === 0) {
    return '| results |\n| --- |\n| [] |';
  }

  const columns = extractColumns(results);

  if (columns.length === 0) {
    const rows = results
      .map((item) => `| ${escapeMarkdownCell(serializeCellValue(item))} |`)
      .join('\n');
    return `| value |\n| --- |\n${rows}`;
  }

  const header = `| ${columns.map(escapeMarkdownCell).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = results
    .map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        const rowValue = escapeMarkdownCell(serializeCellValue(row));
        const emptyColumns = columns.slice(1).map(() => '').join(' | ');
        return `| ${rowValue}${emptyColumns ? ` | ${emptyColumns}` : ''} |`;
      }

      const record = row as Record<string, unknown>;
      const cells = columns.map((column) => escapeMarkdownCell(serializeCellValue(record[column])));
      return `| ${cells.join(' | ')} |`;
    })
    .join('\n');

  return `${header}\n${divider}\n${body}`;
}
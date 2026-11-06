/**
 * xlsx 创建工具
 *
 * 单一工具覆盖 Excel 文件生成的完整操作面，通过 action 区分：
 *   - create                ：声明式创建（多表/合并单元格/公式/富文本/超链接/样式/冻结/筛选）
 *   - create_from_markdown  ：把 Markdown 表格文本（支持多表）转换为 xlsx
 *
 * 产物路径：生成 → 存入扩展文件库（chrome.storage，fileId 索引）→（可选）自动下载。
 * 返回结果携带 [file:ID|文件名] 标记，渲染端据此展示可下载的文件卡片。
 *
 * 错误约定：所有参数/构建错误以精准原因（含参数路径）封装为失败 ToolResult 返回，
 * 绝不向上抛出中断对话流程。
 */

import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { fileManager } from '@/utils/file-manager';
import { arrayBufferToBase64 } from '@/utils/shared/base64';
import { getDataRef, MAX_FIELDS as DATA_REF_MAX_FIELDS } from '@/utils/data-ref-store';
import { buildWorkbook, XlsxBuildError, XLSX_LIMITS } from './xlsx-builder';
import { parseMarkdownTables } from './xlsx-markdown';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Service Worker 环境下 data: URL 自动下载的体积守卫 */
const DATA_URL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 文件名合法化：
 * - 剔除文件系统/下载非法字符（含 [ ]，避免破坏 [file:ID|文件名] 标记解析）与全部控制字符；
 * - 换行/制表符折叠为空格；Windows 不允许结尾点号，去尾点；
 * - 强制 .xlsx 后缀；基名长度 ≤ 96（含后缀 ≤ 102）。
 * 返回 name 与可选 note（入参类型异常时的降级说明）。
 */
function sanitizeFilename(raw: unknown): { name: string; note?: string } {
  const fallback = `导出_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`;
  if (raw === undefined || raw === null || raw === '') return { name: fallback };
  if (typeof raw !== 'string') {
    return { name: fallback, note: `filename 需为字符串（实际收到 ${Array.isArray(raw) ? '数组' : typeof raw}），已使用默认名 ${fallback}` };
  }

  let name = raw
    .trim()
    // 控制字符（0x00-0x1F、0x7F）与文件名非法字符整体剔除；换行/制表折叠为空格
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex -- 刻意匹配控制字符以清理文件名
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/:*?"<>|[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, ''); // Windows 结尾点号
  if (!name || name === '.xlsx') return { name: fallback };
  if (!/\.xlsx$/i.test(name)) name = `${name}.xlsx`;
  // 基名（去掉 .xlsx 后）截断到 96 字符
  const base = name.replace(/\.xlsx$/i, '');
  if (base.length > 96) name = `${base.slice(0, 96)}.xlsx`;
  return { name };
}

const STYLE_SCHEMA = {
  type: 'object',
  description: '单元格/区域样式',
  properties: {
    bold: { type: 'boolean', description: '加粗' },
    italic: { type: 'boolean', description: '斜体' },
    underline: { type: 'boolean', description: '下划线' },
    strike: { type: 'boolean', description: '删除线' },
    fontSize: { type: 'number', description: '字号 1-100' },
    fontName: { type: 'string', description: '字体名，如 "微软雅黑"' },
    fontColor: { type: 'string', description: '文字颜色：#RGB/#RRGGBB 或颜色名' },
    fillColor: { type: 'string', description: '背景颜色：#RGB/#RRGGBB 或颜色名' },
    hAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '水平对齐' },
    vAlign: { type: 'string', enum: ['top', 'middle', 'bottom'], description: '垂直对齐' },
    wrap: { type: 'boolean', description: '自动换行' },
    border: {
      description: '边框：统一线型字符串，或按边对象',
      oneOf: [
        { type: 'string', enum: ['none', 'hair', 'thin', 'medium', 'thick', 'double', 'dashed', 'dotted', 'dashDot', 'dashDotDot', 'slantDashDot'] },
        {
          type: 'object',
          properties: {
            top: { type: 'string' },
            bottom: { type: 'string' },
            left: { type: 'string' },
            right: { type: 'string' },
            color: { type: 'string', description: '边框颜色' },
          },
        },
      ],
    },
    borderColor: { type: 'string', description: '边框颜色（border 为字符串线型时使用）' },
    numFmt: { type: 'string', description: "数字/日期格式，如 '0.00%'、'yyyy-mm-dd'、'#,##0'" },
  },
};

const CELL_SCHEMA = {
  description: '单元格：直接值（string/number/boolean），或对象声明（值形态 v/value、formula、richText、link、date 六选一，可附 style/numFmt）',
  oneOf: [
    { type: ['string', 'number', 'boolean', 'null'] },
    {
      type: 'object',
      properties: {
        v: { description: '纯值（string/number/boolean）' },
        value: { description: 'v 的别名' },
        formula: { type: 'string', description: "Excel 公式，如 'SUM(A1:A10)'（等号可省略）" },
        richText: {
          type: 'array',
          description: '富文本片段',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              bold: { type: 'boolean' },
              italic: { type: 'boolean' },
              color: { type: 'string' },
              size: { type: 'number' },
            },
            required: ['text'],
          },
        },
        link: { type: 'string', description: '超链接 URL（http/https/mailto）；可与 v 搭配，v 作为链接显示文字' },
        date: { type: 'string', description: "日期字符串，如 '2026-10-30'" },
        numFmt: { type: 'string' },
        style: STYLE_SCHEMA,
      },
    },
  ],
};

const SHEET_SCHEMA = {
  type: 'object',
  description: '工作表声明',
  properties: {
    name: { type: 'string', description: '工作表名（≤31 字符，不含 : \\ / ? * [ ]）' },
    title: { type: 'string', description: '大标题：置于表格上方，跨全部列合并居中加粗' },
    headers: { type: 'array', description: '表头行（默认蓝底白字加粗、冻结表头）', items: CELL_SCHEMA },
    firstRowAsHeader: { type: 'boolean', description: '无 headers 时是否把 rows 第一行当表头美化（默认 false）' },
    rows: { type: 'array', description: `数据行二维数组（每行 ≤ ${XLSX_LIMITS.maxColumnsPerSheet} 列，共 ≤ ${XLSX_LIMITS.maxRowsPerSheet} 行）`, items: { type: 'array', items: CELL_SCHEMA } },
    cells: {
      type: 'array',
      description: '精确单元格放置（ref 如 "B3"），与 rows 叠加使用（后写覆盖）',
      items: { type: 'object', properties: { ref: { type: 'string', description: "单元格引用，如 'B3'" } }, required: ['ref'] },
    },
    merges: { type: 'array', description: "合并区域，如 ['A1:C1','B2:B5']（区域内只允许左上角有数据）", items: { type: 'string' } },
    columns: {
      type: 'array',
      description: '按列序号（从 1 起）的列定义：width/numFmt/style（作用该列数据格）',
      items: {
        type: 'object',
        properties: {
          width: { type: 'number', description: '显式列宽（缺省自动列宽）' },
          numFmt: { type: 'string' },
          style: STYLE_SCHEMA,
        },
      },
    },
    colWidths: {
      type: 'object',
      description: '列宽策略（默认自动列宽）',
      properties: {
        auto: { type: 'boolean' },
        minWidth: { type: 'number' },
        maxWidth: { type: 'number' },
      },
    },
    rowHeights: { type: 'object', description: '行高，如 {"1": 30}（行号从 1 起）' },
    freeze: { description: "冻结窗格引用（如 'A2' 冻结第 1 行）；有 headers 时默认冻结表头，传 false 关闭", oneOf: [{ type: 'string' }, { type: 'boolean', enum: [false] }] },
    autoFilter: { type: 'boolean', description: '表头自动筛选（默认 false）' },
    zebra: { type: 'boolean', description: '数据行斑马纹底色（默认 false）' },
    tabColor: { type: 'string', description: '工作表标签颜色' },
    landscape: { type: 'boolean', description: '横向打印适配' },
  },
  required: ['name'],
};

/**
 * create_from_data 的工作表声明：数据来自暂存批次（dataRef），无需手写 rows。
 * 样式/结构选项与 SHEET_SCHEMA 保持一致，仅把 rows/cells 换成 dataRef + 列映射。
 */
const DATA_SHEET_SCHEMA = {
  type: 'object',
  description: '数据表声明：dataRef 引用的暂存批次直接生成工作表（无需手写 rows，数据零转录）',
  properties: {
    name: SHEET_SCHEMA.properties.name,
    title: SHEET_SCHEMA.properties.title,
    dataRef: {
      type: 'string',
      description: '数据批次 ID（browser_page_exec 抓取产生：saveResult 默认开启即暂存，或结果超 2000 字符自动暂存；data_ref_tool(action="list") 可查，分页批次先 merge）。浏览器会话内约 12 小时有效',
    },
    fields: {
      type: 'array',
      description: '对象数组数据：按此字段列表取值，并决定导出列的顺序与数量（缺省取数据全部字段；不在此列表中的字段不导出；字段名拼写错误会被校验拒绝）',
      items: { type: 'string' },
    },
    headers: {
      ...SHEET_SCHEMA.properties.headers,
      description: '表头行（缺省：对象数组用 fields 作表头并自动美化；二维数组默认无表头，可配 firstRowAsHeader 把首行当表头）',
    },
    firstRowAsHeader: SHEET_SCHEMA.properties.firstRowAsHeader,
    merges: SHEET_SCHEMA.properties.merges,
    columns: SHEET_SCHEMA.properties.columns,
    colWidths: SHEET_SCHEMA.properties.colWidths,
    rowHeights: SHEET_SCHEMA.properties.rowHeights,
    freeze: SHEET_SCHEMA.properties.freeze,
    autoFilter: SHEET_SCHEMA.properties.autoFilter,
    zebra: SHEET_SCHEMA.properties.zebra,
    tabColor: SHEET_SCHEMA.properties.tabColor,
    landscape: SHEET_SCHEMA.properties.landscape,
  },
  required: ['name', 'dataRef'],
};

/** 是否为普通对象（非数组） */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 任意抓取值 → xlsx 可接受的纯值（超长文本截断、结构化值紧凑 JSON 化） */
function toXlsxCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  const maxLen = XLSX_LIMITS.maxCellTextLength;
  if (typeof value === 'string') {
    return value.length > maxLen ? `${value.slice(0, maxLen - 12)}…[已截断]` : value;
  }
  try {
    const text = JSON.stringify(value);
    const json = typeof text === 'string' ? text : String(value);
    return json.length > maxLen ? `${json.slice(0, maxLen - 12)}…[已截断]` : json;
  } catch {
    return '[无法序列化的值]';
  }
}

/**
 * create_from_data：把暂存批次（dataRef）转换为 buildWorkbook 可用的工作表声明。
 * 对象数组 → 按 fields（或全部字段）逐行取值；二维数组 → 行内值规范化后直传。
 * 所有结构性错误以带参数路径的 XlsxBuildError 抛出，由 execute 统一转为失败结果；
 * 数据质量提示（嵌套对象降级、全空列）以 warnings 返回，不阻断导出。
 */
async function buildSheetsFromDataRefs(
  rawSheets: unknown
): Promise<{ sheets: unknown[]; warnings: string[] }> {
  if (!Array.isArray(rawSheets) || rawSheets.length === 0) {
    throw new XlsxBuildError(
      'sheets: create_from_data 需要 sheets 数组（每项含 name 与 dataRef），或单表简写 sheet 对象',
    );
  }

  const sheets: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  let roughTotalCells = 0;

  for (let i = 0; i < rawSheets.length; i++) {
    const path = `sheets[${i}]`;
    const raw = rawSheets[i];
    if (!isPlainRecord(raw)) {
      throw new XlsxBuildError(`${path}: 工作表必须是对象，实际收到 ${Array.isArray(raw) ? '数组' : typeof raw}`);
    }
    const spec = raw as Record<string, unknown>;
    if (spec.rows !== undefined || spec.cells !== undefined) {
      throw new XlsxBuildError(
        `${path}: create_from_data 不接受 rows/cells——数据来自 dataRef 批次；若需手写数据请改用 action="create"`,
      );
    }
    const refId = spec.dataRef;
    if (typeof refId !== 'string' || !refId.trim()) {
      throw new XlsxBuildError(`${path}.dataRef: 必须是数据批次 ID（browser_page_exec 抓取产生：saveResult 默认开启，或结果超 2000 字符自动暂存）`);
    }

    const entry = await getDataRef(refId.trim());
    if (!entry) {
      throw new XlsxBuildError(
        `${path}.dataRef: 引用 "${refId}" 不存在或已过期（暂存区数据仅在浏览器会话内有效）——请重新抓取后再导出`,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(entry.json);
    } catch {
      throw new XlsxBuildError(`${path}.dataRef: 批次 "${refId}" 数据已损坏，无法解析`);
    }
    if (!Array.isArray(value)) {
      throw new XlsxBuildError(`${path}.dataRef: 批次 "${refId}" 不是表格形态数据（kind=${entry.kind}），无法生成工作表`);
    }
    if (entry.kind === 'value') {
      throw new XlsxBuildError(
        `${path}.dataRef: 批次 "${refId}" 不是对象数组或二维数组——请在抓取脚本中返回表格形态的数据`,
      );
    }

    // 样式/结构选项透传给 buildWorkbook（dataRef/fields 是本层参数，剔除后再传）
    const { dataRef: _dataRef, fields: _fields, ...styleProps } = spec;

    let rows: unknown[][];
    let headers: unknown[] | undefined;

    if (entry.kind === 'records') {
      let keys: string[];
      if (spec.fields !== undefined) {
        if (!Array.isArray(spec.fields) || !spec.fields.every(k => typeof k === 'string')) {
          throw new XlsxBuildError(`${path}.fields: 必须是字符串数组（对象数据的字段名列表）`);
        }
        keys = spec.fields as string[];
        // 字段名硬校验：与批次存储时算好的字段并集比对，typo 直接报错而不是静默产出空列。
        // 并集在存储层截断到 MAX_FIELDS（超出部分不在列表内）——此时跳过校验避免误伤合法字段。
        const known = entry.fields ?? [];
        if (known.length > 0 && known.length < DATA_REF_MAX_FIELDS) {
          const unknownKeys = keys.filter(k => !known.includes(k));
          if (unknownKeys.length > 0) {
            throw new XlsxBuildError(
              `${path}.fields: 字段 ${unknownKeys.map(k => JSON.stringify(k)).join('、')} 不在批次字段列表中（可能拼写有误）。` +
                `批次实际字段：${known.join('、')}（data_ref_tool(action="info", ref="${refId.trim()}") 可复核）`,
            );
          }
        }
      } else {
        keys = entry.fields ?? [];
      }
      if (keys.length === 0) {
        throw new XlsxBuildError(`${path}: 数据没有可导出的字段`);
      }
      if (keys.length > XLSX_LIMITS.maxColumnsPerSheet) {
        throw new XlsxBuildError(
          `${path}.fields: 字段数 ${keys.length} 超过单表列上限 ${XLSX_LIMITS.maxColumnsPerSheet}——请用 fields 只选需要的列`,
        );
      }
      // 逐行取值时同步做数据质量侦测：嵌套结构降级计数、全空列计数
      let nestedCount = 0;
      const definedHits = new Map<string, number>();
      rows = (value as unknown[]).map(record => {
        const plain = isPlainRecord(record);
        return keys.map(key => {
          const cellValue = plain ? record[key] : undefined;
          if (cellValue !== undefined && cellValue !== null) {
            definedHits.set(key, (definedHits.get(key) ?? 0) + 1);
            if (typeof cellValue === 'object') nestedCount++;
          }
          return toXlsxCell(cellValue);
        });
      });
      if (nestedCount > 0) {
        warnings.push(
          `sheets[${i}]（${spec.name}）：${nestedCount} 个单元格的值是嵌套对象/数组，已按紧凑 JSON 文本写入单元格——如需独立列请在抓取脚本中展平字段后再暂存`,
        );
      }
      const emptyKeys = keys.filter(k => (definedHits.get(k) ?? 0) === 0);
      if (emptyKeys.length > 0 && rows.length > 0) {
        warnings.push(
          `sheets[${i}]（${spec.name}）：字段 ${emptyKeys.join('、')} 在所有行都是空值——若非预期请用 data_ref_tool(action="info") 核对字段名`,
        );
      }
      headers = spec.headers !== undefined ? (spec.headers as unknown[]) : keys;
    } else {
      if (spec.fields !== undefined) {
        throw new XlsxBuildError(`${path}.fields: 仅对象数组数据支持字段筛选（该批次为二维数组）`);
      }
      let nestedCount = 0;
      rows = (value as unknown[]).map(row =>
        Array.isArray(row)
          ? row.map(v => {
              if (typeof v === 'object' && v !== null) nestedCount++;
              return toXlsxCell(v);
            })
          : [toXlsxCell(row)],
      );
      if (nestedCount > 0) {
        warnings.push(
          `sheets[${i}]（${spec.name}）：${nestedCount} 个单元格的值是嵌套对象/数组，已按紧凑 JSON 文本写入单元格`,
        );
      }
      headers = spec.headers !== undefined ? (spec.headers as unknown[]) : undefined;
    }

    if (rows.length > XLSX_LIMITS.maxRowsPerSheet) {
      throw new XlsxBuildError(
        `${path}: 批次 "${refId}" 有 ${rows.length} 行，超过单表上限 ${XLSX_LIMITS.maxRowsPerSheet} 行——请分批导出（分多个工作表或多个文件）`,
      );
    }
    roughTotalCells += rows.length * (headers?.length ?? (rows[0]?.length || 0));

    sheets.push({
      ...styleProps,
      name: spec.name,
      ...(headers !== undefined ? { headers } : {}),
      rows,
    });
  }

  if (roughTotalCells > XLSX_LIMITS.maxTotalCells) {
    throw new XlsxBuildError(
      `预计总单元格数约 ${roughTotalCells} 超过上限 ${XLSX_LIMITS.maxTotalCells}——请减少导出列（fields 精简）或拆分为多个文件`,
    );
  }
  return { sheets, warnings };
}

export class XlsxTool extends BaseTool {
  name = 'xlsx_tool';

  metadata: ToolMetadata = {
    name: 'xlsx_tool',
    description: '生成 Excel (.xlsx) 文件：多工作表、合并单元格、公式、富文本、超链接、样式美化、自动列宽、批量抓取数据直接导出，并把文件保存为可下载产物',
    category: 'office',
    version: '1.0.0',
    author: 'AgentNexus',
    displayName: 'Excel 文件生成',
    tags: ['xlsx', 'excel', 'office', 'file', 'export'],
    permissions: ['downloads', 'storage'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'xlsx_tool',
      description:
        '生成 Excel (.xlsx) 文件并保存为可下载产物。action=create 用声明式结构一次生成完整工作簿（多表/合并单元格/公式/富文本/超链接/冻结表头/自动筛选/样式）；' +
        'action=create_from_markdown 把 Markdown 表格文本（支持多表，标题作表名）转为 xlsx；' +
        'action=create_from_data 把批量抓取的暂存数据（browser_page_exec 产生的 dataRef：saveResult 默认开启即暂存，或结果超 2000 字符自动暂存）直接生成工作表——数据零转录，' +
        '适合电商 SKU、评论、榜单等大批量场景，务必用它替代手写 rows。' +
        '默认自动美化：表头蓝底白字加粗、全表细边框、自动列宽、冻结表头。生成成功后按结果中的【输出指引】在回复里插入文件标记。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'create_from_markdown', 'create_from_data'], description: '操作类型' },
          filename: { type: 'string', description: '文件名（无需 .xlsx 后缀也会自动补全）' },
          autoDownload: { type: 'boolean', description: '生成后是否同时下载到浏览器下载目录（默认 false；文件始终保存到扩展文件库供下载）' },
          sheets: { type: 'array', description: `工作表声明列表（create/create_from_data 必填，1-${XLSX_LIMITS.maxSheets} 张；create 用 rows 手写数据，create_from_data 用 dataRef 引用暂存批次）`, items: SHEET_SCHEMA },
          sheet: { ...SHEET_SCHEMA, description: '单表简写：只有一张表时可直接给 sheet 对象（与 sheets 二选一）' },
          markdown: { type: 'string', description: 'create_from_markdown 必填：含 Markdown 表格的文本（| 分隔；多张表用标题行 # 分隔并命名）' },
          defaultSheetName: { type: 'string', description: 'create_from_markdown：单表默认工作表名' },
        },
        required: ['action'],
      },
    },
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    try {
      // ── 入参形态守卫 ──
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return this.createErrorResponse(
          `参数必须是 JSON 对象，实际收到 ${params === null ? 'null' : Array.isArray(params) ? '数组' : typeof params}`,
        );
      }

      const { action } = params;
      if (action !== 'create' && action !== 'create_from_markdown' && action !== 'create_from_data') {
        return this.createErrorResponse(
          `action 必须是 'create'、'create_from_markdown' 或 'create_from_data'，实际收到 ${JSON.stringify(action ?? null)}`,
        );
      }

      // ── 标量选项严格校验（类型错误直接报精准原因，杜绝静默忽略） ──
      if (params.autoDownload !== undefined && typeof params.autoDownload !== 'boolean') {
        return this.createErrorResponse(
          `autoDownload 必须是布尔值，实际收到 ${JSON.stringify(params.autoDownload) ?? String(params.autoDownload)}`,
        );
      }
      if (
        params.defaultSheetName !== undefined &&
        params.defaultSheetName !== null &&
        typeof params.defaultSheetName !== 'string'
      ) {
        return this.createErrorResponse(
          `defaultSheetName 必须是字符串，实际收到 ${JSON.stringify(params.defaultSheetName) ?? String(params.defaultSheetName)}`,
        );
      }

      // ── 组装工作表声明 ──
      const dataWarnings: string[] = [];
      let sheetsSpec: unknown;
      if (action === 'create' || action === 'create_from_data') {
        if (params.sheets !== undefined && params.sheet !== undefined) {
          return this.createErrorResponse(`sheets 与 sheet 只能提供一个（多表用 sheets 数组，单表用 sheet 对象）`);
        }
        if (params.sheets === undefined && params.sheet === undefined) {
          return this.createErrorResponse(`缺少工作表数据：请提供 sheets 数组（多表），或单表简写 sheet 对象`);
        }
        sheetsSpec = params.sheets !== undefined ? params.sheets : [params.sheet];
        if (action === 'create_from_data') {
          // dataRef → 行数据：从暂存区解析批次并转换（错误带参数路径，由 catch 统一转失败结果；
          // 数据质量提示以 warnings 透传给模型）
          const built = await buildSheetsFromDataRefs(sheetsSpec);
          sheetsSpec = built.sheets;
          dataWarnings.push(...built.warnings);
        }
        // 结构合法性由 buildWorkbook 逐项校验（报错带参数路径）
      } else {
        sheetsSpec = parseMarkdownTables({
          markdown: params.markdown,
          path: 'markdown',
          defaultSheetName:
            typeof params.defaultSheetName === 'string' ? params.defaultSheetName : undefined,
        });
      }

      // ── 构建 xlsx ──
      const { name: filename, note } = sanitizeFilename(params.filename);
      const startedAt = Date.now();
      const { buffer, sheets: sheetSummaries, totalCells } = await buildWorkbook(sheetsSpec);
      const sizeBytes = buffer.byteLength;
      this.log(`工作簿构建完成：${sheetSummaries.length} 表 / ${totalCells} 格 / ${(sizeBytes / 1024).toFixed(1)}KB / ${Date.now() - startedAt}ms`);

      // ── 存入扩展文件库（渲染端文件卡片按 fileId 下载） ──
      let fileId: string;
      try {
        fileId = await fileManager.addFile(filename, buffer, XLSX_MIME, {
          kind: 'xlsx',
          sheetNames: sheetSummaries.map(s => s.name),
          totalCells,
          tool: this.name,
        });
      } catch (storageError) {
        // 存储层失败（配额/序列化）单独归因：文件已生成但无法交付，指向可行动的清理路径
        const reason = storageError instanceof Error ? storageError.message : String(storageError);
        return this.createErrorResponse(
          `文件已生成但保存到扩展文件库失败（${reason}）——可在设置的文件管理中清理空间后重试`,
        );
      }

      // ── 可选自动下载 ──
      const warnings: string[] = [...dataWarnings];
      if (note) warnings.push(note);
      let autoDownloaded = false;
      if (params.autoDownload === true) {
        const downloadResult = await this.tryAutoDownload(filename, buffer);
        autoDownloaded = downloadResult.ok;
        if (downloadResult.warning) warnings.push(downloadResult.warning);
      }

      // ── 成功结果（含给模型的输出指引） ──
      const marker = `[file:${fileId}|${filename}]`;
      const sizeLabel = sizeBytes >= 1024 * 1024
        ? `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`
        : `${(sizeBytes / 1024).toFixed(1)} KB`;
      const sheetLines = sheetSummaries
        .map(s => `  - ${s.name}：${s.rowCount} 行 × ${s.columnCount} 列${s.mergeCount > 0 ? `，${s.mergeCount} 处合并` : ''}${s.frozen ? '，冻结表头' : ''}`)
        .join('\n');

      // 直接构造 ToolResult（不经 createSuccessResponse 的 JSON 再序列化）：
      // content[0].text 保持纯文本给模型阅读，data 供渲染端/程序化消费，二者不重复
      return {
        success: true,
        isError: false,
        content: [
          {
            type: 'text',
            text:
              `✅ Excel 文件生成成功\n\n` +
              `- 文件名：${filename}（${sizeLabel}，文件ID ${fileId}）\n` +
              `- 工作表：\n${sheetLines}\n` +
              (autoDownloaded ? `- 已自动下载到浏览器下载目录\n` : '') +
              (warnings.length > 0 ? `- 提示：${warnings.join('；')}\n` : '') +
              `\n【输出指引】在最终回复中必须原样插入下面这行标记（单独成行，不要放进代码块或引用块，不要改动任何字符），界面会把它渲染为可下载的文件卡片：\n${marker}`,
          },
        ],
        data: {
          message: 'Excel 文件生成成功',
          file: { fileId, name: filename, sizeBytes, mime: XLSX_MIME, kind: 'xlsx', marker },
          sheets: sheetSummaries,
          autoDownloaded,
          warnings,
        },
      };
    } catch (error) {
      // 精准错误路径：XlsxBuildError 的 message 已含「参数路径 + 实际值 + 期望」
      if (error instanceof XlsxBuildError) {
        this.log(`参数校验/构建失败：${error.message}`, 'warn');
        return this.createErrorResponse(`参数不合法 → ${error.message}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      this.log(`执行失败：${message}`, 'error');
      return this.createErrorResponse(`生成失败 → ${message}`);
    }
  }

  /**
   * 自动下载：
   * - DOM 上下文（sidepanel）：blob URL + chrome.downloads
   * - Service Worker（无 DOM、无 URL.createObjectURL）：data: URL（8MB 守卫，超限降级为仅入库）
   */
  private async tryAutoDownload(filename: string, buffer: ArrayBuffer): Promise<{ ok: boolean; warning?: string }> {
    try {
      if (typeof document !== 'undefined') {
        const url = URL.createObjectURL(new Blob([buffer], { type: XLSX_MIME }));
        await chrome.downloads.download({ url, filename, saveAs: false });
        // 全局 setTimeout（sidepanel 与 SW 均可用），延迟回收避免下载尚未启动就失效
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return { ok: true };
      }
      if (buffer.byteLength > DATA_URL_MAX_BYTES) {
        return {
          ok: false,
          warning: `文件 ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB 超过后台直下上限 8MB，已保存到扩展文件库（用户仍可从文件卡片下载）`,
        };
      }
      const dataUrl = `data:${XLSX_MIME};base64,${arrayBufferToBase64(buffer)}`;
      await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, warning: `自动下载失败（${message}）；文件已保存到扩展文件库，可从文件卡片下载` };
    }
  }
}

export const xlsxTool = new XlsxTool();

/**
 * exceljs 自包含浏览器构建（dist/exceljs.min.js）的最小类型声明。
 *
 * 说明：
 * - exceljs 的包入口类型（index.d.ts）引用了 Node 的 'stream' 模块，本项目未安装
 *   @types/node，直接引用会破坏 vue-tsc；因此工具统一从自包含的 dist 构建动态
 *   加载（同时避免 lib 入口的 node 依赖被打进扩展包），并在此声明实际用到的 API 面。
 * - 类型仅覆盖 xlsx 工具使用的子集；字段与 exceljs 官方文档语义一致。
 */
declare module 'exceljs/dist/exceljs.min.js' {
  /** 颜色（ARGB 十六进制，如 'FF4472C4'） */
  export interface ExcelJsColor {
    argb?: string;
    rgb?: string;
    theme?: number;
  }

  export interface ExcelJsFont {
    name?: string;
    size?: number;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean | 'single' | 'double';
    strike?: boolean;
    color?: ExcelJsColor;
  }

  export interface ExcelJsBorderEdge {
    style?:
      | 'hair'
      | 'thin'
      | 'medium'
      | 'thick'
      | 'double'
      | 'dashed'
      | 'dotted'
      | 'dashDot'
      | 'dashDotDot'
      | 'slantDashDot';
    color?: ExcelJsColor;
  }

  export interface ExcelJsBorder {
    top?: ExcelJsBorderEdge;
    bottom?: ExcelJsBorderEdge;
    left?: ExcelJsBorderEdge;
    right?: ExcelJsBorderEdge;
  }

  export interface ExcelJsFill {
    type: 'pattern';
    pattern: 'solid';
    fgColor: ExcelJsColor;
    bgColor?: ExcelJsColor;
  }

  export interface ExcelJsAlignment {
    horizontal?: 'left' | 'center' | 'right';
    vertical?: 'top' | 'middle' | 'bottom';
    wrapText?: boolean;
  }

  export interface ExcelJsRichTextRun {
    text: string;
    font?: Partial<ExcelJsFont>;
  }

  export interface ExcelJsCellLinkValue {
    text: string;
    hyperlink: string;
  }

  export interface ExcelJsCellFormulaValue {
    formula: string;
    result?: unknown;
  }

  export interface ExcelJsCellRichTextValue {
    richText: ExcelJsRichTextRun[];
  }

  export type ExcelJsCellValue =
    | null
    | string
    | number
    | boolean
    | Date
    | { text: string; hyperlink: string }
    | { formula: string; result?: unknown }
    | { richText: Array<{ text: string; font?: Partial<ExcelJsFont> }> };

  export interface ExcelJsCell {
    value: ExcelJsCellValue;
    font: Partial<ExcelJsFont>;
    fill: ExcelJsFill;
    border: ExcelJsBorder;
    alignment: ExcelJsAlignment;
    numFmt: string;
  }

  export interface ExcelJsRow {
    height: number;
    font: Partial<ExcelJsFont>;
  }

  /** 行遍历回调中的行（附件解析读取单元格值用） */
  export interface ExcelJsCellRow {
    getCell(col: number): ExcelJsCell;
  }

  export interface ExcelJsColumn {
    width: number;
  }

  export interface ExcelJsWorksheetView {
    state?: 'frozen' | 'frozenSplit' | 'split' | 'normal';
    xSplit?: number;
    ySplit?: number;
  }

  export interface ExcelJsPageSetup {
    orientation?: 'portrait' | 'landscape';
    fitToPage?: boolean;
    fitToWidth?: number;
    fitToHeight?: number;
  }

  export interface ExcelJsAutoFilter {
    from: { row: number; column: number };
    to: { row: number; column: number };
  }

  export interface ExcelJsWorksheet {
    readonly name: string;
    views: ExcelJsWorksheetView[];
    pageSetup: ExcelJsPageSetup;
    autoFilter: ExcelJsAutoFilter | string;
    getCell(row: number, col: number): ExcelJsCell;
    getRow(row: number): ExcelJsRow;
    getColumn(col: number): ExcelJsColumn;
    mergeCells(range: string): void;
    addRow(row: unknown): ExcelJsRow;
    /** 全表最大列数（含稀疏尾部；遍历行时按此宽度对齐输出） */
    readonly columnCount: number;
    /** 全表最大行数 */
    readonly rowCount: number;
    /** 行遍历（includeEmpty=false 跳过全空行） */
    eachRow(
      options: { includeEmpty: boolean },
      onRow: (row: ExcelJsCellRow, rowNumber: number) => void,
    ): void;
  }

  export interface ExcelJsAddWorksheetOptions {
    properties?: {
      tabColor?: ExcelJsColor;
      defaultRowHeight?: number;
    };
    views?: ExcelJsWorksheetView[];
    pageSetup?: ExcelJsPageSetup;
  }

  export interface ExcelJsWorkbook {
    addWorksheet(name: string, options?: ExcelJsAddWorksheetOptions): ExcelJsWorksheet;
    readonly worksheets: ExcelJsWorksheet[];
    xlsx: {
      /** 浏览器构建下返回内部 Buffer（继承 ArrayBuffer），可直接用于 Blob */
      writeBuffer(): Promise<ArrayBuffer>;
      /** 从 zip 二进制载入工作簿（附件解析读取 xlsx 用） */
      load(data: ArrayBuffer): Promise<ExcelJsWorkbook>;
    };
  }

  const ExcelJS: { Workbook: new () => ExcelJsWorkbook };
  export default ExcelJS;
}

/**
 * office 类工具注册
 */

import { toolRegistry } from '../registry';
import { xlsxTool } from './xlsx-tool';

export function registerOfficeTools(): void {
  toolRegistry.register(xlsxTool);
}

export { xlsxTool } from './xlsx-tool';
export { XlsxTool } from './xlsx-tool';
export type {
  XlsxSheetSpec,
  XlsxStyleSpec,
  XlsxCellInput,
  XlsxCellSpec,
  XlsxCellPlacement,
  XlsxColumnSpec,
  XlsxBorderSpec,
  XlsxBorderStyleName,
  XlsxRichTextPart,
  XlsxSheetSummary,
} from './xlsx-builder';
export { XlsxBuildError, XLSX_LIMITS } from './xlsx-builder';
export { parseMarkdownTables } from './xlsx-markdown';

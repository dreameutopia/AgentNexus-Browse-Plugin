/**
 * 笔记导出统一入口（txt / md / docx / pdf）
 *
 * - txt / md：HTML → 文档模型 → 文本渲染（doc-model 解析层保证结构保真）；
 * - docx：docx/html 官方解析器把 HTML 渲染为 Word 原生样式后打包下载；
 * - pdf：浏览器打印管线渲染，打开打印面板（目标「另存为 PDF」）。
 *
 * 所有格式先经 sanitizeFileName 生成合法文件名；返回值携带实际下载的
 * 文件名（pdf 为 null）与 docx 转换降级提示，供调用方给出准确反馈。
 */

import { parseNoteHtml } from './doc-model';
import { docToMarkdown } from './render-markdown';
import { docToPlainText } from './render-text';
import { noteHtmlToDocxBlob } from './render-docx';
import { exportNoteAsPdf } from './render-pdf';
import { downloadBlob, sanitizeFileName } from './download';

export type NoteExportFormat = 'txt' | 'md' | 'docx' | 'pdf';

export interface NoteExportInput {
  /** 笔记标题（用作文件名 / PDF 保存名 / 文档 Title） */
  title: string;
  /** Tiptap 正文 HTML */
  html: string;
  /** PDF 打印页眉下的副信息（如「更新时间 …」） */
  subtitle?: string;
}

export interface NoteExportOutcome {
  /** 实际下载的文件名；PDF 走打印管线，为 null */
  fileName: string | null;
  /** DOCX 转换中被 Word 降级 / 弃用的内容提示（空 = 完整转换） */
  warnings: string[];
}

/** 触发指定格式的导出；失败抛出可读 Error，由调用方提示 */
export async function exportNote(
  format: NoteExportFormat,
  input: NoteExportInput,
): Promise<NoteExportOutcome> {
  const base = sanitizeFileName(input.title);

  switch (format) {
    case 'txt': {
      const text = `${docToPlainText(parseNoteHtml(input.html))}\n`;
      const fileName = `${base}.txt`;
      downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), fileName);
      return { fileName, warnings: [] };
    }
    case 'md': {
      const markdown = `${docToMarkdown(parseNoteHtml(input.html))}\n`;
      const fileName = `${base}.md`;
      downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), fileName);
      return { fileName, warnings: [] };
    }
    case 'docx': {
      const { blob, warnings } = await noteHtmlToDocxBlob(input.title, input.html);
      const fileName = `${base}.docx`;
      downloadBlob(blob, fileName);
      return { fileName, warnings };
    }
    case 'pdf': {
      exportNoteAsPdf({ title: input.title, html: input.html, subtitle: input.subtitle });
      return { fileName: null, warnings: [] };
    }
    default: {
      const exhaustive: never = format;
      throw new Error(`不支持的导出格式: ${String(exhaustive)}`);
    }
  }
}

export { parseNoteHtml } from './doc-model';
export { sanitizeFileName } from './download';

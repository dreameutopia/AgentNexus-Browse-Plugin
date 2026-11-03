/**
 * 笔记 HTML → DOCX（.docx 导出）
 *
 * 解析方案：docx 官方 `docx/html` 模块的 `htmlToContent` —— 完整 HTML5 解析器，
 * 明确面向 TipTap / TinyMCE / CKEditor 等富文本输出，直接把标题、段落、
 * 嵌套列表、引用、代码块、分割线、链接、加粗 / 斜体 / 删除线、base64 图片
 * 解析渲染为 Word 原生样式（Heading 1-6、列表编号、超链接等），
 * 不是把 Markdown 文本原样塞进文档。
 *
 * 排版：`stylesheet` 注入中性排版规则（代码等宽灰底、引用左侧竖线、
 * 分割线），与页面黑白灰风格一致；`onWarning` 汇总被 Word 弃用的
 * 元素（如 WebP 图片）便于排查，解析层从不抛错。
 */

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { htmlToContent } from 'docx/html';

/** 导出文档的中性排版样式（作为「编辑器样式表」追加给 docx/html 解析） */
const NOTE_DOCX_STYLESHEET = `
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
    font-size: 12pt;
    color: #1a1a1a;
    line-height: 1.6;
  }
  h1 { font-size: 22pt; margin-top: 18pt; margin-bottom: 8pt; }
  h2 { font-size: 17pt; margin-top: 14pt; margin-bottom: 6pt; }
  h3 { font-size: 14pt; margin-top: 12pt; margin-bottom: 6pt; }
  h4, h5, h6 { font-size: 12pt; margin-top: 10pt; margin-bottom: 4pt; }
  p { margin-top: 4pt; margin-bottom: 4pt; }
  blockquote {
    margin-left: 24pt;
    padding-left: 12pt;
    border-left: 2pt solid #d4d4d4;
    color: #555555;
  }
  code {
    font-family: "Consolas", "SF Mono", monospace;
    font-size: 10.5pt;
    background-color: #f1f1f1;
  }
  pre {
    font-family: "Consolas", "SF Mono", monospace;
    font-size: 10.5pt;
    background-color: #f4f4f4;
    padding: 8pt;
  }
  pre code { background-color: transparent; }
  hr { border-bottom: 1pt solid #cccccc; }
  a { color: #1a1a1a; text-decoration: underline; }
  img { max-width: 100%; }
`;

export interface DocxExportResult {
  blob: Blob;
  /** 解析过程中被 Word 弃用 / 降级的内容说明（空数组 = 完整转换） */
  warnings: string[];
}

/**
 * 把笔记 HTML 转为 DOCX Blob。
 * @param title 文档标题（作为 Title 样式段落置于文首）
 * @param html  Tiptap 正文 HTML
 */
export async function noteHtmlToDocxBlob(title: string, html: string): Promise<DocxExportResult> {
  const warnings: string[] = [];
  const content = htmlToContent(html || '', {
    stylesheet: NOTE_DOCX_STYLESHEET,
    onWarning: (warning) => {
      warnings.push(warning.message);
      console.warn('[Notes][docx]', warning.code, warning.message);
    },
  });

  const children = [
    ...(title
      ? [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            spacing: { after: 240 },
            children: [new TextRun({ text: title })],
          }),
        ]
      : []),
    ...content,
  ];

  const doc = new Document({
    creator: 'AgentNexus',
    title: title || undefined,
    description: 'AgentNexus 工作笔记导出',
    sections: [{ children }],
  });

  const blob = await Packer.toBlob(doc);
  return { blob, warnings };
}

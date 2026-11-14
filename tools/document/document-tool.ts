/**
 * 文档工具（document_tool）
 *
 * ==================== 职责 ====================
 *
 * 一个工具覆盖「写 Markdown → 出 Word/PDF」这条完整链路，四个 action：
 *
 *   create    创建 .md 文件（工作区内）
 *   edit      编辑 .md 文件（整体重写 / find+replace / 批量 edits）
 *   delete    删除 .md 文件
 *   convert   把已有 .md 渲染为 .docx / .pdf（可同时产出两种）
 *
 * 为什么文件 CRUD 与转换放同一个工具：模型的工作流天然是
 * 「写/改 Markdown → 转成 Word/PDF 交付」，拆成两个工具会让模型多一次
 * 工具选择与参数交接；而 create/edit/delete 与 js_run 的同名 action
 * 语义完全一致（路径/内容/替换/指纹），心智负担低。
 *
 * ==================== 与既有工具的边界 ====================
 *
 * - js_run 已经能创建/编辑/删除**任意**文本文件。本工具的 create/edit/delete
 *   额外约束为 **.md 后缀**（文档源文件），并把「转换」这一动作接在后面，
 *   避免模型为了导出一份报告而先写一段 Python 去调第三方库。
 * - 本工具**不做**数据抓取（那是 js_run/browser_* 的职责），只消费工作区里
 *   已经存在的 Markdown。
 *
 * ==================== 参数契约 ====================
 *
 * - 每个 action 有**独立的参数白名单**：多传参数会得到「action=convert 不接受
 *   参数：xxx」的明确回执，而不是被静默忽略（静默忽略会让模型以为自己设置
 *   生效了，例如误以为改过标题）。
 * - edit 的三种编辑模式与工作区引擎完全一致（content 整体重写 / find+replace
 *   精确替换 / edits 批量替换），互斥，参数定义复用 js_run 的同一份片段。
 * - create/edit/convert 都会回传源文件的 sha256，模型可以把它作为下一次
 *   edit 的 expectedHash，用于并发改动检测。
 *
 * ==================== 错误约定 ====================
 *
 * 所有参数/构建错误以精准原因（含参数路径）封装为失败 ToolResult 返回，
 * 绝不向上抛出中断对话流程（与 xlsx_tool 同款约定）。工作区引擎的错误码
 * 统一映射为 `[DOCUMENT_*]`，便于模型识别可自纠的失败类型。
 */

import { BaseTool } from '../base-tool';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { readWorkspaceOutput, saveWorkspaceOutput } from '@/utils/python-workspace/store';
import { requireWorkspaceChatId, type WorkspaceArtifact } from '@/utils/python-workspace/artifact-contract';
import { downloadWorkspaceArtifact } from '@/utils/python-workspace/artifact-download';
import { WORKSPACE_EDIT_PROPERTIES } from '@/utils/python-workspace/file-action';
import {
  createWorkspaceFile,
  deleteWorkspaceFile,
  editWorkspaceFile,
  readWorkspaceTextFile,
} from '@/utils/python-workspace/workspace-files';
import { errorDetails } from '@/utils/shared/error-details';
import { renderMarkdownToHtml } from './markdown-render';
import { createImageResolver } from './image-resolver';
import { buildDocx } from './docx-builder';
import { buildPdfDocument } from './pdf-document';
import { renderMermaidToSvg } from './mermaid-renderer';
import { requestPdfRender } from './pdf-client';
import type { PdfPaperSize } from './pdf-protocol';

/** 工具名 */
export const DOCUMENT_TOOL_ID = 'document_tool';

/** 支持的 action */
const ACTIONS = ['create', 'edit', 'delete', 'convert'] as const;

/** 支持的导出格式 */
const FORMATS = ['docx', 'pdf'] as const;

/** convert 的格式参数取值（'both' = 同时产出两种） */
const FORMAT_VALUES = ['docx', 'pdf', 'both'] as const;

/** .md 源文件后缀（大小写不敏感） */
const MARKDOWN_SUFFIX = '.md';

/** 读取源 md 的字节上限（与工作区编辑上限一致） */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** 产物文件名基名长度上限 */
const MAX_FILENAME_BASE = 96;

/**
 * 计算 sha256 指纹的体积门槛。
 *
 * 指纹需要整读文件；超过 1MB 的文档不值得为它多读一遍，此时回传 undefined，
 * 模型自然不会拿它当 expectedHash 用。
 */
const HASHABLE_FILE_BYTES = 1024 * 1024;

/**
 * 控制字符正则（文件名合法化用）。
 *
 * 用码点构造，而不是在源码里写转义序列：字面控制字符（NUL、US 等）会让
 * 文件变成二进制，编辑器、补丁工具与代码审查都难以处理。
 */
const CONTROL_CHAR_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`,
  'g',
);

/** 每个 action 的参数白名单（多传即报错，避免静默忽略） */
const ACTION_PARAMS: Record<(typeof ACTIONS)[number], readonly string[]> = {
  create: ['action', 'path', 'content'],
  edit: [
    'action',
    'path',
    'content',
    'find',
    'replace',
    'replaceAll',
    'edits',
    'matchMode',
    'expectedHash',
  ],
  delete: ['action', 'path'],
  convert: [
    'action',
    'path',
    'format',
    'filename',
    'title',
    'headerText',
    'autoDownload',
    'paperSize',
    'pageNumbers',
  ],
};

/**
 * 文件名合法化（产物用）：剔除非法字符、强制目标后缀、限长。
 *
 * 后缀处理必须「先剥后挂」：直接按目标后缀的长度截断会把 `报告.docx` 变成
 * `报告..pdf` 这种畸形名。这里先去掉原有的任何后缀，再统一挂上目标后缀。
 *
 * @param raw 原始文件名（可含后缀）
 * @param extension 目标后缀（含点，如 '.pdf'）
 */
function sanitizeArtifactFilename(raw: unknown, extension: string): { name: string; note?: string } {
  const fallback = `文档_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${extension}`;
  if (raw === undefined || raw === null || raw === '') return { name: fallback };
  if (typeof raw !== 'string') {
    return {
      name: fallback,
      note: `filename 需为字符串（实际收到 ${Array.isArray(raw) ? '数组' : typeof raw}），已使用默认名 ${fallback}`,
    };
  }
  let name = raw
    .trim()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CONTROL_CHAR_PATTERN, '')
    .replace(/[\\/:*?"<>|[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  // 去掉可能存在的原后缀（限长且纯字母数字才算后缀，避免误伤 `2024.05 报告`）
  name = name.replace(/\.[A-Za-z0-9]{1,10}$/, '').trim();
  if (!name) return { name: fallback };
  name = name + extension;
  const base = name.slice(0, name.length - extension.length);
  if (base.length > MAX_FILENAME_BASE) {
    name = `${base.slice(0, MAX_FILENAME_BASE)}${extension}`;
  }
  return { name };
}

/** 校验 .md 路径（create/edit/delete/convert 共用） */
function normalizeMarkdownPath(raw: unknown): { path: string } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'path 必填且需为字符串（工作区相对路径，以 .md 结尾）' };
  }
  const path = raw.trim();
  if (!path.toLowerCase().endsWith(MARKDOWN_SUFFIX)) {
    return {
      error: `path 必须以 ${MARKDOWN_SUFFIX} 结尾（这是 Markdown 源文件工具），收到 ${JSON.stringify(raw)}`,
    };
  }
  return { path };
}

/** 错误结果构造（统一带工具名前缀） */
function fail(message: string): ToolResult {
  return {
    success: false,
    isError: true,
    content: [{ type: 'text', text: `❌ ${message}` }],
  };
}

/**
 * 错误详情归一：把工作区引擎的错误码映射到文档工具命名空间。
 *
 * `[WORKSPACE_FILE_EXISTS]` → `[DOCUMENT_FILE_EXISTS]`，模型据此判断
 * 「换个文件名重试」还是「改用 edit」还是「源文件不存在」。
 */
function documentErrorDetails(error: unknown): string {
  return errorDetails(error).replace(
    /^(?:WorkspaceOperationError: )?\[WORKSPACE_([A-Z_]+)\]/,
    '[DOCUMENT_$1]',
  );
}

export class DocumentTool extends BaseTool {
  name = DOCUMENT_TOOL_ID;

  /**
   * mermaid 渲染器（源码 → SVG 原文）。
   *
   * 缺省用真实渲染（依赖 DOM，见 mermaid-renderer.ts）。这里留一个可注入
   * 的口子：测试环境（JSDOM 无完整 SVG 几何实现）用它验证
   * 「mermaid 围栏 → 矢量图 → DOCX 内嵌」的整条链路，而不必依赖真实渲染。
   */
  mermaidRenderer?: (code: string) => Promise<string | null>;

  metadata: ToolMetadata = {
    name: DOCUMENT_TOOL_ID,
    description:
      'Markdown 文档工具：创建/编辑/删除工作区内的 .md 源文件，并把 .md 渲染为 Word (.docx) 与 PDF。支持标题、多级列表、任务列表、表格、引用块、代码块高亮、GFM 语法、LaTeX 公式（Word 原生公式）、图片（远程/工作区/会话截图）与 Mermaid 图表（矢量嵌入）。',
    category: 'office',
    version: '1.0.0',
    author: 'AgentNexus',
    displayName: 'Markdown 文档',
    tags: ['markdown', 'docx', 'pdf', 'document', 'office', 'export', 'mermaid'],
    permissions: ['downloads', 'storage'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: DOCUMENT_TOOL_ID,
      description:
        'Markdown 文档工具。create 创建 .md 源文件；edit 编辑 .md（content 全量重写 / find+replace 精确定位 / edits 批量替换，三者互斥）；delete 删除 .md；' +
        'convert 把已有 .md 渲染为 Word(.docx) 与/或 PDF 并保存到当前会话工作区 outputs/（可下载）。' +
        '转换支持标题、多级/任务列表、表格、引用块、代码块（带语法高亮）、GFM 语法、LaTeX 公式（Word 中为可编辑原生公式）、' +
        '图片与 Mermaid 图表（渲染为矢量图嵌入）。' +
        '图片写法：远程 URL（https://…）、工作区相对路径（outputs/report.png、inputs/photo.jpg）、' +
        '会话截图短 id（agent-image:xxxxxxxx）、内嵌 data URL。' +
        '典型流程：create 写内容 → edit 精修 → convert 导出；' +
        '产物路径与下载方式同 xlsx_tool。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description:
              'create=创建 .md；edit=编辑 .md；delete=删除 .md；convert=把 .md 渲染为 docx/pdf',
          },
          path: {
            type: 'string',
            description:
              '工作区相对路径，必须以 .md 结尾（如 docs/报告.md）。create 必填；edit/delete/convert 必填。',
          },
          content: {
            type: 'string',
            description: 'create 必填（Markdown 源码全文）；edit 时全量重写（与 find/replace、edits 互斥）。',
          },
          find: {
            type: 'string',
            description: 'edit 精确定位串，默认必须唯一命中；与 replace 成对。',
          },
          replace: {
            type: 'string',
            description: 'edit 替换文本，按字面处理，允许空串。',
          },
          replaceAll: {
            type: 'boolean',
            description: 'edit 是否替换全部命中，默认 false。',
          },
          ...WORKSPACE_EDIT_PROPERTIES,
          format: {
            type: 'string',
            enum: [...FORMAT_VALUES],
            description: 'convert 产物格式：docx=仅 Word；pdf=仅 PDF；both=两种都出（默认 both）。',
          },
          filename: {
            type: 'string',
            description:
              'convert 产物文件名（不含后缀；已有后缀会被替换为目标格式的后缀）。缺省用源 .md 的文件名。',
          },
          title: {
            type: 'string',
            description: 'convert 文档标题（写入 Word 属性与 PDF 标题）；缺省用源文件名。',
          },
          headerText: {
            type: 'string',
            description: 'convert 页眉文本（印在每页顶部，Word 与 PDF 均生效）。',
          },
          autoDownload: {
            type: 'boolean',
            description:
              'convert 生成后是否同时下载到浏览器下载目录（默认 false；文件始终先保存到当前会话工作区 outputs/）。',
          },
          paperSize: {
            type: 'string',
            enum: ['A4', 'Letter'],
            description: 'convert 的 PDF 纸张尺寸（默认 A4）。',
          },
          pageNumbers: {
            type: 'boolean',
            description: 'convert 的 PDF 是否显示页码（默认 true；页脚居中）。',
          },
        },
        required: ['action'],
        anyOf: ACTIONS.map((action) => ({
          properties: { action: { type: 'string', enum: [action] } },
          required:
            action === 'create'
              ? ['action', 'path', 'content']
              : action === 'convert'
                ? ['action', 'path']
                : ['action', 'path'],
        })),
      },
    },
  };

  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    try {
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return fail(
          `参数必须是 JSON 对象，实际收到 ${params === null ? 'null' : Array.isArray(params) ? '数组' : typeof params}`,
        );
      }

      const action = params.action;
      if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
        return fail(
          `action 必须是 ${ACTIONS.map((a) => `"${a}"`).join(' / ')} 之一，实际收到 ${JSON.stringify(action) ?? String(action)}`,
        );
      }

      // 参数白名单：多传参数必须报错，否则模型会以为设置生效了
      const allowed = ACTION_PARAMS[action as (typeof ACTIONS)[number]];
      const unexpected = Object.keys(params).filter((key) => !allowed.includes(key));
      if (unexpected.length) {
        return fail(
          `action="${action}" 不接受参数：${unexpected.join('、')}（该 action 可用参数：${allowed
            .filter((key) => key !== 'action')
            .join('、')}）`,
        );
      }

      if (action === 'create') return await this.runCreate(params, context);
      if (action === 'edit') return await this.runEdit(params, context);
      if (action === 'delete') return await this.runDelete(params, context);
      return await this.runConvert(params, context);
    } catch (error) {
      const message = documentErrorDetails(error);
      this.log(`执行失败：${message}`, 'error');
      return fail(`执行失败 → ${message}`);
    }
  }

  // ==================== create ====================

  /** action="create"：创建 .md 源文件 */
  private async runCreate(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const normalized = normalizeMarkdownPath(params.path);
    if ('error' in normalized) return fail(normalized.error);
    const content = params.content;
    if (typeof content !== 'string') {
      return fail('content 必填且需为字符串（Markdown 源码）');
    }

    const chatId = requireWorkspaceChatId(context?.chatId);
    const stat = await createWorkspaceFile(chatId, normalized.path, content, context?.signal);
    const sha256 = await this.readFingerprint(chatId, stat.path, stat.bytes);
    return {
      success: true,
      isError: false,
      content: [
        {
          type: 'text',
          text:
            `✅ 已创建 Markdown 文件 ${stat.path}（${stat.bytes} 字节）\n` +
            `下一步：内容定稿后用 ${DOCUMENT_TOOL_ID}(action="convert", path="${stat.path}") 导出 Word/PDF。`,
        },
      ],
      data: { path: stat.path, bytes: stat.bytes, sha256 },
    };
  }

  // ==================== edit ====================

  /** action="edit"：编辑 .md 源文件 */
  private async runEdit(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const normalized = normalizeMarkdownPath(params.path);
    if ('error' in normalized) return fail(normalized.error);

    // 语义与工作区引擎一致：content 全量重写 / find+replace / edits 批量替换，三者互斥
    const hasContent = params.content !== undefined;
    const hasEdits = params.edits !== undefined;
    const hasPair = params.find !== undefined || params.replace !== undefined;
    const modes = Number(hasContent) + Number(hasEdits) + Number(hasPair);
    if (modes === 0) {
      return fail('edit 需要 content（全量重写）、find+replace（精确替换）或 edits（批量替换）之一');
    }
    if (modes > 1) {
      return fail(
        'edit 的 content（全量重写）、find/replace（精确替换）、edits（批量替换）三者互斥，请只提供一种',
      );
    }

    const chatId = requireWorkspaceChatId(context?.chatId);
    const stat = await editWorkspaceFile(chatId, normalized.path, params, context?.signal);
    const replaced = stat.replaced;
    const detail =
      replaced === undefined
        ? '已整体重写'
        : replaced === 1
          ? '唯一命中替换 1 处'
          : `替换 ${replaced} 处`;
    const sha256 = await this.readFingerprint(chatId, stat.path, stat.bytes);
    return {
      success: true,
      isError: false,
      content: [
        {
          type: 'text',
          text: `✅ 已编辑 Markdown 文件 ${stat.path}（${stat.bytes} 字节，${detail}）`,
        },
      ],
      data: { path: stat.path, bytes: stat.bytes, replaced, sha256 },
    };
  }

  // ==================== delete ====================

  /** action="delete"：删除 .md 源文件 */
  private async runDelete(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const normalized = normalizeMarkdownPath(params.path);
    if ('error' in normalized) return fail(normalized.error);

    const chatId = requireWorkspaceChatId(context?.chatId);
    const stat = await deleteWorkspaceFile(chatId, normalized.path, context?.signal);
    return {
      success: true,
      isError: false,
      content: [{ type: 'text', text: `✅ 已删除 Markdown 文件 ${stat.path}` }],
      data: { path: stat.path },
    };
  }

  // ==================== convert ====================

  /** action="convert"：把 .md 渲染为 Word / PDF */
  private async runConvert(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const normalized = normalizeMarkdownPath(params.path);
    if ('error' in normalized) return fail(normalized.error);

    // 1. 格式参数
    const formatRaw = params.format ?? 'both';
    if (typeof formatRaw !== 'string' || !(FORMAT_VALUES as readonly string[]).includes(formatRaw)) {
      return fail(
        `format 必须是 ${FORMAT_VALUES.map((f) => `"${f}"`).join(' / ')} 之一，实际收到 ${JSON.stringify(formatRaw)}`,
      );
    }
    const wantDocx = formatRaw === 'docx' || formatRaw === 'both';
    const wantPdf = formatRaw === 'pdf' || formatRaw === 'both';

    // 2. 纸张与页码（PDF 专属；Word 固定 A4 纵向）
    const paperSize: PdfPaperSize = params.paperSize === 'Letter' ? 'Letter' : 'A4';
    const pageNumbers = params.pageNumbers !== false;

    const chatId = requireWorkspaceChatId(context?.chatId);

    // 3. 读取源文件
    const source = await readWorkspaceTextFile(chatId, normalized.path, context?.signal, MAX_SOURCE_BYTES);
    if (!source.content.trim()) {
      return fail(`源文件为空：${source.path}——没有内容可转换`);
    }

    // 4. 渲染 Markdown → HTML（公式/图片/图表统一在这里处理）
    const images = createImageResolver({ chatId, signal: context?.signal });
    const rendered = await renderMarkdownToHtml(source.content, {
      images,
      // mermaid 渲染器可注入：默认用真实渲染（需要 DOM），测试与
      // 「无图表能力」的环境可换成任意实现，链路不变。
      renderMermaid: this.mermaidRenderer ?? renderMermaidToSvg,
    });
    context?.signal?.throwIfAborted();

    // 5. 标题：参数优先，其次源文件名
    const titleParam =
      typeof params.title === 'string' && params.title.trim() ? params.title.trim() : undefined;
    const baseName = source.path.slice(source.path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    const title = titleParam ?? baseName;

    const warnings = rendered.warnings.map((w) => `${w.subject}：${w.reason}`);
    const artifacts: WorkspaceArtifact[] = [];
    const files: WorkspaceArtifact[] = [];
    const summary: string[] = [];

    // 6. 产物文件名
    const docxName = sanitizeArtifactFilename(params.filename ?? baseName, '.docx');
    const pdfName = sanitizeArtifactFilename(params.filename ?? baseName, '.pdf');
    if (wantDocx && docxName.note) warnings.push(docxName.note);
    if (wantPdf && pdfName.note) warnings.push(pdfName.note);

    const headerText = typeof params.headerText === 'string' ? params.headerText : undefined;

    // 7. DOCX
    if (wantDocx) {
      const docx = await buildDocx(rendered.html, {
        title,
        headerText,
        // 矢量图表必须注入：docx/html 绝不联网，地址不在 images 表里就只剩 alt 文本
        vectorImages: rendered.vectorImages,
      });
      for (const message of docx.warnings) warnings.push(`Word 降级：${message}`);
      const file = await saveWorkspaceOutput(chatId, `outputs/${docxName.name}`, docx.blob, context?.signal);
      artifacts.push(file);
      files.push(file);
      summary.push(`Word（.docx）：${file.name}（${formatBytes(docx.blob.size)}）`);
    }

    // 8. PDF
    if (wantPdf) {
      const document = buildPdfDocument(rendered.html, {
        title,
        paperSize,
        vectorImages: rendered.vectorImages,
      });
      const result = await requestPdfRender({
        html: document,
        paperSize,
        headerText,
        pageNumbers,
      });
      if (!result.ok) {
        // PDF 失败不回滚已成功的 Word：产物独立交付，失败原因如实回传
        const message = `PDF 渲染失败 → ${result.error}`;
        if (wantDocx) {
          warnings.push(message);
        } else {
          return fail(message);
        }
      } else {
        const bytes = base64ToBytes(result.base64 ?? '');
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
        const file = await saveWorkspaceOutput(chatId, `outputs/${pdfName.name}`, blob, context?.signal);
        artifacts.push(file);
        files.push(file);
        summary.push(`PDF（.pdf）：${file.name}（${formatBytes(blob.size)}）`);
      }
    }

    if (!artifacts.length) {
      return fail('未产出任何文件（请检查 format 参数与源文件内容）');
    }

    // 9. 可选自动下载
    let autoDownloaded = false;
    if (params.autoDownload === true) {
      try {
        for (const file of artifacts) {
          const blob = await readWorkspaceOutput(chatId, file.path);
          if (!blob) continue;
          await downloadWorkspaceArtifact(file, blob);
        }
        autoDownloaded = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`工作区文件已保存，自动下载未发起：${message}`);
      }
    }

    return {
      success: true,
      isError: false,
      content: [
        {
          type: 'text',
          text:
            `✅ 文档生成成功\n` +
            `- 源文件：${source.path}\n` +
            `- 产物：\n${summary.map((line) => `  - ${line}`).join('\n')}\n` +
            (autoDownloaded ? '- 已发起浏览器下载\n' : '') +
            (warnings.length ? `- 提示：\n${warnings.map((line) => `  - ${line}`).join('\n')}\n` : '') +
            `\n已保存的文件：\n${artifacts.map((file) => file.marker).join('\n')}`,
        },
      ],
      data: {
        message: '文档生成成功',
        source: source.path,
        sha256: source.sha256,
        files,
        artifacts,
        autoDownloaded,
        warnings,
      },
    };
  }

  /**
   * 读取源文件指纹（sha256）。
   *
   * 指纹让模型能在下一次 edit 时用 expectedHash 检测并发改动。
   * 文件过大时不读（整读一次的成本不划算），返回 undefined。
   */
  private async readFingerprint(
    chatId: string,
    path: string,
    bytes: number,
  ): Promise<string | undefined> {
    if (bytes > HASHABLE_FILE_BYTES) return undefined;
    try {
      const snapshot = await readWorkspaceTextFile(chatId, path, undefined, MAX_SOURCE_BYTES);
      return snapshot.sha256;
    } catch {
      // 指纹只是附加信息，取不到不影响主流程
      return undefined;
    }
  }
}

/** base64 → 字节 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 字节数格式化 */
function formatBytes(size: number): string {
  return size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(2)} MB`
    : `${(size / 1024).toFixed(1)} KB`;
}

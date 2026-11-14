/**
 * HTML → DOCX 构建器
 *
 * ==================== 设计要点 ====================
 *
 * 1. **复用官方 htmlToContent**：docx@9.15.1 的 `docx/html` 模块是完整 HTML5
 *    解析器（parse5），直接把 HTML 映射为 Word 原生结构——标题 1-6、段落、
 *    嵌套列表（含任务列表复选框）、GFM 表格（合并单元格/表头重复/宽度/边框/
 *    背景/对齐）、图片、超链接（锚点转书签、危险协议只留文字）、代码块
 *    （保留空格、等宽字体）、KaTeX 的 MathML → **Word 原生可编辑公式**、
 *    脚注、删除线、修订标记。
 *    这与父仓库「flexmark AST → Apache POI」的路线等价，但省掉整套 POI 映射。
 * 2. **绝不联网**：docx/html 不下载任何图片。因此图片必须在渲染期就内联成
 *    data URL（见 markdown-render.ts 的图片解析器）——否则只会得到 missing-image
 *    警告与空图。矢量图通过 images 选项注入（地址 → SVG + PNG 兜底）。
 * 3. **样式注入**：通过 stylesheet 选项注入中性黑白排版规则（代码等宽灰底、
 *    引用左侧竖线、表格边框、分割线），与仓库既有黑白灰风格一致。
 * 4. **降级可见**：onWarning 汇总 missing-image / unsupported-image /
 *    invalid-math / unsafe-link 等降级项，随产物回传给用户，绝不静默丢内容。
 * 5. **页眉页脚**：页脚带「第 N 页」，页眉可选（对应父仓库 PdfRenderer 的
 *    页眉页脚能力）。
 *
 * ==================== 分包说明 ====================
 *
 * `docx` 与 `docx/html` 合计约 1.5MB，静态 import 会把它们打进
 * background 主包（该包已 3.8MB），白白拖慢扩展启动。因此这里一律
 * **动态 import**：Vite 会把它们拆成独立 chunk，只在真正导出 Word 时
 * 按需下载与解析。
 */

import type { VectorImage } from './markdown-render';
import { svgToPngDataUrl } from './svg-raster';

/**
 * docx/html 的图片条目形状（与 HtmlImage 等价，但用本地类型声明避免
 * 静态 import docx/html —— 那会把 528KB 的模块打进主包）。
 */
type HtmlImageShape = {
  readonly data: Uint8Array;
  readonly fallback?: Uint8Array;
};

/** docx 包的动态加载器（同一 chunk 内复用，避免重复 import 往返） */
type DocxModule = typeof import('docx');
type DocxHtmlModule = typeof import('docx/html');
/** section 的形状：直接取 docx 导出的类型（type-only，不产生运行时依赖） */
type DocxSectionOptions = import('docx').ISectionOptions;

let docxModulePromise: Promise<DocxModule> | null = null;
let docxHtmlModulePromise: Promise<DocxHtmlModule> | null = null;

/** 加载 docx 主模块（Document/Packer 等） */
async function loadDocx(): Promise<DocxModule> {
  if (!docxModulePromise) {
    docxModulePromise = import('docx').catch((error) => {
      docxModulePromise = null;
      throw error;
    });
  }
  return docxModulePromise;
}

/** 加载 docx/html 模块（htmlToContent） */
async function loadDocxHtml(): Promise<DocxHtmlModule> {
  if (!docxHtmlModulePromise) {
    docxHtmlModulePromise = import('docx/html').catch((error) => {
      docxHtmlModulePromise = null;
      throw error;
    });
  }
  return docxHtmlModulePromise;
}

/** DOCX 产物构建结果 */
export interface DocxBuildResult {
  /** 打包好的 .docx 二进制 */
  blob: Blob;
  /** 内容降级说明（空数组 = 完整转换） */
  warnings: string[];
}

/** 构建选项 */
export interface DocxBuildOptions {
  /** 文档标题（作为 Title 样式段落置于文首，并写入文档属性） */
  title?: string;
  /** 页眉文本（空则不加页眉） */
  headerText?: string;
  /** 页边距（英寸）；缺省 1 英寸 */
  marginInches?: number;
  /** 矢量图表：占位地址 → SVG + PNG 兜底 */
  vectorImages?: Map<string, VectorImage>;
}

/** 文档中性排版样式（注入 docx/html 的 stylesheet 选项） */
const DOCX_STYLESHEET = `
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
    font-size: 11pt;
    color: #1a1a1a;
    line-height: 1.6;
  }
  h1 { font-size: 20pt; margin-top: 16pt; margin-bottom: 8pt; }
  h2 { font-size: 16pt; margin-top: 13pt; margin-bottom: 6pt; }
  h3 { font-size: 13.5pt; margin-top: 11pt; margin-bottom: 5pt; }
  h4, h5, h6 { font-size: 12pt; margin-top: 10pt; margin-bottom: 4pt; }
  p { margin-top: 4pt; margin-bottom: 4pt; }
  ul, ol { margin-top: 4pt; margin-bottom: 6pt; }
  li { margin-top: 2pt; margin-bottom: 2pt; }
  blockquote {
    margin-left: 20pt;
    padding-left: 10pt;
    border-left: 2pt solid #d4d4d4;
    color: #555555;
  }
  code {
    font-family: "Consolas", "SF Mono", monospace;
    font-size: 10pt;
    background-color: #f1f1f1;
  }
  pre {
    font-family: "Consolas", "SF Mono", monospace;
    font-size: 10pt;
    background-color: #f4f4f4;
    padding: 8pt;
  }
  pre code { background-color: transparent; }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 10.5pt;
  }
  th {
    background-color: #f1f1f1;
    font-weight: bold;
    border: 0.5pt solid #cccccc;
    padding: 4pt 6pt;
  }
  td {
    border: 0.5pt solid #cccccc;
    padding: 4pt 6pt;
  }
  hr { border-bottom: 1pt solid #cccccc; }
  a { color: #1a1a1a; text-decoration: underline; }
  img { max-width: 100%; }
  .md-image-fallback { color: #777777; font-style: italic; }
  .md-math-display { text-align: center; }
  .md-math-fallback {
    font-family: "Consolas", "SF Mono", monospace;
    color: #555555;
    background-color: #f4f4f4;
  }
`;

/**
 * 把渲染好的 HTML 打包为 .docx。
 *
 * @param html  正文 HTML（由 markdown-render.ts 产出）
 * @param options 标题/页眉/页边距/矢量图等
 */
export async function buildDocx(
  html: string,
  options: DocxBuildOptions = {},
): Promise<DocxBuildResult> {
  const warnings: string[] = [];

  // 动态加载 docx 与 docx/html（约 1.5MB，独立 chunk 按需加载）
  const [{ Document, Footer, Header, HeadingLevel, PageNumber, Packer, Paragraph, TextRun }, { htmlToContent }] =
    await Promise.all([loadDocx(), loadDocxHtml()]);

  // 矢量图注入：docx/html 的 images 选项按地址取图；SVG 需配 PNG 兜底
  // （旧版 Word 与 Apple Pages 只认 PNG，没有兜底的 SVG 会显示为空白）。
  // 类型直接用 docx 的 HtmlImage：其 HtmlImageData 允许 Uint8Array，
  // 避免与 TS 5.7 收紧后的 Uint8Array<ArrayBuffer> 泛型不兼容。
  const images: Record<string, HtmlImageShape> = {};
  for (const [address, vector] of options.vectorImages ?? new Map()) {
    const svgBytes = new TextEncoder().encode(vector.svg);
    const pngBytes = vector.pngDataUrl ? dataUrlToBytes(vector.pngDataUrl) : null;
    if (pngBytes) {
      images[address] = { data: svgBytes, fallback: pngBytes };
      continue;
    }
    // 没有 PNG 兜底：就地补一份（无 DOM 时补不上，保持无兜底）
    const generated = await svgToPngDataUrl(vector.svg).catch(() => null);
    const generatedBytes = generated ? dataUrlToBytes(generated) : null;
    images[address] = generatedBytes
      ? { data: svgBytes, fallback: generatedBytes }
      : { data: svgBytes };
  }

  let content: import('docx').FileChild[];
  try {
    content = htmlToContent(html, {
      stylesheet: DOCX_STYLESHEET,
      ...(Object.keys(images).length ? { images } : {}),
      onWarning: (warning) => {
        warnings.push(warning.message);
      },
    });
  } catch (error) {
    // docx/html 承诺「对任何 HTML 都不抛错」，但样式表/图片表是本模块拼装的，
    // 万一仍有异常，这里给出可定位的上下文而不是裸栈。
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Word 内容转换失败：${message}`);
  }

  // docx 的 section children 需要 FileChild；htmlToContent 产出的
  // Paragraph|Table 与标题段落都满足该约束。
  const children: import('docx').FileChild[] = [];

  // 文档标题（Title 样式）置于文首
  const title = options.title?.trim();
  if (title) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        spacing: { after: 240 },
        children: [new TextRun({ text: title })],
      }),
    );
  }

  // 逐个 push 而不是 children.push(...content)：长文档的段落数可能上万，
  // 展开成函数参数会撞上引擎的参数个数上限（RangeError）。
  for (const child of content) children.push(child);

  const marginTwips = Math.round(normalizeMargin(options.marginInches) * 1440);

  // 页眉（可选）
  const headerText = options.headerText?.trim();
  const headers = headerText
    ? {
        default: new Header({
          children: [
            new Paragraph({
              alignment: 'right',
              children: [new TextRun({ text: headerText, size: 18, color: '777777' })],
            }),
          ],
        }),
      }
    : undefined;

  // 页脚页码（与父仓库 PdfRenderer 的页脚一致）
  const footers = {
    default: new Footer({
      children: [
        new Paragraph({
          alignment: 'center',
          children: [
            new TextRun({ text: '第 ', size: 18, color: '777777' }),
            new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '777777' }),
            new TextRun({ text: ' 页', size: 18, color: '777777' }),
          ],
        }),
      ],
    }),
  };

  const section: DocxSectionOptions = {
    properties: {
      page: {
        margin: {
          top: marginTwips,
          right: marginTwips,
          bottom: marginTwips,
          left: marginTwips,
        },
      },
    },
    ...(headers ? { headers } : {}),
    footers,
    children,
  };

  const doc = new Document({
    creator: 'AgentNexus',
    title: title || undefined,
    description: 'AgentNexus Markdown 文档导出',
    sections: [section],
  });

  const blob = await Packer.toBlob(doc);
  return { blob, warnings };
}

/**
 * 归一化页边距（英寸）：只接受有限正数，收敛到 [0.4, 2] 英寸。
 * 负数/NaN 会让 Word 拿到非法页面设置，0 则内容顶到纸边。
 */
function normalizeMargin(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(2, Math.max(0.4, value));
}

/** data URL → 字节 */
function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  try {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

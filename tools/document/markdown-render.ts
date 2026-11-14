/**
 * Markdown → HTML 渲染核心（DOCX 与 PDF 双管线共用）
 *
 * ==================== 设计要点 ====================
 *
 * 1. **单一事实源**：DOCX 与 PDF 两条产物管线共用本模块产出的同一份 HTML，
 *    保证「Word 看到的」与「PDF 看到的」内容完全一致（父仓库的
 *    MarkdownToDocxConverter / MarkdownToPdfConverter 也是共用同一 AST 的思路）。
 * 2. **Markdown 语法覆盖**：对齐父仓库 flexmark 解析器的覆盖面——
 *    标题 1-6、段落、粗体/斜体/删除线/行内代码、有序/无序/任务列表、
 *    嵌套列表、引用块、分割线、表格（GFM）、围栏代码块、链接、图片、
 *    自动链接、脚注、硬换行。表格与代码块是父仓库 DOCX/PDF 两条链路都
 *    单独处理过的重点，这里同样交给 markdown-it 的 table/fence 规则。
 * 3. **公式**：KaTeX 输出 **MathML**（output:'mathml'）。这一份产物同时满足
 *    两个下游：DOCX 侧由 docx/html 的 MathML 分支转成 Word 原生可编辑公式；
 *    PDF 侧由 Chrome 内建的 MathML Core 排版（无需任何外部字体与 CSS，
 *    因此不打包字体、也不受 KaTeX 字体文件缺失影响）。
 * 4. **图片**：三种来源统一在渲染期解析——
 *    远程 URL（http/https，fetch 后转 data URL）、工作区既有文件
 *    （outputs/、inputs/ 下的图片，经工作区快照读取）、data URL 直嵌。
 *    DOCX 侧 docx/html 绝不联网，必须拿到 data URL 才有图；PDF 侧浏览器
 *    可直取远程图，但统一转 data URL 可保证两份产物一致且离线可用。
 *    矢量图（mermaid 产出、远程 SVG）额外保留 SVG 原文：PDF 内联为矢量，
 *    DOCX 以 SVG + PNG 兜底嵌入（旧版 Word 只认 PNG）。
 * 5. **安全**：markdown-it 关闭 html:true（原始 HTML 一律转义），避免
 *    模型输出的任意标签注入渲染链；链接协议白名单化，javascript: 等危险
 *    协议降级为纯文本。
 * 6. **健壮**：任何单块内容（公式/图片/代码高亮）失败都不中断整篇渲染，
 *    而是降级为等价的可读文本并记录到 warnings，由调用方透传给用户。
 *
 * ==================== 与父仓库的对应关系 ====================
 *
 *   父仓库（Java，flexmark + POI + PDFBox）      本模块（TS，markdown-it + docx）
 *   ─────────────────────────────────────────      ──────────────────────────────────
 *   MarkdownToDocxConverter（flexmark AST→POI）      markdown-it → HTML → docx/html
 *   MarkdownToPdfConverter（flexmark AST→Block）     markdown-it → HTML → CDP 打印管线
 *   DocxWriterUtil（表格/代码/引用/超链接样式）        本模块的 DOCX_STYLESHEET
 *   PdfRenderer（页眉页脚/目录/分页控制）              CDP Page.printToPDF 的 @page 与页边距
 */

/** 单块降级说明（拼接后随产物一起回传，便于模型自纠） */
export interface RenderWarning {
  /** 出问题的内容特征（如「第 3 张图片」「第 2 个公式」） */
  subject: string;
  /** 降级原因 */
  reason: string;
}

/** 矢量图产物：SVG 原文 + PNG 兜底（旧版 Word 只认 PNG） */
export interface VectorImage {
  /** SVG 原文 */
  svg: string;
  /** PNG 兜底（data URL） */
  pngDataUrl?: string;
}

/** 解析出的图片：栅格图走 dataUrl，矢量图走 svg + png 兜底 */
export interface ResolvedImage {
  /** 栅格图（PNG/JPEG/GIF…）的 data URL */
  dataUrl?: string;
  /** 矢量图（SVG）原文 */
  svg?: string;
  /** 矢量图的 PNG 兜底（供旧版 Word 渲染） */
  pngDataUrl?: string;
  /** 图片地址（用于生成稳定占位键） */
  src: string;
}

/** 图片来源解析器：由调用方注入具体取图能力（工作区/远程/矢量） */
export interface ImageResolver {
  /**
   * 把图片地址解析为可内联的形态。
   * @param src 图片地址（可能是 http(s)/data/工作区路径/agent-image 短 id）
   * @returns 解析结果；无法解析时返回 null（调用方降级为 alt 文本）
   */
  resolve(src: string): Promise<ResolvedImage | null>;
}

/** 渲染选项 */
export interface MarkdownRenderOptions {
  /** 图片解析器；缺省时所有图片降级为 alt 文本 */
  images?: ImageResolver;
  /** 是否渲染公式（缺省 true） */
  math?: boolean;
  /** 是否对代码块做语法高亮（缺省 true） */
  highlight?: boolean;
  /** Mermaid 渲染器：源码 → SVG（缺省则 mermaid 围栏降级为代码块） */
  renderMermaid?: (code: string) => Promise<string | null>;
}

// ==================== 依赖（懒加载，避免拖慢工具注册） ====================

/**
 * markdown-it 实例类型。
 * 该包用 `export =` 声明（无 ESM 类型导出），`import()` 取不到类型，
 * 因此顶层 `import type` 是唯一可行写法（与仓库 file-card.ts 同款）。
 */
import type MarkdownIt from 'markdown-it';
// 栅格化工具（矢量图 PNG 兜底）：自身零依赖，不会把重量级模块拖进包体
import { svgToPngDataUrl } from './svg-raster';

/** markdown-it 构造器类型 */
type MarkdownItConstructorType = typeof import('markdown-it') extends { default: infer C } ? C : never;

/** KaTeX 模块类型 */
type KatexModule = typeof import('katex')['default'];
/** highlight.js 实例类型（common 子集导出 HLJSApi） */
type HljsModule = typeof import('highlight.js/lib/common')['default'];

let markdownItPromise: Promise<MarkdownItConstructorType> | null = null;
let katexPromise: Promise<KatexModule> | null = null;
let hljsPromise: Promise<HljsModule> | null = null;

/**
 * 加载 markdown-it 构造器。
 * 初始化失败不缓存 rejection：下次调用自动重试（瞬时 chunk 加载失败不应永久卡死）。
 */
async function loadMarkdownIt(): Promise<MarkdownItConstructorType> {
  if (!markdownItPromise) {
    const pending = (async () => {
      const mod = await import('markdown-it');
      return mod.default;
    })();
    markdownItPromise = pending;
    pending.catch(() => {
      if (markdownItPromise === pending) markdownItPromise = null;
    });
  }
  return markdownItPromise;
}

/** 加载 KaTeX（公式渲染） */
async function loadKatex(): Promise<KatexModule> {
  if (!katexPromise) {
    const pending = (async () => {
      const mod = await import('katex');
      return mod.default;
    })();
    katexPromise = pending;
    pending.catch(() => {
      if (katexPromise === pending) katexPromise = null;
    });
  }
  return katexPromise;
}

/** 加载 highlight.js（代码高亮；只取常用语言子集，控制体积） */
async function loadHljs(): Promise<HljsModule> {
  if (!hljsPromise) {
    const pending = (async () => {
      const mod = await import('highlight.js/lib/common');
      return mod.default;
    })();
    hljsPromise = pending;
    pending.catch(() => {
      if (hljsPromise === pending) hljsPromise = null;
    });
  }
  return hljsPromise;
}

// ==================== 危险协议与链接白名单 ====================

/** 允许的链接协议；其余（javascript:/data:/vbscript:…）降级为纯文本 */
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** 允许的图片协议；data: 单独放行（内联图片是合法用法） */
const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:', 'data:']);

/**
 * 判定链接协议是否安全（相对地址视为安全）。
 *
 * 协议相对地址（//host/path）虽然不带协议，却是**跨源绝对地址**——放进 PDF
 * 会触发对外请求、放进 Word 会留下外链，因此一律判为不安全。
 */
export function isSafeLinkProtocol(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  // 协议相对地址：等价于 //host/path 的绝对地址
  if (trimmed.startsWith('//')) return false;
  // 相对地址与锚点：同文档跳转，安全
  if (trimmed.startsWith('#') || trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('/')) {
    return true;
  }
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!match) return true; // 无协议的裸地址（如 www.example.com）
  return SAFE_LINK_PROTOCOLS.has(match[1].toLowerCase() + ':');
}

/**
 * 判定图片协议是否安全。
 *
 * 协议相对地址同样拒绝：它会指向外部主机，而工作区路径绝不会以 // 开头。
 */
export function isSafeImageProtocol(src: string): boolean {
  const trimmed = src.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('//')) return false;
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!match) return true; // 相对地址（工作区路径）交给解析器判定
  return SAFE_IMAGE_PROTOCOLS.has(match[1].toLowerCase() + ':');
}

// ==================== 基础工具 ====================

/** HTML 文本转义 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 正则元字符转义 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 截断文本（错误信息用，避免撑爆提示词） */
function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

// ==================== 公式渲染 ====================

/**
 * 渲染公式为 KaTeX MathML。
 * MathML 是两条下游的公共格式：docx/html 读它生成 Word 原生公式，
 * Chrome 内建 MathML Core 直接排版，无需外部字体与样式表。
 * 失败时降级为纯文本公式源码（保留信息，不丢内容）。
 */
function renderFormula(
  katex: KatexModule,
  formula: string,
  displayMode: boolean,
): { html: string; degraded: boolean } {
  try {
    const rendered = katex.renderToString(formula, {
      displayMode,
      throwOnError: false,
      errorColor: '#cc0000',
      strict: false,
      output: 'mathml',
      trust: false,
    });
    if (!rendered || !rendered.includes('<math')) {
      throw new Error('KaTeX 未产出 MathML');
    }
    const html = displayMode
      ? `<div class="md-math md-math-display">${rendered}</div>`
      : `<span class="md-math md-math-inline">${rendered}</span>`;
    return { html, degraded: false };
  } catch {
    const escaped = escapeHtml(formula);
    const wrapper = displayMode
      ? `<div class="md-math md-math-display md-math-fallback">${escaped}</div>`
      : `<span class="md-math md-math-inline md-math-fallback">${escaped}</span>`;
    return { html: wrapper, degraded: true };
  }
}

/** 块级公式定界符 $$ */
const BLOCK_MATH_DELIMITER = '$$';

/**
 * 安装块级公式规则：独占一行的 $$ … $$（可跨行）渲染为块级公式。
 * 规则挂在 paragraph 之前，因此代码围栏内的 $$ 不会被误判（围栏先于段落解析）。
 */
function installBlockMathRule(md: MarkdownIt): void {
  md.block.ruler.before('paragraph', 'anmath_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (state.src.slice(start, max).trim().slice(0, 2) !== BLOCK_MATH_DELIMITER) return false;

    const firstLine = state.src.slice(start, max).trim();
    let content = '';
    let nextLine = startLine;

    if (firstLine.length > 2 && firstLine.endsWith(BLOCK_MATH_DELIMITER)) {
      // 单行块：$$x$$
      content = firstLine.slice(2, -2).trim();
    } else {
      // 跨行块：直到遇到以 $$ 结尾的行
      content = firstLine.slice(2).trim();
      let found = false;
      for (nextLine = startLine + 1; nextLine < endLine; nextLine++) {
        const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const lineMax = state.eMarks[nextLine];
        const line = state.src.slice(lineStart, lineMax).trim();
        if (line.endsWith(BLOCK_MATH_DELIMITER)) {
          content += `\n${line.slice(0, -2).trim()}`;
          found = true;
          break;
        }
        content += `\n${line}`;
      }
      if (!found) return false; // 未闭合：交给普通段落处理
    }

    if (silent) return true;
    if (!content.trim()) return false;

    const token = state.push('anmath_block', 'math', 0);
    token.block = true;
    token.content = content;
    token.markup = BLOCK_MATH_DELIMITER;
    token.map = [startLine, nextLine + 1];
    state.line = nextLine + 1;
    return true;
  });
}

/**
 * 安装行内公式规则：$…$（不跨行）。
 * 挂在 emphasis 之前、backticks 之后：代码片段优先于公式（`` `$x$` `` 是字面量），
 * 公式优先于强调（`$a_b$` 中的下划线不参与强调解析）。
 *
 * 货币误判防护（两头都看）：
 * - 起始 `$` 后不得紧跟数字（`$5` 是金额，不是公式）；
 * - 闭合 `$` 后不得紧跟数字（`$5 与 $10` 的第二个 `$` 不是公式结尾）；
 * 这样 `价格 $5 与 $10 元` 不会被误解析，而 `公式 $a^2+b^2=c^2$`（前有文字、
 * 后有标点）正常识别。
 */
function installInlineMathRule(md: MarkdownIt): void {
  md.inline.ruler.before('emphasis', 'anmath_inline', (state, silent) => {
    const start = state.pos;
    if (state.src[start] !== '$') return false;
    // 起始 $ 后紧跟数字 → 视作金额
    if (/\d/.test(state.src[start + 1] ?? '')) return false;

    let cursor = start + 1;
    let closing = -1;
    while (cursor < state.posMax) {
      const char = state.src[cursor];
      if (char === '\\') {
        cursor += 2;
        continue;
      }
      if (char === '\n') break; // 行内公式不跨行
      if (char === '$') {
        closing = cursor;
        break;
      }
      cursor++;
    }
    if (closing < 0 || closing === start + 1) return false;
    const after = state.src[closing + 1];
    if (after && /\d/.test(after)) return false;

    if (!silent) {
      const token = state.push('anmath_inline', 'math', 0);
      token.content = state.src.slice(start + 1, closing);
      token.markup = '$';
    }
    state.pos = closing + 1;
    return true;
  });
}

// ==================== 图片处理 ====================

/** 矢量图占位地址前缀（DOCX 侧据此查表注入 SVG，PDF 侧内联回 SVG 原文） */
export const VECTOR_IMAGE_ADDRESS_PREFIX = 'an-doc-vec-';

/** 栅格图占位地址前缀（渲染期短暂存在，回填后即消失） */
const RASTER_IMAGE_ADDRESS_PREFIX = 'an-doc-raster-';

/**
 * 解析 markdown-it 的图片 token：换成占位地址，回填阶段按解析结果落地。
 *
 * 注意：markdown-it 的默认渲染规则在 `renderer.rules` 里**不一定存在**
 * （默认实现在 `default_rules` 中，只有被覆盖过的规则才会出现在 rules 里）。
 * 因此这里不能直接取 `rules.image!`——那会拿到 undefined。
 */
function installImageRule(md: MarkdownIt, pending: { src: string; alt: string }[]): void {
  const defaultRender = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet('src') ?? '';
    const alt = token.content ?? '';
    if (!isSafeImageProtocol(src)) {
      // 危险协议：只留 alt 文本
      return escapeHtml(alt);
    }
    const index = pending.length;
    pending.push({ src, alt });
    token.attrSet('src', `${RASTER_IMAGE_ADDRESS_PREFIX}${index}`);
    // 无覆盖时走 markdown-it 自带实现（等价于 default_rules.image）
    if (!defaultRender) return self.renderToken(tokens, idx, options);
    return defaultRender(tokens, idx, options, env, self);
  };
}

/**
 * 把占位地址替换为真实地址。
 *
 * 必须按 `src="地址"` **精确**匹配：占位地址形如 `an-doc-raster-N`，
 * 只按裸地址做子串替换会让第 2 张图（an-doc-raster-1）命中第 11 张图
 * （an-doc-raster-10）的前缀，把图片数据写到错误的位置。
 *
 * 替换值用函数形式给出——字符串替换里 `$&`、`$'` 等序列会被二次解释，
 * 而 data URL 里出现 `$` 并不罕见。
 */
function replaceImageSrc(html: string, address: string, replacement: string): string {
  const pattern = new RegExp(`src="${escapeRegExp(address)}"`, 'g');
  return html.replace(pattern, () => `src="${replacement}"`);
}

/** 图片标签正则（按占位地址定位） */
function imageTagPattern(address: string): RegExp {
  return new RegExp(`<img[^>]*src="${escapeRegExp(address)}"[^>]*>`, 'g');
}

/**
 * 回填图片：栅格图换成 data URL，矢量图换成矢量占位地址。
 * 解析失败的图片降级为替代文本（图片信息不丢，且不留破图占位）。
 */
async function inlineImages(
  html: string,
  pending: { src: string; alt: string }[],
  resolver: ImageResolver | null,
  vectorImages: Map<string, VectorImage>,
  vectorSeq: { value: number },
): Promise<{ html: string; warnings: RenderWarning[] }> {
  if (!pending.length) return { html, warnings: [] };
  const warnings: RenderWarning[] = [];

  // 同一地址只解析一次（多个图片引用同一 URL 时省一次网络往返）
  const cache = new Map<string, Promise<ResolvedImage | null>>();
  const resolveOne = (src: string): Promise<ResolvedImage | null> => {
    const cached = cache.get(src);
    if (cached) return cached;
    const promise = resolver ? resolver.resolve(src).catch(() => null) : Promise.resolve(null);
    cache.set(src, promise);
    return promise;
  };

  const resolved = await Promise.all(pending.map((item) => resolveOne(item.src)));

  let output = html;
  for (let i = 0; i < pending.length; i++) {
    const address = `${RASTER_IMAGE_ADDRESS_PREFIX}${i}`;
    const image = resolved[i];
    const alt = pending[i].alt;
    const src = pending[i].src;

    if (!image) {
      warnings.push({
        subject: `图片 ${i + 1}`,
        reason: `无法解析图片地址（${truncate(src, 120)}），已降级为替代文本`,
      });
      output = output.replace(
        imageTagPattern(address),
        () => `<span class="md-image-fallback">${fallbackText(alt, src)}</span>`,
      );
      continue;
    }

    if (image.svg) {
      // 矢量图：DOCX 侧保留占位地址（查表注入 SVG + PNG 兜底），PDF 侧内联 SVG
      const vectorAddress = `${VECTOR_IMAGE_ADDRESS_PREFIX}${vectorSeq.value++}`;
      vectorImages.set(vectorAddress, { svg: image.svg, pngDataUrl: image.pngDataUrl });
      output = output.replace(
        imageTagPattern(address),
        () => `<img src="${vectorAddress}" alt="${escapeHtml(alt)}" class="md-vector-image" />`,
      );
      continue;
    }

    if (image.dataUrl) {
      output = replaceImageSrc(output, address, image.dataUrl);
      continue;
    }

    warnings.push({
      subject: `图片 ${i + 1}`,
      reason: `图片解析结果不含可用数据（${truncate(src, 120)}），已降级为替代文本`,
    });
    output = output.replace(
      imageTagPattern(address),
      () => `<span class="md-image-fallback">${fallbackText(alt, src)}</span>`,
    );
  }

  return { html: output, warnings };
}

/** 图片降级后的替代文本：有 alt 用 alt，没有则标出原地址便于排查 */
function fallbackText(alt: string, src: string): string {
  return alt ? escapeHtml(alt) : `［图片：${truncate(src, 60)}］`;
}

// ==================== 代码高亮 ====================

/**
 * 围栏代码块高亮：命中语言用 highlight.js，未命中则按纯文本转义。
 * 高亮失败不影响产出（回退到普通 pre/code）。
 */
function createFenceRenderer(hljs: HljsModule | null) {
  return (code: string, lang: string): string => {
    const escaped = escapeHtml(code);
    if (!hljs || !lang) return escaped;
    const language = lang.trim().toLowerCase();
    if (!language || !hljs.getLanguage(language)) return escaped;
    try {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } catch {
      return escaped;
    }
  };
}

// ==================== 链接协议收敛 ====================

/**
 * 危险协议链接降级为纯文本（javascript:/data:/vbscript: 等）。
 *
 * 同 installImageRule：markdown-it 的默认规则未必存在于 renderer.rules，
 * 缺省时回落到自带的 token 渲染。
 */
function installLinkRule(md: MarkdownIt): void {
  const defaultRender = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href') ?? '';
    if (!isSafeLinkProtocol(href)) {
      // 去掉链接属性，只保留文字
      token.attrSet('href', '');
      token.attrSet('title', '');
      return self.renderInlineAsText(token.children ?? [], options, env);
    }
    if (!defaultRender) return self.renderToken(tokens, idx, options);
    return defaultRender(tokens, idx, options, env, self);
  };
}

// ==================== Mermaid ====================

/** mermaid 围栏语言标记 */
const MERMAID_LANG = 'mermaid';

/** markdown-it 的 token 类型（从 parse 的返回值推导，不额外依赖类型包内部导出） */
type MarkdownToken = ReturnType<MarkdownIt['parse']>[number];

/** 判断围栏信息串是否为 mermaid */
function isMermaidFence(info: string | undefined): boolean {
  return (info ?? '').trim().toLowerCase() === MERMAID_LANG;
}

/**
 * 按渲染顺序收集文档里的 mermaid 围栏源码。
 *
 * 必须走 markdown-it 的 token 流，**不能**用正则扫源码：正则看不见缩进代码块、
 * 引用块内的围栏与列表项里的围栏，会与真正被渲染的围栏数量对不上，
 * 导致「图表 2 的 SVG 被贴到图表 3 上」这种静默错配。
 *
 * 遍历顺序与 renderer 一致（父 token 在前、其子 token 随后），因此第 n 个
 * 收集到的源码正好对应渲染期第 n 个 mermaid 围栏。
 */
function collectMermaidSources(tokens: MarkdownToken[], out: string[]): void {
  for (const token of tokens) {
    if (token.type === 'fence' && isMermaidFence(token.info)) out.push(token.content);
    if (token.children?.length) collectMermaidSources(token.children, out);
  }
}

// ==================== 主渲染流程 ====================

/** 渲染产物 */
export interface MarkdownRenderResult {
  /** 渲染后的 HTML 正文（不含 <html>/<head> 外壳） */
  html: string;
  /** 矢量图表：占位地址 → SVG 原文 + PNG 兜底 */
  vectorImages: Map<string, VectorImage>;
  /** 降级告警（成功渲染则为空数组） */
  warnings: RenderWarning[];
}

/**
 * 把 Markdown 渲染为 HTML 正文。
 *
 * @param markdown Markdown 源码
 * @param options 渲染选项（图片解析器/公式/高亮/mermaid）
 */
export async function renderMarkdownToHtml(
  markdown: string,
  options: MarkdownRenderOptions = {},
): Promise<MarkdownRenderResult> {
  const warnings: RenderWarning[] = [];
  const source = typeof markdown === 'string' ? markdown : '';
  if (!source.trim()) {
    return { html: '', vectorImages: new Map(), warnings };
  }

  // markdown-it 实例**每次新建**：本模块会往实例上安装自定义渲染规则
  // （图片占位、公式、mermaid），若复用同一实例，规则会层层嵌套，
  // 导致图片占位索引错位、渲染结果不可预期。构造开销极小，不值得为它
  // 引入实例池与状态清理的复杂度。
  const MarkdownItConstructor = await loadMarkdownIt();
  const md: MarkdownIt = new MarkdownItConstructor({
    // 原始 HTML 一律转义（防注入）；链接与图片走白名单校验
    html: false,
    linkify: true,
    breaks: false,
    typographer: false,
  });
  const wantMath = options.math !== false;
  const wantHighlight = options.highlight !== false;

  const katex = wantMath ? await loadKatex().catch(() => null) : null;
  if (wantMath && !katex) {
    warnings.push({ subject: '公式', reason: 'KaTeX 加载失败，公式已按纯文本保留' });
  }
  const hljs = wantHighlight ? await loadHljs().catch(() => null) : null;
  if (wantHighlight && !hljs) {
    warnings.push({ subject: '代码高亮', reason: 'highlight.js 加载失败，代码块按纯文本呈现' });
  }

  // 1. 公式规则
  if (katex) {
    installBlockMathRule(md);
    installInlineMathRule(md);
    md.renderer.rules.anmath_block = (tokens, idx) => {
      const { html: formulaHtml, degraded } = renderFormula(katex, tokens[idx].content, true);
      if (degraded) warnings.push({ subject: '块级公式', reason: '公式解析失败，已按纯文本保留' });
      return formulaHtml;
    };
    md.renderer.rules.anmath_inline = (tokens, idx) => {
      const { html: formulaHtml, degraded } = renderFormula(katex, tokens[idx].content, false);
      if (degraded) warnings.push({ subject: '行内公式', reason: '公式解析失败，已按纯文本保留' });
      return formulaHtml;
    };
  }

  // 2. Mermaid 预渲染（markdown-it 渲染是同步的，无法在围栏规则里 await）
  //    围栏源码取自 token 流（与渲染顺序严格一致），逐个渲染成 SVG。
  const mermaidSvgs: (string | null)[] = [];
  if (options.renderMermaid) {
    const sources: string[] = [];
    collectMermaidSources(md.parse(source, {}), sources);
    for (let i = 0; i < sources.length; i++) {
      const svg = await options.renderMermaid(sources[i]).catch(() => null);
      mermaidSvgs.push(svg);
      if (!svg) {
        warnings.push({ subject: `Mermaid 图表 ${i + 1}`, reason: '图表渲染失败，已降级为代码块' });
      }
    }
  }

  // 3. 图片占位
  const pendingImages: { src: string; alt: string }[] = [];
  const vectorImages = new Map<string, VectorImage>();
  const vectorSeq = { value: 0 };
  installImageRule(md, pendingImages);
  installLinkRule(md);

  // 4. 代码高亮
  if (hljs) {
    md.options.highlight = createFenceRenderer(hljs);
  }

  // 5. mermaid 围栏 → 图表占位
  // 同 installImageRule：默认围栏规则未必存在于 renderer.rules，缺省时
  // 用 markdown-it 自带的 token 渲染（等价于 default_rules.fence）。
  const defaultFence = md.renderer.rules.fence;
  let mermaidIndex = 0;
  md.renderer.rules.fence = (tokens, idx, fenceOptions, env, self) => {
    const token = tokens[idx];
    const renderFence = () =>
      defaultFence
        ? defaultFence(tokens, idx, fenceOptions, env, self)
        : self.renderToken(tokens, idx, fenceOptions);
    if (!isMermaidFence(token.info)) return renderFence();
    const svg = mermaidSvgs[mermaidIndex++];
    if (!svg) {
      // 渲染失败：回退为普通代码块，源码不丢
      return renderFence();
    }
    const vectorAddress = `${VECTOR_IMAGE_ADDRESS_PREFIX}${vectorSeq.value++}`;
    vectorImages.set(vectorAddress, { svg, pngDataUrl: undefined });
    // PNG 兜底（异步生成，稍后回填）——见第 7 步
    return `<p class="md-mermaid"><img src="${vectorAddress}" alt="Mermaid 图表" class="md-vector-image" /></p>`;
  };

  // 6. 渲染
  let html = md.render(source);

  // 7. 回填图片
  const imageResult = await inlineImages(html, pendingImages, options.images ?? null, vectorImages, vectorSeq);
  html = imageResult.html;
  warnings.push(...imageResult.warnings);

  // 8. 矢量图 PNG 兜底：Word 2019 以下 / Pages / LibreOffice 不显示无兜底的
  //    SVG（docx 会塞一张 1px 透明像素），因此这里补一份 PNG 供旧版渲染。
  await attachVectorFallbacks(vectorImages);

  return { html, vectorImages, warnings };
}

/**
 * 为矢量图补 PNG 兜底（原地更新 vectorImages）。
 *
 * 没有 DOM（Node 测试环境）或栅格化失败时保持原样：新版 Word 仍能显示 SVG，
 * 只是旧版渲染不出来——这属于可接受的降级，不阻断产物。
 */
async function attachVectorFallbacks(vectorImages: Map<string, VectorImage>): Promise<void> {
  for (const vector of vectorImages.values()) {
    if (vector.pngDataUrl) continue;
    const png = await svgToPngDataUrl(vector.svg).catch(() => null);
    if (png) vector.pngDataUrl = png;
  }
}

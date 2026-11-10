/**
 * Markdown 渲染器（对话消息）
 *
 * 负责把 AI 输出渲染为 HTML，供 v-html 注入侧边栏。
 *
 * ==================== 信任边界（安全基线） ====================
 * 侧边栏是扩展页（chrome-extension:// 源），与 chrome.storage 同源：
 * 一旦这里出现可执行的注入脚本，攻击者即可直接读取 chrome.storage.local 中的
 * API 密钥并外传——XSS 在本扩展等价于凭据泄露。因此渲染链路必须显式建模信任边界：
 *
 *   1. **模型内容永不产生 HTML**markdown-it 关闭原始 HTML 解析（html: false），
 *      模型输出中的 <script> / <img onerror> / <iframe> 一律转义为纯文本。
 *      「模型输出 → v-html」这条唯一的注入入口被从根上关闭。
 *   2. **页面中的 HTML 全部来自可信代码**：LaTeX（KaTeX）、代码高亮、Mermaid 容器、
 *      文件卡片、API 错误卡片——均由本模块生成或来自已转义/已校验的结构化数据。
 *      因此无需再引入通用 HTML 消毒器（避免 style / MathML 白名单带来的复杂度与新风险）。
 *   3. **模型内容中的 URL 走协议校验**：markdown-it 内置 validateLink 拦截
 *      javascript: / vbscript: 等危险协议；链接统一 target="_blank" +
 *      rel="noopener noreferrer nofollow"，既避免扩展页被导航走（丢失上下文），
 *      也切断 window.opener 劫持链。
 *   4. **不产出内联脚本**：扩展 CSP 为 script-src 'self'（不含 'unsafe-inline'），
 *      内联 onclick 会被浏览器直接拦截；代码复制按钮走 document 级事件委托。
 *
 * ==================== 占位符机制 ====================
 * 关闭原始 HTML 后，<api-error> / <think> 等结构化块与 LaTeX 公式都必须在
 * Markdown 解析前从源码中摘出、解析完成后回填。摘出时统一替换为纯文本令牌
 * （仅字母数字，Markdown 不会改写），避免 HTML 标签被转义后无法回填。
 * 令牌带每次渲染随机后缀，杜绝与模型内容撞名导致的错误回填。
 */

import MarkdownIt from 'markdown-it';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import hljs from 'highlight.js';
import 'highlight.js/styles/github.css';
import { installFileCardHandler, installFileCardSyntax, protectWorkspaceFileTags, renderPlainFileCards } from './file-card';
import { installCodeCopyHandler } from './code-copy';
import { installComponentImageSaveHandler } from './component-image-save';
import { installTableActionHandler } from './table-actions';
import { installApiErrorModelHandler } from './api-error-model';
import { installApiErrorRetryHandler } from './api-error-retry';
import { escapeHtml } from './html-escape';
import { unescapeXmlText } from '../xml-entities';
import { buildStatCardBlock } from './stat-card';
import {
  COMPONENT_FENCE_LANG,
  findRichComponentByFenceLang,
  parseRichEnvelope,
  buildEnvelopeComponentBlock,
  buildDiffBlock,
} from './rich-components';
import { SHORT_ID_PATTERN } from '../../core/images/image-store';
import { driverRegistry } from '../stream/driver-registry';
import type { ProviderType } from '../stream/types';
import { t } from '@/utils/i18n/core';

// 文件下载委托 + 代码复制委托 + 组件保存图片委托 + 表格工具栏委托 + 错误卡片浮层/重试委托（均为幂等安装）；本模块只在 DOM 上下文被使用
installFileCardHandler();
installCodeCopyHandler();
installComponentImageSaveHandler();
installTableActionHandler();
installApiErrorModelHandler();
installApiErrorRetryHandler();

/** 「请求模型」浮层 id 序号（同一页多张错误卡片时保证 id 唯一） */
let apiErrorModelPanelSeq = 0;

/**
 * <api-error> 卡片合法分类（发射侧 ApiRequestErrorKind 五类 + 非 ApiRequestError
 * 的兜底 error，见 utils/stream/errors.ts 的 toApiErrorBlock）。
 *
 * kind 会拼进卡片的 class 属性（CSS 按 .kind-* 切换分类配色）——必须白名单
 * 校验：卡片 XML 会随转录持久化，存储层损坏或被篡改时，任意字符串直接进
 * class 等于向样式选择器面注入任意 token。未知值一律按 error（中性配色）
 * 呈现，信息不丢（原始块始终原文保留在卡片/降级 pre 中）。
 */
const API_ERROR_KINDS: ReadonlySet<string> = new Set([
  'http',
  'timeout',
  'network',
  'protocol',
  'inband',
  'error',
]);

// ==================== 通用工具 ====================

/**
 * 生成占位符随机后缀（8 位字母数字）。
 * 每次渲染都不同：模型内容里偶然出现的同名令牌不会被误当作占位符回填。
 */
function createTokenSuffix(): string {
  let suffix = '';
  do {
    suffix = Math.random().toString(36).slice(2, 10);
  } while (suffix.length < 8);
  return suffix.slice(0, 8);
}

// ==================== 源码分段（代码区与正文区） ====================

interface SourceSegment {
  text: string;
  /** true = 代码内容（围栏代码块 / 行内代码），其中的 $…$ 是字面量，不应渲染成公式 */
  code: boolean;
}

/** 追加分段并合并相邻同类分段 */
function pushSegment(segments: SourceSegment[], text: string, code: boolean): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.code === code) {
    last.text += text;
    return;
  }
  segments.push({ text, code });
}

/**
 * 按反引号串把一行拆成「正文 / 行内代码」两段。
 * 反引号串必须等长闭合（与 CommonMark 一致）；未闭合时按正文处理。
 */
function splitInlineCode(segments: SourceSegment[], text: string): void {
  let pos = 0;
  while (pos < text.length) {
    const tick = text.indexOf('`', pos);
    if (tick === -1) {
      pushSegment(segments, text.slice(pos), false);
      return;
    }

    let run = 1;
    while (tick + run < text.length && text[tick + run] === '`') run++;

    // 查找等长闭合串（更长的反引号串不算闭合）
    let closeAt = -1;
    let searchFrom = tick + run;
    while (searchFrom < text.length) {
      const idx = text.indexOf('`', searchFrom);
      if (idx === -1) break;
      let closeRun = 1;
      while (idx + closeRun < text.length && text[idx + closeRun] === '`') closeRun++;
      if (closeRun === run) {
        closeAt = idx;
        break;
      }
      searchFrom = idx + closeRun;
    }

    if (closeAt === -1) {
      // 无闭合 → 视为普通文本
      pushSegment(segments, text.slice(pos, tick + run), false);
      pos = tick + run;
      continue;
    }

    pushSegment(segments, text.slice(pos, tick), false);
    pushSegment(segments, text.slice(tick, closeAt + run), true);
    pos = closeAt + run;
  }
}

/**
 * 把源码切分为代码段与正文段。
 * 代码段 = 围栏代码块（``` / ~~~）+ 行内代码（反引号）。
 * 未闭合的围栏按普通文本处理（与 markdown-it 行为一致）。
 */
function splitByCodeSegments(source: string): SourceSegment[] {
  const segments: SourceSegment[] = [];
  const lines = source.split('\n');
  let fence: { char: string; length: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = i === lines.length - 1 ? line : `${line}\n`;

    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const char = marker[0];
      const rest = fenceMatch[2];
      if (!fence) {
        pushSegment(segments, text, true);
        fence = { char, length: marker.length };
        continue;
      }
      // 闭合围栏：同字符、长度足够、其后无其它内容
      if (char === fence.char && marker.length >= fence.length && !rest.trim()) {
        pushSegment(segments, text, true);
        fence = null;
        continue;
      }
    }

    if (fence) {
      pushSegment(segments, text, true);
      continue;
    }
    splitInlineCode(segments, text);
  }

  return segments;
}

// ==================== LaTeX 抽取 ====================

/** 行内公式 $…$（不跨行）与块级公式 $$…$$（可跨行） */
const LATEX_PATTERN = /\$\$([\s\S]+?)\$\$|\$([^$\n]+)\$/g;

/** 渲染单个公式；失败时降级为可读的错误文本，绝不抛出中断整条消息渲染 */
function renderFormula(formula: string, displayMode: boolean): string {
  try {
    return katex.renderToString(formula, {
      displayMode,
      throwOnError: false,
      errorColor: '#cc0000',
      strict: false,
    });
  } catch (error) {
    console.warn('[MarkdownRenderer] LaTeX 渲染失败:', error);
    return `<span class="latex-error">${escapeHtml(formula)}</span>`;
  }
}

/**
 * 抽取源码中的公式并替换为占位符。
 * 只在正文段抽取：代码里的 $…$ 是字面量，渲染成公式既失真也会破坏代码可复制性。
 */
function extractLatex(source: string, suffix: string): { text: string; formulas: string[] } {
  const formulas: string[] = [];
  const fileTags: string[] = [];
  // Restore the original attributes before Markdown parses them. A path can contain dollar signs.
  const tagPrefix = `ANWORKSPACE${suffix}FILE`;
  const protectedSource = protectWorkspaceFileTags(source, tag => {
    fileTags.push(tag);
    return `${tagPrefix}${fileTags.length - 1}END`;
  });
  let text = '';

  for (const segment of splitByCodeSegments(protectedSource)) {
    if (segment.code) {
      text += segment.text;
      continue;
    }
    text += segment.text.replace(LATEX_PATTERN, (match, display: string | undefined, inline: string | undefined) => {
      const isDisplay = display !== undefined;
      const formula = (display ?? inline ?? '').trim();
      if (!formula || formula.includes(tagPrefix)) return match;
      const index = formulas.length;
      formulas.push(renderFormula(formula, isDisplay));
      return `ANLATEX${index}END${suffix}`;
    });
  }

  if (fileTags.length) {
    text = text.replace(new RegExp(`${tagPrefix}(\\d+)END`, 'g'), (_match, index) => fileTags[Number(index)]);
  }
  return { text, formulas };
}

// ==================== 回答内截图引用（agent-image） ====================

/**
 * 回答里引用已存档截图的标签：`<agent-image id="8位短id" alt="可选说明" />`
 *
 * 语义：模型在最终回答中写出该标签，渲染层把它还原成图片卡片
 * （图片本体在图片库里，渲染时按短 id 反查 object URL）。
 * id 形如 `a1b2c3d4`：8 位小写字母数字，由图片库分配、插件内唯一。
 *
 * 与 <api-error> / <think> 同样的处理顺序：**解析前摘出、解析后回填**
 * （markdown-it 关闭了原始 HTML，标签若留在正文里会被转义成文本）。
 * 代码块里的同名标签是字面量，不摘出、不还原。
 */
const AGENT_IMAGE_PATTERN = /<agent-image\b(?:"[^"]*"|'[^']*'|[^>"'])*(\/?)>/g;
const AGENT_IMAGE_ID_PATTERN = /\bid\s*=\s*"([^"]*)"/;
const AGENT_IMAGE_ALT_PATTERN = /\balt\s*=\s*"([^"]*)"/;

/** 回答内截图引用（id + 可选说明） */
interface AgentImageRef {
  id: string;
  alt: string;
}

/**
 * 摘出回答中的截图引用标签，替换为纯文本占位符。
 * 非法 id（不是 8 位短 id）保持原样：宁可让模型看到自己写的原文，
 * 也不把无法解析的引用渲染成空卡片。
 */
function extractAgentImages(source: string, suffix: string): { text: string; refs: AgentImageRef[] } {
  const refs: AgentImageRef[] = [];
  const text = splitByCodeSegments(source)
    .map(segment => {
      if (segment.code) return segment.text;
      return segment.text.replace(AGENT_IMAGE_PATTERN, (match, _slash: string, offset: number, whole: string) => {
        // 属性串从原文切片（标签头之后、边界 > 之前，去掉可选自闭合 /）。
        // 不能用捕获组：alt 属外部数据可能含 >，惰性捕获会在其内部截断，
        // 导致 alt 抽成空串并让原始 HTML 泄漏进正文。
        const closeAt = offset + match.lastIndexOf('>');
        const attrs = whole.slice(offset + '<agent-image'.length, closeAt).replace(/\/$/, '');
        const id = AGENT_IMAGE_ID_PATTERN.exec(attrs)?.[1]?.trim() ?? '';
        if (!SHORT_ID_PATTERN.test(id)) return match;
        const alt = AGENT_IMAGE_ALT_PATTERN.exec(attrs)?.[1]?.trim() ?? '';
        refs.push({ id, alt });
        return `ANAGENTIMG${refs.length - 1}END${suffix}`;
      });
    })
    .join('');
  return { text, refs };
}

// ==================== 表格工具栏图标 ====================

/** 表格标识图标（工具栏左侧） */
const TABLE_ICON_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/></svg>';

/** 复制按钮图标 */
const COPY_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

/** 导出按钮图标（下载） */
const DOWNLOAD_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';

// ==================== MarkdownIt 实例 ====================

/** 渲染选项接口 */
export interface RenderOptions {
  enableLatex?: boolean;
  enableMarkdown?: boolean;
  enableCodeHighlight?: boolean;
  enableMermaid?: boolean;
  /** 富内容组件围栏渲染开关（```component 信封 + legacy 直连名 + diff） */
  enableRichCharts?: boolean;
  codeTheme?: string;
  workspaceChatId?: string;
}

/**
 * Markdown 渲染器类
 */
export class MarkdownRenderer {
  private md: MarkdownIt;

  /** 当前渲染是否启用语法高亮（由 renderMessage 按选项设置，供 fence 规则读取） */
  private codeHighlightEnabled = true;

  /** 当前渲染是否启用图表容器（Mermaid / PlantUML；由 renderMessage 按选项设置） */
  private mermaidEnabled = true;

  /** 当前渲染是否启用富内容组件围栏（ECharts / 统计卡；由 renderMessage 按选项设置） */
  private richChartsEnabled = true;

  constructor() {
    this.md = new MarkdownIt({
      // 安全基线：模型输出中的原始 HTML 一律转义为文本（详见文件头信任边界说明）
      html: false,
      linkify: true,
      typographer: true,
      breaks: true,
    });

    this.md.enable(['table']);
    installFileCardSyntax(this.md);

    // ── 代码块：整体由 fence 规则渲染，避免 markdown-it 默认的 <pre><code> 包裹
    //    与自定义容器嵌套产生的非法 HTML；同时不使用任何内联脚本 ──
    this.md.renderer.rules.fence = (tokens, idx) => {
      const token = tokens[idx];
      const lang = (token.info || '').trim().split(/\s+/)[0] || '';
      const code = token.content;

      // ── 富内容围栏：注册表分发（语言名单单一事实源见 rich-components/registry.ts）──
      // 三类入口共用此处分发：
      //   1. ```component 统一信封（type 字段决定组件；chart 走骨架 + 异步派生，
      //      stat/table/timeline/tree/insight 渲染期同步产出可信 HTML）；
      //   2. legacy 直连名（echarts / stat-card 等，历史消息兼容）；
      //   3. 原生 DSL 名（mermaid / plantuml / puml / diff）。
      // 任何解析 / 校验失败都继续下落为普通代码块：源码可见、信息不丢。
      if (lang === COMPONENT_FENCE_LANG && this.richChartsEnabled) {
        const parsed = parseRichEnvelope(code);
        if (parsed.ok) {
          if (parsed.envelope.type === 'chart') {
            // 图表：骨架 + data-chart-input="envelope"，chart-renderer 在
            // v-html 注入后解析信封 → 派生 option → 净化 → 沙箱渲染
            return this.buildChartBlock(code, 'envelope', parsed.envelope.source);
          }
          const componentHtml = buildEnvelopeComponentBlock(parsed.envelope);
          if (componentHtml !== null) return componentHtml;
        }
        // 信封解析 / 构建失败 → 普通代码块（源码降级展示）
      } else {
        const spec = findRichComponentByFenceLang(lang);
        if (spec?.id === 'diagram' && this.mermaidEnabled) {
          // 图表围栏（Mermaid / PlantUML）→ 统一图表块容器：
          // 实际 SVG / <img> 由 diagram-renderer.ts 在 v-html 注入后异步渲染
          // （库懒加载），源码以转义文本保存在隐藏 <pre> 中
          return this.buildDiagramBlock(lang === 'mermaid' ? 'mermaid' : 'plantuml', code);
        }
        if (spec && this.richChartsEnabled) {
          if (spec.id === 'chart') {
            // legacy ```echarts 直连：源码即 option，chart-renderer 直接净化
            return this.buildChartBlock(code, 'option');
          }
          if (spec.id === 'stat') {
            // legacy ```stat-card 直连：zod 校验 + 可信 HTML（失败回落代码块）
            const statHtml = buildStatCardBlock(code);
            if (statHtml !== null) return statHtml;
          } else if (spec.id === 'diff') {
            return buildDiffBlock(code);
          }
        }
      }

      let codeHtml: string;
      if (this.codeHighlightEnabled && lang && hljs.getLanguage(lang)) {
        try {
          const result = hljs.highlight(code, { language: lang, ignoreIllegals: true });
          codeHtml = `<pre class="code-block"><code class="hljs language-${escapeHtml(lang)}">${result.value}</code></pre>`;
        } catch {
          codeHtml = `<pre class="code-block"><code class="hljs">${escapeHtml(code)}</code></pre>`;
        }
      } else {
        codeHtml = `<pre class="code-block"><code class="hljs">${escapeHtml(code)}</code></pre>`;
      }

      const langLabel = lang ? lang.toUpperCase() : 'CODE';
      const copyLabel = t('sidepanel.chat.copyLabel');
      const copiedLabel = t('sidepanel.chat.copiedLabel');
      return (
        `<div class="code-block-wrapper">` +
        `<div class="code-block-header">` +
        `<span class="code-lang-label">${escapeHtml(langLabel)}</span>` +
        `<button type="button" class="code-copy-btn"` +
        ` data-copy-idle-label="${escapeHtml(copyLabel)}"` +
        ` data-copy-done-label="${escapeHtml(copiedLabel)}">${escapeHtml(copyLabel)}</button>` +
        `</div>` +
        codeHtml +
        `</div>\n`
      );
    };

    // ── 链接：新标签页打开 + 切断 opener 引用（扩展页被导航走会丢失 sidepanel 上下文）──
    const defaultLinkOpen =
      this.md.renderer.rules.link_open ||
      ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
    this.md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer nofollow');
      return defaultLinkOpen(tokens, idx, options, env, self);
    };

    // ── 图片：延迟加载，避免长会话一次性拉取大量远端图片 ──
    const defaultImage =
      this.md.renderer.rules.image ||
      ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
    this.md.renderer.rules.image = (tokens, idx, options, env, self) => {
      tokens[idx].attrSet('loading', 'lazy');
      return defaultImage(tokens, idx, options, env, self);
    };
  }

  /**
   * 渲染消息内容
   * @param content 原始文本内容
   * @param options 渲染选项
   * @returns 渲染后的HTML字符串
   */
  renderMessage(content: string, options: RenderOptions = {}): string {
    try {
      const {
        enableLatex = true,
        enableMarkdown = true,
        enableCodeHighlight = true,
        enableMermaid = true,
        enableRichCharts = true,
      } = options;

      let rendered = content ?? '';

      // 渲染选项下发到 fence 规则（高亮 / Mermaid / 富内容开关）
      this.codeHighlightEnabled = enableCodeHighlight;
      this.mermaidEnabled = enableMermaid;
      this.richChartsEnabled = enableRichCharts;

      const suffix = createTokenSuffix();

      // ── 1. 摘出 <api-error> 错误卡片块 ──
      // 必须早于 Markdown 解析：块内 JSON 缩进会被误判为代码块、breaks 规则会插入 <br>，
      // 破坏原始响应的逐字展示
      const apiErrorBlocks: string[] = [];
      rendered = rendered.replace(/<api-error\b[^>]*>[\s\S]*?<\/api-error>/g, block => {
        apiErrorBlocks.push(block);
        return `ANAPIERR${apiErrorBlocks.length - 1}END${suffix}`;
      });

      // ── 2. 摘出 <think> 推理段（含未闭合情形）──
      const thinkBlocks: string[] = [];
      rendered = rendered.replace(/<think>([\s\S]*?)<\/think>/g, (_match, content: string) => {
        thinkBlocks.push(content);
        return `ANTHINK${thinkBlocks.length - 1}END${suffix}`;
      });
      const unclosedThink = rendered.match(/<think>([\s\S]*)$/);
      if (unclosedThink) {
        thinkBlocks.push(unclosedThink[1]);
        rendered = rendered.replace(/<think>([\s\S]*)$/, `ANTHINK${thinkBlocks.length - 1}END${suffix}`);
      }

      // ── 3. 摘出 <agent-image> 截图引用（回答里引用已存档截图）──
      // 必须在 Markdown 解析前：markdown-it 关闭原始 HTML，标签留在正文会被转义成文本
      const agentImages = extractAgentImages(rendered, suffix);
      rendered = agentImages.text;

      // ── 4. 摘出 LaTeX 公式（在 Markdown 解析前完成，保证公式里的 < > & 不被转义）──
      let formulas: string[] = [];
      if (enableLatex) {
        const extracted = extractLatex(rendered, suffix);
        rendered = extracted.text;
        formulas = extracted.formulas;
      }

      // ── 5. Markdown 解析 ──
      if (enableMarkdown) {
        rendered = this.md.render(rendered, { workspaceChatId: options.workspaceChatId });
      } else {
        rendered = renderPlainFileCards(escapeHtml(rendered));
      }

      // ── 6. 回填 LaTeX 公式（KaTeX 产物为可信 HTML）──
      if (formulas.length > 0) {
        formulas.forEach((formula, index) => {
          rendered = rendered.split(`ANLATEX${index}END${suffix}`).join(formula);
        });
      }

      // ── 7. 表格包裹：工具栏（复制 / 导出 xlsx）+ 横向滚动容器 ──
      rendered = this.wrapTables(rendered);

      // ── 9. 回填 <agent-image> 截图引用卡片（可信 HTML，图片本体异步注入）──
      agentImages.refs.forEach((ref, index) => {
        const token = `ANAGENTIMG${index}END${suffix}`;
        rendered = this.restoreToken(rendered, token, this.buildAgentImageCard(ref));
      });

      // ── 10. 回填 <think> 推理段（内容转义：模型内容不得产生可执行标记）──
      thinkBlocks.forEach((content, index) => {
        const token = `ANTHINK${index}END${suffix}`;
        rendered = this.restoreToken(rendered, token, `<think>${escapeHtml(content)}</think>`);
      });

      // ── 11. 回填 <api-error> 错误卡片 ──
      apiErrorBlocks.forEach((block, index) => {
        const token = `ANAPIERR${index}END${suffix}`;
        rendered = this.restoreToken(rendered, token, this.buildApiErrorCard(block));
      });

      // 清理历史遗留的占位符文本，避免在界面直接显示
      rendered = rendered.replace(/__?THINK_PLACEHOLDER_\d+__?/g, '');

      return rendered;
    } catch (error) {
      console.warn('Markdown render error:', error);
      return escapeHtml(content ?? '');
    }
  }

  /**
   * 表格 → 工具栏 + 滚动容器。
   *
   * DOM 契约（table-actions.ts 依赖）：
   *   <div class="table-block">
   *     <div class="table-header">
   *       <span class="table-title">…图标 + 标题…</span>
   *       <span class="table-actions">
   *         <button class="table-action-btn table-copy-btn" title aria-label>…复制图标…</button>
   *         <button class="table-action-btn table-export-btn" title aria-label>…下载图标…</button>
   *       </span>
   *     </div>
   *     <div class="table-scroll-wrapper"><table>…</table></div>
   *   </div>
   *
   * 表格本身不改变内容，仅套一层容器：横向滚动仍由 .table-scroll-wrapper 承担，
   * 工具栏提供「复制为 Markdown」与「导出 xlsx」两个动作（均走 document 级委托）。
   */
  private wrapTables(html: string): string {
    if (!html.includes('<table>')) return html;
    const header = this.buildTableHeader();
    return html
      .replace(
        /<table>/g,
        `<div class="table-block">${header}<div class="table-scroll-wrapper"><table>`,
      )
      .replace(/<\/table>/g, '</table></div></div>');
  }

  /** 表格工具栏 HTML（右侧排列复制 / 导出按钮，均为 SVG 图标） */
  private buildTableHeader(): string {
    const label = t('sidepanel.chat.tableLabel');
    const copyLabel = t('sidepanel.chat.tableCopyLabel');
    const exportLabel = t('sidepanel.chat.tableExportLabel');
    return (
      `<div class="table-header">` +
      `<span class="table-title">${TABLE_ICON_SVG}${escapeHtml(label)}</span>` +
      `<span class="table-actions">` +
      `<button type="button" class="table-action-btn table-copy-btn"` +
      ` title="${escapeHtml(copyLabel)}" aria-label="${escapeHtml(copyLabel)}">${COPY_ICON_SVG}</button>` +
      `<button type="button" class="table-action-btn table-export-btn"` +
      ` title="${escapeHtml(exportLabel)}" aria-label="${escapeHtml(exportLabel)}">${DOWNLOAD_ICON_SVG}</button>` +
      `</span>` +
      `</div>`
    );
  }

  /**
   * 图表围栏 → 统一图表块 HTML。DOM 契约（diagram-renderer.ts 依赖）：
   *
   *   <div class="diagram-block" data-diagram-kind="mermaid|plantuml" data-diagram-state="pending">
   *     <div class="diagram-header">
   *       <span class="diagram-lang-label">…</span>
   *       <button class="code-copy-btn component-save-btn" data-save-idle-label data-save-done-label>保存</button>
   *     </div>
   *     <div class="diagram-body">…状态占位，异步渲染后替换为 SVG / <img>…</div>
   *     <pre class="diagram-source"><code>转义源码</code></pre>  ← 默认隐藏（渲染失败时由降级路径展开）
   *   </div>
   *
   * 头部动作只有一个「保存」：把当前渲染产物导出为高清 PNG（保存委托见
   * component-image-save.ts）。源码不再有切换入口——渲染失败时由
   * diagram-renderer 自动展开源码视图，信息不丢。
   *
   * 源码只以转义文本形态存在；.diagram-body 初始内容为无害占位文本，
   * 真正的图表产物由 diagram-renderer 注入（Mermaid strict 模式 / 远程 SVG 图片）。
   */
  private buildDiagramBlock(kind: 'mermaid' | 'plantuml', code: string): string {
    const label =
      kind === 'mermaid'
        ? t('sidepanel.chat.diagramMermaidLabel')
        : t('sidepanel.chat.diagramPlantumlLabel');
    const saveLabel = t('sidepanel.chat.saveImageLabel');
    const savedLabel = t('sidepanel.chat.saveImageDoneLabel');
    return (
      `<div class="diagram-block" data-diagram-kind="${kind}" data-diagram-state="pending">` +
      `<div class="diagram-header">` +
      `<span class="diagram-lang-label">${escapeHtml(label)}</span>` +
      `<button type="button" class="code-copy-btn component-save-btn"` +
      ` data-save-idle-label="${escapeHtml(saveLabel)}"` +
      ` data-save-done-label="${escapeHtml(savedLabel)}">${escapeHtml(saveLabel)}</button>` +
      `</div>` +
      `<div class="diagram-body">${escapeHtml(t('sidepanel.chat.diagramRendering'))}</div>` +
      `<pre class="diagram-source"><code>${escapeHtml(code)}</code></pre>` +
      `</div>\n`
    );
  }

  /**
   * ECharts 图表围栏 → 图表块 HTML。DOM 契约（chart-renderer.ts 依赖，
   * 与 diagram-block 同构、类名独立——避免 diagram-renderer 误拾取）：
   *
   *   <div class="chart-block" data-chart-kind="echarts" data-chart-input="option|envelope" data-chart-state="pending">
   *     <div class="chart-header">
   *       <span class="chart-lang-label">…</span>
   *       <button class="code-copy-btn component-save-btn" data-save-idle-label data-save-done-label>保存</button>
   *     </div>
   *     <div class="chart-body">…状态占位，chart-renderer 注入沙箱 iframe…</div>
   *     <pre class="chart-source"><code>转义源码</code></pre>  ← 默认隐藏（渲染失败时由降级路径展开）
   *   </div>
   *
   * 头部动作只有一个「保存」：把当前渲染产物导出为高清 PNG（保存委托见
   * component-image-save.ts，图表产物经 registerChartImageSource 由
   * chart-renderer 提供）。源码不再有切换入口——渲染失败时由
   * chart-renderer 自动展开源码视图，信息不丢。
   *
   * data-chart-input 决定 chart-renderer 的处理路径：option = legacy 直连
   * （源码即 option，直接净化）；envelope = 统一信封（源码是列式数据，
   * 先信封解析 → derive-chart 派生 option → 再净化）。源码只以转义文本
   * 形态存在；.chart-body 初始内容为无害占位文本，真正的图表产物由沙箱页
   * 内 ECharts 渲染（见 chart-renderer.ts 安全模型）。
   *
   * source = 信封级来源说明（可选）：渲染成图表下方的脚注，让「数据出处」
   * 与图表本体同屏可见（敏感数据必须附来源纪律的落地形态）。
   */
  private buildChartBlock(code: string, input: 'option' | 'envelope', source = ''): string {
    const label = t('sidepanel.chat.chartEchartsLabel');
    const saveLabel = t('sidepanel.chat.saveImageLabel');
    const savedLabel = t('sidepanel.chat.saveImageDoneLabel');
    return (
      `<div class="chart-block" data-chart-kind="echarts" data-chart-input="${input}" data-chart-state="pending">` +
      `<div class="chart-header">` +
      `<span class="chart-lang-label">${escapeHtml(label)}</span>` +
      `<button type="button" class="code-copy-btn component-save-btn"` +
      ` data-save-idle-label="${escapeHtml(saveLabel)}"` +
      ` data-save-done-label="${escapeHtml(savedLabel)}">${escapeHtml(saveLabel)}</button>` +
      `</div>` +
      (source
        ? `<div class="component-block-source">${escapeHtml(t('sidepanel.chat.componentSourceLabel'))}${escapeHtml(source)}</div>`
        : '') +
      `<div class="chart-body">${escapeHtml(t('sidepanel.chat.chartRendering'))}</div>` +
      `<pre class="chart-source"><code>${escapeHtml(code)}</code></pre>` +
      `</div>\n`
    );
  }

  /**
   * 回填占位符：
   * 独占一段的占位符整段替换（卡片是块级元素，塞进 <p> 会产生非法嵌套），
   * 行内占位符直接原位替换。
   */
  private restoreToken(html: string, token: string, replacement: string): string {
    const paragraphToken = `<p>${token}</p>`;
    if (html.includes(paragraphToken)) {
      return html.split(paragraphToken).join(replacement);
    }
    return html.split(token).join(replacement);
  }

  /**
   * `<agent-image id="..." />` → 截图引用卡片骨架。
   *
   * DOM 契约（agent-image-renderer.ts 依赖）：
   *   <div class="agent-image-card" data-agent-image-id="8位短id"
   *        data-agent-image-alt="说明" data-agent-image-state="pending|loading|done|missing">
   *     <div class="agent-image-body">…图片本体由渲染器异步注入…</div>
   *   </div>
   *
   * 骨架本身不含任何图片数据：短 id → 图片的解析是异步的（图片库读取），
   * 由渲染层在 v-html 注入后完成。所有展示文本一律转义——
   * alt 来自模型输出，属外部数据。
   */
  private buildAgentImageCard(ref: AgentImageRef): string {
    const alt = ref.alt || t('sidepanel.chat.agentImageDefaultAlt');
    return (
      `<div class="agent-image-card" data-agent-image-id="${escapeHtml(ref.id)}"` +
      ` data-agent-image-alt="${escapeHtml(alt)}" data-agent-image-state="pending">` +
      `<div class="agent-image-body">` +
      `<span class="agent-image-placeholder">${escapeHtml(t('sidepanel.chat.agentImageLoading'))}</span>` +
      `</div></div>`
    );
  }

  /**
   * <api-error> XML 块 → 样式化错误卡片 HTML。
   * 结构（发射侧见 utils/stream/errors.ts 的 toApiErrorBlock）：
   *   <api-error kind="http" status="429" title="HTTP 429" label="限流" provider="openai" model="gpt-4o" occurred-at="ISO">
   *     <summary>单行摘要</summary>
   *     <raw>完整原始响应</raw>
   *   </api-error>
   * 所有展示文本一律 HTML 转义；解析失败的块降级为 <pre> 展示原文（信息不丢）。
   * provider / model / url / occurred-at 同时以 data-* 暴露给复制委托，拼装「可直接提交 issue」的报告。
   */
  private buildApiErrorCard(block: string): string {
    try {
      const attrs: Record<string, string> = {};
      const attrRegex = /([\w-]+)="([^"]*)"/g;
      const openTagMatch = block.match(/<api-error\b([^>]*)>/);
      if (openTagMatch) {
        let attrMatch: RegExpExecArray | null;
        while ((attrMatch = attrRegex.exec(openTagMatch[1])) !== null) {
          attrs[attrMatch[1]] = unescapeXmlText(attrMatch[2]);
        }
      }
      const summaryMatch = block.match(/<summary>([\s\S]*?)<\/summary>/);
      const rawMatch = block.match(/<raw>([\s\S]*?)<\/raw>/);

      // 白名单校验（API_ERROR_KINDS）：未知 kind 一律按 error，class 只含受信枚举
      const rawKind = attrs['kind'] || 'error';
      const kind = API_ERROR_KINDS.has(rawKind) ? rawKind : 'error';
      const title = attrs['title'] || (attrs['status'] ? `HTTP ${attrs['status']}` : '');
      const label = attrs['label'] || '';
      const summary = summaryMatch ? unescapeXmlText(summaryMatch[1]).trim() : '';
      const raw = rawMatch ? unescapeXmlText(rawMatch[1]).trim() : '';
      const provider = attrs['provider'] || '';
      const model = attrs['model'] || '';
      const url = attrs['url'] || '';
      const occurredAt = attrs['occurred-at'] || '';

      // 环境元信息以 data-* 暴露给复制委托（code-copy.ts 拼装 issue 报告用）
      const parts: string[] = [
        `<div class="api-error-card kind-${kind}"` +
          ` data-provider="${escapeHtml(provider)}"` +
          ` data-model="${escapeHtml(model)}"` +
          ` data-url="${escapeHtml(url)}"` +
          ` data-occurred-at="${escapeHtml(occurredAt)}">`,
      ];
      parts.push('<div class="api-error-head">');
      parts.push('<span class="api-error-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16" fill="currentColor"/></svg></span>');
      if (title) parts.push(`<span class="api-error-title">${escapeHtml(title)}</span>`);
      if (label) parts.push(`<span class="api-error-badge">${escapeHtml(label)}</span>`);
      // 协议 / 模型 / 端点收进「请求模型」浮层卡：顶栏只留状态与操作，
      // 长 URL 不再把徽章与操作按钮挤到换行
      const hasRequestModel = Boolean(provider || model || url);
      const requestModelBlock = hasRequestModel
        ? this.buildRequestModelBlock(provider, model, url)
        : '';
      // 一键复制结构化错误报告（分类/状态/摘要/原始响应 + 环境元信息）——
      // 反馈与提交 issue 即拷即用；走 document 级委托（见 code-copy.ts），符合扩展 CSP（无内联脚本）
      const copyLabel = t('sidepanel.chat.copyErrorLabel');
      const copiedLabel = t('sidepanel.chat.copiedLabel');
      const copyButton =
        `<button type="button" class="api-error-copy-btn"` +
        ` data-copy-idle-label="${escapeHtml(copyLabel)}"` +
        ` data-copy-done-label="${escapeHtml(copiedLabel)}">${escapeHtml(copyLabel)}</button>`;
      // 重试（主操作）：重新发起请求以继续会话；语义与守卫在应用层回调
      // （App.vue 的 retryFromErrorCard，委托见 api-error-retry.ts）——渲染层只发按钮
      const retryLabel = t('sidepanel.chat.apiErrorRetry');
      const retryTitle = t('sidepanel.chat.apiErrorRetryTitle');
      const retryButton =
        `<button type="button" class="api-error-retry-btn" title="${escapeHtml(retryTitle)}"` +
        ` aria-label="${escapeHtml(retryTitle)}">` +
        `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>` +
        `<span>${escapeHtml(retryLabel)}</span></button>`;
      // 操作按钮成组：窄侧边栏里顶栏放不下时整组换行，不会把状态标题挤没
      parts.push(
        `<span class="api-error-actions">${requestModelBlock}${retryButton}${copyButton}</span>`,
      );
      parts.push('</div>');
      if (summary) parts.push(`<div class="api-error-summary">${escapeHtml(summary)}</div>`);
      if (raw) parts.push(`<pre class="api-error-raw">${escapeHtml(raw)}</pre>`);
      parts.push('</div>');
      return parts.join('');
    } catch (error) {
      console.warn('[MarkdownRenderer] api-error 卡片解析失败，降级为原文展示:', error);
      // 专用兜底样式（.api-error-fallback）：不能复用 .api-error-raw——后者依赖
      // 卡片根节点上的 --ae-* 分类配色变量，脱离卡片容器时同类声明会被静默丢弃
      return `<pre class="api-error-fallback">${escapeHtml(block)}</pre>`;
    }
  }

  /**
   * 「请求模型」按钮 + 浮层卡（协议 / 模型 / 端点）。
   *
   * 这三项原先平铺在卡片顶栏右侧：长端点 URL 会把顶栏撑开、把状态徽章与
   * 操作按钮挤到换行，窄侧边栏里尤其明显。现改为单个按钮点开浮层卡，
   * 顶栏只保留状态与操作，定位信息按需展开。
   *
   * 协议展示名走驱动注册表（OpenAI / Ollama / …），未注册协议原样展示协议 id；
   * 协议 id 与展示名不同时并列展示，排查时既能看协议族也能看原始标识。
   *
   * 浮层内容全部来自已转义的结构化属性（provider / model / url），本模块不注入
   * 任何动态 HTML；显隐由 api-error-model.ts 的 document 级委托负责。
   */
  private buildRequestModelBlock(provider: string, model: string, url: string): string {
    const panelId = `api-error-model-panel-${++apiErrorModelPanelSeq}`;
    const protocolLabel = provider
      ? driverRegistry.tryGet(provider as ProviderType)?.meta.label || provider
      : '';
    // 展示名与协议 id 仅大小写不同时（如 Ollama / ollama）不必并列，重复信息反而杂乱
    const showRawProtocol =
      Boolean(protocolLabel) && protocolLabel.toLowerCase() !== provider.toLowerCase();

    // 行构造器：key 走 i18n 键值；valueHtml 为已转义的值 HTML（协议行可带
    // 并列 id 后缀，故收 HTML 而非纯文本），mono 控制是否用等宽字体
    const row = (key: string, valueHtml: string, mono: boolean): string =>
      `<div class="api-error-model-row">` +
      `<dt class="api-error-model-key">${escapeHtml(key)}</dt>` +
      `<dd class="api-error-model-val${mono ? ' api-error-model-mono' : ''}">${valueHtml}</dd>` +
      `</div>`;

    const rows: string[] = [];
    if (protocolLabel) {
      rows.push(
        row(
          t('sidepanel.chat.apiErrorModelProtocol'),
          escapeHtml(protocolLabel) +
            (showRawProtocol ? `<span class="api-error-model-id">${escapeHtml(provider)}</span>` : ''),
          false,
        ),
      );
    }
    if (model) {
      rows.push(row(t('sidepanel.chat.apiErrorModelModel'), escapeHtml(model), true));
    }
    if (url) {
      // 端点定位（多渠道场景「哪个地址出错」）；构造期已脱敏，密钥不会展示
      rows.push(row(t('sidepanel.chat.apiErrorModelUrl'), escapeHtml(url), true));
    }

    return (
      `<span class="api-error-model">` +
      `<button type="button" class="api-error-model-btn" aria-expanded="false"` +
      ` aria-controls="${escapeHtml(panelId)}">` +
      `<svg class="api-error-model-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>` +
      `<span class="api-error-model-btn-text">${escapeHtml(t('sidepanel.chat.apiErrorModelButton'))}</span>` +
      `<svg class="api-error-model-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>` +
      `</button>` +
      `<div class="api-error-model-panel" id="${escapeHtml(panelId)}" role="group"` +
      ` aria-label="${escapeHtml(t('sidepanel.chat.apiErrorModelTitle'))}" hidden>` +
      `<div class="api-error-model-panel-title">${escapeHtml(t('sidepanel.chat.apiErrorModelTitle'))}</div>` +
      `<dl class="api-error-model-list">${rows.join('')}</dl>` +
      `</div></span>`
    );
  }
}

// 导出默认实例
export const markdownRenderer = new MarkdownRenderer();

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
import { renderFileCards, installFileCardHandler } from './file-card';
import { installCodeCopyHandler } from './code-copy';
import { escapeHtml } from './html-escape';
import { unescapeXmlText } from '../xml-entities';
import { buildStatCardBlock } from './stat-card';
import { RICH_OUTPUT_ECHARTS_LANGS, RICH_OUTPUT_STAT_CARD_LANGS } from './rich-output-prompt';
import { t } from '@/utils/i18n/core';

// 文件下载委托 + 代码复制委托（均为幂等安装）；本模块只在 DOM 上下文被使用
installFileCardHandler();
installCodeCopyHandler();

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
  let text = '';

  for (const segment of splitByCodeSegments(source)) {
    if (segment.code) {
      text += segment.text;
      continue;
    }
    text += segment.text.replace(LATEX_PATTERN, (match, display: string | undefined, inline: string | undefined) => {
      const isDisplay = display !== undefined;
      const formula = (display ?? inline ?? '').trim();
      if (!formula) return match;
      const index = formulas.length;
      formulas.push(renderFormula(formula, isDisplay));
      return `ANLATEX${index}END${suffix}`;
    });
  }

  return { text, formulas };
}

// ==================== MarkdownIt 实例 ====================

/** 渲染选项接口 */
export interface RenderOptions {
  enableLatex?: boolean;
  enableMarkdown?: boolean;
  enableCodeHighlight?: boolean;
  enableMermaid?: boolean;
  /** 富内容组件（ECharts 图表 / 统计卡）围栏渲染开关 */
  enableRichCharts?: boolean;
  codeTheme?: string;
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

    // ── 代码块：整体由 fence 规则渲染，避免 markdown-it 默认的 <pre><code> 包裹
    //    与自定义容器嵌套产生的非法 HTML；同时不使用任何内联脚本 ──
    this.md.renderer.rules.fence = (tokens, idx) => {
      const token = tokens[idx];
      const lang = (token.info || '').trim().split(/\s+/)[0] || '';
      const code = token.content;

      // 图表围栏（Mermaid / PlantUML）→ 统一图表块容器：
      // 实际 SVG / <img> 由 diagram-renderer.ts 在 v-html 注入后异步渲染（库懒加载），
      // 源码以转义文本保存在隐藏 <pre> 中，作为「查看源码 / 复制」的唯一事实源
      if ((lang === 'mermaid' || lang === 'plantuml' || lang === 'puml') && this.mermaidEnabled) {
        return this.buildDiagramBlock(lang === 'mermaid' ? 'mermaid' : 'plantuml', code);
      }

      // ── 富内容围栏（ECharts 图表 / 统计卡；契约见 rich-output-prompt.ts）──
      // 图表：同 Mermaid 的「骨架 + 异步渲染」模式，沙箱 iframe 渲染由
      // chart-renderer.ts 在 v-html 注入后驱动；统计卡：纯可信 HTML 在渲染期
      // 同步产出（校验失败回落为普通代码块，源码可见、信息不丢）
      if (this.richChartsEnabled) {
        if (RICH_OUTPUT_ECHARTS_LANGS.includes(lang)) {
          return this.buildChartBlock(code);
        }
        if (RICH_OUTPUT_STAT_CARD_LANGS.includes(lang)) {
          const statHtml = buildStatCardBlock(code);
          if (statHtml !== null) {
            return statHtml;
          }
          // 校验失败 → 继续走普通代码块渲染（降级展示原始 JSON）
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

      // ── 3. 摘出 LaTeX 公式（在 Markdown 解析前完成，保证公式里的 < > & 不被转义）──
      let formulas: string[] = [];
      if (enableLatex) {
        const extracted = extractLatex(rendered, suffix);
        rendered = extracted.text;
        formulas = extracted.formulas;
      }

      // ── 4. Markdown 解析 ──
      if (enableMarkdown) {
        rendered = this.md.render(rendered);
      } else {
        rendered = escapeHtml(rendered);
      }

      // ── 5. 回填 LaTeX 公式（KaTeX 产物为可信 HTML）──
      if (formulas.length > 0) {
        formulas.forEach((formula, index) => {
          rendered = rendered.split(`ANLATEX${index}END${suffix}`).join(formula);
        });
      }

      // ── 6. 表格包裹滚动容器，防止撑破消息宽度 ──
      rendered = rendered.replace(/<table>/g, '<div class="table-scroll-wrapper"><table>');
      rendered = rendered.replace(/<\/table>/g, '</table></div>');

      // ── 7. 文件标记 → 可下载文件卡片 ──
      rendered = renderFileCards(rendered);

      // ── 8. 回填 <think> 推理段（内容转义：模型内容不得产生可执行标记）──
      thinkBlocks.forEach((content, index) => {
        const token = `ANTHINK${index}END${suffix}`;
        rendered = this.restoreToken(rendered, token, `<think>${escapeHtml(content)}</think>`);
      });

      // ── 9. 回填 <api-error> 错误卡片 ──
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
   * 图表围栏 → 统一图表块 HTML。DOM 契约（diagram-renderer.ts 依赖）：
   *
   *   <div class="diagram-block" data-diagram-kind="mermaid|plantuml" data-diagram-state="pending">
   *     <div class="diagram-header">
   *       <span class="diagram-lang-label">…</span>
   *       <button class="code-copy-btn" …>复制</button>        ← 复用代码块复制委托（code-copy.ts）
   *       <button class="diagram-toggle-btn" data-view-source-label data-view-chart-label>…</button>
   *     </div>
   *     <div class="diagram-body">…状态占位，异步渲染后替换为 SVG / <img>…</div>
   *     <pre class="diagram-source"><code>转义源码</code></pre>  ← 默认隐藏，切换/复制的事实源
   *   </div>
   *
   * 源码只以转义文本形态存在；.diagram-body 初始内容为无害占位文本，
   * 真正的图表产物由 diagram-renderer 注入（Mermaid strict 模式 / 远程 SVG 图片）。
   */
  private buildDiagramBlock(kind: 'mermaid' | 'plantuml', code: string): string {
    const label =
      kind === 'mermaid'
        ? t('sidepanel.chat.diagramMermaidLabel')
        : t('sidepanel.chat.diagramPlantumlLabel');
    const copyLabel = t('sidepanel.chat.copyLabel');
    const copiedLabel = t('sidepanel.chat.copiedLabel');
    const viewSourceLabel = t('sidepanel.chat.diagramViewSource');
    const viewChartLabel = t('sidepanel.chat.diagramViewChart');
    return (
      `<div class="diagram-block" data-diagram-kind="${kind}" data-diagram-state="pending">` +
      `<div class="diagram-header">` +
      `<span class="diagram-lang-label">${escapeHtml(label)}</span>` +
      `<button type="button" class="code-copy-btn diagram-copy-btn"` +
      ` data-copy-idle-label="${escapeHtml(copyLabel)}"` +
      ` data-copy-done-label="${escapeHtml(copiedLabel)}">${escapeHtml(copyLabel)}</button>` +
      `<button type="button" class="diagram-toggle-btn" aria-pressed="false"` +
      ` data-view-source-label="${escapeHtml(viewSourceLabel)}"` +
      ` data-view-chart-label="${escapeHtml(viewChartLabel)}">${escapeHtml(viewSourceLabel)}</button>` +
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
   *   <div class="chart-block" data-chart-kind="echarts" data-chart-state="pending">
   *     <div class="chart-header">
   *       <span class="chart-lang-label">…</span>
   *       <button class="code-copy-btn chart-copy-btn" …>复制</button>   ← 复用代码块复制委托
   *       <button class="chart-toggle-btn" data-view-source-label data-view-chart-label>…</button>
   *     </div>
   *     <div class="chart-body">…状态占位，chart-renderer 注入沙箱 iframe…</div>
   *     <pre class="chart-source"><code>转义源码</code></pre>  ← 默认隐藏，切换/复制的事实源
   *   </div>
   *
   * 源码只以转义文本形态存在；.chart-body 初始内容为无害占位文本，
   * 真正的图表产物由沙箱页内 ECharts 渲染（见 chart-renderer.ts 安全模型）。
   */
  private buildChartBlock(code: string): string {
    const label = t('sidepanel.chat.chartEchartsLabel');
    const copyLabel = t('sidepanel.chat.copyLabel');
    const copiedLabel = t('sidepanel.chat.copiedLabel');
    const viewSourceLabel = t('sidepanel.chat.chartViewSource');
    const viewChartLabel = t('sidepanel.chat.chartViewChart');
    return (
      `<div class="chart-block" data-chart-kind="echarts" data-chart-state="pending">` +
      `<div class="chart-header">` +
      `<span class="chart-lang-label">${escapeHtml(label)}</span>` +
      `<button type="button" class="code-copy-btn chart-copy-btn"` +
      ` data-copy-idle-label="${escapeHtml(copyLabel)}"` +
      ` data-copy-done-label="${escapeHtml(copiedLabel)}">${escapeHtml(copyLabel)}</button>` +
      `<button type="button" class="chart-toggle-btn" aria-pressed="false"` +
      ` data-view-source-label="${escapeHtml(viewSourceLabel)}"` +
      ` data-view-chart-label="${escapeHtml(viewChartLabel)}">${escapeHtml(viewSourceLabel)}</button>` +
      `</div>` +
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
   * <api-error> XML 块 → 样式化错误卡片 HTML。
   * 结构（发射侧见 utils/stream/errors.ts 的 toApiErrorBlock）：
   *   <api-error kind="http" status="429" title="HTTP 429" label="限流" provider="openai" model="gpt-4o" occurred-at="ISO">
   *     <summary>单行摘要</summary>
   *     <raw>完整原始响应</raw>
   *   </api-error>
   * 所有展示文本一律 HTML 转义；解析失败的块降级为 <pre> 展示原文（信息不丢）。
   * model / occurred-at 同时以 data-* 暴露给复制委托，拼装「可直接提交 issue」的报告。
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

      const kind = attrs['kind'] || 'error';
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
        `<div class="api-error-card kind-${escapeHtml(kind)}"` +
          ` data-model="${escapeHtml(model)}"` +
          ` data-occurred-at="${escapeHtml(occurredAt)}">`,
      ];
      parts.push('<div class="api-error-head">');
      parts.push('<span class="api-error-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16" fill="currentColor"/></svg></span>');
      if (title) parts.push(`<span class="api-error-title">${escapeHtml(title)}</span>`);
      if (label) parts.push(`<span class="api-error-badge">${escapeHtml(label)}</span>`);
      if (provider) parts.push(`<span class="api-error-provider">${escapeHtml(provider)}</span>`);
      if (model) parts.push(`<span class="api-error-provider">${escapeHtml(model)}</span>`);
      // 端点定位（多渠道场景「哪个地址出错」）；构造期已脱敏，密钥不会展示
      if (url) {
        parts.push(
          `<span class="api-error-provider api-error-url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>`,
        );
      }
      // 一键复制结构化错误报告（分类/状态/摘要/原始响应 + 环境元信息）——
      // 反馈与提交 issue 即拷即用；走 document 级委托（见 code-copy.ts），符合扩展 CSP（无内联脚本）
      const copyLabel = t('sidepanel.chat.copyErrorLabel');
      const copiedLabel = t('sidepanel.chat.copiedLabel');
      parts.push(
        `<button type="button" class="api-error-copy-btn"` +
        ` data-copy-idle-label="${escapeHtml(copyLabel)}"` +
        ` data-copy-done-label="${escapeHtml(copiedLabel)}">${escapeHtml(copyLabel)}</button>`,
      );
      parts.push('</div>');
      if (summary) parts.push(`<div class="api-error-summary">${escapeHtml(summary)}</div>`);
      if (raw) parts.push(`<pre class="api-error-raw">${escapeHtml(raw)}</pre>`);
      parts.push('</div>');
      return parts.join('');
    } catch (error) {
      console.warn('[MarkdownRenderer] api-error 卡片解析失败，降级为原文展示:', error);
      return `<pre class="api-error-raw">${escapeHtml(block)}</pre>`;
    }
  }
}

// 导出默认实例
export const markdownRenderer = new MarkdownRenderer();

/**
 * 同步信封组件构建器（stat / table / timeline / tree）+ diff 围栏构建器
 *
 * 与 stat-card.ts 同一信任模型：模型内容在本模块只经历
 * 「envelope 归一化（envelope.ts）→ 受控模板拼装 + 全量 escapeHtml」
 * 一条路径，产物是纯可信 HTML（没有任何模型字符串进入标签 / 属性 /
 * class 位置——class 一律来自固定枚举），因此可在扩展页内同步渲染。
 * 构建失败返回 null，调用方（markdown-renderer fence 规则）回落为普通
 * 代码块展示源码，信息不丢。
 *
 * DOM 契约（chat-message-list.css 按此着色）：
 *   .component-block .component-block-title         — 通用容器 + 标题
 *   .component-table-block table.component-data-table — thead/tbody；数值列 .num；
 *     状态单元格 .st-good/.st-warn/.st-bad/.st-doing（关键词命中才加）
 *   .component-timeline-block .tl-item(.done/.active/.todo/.fail) — 节点 + 主文 + 元信息
 *   .component-tree-block .tree-row[data-depth]     — 缩进层级（padding 由宿主计算）
 *   .diff-block .diff-line.add/.del/.meta           — unified diff 行级着色
 */

import { escapeHtml } from '../html-escape';
import { TREND_ARROW_SVG } from '../stat-card';
import { t } from '@/utils/i18n/core';
import type { NormalizedEnvelope, RichCell } from './envelope';

/** stat 组件行数上限（与 legacy stat-card zod 契约一致；超限降级源码） */
const STAT_MAX_ROWS = 6;
/** tree 路径层级上限（更深按 10 层截断显示，防病态深路径撑爆） */
const TREE_MAX_DEPTH = 10;
/** diff 源码上限 */
const DIFF_MAX_CHARS = 60_000;
const DIFF_MAX_LINES = 1_500;

// ==================== 状态关键词（class 枚举的唯一入口，模型文本永不进 class） ====================

interface StatusStyle {
  cls: string;
  pattern: RegExp;
}

/** 命中顺序即优先级：bad > warn > doing > good（「修复失败」含「修复」不误判） */
const STATUS_STYLES: readonly StatusStyle[] = [
  { cls: 'st-bad', pattern: /失败|错误|异常|超标|离线|崩溃|fail|error|critical|fatal/i },
  { cls: 'st-warn', pattern: /待优化|警告|注意|降级|偏慢|warn|degraded|slow/i },
  { cls: 'st-doing', pattern: /进行中|处理中|加载中|运行中|排队|loading|running|pending|active|in\s*progress/i },
  { cls: 'st-good', pattern: /完成|通过|良好|成功|在线|达标|已修复|✓|✔|done|pass(?:ed)?|success|ok|online|healthy/i },
];

/** 单元格文本的状态样式类（未命中返回空串） */
function statusClassOf(value: RichCell): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > 30) return '';
  for (const style of STATUS_STYLES) {
    if (style.pattern.test(text)) return style.cls;
  }
  return '';
}

/** 单元格文本化（null → 占位破折号，避免空 td 塌陷；表格展示位专用） */
function cellDisplay(value: RichCell): string {
  if (value === null) return '—';
  return String(value);
}

/** 单元格纯文本（null → 空串；主文 / 路径 / 元信息判断位专用，不吃占位符） */
function plainText(value: RichCell): string {
  if (value === null) return '';
  return String(value).trim();
}

// ==================== 通用容器 ====================

function wrapBlock(extraClass: string, title: string, inner: string): string {
  return (
    `<div class="component-block ${extraClass}">` +
    (title ? `<div class="component-block-title">${escapeHtml(title)}</div>` : '') +
    inner +
    `</div>\n`
  );
}

// ==================== stat（信封 → 复用统计卡 DOM 契约） ====================

/**
 * 信封 stat → 统计卡组。产出与 stat-card.ts 完全一致的 DOM
 * （.stat-card-block / .stat-cards / .stat-card…），零新增样式。
 * 列语义：1=指标名 2=当前值 3=变化（+/- 前缀驱动涨跌方向）4=可选说明。
 * 超过 6 行判建模错误（>6 个指标应改用 table），降级源码。
 */
function buildStatBlock(env: NormalizedEnvelope): string | null {
  if (env.rows.length > STAT_MAX_ROWS) return null;

  const cards: string[] = [];
  for (const row of env.rows) {
    const label = row[0] === null ? '' : String(row[0]).trim();
    const value = row[1] === null ? '' : String(row[1]).trim();
    if (!label || !value) continue;
    const trendText = typeof row[2] === 'string' ? row[2].trim() : '';
    const note = typeof row[3] === 'string' ? row[3].trim() : '';

    const parts: string[] = ['<div class="stat-card">'];
    parts.push(`<div class="stat-card-label">${escapeHtml(label)}</div>`);
    parts.push(`<div class="stat-card-value">${escapeHtml(value)}</div>`);
    // 涨跌方向只由 +/- 前缀驱动；「持平」等中性文本不渲染箭头
    if (trendText && (trendText.startsWith('+') || trendText.startsWith('-'))) {
      const direction = trendText.startsWith('-') ? 'down' : 'up';
      parts.push(
        `<div class="stat-card-trend ${direction}">${TREND_ARROW_SVG}` +
          `<span>${escapeHtml(trendText)}</span></div>`,
      );
    }
    if (note) {
      parts.push(`<div class="stat-card-note">${escapeHtml(note)}</div>`);
    }
    parts.push('</div>');
    cards.push(parts.join(''));
  }
  if (cards.length === 0) return null;

  return (
    `<div class="stat-card-block">` +
    (env.title ? `<div class="stat-card-block-title">${escapeHtml(env.title)}</div>` : '') +
    `<div class="stat-cards">${cards.join('')}</div>` +
    `</div>\n`
  );
}

// ==================== table ====================

/**
 * 数值列判定：非空单元格中可解析数值占比 ≥ 70% 且非空 ≥ 2 个。
 * 右对齐 + 等宽字体由 .num 类承担。
 */
function isNumericColumn(rows: RichCell[][], colIndex: number): boolean {
  let nonNull = 0;
  let numeric = 0;
  for (const row of rows) {
    const cell = row[colIndex];
    if (cell === null || cell === '') continue;
    nonNull++;
    if (typeof cell === 'number') numeric++;
    else if (typeof cell === 'string' && /^[+-]?(\d+(\.\d+)?|\.\d+)/.test(cell.trim())) numeric++;
  }
  return nonNull >= 2 && numeric / nonNull >= 0.7;
}

/**
 * 信封 table → 富表格。
 * 注意：<table> 必须带 class（component-data-table）——markdown 渲染期的
 * wrapTables 会按字面 `<table>` 匹配并包工具栏，带属性即不匹配。
 */
function buildTableBlock(env: NormalizedEnvelope): string | null {
  const numericCols = env.columns.map((_, index) => isNumericColumn(env.rows, index));

  const head = env.columns
    .map((col, index) => `<th${numericCols[index] ? ' class="num"' : ''}>${escapeHtml(col || `列${index + 1}`)}</th>`)
    .join('');

  const body = env.rows
    .map(row =>
      `<tr>${row
        .map((cell, index) => {
          const statusCls = statusClassOf(cell);
          const classes = [numericCols[index] ? 'num' : '', statusCls].filter(Boolean).join(' ');
          return `<td${classes ? ` class="${classes}"` : ''}>${escapeHtml(cellDisplay(cell))}</td>`;
        })
        .join('')}</tr>`,
    )
    .join('');

  return wrapBlock(
    'component-table-block',
    env.title,
    `<div class="component-table-scroll"><table class="component-data-table">` +
      `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
  );
}

// ==================== timeline ====================

/**
 * 信封 timeline → 纵向时间轴。
 * 列语义（宽松）：状态列按列名（含「状态/status」）识别，其余列依次作为
 * 主文与元信息；状态样式只从状态列读取，避免「完成度 30%」这类正文误判。
 */
function buildTimelineBlock(env: NormalizedEnvelope): string | null {
  const statusCol = env.columns.findIndex(col => /状态|status/i.test(col));
  const labelCols = env.columns.map((_, index) => index).filter(index => index !== statusCol);

  const items: string[] = [];
  for (const row of env.rows) {
    const statusCell = statusCol >= 0 ? row[statusCol] : null;
    const statusCls = statusClassOf(statusCell);
    const stateClass =
      statusCls === 'st-good' ? 'done' :
      statusCls === 'st-doing' ? 'active' :
      statusCls === 'st-bad' ? 'fail' :
      statusCls === 'st-warn' ? 'warn' : 'todo';

    const primary = labelCols
      .slice(0, 2)
      .map(index => plainText(row[index]))
      .filter(Boolean)
      .join(' · ');
    if (!primary) continue;
    const meta = labelCols
      .slice(2)
      .map(index => plainText(row[index]))
      .filter(Boolean)
      .map(text => escapeHtml(text))
      .join('<span class="tl-meta-sep">·</span>');

    items.push(
      `<li class="tl-item ${stateClass}">` +
        `<span class="tl-dot" aria-hidden="true"></span>` +
        `<div class="tl-content">` +
        `<span class="tl-title">${escapeHtml(primary)}</span>` +
        (meta ? `<span class="tl-meta">${meta}</span>` : '') +
        `</div></li>`,
    );
  }
  if (items.length === 0) return null;

  return wrapBlock('component-timeline-block', env.title, `<ul class="tl-list">${items.join('')}</ul>`);
}

// ==================== tree ====================

/**
 * 信封 tree → 缩进结构树（平铺行 + 宿主计算的缩进，无交互、无嵌套构建——
 * 对任意顺序的输入都稳定）。第 1 列路径（/ 分隔），第 2 列可选备注。
 */
function buildTreeBlock(env: NormalizedEnvelope): string | null {
  const rows: string[] = [];
  const seen = new Set<string>();
  for (const row of env.rows) {
    const rawPath = plainText(row[0]);
    if (!rawPath) continue;
    const segments = rawPath.split(/[/\\]+/).map(s => s.trim()).filter(Boolean);
    if (segments.length === 0) continue;
    const path = segments.join('/');
    if (seen.has(path)) continue;
    seen.add(path);

    const depth = Math.min(segments.length, TREE_MAX_DEPTH);
    const label = segments[segments.length - 1];
    const isBranch = /[\\/]\s*$/.test(rawPath) || segments.length > 1;
    const note = plainText(row[1]);

    rows.push(
      `<div class="tree-row${isBranch ? ' tree-branch' : ''}" data-depth="${depth}"` +
        ` style="padding-left:${(depth - 1) * 16 + 8}px">` +
        `<span class="tree-glyph" aria-hidden="true"></span>` +
        `<span class="tree-label">${escapeHtml(label)}</span>` +
        (note ? `<span class="tree-note">${escapeHtml(note)}</span>` : '') +
        `</div>`,
    );
  }
  if (rows.length === 0) return null;

  return wrapBlock('component-tree-block', env.title, `<div class="tree-list">${rows.join('')}</div>`);
}

// ==================== 统一分发 ====================

/** 信封 → 同步组件 HTML；类型不属于同步集或结构不满足返回 null（降级源码） */
export function buildEnvelopeComponentBlock(env: NormalizedEnvelope): string | null {
  switch (env.type) {
    case 'stat':
      return buildStatBlock(env);
    case 'table':
      return buildTableBlock(env);
    case 'timeline':
      return buildTimelineBlock(env);
    case 'tree':
      return buildTreeBlock(env);
    default:
      return null;
  }
}

// ==================== diff（原生围栏，非信封） ====================

/**
 * ```diff 围栏 → 行级着色 diff 块（unified diff 语法；任何文本都可着色，
 * 无失败路径——着不了色的行按上下文展示）。头部带 +N −M 统计徽标。
 */
export function buildDiffBlock(code: string): string {
  const text = (code ?? '').slice(0, DIFF_MAX_CHARS).replace(/\r\n/g, '\n');
  const lines = text.split('\n').slice(0, DIFF_MAX_LINES);

  let added = 0;
  let removed = 0;
  const lineHtml: string[] = [];
  for (const line of lines) {
    let cls = 'ctx';
    if (line.startsWith('+++') || line.startsWith('---')) {
      cls = 'meta';
    } else if (line.startsWith('+')) {
      cls = 'add';
      added++;
    } else if (line.startsWith('-')) {
      cls = 'del';
      removed++;
    } else if (line.startsWith('@@')) {
      cls = 'meta';
    }
    lineHtml.push(`<span class="diff-line ${cls}">${escapeHtml(line) || ' '}</span>`);
  }
  if (text.length > DIFF_MAX_CHARS || lines.length >= DIFF_MAX_LINES) {
    lineHtml.push(`<span class="diff-line meta">…（内容过长已截断）</span>`);
  }

  return (
    `<div class="diff-block">` +
    `<div class="diff-header">` +
    `<span class="diff-label">${escapeHtml(t('sidepanel.chat.componentDiffLabel'))}</span>` +
    `<span class="diff-stats"><span class="diff-add-count">+${added}</span>` +
    `<span class="diff-del-count">−${removed}</span></span>` +
    `</div>` +
    `<pre class="diff-body">${lineHtml.join('')}</pre>` +
    `</div>\n`
  );
}

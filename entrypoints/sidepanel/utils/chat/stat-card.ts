/**
 * 统计卡（KPI 卡片组）渲染器 —— 由 ```stat-card 围栏块驱动
 *
 * 信任边界：模型内容在本文件中只经历「JSON.parse → zod 结构校验 →
 * 全量 HTML 转义 → 受控模板拼装」一条路径，产物是纯可信 HTML
 * （没有任何模型字符串直接进入标签 / 属性位置），因此可以安全地在
 * 扩展页内同步渲染（无需沙箱）。校验失败返回 null，调用方
 * （markdown-renderer fence 规则）回落为普通代码块展示源码，信息不丢。
 *
 * 流式友好：纯字符串函数、无异步依赖——围栏一旦闭合即在 Markdown
 * 渲染期同步产出，流式 token 重排时反复重算成本可忽略。
 */

import { z } from 'zod';
import { escapeHtml } from './html-escape';

/** 围栏源码最大字符数（超出直接判失败，防异常巨型输出拖慢渲染） */
const MAX_SOURCE_CHARS = 8_000;

// ==================== 结构契约（zod，字段上限即展示层合理上限） ====================

/** 趋势：direction 只允许 up / down（映射为固定样式类，非模型可控字符串） */
const TrendSchema = z.object({
  direction: z.enum(['up', 'down']),
  value: z.union([z.string(), z.number()]).transform(String),
});

/** 单张卡片：label/value 必填，unit/trend/note 可选；全部为短文本 */
const StatCardItemSchema = z.object({
  label: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(60)),
  value: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(40)),
  unit: z.string().max(12).optional(),
  trend: TrendSchema.optional(),
  note: z.string().max(80).optional(),
});

/** 卡片组：2~6 张（1 张时模型应直接用文字表达；>6 张应改用表格） */
export const StatCardSchema = z.object({
  title: z.string().max(60).optional(),
  items: z.array(StatCardItemSchema).min(1).max(6),
});

export type StatCardData = z.infer<typeof StatCardSchema>;

// ==================== 渲染 ====================

/** 趋势箭头：内联 SVG（与代码库其他组件一致，不依赖字体符号） */
const TREND_ARROW_SVG =
  '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6,1.5L11,10H1Z" fill="currentColor"/></svg>';

/** 单张卡片 HTML（所有模型文本经 escapeHtml 进入） */
function buildCard(item: z.infer<typeof StatCardItemSchema>): string {
  const parts: string[] = ['<div class="stat-card">'];
  parts.push(`<div class="stat-card-label">${escapeHtml(item.label)}</div>`);
  parts.push(
    `<div class="stat-card-value">${escapeHtml(item.value)}` +
      (item.unit ? `<span class="stat-card-unit">${escapeHtml(item.unit)}</span>` : '') +
      `</div>`,
  );
  if (item.trend) {
    const direction = item.trend.direction === 'down' ? 'down' : 'up';
    parts.push(
      `<div class="stat-card-trend ${direction}">${TREND_ARROW_SVG}` +
        `<span>${escapeHtml(item.trend.value)}</span></div>`,
    );
  }
  if (item.note) {
    parts.push(`<div class="stat-card-note">${escapeHtml(item.note)}</div>`);
  }
  parts.push('</div>');
  return parts.join('');
}

/**
 * 把 ```stat-card 围栏源码渲染为可信 HTML。
 * 解析 / 校验失败（含超长）返回 null —— 调用方回落为普通代码块，
 * 模型原始输出对用户仍然可见、可复制。
 */
export function buildStatCardBlock(code: string): string | null {
  const text = (code ?? '').trim();
  if (!text || text.length > MAX_SOURCE_CHARS) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const result = StatCardSchema.safeParse(parsed);
  if (!result.success) return null;
  const data: StatCardData = result.data;

  const parts: string[] = ['<div class="stat-card-block">'];
  if (data.title) {
    parts.push(`<div class="stat-card-block-title">${escapeHtml(data.title)}</div>`);
  }
  parts.push('<div class="stat-cards">');
  for (const item of data.items) {
    parts.push(buildCard(item));
  }
  parts.push('</div></div>');
  return parts.join('');
}

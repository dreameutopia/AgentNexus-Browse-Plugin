/**
 * 用户消息气泡「超长自动收起」规则（纯函数，领域规则的唯一事实源）
 *
 * 规则：
 *   - 用户消息气泡只保留 USER_MESSAGE_MAX_LINES 行正文，超出部分自动收起；
 *   - 收起态由渲染层给出「展开全文」入口，用户点击后展开完整正文；
 *   - 折叠高度 = 行数上限 × **实测行高**——行高随字号 / 主题 / 排版变化，
 *     运行时测量而不写死在 CSS 里，避免与 .message-content 的排版常量脱钩
 *     （写死像素会在用户放大字号时提前截断，或字号变小时多留半行空白）。
 *
 * 与「模型消息折叠」（utils/chat/part-grouping.ts）是两件事：那条规则折叠
 * 的是模型回复里的过程内容（推理 / 工具 / 截图），本模块折叠的是**用户自己
 * 输入的正文**——用户随时可以展开，两条规则互不干涉。
 *
 * 为什么独立成模块：折叠阈值与溢出判定是跨组件（气泡组件 / 预览页 / 单测）
 * 共用的领域口径，写在组件里既无法复用也无法直接测试。
 */

/** 用户消息气泡保留的最大行数（正文超出即自动收起） */
export const USER_MESSAGE_MAX_LINES = 6;

/**
 * 行高兜底比例（与 .message-content 的 line-height: 1.75 对齐）。
 * 仅在浏览器给不出可用行高时启用（无单位 line-height 的旧内核 / 测试宿主）。
 */
export const DEFAULT_LINE_HEIGHT_RATIO = 1.75;

/** 字号兜底值（px）：与 .message-content 的 font-size: 14px 对齐 */
export const DEFAULT_FONT_SIZE_PX = 14;

/**
 * 溢出判定容差（px）。
 * scrollHeight 取整与亚像素排版会带来 1px 级误差，不能据此判成溢出。
 */
export const OVERFLOW_TOLERANCE_PX = 1;

/**
 * 解析行高（px）。
 *
 * computed line-height 有三种可能形态，全部要给出可用的像素行高：
 *   - '24.5px'（浏览器对定值 / 无单位 line-height 的计算值）→ 直接取用；
 *   - '1.75'（部分宿主保留无单位比例）→ 比例 × 字号；
 *   - '' / 'normal'（未设置）→ 兜底比例 × 字号。
 */
export function resolveLineHeightPx(computedLineHeight: string, fontSizePx: number): number {
  const raw = String(computedLineHeight ?? '').trim();
  const size = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : DEFAULT_FONT_SIZE_PX;

  if (raw.endsWith('px')) {
    const px = Number.parseFloat(raw);
    if (Number.isFinite(px) && px > 0) return px;
  }

  const ratio = raw && raw !== 'normal' ? Number.parseFloat(raw) : Number.NaN;
  if (Number.isFinite(ratio) && ratio > 0) return ratio * size;

  return size * DEFAULT_LINE_HEIGHT_RATIO;
}

/**
 * 折叠高度（px）：行数上限 × 行高（向上取整，避免最后一行被切掉半个像素）。
 * 行数上限与行高非法时回落到默认口径，绝不返回 0（否则正文被完全截断）。
 */
export function computeClampHeightPx(
  lineHeightPx: number,
  maxLines: number = USER_MESSAGE_MAX_LINES,
): number {
  const lines = Number.isFinite(maxLines) && maxLines > 0 ? maxLines : USER_MESSAGE_MAX_LINES;
  const height =
    Number.isFinite(lineHeightPx) && lineHeightPx > 0 ? lineHeightPx : DEFAULT_FONT_SIZE_PX * DEFAULT_LINE_HEIGHT_RATIO;
  return Math.ceil(height * lines);
}

/**
 * 正文是否超出折叠阈值（超出才需要收起并提供展开入口）。
 * 测量值非法时按「不溢出」处理——宁可多显示几行，也不把正文藏起来。
 */
export function isContentOverflowing(contentHeightPx: number, clampHeightPx: number): boolean {
  if (!Number.isFinite(contentHeightPx) || !Number.isFinite(clampHeightPx)) return false;
  return contentHeightPx > clampHeightPx + OVERFLOW_TOLERANCE_PX;
}

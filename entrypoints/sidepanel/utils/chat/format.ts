/**
 * 行内紧凑数值格式化（展示层共用唯一实现）。
 *
 * 抽取自三处逐字重复的实现（App.vue 的 formatTokensK、ToolCallItem 与
 * CompactionItem 各自的耗时标签）：同一换算口径（token K = 1024，与上下文
 * 阈值 256K = 262144 同源；耗时 <1s 毫秒整数 / ≥1s 秒一位小数）必须只有
 * 一份实现——任何口径漂移都会让「压缩前后」「消息体积 vs 预算」这类对比
 * 文案在两个组件里读出不同的数字。
 *
 * 输入防御：非有限值 / 负数（token 额外拒绝 ≤0）返回空串，调用方据此隐藏
 * 展示，绝不把 NaN / 负数 / 0 token 渲染到界面上。需要「0」而非空串的
 * 场景（如预算告警文案）由调用方以 `|| '0'` 兜底，语义显式留在调用点。
 */

/**
 * token 数人性化（K = 1024 token，与上下文阈值 256K = 262144 同一换算，
 * 保证「压缩前后」「消息体积 vs 预算」等对比文案与圆环读数量纲一致）。
 */
export function formatTokensK(tokens: number | undefined | null): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return '';
  return tokens < 1024 ? `${Math.round(tokens)}` : `${(tokens / 1024).toFixed(1)}K`;
}

/**
 * 行内耗时标签（工具行 / 压缩行共用）：<1s 显示毫秒整数，≥1s 保留一位小数。
 * 分钟以上的可读分档（"2 分 15 秒"）走 duration.ts 的 formatDuration——
 * 行内标签刻意停在秒级，保持单行紧凑；两处口径的分工见各自调用点。
 */
export function formatCompactDuration(ms: number | undefined | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 消息执行耗时格式化（展示层唯一实现）
 *
 * 分档口径（对标主流 AI 应用的消息耗时展示；先按四舍五入总秒数分档，
 * 避免 59_999ms → "60.0s"、3_599_999ms → "60 分 0 秒" 这类别扭边界）：
 *   - < 1s      → 毫秒整数（"860ms"）：亚秒级不值得升位到秒的小数；
 *   - < 1min    → 秒 + 1 位小数（"12.3s"）：ChatGPT / Gemini 同款粒度；
 *   - < 1h      → 分 + 秒（"2 分 15 秒" / "2m 15s"）：读秒会得到 "134.2s"
 *                 这类不利于扫读的数字；
 *   - ≥ 1h      → 时 + 分（"2 小时 5 分" / "2h 5m"）：守卫多次确认续跑的
 *                 长任务可达数小时，纯分钟数（"3000 分"）不可读。
 *
 * 输入防御：非有限值 / 负数返回空串——调用方（MessageItem）据此隐藏耗时
 * 展示，绝不把 NaN / 负时长渲染到界面上。
 *
 * 本地化：走 Vue 侧 t（读取 vue-i18n locale），语言切换后依赖它的 computed
 * 自动重算；分钟/小时档文案见 sidepanel.chat.durationMinutes / durationHours。
 */

import { t } from '@/utils/i18n';

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`;
  if (totalSeconds < 3600) {
    return t('sidepanel.chat.durationMinutes', {
      minutes: Math.floor(totalSeconds / 60),
      seconds: totalSeconds % 60,
    });
  }
  return t('sidepanel.chat.durationHours', {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
  });
}

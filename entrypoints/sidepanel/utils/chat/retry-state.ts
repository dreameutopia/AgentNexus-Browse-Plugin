/** Stable wire error; the view translates it into the application dialog. */
export const API_ERROR_RETRY_EXPIRED = 'API_ERROR_RETRY_EXPIRED';
/** Guard-stop continue became stale before the run could start (engine-side recheck). */
export const API_ERROR_CONTINUE_EXPIRED = 'API_ERROR_CONTINUE_EXPIRED';

export interface ApiErrorRetryRequest {
  chatId: string;
  messageId: string;
  content: string;
}

/**
 * 守卫停止注记上的「继续」请求。
 *
 * 与 API 错误重试同构：只允许在「中断后没有任何后续输出」时发起。
 * 应用层先按当前消息列表做即时校验，引擎在运行开始时再对最新落库记录
 * 复核一次（双保险，覆盖校验与入档之间的竞态）。
 */
export interface GuardContinueRequest {
  chatId: string;
  /** 守卫停止注记所属的助手消息 */
  messageId: string;
  /** notice 片段在 record.parts 中的原始下标 */
  partIndex: number;
  /** 期望的注记全文（与片段 content 逐字比对） */
  expectedNotice: string;
}

/**
 * XML 实体转义/反转义（跨层共享的唯一实现）
 *
 * 使用方（转义与反转义必须成对出现，语义不允许实现漂移）：
 *   - utils/stream/errors.ts            发射侧：错误卡片 XML 的属性与正文转义
 *   - core/context/context-engine.ts    消费侧：卡片摘要反转义（模型面清洗）
 *   - utils/chat/markdown-renderer.ts   消费侧：卡片属性/摘要反转义（UI 展示）
 *
 * 顺序约定：
 *   - 转义 & 最先（防止二次转义）、其余实体随后；
 *   - 反转义 &amp; 最后（防止「&amp;lt;」被解成「<」的两段式误还原）。
 */

/** XML 文本转义：& < > " ' → 预定义实体 */
export function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** XML 文本反转义：预定义实体 → 原字符（&amp; 最后还原） */
export function unescapeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

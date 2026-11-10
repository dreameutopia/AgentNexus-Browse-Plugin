/**
 * 网页引用（待引用 / 已引用）领域模块
 *
 * 职责边界（纯函数，无 IO、无响应式状态）：
 *   - 引用来源与正文的归一（URL / 标题 / 选区文本）
 *   - 引用信封（<page_quote> XML）的装配
 *
 * 状态机（pending → confirmed → 取消 / 发送消耗）由 App.vue 持有：
 * 本模块只提供「装配口径」与「归一规则」，避免状态与展示耦合。
 *
 * 与 <upload_file> 信封同构：信封只进模型面用户消息，不落用户可见转录
 * （转录只存用户自己的输入），因此引用原文不会在会话里重复占位。
 */

import { escapeXmlText } from '../xml-entities';

/** 引用信封根标签（模型面契约；改动须同步模型侧口径说明） */
export const PAGE_QUOTE_TAG = 'page_quote';

/**
 * 引用正文的字符上限。
 *
 * 选区可能是一整篇文章：全量进上下文会挤爆预算并触发发送前体积拦截
 * （整条消息被拒绝，用户什么都发不出去）。截断后模型仍可经
 * browser_get_page_text 回读页面原文，语义不丢。
 */
export const PAGE_QUOTE_MAX_CHARS = 8000;

/** 截断标记（模型面可见：明示正文不完整，提示回读页面） */
const TRUNCATION_MARKER = '……（引用原文已截断，完整内容请回读当前页面）';

/** 引用来源（选区所在页面） */
export interface PageQuoteSource {
  /** 顶层页面地址（iframe 内的选区也记顶层页面：用户看到的是那个页面） */
  url: string;
  /** 页面标题 */
  title: string;
}

/** 一条引用（选区原文 + 来源） */
export interface PageQuote {
  /** 用户选中的原文 */
  text: string;
  /** 来源页面 */
  source: PageQuoteSource;
}

/**
 * 引用态：
 *   - pending  = 待引用：已捕获选区，等待用户点「确认引用」
 *   - confirmed = 已引用：用户已确认，随本轮消息以 <page_quote> 信封发送
 */
export type PageQuoteState = 'pending' | 'confirmed';

/**
 * 来源归一：只保留可用字段。
 * 缺失时退化为空串而非 'undefined' / 'null' 字面量（信封里出现这两个词
 * 会让模型误以为页面地址真的写着 "undefined"）。
 */
export function normalizePageQuoteSource(
  url?: string | null,
  title?: string | null,
): PageQuoteSource {
  return {
    url: typeof url === 'string' ? url.trim() : '',
    title: typeof title === 'string' ? title.trim() : '',
  };
}

/** 引用正文归一：去首尾空白；超长按上限截断并追加截断标记 */
export function normalizeQuoteText(text: string): string {
  const trimmed = (text ?? '').trim();
  if (trimmed.length <= PAGE_QUOTE_MAX_CHARS) return trimmed;
  return trimmed.slice(0, PAGE_QUOTE_MAX_CHARS) + TRUNCATION_MARKER;
}

/**
 * 来源展示：页面标题优先，其次取 URL 的主机名（标题缺失时至少让人认得出
 * 引用来自哪个站），都没有则返回空串（由展示层回落到中性文案）。
 */
export function pageQuoteSourceDisplay(quote: PageQuote): string {
  const title = quote.source.title.trim();
  if (title) return title;
  const url = quote.source.url.trim();
  if (!url) return '';
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/**
 * 装配引用信封（纯数据，不夹带指令）：
 *
 *   <page_quote>
 *   <source_url>https://example.com/a</source_url>
 *   <source_title>页面标题</source_title>
 *   <quote_text>用户选中的原文</quote_text>
 *   </page_quote>
 *
 * 标签语义即契约：<quote_text> 是用户从 <source_url> 页面逐字选中的原文，
 * 模型据此判断「这是页面证据」而非用户自己写下的话。
 */
export function buildPageQuoteEnvelope(quote: PageQuote): string {
  const text = normalizeQuoteText(quote.text);
  if (!text) return '';
  return (
    `<${PAGE_QUOTE_TAG}>\n` +
    `<source_url>${escapeXmlText(quote.source.url)}</source_url>\n` +
    `<source_title>${escapeXmlText(quote.source.title)}</source_title>\n` +
    `<quote_text>${escapeXmlText(text)}</quote_text>\n` +
    `</${PAGE_QUOTE_TAG}>`
  );
}

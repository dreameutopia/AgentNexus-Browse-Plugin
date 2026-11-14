/**
 * 技能文本分页（渐进式披露的读取层）
 *
 * 背景：多文件技能落地后，SKILL.md 正文与资源文件都可能远超单次注入的合理
 * 体量（Agent Skills 规范建议正文 < 5000 token，参考文件「按需加载」）。
 * 本模块把任意文本按 token 预算切成确定性的页，供 skill_tool(action="load")（正文）与
 * skill_tool(action="read")（资源文件）共用——两条读取路径的页码口径完全一致。
 *
 * 口径与唯一实现：
 *   - token 计量复用 utils/ai/token-estimate 的启发式（CJK ≈ 1 token/字、
 *     其余 ≈ 4 字符/token），与上下文守卫 / 用量环同一套账——分页声称的
 *     「每页约 N token」与实际计入上下文窗口的量不会漂移；
 *   - 「字数」一律按 Unicode 码点计数（与切片边界一致；含 emoji 的文本
 *     不会因代理对被拆开而出现半字）。
 *
 * 确定性（关键不变量）：
 *   页边界只由「文本内容 + 预算」决定——贪心累积码点直到加入下一个码点会
 *   使本页估算超过预算即收页。同一文本在任何上下文、任何时刻切出的页完全
 *   相同，模型按页码续读不会错位；文本一旦变更页边界自然重算（调用方在
 *   页脚提示总页数，模型据此自纠）。
 */

import {
  CHARS_PER_TOKEN,
  isCjkLikeCodePoint,
} from '@/entrypoints/sidepanel/utils/ai/token-estimate';

/**
 * 单次读取的 token 预算（skill_tool(action="load") 正文页与 skill_tool(action="read") 文件页共用）。
 * 3000 对齐 Agent Skills 规范「SKILL.md 正文建议 < 5000 token」的量级，
 * 给指令装配的其余段（优先级约定 / 资源清单 / 环境说明）留出头寸。
 */
export const SKILL_PAGE_TOKEN_BUDGET = 3000;

/** 分页元信息（工具响应与指令装配共用同一形态） */
export interface SkillPageInfo {
  /** 当前页码（1 起） */
  page: number;
  /** 总页数 */
  pageCount: number;
  /** 全文字数（码点数） */
  totalChars: number;
  /** 本页字数（码点数） */
  currentChars: number;
  /** 本页之后剩余字数（码点数） */
  remainingChars: number;
}

/** 单页结果：元信息 + 该页内容 */
export interface SkillPage extends SkillPageInfo {
  content: string;
}

export type SkillPageResult =
  | { ok: true; page: SkillPage }
  | { ok: false; reason: 'page-out-of-range'; pageCount: number; totalChars: number };

/**
 * 归一化模型传入的页码参数：非数字 / NaN / 小于 1 一律回落第 1 页
 * （模型偶发传 "1"、"0"、null 时优雅降级，而不是报错打断任务）。
 */
export function normalizeSkillPageParam(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

/** 文本的码点数（「字数」的统一口径；无正则、无中间数组分配；非字符串收敛为 0） */
export function countSkillChars(text: string): number {
  if (typeof text !== 'string') return 0;
  let count = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) ?? 0;
    index += codePoint > 0xffff ? 2 : 1;
    count += 1;
  }
  return count;
}

/**
 * 把文本按 token 预算分页并取指定页。
 *
 * @param text 待分页文本（任意长度；空文本返回唯一的空页）
 * @param requestedPage 页码（1 起；建议先经 normalizeSkillPageParam 归一）
 * @param budget 每页 token 预算（≤0 时按 1 处理，防御外部注入）
 * @returns 命中返回 { ok: true, page }；页码超出范围返回总页数与总字数
 *          （调用方据此给出可自纠的报错文案）
 */
export function paginateSkillText(
  text: string,
  requestedPage: number,
  budget: number = SKILL_PAGE_TOKEN_BUDGET,
): SkillPageResult {
  // 输入防御：技能正文 / 文件内容正常恒为字符串，但插件技能等第三方数据
  // 跨越信任边界——非字符串一律收敛为安全文本而不是抛 TypeError 击穿调用链
  const safeText = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
  const safeBudget = Math.max(1, Math.floor(Number.isFinite(budget) ? budget : SKILL_PAGE_TOKEN_BUDGET));
  const page = Math.max(1, Math.floor(Number.isFinite(requestedPage) ? requestedPage : 1));

  // 单次扫描同时产出：页边界（UTF-16 索引）、每页字数、总字数。
  // 估算口径与 estimateTextTokens 逐码点一致（ceil(cjk + other/4)），
  // 区别仅在按「页内段」而非全文累计——这正是页边界确定性的来源。
  const boundaries: number[] = [0];
  const pageCharCounts: number[] = [];
  let cjk = 0;
  let other = 0;
  let charsInPage = 0;
  let totalChars = 0;

  for (let index = 0; index < safeText.length; ) {
    const codePoint = safeText.codePointAt(index) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    const cjkLike = codePoint > 0xffff || isCjkLikeCodePoint(codePoint);
    const nextCjk = cjk + (cjkLike ? 1 : 0);
    const nextOther = other + (cjkLike ? 0 : 1);

    // 本页已有内容且加入该码点会超预算 → 先收页，再从该码点起新页。
    // 收页时分段计数重置为当前码点自身的成本（它是新页的第一个字符），
    // 绝不携带上一页的累计——携带会把新页「预置」成超预算，退化成每页一字。
    // 页边界恒落在码点边界上（width 按码点推进），代理对不会被拆开。
    if (charsInPage > 0 && Math.ceil(nextCjk + nextOther / CHARS_PER_TOKEN) > safeBudget) {
      boundaries.push(index);
      pageCharCounts.push(charsInPage);
      cjk = cjkLike ? 1 : 0;
      other = cjkLike ? 0 : 1;
      charsInPage = 1;
    } else {
      cjk = nextCjk;
      other = nextOther;
      charsInPage += 1;
    }
    totalChars += 1;
    index += width;
  }
  boundaries.push(safeText.length);
  pageCharCounts.push(charsInPage);

  const pageCount = pageCharCounts.length;
  if (page > pageCount) {
    return { ok: false, reason: 'page-out-of-range', pageCount, totalChars };
  }

  const currentChars = pageCharCounts[page - 1];
  let remainingChars = 0;
  for (let i = page; i < pageCount; i++) remainingChars += pageCharCounts[i];

  return {
    ok: true,
    page: {
      page,
      pageCount,
      totalChars,
      currentChars,
      remainingChars,
      content: safeText.slice(boundaries[page - 1], boundaries[page]),
    },
  };
}

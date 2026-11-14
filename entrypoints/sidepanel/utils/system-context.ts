/**
 * 系统注入上下文（<system_context>）
 *
 * 背景：时间戳原拼在 systemPrompt 头部，逐轮变化会让 system 前缀失配，
 * 导致服务端上下文缓存（prompt cache）每轮失效。现改为：systemPrompt 保持
 * 逐字稳定，注入信息在装配请求时附加到「本轮用户消息」尾部，整体用
 * <system_context source="auto_injected"> 包裹并标注为系统自动注入
 * （非用户输入），随最后一轮 user 消息进模型。
 *
 * 注入内容（各自独立标签隔离）：
 *   - <current_time>：本地时间（YYYY-MM-DD HH:mm:ss，精确到秒）+ 时区信息
 *     （UTC 偏移 + IANA 时区 ID + 常见城市名）；
 *   - <active_page>：浏览器当前激活标签页的 URL（超 500 字符自动截断）与
 *     标题；查询失败/无标签页时整段退化为 unavailable，绝不抛出。
 *
 * 仅进入 LLM 请求，不写入转录/用户可见正文。
 */

/** 常见 IANA 时区 → 城市名（中文） */
const TIMEZONE_CITY: Record<string, string> = {
  'Asia/Shanghai': '北京',
  'Asia/Chongqing': '重庆',
  'Asia/Harbin': '哈尔滨',
  'Asia/Urumqi': '乌鲁木齐',
  'Asia/Lhasa': '拉萨',
  'Asia/Hong_Kong': '香港',
  'Asia/Macau': '澳门',
  'Asia/Taipei': '台北',
  'Asia/Tokyo': '东京',
  'Asia/Seoul': '首尔',
  'Asia/Singapore': '新加坡',
  'Asia/Bangkok': '曼谷',
  'Asia/Kuala_Lumpur': '吉隆坡',
  'Asia/Jakarta': '雅加达',
  'Asia/Manila': '马尼拉',
  'Asia/Kolkata': '加尔各答',
  'Asia/Karachi': '卡拉奇',
  'Asia/Dubai': '迪拜',
  'Asia/Tehran': '德黑兰',
  'Asia/Istanbul': '伊斯坦布尔',
  'Asia/Jerusalem': '耶路撒冷',
  'Asia/Kathmandu': '加德满都',
  'Europe/London': '伦敦',
  'Europe/Paris': '巴黎',
  'Europe/Berlin': '柏林',
  'Europe/Madrid': '马德里',
  'Europe/Rome': '罗马',
  'Europe/Moscow': '莫斯科',
  'Europe/Amsterdam': '阿姆斯特丹',
  'Europe/Zurich': '苏黎世',
  'America/New_York': '纽约',
  'America/Chicago': '芝加哥',
  'America/Denver': '丹佛',
  'America/Los_Angeles': '洛杉矶',
  'America/Sao_Paulo': '圣保罗',
  'America/Buenos_Aires': '布宜诺斯艾利斯',
  'America/Vancouver': '温哥华',
  'America/Toronto': '多伦多',
  'Australia/Sydney': '悉尼',
  'Australia/Melbourne': '墨尔本',
  'Pacific/Auckland': '奥克兰',
  'Africa/Cairo': '开罗',
  'Africa/Johannesburg': '约翰内斯堡',
  UTC: 'UTC',
  'Etc/UTC': 'UTC',
};

/** 激活网页 URL 注入上限（字符）；超出截断为 499 字符 + 省略号，总长恒 ≤ 500 */
export const ACTIVE_PAGE_URL_MAX_CHARS = 500;

/** 当前激活标签页信息（注入面；null 表示查询失败或无可用标签页） */
export interface ActivePageInfo {
  url: string;
  title: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** UTC 偏移：按本地时区实时计算（含夏令时），东为正，如 UTC+08:00 / UTC-04:30 */
function formatUtcOffset(date: Date): string {
  const totalMinutes = -date.getTimezoneOffset();
  const sign = totalMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(totalMinutes);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** 当前 IANA 时区 ID（运行环境不可用时回落 UTC） */
function resolveTimezoneId(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 时区 ID → 城市显示名：查表命中用中文名，否则回落尾段（下划线转空格） */
function resolveCityName(timezoneId: string): string {
  const mapped = TIMEZONE_CITY[timezoneId];
  if (mapped) return mapped;
  const tail = timezoneId.split('/').pop() || timezoneId;
  return tail.replace(/_/g, ' ');
}

/**
 * 格式化当前时间（本地时区，精确到秒）+ 时区信息。
 * 例：2026-10-30 18:18:45（UTC+08:00 · Asia/Shanghai · 北京）
 */
export function formatSystemTimestamp(now: Date = new Date()): string {
  const local = [
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
    `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`,
  ].join(' ');
  const timezoneId = resolveTimezoneId();
  return `${local}（${formatUtcOffset(now)} · ${timezoneId} · ${resolveCityName(timezoneId)}）`;
}

/**
 * 查询当前激活标签页的 URL 与标题。
 *
 * 健壮性铁律：任何失败路径（无 chrome API、权限缺失、chrome:// 等浏览器
 * 自身页面、查询抛错/超时）都返回 null，绝不向上抛出——本函数在发送链路
 * 与引擎链路上被同步前置调用，抛错会阻断整条消息发送。
 *
 * 窗口选择：优先「最近聚焦的普通窗口」的激活标签（sidepanel/弹窗不构成
 * 普通窗口，取到的即用户正在浏览的页面），再逐级放宽兜底。
 */
export async function queryActivePageInfo(): Promise<ActivePageInfo | null> {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) return null;
    const pick = (tabs: readonly chrome.tabs.Tab[] | undefined): chrome.tabs.Tab | null =>
      tabs?.find(tab => tab && typeof tab === 'object') ?? null;
    // 优先：最近聚焦的普通窗口（用户正在浏览的标签页）
    let tab = pick(await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' }));
    // 兜底一：放宽窗口类型（全屏/特殊窗口）
    if (!tab) tab = pick(await chrome.tabs.query({ active: true, lastFocusedWindow: true }));
    // 兜底二：任意窗口的激活标签（如最近聚焦窗口已关闭）
    if (!tab) tab = pick(await chrome.tabs.query({ active: true }));
    if (!tab) return null;
    const url = typeof tab.url === 'string' ? tab.url : '';
    const title = typeof tab.title === 'string' ? tab.title.trim() : '';
    if (!url && !title) return null;
    return { url, title };
  } catch {
    return null;
  }
}

/** URL 截断：超上限时保留 499 字符 + 省略号（总长恒 ≤ 上限，且向模型明示被截断） */
function truncateActivePageUrl(url: string): string {
  if (url.length <= ACTIVE_PAGE_URL_MAX_CHARS) return url;
  return `${url.slice(0, ACTIVE_PAGE_URL_MAX_CHARS - 1)}…`;
}

/**
 * 注入面文本转义：只处理 `<`（标题可含任意字符，尖括号会被模型误读为标签
 * 边界）；`&` 保持原样——URL 里的查询参数需要能被模型原样复制使用。
 */
function escapeInjectedText(value: string): string {
  return value.replace(/</g, '&lt;');
}

/**
 * 在用户输入尾部附加系统注入上下文（仅进入 LLM 请求，不写入转录/用户可见正文）。
 * 例：
 *   今天天气怎么样
 *
 *   <system_context source="auto_injected">
 *   <current_time>2026-10-30 18:18:45（UTC+08:00 · Asia/Shanghai · 北京）</current_time>
 *   <active_page>
 *   <url>https://example.com/</url>
 *   <title>Example</title>
 *   </active_page>
 *   </system_context>
 *
 * activePage 为 null 时 <active_page> 整段退化为 unavailable 占位，保证
 * 标签结构恒定（模型始终知道该字段存在且本次不可用）。
 */
export function appendSystemContext(
  text: string,
  options: { now?: Date; activePage?: ActivePageInfo | null } = {},
): string {
  const now = options.now ?? new Date();
  const page = options.activePage;
  const activePageBlock = page
    ? [
        '<active_page>',
        `<url>${escapeInjectedText(truncateActivePageUrl(page.url))}</url>`,
        `<title>${escapeInjectedText(page.title)}</title>`,
        '</active_page>',
      ].join('\n')
    : '<active_page>unavailable</active_page>';
  return [
    text,
    '',
    '<system_context source="auto_injected">',
    `<current_time>${formatSystemTimestamp(now)}</current_time>`,
    activePageBlock,
    '</system_context>',
  ].join('\n');
}

/**
 * 系统时间戳注入
 *
 * 背景：时间戳原拼在 systemPrompt 头部，逐轮变化会让 system 前缀失配，
 * 导致服务端上下文缓存（prompt cache）每轮失效。现改为：systemPrompt 保持
 * 逐字稳定，时间戳在装配请求时附加到「本轮用户消息」尾部，并明确标注
 * 为系统自动附加（非用户输入），随最后一轮 user 消息进模型。
 *
 * 时间格式：YYYY-MM-DD HH:mm:ss（本地时区，精确到秒）；
 * 时区信息：UTC 偏移 + IANA 时区 ID + 常见城市名（北京/纽约/东京…），
 * 未知 IANA ID 回落其尾段（下划线转空格）。
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
 * 在用户输入尾部附加系统时间戳（仅进入 LLM 请求，不写入转录/用户可见正文）。
 * 例：
 *   今天天气怎么样
 *
 *   （系统自动附加 · 非用户输入）当前时间：2026-10-30 18:18:45（UTC+08:00 · Asia/Shanghai · 北京）
 */
export function appendSystemTimestamp(text: string, now: Date = new Date()): string {
  return `${text}\n\n（系统自动附加 · 非用户输入）当前时间：${formatSystemTimestamp(now)}`;
}

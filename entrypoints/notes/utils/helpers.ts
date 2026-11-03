/**
 * 通用工具函数（内置笔记页）
 */

/**
 * 防抖（带 cancel：接受外部更新/切换笔记/卸载前需丢弃挂起的保存时使用）。
 * 返回值保持原函数签名，另附加 cancel() 方法。
 */
export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delay = 300,
): T & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const wrapped = ((...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  }) as T & { cancel(): void };

  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return wrapped;
}

/**
 * 复制文本到剪贴板（统一入口：clipboard API 缺失或被权限拒绝时回退
 * 到隐藏 textarea + execCommand，兼容非安全上下文与老旧内核）。
 *
 * @returns 是否复制成功
 */
export async function copyText(text: string): Promise<boolean> {
  // 首选：现代 Clipboard API
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走回退路径
  }

  // 回退：隐藏 textarea + execCommand（extensions 页面为安全上下文，
  // 正常不会走到这里；仅在剪贴板权限被拒等场景兜底）
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 相对时间（"3 分钟前" / "2 days ago"，跟随浏览器语言）。
 * Intl.RelativeTimeFormat 属于较新的 Intl API：不存在时回退为绝对日期，
 * 保证构建目标（es2015）覆盖的旧内核不因缺 API 而整页崩溃。
 */
export function formatRelativeTime(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';

  const RelativeTimeFormat = (Intl as unknown as {
    RelativeTimeFormat?: new (
      locales?: string | string[],
      options?: { numeric?: string },
    ) => { format(value: number, unit: string): string };
  }).RelativeTimeFormat;

  if (!RelativeTimeFormat) {
    return formatDateTime(iso);
  }

  const diff = time - Date.now();
  const abs = Math.abs(diff);
  const locale = navigator?.language || 'zh-CN';
  const rtf = new RelativeTimeFormat(locale, { numeric: 'auto' });

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (abs < minute) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < hour) return rtf.format(Math.round(diff / minute), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  if (abs < 30 * day) return rtf.format(Math.round(diff / day), 'day');
  if (abs < 365 * day) return rtf.format(Math.round(diff / (30 * day)), 'month');
  return rtf.format(Math.round(diff / (365 * day)), 'year');
}

/**
 * 绝对日期时间（YYYY-MM-DD HH:mm）
 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

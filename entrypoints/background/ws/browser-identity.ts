/**
 * 浏览器身份（browserUuid）解析（V2026.09.24 双模式）。
 *
 * - docker 场景：构建时 .env 注入 BROWSER_UUID（编译常量 __BROWSER_UUID__ 非空），
 *   沿用固定 uuid 直连后端；
 * - 用户浏览器场景：__BROWSER_UUID__ 为空，首次运行生成
 *   `b-{yyyyMMddHHmmssSSS}-{randomUUID}` 并持久化到 chrome.storage.local，
 *   后续运行复用（保证绑定关系稳定）。
 */

declare const __BROWSER_UUID__: string;

const STORAGE_KEY = 'browserUuid';

/** 生成用户浏览器场景的运行时 uuid */
function generateBrowserUuid(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `b-${ts}-${rand}`;
}

/**
 * 解析当前浏览器身份。
 * docker 场景（编译常量非空）同步返回；用户浏览器场景异步读/生成。
 */
export async function resolveBrowserUuid(): Promise<string> {
  // docker 场景：构建期注入的固定 uuid
  if (typeof __BROWSER_UUID__ !== 'undefined' && __BROWSER_UUID__) {
    return __BROWSER_UUID__;
  }

  // 用户浏览器场景：chrome.storage.local 持久化
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const existing = stored?.[STORAGE_KEY];
  if (typeof existing === 'string' && existing.startsWith('b-')) {
    return existing;
  }
  const generated = generateBrowserUuid();
  await chrome.storage.local.set({ [STORAGE_KEY]: generated });
  return generated;
}

/** 是否 docker 直连模式（构建期决定） */
export function isDockerMode(): boolean {
  return typeof __BROWSER_UUID__ !== 'undefined' && Boolean(__BROWSER_UUID__);
}

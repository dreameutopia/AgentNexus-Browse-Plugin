/**
 * i18n 核心层（框架无关）
 *
 * 设计约定：
 * 1. 消息目录是唯一事实源：locales/zh-CN.ts 定义 Schema，locales/en.ts 用类型强制逐键对齐。
 * 2. 语言状态链：内存 -> chrome.storage.local 持久化 -> chrome.storage.onChanged 跨上下文同步。
 *    sidepanel / notes / permission / content script / background 共享同一份语言选择。
 * 3. 使用分工：
 *    - Vue 环境（组件、computed、模板）请用 `@/utils/i18n` 的 t（读取 vue-i18n locale，具备响应式）；
 *    - 非 Vue 环境（content script、background、纯 HTML 页）用本模块的 t（零依赖、体积最小）。
 * 4. 文案里只允许 {name} 插值，禁止 ICU/链接语法（@:）等高级特性，保证两侧渲染语义一致。
 */
import zhCN from './locales/zh-CN';
import en from './locales/en';
import type { Schema } from './locales/zh-CN';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type Locale,
  type NonDefaultLocale,
} from './locales';

// ==================== 语言定义 ====================

export { SUPPORTED_LOCALES, DEFAULT_LOCALE };
export type { Locale, NonDefaultLocale };

/** chrome.storage.local 中持久化的语言键名 */
export const LOCALE_STORAGE_KEY = 'ui_locale';

// ==================== 类型化 key（点路径） ====================

type Join<K extends string, P extends string> = P extends '' ? K : `${K}.${P}`;
type Paths<T> = T extends string
  ? ''
  : { [K in keyof T & string]: Join<K, Paths<T[K]>> }[keyof T & string];

/** 可用消息 key 的字面量联合，例如 'common.save' | 'sidepanel.app.greetingMorning' */
export type MessageKey = Paths<Schema>;

// ==================== 消息目录 ====================

type Catalog = Record<Locale, Schema>;

const catalogs: Catalog = {
  'zh-CN': zhCN,
  en,
};

// ==================== 语言状态 ====================

let currentLocale: Locale = detectLocaleSync();
const listeners = new Set<(locale: Locale) => void>();
let initialized = false;
let domSyncRegistered = false;

/** 依据浏览器界面语言同步探测初始语言（zh* -> zh-CN，其余 -> en） */
function detectLocaleSync(): Locale {
  try {
    let ui = '';
    if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
      ui = chrome.i18n.getUILanguage();
    } else if (typeof navigator !== 'undefined') {
      ui = navigator.language ?? '';
    }
    return ui.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  } catch {
    return DEFAULT_LOCALE;
  }
}

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn(currentLocale);
    } catch (error) {
      console.error('[i18n] locale listener failed:', error);
    }
  });
}

/** 扩展页面才允许改 <html lang>；content script 的 document 属于宿主页面，必须跳过 */
function applyDocumentLang(): void {
  try {
    if (typeof document === 'undefined') return;
    const proto = location.protocol;
    if (proto !== 'chrome-extension:' && proto !== 'moz-extension:' && proto !== 'safari-web-extension:') {
      return;
    }
    document.documentElement.lang = currentLocale;
  } catch {
    /* ignore */
  }
}

export function getLocale(): Locale {
  return currentLocale;
}

/** 把任意字符串归一化为受支持的语言，无法识别时回落到默认语言 */
export function normalizeLocale(value: unknown): Locale {
  if (isLocale(value)) return value;
  if (typeof value === 'string' && value.toLowerCase().startsWith('zh')) return 'zh-CN';
  return DEFAULT_LOCALE;
}

/**
 * 切换语言：更新内存状态 -> 通知订阅者 -> 持久化到 chrome.storage。
 * 其它扩展上下文经 chrome.storage.onChanged 自动跟随，无需手动广播。
 */
export function setLocale(locale: Locale): void {
  if (!isLocale(locale) || locale === currentLocale) return;
  currentLocale = locale;
  applyDocumentLang();
  notify();
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      void chrome.storage.local.set({ [LOCALE_STORAGE_KEY]: locale }).catch((error) => {
        console.error('[i18n] failed to persist locale:', error);
      });
    }
  } catch {
    /* 非扩展环境忽略 */
  }
}

/** 订阅语言变化，返回取消订阅函数 */
export function subscribeLocale(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 初始化语言环境（幂等）：读取用户选择、注册跨上下文同步监听。
 * 必须在首次使用 t() 前 await 完成；重复调用安全。
 */
export async function initLocale(): Promise<Locale> {
  if (!initialized) {
    initialized = true;
    // 纯 HTML 页面（permission 等）：语言变化后自动重刷 [data-i18n] 节点，
    // 使「在别处切换语言 → 本页跟随」与本页切换同样免手动。
    // service worker 无 document，跳过。
    if (!domSyncRegistered && typeof document !== 'undefined') {
      domSyncRegistered = true;
      subscribeLocale(() => applyDomI18n());
    }
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const stored = await chrome.storage.local.get(LOCALE_STORAGE_KEY);
        const saved = stored?.[LOCALE_STORAGE_KEY];
        if (isLocale(saved) && saved !== currentLocale) {
          currentLocale = saved;
          applyDocumentLang();
          notify();
        }
        chrome.storage.onChanged?.addListener((changes, area) => {
          if (area !== 'local') return;
          const next = changes[LOCALE_STORAGE_KEY]?.newValue;
          if (isLocale(next) && next !== currentLocale) {
            currentLocale = next;
            applyDocumentLang();
            notify();
          }
        });
      }
    } catch (error) {
      console.error('[i18n] failed to init locale:', error);
    }
  }
  applyDocumentLang();
  return currentLocale;
}

// ==================== 翻译 ====================

function resolveMessage(locale: Locale, key: string): string | undefined {
  const segments = key.split('.');
  let node: unknown = catalogs[locale];
  for (const segment of segments) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * 还原 vue-i18n 字面量转义（如 {'@'} -> @）。
 * 语言目录中包含 @ 等特殊字符的文案必须写成 vue-i18n 字面量形式，
 * 否则 vue-i18n 会把 @ 当作链接消息语法解析并抛编译错误；
 * 本模块（非 Vue 环境）需同步还原，保证两侧渲染一致。
 */
function unescapeLiterals(template: string): string {
  return template.replace(/\{'([^']*)'\}/g, '$1');
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  const text = unescapeLiterals(template);
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * 框架无关的翻译函数（非响应式）。
 * 用于 content script / background / 纯 HTML 页面；Vue 组件请用 `@/utils/i18n` 的 t。
 *
 * 解析顺序：当前语言 -> 默认语言 -> 原样返回 key（保证永不抛错）。
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const raw =
    resolveMessage(currentLocale, key) ?? resolveMessage(DEFAULT_LOCALE, key) ?? (key as string);
  return interpolate(raw, params);
}

// ==================== 纯 HTML 页面的 DOM 文案注入 ====================

/**
 * 为无框架页面注入文案：
 * - [data-i18n]           -> textContent
 * - [data-i18n-placeholder] -> placeholder
 * - [data-i18n-title]      -> title
 * 并同步 <html lang>。语言切换后重新调用即可整页跟随。
 */
export function applyDomI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key as MessageKey);
  });
  root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
    const key = el.dataset.i18nPlaceholder;
    if (key) el.placeholder = t(key as MessageKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (key) el.title = t(key as MessageKey);
  });
  applyDocumentLang();
}

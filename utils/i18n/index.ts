/**
 * i18n 入口（Vue 适配层）
 *
 * 职责：
 * - 创建 vue-i18n 实例（Composition API 模式），挂载到 Vue 应用；
 * - 把 core.ts 的语言状态桥接给 vue-i18n，使组件内的 t 具备响应式；
 * - 对外提供统一的 t / setLocale / initI18n / applyDomI18n。
 *
 * 接入方式（每个 Vue 入口 main.ts 只需 3 行）：
 * ```ts
 * import { i18n, initI18n } from '@/utils/i18n';
 * const app = createApp(App);
 * app.use(i18n);
 * initI18n().finally(() => app.mount('#app'));
 * ```
 *
 * 组件内取文案：
 * ```ts
 * import { t } from '@/utils/i18n';
 * const label = t('common.save');            // 模板与 script 通用
 * const hint = t('common.fileCount', { count: 3 });
 * ```
 * 模板中调用 t 时会读取 vue-i18n 的 locale ref，因此语言切换会自动触发重渲染。
 */
import { createI18n } from 'vue-i18n';
import { computed } from 'vue';
import type { App } from 'vue';
import zhCN from './locales/zh-CN';
import en from './locales/en';
import type { Schema } from './locales/zh-CN';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  getLocale,
  initLocale,
  setLocale,
  subscribeLocale,
  t as tCore,
  type Locale,
  type MessageKey,
} from './core';
import { NON_DEFAULT_LOCALES, type NonDefaultLocale } from './locales';

// 类型安全：让 vue-i18n 的 t/$t 只接受 zh-CN 目录里真实存在的 key（含嵌套点路径）
declare module 'vue-i18n' {
  export interface DefineLocaleMessage extends Schema {}
}

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: getLocale(),
  fallbackLocale: DEFAULT_LOCALE,
  messages: {
    'zh-CN': zhCN,
    en,
  },
});

// core（唯一事实源） -> vue-i18n 的单向桥接；组件内 t 靠它获得响应式
subscribeLocale((locale) => {
  i18n.global.locale.value = locale;
});

/**
 * Vue 环境下的翻译函数。
 * 在渲染/computed 中调用会跟踪 vue-i18n 的 locale ref，语言切换自动重渲染；
 * 在事件回调中调用则读取当前最新语言。
 *
 * 防御：vue-i18n 编译消息（@ 链接语法、插值格式等）失败会直接抛错，
 * 若发生在组件渲染中会中断整个 patch，导致界面卡死在旧状态。
 * 因此捕获异常后回退到 core 的 t（永不抛错），保证渲染链路绝对安全。
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  try {
    return i18n.global.t(key, params as never);
  } catch (error) {
    console.error(`[i18n] vue-i18n 编译消息失败，已回退到原文案（key=${key}）:`, error);
    return tCore(key, params);
  }
}

/**
 * 当前语言（响应式）。配套 switchLocale 立即生效并持久化。
 *
 * 注意：locale 必须读 vue-i18n 的 ref，不能读 core 的 getLocale()。
 * getLocale() 返回普通变量（非响应式），computed 会缓存首次结果导致
 * 「文案已切换、选中态却卡在旧语言」。i18n.global.locale 由 subscribeLocale
 * 桥接保持与 core 同步，读它才能触发依赖收集。
 *
 * ```ts
 * const { locale, switchLocale, options } = useLocale();
 * ```
 */
export function useLocale() {
  const locale = computed<Locale>(() => i18n.global.locale.value as Locale);
  return {
    locale,
    switchLocale: (next: Locale) => setLocale(next),
    options: SUPPORTED_LOCALES,
  };
}

/**
 * 语言切换器选项（单一事实源）。
 * 语言名按其自身语言展示（endonym），因此标签不参与翻译——
 * 切换成英文后"简体中文"仍应显示为"简体中文"，用户才找得到自己的语言。
 * SettingsModal / ApiConfigModal 等所有切换器共用此数组。
 */
export const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
];

/**
 * 初始化语言（读取持久化选择 + 注册跨上下文同步）。
 * 建议在 mount 前 await/finally 调用，避免首屏闪错语言。
 */
export async function initI18n(): Promise<Locale> {
  const locale = await initLocale();
  i18n.global.locale.value = locale;
  return locale;
}

/** 把 i18n 插件安装到 Vue 应用（等价于 app.use(i18n)） */
export function installI18n(app: App): void {
  app.use(i18n);
}

export { SUPPORTED_LOCALES, DEFAULT_LOCALE, getLocale, setLocale, subscribeLocale };
export { NON_DEFAULT_LOCALES };
export type { Locale, MessageKey, NonDefaultLocale };
export { initLocale, applyDomI18n } from './core';

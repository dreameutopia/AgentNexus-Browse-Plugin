/**
 * 语言常量（无副作用的纯声明）
 *
 * 单独成文件的原因：领域层（utils/agents 等）需要「有哪些语言 / 哪些是非默认语言」
 * 这组常量来做编译期与运行时的校验，但不该因此依赖 i18n/core.ts——
 * 后者持有语言状态（chrome.storage 监听、目录载入），导入即产生副作用。
 * 因此常量放这里，core.ts 反向依赖它，两边都不产生循环。
 */

/** 支持的语言（新增语言在此登记，两个 locale 目录需同步补齐） */
export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;

/** 语言码 */
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/**
 * 兜底语言（消息目录的源语言，缺 key 时回落到中文）。
 * 声明为字面量类型（非 Locale 宽类型）：下游可据此推导
 * 「除默认语言外还需覆盖的语言集合」（见 NonDefaultLocale）。
 */
export const DEFAULT_LOCALE = 'zh-CN' as const;

/**
 * 除默认语言外还需提供文案的语言集合。
 * 领域层（预置智能体等）据此要求「每个非默认语言都必须有文案」——
 * 新增语言时编译期即可暴露缺口，而不是运行时静默回落成默认语言。
 */
export type NonDefaultLocale = Exclude<Locale, typeof DEFAULT_LOCALE>;

/** 除默认语言外的全部语言（运行时列表；与 NonDefaultLocale 一一对应） */
export const NON_DEFAULT_LOCALES: readonly NonDefaultLocale[] = SUPPORTED_LOCALES.filter(
  (locale): locale is NonDefaultLocale => locale !== DEFAULT_LOCALE,
);

/**
 * 构建时注入的全局常量类型声明
 *
 * 这些值由 wxt.config.ts 中的 vite.define 在构建时注入：
 * - __APP_VERSION__: 从 package.json 读取的版本号
 * - __BROWSER_UUID__: 从 .env / .env.local 读取的浏览器实例唯一标识 (UUID)
 */
declare const __APP_VERSION__: string;
declare const __BROWSER_UUID__: string;

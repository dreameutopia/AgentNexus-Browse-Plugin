/**
 * 通用工具集合
 *
 * 历史上的 generic_wait（盲等固定秒数）已被 browser_wait 取代并**整体删除**：
 * 盲等既不能表达「等什么」，又让模型把「时间到了」误当作「业务完成了」。
 * 条件等待统一由 tools/browser/browser-wait-tool.ts 承载。
 *
 * 本文件保留为空壳是为了不破坏 tools/index.ts 的注册序列形状；不再注册任何工具。
 */

export function registerCommonTools() {
  // 无通用工具：等待类能力统一由 browser_wait 提供（条件等待）。
}

/**
 * 线上文本截断安全工具（跨 bundle 共享的单一实现）
 *
 * 接收方：会话侧（token-estimate 经重导出使用）与 background 工具链
 * （page_exec 等）——两侧都必须保证「会进入模型请求体的截断点」用同一实现，
 * 这也是它放在共享 utils/ 而非某个 entrypoint 的原因。
 */

/**
 * 切点落在高位代理（0xD800-0xDBFF）时回退 1 个码元，避免孤立代理项。
 *
 * 理由：JS 的 String.slice 可能把增补平面字符（emoji 等）劈成两半，
 * JSON.stringify 会把半个字符序列化为孤立的 "\ud8xx" 转义——语法合法但
 * 语义非法，serde_json 等严格网关会以此拒收整个请求（400），且报错不指明
 * 字段，极难定位。任何新的线上文本截断点必须经本函数（或先经
 * ContextWindowGuard 的 sanitize 兜底）。
 */
export function trimDanglingSurrogate(text: string, length: number): string {
  const end = Math.min(length, text.length);
  if (end <= 0) return '';
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) return text.slice(0, end - 1);
  return text.slice(0, end);
}

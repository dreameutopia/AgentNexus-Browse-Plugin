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

/**
 * 切点落在**低位代理**（0xDC00-0xDFFF）时前进 1 个码元，避免孤立代理项。
 *
 * 与 trimDanglingSurrogate 对偶：头部切片怕「结尾落在高位代理」，尾部切片
 * 怕「起点落在低位代理」——后者同样会把增补平面字符劈成两半（高位在前、
 * 低位被切掉），序列化出孤立代理转义，被严格网关整单拒收（400）。
 * 前进 1 码元后该代理对整体落在切片之外，后缀以完整字符起步。
 */
export function trimLeadingLoneSurrogate(text: string, start: number): string {
  const begin = Math.max(0, Math.min(start, text.length));
  if (begin <= 0 || begin >= text.length) return text.slice(begin);
  const current = text.charCodeAt(begin);
  const previous = text.charCodeAt(begin - 1);
  const isLowSurrogate = current >= 0xdc00 && current <= 0xdfff;
  const isHighSurrogate = previous >= 0xd800 && previous <= 0xdbff;
  return text.slice(isLowSurrogate && isHighSurrogate ? begin + 1 : begin);
}

/**
 * 流式稳定边界探测（MarkdownText 增量渲染的核心纯函数）
 *
 * 目标：在「正在增长的直播内容」里找到最后一个**可以安全冻结**的位置——
 * 该位置之前的所有块级结构都已闭合，渲染一次后永不重解析（业界通行做法，
 * 参见 Streamdown / Incremark / FastGPT 的「完成块冻结」模式）。
 * 之后的「活动尾部」继续逐 token 重渲染；组件（围栏块）一旦闭合即落入
 * 稳定区被立即挂载，且后续 token 不会再触碰它。
 *
 * 冻结点 = 最后一个「闭合围栏代码块」的行尾，且该点满足全部安全条件：
 *   1. 无未闭合的 <think> / <api-error> 块（renderMessage 对二者做
 *      「解析前摘出」，跨冻结点的半开块会被拆成两个残块——必须等它闭合）；
 *   2. 非围栏文本中 $$ 数量为偶数（块级公式跨行；奇数 = 有 $$ 开未闭）。
 *      与 extractLatex 的语义一致：代码围栏内的 $$ 是字面量，不计入；
 *      行内 $…$ 不跨行，无需保护。
 *
 * 为什么只认「闭合围栏」而不冻结普通段落：组件（chart / mermaid / diff）
 * 恰好全部以围栏承载，围栏边界就是挂载粒度；段落级冻结会引入列表续行、
 * 松散列表跨段等拆分伪影，而文本尾部的重渲染成本已被 120ms 节流摊平，
 * 无需更激进的冻结。
 *
 * 行为契约：
 *   - 返回 0 = 没有任何可冻结前缀（常态：纯文本直播、围栏未闭合）；
 *   - 返回值单调非降（对只追加的内容）：已冻结的边界不会被后续 token 收回；
 *   - 纯函数、无状态、O(n) 单遍扫描，可在任何上下文安全调用。
 */

/** 围栏行：起始标记（含可选 info string）或闭合标记（CommonMark 缩进容忍） */
const FENCE_LINE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;

interface FenceState {
  char: string;
  length: number;
}

/** 在一行文本内统计子串出现次数（think / api-error 标签与 $$ 计数用） */
function countOccurrences(line: string, needle: string): number {
  if (!line.includes(needle)) return 0;
  let count = 0;
  let at = line.indexOf(needle);
  while (at !== -1) {
    count++;
    at = line.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * 探测内容的稳定边界（返回可冻结前缀的长度；0 = 无）。
 * 实现为单遍行扫描：围栏状态机 + 标签深度 + $$ 奇偶，在「围栏闭合行」处
 * 校验安全条件并记录最后一个合法冻结点。
 */
export function findStableBoundary(content: string): number {
  if (!content) return 0;

  let fence: FenceState | null = null;
  let thinkDepth = 0;
  let apiErrorDepth = 0;
  let dollarBlockParity = 0;
  let boundary = 0;

  const lines = content.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    // 行尾（含换行）= 下一起始；最后一行无换行时恰为 content.length
    offset += line.length + (i < lines.length - 1 ? 1 : 0);
    const lineEnd = offset;

    const fenceMatch = line.match(FENCE_LINE_PATTERN);

    if (fence) {
      // 围栏闭合：同字符、长度足够、其后无内容（与 markdown-it 一致）
      const marker = fenceMatch?.[1] ?? '';
      if (fenceMatch && marker[0] === fence.char && marker.length >= fence.length && !fenceMatch[2].trim()) {
        fence = null;
        // 冻结点候选：闭合行行尾。安全条件全满足才推进（不满足则保留更早的）
        if (thinkDepth === 0 && apiErrorDepth === 0 && dollarBlockParity === 0) {
          boundary = lineEnd;
        }
      }
      // 围栏内部行：$$ 与代码字面量不参与奇偶；think / api-error 标签仍计数
      // ——与 renderMessage 的摘出行为对齐（二者摘出发生在围栏识别之前）
      if (line.includes('<think>')) thinkDepth += countOccurrences(line, '<think>');
      if (line.includes('</think>')) thinkDepth -= countOccurrences(line, '</think>');
      if (line.includes('<api-error')) apiErrorDepth += countOccurrences(line, '<api-error');
      if (line.includes('</api-error>')) apiErrorDepth -= countOccurrences(line, '</api-error>');
      continue;
    }

    if (fenceMatch) {
      // 围栏开启：info string 之后整行都属围栏，不参与标签 / $$ 计数
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }

    // 普通行：块级标签深度 + $$ 奇偶
    if (line.includes('<think>')) thinkDepth += countOccurrences(line, '<think>');
    if (line.includes('</think>')) thinkDepth -= countOccurrences(line, '</think>');
    if (line.includes('<api-error')) apiErrorDepth += countOccurrences(line, '<api-error');
    if (line.includes('</api-error>')) apiErrorDepth -= countOccurrences(line, '</api-error>');
    if (line.includes('$$')) dollarBlockParity ^= countOccurrences(line, '$$') % 2;
  }

  // 未闭合围栏 / 半开标签 / 奇数 $$：最后候选之后的内容全部留在活动尾部
  return boundary;
}

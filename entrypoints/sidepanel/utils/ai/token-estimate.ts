/**
 * 上下文 token 估算（唯一实现）
 *
 * 口径定义：模型单次请求的真实负载以 **token** 计量——上下文窗口（阈值）、
 * 窗口守卫裁剪、80%/90% 压缩触发、用量环显示全部同源于本模块，杜绝
 * 「显示未超限但请求被裁」的口径漂移。
 *
 * 估算策略（无分词器依赖的启发式，注释即依据）：
 *   - 文本：CJK 字符（汉字/假名/谚文/全角符号等）按 ≈1 token/字；
 *     其余字符按 ≈4 字符/token（OpenAI/Anthropic 系 BPE 对拉丁文本的
 *     经验比值）。非 BMP 字符（emoji 等）按 1 token 计（保守上偏）。
 *   - 图片：**固定 IMAGE_CONTEXT_TOKENS = 1200 token/张**，与图片字节、
 *     base64 长度完全解耦。依据：主流多模态接口按图像尺寸计费——
 *     OpenAI high-detail 约 85 + 170×(512px tiles)（1024×1024 ≈ 765）、
 *     Claude ≈ (宽×高)/750（1200×800 ≈ 1280），Gemini 按 tile ≈ 数百至两千
 *     token。本助手实际进入上下文的图片以**视口截图**为主（≈1200×800），
 *     1200 按该主形态校准；更大分辨率的截图在 Claude/Gemini 侧可能略欠计
 *     （预算口径偏松），以换取典型视觉对话不虚耗窗口。此前按 base64 JSON
 *     长度计入（单张截图动辄数十万「字符」）会把环上占比与守卫裁剪同时
 *     打爆，是视觉对话上下文失真的根因。
 *
 * 单调性：估算对文本前缀单调不减（守卫「从新到旧保留」依赖该性质）。
 */

/**
 * 单张图片固定计入的 token 数（上下文计量、守卫裁剪、压缩触发共用；
 * 调整此值即调整全链路对图片的成本假设——单一事实源）。
 */
export const IMAGE_CONTEXT_TOKENS = 1200;

/** 拉丁等非 CJK 文本的字符/token 经验比值（导出供技能分页按同一口径收页） */
export const CHARS_PER_TOKEN = 4;

/**
 * 判定码点是否按「≈1 token/字」计费的 CJK 类字符：
 *   - 汉字（统一表意 + 扩展 A）与兼容汉字
 *   - 假名（平假名/片假名，含中点等日文符号区间）
 *   - 谚文音节
 *   - CJK 符号与标点（全角引号、顿号等）
 *   - 全角/半角形式（全角字母数字、全角标点）
 *   - 扩展 B 及以上（增补平面汉字）
 *
 * 导出供技能分页（utils/skills/skill-pagination）按同一套字符分类收页，
 * 保证「每页约 N token」的声称与上下文计量不漂移。
 */
export function isCjkLikeCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK 统一表意
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // 扩展 A
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // 兼容表意
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // 假名
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // 谚文音节
    (codePoint >= 0x3000 && codePoint <= 0x303f) || // CJK 符号标点
    (codePoint >= 0xff00 && codePoint <= 0xffef) || // 全角形式
    (codePoint >= 0x20000 && codePoint <= 0x2fa1f) // 增补平面汉字
  );
}

/**
 * 文本 token 估算（向上取整；空串返回 0）。
 * 按码点遍历（无正则回溯、无匹配数组分配），O(n) 单次扫描。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjkLike = 0;
  let other = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) ?? 0;
    index += codePoint > 0xffff ? 2 : 1;
    // 非 BMP（emoji / 扩展汉字等）保守按 1 token；其余按 4 字符/token 折算
    if (codePoint > 0xffff || isCjkLikeCodePoint(codePoint)) cjkLike += 1;
    else other += 1;
  }
  return Math.ceil(cjkLike + other / CHARS_PER_TOKEN);
}

/**
 * 按 token 预算截断文本（供 system 消息裁剪与附件预算裁剪共用）。
 * 估算对前缀近似线性 → 比例初值 + 收敛迭代（最多 8 轮，正常 1-2 轮命中）；
 * 迭代不收敛时兜底按比例硬切，保证恒返回 ≤ 预算的前缀。
 * 代理对安全：切点落在高位代理时回退一个码元，避免产生孤立代理项。
 */
export function sliceTextToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  const whole = estimateTextTokens(text);
  if (whole <= maxTokens) return text;

  let sliceLength = Math.max(1, Math.floor((text.length * maxTokens) / whole));
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = trimDanglingSurrogate(text, sliceLength);
    const cost = estimateTextTokens(candidate);
    if (cost <= maxTokens) return candidate;
    sliceLength = Math.max(1, Math.floor((sliceLength * maxTokens) / cost));
  }
  return trimDanglingSurrogate(text, Math.max(1, sliceLength));
}

/**
 * 与 sliceTextToTokenBudget 对偶的**尾部**切片：返回 ≤ maxTokens 的文本**后缀**。
 *
 * 用途：压缩载荷的「从后往前保留」截断兜底（分段摘要触顶后的最后防线）——
 * 被截的往往是单条超长工具结果，其结论通常在末尾，保留尾部比保留头部
 * 更接近「可继续工作的信息」。
 *
 * 三条硬契约：
 *   1. **恒 ≤ 预算**：二分求「最大的可行起点」（后缀成本随起点右移单调
 *      不增，空后缀必可行 → 一定有解），不做比例估算式的近似收敛；
 *   2. **代理对安全**：起点不得落在低位代理上（切在代理对中间会产出孤立
 *      代理转义 → 严格网关整单 400，见 utils/text/truncate 的说明）；
 *   3. **纯后缀语义**：不改动文本内容，只决定从哪里开始保留。
 */
export function sliceTextTailToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (text.length === 0) return '';
  const whole = estimateTextTokens(text);
  if (whole <= maxTokens) return text;

  // 二分求「最小的可行起点」：起点右移 → 后缀变短 → 成本单调不增，
  // 可行区间是 [首个可行起点, 长度]；取下界即得**预算内最长**的后缀
  // （取上界会收敛到空后缀——与目标相反）
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (estimateTextTokens(text.slice(mid)) <= maxTokens) high = mid;
    else low = mid + 1;
  }
  return trimLeadingLoneSurrogate(text, low);
}

/**
 * 截断点代理对回退——单一实现位于共享域 utils/text/truncate（background
 * 工具链同样引用），此处重导出保持既有导入方稳定；契约与理由见该模块。
 */
import { trimDanglingSurrogate, trimLeadingLoneSurrogate } from '@/utils/text/truncate';
export { trimDanglingSurrogate, trimLeadingLoneSurrogate };

/** 消息中「图片部件」数量（content 数组内 type=image_url 的部件；字符串 content 恒为 0） */
function countImageParts(message: unknown): number {
  if (!message || typeof message !== 'object') return 0;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'image_url') {
      count += 1;
    }
  }
  return count;
}

/**
 * 克隆消息并把图片部件的 url 载荷置空（保留部件结构）。
 * 图片按固定 token 计费，base64 载荷不参与文本估算——否则单张截图的
 * base64（数十万字符）会再次淹没文本成本。
 */
function stripImagePayloads(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return message;
  const strippedContent = content.map(part => {
    if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'image_url') {
      return part;
    }
    const imagePart = part as { image_url?: { url?: unknown; detail?: unknown } };
    if (!imagePart.image_url) return part;
    return { ...part, image_url: { ...imagePart.image_url, url: '' } };
  });
  return { ...(message as Record<string, unknown>), content: strippedContent };
}

/** 单条消息的 token 估算分解（文本与图片分列，供用量环成分展示） */
export interface MessageTokenEstimate {
  /** 非图片载荷（JSON 序列化后）的文本 token 估算 */
  textTokens: number;
  /** 图片部件固定成本（IMAGE_CONTEXT_TOKENS × 张数） */
  imageTokens: number;
  /** 合计 */
  totalTokens: number;
}

/**
 * 单条消息 token 估算：
 *   文本 = JSON 序列化（图片 url 已置空）→ estimateTextTokens；
 *   图片 = 张数 × IMAGE_CONTEXT_TOKENS。
 * 不可序列化形态（循环引用等）回落 String 表示，保证恒有数值。
 */
export function estimateMessageTokensDetailed(message: unknown): MessageTokenEstimate {
  const imageTokens = countImageParts(message) * IMAGE_CONTEXT_TOKENS;
  let visible = message;
  let reasoningTokens = 0;
  if (message && typeof message === 'object') {
    const { nativeReplay, toolFeedbackFor: _feedback, ...rest } = message as Record<string, any>;
    // Native output also contains copies of visible text/tool calls, IDs and
    // opaque signatures. Do not tokenize those transport envelopes twice.
    if (Array.isArray(rest.tool_calls)) rest.tool_calls = rest.tool_calls.map((call: any) => {
      if (!call || typeof call !== 'object') return call;
      const { geminiThoughtSignature: _signature, ...ordinary } = call;
      return ordinary;
    });
    visible = rest;
    if (nativeReplay && Array.isArray(nativeReplay.items)) {
      for (const item of nativeReplay.items) {
        if (!item || typeof item !== 'object') continue;
        const text = nativeReplay.provider === 'openai' ? item.reasoning_content
          : nativeReplay.provider === 'ollama' ? item.thinking
          : nativeReplay.provider === 'claude' && item.type === 'thinking' ? item.thinking
          : nativeReplay.provider === 'gemini' && item.thought === true ? item.text : '';
        if (typeof text === 'string') reasoningTokens += estimateTextTokens(text);
      }
      if (typeof nativeReplay.reasoningTokens === 'number' && Number.isFinite(nativeReplay.reasoningTokens) && nativeReplay.reasoningTokens >= 0) {
        reasoningTokens = Math.max(reasoningTokens, Math.ceil(nativeReplay.reasoningTokens));
      }
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(stripImagePayloads(visible)) ?? '';
  } catch {
    serialized = String(message ?? '');
  }
  const textTokens = estimateTextTokens(serialized) + reasoningTokens;
  return { textTokens, imageTokens, totalTokens: textTokens + imageTokens };
}

/** 单条消息 token 估算（守卫预算累加的常用形态） */
export function estimateMessageTokens(message: unknown): number {
  return estimateMessageTokensDetailed(message).totalTokens;
}

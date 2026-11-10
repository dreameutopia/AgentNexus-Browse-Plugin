/**
 * 上下文用量计量（token 口径，全量）
 *
 * 口径定义：模型单次请求的真实负载 = 系统提示词 + 工具定义（OpenAI JSON Schema）
 * + 对话消息（含运行中的工具结果与合成消息）。三者缺一都会让"上下文进度"
 * 与真实裁剪行为脱节，因此计量必须全量。
 *
 * 计量直接复用 utils/ai/token-estimate 的唯一实现（文本启发式 token 估算 +
 * 图片固定 1200 token/张）：环上显示的占比、80%/90% 压缩触发、窗口守卫裁剪
 * 三者同源，不会出现「显示未超限但请求被裁剪」的口径漂移。
 *
 * 图片成本单列（imageTokens）：图片按固定 1200 token 计，与 base64 体积解耦，
 * 用量环可独立展示「图片吃了多少窗口」，视觉对话的预算一眼可解释。
 */

import type { ChatMessage } from '../../utils/ai/ai-chat-api';
import { estimateMessageTokensDetailed, estimateTextTokens } from '../../utils/ai/token-estimate';
import { openaiToolsConverter } from '../../utils/tools/openai-tools-converter';
import type { ContextUsage } from '../types';

/**
 * 工具定义合计 token 估算（未注册的工具 ID 由转换器告警并跳过，与实际请求一致）。
 * 结果按工具 ID 集合缓存：注册表在启动后不可变，且会话引擎每轮循环都会测量，
 * 不缓存会对全部工具 Schema 做重复序列化与估算（几十次/运行）。
 */
const toolsTokensCache = new Map<string, number>();

function measureTools(toolIds: readonly string[]): number {
  if (toolIds.length === 0) return 0;
  const cacheKey = toolIds.join('|');
  const cached = toolsTokensCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const tools = openaiToolsConverter.getToolsByIds([...toolIds]);
    const tokens = tools.reduce(
      (total, tool) => total + estimateTextTokens(JSON.stringify(tool) || ''),
      0,
    );
    toolsTokensCache.set(cacheKey, tokens);
    return tokens;
  } catch (error) {
    console.warn('[ContextMeter] 工具定义计量失败，按 0 计:', error);
    return 0;
  }
}

/**
 * 测量一次模型请求的全量上下文用量（token）。
 * messages 应传「不含 system 角色消息」的对话消息（system 单独以 systemPrompt 计），
 * 与会话引擎的实际组装方式（system + history）一致；重复传入 system 会导致双重计量。
 */
export function measureContextUsage(input: {
  toolDefinitions?: import('@/common/openai-types').OpenAITool[];
  systemPrompt: string;
  toolIds: readonly string[];
  messages: readonly ChatMessage[];
  threshold: number;
}): ContextUsage {
  const systemTokens = estimateTextTokens(input.systemPrompt);
  const toolsTokens = input.toolDefinitions
    ? input.toolDefinitions.reduce((sum, tool) => sum + estimateTextTokens(JSON.stringify(tool)), 0)
    : measureTools(input.toolIds);
  let messagesTokens = 0;
  let imageTokens = 0;
  for (const message of input.messages) {
    const estimate = estimateMessageTokensDetailed(message);
    messagesTokens += estimate.textTokens;
    imageTokens += estimate.imageTokens;
  }
  const totalTokens = systemTokens + toolsTokens + messagesTokens + imageTokens;
  const threshold = input.threshold > 0 ? input.threshold : 1;
  return {
    systemTokens,
    toolsTokens,
    messagesTokens,
    imageTokens,
    totalTokens,
    threshold,
    ratio: totalTokens / threshold,
  };
}

/**
 * 触发阈值：发送前（新会话轮次开始）与运行中（工具循环内）的压缩线。
 *
 * 取值依据（业界复盘，Claude Code / Codex / OpenCode 对比实践）：
 *   - 95% 普遍被认为偏晚——压缩请求本身需要时间与窗口，且单轮巨型工具
 *     结果可能一步跨过触发线直抵 100%，压缩来不及生效；
 *   - Claude Code 采用「有效窗口 −13K」的绝对提前量（200K 窗口 ≈93.5%）；
 *   - 运行中 90% 在 256K 窗口留出 ~25K 余量：覆盖单轮跳变，与运行时压缩
 *     的「末轮 ≤15% 保留」规则配合（压缩后总量约 30%，两线间有约半个窗口
 *     的增长空间，压缩节奏不致过频）；
 *   - 发送前 80%：发送前压缩发生在**用户点发送之后、请求发出之前**，
 *     用户此刻正盯着界面等待——比运行中线再提前 10 个百分点，让「压缩
 *     正在进行」的提示尽早出现，也给「压缩后仍超限则整轮报错」的极端
 *     情形多留一次压缩机会（压缩只做一次，失败即降级裁剪）。
 *
 * 两线与展示层同源：用量圆环的变红线、学习状态条的警示线均直接引用
 * 本常量（不各自硬编码），保证「看到红色 = 下一次发送就会压缩」这一
 * 用户预期恒成立。
 */
export const COMPACTION_PRE_RUN_RATIO = 0.80;
export const COMPACTION_RUNTIME_RATIO = 0.90;

/**
 * 运行中压缩失败后的重试间隔（引擎主循环轮次）。
 *
 * 单次失败不再整段运行熔断（旧实现）：长自治运行（网站学习/盲试验证，
 * 默认 60 轮 / 30 分钟）里一次压缩请求的瞬时网络失败，不应让后续数十轮
 * 全部失去压缩保护、直到越限整段报错。改为冷却式重试——失败后记录轮次，
 * 间隔 N 轮后允许再次尝试；N 足够大以避免每轮重复失败的请求风暴
 * （失败提示条同样每 N 轮至多一次），又足够小以在长运行内及时恢复保护。
 */
export const COMPACTION_RETRY_ROUND_GAP = 3;

/**
 * AI 上下文引擎（AI 面）
 *
 * 职责：把用户面完整转录（ChatMessageRecord[]）派生为模型协议上下文（ChatMessage[]），
 * 并施加窗口保护。两套数据的边界：
 *   - 用户面：完整、无长度限制、面向展示
 *   - AI 面：派生态、受上下文 token 阈值约束、面向模型协议（assistant.tool_calls + tool 结果配对重建）
 *
 * 图片口径：用户消息的 imageRefs（内容哈希）在此还原为 data URL 多模态部件——
 * 图片跨轮次随上下文重发给模型，但二进制始终存于独立图片库（core/images），
 * 本层只经 imageStore 解析引用，绝不触碰存储细节。快照同步性由记录加载点的
 * 预载（transcriptEngine.preloadRecordImages）保证；缓存未命中的引用按缺失处理
 * 并告警（降级为纯文本消息，绝不阻断派生）。
 *
 * 窗口策略复用 ContextWindowGuard（system 优先保留、tool 内容截断、按原子组从新保留），
 * 阈值来源为 runtime.model.contextThreshold；计量经 utils/ai/token-estimate
 * （文本启发式 + 图片固定 1800 token），与用量环、压缩触发同源。
 */

import type { ChatMessage } from '../../utils/ai/ai-chat-api';
import { ContextWindowGuard, type ContextGuardResult } from '../../utils/ai/context-window-guard';
import { contextCompactor } from './compactor';
import { unescapeXmlText } from '../../utils/xml-entities';
import { imageStore, normalizeImageRefs } from '../images/image-store';
import type { ChatMessageRecord } from '../types';
import type { ToolCallUI } from '../../types/chat';

/** <api-error> 错误卡片块（发射侧见 utils/stream/errors.ts 的 toApiErrorBlock） */
const API_ERROR_BLOCK_PATTERN = /<api-error\b[^>]*>([\s\S]*?)<\/api-error>/g;

/**
 * 模型面内容清洗：错误卡片 XML → 单行事实注记。
 * <api-error> 是面向 UI 的渲染协议（分类徽章 + 完整原始响应），整块回传模型
 * 有两个问题：raw 响应动辄数 KB 浪费上下文预算；结构化 XML 会诱导模型在
 * 后续正文里模仿卡片格式。但「上一轮请求失败」这一事实必须如实保留——
 * 否则模型会误以为上次已正常完成，基于不存在的回复继续任务。
 */
function toModelFacingContent(content: string): string {
  if (!content.includes('<api-error')) return content;
  return content.replace(API_ERROR_BLOCK_PATTERN, block => {
    const summary = block.match(/<summary>([\s\S]*?)<\/summary>/);
    const summaryText = summary ? unescapeXmlText(summary[1]).trim() : '';
    return summaryText
      ? `[系统注：上一次模型请求失败，未产生完整回复。失败原因：${summaryText}]`
      : '[系统注：上一次模型请求失败，未产生完整回复。]';
  });
}

class ContextEngine {  /**
   * 记录 → 协议消息（按 seq 升序）。
   * 助手记录中的工具调用重建为 assistant.tool_calls + 相邻 tool 结果消息，
   * 满足 OpenAI 协议「tool_calls 必须紧跟 tool 结果」的约束。
   * 流式中/已中断的部分内容同样纳入（与既有内存态行为一致）。
   * 防御：空内容且无图片引用的记录被跳过——部分服务端会拒绝空 content 消息，
   * 这类记录（如中止时的空助手占位）对语义无贡献，剔除后请求更健壮。
   *
   * 图片：user 记录的 imageRefs 经 imageStore 同步解析（依赖记录加载点预载）
   * 还原为多模态 content；assistant 记录的图片引用（vision 自动截图）**不回注**
   * 模型上下文——它们仅供 UI 查看，且每轮开始都会拍新截图（旧标签已失效）。
   *
   * @param options.summary 会话压缩摘要（存在时以系统级记忆消息置于最前，
   *   该消息经窗口守卫按 system 优先保护，永不因超限被裁剪）
   */
  toProtocolMessages(
    records: ChatMessageRecord[],
    options?: { summary?: string; compactedAt?: number },
  ): ChatMessage[] {
    const sorted = [...records].sort((a, b) => a.seq - b.seq);
    const messages: ChatMessage[] = [];

    if (options?.summary) {
      messages.push(
        contextCompactor.buildSummaryMessage(options.summary, options.compactedAt ?? Date.now()),
      );
    }

    for (const record of sorted) {
      if (record.role === 'user') {
        const imageUrls = this.resolveUserImageUrls(record);
        if (!record.content && imageUrls.length === 0) continue;
        if (imageUrls.length === 0) {
          messages.push({ role: 'user', content: record.content });
          continue;
        }
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: record.content },
            ...imageUrls.map(url => ({
              type: 'image_url' as const,
              image_url: { url, detail: 'auto' as const },
            })),
          ],
        });
        continue;
      }

      const toolCalls = record.toolCalls ?? [];
      if (!record.content && toolCalls.length === 0) continue;
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        // 模型面清洗：错误卡片 XML 收敛为事实注记（详见 toModelFacingContent）
        content: toModelFacingContent(record.content || ''),
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map(call => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: call.arguments ?? '{}' },
              })),
            }
          : {}),
      };
      messages.push(assistantMessage);

      for (const call of toolCalls) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: this.buildToolContent(call),
        });
      }
    }

    return messages;
  }

  /**
   * 用户记录的图片引用 → data URL 列表（同步快照；缓存未命中按缺失降级）。
   * 引用形态经 normalizeImageRefs 收敛，坏引用静默剔除并告警一次。
   */
  private resolveUserImageUrls(record: ChatMessageRecord): string[] {
    const refs = normalizeImageRefs(record.imageRefs);
    if (refs.length === 0) return [];
    const urls: string[] = [];
    const missing: string[] = [];
    for (const ref of refs) {
      const url = imageStore.peekDataUrl(ref);
      if (url) urls.push(url);
      else missing.push(ref);
    }
    if (missing.length > 0) {
      console.warn(
        `[ContextEngine] 消息 ${record.id} 的 ${missing.length} 张图片未命中缓存（未预载或已被回收），本次按纯文本派生`,
      );
    }
    return urls;
  }

  /**
   * 由持久化的工具调用记录重建 tool 消息内容。
   *
   * 三种形态各自如实表达，避免模型读到失真的「成功」：
   *   - error    → 失败原因（与运行期的 tool 消息语义一致）
   *   - pending  → 调用未完成（运行被中断）：明确告知不可用，
   *                而不是伪装成成功且结果为空
   *   - success  → 完整结果对象
   *
   * 结果字段可能是任意历史形态（字符串 / 数组 / 截断摘要），
   * 这里统一包成 JSON 对象，保证协议侧永远是可解析的 JSON。
   */
  private buildToolContent(call: ToolCallUI): string {
    if (call.status === 'error') {
      return JSON.stringify({ success: false, error: call.error ?? 'unknown error' });
    }
    if (call.status === 'pending') {
      return JSON.stringify({
        success: false,
        error: '工具调用未完成（运行被中断），结果不可用',
      });
    }
    const result = call.result;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return JSON.stringify({ success: true, ...(result as Record<string, unknown>) });
    }
    return JSON.stringify({ success: true, result: result ?? null });
  }

  /**
   * 窗口保护（薄封装，统一告警与统计）。阈值为 **token** 预算。
   * 阈值缺省时由 ContextWindowGuard 按共享默认值兜底（不回读全局配置）。
   */
  protect(messages: ChatMessage[], thresholdTokens?: number): ContextGuardResult {
    const result = ContextWindowGuard.protect(messages, thresholdTokens);
    if (result.truncated) {
      console.warn(
        `[ContextEngine] 上下文超限裁剪: ${result.originalTokens} → ${result.finalTokens} token，` +
          `移除 ${result.removedMessages} 条消息`,
      );
    }
    return result;
  }
}

/** 全局单例 */
export const contextEngine = new ContextEngine();

import type { CallToolResult, TextContent, ImageContent } from '@modelcontextprotocol/sdk/types.js';
import { trimDanglingSurrogate } from '@/utils/text/truncate';

/**
 * 工具执行结果。
 *
 * 注意：`content` 是可选的。项目中大量工具返回的是 `{ success, message|error, data }`
 * 这种「业务结果」形态，而没有携带 MCP 风格的 `content` 内容块（消费方
 * `formatToolResult` / `formatResult` 均已对 `content` 缺失做分支处理）。
 * 因此这里用 Omit 收窄基类的必填 `content`，避免类型与真实运行时不一致。
 */
export interface ToolResult extends Omit<CallToolResult, 'content'> {
  success: boolean;
  content?: CallToolResult['content'];
  /** MCP 错误标记（显式声明，避免 Omit 之后只剩索引签名而丢掉窄类型） */
  isError?: boolean;
  data?: any;
  error?: string;
  /** 部分工具用 message 而非 error 承载提示文案 */
  message?: string;
  /**
   * 主载荷通道声明——**哪一份才是这次调用的正题**。
   *
   * 工具结果常有两条通道：`content`（给人 / 给模型读的文本）与 `data`
   * （给程序消费的结构化载荷）。两条通道**可能承载同一批事实**——若消费方
   * 把它们原样一并回传，同一份事实就在模型上下文 / 外部响应里出现两次。
   * 本字段把「谁是正题」变成**生产者显式声明的事实**，消费方据此只取一份：
   *
   * - `'data'`（默认）：`data` 是完整事实，`content` 只是它的摘要或附属说明
   *   （见 buildSuccessPayload）——外部调用方直接拿 `data`；
   * - `'content'`：`content` 承载正题（如 Markdown 结果表、清单正文、页文本），
   *   `data` 只承载事实元数据（导航信息、计数、分页参数）——外部调用方拿
   *   `content` 的正文并附 `data` 的元数据。
   *
   * 未声明 = `'data'`（与历史行为一致）。声明它不是可选的礼貌：没有它，
   * 消费方只能靠「content 能否解析成 JSON」之类的启发式去猜正文在哪，
   * 猜错就会丢信息——这正是 web_search 条目曾对外部调用方丢失的原因。
   */
  primary?: 'data' | 'content';
}

export interface ToolExecutor {
  execute(args: any): Promise<ToolResult>;
}

/**
 * 主载荷通道判定（**唯一口径**）：未声明 = 'data'。
 * 消费方（外部调用方投影、工具面板展示）都从这里取，避免两处各写一套规则
 * 而随时间漂移。
 */
export function primaryChannelOf(result: Pick<ToolResult, 'primary'>): 'data' | 'content' {
  return result.primary === 'content' ? 'content' : 'data';
}

/**
 * content 内容块里所有文本块的拼接（图片等非文本块不计入正文）。
 * 入参刻意收成 unknown：调用方的 content 形态并不统一（MCP 的 ContentBlock[]、
 * 侧边栏工具面板的宽松数组、缺失），运行时按形状防御取文本即可。
 */
export function extractContentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      item =>
        !!item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text',
    )
    .map(item => (item as { text?: unknown }).text)
    .filter((text): text is string => typeof text === 'string')
    .join('\n');
}

/** 对外载荷投影的结果：载荷本体，或需要抛出的错误 */
export type ToolPayloadProjection =
  | { kind: 'payload'; value: Record<string, unknown> }
  | { kind: 'error'; error: string };

/**
 * 把工具结果投影成**一份正题**的对外载荷（外部调用方与工具面板共用同一口径）。
 *
 * 规则与 ToolResult.primary 的声明一致：
 *   - 正题在 content（如 Markdown 结果表、清单正文、页文本）→ 返回
 *     「事实元数据（data）+ 正文（text）」，两边都不丢；
 *   - 正题在 data（默认）→ 返回 data；若 content 恰好是结构化 JSON
 *     （历史形态：content 里放的是 data 的副本），按原样返回，老客户端不变；
 *   - 两者皆无 → 只剩纯文本正文时按 { text } 返回；否则是错误。
 */
export function projectToolPayload(result: ToolResult): ToolPayloadProjection {
  const contentText = extractContentText(result.content);
  const data =
    result.data && typeof result.data === 'object' && !Array.isArray(result.data)
      ? (result.data as Record<string, unknown>)
      : undefined;
  /** content 若恰好是结构化 JSON（历史形态），按原样返回 */
  const parsedContent = (): Record<string, unknown> | undefined => {
    if (!contentText) return undefined;
    try {
      const parsed = JSON.parse(contentText);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };

  if (primaryChannelOf(result) === 'content') {
    return { kind: 'payload', value: { ...(data ?? {}), text: contentText } };
  }
  if (data) {
    return { kind: 'payload', value: parsedContent() ?? data };
  }
  const parsed = parsedContent();
  if (parsed) return { kind: 'payload', value: parsed };
  if (contentText) return { kind: 'payload', value: { text: contentText } };
  if (result.isError || result.error) {
    return { kind: 'error', error: result.error || '工具执行失败' };
  }
  return { kind: 'payload', value: (result as unknown as Record<string, unknown>) ?? {} };
}

export const createErrorResponse = (
  message: string = 'Unknown error, please try again',
): ToolResult => {
  return {
    success: false,
    error: message,
    content: [
      {
        type: 'text',
        text: message
      }
    ]
  };
};

/**
 * 成功响应的 content / data 载荷（`BaseTool.createSuccessResponse` 与技能合成
 * 激活轮共用的唯一拼装规则）：
 *   - `data` = `{ message, ...业务数据 }`（message 缺省为通用成功文案）——
 *     **完整结构化载荷，模型与宿主的唯一事实源**；
 *   - `content[0].text` = 同一份 data 的**紧凑摘要**——一句话结论 + 字段名清单，
 *     **不复制 data 本身，也不复制任何字段值**。
 *
 * 为什么曾经是 data 的 pretty JSON：为了让「只读 content 的消费者」（后台
 * WebSocket 工具执行器按 content 解析 JSON 再回给外部调用方）也能拿到结构化
 * 结果。代价是同一份载荷在模型上下文里出现两遍——正文类工具（页面正文、
 * 指令正文）一次可达数万字符，翻倍即纯浪费。现在 content 退回摘要，
 * 外部调用方改为优先读 data（见 background/tools/tool-executor.ts），
 * 模型上下文里每份信息只出现一次，且摘要让「完整内容在 data 里」显式可见。
 *
 * 抽成独立函数的原因：load_skill 有两条产出路径——模型自主调用（走 BaseTool）
 * 与用户预选技能时由系统代发的一轮合成调用（走
 * utils/skills/skill-instruction.skillLoadToolContent）。两侧必须逐字同源，
 * 模型才无法（也不需要）区分「谁加载的」。
 */

/** 载荷规模超过此值时，摘要额外附上字段名清单（帮助模型定位要找的字段） */
const SUMMARY_FIELD_LIST_MIN_CHARS = 400;
/** 摘要整体长度上限（防止超长 message 把摘要撑大） */
const SUMMARY_MAX_CHARS = 1_200;
/** 字段名清单最多列出的字段数（超出的用省略号收尾） */
const SUMMARY_MAX_FIELDS = 24;

/**
 * 载荷摘要：**不复制载荷**，只给「这次返回了什么」的标签 + 字段名。
 * 首行是 message（人类与模型都能读的一句话结论）；载荷大时再补一行字段名，
 * 让模型知道去 data 里翻哪个键——但绝不把字段值抄一遍（那正是双份占用的根源）。
 * 载荷本身小的时候只留 message：此时任何字段清单都只是等量复制。
 *
 * 防御要点：
 *   - 载荷可能含循环引用 → JSON.stringify 会抛 → 摘要降级为纯 message，
 *     绝不让「算摘要」这件事把整次工具调用带崩（载荷本身仍原样在 data 里）；
 *   - 截断必须经 trimDanglingSurrogate：切点落在增补平面字符（emoji 等）
 *     高位代理上会劈出孤立代理项，严格网关会以 400 拒收整个请求。
 */
function summarizePayload(merged: Record<string, unknown>): string {
  const message = String(merged.message ?? '');
  const keys = Object.keys(merged).filter(key => key !== 'message');
  if (keys.length === 0) return message;
  let size = 0;
  try {
    size = JSON.stringify(merged)?.length ?? 0;
  } catch {
    // 循环引用等不可序列化载荷：摘要降级为纯 message（不猜、不吞、不炸）
    return message;
  }
  if (size <= SUMMARY_FIELD_LIST_MIN_CHARS) return message;
  const shown = keys.slice(0, SUMMARY_MAX_FIELDS);
  const more = keys.length > shown.length ? ` / …共 ${keys.length} 个字段` : '';
  const fieldList = `（完整载荷见 data 字段：${shown.join(' / ')}${more}）`;
  return message.length + fieldList.length > SUMMARY_MAX_CHARS
    ? `${trimDanglingSurrogate(message, SUMMARY_MAX_CHARS)}…`
    : `${message}\n${fieldList}`;
}

export function buildSuccessPayload(
  data: Record<string, unknown>,
  message?: string,
): { content: TextContent[]; data: Record<string, unknown>; primary: 'data' } {
  const merged: Record<string, unknown> = {
    message: message || 'Operation completed successfully',
    ...data,
  };
  return {
    content: [{ type: 'text', text: summarizePayload(merged) }],
    data: merged,
    // data 是完整事实，content 只是它的摘要——消费方据此只取 data
    primary: 'data',
  };
}

/**
 * 模型消息「完整执行轨迹」复制载荷（纯函数）
 *
 * 用途：模型消息操作栏的调试按钮——把这一轮的全部执行过程按时间顺序
 * 复制出来，供 Agent 执行流程分析。与「复制」按钮的分工：
 *   - 复制按钮：只复制末段正文（正式输出），不含任何过程内容；
 *   - 调试按钮：复制完整轨迹，含思考过程、工具调用与工具响应。
 *
 * 载荷形态：结构化标签序列（内容**不做 XML 转义**——原样保留，逐字可比对）
 *
 *   <think>…</think>                   思考（推理片段 / 正文内联的 <think> 段）
 *   <tool_call>            工具调用
 *     <tool_name>…</tool_name>          工具名
 *     <tool_args>…</tool_args>          原始入参（arguments 原始字符串，不重排）
 *     <tool_result>…</tool_result>      工具响应（失败时改用 <tool_error>）
 *   </tool_call>
 *   <notice>…</notice>                终态注记
 *   <compaction …>…</compaction>       上下文压缩
 *   <screenshot />                    截屏标记（图片本体不可复制）
 *   裸文本                            正式输出（不加标签）
 *
 * 载荷**不带任何页眉**（不再有标题 / 消息 ID / 时间戳的框线前缀）——它是一段
 * 可直接喂给分析流程的正文，前缀只会干扰解析。
 *
 * 口径约定：
 *   - 顺序 = 片段流（parts）的时间顺序，不做任何重排——「先想、再调工具、
 *     再看结果、最后作答」的执行链必须原样可读；
 *   - 思考一律进 <think>：推理片段（reasoning）与正文里内联的 <think> 段
 *     两种来源还原成同一形态；正文其余部分保持裸文本（正式输出不套标签）；
 *   - 工具入参原样保留（arguments 原始 JSON 字符串不重排、不美化）；工具响应
 *     按值序列化（字符串原样，对象按 JSON 美化，与工具行展开区同一口径）；
 *   - 截图（image 片段）只留一行标记，不复制图片本体：图片是二进制，
 *     进不了剪贴板文本，对流程分析也无增量价值（知道「此处截过屏」即可）；
 *   - 旧记录（只有 reasoning_content / 只有 toolCalls，没有对应片段）由
 *     调用方作为兜底传入，避免旧会话的轨迹凭空缺一段；
 *   - 单段超长（工具响应可达数十 KB）按上限截断并标注，防止一个巨型
 *     payload 撑爆剪贴板、连带后面的步骤全部丢失。
 *
 * 本模块只产出结构化标签，不产出界面文案——载荷面向执行流程分析，
 * 不是界面渲染（文案一律由 i18n 承载）。
 */

import type { IndexedMessagePart, ToolCallUI } from '../../types/chat';

/** 单个片段载荷的字符上限（工具响应可能达数十 KB） */
const TRACE_SECTION_MAX_CHARS = 200_000;

/** 轨迹构造入参 */
export interface ExecutionTraceInput {
  /** 可见片段（已剔除空片段），按时间顺序；文本片段保留原始 <think> 段 */
  parts: IndexedMessagePart[];
  /** 旧记录兜底：整段思考内容（片段流中没有 reasoning 片段时） */
  legacyReasoning?: string;
  /** 旧记录兜底：工具调用（片段流中没有 tool 片段时） */
  legacyToolCalls?: ToolCallUI[];
}

/**
 * 截断超长片段载荷。截断必须留痕——静默截断会让分析者误以为流程本就
 * 只有这么长，反而得出错误结论。
 */
function truncate(text: string): string {
  if (text.length <= TRACE_SECTION_MAX_CHARS) return text;
  return `${text.slice(0, TRACE_SECTION_MAX_CHARS)}\n<truncated original_length="${text.length}" />`;
}

/**
 * 任意值 → 可读文本：对象/数组按 JSON 美化输出，其余走字符串化。
 * 含循环引用等不可序列化结构时降级为字符串快照（与工具行展开区同口径）。
 */
function stringifyPayload(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    const text = JSON.stringify(value, null, 2);
    return text ?? String(value);
  } catch {
    return String(value);
  }
}

/** 标签包裹：内容原样置于标签之间（内容为空时不产出标签） */
function wrap(tag: string, content: string): string {
  const body = content.trim();
  if (!body) return '';
  return `<${tag}>\n${body}\n</${tag}>`;
}

/** 轨迹中的一段内容：思考段 / 正式输出段 */
type TraceSegment =
  | { kind: 'think'; content: string }
  | { kind: 'output'; content: string };

/**
 * 把一段原始正文切成「思考段 / 正式输出段」序列（保持先后顺序）。
 *
 * 识别两种形态：闭合的 `<think>…</think>` 与未闭合的 `<think>…`（流式中断
 * 的思考段常见）。切出来的思考段会在轨迹里还原成 <think> 标签，其余部分
 * 是正式输出（裸文本）。
 */
function splitThinkSegments(content: string): TraceSegment[] {
  const segments: TraceSegment[] = [];
  // 每次调用新建正则：共享 lastIndex 会让第二段文本漏掉首个匹配
  const pattern = /<think>([\s\S]*?)(?:<\/think>|$)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > cursor) {
      segments.push({ kind: 'output', content: content.slice(cursor, match.index) });
    }
    segments.push({ kind: 'think', content: match[1] });
    cursor = match.index + match[0].length;
    if (match[0].length === 0) pattern.lastIndex += 1; // 防御零宽匹配导致的死循环
  }
  if (cursor < content.length) {
    segments.push({ kind: 'output', content: content.slice(cursor) });
  }
  return segments;
}

/**
 * 思考内容 → <think> 块序列。
 *
 * 内容本身若带 <think> 段则逐段还原（不再二次包裹），其余文本整体作思考
 * 收拢成一块——推理片段与旧记录的 reasoning_content 都走这里。
 */
function thinkingBlocks(content: string): string[] {
  const blocks: string[] = [];
  let plain = '';
  for (const segment of splitThinkSegments(content)) {
    if (segment.kind === 'think') {
      if (plain.trim()) {
        blocks.push(wrap('think', plain));
        plain = '';
      }
      const block = wrap('think', segment.content);
      if (block) blocks.push(block);
      continue;
    }
    plain += segment.content;
  }
  if (plain.trim()) blocks.push(wrap('think', plain));
  return blocks;
}

/**
 * 工具调用 → <tool_call> 块。
 *
 * 结构：工具名 + 原始入参 + 响应（失败时是错误信息）。状态与耗时并入
 * 起始标签的属性——它们是这一次调用的元信息，不占正文位置。
 */
function buildToolSection(call: ToolCallUI): string {
  const attrs: string[] = [];
  if (call.status) attrs.push(`status="${call.status}"`);
  if (typeof call.executionTime === 'number' && Number.isFinite(call.executionTime)) {
    attrs.push(`duration_ms="${Math.round(call.executionTime)}"`);
  }

  const lines: string[] = [attrs.length ? `<tool_call> ${attrs.join(' ')}` : '<tool_call>'];
  lines.push(`<tool_name>${(call.name ?? '').trim()}</tool_name>`);

  const args = (call.arguments ?? '').trim();
  if (args) {
    lines.push(`<tool_args>\n${truncate(args)}\n</tool_args>`);
  }

  if (call.status === 'error') {
    const error = (call.error ?? '').trim();
    if (error) {
      lines.push(`<tool_error>\n${truncate(error)}\n</tool_error>`);
    }
  } else if (call.result !== undefined && call.result !== null) {
    const result = stringifyPayload(call.result);
    if (result.trim()) {
      lines.push(`<tool_result>\n${truncate(result)}\n</tool_result>`);
    }
  }

  lines.push('</tool_call>');
  return lines.join('\n');
}

/** 上下文压缩片段 → <compaction> 块（压缩是过程事件，同样进轨迹） */
function buildCompactionSection(state: NonNullable<IndexedMessagePart['part']['compaction']>): string {
  const attrs: string[] = [`status="${state.status}"`];
  if (state.trigger) attrs.push(`trigger="${state.trigger}"`);
  if (typeof state.originalTokens === 'number') attrs.push(`original_tokens="${state.originalTokens}"`);
  if (typeof state.summaryTokens === 'number') attrs.push(`summary_tokens="${state.summaryTokens}"`);
  if (typeof state.durationMs === 'number') attrs.push(`duration_ms="${Math.round(state.durationMs)}"`);

  const body = state.status === 'error'
    ? (state.error ?? '').trim()
    : (state.summary ?? '').trim();
  if (!body) return `<compaction ${attrs.join(' ')} />`;
  return `<compaction ${attrs.join(' ')}>\n${truncate(body)}\n</compaction>`;
}

/**
 * 构造完整执行轨迹文本（按时间顺序）。
 *
 * 返回空串表示本轮没有任何可复制的内容——调用方据此禁用按钮，
 * 避免点击后剪贴板被写入空文本。
 */
export function buildExecutionTraceText(input: ExecutionTraceInput): string {
  const parts = Array.isArray(input.parts) ? input.parts : [];
  const sections: string[] = [];

  for (const { part } of parts) {
    if (part.type === 'text') {
      const raw = part.content ?? '';
      if (!raw.trim()) continue;
      // 正文里可能内联 <think> 段：思考归 <think>，其余保持裸文本（正式输出）
      for (const segment of splitThinkSegments(raw)) {
        if (segment.kind === 'think') {
          const block = wrap('think', segment.content);
          if (block) sections.push(block);
          continue;
        }
        const text = segment.content.trim();
        if (text) sections.push(text);
      }
      continue;
    }
    if (part.type === 'reasoning') {
      sections.push(...thinkingBlocks(part.content ?? ''));
      continue;
    }
    if (part.type === 'tool') {
      if (!part.toolCall) continue;
      sections.push(buildToolSection(part.toolCall));
      continue;
    }
    if (part.type === 'notice') {
      const block = wrap('notice', part.content ?? '');
      if (block) sections.push(block);
      continue;
    }
    if (part.type === 'compaction') {
      if (!part.compaction) continue;
      sections.push(buildCompactionSection(part.compaction));
      continue;
    }
    if (part.type === 'image') {
      // 截图只留标记：知道此处发生过截屏即可，图片本体不进剪贴板
      sections.push('<screenshot />');
    }
  }

  // 旧记录兜底：片段流里没有对应类型时，用消息级的旧字段补齐
  const hasReasoningPart = parts.some(part => part.part.type === 'reasoning');
  const hasToolPart = parts.some(part => part.part.type === 'tool');
  if (!hasReasoningPart && input.legacyReasoning?.trim()) {
    sections.push(...thinkingBlocks(input.legacyReasoning));
  }
  if (!hasToolPart) {
    for (const call of input.legacyToolCalls ?? []) {
      sections.push(buildToolSection(call));
    }
  }

  return sections.join('\n\n');
}

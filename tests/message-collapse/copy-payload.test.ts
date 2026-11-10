/**
 * 执行轨迹复制载荷纯函数回归（buildExecutionTraceText）。
 *
 * 覆盖：结构化标签形态（<think> / <tool_call> / <notice> / <screenshot />）、
 * 正式输出裸文本（不加标签）、时间顺序分段、工具入参原样保留与响应美化、
 * 工具失败只带错误信息、正文内联 <think> 的还原、旧记录兜底
 * （legacyReasoning / legacyToolCalls）、超长载荷截断留痕、空内容返回
 * 空串（调用方据此禁用按钮）、载荷不含页眉前缀。
 *
 * 运行：node tests/message-collapse/run.mjs（npm run test:message-collapse）
 */

import assert from 'node:assert/strict';
import { buildExecutionTraceText } from '@/entrypoints/sidepanel/utils/chat/message-copy-payload';
import type { IndexedMessagePart, MessagePart, ToolCallUI } from '@/entrypoints/sidepanel/types/chat';

const indexed = (part: MessagePart, index: number): IndexedMessagePart => ({ index, part });

const toolCall = (overrides: Partial<ToolCallUI> = {}): ToolCallUI => ({
  id: 't1',
  name: 'navigate',
  status: 'success',
  arguments: '{"url":"https://example.com"}',
  ...overrides,
});

// 1. 标签形态 + 顺序：思考 → 工具调用 → 输出 → 注记，各段按时间顺序排列
{
  const parts: IndexedMessagePart[] = [
    indexed({ type: 'reasoning', content: '先看看页面结构' }, 0),
    indexed({ type: 'tool', toolCall: toolCall({ result: { title: 'Example' } }) }, 1),
    indexed({ type: 'text', content: '页面标题是 Example' }, 2),
    indexed({ type: 'notice', content: '回复被截断' }, 3),
  ];
  const trace = buildExecutionTraceText({ parts });

  // 思考：<think> 标签包裹
  assert.ok(trace.includes('<think>\n先看看页面结构\n</think>'), '思考过程进入 <think> 标签');
  // 工具调用：XML 形态（工具名 / 入参 / 响应）
  assert.ok(trace.includes('<tool_name>navigate</tool_name>'), '工具名进入 tool_call 标签');
  assert.ok(trace.includes('<tool_args>'), '工具入参进入 tool_args 标签');
  assert.ok(trace.includes('<tool_result>'), '工具响应进入 tool_result 标签');
  assert.ok(trace.includes('<tool_call>'), '工具调用整体被 tool_call 标签包裹');
  assert.ok(trace.includes('</tool_call>'), 'tool_call 标签闭合');
  // 正式输出：裸文本，不套任何标签
  assert.ok(trace.includes('\n\n页面标题是 Example\n\n'), '正式输出保持裸文本');
  assert.ok(!trace.includes('<output>'), '正式输出不加标签');
  // 终态注记：notice 标签
  assert.ok(trace.includes('<notice>\n回复被截断\n</notice>'), '终态注记进入 notice 标签');
  // 顺序：思考在前、工具居中、正文与注记在后
  const thinkingAt = trace.indexOf('先看看页面结构');
  const toolAt = trace.indexOf('<tool_name>');
  const outputAt = trace.indexOf('页面标题是 Example');
  const noticeAt = trace.indexOf('<notice>');
  assert.ok(thinkingAt < toolAt && toolAt < outputAt && outputAt < noticeAt, '轨迹严格按片段流顺序排列');
  assert.ok(!trace.includes('[1]'), '不再用「[1] 思考」这类序号拼接');
}

// 1b. 无页眉前缀：载荷是可直接喂给分析流程的正文，不带标题 / 消息 ID / 时间戳
{
  const trace = buildExecutionTraceText({
    parts: [indexed({ type: 'text', content: '正文' }, 0)],
    messageId: 'm-1',
    timestamp: 1_700_000_000_000,
  } as unknown as Parameters<typeof buildExecutionTraceText>[0]);
  assert.ok(!trace.includes('════════'), '载荷不含分隔线页眉');
  assert.ok(!trace.includes('m-1'), '载荷不含消息 ID');
  assert.ok(!trace.includes('Agent 执行轨迹'), '载荷不含标题行');
  assert.ok(!trace.includes('消息 ID'), '载荷不含「消息 ID」字段');
}

// 2. 工具入参原样保留（不重排），响应按 JSON 美化输出
{
  const trace = buildExecutionTraceText({
    parts: [indexed({ type: 'tool', toolCall: toolCall({ result: { title: 'Example', ok: true } }) }, 0)],
  });
  assert.ok(trace.includes('{"url":"https://example.com"}'), '工具入参原样保留（不重排）');
  assert.ok(trace.includes('"title": "Example"'), '工具响应被包含');
}

// 3. 工具失败：错误信息进入 tool_error，参数一并保留（复盘失败调用需要入参）
{
  const trace = buildExecutionTraceText({
    parts: [indexed({ type: 'tool', toolCall: toolCall({ status: 'error', error: '页面不可达' }) }, 0)],
  });
  assert.ok(trace.includes('<tool_error>\n页面不可达\n</tool_error>'), '失败原因进入 tool_error');
  assert.ok(!trace.includes('<tool_result>'), '失败调用不产出 tool_result');
  assert.ok(trace.includes('{"url":"https://example.com"}'), '失败调用同样保留参数');
  assert.ok(trace.includes('status="error"'), '状态并入 tool_call 属性');
}

// 4. 截图：只留标记，不复制图片本体（引用哈希也不进轨迹）
{
  const trace = buildExecutionTraceText({
    parts: [
      indexed({ type: 'image', imageRef: 'hash-abc123' }, 0),
      indexed({ type: 'text', content: '正文' }, 1),
    ],
  });
  assert.ok(trace.includes('<screenshot />'), '截屏留一行标记');
  assert.ok(trace.includes('正文'), '截图后的正文仍在轨迹里');
  assert.ok(!trace.includes('hash-abc123'), '截图引用不进轨迹（图片本体不可复制）');
}

// 5. 正文内联的 <think> 段：还原成 <think> 标签，其余正文保持裸文本
{
  const trace = buildExecutionTraceText({
    parts: [indexed({ type: 'text', content: '<think>先看结构</think>页面标题是 Example' }, 0)],
  });
  assert.ok(trace.includes('<think>\n先看结构\n</think>'), '正文内联的思考段还原成 think 标签');
  assert.ok(trace.includes('\n\n页面标题是 Example'), '正文其余部分保持裸文本');
  assert.ok(
    trace.indexOf('先看结构') < trace.indexOf('页面标题是 Example'),
    '思考段排在正文之前（原文顺序不变）',
  );
}

// 5c. 未闭合的 <think> 段（流式中断）同样还原
{
  const trace = buildExecutionTraceText({
    parts: [indexed({ type: 'text', content: '<think>没说完的思考' }, 0)],
  });
  assert.ok(trace.includes('<think>\n没说完的思考\n</think>'), '未闭合的思考段照样还原');
}

// 6. 旧记录兜底：片段流没有 reasoning / tool 时，用消息级旧字段补齐
{
  const trace = buildExecutionTraceText({
    parts: [indexed({ type: 'text', content: '正文' }, 0)],
    legacyReasoning: '旧记录的整段思考',
    legacyToolCalls: [toolCall({ id: 'old-1', name: 'old_tool' })],
  });
  assert.ok(trace.includes('<think>\n旧记录的整段思考\n</think>'), '旧记录思考被兜底补齐');
  assert.ok(trace.includes('<tool_name>old_tool</tool_name>'), '旧记录工具调用被兜底补齐');
}

// 6b. 兜底只在缺失时生效：片段流已有 reasoning / tool 时不得重复输出
{
  const trace = buildExecutionTraceText({
    parts: [
      indexed({ type: 'reasoning', content: '片段里的思考' }, 0),
      indexed({ type: 'tool', toolCall: toolCall({ id: 'new-1', name: 'new_tool' }) }, 1),
    ],
    legacyReasoning: '旧记录的整段思考',
    legacyToolCalls: [toolCall({ id: 'old-1', name: 'old_tool' })],
  });
  assert.ok(!trace.includes('旧记录的整段思考'), '片段流已有思考时不重复输出旧字段');
  assert.ok(!trace.includes('old_tool'), '片段流已有工具时不重复输出旧字段');
}

// 7. 空内容：返回空串（调用方据此禁用调试按钮）
{
  assert.equal(buildExecutionTraceText({ parts: [] }), '');
  assert.equal(buildExecutionTraceText({ parts: [indexed({ type: 'text', content: '   ' }, 0)] }), '', '空白正文不算可复制内容');
}

// 8. 超长载荷：截断且留痕（原始长度可见）
{
  const huge = 'x'.repeat(200_001);
  const trace = buildExecutionTraceText({
    parts: [indexed({ type: 'tool', toolCall: toolCall({ result: huge }) }, 0)],
  });
  assert.ok(trace.includes('<truncated original_length="200001" />'), '截断标注带原始长度');
  assert.ok(trace.length < 210_000, '超长内容被截断，轨迹体量可控');
}

// 9. 畸形输入：缺载荷的片段不抛错
{
  assert.doesNotThrow(() =>
    buildExecutionTraceText({
      parts: [indexed({ type: 'tool' }, 0), indexed({ type: 'compaction' }, 1), indexed({ type: 'image' }, 2)],
    }),
  );
}

console.log('[message-collapse] 执行轨迹复制载荷纯函数全部场景通过（标签形态 / 正式输出裸文本 / 无页眉前缀 / 入参原样 / 失败分支 / 截屏标记 / 内联思考还原 / 旧记录兜底 / 空内容 / 截断留痕 / 畸形防御）。');

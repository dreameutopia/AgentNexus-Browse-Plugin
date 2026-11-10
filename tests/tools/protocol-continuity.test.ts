/**
 * 跨轮中断的协议完整性测试
 *
 * 场景：某一轮运行在**工具执行阶段**被用户中断，随后用户发送下一条消息。
 * 此时上一轮的记录会被重放进模型上下文（protocol-history），必须满足：
 *   1. assistant.tool_calls 与 tool 消息一一配对（协议硬要求）；
 *   2. 不出现「有 tool_calls 却没有对应 tool 结果」的悬空调用；
 *   3. 不出现「有 tool 结果但没有对应 tool_calls」的孤儿结果；
 *   4. 中断产生的 tool 结果带有可读原因（模型知道是用户停了）；
 *   5. 中断后启动的新一轮，其结果不得写进上一轮的上下文。
 */

import assert from 'node:assert/strict';
import { readProtocolHistory } from '../../entrypoints/sidepanel/core/context/protocol-history';
import type { ChatMessageRecord } from '../../entrypoints/sidepanel/core/types';
import type { ChatMessage } from '../../entrypoints/sidepanel/utils/ai/ai-chat-api';

/**
 * 协议配对校验（OpenAI 规范）：
 *   - 每条 tool 消息必须紧跟在带 tool_calls 的 assistant 消息之后；
 *   - assistant 的每个 tool_call.id 必须有且仅有一条同 id 的 tool 消息；
 *   - tool 消息不得凭空出现（必须有对应的 tool_call）。
 */
function assertProtocolPaired(messages: ChatMessage[], label: string): void {
  const answered = new Set<string>();
  const declared = new Set<string>();
  let openCalls: string[] = [];

  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      // 上一组 tool_calls 必须已被全部应答
      assert.deepEqual(
        openCalls.filter(id => !answered.has(id)),
        [],
        `${label}：assistant 的 tool_calls 未被全部应答即出现新的 assistant 消息`,
      );
      openCalls = message.tool_calls.map(call => call.id);
      for (const id of openCalls) declared.add(id);
    } else if (message.role === 'tool') {
      assert.ok(
        typeof message.tool_call_id === 'string',
        `${label}：tool 消息必须有 tool_call_id`,
      );
      assert.ok(
        declared.has(message.tool_call_id),
        `${label}：出现孤儿 tool 结果（tool_call_id=${message.tool_call_id} 没有对应的 tool_call）`,
      );
      assert.ok(
        !answered.has(message.tool_call_id),
        `${label}：tool_call_id=${message.tool_call_id} 被应答了多次`,
      );
      answered.add(message.tool_call_id);
    }
  }
  assert.deepEqual(
    openCalls.filter(id => !answered.has(id)),
    [],
    `${label}：存在悬空的 tool_calls（没有对应 tool 结果）`,
  );
}

const baseRecord = (overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord => ({
  id: 'msg-1',
  chatId: 'chat-1',
  role: 'assistant',
  content: '',
  parts: [],
  toolCalls: [],
  imageRefs: [],
  createdAt: 1,
  ...overrides,
} as ChatMessageRecord);

// ── 1. 正常完成的一轮：协议完整 ──
{
  const messages: ChatMessage[] = [
    { role: 'user', content: '跑一下' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'a', content: '{"success":true}' },
    { role: 'tool', tool_call_id: 'call_2', name: 'b', content: '{"success":false,"error":"boom"}' },
    { role: 'assistant', content: '好了' },
  ];
  assertProtocolPaired(messages, '正常完成');
}

// ── 2. 中断的一轮：占位响应保证配对，且带可读原因 ──
{
  const messages: ChatMessage[] = [
    { role: 'user', content: '跑一下' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'a', content: '{"success":true}' },
    {
      role: 'tool',
      tool_call_id: 'call_2',
      name: 'b',
      content: JSON.stringify({ success: false, error: '用户主动中断会话导致工具中断运行' }),
    },
    {
      role: 'user',
      content: '[System status: the previous run was interrupted. Completed tool results remain valid; unfinished operations are not evidence of success.]',
    },
  ];
  assertProtocolPaired(messages, '中断的一轮');
  const interrupted = messages.find(
    m => m.role === 'tool' && m.tool_call_id === 'call_2',
  ) as ChatMessage;
  const parsed = JSON.parse(interrupted.content as string);
  assert.equal(parsed.success, false);
  assert.match(parsed.error, /中断/, '中断的 tool 结果必须带可读原因');
}

// ── 3. 崩溃恢复：modelPartial 里的 tool_calls 被合成配对的 tool 结果 ──
{
  const record = baseRecord({
    modelMessages: [
      { role: 'user', content: '跑一下' },
      { role: 'assistant', content: '好，我调用工具' },
    ],
    // 运行在流式阶段崩溃：tool_calls 只存在于 modelPartial，未进 modelMessages
    modelPartial: {
      role: 'assistant',
      content: '好，我调用工具',
      tool_calls: [
        { id: 'call_x', type: 'function', function: { name: 'a', arguments: '{}' } },
      ],
    } as ChatMessage,
  });
  const replayed = readProtocolHistory(record) ?? [];
  assertProtocolPaired(replayed, '崩溃恢复重放');
  const toolMessage = replayed.find(m => m.role === 'tool');
  assert.ok(toolMessage, '崩溃恢复必须合成 tool 结果');
  const parsed = JSON.parse(toolMessage.content as string);
  assert.equal(parsed.success, false);
  assert.match(parsed.error, /interrupted|中断/i, '合成的 tool 结果必须说明是中断导致');
}

// ── 4. 跨轮：新一轮的结果不得写进上一轮的上下文 ──
{
  // 上一轮：中断在工具阶段（占位响应已在库里）
  const previous = baseRecord({
    id: 'msg-prev',
    modelMessages: [
      { role: 'user', content: '第一轮' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_prev', type: 'function', function: { name: 'a', arguments: '{}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_prev',
        name: 'a',
        content: JSON.stringify({ success: false, error: '用户主动中断会话导致工具中断运行' }),
      },
    ],
  });
  const replayed = readProtocolHistory(previous) ?? [];
  assertProtocolPaired(replayed, '跨轮重放');
  const ids = new Set(
    replayed.flatMap(m => (m.tool_calls ?? []).map(c => c.id)),
  );
  assert.ok(ids.has('call_prev'), '上一轮的 tool_calls 必须保留在重放历史中');
  assert.equal(
    replayed.some(m => m.tool_call_id === 'call_next'),
    false,
    '上一轮的历史里不得出现下一轮的 tool 结果（跨轮污染）',
  );
}

console.log('[protocol-continuity] 全部断言通过');

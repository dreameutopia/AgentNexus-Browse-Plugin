/**
 * 消息折叠分组纯函数回归（groupAnswerParts / buildLivePartSegments）。
 *
 * 覆盖所有终态时序：正常结束 / 用户中止（正文后残留工具 / 纯思考 / 纯工具轮）/
 * 异常收尾 / 学习模式收尾轮（提交工具 + 终态注记），以及直播态连续过程
 * （连续工具调用 / 工具+思考 / 截图混合）的小折叠分段规则。
 *
 * 运行：node tests/message-collapse/run.mjs（npm run test:message-collapse）
 */

import assert from 'node:assert/strict';
import {
  groupAnswerParts,
  buildLivePartSegments,
  MIN_LIVE_CLUSTER_PARTS,
} from '@/entrypoints/sidepanel/utils/chat/part-grouping';
import type { IndexedMessagePart, MessagePart, ToolCallUI } from '@/entrypoints/sidepanel/types/chat';

// ── 构造工具 ──
const at = (index: number, part: MessagePart): IndexedMessagePart => ({ index, part });const text = (content: string): MessagePart => ({ type: 'text', content });
const reasoning = (content = '思考'): MessagePart => ({ type: 'reasoning', content });
const notice = (content = '终态注记'): MessagePart => ({ type: 'notice', content });
const image = (ref = 'hash'): MessagePart => ({ type: 'image', imageRef: ref });
const tool = (id: string, status: ToolCallUI['status'] = 'success', executionTime?: number): MessagePart => ({
  type: 'tool',
  toolCall: {
    id,
    name: id,
    status,
    ...(executionTime === undefined ? {} : { executionTime }),
  },
});
const indexed = (...parts: MessagePart[]): IndexedMessagePart[] => parts.map((part, i) => at(i, part));
const kinds = (entries: ReturnType<typeof buildLivePartSegments>) =>
  entries.map(e => (e.kind === 'cluster-bar' ? 'bar' : e.clusterKey ? 'grouped' : 'part'));

// ════════ groupAnswerParts：结束态「前奏折叠」 ════════

// 1. 正常结束：末段正文之前的全部过程内容折叠（原有正确行为不回归）
{
  const g = groupAnswerParts(
    indexed(reasoning(), tool('t1'), text('先看一下'), tool('t2'), text('最终答复')),
    { legacyReasoningText: false },
  );
  assert.deepEqual(
    g.prelude.map(p => p.part.type),
    ['reasoning', 'tool', 'text', 'tool'],
    '正常结束：正文前的推理/工具/中间文本全部入前奏',
  );
  assert.equal(g.final?.part.type, 'text');
  assert.equal((g.final?.part as { content?: string }).content, '最终答复');
  assert.deepEqual(g.tail, [], '正常结束无终态注记');
  assert.equal(g.hasReasoning, true);
  assert.equal(g.toolCount, 2);
}

// 2. 中止：正文之后残留的工具调用必须并入折叠（修复点：不再滞留在折叠条下方）
{
  const g = groupAnswerParts(indexed(text('我来处理'), tool('t1'), tool('t2')), {
    legacyReasoningText: false,
  });
  assert.deepEqual(
    g.prelude.map(p => p.part.type),
    ['tool', 'tool'],
    '中止：正文后的工具残留并入前奏折叠',
  );
  assert.equal((g.final?.part as { content?: string }).content, '我来处理');
  assert.deepEqual(g.tail, []);
}

// 3. 中止于纯思考：无任何正文 → 前奏收纳全部、折叠条独立成立（修复点）
{
  const g = groupAnswerParts(indexed(reasoning()), { legacyReasoningText: false });
  assert.equal(g.final, null);
  assert.equal(g.prelude.length, 1);
  assert.deepEqual(g.tail, []);
  assert.equal(g.hasReasoning, true);
}

// 4. 中止于纯工具轮（此前轮次也无正文）：全部折叠
{
  const g = groupAnswerParts(indexed(tool('t1'), tool('t2')), { legacyReasoningText: false });
  assert.equal(g.final, null);
  assert.equal(g.prelude.length, 2);
}

// 5. 异常收尾：错误文本追加为最后文本片段 → 过程全部折叠、错误保持可见
{
  const g = groupAnswerParts(indexed(reasoning(), tool('t1'), text('部分输出\n\n错误卡片')), {
    legacyReasoningText: false,
  });
  assert.deepEqual(g.prelude.map(p => p.part.type), ['reasoning', 'tool']);
  assert.equal(g.final?.part.type, 'text');
}

// 6. 学习模式收尾轮：提交工具与终态注记在正文之后 → 工具折叠、注记保持可见
{
  const g = groupAnswerParts(indexed(text('学习完成'), tool('submit_skill'), notice()), {
    legacyReasoningText: false,
  });
  assert.deepEqual(g.prelude.map(p => p.part.type), ['tool'], '提交工具并入前奏');
  assert.equal(g.tail.length, 1, '终态注记不被折叠遮蔽');
  assert.equal(g.final?.part.type, 'text');
}

// 7. 学习模式收尾轮（无正文）：工具全折叠，注记可见
{
  const g = groupAnswerParts(indexed(tool('t1'), tool('submit_skill'), notice()), {
    legacyReasoningText: false,
  });
  assert.equal(g.final, null);
  assert.equal(g.prelude.length, 2);
  assert.equal(g.tail.length, 1);
}

// 8. vision 截图：过程截图并入折叠
{
  const g = groupAnswerParts(indexed(image(), reasoning(), tool('t1'), text('答复')), {
    legacyReasoningText: false,
  });
  assert.deepEqual(g.prelude.map(p => p.part.type), ['image', 'reasoning', 'tool']);
}

// 9. 防御：正文之前出现 notice（当前引擎不会产生，脏数据兜底）→ 仍保持可见
{
  const g = groupAnswerParts(indexed(notice(), text('答复')), { legacyReasoningText: false });
  assert.deepEqual(g.prelude, []);
  assert.equal(g.tail.length, 1);
  assert.equal(g.final?.part.type, 'text');
}

// 10. 纯文本回答：无前奏（不启用折叠条）
{
  const g = groupAnswerParts(indexed(text('只是文字')), { legacyReasoningText: false });
  assert.deepEqual(g.prelude, []);
  assert.equal(g.final?.part.type, 'text');
  assert.equal(g.toolCount, 0);
}

// 11. 仅注记：不折叠任何内容
{
  const g = groupAnswerParts(indexed(notice()), { legacyReasoningText: false });
  assert.deepEqual(g.prelude, []);
  assert.equal(g.final, null);
  assert.equal(g.tail.length, 1);
}

// 12. 摘要口径：工具数与思考判定（含正文之后并入的部分 + 旧记录回退）
{
  const g = groupAnswerParts(indexed(text('a'), tool('t1'), tool('t2')), {
    legacyReasoningText: false,
  });
  assert.equal(g.toolCount, 2, '正文之后的工具同样计入摘要');
  const legacy = groupAnswerParts(indexed(text('a')), { legacyReasoningText: true });
  assert.equal(legacy.hasReasoning, true, '旧记录 reasoning_content 计入思考摘要');
  const legacyNoText = groupAnswerParts(indexed(), { legacyReasoningText: true });
  assert.equal(legacyNoText.final, null);
  assert.equal(legacyNoText.hasReasoning, true, '旧记录无任何片段时思考摘要仍成立（折叠条独立承载）');
  const fallback = groupAnswerParts(indexed(tool('t1'), text('a')), {
    legacyReasoningText: false,
    totalToolCalls: 7,
  });
  assert.equal(fallback.toolCount, 7, '消息级 toolCalls 总数优先');
  assert.equal(groupAnswerParts(indexed(tool('t1'), text('a')), { legacyReasoningText: false }).toolCount, 1, '未提供回退时按片段计数');
}

// 13. 多段正文：锚点取最后一个文本片段，其后的过程内容并入前奏
{
  const g = groupAnswerParts(indexed(text('a'), tool('t1'), text('b'), tool('t2')), {
    legacyReasoningText: false,
  });
  assert.equal((g.final?.part as { content?: string }).content, 'b');
  assert.deepEqual(g.prelude.map(p => p.part.type), ['text', 'tool', 'tool']);
}

// ════════ buildLivePartSegments：直播态「连续过程小折叠」 ════════

assert.equal(MIN_LIVE_CLUSTER_PARTS, 3);

// 1. 非直播（结束态分组）：不产生任何折叠条，逐项原样输出
{
  const entries = buildLivePartSegments(indexed(tool('t1'), tool('t2'), tool('t3')), {
    collapse: false,
  });
  assert.deepEqual(kinds(entries), ['part', 'part', 'part']);
}

// 2. 直播：两个连续工具不折叠（低于阈值，避免一两条信息也立折叠条）
{
  const entries = buildLivePartSegments(indexed(tool('t1'), tool('t2')), { collapse: true });
  assert.deepEqual(kinds(entries), ['part', 'part']);
}

// 3. 直播末尾簇：连续 3 个工具 → 前 2 个收拢成条，最新 1 个保持可见
{
  const entries = buildLivePartSegments(indexed(tool('t1'), tool('t2'), tool('t3')), {
    collapse: true,
  });
  assert.deepEqual(kinds(entries), ['bar', 'grouped', 'grouped', 'part']);
  const bar = entries[0];
  assert.equal(bar.kind, 'cluster-bar');
  assert.equal(bar.counts.tools, 2);
  assert.equal(bar.grouped.length, 2);
  const visible = entries[entries.length - 1];
  assert.equal(visible.kind, 'part');
  assert.equal(visible.clusterKey, undefined, '最新活动不挂簇标识（恒可见）');
}

// 4. 直播中段簇：后续已有正文接续 → 整组收拢（全部被取代）
{
  const entries = buildLivePartSegments(
    indexed(tool('t1'), tool('t2'), tool('t3'), text('中间说明')),
    { collapse: true },
  );
  assert.deepEqual(kinds(entries), ['bar', 'grouped', 'grouped', 'grouped', 'part']);
}

// 5. 工具+思考+截图混合簇：计数分项正确，最新工具保持可见
{
  const entries = buildLivePartSegments(
    indexed(image(), reasoning(), tool('t1'), tool('t2')),
    { collapse: true },
  );
  const bar = entries[0];
  assert.equal(bar.kind, 'cluster-bar');
  assert.deepEqual(bar.counts, { tools: 1, reasoning: 1, images: 1 });
  assert.equal(kinds(entries).filter(k => k === 'part').length, 1, '仅最新工具可见');
}

// 6. 正文打断簇：两个各为 2 的簇都不折叠
{
  const entries = buildLivePartSegments(
    indexed(tool('t1'), tool('t2'), text('说明'), tool('t3'), tool('t4')),
    { collapse: true },
  );
  assert.deepEqual(kinds(entries), ['part', 'part', 'part', 'part', 'part']);
}

// 7. 多簇并存：中段簇整组收拢 + 末尾簇保留最新一项
{
  const entries = buildLivePartSegments(
    indexed(tool('t1'), tool('t2'), tool('t3'), text('说明'), reasoning('r1'), reasoning('r2'), reasoning('r3')),
    { collapse: true },
  );
  assert.deepEqual(kinds(entries), [
    'bar', 'grouped', 'grouped', 'grouped', // 中段工具簇
    'part', // 说明正文
    'bar', 'grouped', 'grouped', 'part', // 末尾思考簇（最新一段可见）
  ]);
  const bars = entries.filter(e => e.kind === 'cluster-bar');
  assert.equal(bars.length, 2);
  assert.notEqual(bars[0].key, bars[1].key, '不同簇的标识互异');
}

// 8. 已结算工具耗时合计入条；未结算（pending / 缺时长）不计
{
  const entries = buildLivePartSegments(
    indexed(
      tool('t1', 'success', 1500),
      tool('t2', 'error', 2300),
      tool('t3', 'pending'),
      tool('t4'),
    ),
    { collapse: true },
  );
  const bar = entries[0];
  assert.equal(bar.kind, 'cluster-bar');
  assert.equal(bar.durationMs, 3800);
}

// 9. notice 打断簇（终态注记不参与小折叠）
{
  const entries = buildLivePartSegments(
    indexed(notice(), tool('t1'), tool('t2'), tool('t3')),
    { collapse: true },
  );
  assert.deepEqual(kinds(entries), ['part', 'bar', 'grouped', 'grouped', 'part']);
}

// 10. 空输入
{
  assert.deepEqual(buildLivePartSegments([], { collapse: true }), []);
  assert.deepEqual(buildLivePartSegments([], { collapse: false }), []);
}

console.log('[message-collapse] 分组纯函数全部场景通过（结束态前奏折叠 + 直播态连续过程小折叠）。');

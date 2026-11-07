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
} from '@/entrypoints/sidepanel/utils/chat/part-grouping';
import type { IndexedMessagePart, MessagePart, ToolCallUI } from '@/entrypoints/sidepanel/types/chat';

// ── 构造工具 ──
const at = (index: number, part: MessagePart): IndexedMessagePart => ({ index, part });const text = (content: string): MessagePart => ({ type: 'text', content });
const reasoning = (content = '思考'): MessagePart => ({ type: 'reasoning', content });
const notice = (content = '终态注记'): MessagePart => ({ type: 'notice', content });
const image = (ref = 'hash'): MessagePart => ({ type: 'image', imageRef: ref });
const compaction = (
  status: 'pending' | 'success' | 'error' = 'success',
): MessagePart => ({
  type: 'compaction',
  compaction: { status, trigger: 'runtime', ...(status === 'success' ? { originalTokens: 147968, summaryTokens: 2560, summary: '<summary>…</summary>' } : {}) },
});
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

// ════════ buildLivePartSegments：连续过程小折叠（正文输出为簇间断片） ════════

// 1. 单个过程片段不折叠（含伴随文本）：一行紧凑容器不值得立折叠条
{
  assert.deepEqual(kinds(buildLivePartSegments(indexed(tool('t1')))), ['part']);
  assert.deepEqual(kinds(buildLivePartSegments(indexed(text('说明'), tool('t1')))), ['part', 'part']);
}

// 2. 两个连续工具（抵达片段流末尾）→ 前者收拢、最新工具可见
{
  const entries = buildLivePartSegments(indexed(tool('t1'), tool('t2')));
  assert.deepEqual(kinds(entries), ['bar', 'grouped', 'part']);
  const bar = entries[0];
  assert.equal(bar.kind, 'cluster-bar');
  assert.equal(bar.counts.tools, 1);
  const visible = entries[entries.length - 1];
  assert.equal(visible.kind, 'part');
  assert.equal(visible.clusterKey, undefined, '最新活动不挂簇标识（恒可见）');
}

// 3. 思考+工具 / 工具+思考 任意组合（用户点名的形态）都收拢
{
  assert.deepEqual(
    kinds(buildLivePartSegments(indexed(reasoning(), tool('t1')))),
    ['bar', 'grouped', 'part'],
  );
  assert.deepEqual(
    kinds(buildLivePartSegments(indexed(tool('t1'), reasoning()))),
    ['bar', 'grouped', 'part'],
  );
  assert.deepEqual(
    kinds(buildLivePartSegments(indexed(tool('t1'), reasoning(), tool('t2')))),
    ['bar', 'grouped', 'grouped', 'part'],
  );
}

// 4. 正文文本是正式输出：恒可见并隔离簇——工具之间一旦出现文本，连续即被隔断
{
  const entries = buildLivePartSegments(indexed(tool('t1'), text('现在点击搜索框'), tool('t2')));
  assert.deepEqual(kinds(entries), ['part', 'part', 'part'], '文本隔断两侧，各自单独可见，不立折叠条');
}

// 5. 前导文本保持可见（模型的开场说明不折叠）
{
  assert.deepEqual(
    kinds(buildLivePartSegments(indexed(text('我来处理这个任务'), tool('t1'), tool('t2')))),
    ['part', 'bar', 'grouped', 'part'],
  );
}

// 6. 尾随正文保持可见，其前的簇整组收拢（直播中正在流出的答案不被遮住）
{
  assert.deepEqual(
    kinds(buildLivePartSegments(indexed(tool('t1'), tool('t2'), text('最终答复正文')))),
    ['bar', 'grouped', 'grouped', 'part'],
  );
}

// 7. 多轮时间线：每轮「工具+思考」成簇，轮间文本隔离、正文后整组收拢
{
  const entries = buildLivePartSegments(indexed(tool('t1'), reasoning(), text('第一轮结论'), tool('t2'), reasoning('r2')));
  // {t1,reasoning} 后有正文 → 整组收拢；正文可见；{t2,r2} 抵达末尾 → 保留最新思考可见
  assert.deepEqual(
    kinds(entries),
    ['bar', 'grouped', 'grouped', 'part', 'bar', 'grouped', 'part'],
  );
  const bars = entries.filter(e => e.kind === 'cluster-bar');
  assert.notEqual(bars[0].key, bars[1].key, '不同簇的标识互异');
}

// 8. 混合簇计数（截图 + 思考 + 工具 + 压缩计数恒在）
{
  const entries = buildLivePartSegments(indexed(image(), reasoning(), tool('t1'), tool('t2')));
  const bar = entries[0];
  assert.equal(bar.kind, 'cluster-bar');
  assert.deepEqual(bar.counts, { tools: 1, reasoning: 1, images: 1, compactions: 0 });
  assert.equal(kinds(entries).filter(k => k === 'part').length, 1, '仅最新工具可见');
}

// 9. notice 恒可见且切断簇
{
  // 两侧各自不足两个过程片段：全部可见，无折叠条
  assert.deepEqual(
    kinds(buildLivePartSegments(indexed(tool('t1'), notice(), tool('t2')))),
    ['part', 'part', 'part'],
  );
  // 两侧各自成簇：notice 之前的簇整组收拢（其后有内容），之后的簇保留最新一项
  assert.deepEqual(
    kinds(buildLivePartSegments(indexed(tool('t1'), tool('t2'), notice(), tool('t3'), tool('t4')))),
    ['bar', 'grouped', 'grouped', 'part', 'bar', 'grouped', 'part'],
  );
}

// 10. 已结算工具耗时合计入条；未结算（pending / 缺时长）不计；压缩耗时同口径计入
{
  const entries = buildLivePartSegments(
    indexed(
      tool('t1', 'success', 1500),
      tool('t2', 'error', 2300),
      tool('t3', 'pending'),
      tool('t4'),
    ),
  );
  const bar = entries[0];
  assert.equal(bar.kind, 'cluster-bar');
  assert.equal(bar.durationMs, 3800);
  // 压缩耗时并入簇合计（pending 不计，与工具未结算同口径）
  const withCompaction = buildLivePartSegments(
    indexed(tool('t1', 'success', 1000), {
      ...compaction('success'),
      compaction: { ...compaction('success').compaction!, durationMs: 8500 },
    }, compaction('pending')),
  );
  const compactionBar = withCompaction[0];
  assert.equal(compactionBar.kind, 'cluster-bar');
  assert.equal(compactionBar.durationMs, 9500, '已结算压缩的耗时计入簇合计');
}

// 11. 纯文本 / 纯推理单段：无折叠条
{
  assert.deepEqual(kinds(buildLivePartSegments(indexed(text('a'), text('b')))), ['part', 'part']);
  assert.deepEqual(kinds(buildLivePartSegments(indexed(reasoning()))), ['part']);
}

// 12. 空输入
{
  assert.deepEqual(buildLivePartSegments([]), []);
}

// ════════ 上下文压缩片段（type='compaction'）：与工具调用同一过程语义 ════════
//（构造器 compaction() 定义在文件顶部的构造工具区，与 text/tool 同列）

// C1. 结束态：压缩片段并入前奏折叠，计数单列（与 toolCount 同口径）
{
  const g = groupAnswerParts(indexed(compaction(), tool('t1'), text('压缩后继续答复')), {
    legacyReasoningText: false,
  });
  assert.deepEqual(g.prelude.map(p => p.part.type), ['compaction', 'tool'], '压缩片段随过程内容入前奏');
  assert.equal(g.compactionCount, 1);
  assert.equal(g.toolCount, 1);
  // 无工具仅压缩：折叠条单独成立，计数仍准确
  const only = groupAnswerParts(indexed(compaction(), text('答复')), { legacyReasoningText: false });
  assert.deepEqual(only.prelude.map(p => p.part.type), ['compaction']);
  assert.equal(only.compactionCount, 1);
  assert.equal(only.toolCount, 0);
  // 多次压缩计数累加
  const twice = groupAnswerParts(indexed(compaction(), compaction(), text('答复')), { legacyReasoningText: false });
  assert.equal(twice.compactionCount, 2);
}

// C2. 直播态：压缩是过程片段——与工具相邻成簇、计数入条；
//     抵达流末尾的 pending 压缩保持条外可见（当前活动不被折叠遮住）
{
  // [tool, compaction-pending]：簇收拢 tool，压缩行（当前活动）可见
  const entries = buildLivePartSegments(indexed(tool('t1'), compaction('pending')));
  assert.deepEqual(kinds(entries), ['bar', 'grouped', 'part']);
  const bar = entries[0];
  assert.equal(bar.kind, 'cluster-bar');
  assert.equal(bar.counts.tools, 1);
  assert.equal(bar.counts.compactions, 0, '条外可见的最新压缩不计入条内');
  // [compaction-success, tool]：压缩被取代 → 整簇收拢，仅最新工具可见
  const superseded = buildLivePartSegments(indexed(compaction(), tool('t2')));
  assert.deepEqual(kinds(superseded), ['bar', 'grouped', 'part']);
  assert.equal((superseded[0] as { counts: { compactions: number } }).counts.compactions, 1);
  // 正文之后的压缩 + 工具：文本断片隔离，两侧各自成簇
  const mixed = buildLivePartSegments(indexed(compaction(), text('中间结论'), tool('t1'), compaction('pending')));
  assert.deepEqual(
    mixed.map(e => (e.kind === 'cluster-bar' ? `bar(${e.counts.compactions}c)` : e.clusterKey ? 'grouped' : 'part')),
    ['part', 'part', 'bar(0c)', 'grouped', 'part'],
    '正文隔断：孤立压缩单行可见，末簇保留 pending 压缩条外可见',
  );
}

// C3. 压缩独占时间线（前无工具后有正文）：单行容器恒可见，不立折叠条
{
  assert.deepEqual(kinds(buildLivePartSegments(indexed(text('收到'), compaction(), text('继续')))), ['part', 'part', 'part']);
  // 纯压缩单段（中止于压缩轮的极端形态）
  assert.deepEqual(kinds(buildLivePartSegments(indexed(compaction()))), ['part']);
}

console.log('[message-collapse] 分组纯函数全部场景通过（结束态前奏折叠 + 连续过程小折叠：正文隔离语义）。');

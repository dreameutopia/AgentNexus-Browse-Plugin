/**
 * 压缩片段生命周期纯函数回归（pushCompactionPart / settleCompactionPart /
 * settlePendingCompactionParts / toggleCompactionExpanded）。
 *
 * 覆盖：pending 推送 → done/failed 结算（最后一条 pending）→ 重复结算与
 * 乱序事件防御 → 运行终态中断收拢（全部 pending → error）→ 展开切换
 * （pending 不可展开、结算态可切换）。这些函数是引擎侧 record.parts 与
 * UI 侧直播消息双写共用的唯一实现，任何漂移都会造成终态按索引合并错位。
 *
 * 运行：node tests/message-collapse/run.mjs（npm run test:message-collapse）
 */

import assert from 'node:assert/strict';
import {
  pushCompactionPart,
  settleCompactionPart,
  settlePendingCompactionParts,
  toggleCompactionExpanded,
  historyDisplayParts,
  createCompactionPart,
} from '@/entrypoints/sidepanel/utils/chat/compaction-part';
import type { MessagePart } from '@/entrypoints/sidepanel/types/chat';

const text = (content: string): MessagePart => ({ type: 'text', content });
const asCompaction = (part: MessagePart) => {
  assert.equal(part.type, 'compaction');
  return part.compaction!;
};

// 1. 推送：pending 片段追加到流末尾，携带触发路径与头部体量（不可变追加）
{
  const original: MessagePart[] = [text('前文')];
  const parts = pushCompactionPart(original, { trigger: 'runtime', originalTokens: 147968 });
  assert.equal(parts.length, 2);
  assert.equal(original.length, 1, '原数组不被变异');
  assert.equal(parts[0], original[0], '原片段原样保留');
  const state = asCompaction(parts[1]);
  assert.equal(state.status, 'pending');
  assert.equal(state.trigger, 'runtime');
  assert.equal(state.originalTokens, 147968);
}

// 1b. 构造器：压缩片段的统一构造（引擎种子与 UI 种子共用）
{
  const part = createCompactionPart({ status: 'success', trigger: 'pre-run', originalTokens: 51200, summaryTokens: 1024, summary: '<summary>x</summary>' });
  assert.equal(part.type, 'compaction');
  assert.deepEqual(part.compaction, {
    status: 'success', trigger: 'pre-run', originalTokens: 51200, summaryTokens: 1024, summary: '<summary>x</summary>',
  });
  // 载荷拷贝：调用方后续改动不影响已构造片段（两侧各自持有独立副本）
  const state = { status: 'success' as const, trigger: 'pre-run' as const, originalTokens: 1 };
  const built = createCompactionPart(state);
  state.originalTokens = 2;
  assert.equal(built.compaction?.originalTokens, 1, '构造器拷贝载荷，不共享引用');
  // 畸形防御：缺状态时按 pending 之外的缺省不崩（调用方类型已保证，这里只验证不抛）
  assert.doesNotThrow(() => createCompactionPart({ status: 'error' }));
}

// 2. 结算成功：最后一条 pending 变 success，携带摘要与 token 数
{
  const parts = pushCompactionPart([], { trigger: 'runtime', originalTokens: 100 });
  assert.equal(settleCompactionPart(parts, {
    status: 'success',
    originalTokens: 147968,
    summaryTokens: 2560,
    summary: '<summary><task>目标</task></summary>',
    durationMs: 8500,
  }), true);
  const state = asCompaction(parts[0]);
  assert.equal(state.status, 'success');
  assert.equal(state.originalTokens, 147968, '结算覆盖 start 时的估算值');
  assert.equal(state.summaryTokens, 2560);
  assert.equal(state.summary, '<summary><task>目标</task></summary>');
  assert.equal(state.durationMs, 8500);
}

// 3. 结算失败：error 状态与原因；后续再次结算同一片段被拒绝（幂等防御）
{
  const parts = pushCompactionPart([], { trigger: 'runtime' });
  assert.equal(settleCompactionPart(parts, { status: 'error', error: '压缩请求失败: 超时', durationMs: 1200 }), true);
  assert.equal(asCompaction(parts[0]).status, 'error');
  assert.equal(asCompaction(parts[0]).error, '压缩请求失败: 超时');
  assert.equal(settleCompactionPart(parts, { status: 'success' }), false, '已结算片段不再接受二次结算');
  assert.equal(asCompaction(parts[0]).status, 'error');
}

// 4. 多次压缩：结算只命中最后一条 pending，先前已结算的不受影响
{
  const parts = [
    ...pushCompactionPart([], { trigger: 'runtime' }),
  ];
  settleCompactionPart(parts, { status: 'success', summaryTokens: 100 });
  const grown = pushCompactionPart(parts, { trigger: 'runtime' });
  settleCompactionPart(grown, { status: 'error', error: 'x' });
  assert.equal(asCompaction(grown[0]).status, 'success', '第一次压缩结果保持');
  assert.equal(asCompaction(grown[1]).status, 'error', '第二次压缩按事件结算');
}

// 4b. 结算恒命中「最后一条 pending」；已结算片段不阻断其结算
{
  // 典型形态：发送前压缩（已结算）在流首，运行中压缩（pending）在其后
  const parts = [
    ...pushCompactionPart([], { trigger: 'pre-run' }),
    text('中间输出'),
    ...pushCompactionPart([], { trigger: 'runtime' }),
  ];
  // 结算末条 pending（index 2），流首的 pending 不受影响
  assert.equal(settleCompactionPart(parts, { status: 'success', summaryTokens: 10 }), true);
  assert.equal(asCompaction(parts[2]).status, 'success');
  assert.equal(asCompaction(parts[0]).status, 'pending', '只结算最后一条 pending');

  // 新增 pending：结算必须落到新 pending 上，已结算的片段不被覆盖
  const grown = pushCompactionPart(parts, { trigger: 'runtime' });
  assert.equal(settleCompactionPart(grown, { status: 'error', error: 'boom' }), true);
  assert.equal(asCompaction(grown[3]).status, 'error', '新 pending 被结算');
  assert.equal(asCompaction(grown[2]).status, 'success', '中间的已结算压缩不被覆盖');

  // 关键语义：pending 在前、已结算在后时，结算必须落到前面的 pending
  // （旧实现「遇已结算即 return false」会让靠前的 pending 永远结算不到）
  const mixed = [
    ...pushCompactionPart([], { trigger: 'runtime' }),   // index 0：pending
    ...pushCompactionPart([], { trigger: 'runtime' }),   // index 1：pending
  ];
  settleCompactionPart(mixed, { status: 'success' });    // 结算 index 1
  assert.equal(asCompaction(mixed[1]).status, 'success');
  assert.equal(asCompaction(mixed[0]).status, 'pending');
  // 再来一条结算：跳过已结算的 index 1，命中 index 0 的 pending
  assert.equal(settleCompactionPart(mixed, { status: 'error', error: 'late' }), true);
  assert.equal(asCompaction(mixed[0]).status, 'error', '靠前的 pending 同样可被结算');
  assert.equal(asCompaction(mixed[1]).status, 'success', '已结算片段不被二次覆盖');
}

// 5. 无 pending 可结算（乱序 done / 未发生压缩）→ false，片段流不变
{
  assert.equal(settleCompactionPart([text('a')], { status: 'success' }), false);
  assert.equal(settleCompactionPart([], { status: 'error', error: 'x' }), false);
}

// 6. 运行终态中断收拢：全部 pending → error（可读中断说明），已结算的不覆盖
{
  // settleCompactionPart 从流末向前定位最后一条 pending：要结算「第一条」，
  // 必须在第二条进入流之前结算（与真实时序一致——事件按发生顺序到达）
  const first = pushCompactionPart([], { trigger: 'pre-run' });
  settleCompactionPart(first, { status: 'success' });
  const parts: MessagePart[] = [...first, text('中间输出'), ...pushCompactionPart([], { trigger: 'runtime' })];
  assert.equal(asCompaction(parts[0]).status, 'success');
  assert.equal(asCompaction(parts[2]).status, 'pending');
  assert.equal(settlePendingCompactionParts(parts, '压缩随运行结束而中断'), true);
  assert.equal(asCompaction(parts[0]).status, 'success', '已结算片段不被中断文案覆盖');
  assert.equal(asCompaction(parts[2]).status, 'error');
  assert.equal(asCompaction(parts[2]).error, '压缩随运行结束而中断');
  // 再次收拢：无 pending → false
  assert.equal(settlePendingCompactionParts(parts, 'x'), false);
}

// 7. 展开切换：结算态可切换；pending 与非压缩片段（含越界下标）拒绝
{
  const pending = pushCompactionPart([], { trigger: 'runtime' });
  assert.equal(toggleCompactionExpanded(pending, 0), false, 'pending 不可展开');

  const done = pushCompactionPart([], { trigger: 'runtime' });
  settleCompactionPart(done, { status: 'success', summary: '<summary>…</summary>' });
  assert.equal(toggleCompactionExpanded(done, 0), true);
  assert.equal(asCompaction(done[0]).expanded, true);
  assert.equal(toggleCompactionExpanded(done, 0), true);
  assert.equal(asCompaction(done[0]).expanded, false);

  const withText: MessagePart[] = [text('a')];
  assert.equal(toggleCompactionExpanded(withText, 0), false, '非压缩片段拒绝');
  assert.equal(toggleCompactionExpanded(done, 9), false, '越界下标拒绝');
  assert.equal(toggleCompactionExpanded(done, -1), false, '负下标拒绝');
}

// 8. 历史重载展示归一：pending（崩溃残留）→ 中断错误；无 pending 零拷贝；
//    归一只作用于返回副本，绝不污染调用方持有的记录对象
{
  // 无 pending：返回原数组引用（零拷贝快路径）
  const clean: MessagePart[] = [text('a')];
  assert.equal(historyDisplayParts(clean, '中断'), clean, '无 pending 时返回原引用');

  // 已结算片段同样走零拷贝
  const settledOnly = pushCompactionPart([], { trigger: 'runtime' });
  settleCompactionPart(settledOnly, { status: 'success', summary: 's' });
  assert.equal(historyDisplayParts(settledOnly, '中断'), settledOnly, '已结算片段不触发拷贝');

  // 崩溃残留：pending 结算为中断错误，且返回新数组 / 新片段对象
  const crashed = pushCompactionPart([text('崩溃前的输出')], { trigger: 'runtime' });
  const normalized = historyDisplayParts(crashed, '压缩随运行结束而中断');
  assert.notEqual(normalized, crashed, '有待结算片段时返回新数组');
  assert.equal(asCompaction(crashed[1]).status, 'pending', '原记录对象不被污染（备份/缓存安全）');
  assert.equal(asCompaction(normalized[1]).status, 'error');
  assert.equal(asCompaction(normalized[1]).error, '压缩随运行结束而中断');
  assert.equal(normalized[0], crashed[0], '无关片段共享引用（最小拷贝）');

  // 混合形态：多个 pending 全部结算，已结算的成功片段保持原状
  //（settleCompactionPart 从流末定位最后一条 pending：c2 先正常结算，c1 仍是 pending）
  const mixed = [
    ...pushCompactionPart([], { trigger: 'pre-run' }),  // c1 pending
    text('中间输出'),
    ...pushCompactionPart([], { trigger: 'runtime' }),  // c2 pending
  ];
  settleCompactionPart(mixed, { status: 'success', summary: 's' });  // 结算 c2（最后一条 pending）
  const grown = pushCompactionPart(mixed, { trigger: 'runtime' });   // c3 pending（崩溃残留）
  const mixedView = historyDisplayParts(grown, '中断');
  assert.equal(asCompaction(mixedView[0]).status, 'error', '更早的 pending（c1）同样被归一结算');
  assert.equal(asCompaction(mixedView[2]).status, 'success', '已结算的成功片段原样保留');
  assert.equal(asCompaction(mixedView[3]).status, 'error', '崩溃残留片段（c3）被结算');

  // 畸形防御：片段缺 compaction 载荷（脏数据）不拖垮归一
  const malformed: MessagePart[] = [{ type: 'compaction' }, text('a')];
  assert.equal(historyDisplayParts(malformed, '中断'), malformed, '缺载荷片段按无 pending 处理');

  // 空数组
  assert.deepEqual(historyDisplayParts([], '中断'), []);
}

console.log('[message-collapse] 压缩片段生命周期纯函数全部场景通过（推送 / 结算 / 幂等防御 / 中断收拢 / 展开切换 / 历史重载归一）。');

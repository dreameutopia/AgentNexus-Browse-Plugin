/**
 * 消息元数据领域测试
 *
 * 覆盖本次「消息耗时展示 + 赞踩反馈」特性的两块纯逻辑：
 *   1. formatDuration —— 耗时分档格式化（毫秒 / 秒 / 分秒 / 时分、双语、非法输入）；
 *   2. mergeMessagePatch —— 消息字段补丁合并（undefined 删键、身份字段保护、
 *      updatedAt 推进、不可变性），即 patchMessage 的 DB 事务内合并语义。
 *
 * 运行：node tests/message-meta/run.mjs（esbuild 打包后在 Node 执行）
 */

import { formatDuration } from '../../entrypoints/sidepanel/utils/chat/duration';
import { mergeMessagePatch } from '../../entrypoints/sidepanel/core/context/chat-database';
import { setLocale, getLocale } from '../../utils/i18n/core';
import type { ChatMessageRecord } from '../../entrypoints/sidepanel/core/types';

// ==================== 断言工具 ====================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ==================== 测试数据 ====================

function makeRecord(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    id: 'msg_test',
    chatId: 'chat_test',
    seq: 7,
    role: 'assistant',
    content: 'hello',
    parts: [{ type: 'text', content: 'hello' }],
    reasoning: '',
    toolCalls: [],
    status: 'done',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// ============================================================
section('1. formatDuration 分档（毫秒 / 秒 / 分秒 / 时分）');
{
  setLocale('zh-CN');
  check('切到 zh-CN 生效', getLocale() === 'zh-CN');

  check('0ms', formatDuration(0) === '0ms', formatDuration(0));
  check('860ms 毫秒整数', formatDuration(860) === '860ms', formatDuration(860));
  check('999ms 毫秒上界', formatDuration(999) === '999ms', formatDuration(999));
  check('1000ms → 1.0s', formatDuration(1000) === '1.0s', formatDuration(1000));
  check('12.345s → 12.3s（一位小数）', formatDuration(12_345) === '12.3s', formatDuration(12_345));
  check('59.499s → 59.5s（秒档上界）', formatDuration(59_499) === '59.5s', formatDuration(59_499));
  check(
    '59.5s → 1 分 0 秒（按总秒数分档，不出现 60.0s）',
    formatDuration(59_500) === '1 分 0 秒',
    formatDuration(59_500),
  );
  check(
    '134.2s → 2 分 14 秒（不出现 134.2s）',
    formatDuration(134_200) === '2 分 14 秒',
    formatDuration(134_200),
  );
  check(
    '3599.999s → 1 小时 0 分（不出现 60 分 0 秒）',
    formatDuration(3_599_999) === '1 小时 0 分',
    formatDuration(3_599_999),
  );
  check('2 小时 5 分（小时档）', formatDuration(7_500_000) === '2 小时 5 分', formatDuration(7_500_000));

  check('负数 → 空串', formatDuration(-1) === '', JSON.stringify(formatDuration(-1)));
  check('NaN → 空串', formatDuration(Number.NaN) === '', JSON.stringify(formatDuration(Number.NaN)));
  check('Infinity → 空串', formatDuration(Number.POSITIVE_INFINITY) === '');
}

// ============================================================
section('2. formatDuration 英文文案（locale 切换联动）');
{
  setLocale('en');
  check('切到 en 生效', getLocale() === 'en');
  check('12.3s 不受语言影响', formatDuration(12_345) === '12.3s', formatDuration(12_345));
  check('分秒档英文', formatDuration(134_200) === '2m 14s', formatDuration(134_200));
  check('时分档英文', formatDuration(7_500_000) === '2h 5m', formatDuration(7_500_000));
  // 文案 key 缺失时 t 会回落为原始 key——断言输出不包含 key 字样即证明目录完整
  check(
    '分钟档文案 key 存在（未回落原始 key）',
    !formatDuration(134_200).includes('sidepanel.chat.'),
    formatDuration(134_200),
  );
  setLocale('zh-CN');
}

// ============================================================
section('3. mergeMessagePatch —— 合并与字段保护');
{
  const now = 9_999_999;

  // 3.1 普通字段合并 + updatedAt 推进
  const base = makeRecord();
  const merged = mergeMessagePatch(base, { feedback: 'up' }, now);
  check('feedback 写入', merged.feedback === 'up', String(merged.feedback));
  check('updatedAt 推进为注入值', merged.updatedAt === now, String(merged.updatedAt));
  check('未指定字段保持原值', merged.content === 'hello' && merged.seq === 7);

  // 3.2 undefined = 删键（反馈清除语义）
  const withFeedback = makeRecord({ feedback: 'down' });
  const cleared = mergeMessagePatch(withFeedback, { feedback: undefined }, now);
  check('显式 undefined 删除已有键', !('feedback' in cleared), `'feedback' in cleared = ${'feedback' in cleared}`);
  check('删键后其余字段无损', cleared.id === 'msg_test' && cleared.content === 'hello');

  // 3.3 patch 不含该键 → 保留原值（「不传 ≠ 清除」）
  const kept = mergeMessagePatch(withFeedback, { content: 'updated' }, now);
  check('未出现在 patch 的键保留原值', kept.feedback === 'down', String(kept.feedback));
  check('同 patch 的其他键正常合并', kept.content === 'updated');

  // 3.4 身份字段保护（patch 试图改写 id/chatId/seq 被忽略）
  const tampered = mergeMessagePatch(
    base,
    { id: 'msg_hacked', chatId: 'chat_hacked', seq: 999 },
    now,
  );
  check('id 不可被 patch 改写', tampered.id === 'msg_test', tampered.id);
  check('chatId 不可被 patch 改写', tampered.chatId === 'chat_test', tampered.chatId);
  check('seq 不可被 patch 改写', tampered.seq === 7, String(tampered.seq));

  // 3.5 updatedAt 由调用方统一推进，patch 自带的值被覆盖
  const withUpdatedAt = mergeMessagePatch(base, { updatedAt: 12345 }, now);
  check('patch 的 updatedAt 被统一值覆盖', withUpdatedAt.updatedAt === now, String(withUpdatedAt.updatedAt));

  // 3.6 不可变性（入参不被改动）
  const original = makeRecord({ feedback: 'up' });
  mergeMessagePatch(original, { feedback: undefined }, now);
  check('入参 existing 不被改动', original.feedback === 'up' && original.updatedAt === 1000);
}

// ============================================================
section('4. mergeMessagePatch —— 边界与防御');
{
  const now = 42;

  // 4.1 对本就没有 feedback 键的记录执行清除 → 不产生键
  const plain = makeRecord();
  const result = mergeMessagePatch(plain, { feedback: undefined }, now);
  check('对缺失键执行清除不产生该键', !('feedback' in result));

  // 4.2 空 patch → 仅推进 updatedAt
  const emptyPatch = mergeMessagePatch(plain, {}, now);
  check('空 patch 只推进 updatedAt', emptyPatch.updatedAt === now && emptyPatch.content === 'hello');

  // 4.3 多键同时 undefined 删除
  const multi = makeRecord({ feedback: 'up', imageRefs: ['a', 'b'] });
  const multiResult = mergeMessagePatch(multi, { feedback: undefined, imageRefs: undefined }, now);
  check(
    '多键同时删除',
    !('feedback' in multiResult) && !('imageRefs' in multiResult),
    `feedback=${'feedback' in multiResult}, imageRefs=${'imageRefs' in multiResult}`,
  );

  // 4.4 嵌套数组引用共享但入参不受影响（put 整条结构化克隆，不原地改写）
  const arr = ['ref1'];
  const withRefs = makeRecord({ imageRefs: arr });
  const merged = mergeMessagePatch(withRefs, { imageRefs: ['ref2'] }, now);
  check('数组字段被 patch 替换', merged.imageRefs?.length === 1 && merged.imageRefs[0] === 'ref2');
  check('入参数组不被改动', arr.length === 1 && arr[0] === 'ref1');
}

// ==================== 汇总 ====================

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failures.length > 0) {
  console.log(`失败用例: ${failures.join(' | ')}`);
}
process.exit(failed > 0 ? 1 : 0);

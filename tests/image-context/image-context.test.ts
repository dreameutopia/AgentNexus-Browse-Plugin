/**
 * 图片上下文领域单元测试
 *
 * 覆盖：
 *   1. token 估算口径（图片固定成本校准锚、CJK/拉丁/emoji 启发式、空串与坏输入）
 *   2. 消息级估算（图片部件计数、base64 载荷剥离、循环引用回落）
 *   3. 预算截断（前缀 ≤ 预算、代理对安全、空预算）
 *   4. 前缀单调性（窗口守卫「从新到旧保留」依赖的性质）
 *   5. 图片引用归一（形态校验、去重保序、上限截断、任意输入不抛错）
 *   6. 上下文窗口守卫（图片按固定成本计入、装不下即丢、system 保护、
 *      工具调用原子配对、NUL 剥离）
 *
 * 运行：node tests/image-context/run.mjs   （或 npm run test:image-context）
 */

import {
  IMAGE_CONTEXT_TOKENS,
  estimateTextTokens,
  estimateMessageTokens,
  estimateMessageTokensDetailed,
  sliceTextToTokenBudget,
} from '../../entrypoints/sidepanel/utils/ai/token-estimate';
import {
  isImageRef,
  normalizeImageRefs,
  IMAGE_REF_MAX_PER_MESSAGE,
} from '../../entrypoints/sidepanel/core/images/image-store';
import { ContextWindowGuard } from '../../entrypoints/sidepanel/utils/ai/context-window-guard';
import { CONTEXT_THRESHOLD_MIN } from '../../entrypoints/sidepanel/utils/channels/channel-types';
import type { ChatMessage, VisionContent } from '../../entrypoints/sidepanel/utils/ai/ai-chat-api';

// ==================== 极简断言 ====================

let passed = 0;
const failures: string[] = [];

function check(cond: boolean, label: string, extra?: unknown): void {
  if (cond) passed++;
  else failures.push(label + (extra !== undefined ? ` => ${JSON.stringify(extra)}` : ''));
}

function eq(actual: unknown, expected: unknown, label: string): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    { actual, expected },
  );
}

function throwsNot(fn: () => unknown, label: string): boolean {
  try {
    fn();
    return true;
  } catch (error) {
    failures.push(`${label} => 抛错: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// ==================== 测试数据工具 ====================

/** 合法内容哈希引用（64 位小写 hex；i 从 0 起保证互不相同） */
function hexRef(i: number): string {
  return i.toString(16).padStart(64, '0');
}

/** 文本部件 */
function textPart(text: string): VisionContent {
  return { type: 'text', text };
}

/** 图片部件（data URL 可任意长度，用于验证载荷不参与文本估算） */
function imagePart(dataUrl: string): VisionContent {
  return { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } };
}

// ==================== 1. token 估算口径 ====================

// 校准锚：唯一允许写死图片成本数值的地方（其余断言一律引用常量）。
// 1200 按视口截图（≈1200×800 → Claude ≈1280 / OpenAI high-detail ≈765-1100）校准。
eq(IMAGE_CONTEXT_TOKENS, 1200, '图片固定计入 1200 token（单一事实源校准锚）');

eq(estimateTextTokens(''), 0, '空串 0 token');
eq(estimateTextTokens('你好世界'), 4, 'CJK 按 1 token/字');
eq(estimateTextTokens('abcd'), 1, '4 个拉丁字符 = 1 token');
eq(estimateTextTokens('abc'), 1, '不足 4 字符向上取整');
eq(estimateTextTokens('a'), 1, '单字符至少 1 token');
eq(estimateTextTokens('😀'), 1, '非 BMP（emoji）按 1 token');
eq(estimateTextTokens('😀😀😀'), 3, '多个 emoji 逐个计数');
eq(estimateTextTokens('你好ab'), 3, '混合文本：CJK 2 + 拉丁 0.5 → 向上取整 3');
eq(estimateTextTokens('\uD800'), 1, '孤立代理项不抛错且至少 1 token');

// ==================== 2. 消息级估算 ====================

{
  const plain = { role: 'user', content: '你好' } as ChatMessage;
  const detail = estimateMessageTokensDetailed(plain);
  eq(detail.imageTokens, 0, '纯文本消息图片成本为 0');
  eq(detail.totalTokens, detail.textTokens + detail.imageTokens, '合计 = 文本 + 图片');
  eq(estimateMessageTokens(plain), detail.totalTokens, '单值接口与分解接口一致');
  check(detail.textTokens > 0, '纯文本消息有文本成本', detail);
}

{
  const hugeUrl = `data:image/png;base64,${'A'.repeat(500000)}`;
  const msg = {
    role: 'user',
    content: [textPart('看图'), imagePart(hugeUrl)],
  } as ChatMessage;
  const detail = estimateMessageTokensDetailed(msg);
  eq(detail.imageTokens, IMAGE_CONTEXT_TOKENS, '单张图片按固定成本计');
  check(detail.textTokens < 60, 'base64 载荷被剥离、不淹没文本成本', detail);
  eq(detail.totalTokens, detail.textTokens + IMAGE_CONTEXT_TOKENS, '单图消息合计 = 文本 + 图片固定成本');
}

{
  const msg = {
    role: 'user',
    content: [
      imagePart('data:image/png;base64,AA'),
      textPart('两张图'),
      imagePart('data:image/jpeg;base64,BB'),
    ],
  } as ChatMessage;
  eq(
    estimateMessageTokensDetailed(msg).imageTokens,
    IMAGE_CONTEXT_TOKENS * 2,
    '两张图片按固定成本 × 2 计',
  );
}

{
  const noImage = { role: 'user', content: [textPart('x')] } as ChatMessage;
  eq(estimateMessageTokensDetailed(noImage).imageTokens, 0, '仅文本部件不计图片成本');
}

{
  // 坏输入防御：任意形态不抛错且返回有限数值
  const circular: Record<string, unknown> = { content: 'x' };
  circular.self = circular;
  const cases: unknown[] = [
    null,
    undefined,
    'plain string',
    42,
    {},
    { content: null },
    { content: [null, 'str', 123, { type: 'other' }] },
    circular,
  ];
  let allFinite = true;
  for (const item of cases) {
    const ok = throwsNot(() => {
      const detail = estimateMessageTokensDetailed(item);
      if (!Number.isFinite(detail.totalTokens) || detail.totalTokens < 0) allFinite = false;
    }, `坏输入不抛错: ${String(item).slice(0, 20)}`);
    if (!ok) allFinite = false;
  }
  check(allFinite, '坏输入一律返回有限非负数值');
}

// ==================== 3. 预算截断 ====================

{
  const text = 'hello world';
  eq(sliceTextToTokenBudget(text, 100), text, '预算充足返回原文');
  eq(sliceTextToTokenBudget(text, 0), '', '零预算返回空串');
  eq(sliceTextToTokenBudget('', 10), '', '空文本返回空串');

  const long = '汉'.repeat(5000);
  const sliced = sliceTextToTokenBudget(long, 1000);
  check(long.startsWith(sliced), '截断结果是原文前缀');
  check(
    estimateTextTokens(sliced) <= 1000,
    '截断结果不超过预算',
    estimateTextTokens(sliced),
  );

  // 代理对安全：切点落在 emoji 中间时回退，不产生孤立代理项
  const emojiText = `a${'😀'.repeat(100)}`;
  const emojiSliced = sliceTextToTokenBudget(emojiText, 50);
  const loneHigh = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
  const loneLow = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  check(emojiText.startsWith(emojiSliced), 'emoji 文本截断仍是前缀');
  check(!loneHigh.test(emojiSliced) && !loneLow.test(emojiSliced), '截断不产生孤立代理项');
  check(
    estimateTextTokens(emojiSliced) <= 50,
    'emoji 文本截断不超过预算',
    estimateTextTokens(emojiSliced),
  );
}

// ==================== 4. 前缀单调性 ====================

{
  const sample = '你好世界 hello 😀 world 测试文本， punctuation! 123';
  let previous = 0;
  let monotonic = true;
  for (let len = 1; len <= sample.length; len++) {
    const current = estimateTextTokens(sample.slice(0, len));
    if (current < previous) {
      monotonic = false;
      break;
    }
    previous = current;
  }
  check(monotonic, '估算对前缀单调不减（守卫保留决策依赖此性质）');
}

// ==================== 5. 图片引用归一 ====================

check(isImageRef(hexRef(1)), '64 位小写 hex 是合法引用');
check(isImageRef('0'.repeat(32)), '32 位 hex（FNV 回退形态）是合法引用');
check(isImageRef('0'.repeat(33)), '33-64 位区间 hex 合法');
check(!isImageRef('0'.repeat(31)), '31 位过短');
check(!isImageRef('0'.repeat(65)), '65 位过长');
check(!isImageRef('A'.repeat(64)), '大写 hex 不合法（形态收敛为小写）');
check(!isImageRef(`${'0'.repeat(63)}g`), '含非 hex 字符不合法');
check(!isImageRef(`sha256:${'0'.repeat(64)}`), '带前缀的哈希不合法');
check(!isImageRef(null), 'null 不是引用');
check(!isImageRef(123), '数字不是引用');
check(!isImageRef({}), '对象不是引用');
check(!isImageRef(undefined), 'undefined 不是引用');

{
  eq(normalizeImageRefs('not-an-array'), [], '非数组归一为空');
  eq(normalizeImageRefs(null), [], 'null 归一为空');
  eq(normalizeImageRefs(undefined), [], 'undefined 归一为空');
  eq(normalizeImageRefs([123, null, {}, 'bad']), [], '全非法项归一为空');

  const a = hexRef(1);
  const b = hexRef(2);
  const c = hexRef(3);
  const mixed = [a, 'INVALID', b, a, 'ABC', c, 42];
  eq(normalizeImageRefs(mixed), [a, b, c], '去重保序、丢弃非法项');

  const many = Array.from({ length: 70 }, (_, i) => hexRef(100 + i));
  const capped = normalizeImageRefs(many);
  eq(capped.length, IMAGE_REF_MAX_PER_MESSAGE, '超过上限被截断');
  eq(capped[0], many[0], '截断保留靠前的引用');
  eq(capped[63], many[63], '截断边界为第 64 个');
}

// ==================== 6. 上下文窗口守卫 ====================

{
  const empty = ContextWindowGuard.protect([], CONTEXT_THRESHOLD_MIN);
  eq(empty.messages, [], '空输入返回空结果');
  eq(empty.finalTokens, 0, '空输入成本为 0');
  check(!empty.truncated, '空输入未裁剪');
}

{
  // 图片成本进入 originalTokens：带图消息比纯文本消息多出 ≈ 固定成本 × 张数
  const textOnly = [{ role: 'user', content: '你好' }] as ChatMessage[];
  const withImages = [
    {
      role: 'user',
      content: [
        textPart('你好'),
        imagePart('data:image/png;base64,AA'),
        imagePart('data:image/png;base64,BB'),
      ],
    },
  ] as ChatMessage[];
  const r1 = ContextWindowGuard.protect(textOnly, CONTEXT_THRESHOLD_MIN);
  const r2 = ContextWindowGuard.protect(withImages, CONTEXT_THRESHOLD_MIN);
  const diff = r2.originalTokens - r1.originalTokens;
  check(diff >= IMAGE_CONTEXT_TOKENS * 2, '两张图片至少计入固定成本 × 2', diff);
  check(diff <= IMAGE_CONTEXT_TOKENS * 2 + 200, '图片成本不被文本估算放大（载荷已剥离）', diff);
}

{
  // 预算装不下图片组 → 整组丢弃；system 与新文本消息保留
  const messages = [
    { role: 'system', content: '汉'.repeat(7000) },
    {
      role: 'user',
      content: [textPart('看图'), imagePart('data:image/png;base64,AAAA')],
    },
    { role: 'user', content: '你好' },
  ] as ChatMessage[];
  const r = ContextWindowGuard.protect(messages, CONTEXT_THRESHOLD_MIN);
  check(r.finalTokens <= CONTEXT_THRESHOLD_MIN, '裁剪后不超阈值', r.finalTokens);
  check(r.truncated, '发生裁剪');
  eq(r.removedMessages, 1, '恰好移除 1 条装不下的消息');
  check(!r.messages.some(m => Array.isArray(m.content)), '图片消息被丢弃');
  check(r.messages.some(m => m.content === '你好'), '新文本消息保留');
  const systemKept = r.messages.find(m => m.role === 'system');
  check(
    systemKept !== undefined &&
      typeof systemKept.content === 'string' &&
      systemKept.content.length === 7000,
    'system 消息完整保留（不被超限裁剪路径波及）',
  );
}

{
  // system 自身超阈值 → 按 token 预算截断正文，仍不超过阈值
  const r = ContextWindowGuard.protect(
    [{ role: 'system', content: '汉'.repeat(9000) }],
    CONTEXT_THRESHOLD_MIN,
  );
  check(r.finalTokens <= CONTEXT_THRESHOLD_MIN, 'system 超限被截断到阈值内', r.finalTokens);
  check(r.truncated, 'system 截断标记为已裁剪');
  const system = r.messages[0];
  check(
    system !== undefined && typeof system.content === 'string' && system.content.length < 9000,
    'system 正文被缩短',
  );
}

{
  // 工具配对原子组：预算充足时 assistant.tool_calls 与其 tool 结果同留
  const messages = [
    { role: 'system', content: '你好' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'browser_click', arguments: '{}' } },
      ],
    },
    { role: 'tool', content: '点击完成', tool_call_id: 'c1', name: 'browser_click' },
  ] as ChatMessage[];
  const r = ContextWindowGuard.protect(messages, CONTEXT_THRESHOLD_MIN);
  check(
    r.messages.some(m => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0),
    '预算充足时工具调用保留',
  );
  check(
    r.messages.some(m => m.role === 'tool' && m.tool_call_id === 'c1'),
    '预算充足时配对的工具结果保留',
  );
}

{
  // 工具配对原子组：预算装不下时整组丢弃，绝不出现半配对
  const messages = [
    { role: 'system', content: '汉'.repeat(7900) },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'browser_extract', arguments: '{}' } },
      ],
    },
    { role: 'tool', content: '汉'.repeat(3000), tool_call_id: 'c1', name: 'browser_extract' },
  ] as ChatMessage[];
  const r = ContextWindowGuard.protect(messages, CONTEXT_THRESHOLD_MIN);
  const hasAssistantCalls = r.messages.some(
    m => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0,
  );
  const hasToolResult = r.messages.some(m => m.role === 'tool');
  check(!hasAssistantCalls && !hasToolResult, '装不下时工具组整体丢弃（无半配对）');
  check(r.finalTokens <= CONTEXT_THRESHOLD_MIN, '工具组裁剪后不超阈值', r.finalTokens);
}

{
  // NUL 剥离：OpenAI 等 API 拒绝 NUL，守卫在传输前清除
  const nul = String.fromCharCode(0);
  const r = ContextWindowGuard.protect(
    [{ role: 'user', content: `a${nul}b` }],
    CONTEXT_THRESHOLD_MIN,
  );
  eq(r.messages[0]?.content, 'ab', 'NUL 控制字符被剥离');
}

// ==================== 汇总 ====================
{
  const original: ChatMessage[] = [{ role: 'system', content: 'stable' }, { role: 'user', content: 'small request' }];
  const r = ContextWindowGuard.protect(original, CONTEXT_THRESHOLD_MIN);
  eq(r.truncated, false, '内部排序字段不得造成虚假的裁剪状态');
  eq(r.originalTokens, r.finalTokens, '内部排序字段不进入 token 预算');
  eq(r.removedMessages, 0, '小请求不移除消息');
}

if (failures.length > 0) {
  console.error(`\n通过 ${passed} 项断言，失败 ${failures.length} 项：`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`通过 ${passed} 项断言，失败 0 项`);

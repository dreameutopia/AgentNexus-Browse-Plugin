/**
 * interact 推荐项契约测试
 *
 * 覆盖「多选项必须给出唯一推荐项、且它排在第一位并带推荐理由」这一契约的三层：
 *   1. 文案层（全局注入分区 + 工具 schema）：同一份规则文案两处一致，
 *      且分区里明确「唯一 / 首位 / 括号标注理由」三项要素；
 *   2. 执行层（normalizeRecommendedOption）：唯一性、首位、可见标注三条不变量，
 *      以及模型把标注写错位置 / 写进 label / 漏写标注时的收敛行为；
 *   3. 工具面（interactTool.execute 真实入参）：交给 UI 的选项列表
 *      首个即推荐项，其余项不带推荐标注；
 *   4. 多选（multiSelect）：schema 声明、透传与单选收敛、
 *      多选答复由工具层拼接（分隔符单一事实源）并附结构化清单。
 *
 * 运行：由 tools.test.ts 末尾动态引入（chrome 全局桩已就位）。
 */

import assert from 'node:assert/strict';

import { interactTool, MULTI_ANSWER_SEPARATOR } from '../../tools/interact/interact-tool';
import {
  INTERACT_SYSTEM_PROMPT_SECTION,
  RECOMMENDED_OPTION_RULE,
} from '../../tools/interact/interact-prompt';
import { normalizeRecommendedOption } from '../../tools/interact/interact-options';
import {
  registerInteractHandler,
  type InteractRequest,
} from '../../tools/interact/interact-ui-bridge';

// ==================== 1. 文案层 ====================

assert.ok(
  INTERACT_SYSTEM_PROMPT_SECTION.includes(RECOMMENDED_OPTION_RULE),
  '全局注入分区引用与工具 schema 同一份推荐项规则文案（单一事实源）',
);
for (const element of ['唯一推荐选项', '第一位', '（推荐：一句简短理由）']) {
  assert.ok(
    INTERACT_SYSTEM_PROMPT_SECTION.includes(element),
    `推荐项规则含要素「${element}」`,
  );
}
assert.ok(
  INTERACT_SYSTEM_PROMPT_SECTION.includes('不得越权替用户做主'),
  '推荐项规则声明推荐不得替用户做主',
);
{
  const schema = interactTool.openaiSchema.function;
  assert.ok(
    schema.description?.includes('推荐'),
    '工具说明提及推荐项',
  );
  const optionsDescription = (
    schema.parameters.properties as Record<string, { description?: string }>
  ).options.description ?? '';
  assert.ok(
    optionsDescription.includes(RECOMMENDED_OPTION_RULE),
    '工具 schema 的 options 说明与全局分区共用同一句规则文案',
  );
}

// ==================== 2. 执行层 ====================

{
  // 模型把推荐项放在第 2 位 → 归一后必须提到首位，其余项不带推荐标注
  const normalized = normalizeRecommendedOption([
    { label: '方案 B', description: '走旧流程' },
    { label: '方案 A', description: '（推荐：最快且无需额外授权）走新流程' },
  ]);
  assert.equal(normalized.length, 2, '归一不改变选项数量');
  assert.equal(normalized[0].label, '方案 A', '推荐项被提到首位');
  assert.ok(
    normalized[0].description?.startsWith('（推荐：'),
    '推荐项带括号标注与理由',
  );
  assert.ok(
    !normalized[1].description?.includes('推荐'),
    '非推荐项不残留推荐标注',
  );
}

{
  // 模型漏写标注 → 工具层补「（推荐）」，首位即推荐项
  const normalized = normalizeRecommendedOption([
    { label: '方案 A', description: '走新流程' },
    { label: '方案 B', description: '走旧流程' },
  ]);
  assert.equal(normalized[0].label, '方案 A', '漏标注时取模型给的第一项');
  assert.ok(
    normalized[0].description?.startsWith('（推荐）'),
    '漏标注时补「（推荐）」前缀',
  );
  assert.equal(normalized[1].description, '走旧流程', '其余项描述保持原样');
}

{
  // 模型把标注写进 label → 搬到 description，label 保持纯文案（答复原文不受污染）
  const normalized = normalizeRecommendedOption([
    { label: '方案 B' },
    { label: '方案 A（推荐：更快）' },
  ]);
  assert.equal(normalized[0].label, '方案 A', '标注写进 label 时仍按推荐项识别');
  assert.ok(
    normalized[0].description?.startsWith('（推荐：'),
    'label 里的标注被搬到 description',
  );
  assert.ok(
    !normalized[0].label.includes('推荐'),
    'label 保持纯选项文案（答复原文不受污染）',
  );
}

{
  // 两个选项都被标了推荐 → 只保留一个推荐项，杜绝列表里出现两个"推荐"
  const normalized = normalizeRecommendedOption([
    { label: '方案 A', description: '（推荐：更快）' },
    { label: '方案 B', description: '（推荐：更稳）' },
  ]);
  assert.equal(
    normalized.filter(option => option.description?.includes('推荐')).length,
    1,
    '推荐标注唯一',
  );
  assert.equal(normalized[0].label, '方案 A', '先标记者为推荐项并居首');
}

{
  // 单选项 / 无选项不涉及选择 → 不做推荐归一
  const single = normalizeRecommendedOption([{ label: '唯一方案', description: '照做' }]);
  assert.deepEqual(single, [{ label: '唯一方案', description: '照做' }], '单选项原样返回');
  assert.deepEqual(normalizeRecommendedOption([]), [], '无选项原样返回');
}

// ==================== 3. 工具面（真实执行路径） ====================

{
  let captured: InteractRequest | null = null;
  const unregister = registerInteractHandler(async request => {
    captured = request;
    return { answered: true, answer: request.options[0]?.label ?? '', source: 'option' };
  });
  try {
    const result = await interactTool.execute({
      question: '用哪个方案？',
      options: [
        { label: '方案 B', description: '走旧流程' },
        { label: '方案 A', description: '（推荐：最快且无需额外授权）走新流程' },
      ],
    });
    assert.equal(result.success, true, 'interact 调用成功');
    const request = captured as unknown as InteractRequest;
    assert.ok(request, 'UI 处理器收到询问');
    assert.equal(request.options[0].label, '方案 A', '交给 UI 的首个选项即推荐项');
    assert.ok(
      request.options[0].description?.startsWith('（推荐：'),
      '交给 UI 的推荐项带标注与理由',
    );
    assert.ok(
      !request.options[1].description?.includes('推荐'),
      '交给 UI 的其余选项不带推荐标注',
    );
  } finally {
    unregister();
  }
}

// ==================== 4. 多选（multiSelect）契约 ====================

{
  const properties = (
    interactTool.openaiSchema.function.parameters.properties
  ) as Record<string, { type?: string; description?: string }>;
  assert.equal(properties.multiSelect?.type, 'boolean', 'schema 声明 multiSelect 为布尔');
  assert.ok(
    properties.multiSelect?.description?.includes('多选'),
    'multiSelect 说明覆盖多选语义',
  );
  assert.ok(
    properties.multiSelect?.description?.includes('至少 2 个候选'),
    'multiSelect 说明声明仅在候选数 ≥ 2 时生效',
  );
}

{
  // 多选透传 + UI 只回传勾选 label → 答复原文由工具层拼接
  let captured: InteractRequest | null = null;
  const unregister = registerInteractHandler(async request => {
    captured = request;
    return { answered: true, answers: ['方案 A', '方案 C'], source: 'option' };
  });
  try {
    const result = await interactTool.execute({
      question: '这次要处理哪几项？',
      multiSelect: true,
      options: [{ label: '方案 A' }, { label: '方案 B' }, { label: '方案 C' }],
    });
    const request = captured as unknown as InteractRequest;
    assert.ok(request, 'UI 处理器收到询问');
    assert.equal(request.multiSelect, true, 'multiSelect 透传给 UI');
    assert.equal(result.success, true, '多选询问成功');
    assert.equal(
      result.data.answer,
      ['方案 A', '方案 C'].join(MULTI_ANSWER_SEPARATOR),
      '答复原文由工具层按单一事实源分隔符拼接',
    );
    assert.deepEqual(result.data.answers, ['方案 A', '方案 C'], '结构化清单原样回传');
    assert.equal(result.data.source, 'option', '多选答复来源为选项');
    const text = String((result.content?.[0] as unknown as { text?: string })?.text ?? '');
    assert.ok(text.includes('多选 2 项'), '正文标明这是多选答复');
    assert.ok(text.includes(['方案 A', '方案 C'].join(MULTI_ANSWER_SEPARATOR)), '正文含拼接后的答复');
  } finally {
    unregister();
  }
}

{
  // 单选项 + multiSelect=true → 按单选收敛（不给用户「只有一个复选框」的无谓往返）
  let captured: InteractRequest | null = null;
  const unregister = registerInteractHandler(async request => {
    captured = request;
    return { answered: true, answer: request.options[0]?.label ?? '', source: 'option' };
  });
  try {
    await interactTool.execute({
      question: '是否继续？',
      multiSelect: true,
      options: [{ label: '继续采集下一批' }],
    });
    const request = captured as unknown as InteractRequest;
    assert.equal(request.multiSelect, false, '单选项时多选被收敛为单选');
  } finally {
    unregister();
  }
}

{
  // 未传 multiSelect → 显式 false（UI 拿到的是布尔，不必判 undefined）
  let captured: InteractRequest | null = null;
  const unregister = registerInteractHandler(async request => {
    captured = request;
    return { answered: false, status: 'declined' };
  });
  try {
    await interactTool.execute({
      question: '用哪个方案？',
      options: [{ label: '方案 A' }, { label: '方案 B' }],
    });
    const request = captured as unknown as InteractRequest;
    assert.equal(request.multiSelect, false, '缺省时显式给 false');
  } finally {
    unregister();
  }
}

{
  // 多选答复的脏入参：去重 / 去空 / 顺序保持；空清单按未答复收敛
  let captured: InteractRequest | null = null;
  const unregister = registerInteractHandler(async request => {
    captured = request;
    return { answered: true, answers: ['方案 B', '方案 B', '  ', '', '方案 A'], source: 'option' };
  });
  try {
    const result = await interactTool.execute({
      question: '勾选要处理的项',
      multiSelect: true,
      options: [{ label: '方案 A' }, { label: '方案 B' }],
    });
    assert.equal((captured as unknown as InteractRequest).multiSelect, true, '两个候选时多选保持开启');
    assert.deepEqual(result.data.answers, ['方案 B', '方案 A'], '去重去空且保持回传顺序');
    assert.equal(
      result.data.answer,
      ['方案 B', '方案 A'].join(MULTI_ANSWER_SEPARATOR),
      '拼接串与清单一致',
    );
  } finally {
    unregister();
  }
}

console.log(
  '[interact-options] 推荐项契约 + 多选契约：文案单一事实源 + 唯一/首位/带标注不变量 + multiSelect 透传与答复拼接通过。',
);

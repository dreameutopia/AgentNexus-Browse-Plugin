/**
 * interact 推荐项契约测试
 *
 * 覆盖「多选项必须给出唯一推荐项、且它排在第一位并带推荐理由」这一契约的三层：
 *   1. 文案层（全局注入分区 + 工具 schema）：同一份规则文案两处一致，
 *      且分区里明确「唯一 / 首位 / 括号标注理由」三项要素；
 *   2. 执行层（normalizeRecommendedOption）：唯一性、首位、可见标注三条不变量，
 *      以及模型把标注写错位置 / 写进 label / 漏写标注时的收敛行为；
 *   3. 工具面（interactTool.execute 真实入参）：交给 UI 的选项列表
 *      首个即推荐项，其余项不带推荐标注。
 *
 * 运行：由 tools.test.ts 末尾动态引入（chrome 全局桩已就位）。
 */

import assert from 'node:assert/strict';

import { interactTool } from '../../tools/interact/interact-tool';
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

console.log('[interact-options] 推荐项契约：文案单一事实源 + 唯一/首位/带标注不变量 + 真实工具面通过。');

/**
 * 视觉能力守卫（utils/chat/vision-capability-guard）单元测试
 *
 * 覆盖三条交互链路的判定矩阵与防御边界：
 *   - upload-image：模型无视觉 → 恒提示；模型有视觉 → 恒不提示
 *   - switch-model：无图片且无视觉智能体 → 不提示；任一存在 → 提示
 *   - select-agent：所选智能体无视觉需求 → 不提示；有 → 提示
 *   - 计数回填：imageCount 由判定入口统一计算（本轮 + 历史）
 *   - agentRequiresVision：undefined/null → false；对象 → true
 *   - 文案工厂透传：判定层不造文案，只透传工厂结果
 */

import assert from 'node:assert/strict';
import {
  needsVisionWarning,
  evaluateVisionGuard,
  agentRequiresVision,
  type VisionCapabilityContext,
} from '../../entrypoints/sidepanel/utils/chat/vision-capability-guard';

const base: VisionCapabilityContext = { modelHasVision: false, modelLabel: 'M' };

// ── upload-image：用户正要引入图片，模型无视觉即提示 ──
assert.equal(needsVisionWarning('upload-image', base), true, 'Upload without vision warns');
assert.equal(
  needsVisionWarning('upload-image', { ...base, modelHasVision: true }),
  false,
  'Vision model never warns',
);
// 计数与智能体状态不影响该场景判定（上传行为本身即触发条件）
assert.equal(
  needsVisionWarning('upload-image', { ...base, pendingImageCount: 0, historyImageCount: 0 }),
  true,
  'Upload warning is independent of existing counts',
);

// ── switch-model：仅当上下文确有图片或视觉智能体才提示 ──
assert.equal(
  needsVisionWarning('switch-model', { ...base, pendingImageCount: 0, historyImageCount: 0 }),
  false,
  'Clean text session switches silently',
);
assert.equal(
  needsVisionWarning('switch-model', { ...base, pendingImageCount: 2 }),
  true,
  'Pending images force the switch warning',
);
assert.equal(
  needsVisionWarning('switch-model', { ...base, historyImageCount: 1 }),
  true,
  'Historical images force the switch warning',
);
assert.equal(
  needsVisionWarning('switch-model', { ...base, agentHasVision: true, agentLabel: 'A' }),
  true,
  'A vision agent forces the switch warning',
);
assert.equal(
  needsVisionWarning('switch-model', { ...base, agentHasVision: false }),
  false,
  'A text agent alone does not warn',
);
assert.equal(
  needsVisionWarning('switch-model', { ...base, modelHasVision: true, pendingImageCount: 5, agentHasVision: true }),
  false,
  'Vision target model never warns regardless of context',
);
// 缺省计数（undefined）按 0 处理，不误报
assert.equal(
  needsVisionWarning('switch-model', base),
  false,
  'Absent counts default to zero (no false warning)',
);

// ── select-agent：所选智能体需要视觉才提示 ──
assert.equal(
  needsVisionWarning('select-agent', { ...base, agentHasVision: false }),
  false,
  'Text agent selection is silent',
);
assert.equal(
  needsVisionWarning('select-agent', { ...base, agentHasVision: true }),
  true,
  'Vision agent selection warns',
);
assert.equal(
  needsVisionWarning('select-agent', { ...base, modelHasVision: true, agentHasVision: true }),
  false,
  'Vision model makes agent selection silent',
);
// agentHasVision 缺省（undefined）不视为视觉智能体
assert.equal(
  needsVisionWarning('select-agent', base),
  false,
  'Absent agent vision flag defaults to not requiring vision',
);

// ── evaluateVisionGuard：计数回填 + 文案透传 ──
{
  const factoryCalls: Array<Record<string, unknown>> = [];
  const verdict = evaluateVisionGuard(
    'switch-model',
    { ...base, pendingImageCount: 2, historyImageCount: 3, agentHasVision: true },
    (scenario, context) => {
      factoryCalls.push({ scenario, imageCount: context.imageCount });
      return `msg:${context.imageCount}`;
    },
  );
  assert.equal(verdict.needsWarning, true);
  assert.equal(verdict.scenario, 'switch-model');
  assert.equal(verdict.imageCount, 5, 'Total count = pending + history');
  assert.equal(factoryCalls[0].imageCount, 5, 'Factory receives the enriched count');
  assert.equal(verdict.message, 'msg:5', 'Message is passed through from the factory');
}
{
  const verdict = evaluateVisionGuard(
    'upload-image',
    { ...base, modelHasVision: true },
    () => 'should-not-be-called',
  );
  assert.equal(verdict.needsWarning, false, 'Vision model short-circuits without factory call');
  assert.equal(verdict.scenario, null);
  assert.equal(verdict.message, '');
}

// ── agentRequiresVision：字段存在性判定（与运行时装配同源） ──
assert.equal(agentRequiresVision(undefined), false);
assert.equal(agentRequiresVision(null), false);
assert.equal(agentRequiresVision({ screenshotTool: 'screenshot', screenshotArgs: {}, reScreenshotAfterTools: true }), true);

console.log('[vision-capability-guard] scenario matrix, count enrichment and agent vision detection passed.');

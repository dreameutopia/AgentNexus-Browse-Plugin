/**
 * 富组件模块出口（统一信封 + 能力注册表 + 提示词 + 派生 + 同步构建器）
 *
 * 外部依赖方向（无环）：
 *   registry（纯能力数据） ← rich-output-prompt（教学文案）
 *   registry ← envelope ← derive-chart / component-blocks
 *   markdown-renderer / chart-renderer / runtime-builder → 本出口
 */

export {
  COMPONENT_FENCE_LANG,
  RICH_COMPONENTS,
  ENVELOPE_COMPONENT_TYPES,
  findRichComponentByFenceLang,
  type RichComponentId,
  type RichComponentSpec,
  type RichComponentForm,
} from './registry';

export { buildRichOutputSystemPrompt } from './rich-output-prompt';

export {
  parseRichEnvelope,
  coerceNumber,
  type NormalizedEnvelope,
  type RichCell,
  type RichEnvelopeType,
  type EnvelopeParseResult,
} from './envelope';

export { deriveChartOption, type ChartKind, type DeriveChartResult } from './derive-chart';

export { buildEnvelopeComponentBlock, buildDiffBlock } from './component-blocks';

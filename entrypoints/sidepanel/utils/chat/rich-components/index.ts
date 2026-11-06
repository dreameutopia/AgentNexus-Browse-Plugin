/**
 * 富组件模块出口（统一信封 + 注册表 + 派生 + 同步构建器）
 *
 * 外部依赖方向（无环）：
 *   registry（纯数据） ← envelope ← derive-chart / component-blocks
 *   markdown-renderer / chart-renderer / runtime-builder → 本出口
 */

export {
  COMPONENT_FENCE_LANG,
  RICH_COMPONENTS,
  ENVELOPE_COMPONENT_TYPES,
  findRichComponentByFenceLang,
  buildRichOutputSystemPrompt,
  type RichComponentId,
  type RichComponentSpec,
} from './registry';

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

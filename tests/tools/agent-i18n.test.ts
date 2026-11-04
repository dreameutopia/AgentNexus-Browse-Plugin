/**
 * 预置智能体多语言展示单元测试
 *
 * 覆盖：
 *   1. 规范值（name/description/tags）本身即默认语言（zh-CN）文案
 *   2. 非默认语言（en）取 display 覆盖；缺项回落规范值
 *   3. 自定义智能体没有 display，任何语言下都用其自填文案（不随界面语言变化）
 *   4. 每个预置智能体都覆盖了全部非默认语言（漏写即编译期报错，此处兜底断言完整性）
 *   5. 预置智能体的规范名唯一（存储键依赖唯一性）
 *   6. 分类显示名随语言切换（内置分类走 i18n 键）
 *   7. 归一化：display 结构非法时整体丢弃，回落规范值而非半吊子修补
 *
 * 运行：node tests/tools/run.mjs   （或 npm run test:tools）
 */

import assert from 'node:assert/strict';
import {
  agentDisplayOf,
  normalizeAgentConfig,
  type AgentConfig,
} from '../../utils/agents/agent-types';
import {
  PRESET_AGENTS,
  isPresetAgent,
} from '../../utils/agents/agent-store';
import { categoryLabelOf } from '../../utils/agents/agent-types';
import { NON_DEFAULT_LOCALES, SUPPORTED_LOCALES } from '../../utils/i18n/locales';

// ── 1. 规范值即默认语言文案 ──
const autoAction = PRESET_AGENTS.find(a => a.id === 'Auto-Action');
assert.ok(autoAction, '预置智能体 Auto-Action 应存在');
assert.equal(autoAction.name, '文本通用助手', 'Auto Action 已更名为文本通用助手');
assert.equal(
  agentDisplayOf(autoAction, 'zh-CN').name,
  autoAction.name,
  '默认语言下展示名即规范名',
);
assert.equal(
  agentDisplayOf(autoAction, 'zh-CN').tags,
  autoAction.tags,
  '默认语言下标签即规范标签',
);

// ── 2. 非默认语言取 display 覆盖 ──
const visionAction = PRESET_AGENTS.find(a => a.id === 'Vision-Action');
assert.ok(visionAction, '预置智能体 Vision-Action 应存在');
assert.equal(visionAction.name, '视觉通用助手', 'Vision Action 已更名为视觉通用助手');
const enView = agentDisplayOf(visionAction, 'en');
assert.equal(enView.name, 'General Vision Assistant', '英文界面展示英文名');
assert.notEqual(enView.description, visionAction.description, '英文描述与中文规范描述不同');
assert.ok(enView.tags.length > 0, '英文标签非空');
assert.ok(
  enView.tags.every(tag => !visionAction.tags.includes(tag)),
  '英文标签与中文规范标签不同',
);

// ── 3. 自定义智能体不受界面语言影响 ──
const custom: AgentConfig = {
  id: 'my-agent',
  name: '我的智能体',
  description: '我自己写的描述',
  system: '你是我的智能体。',
  tools: [],
  category: 'general',
  tags: ['自定义'],
};
assert.equal(agentDisplayOf(custom, 'en').name, '我的智能体', '自定义智能体英文下仍用自填名');
assert.equal(agentDisplayOf(custom, 'en').description, '我自己写的描述', '自定义智能体英文下仍用自填描述');
assert.deepEqual(agentDisplayOf(custom, 'en').tags, ['自定义'], '自定义智能体英文下仍用自填标签');

// ── 4. 每个预置都覆盖全部非默认语言 ──
for (const agent of PRESET_AGENTS) {
  for (const locale of NON_DEFAULT_LOCALES) {
    const text = agentDisplayOf(agent, locale);
    assert.ok(text.name.length > 0, `${agent.id} 缺少 ${locale} 名称`);
    assert.ok(text.description.length > 0, `${agent.id} 缺少 ${locale} 描述`);
    assert.ok(text.tags.length > 0, `${agent.id} 缺少 ${locale} 标签`);
  }
}

// ── 5. 规范名唯一（存储键依赖唯一性）──
const names = PRESET_AGENTS.map(a => a.name);
assert.equal(new Set(names).size, names.length, '预置智能体规范名不得重复');

// ── 6. 分类显示名随语言切换 ──
const zhCategory = categoryLabelOf('automation', key => `zh:${key}`);
const enCategory = categoryLabelOf('automation', key => `en:${key}`);
assert.ok(zhCategory.startsWith('zh:'), '分类走 i18n 键解析');
assert.ok(enCategory.startsWith('en:'), '分类显示名随语言切换');
assert.notEqual(zhCategory, enCategory, '不同语言的分类显示名不同');

// ── 7. 归一化：非法 display 整体丢弃，回落规范值 ──
const withDisplay = normalizeAgentConfig({
  ...autoAction,
  display: { en: { name: 'X', description: 'Y', tags: ['Z'] } },
});
assert.ok(withDisplay?.display?.en, '合法 display 应保留');
assert.equal(withDisplay?.display?.en.name, 'X', 'display 内容原样保留');

const brokenDisplay = normalizeAgentConfig({
  ...autoAction,
  // 缺 description → 结构不完整，整个 display 丢弃
  display: { en: { name: 'X', tags: ['Z'] } },
});
assert.equal(brokenDisplay?.display, undefined, '字段缺失的 display 应整体丢弃');
assert.equal(
  agentDisplayOf(brokenDisplay as AgentConfig, 'en').name,
  autoAction.name,
  'display 被丢弃后回落规范名',
);

const extraTag = normalizeAgentConfig({
  ...autoAction,
  // 标签超出数量上限 → 归一化后数量变化 → 视为结构不可信，整体丢弃
  display: { en: { name: 'X', description: 'Y', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] } },
});
assert.equal(extraTag?.display, undefined, '标签超限的 display 应整体丢弃');

// ── 8. 支持的语言集合与预置覆盖一致 ──
assert.deepEqual(
  [...NON_DEFAULT_LOCALES],
  SUPPORTED_LOCALES.filter(l => l !== 'zh-CN'),
  '非默认语言集合与语言目录一致',
);
for (const agent of PRESET_AGENTS) {
  assert.ok(isPresetAgent(agent.id), `${agent.id} 应被识别为预置`);
}

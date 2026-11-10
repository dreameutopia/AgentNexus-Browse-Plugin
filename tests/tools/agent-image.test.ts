/**
 * 回答内截图引用（<agent-image id="..." />）单元测试
 *
 * 覆盖：
 *   1. 渲染器把合法短 id 的标签还原成截图引用卡片（id / alt 落在 data-* 上）
 *   2. 非法 id 不生成卡片：标签按普通文本转义，模型写错的 id 不会变成空卡片
 *   3. 代码块里的同名标签是字面量，不还原
 *   4. alt 属模型输出（外部数据）：其中的 HTML 必须被转义
 *   5. 短 id 形态：8 位小写字母数字
 *   6. 工具描述与操作协议都写清了引用语法（模型据此产标签）
 *
 * 运行：node tests/tools/run.mjs   （或 npm run test:tools）
 */

import assert from 'node:assert/strict';
import { markdownRenderer } from '../../entrypoints/sidepanel/utils/chat/markdown-renderer';
import { SHORT_ID_PATTERN } from '../../entrypoints/sidepanel/core/images/image-store';
import { screenshotTool } from '../../tools/vision/screenshot-tool';
import { VISION_GUI_PROMPT, VISION_GUI_OBSERVE_PROMPT } from '../../utils/agents/vision-gui-prompt';

// ── 1. 合法标签 → 截图引用卡片 ──
const card = markdownRenderer.renderMessage(
  '已完成下单：\n<agent-image id="abcd1234" alt="订单已提交" />',
);
assert.ok(card.includes('agent-image-card'), '合法标签应渲染为截图引用卡片');
assert.ok(
  card.includes('data-agent-image-id="abcd1234"'),
  '卡片应携带短 id（渲染器据此反查图片）',
);
assert.ok(card.includes('订单已提交'), '卡片应携带 alt 说明');
assert.ok(
  card.includes('data-agent-image-state="pending"'),
  '卡片初始为 pending，由渲染器异步注入图片',
);

// ── 2. 非法 id → 不生成卡片（标签作为普通文本）──
const invalid = markdownRenderer.renderMessage('<agent-image id="NOT-VALID" />');
assert.ok(!invalid.includes('agent-image-card'), '非法 id 不应生成卡片');
assert.ok(
  invalid.includes('&lt;agent-image'),
  '非法 id 的标签应作为转义文本呈现',
);

// ── 3. 代码块内的标签是字面量 ──
const code = markdownRenderer.renderMessage('```\n<agent-image id="abcd1234" />\n```');
assert.ok(!code.includes('agent-image-card'), '代码块内的标签不应被还原');

// ── 4. alt 属外部数据：必须转义 ──
const injected = markdownRenderer.renderMessage(
  '<agent-image id="abcd1234" alt="<img src=x onerror=alert(1)>" />',
);
assert.ok(
  !injected.includes('<img src=x'),
  'alt 中的 HTML 必须被转义（不得出现可执行标记）',
);
assert.ok(injected.includes('&lt;img src=x'), 'alt 中的标签应作为转义文本呈现');

// ── 5. 短 id 形态 ──
assert.equal(SHORT_ID_PATTERN.test('abcd1234'), true);
assert.equal(SHORT_ID_PATTERN.test('ABCD1234'), false);
assert.equal(SHORT_ID_PATTERN.test('abcd123'), false);
assert.equal(SHORT_ID_PATTERN.test('abcd12345'), false);

// ── 6. 工具与规程写清引用语法（模型据此产标签）──
assert.ok(
  screenshotTool.metadata.description.includes('<agent-image id='),
  '截图工具描述必须说明引用语法',
);
assert.ok(
  VISION_GUI_PROMPT.includes('<agent-image id='),
  '视觉操作规程必须说明引用语法',
);
assert.ok(
  VISION_GUI_PROMPT.includes('imageId'),
  '视觉操作规程必须说明短 id 字段名',
);

// ── 7. DOM/视觉通道选择准则（防模型在错误通道上打转）──
assert.ok(
  VISION_GUI_PROMPT.includes('<dom-or-vision>'),
  '视觉操作规程必须包含通道选择准则分区',
);
assert.ok(
  VISION_GUI_PROMPT.includes('视觉优先'),
  '通道选择准则：视觉优先为默认执行通道',
);
assert.ok(
  VISION_GUI_PROMPT.includes('辅助通道'),
  '通道选择准则：DOM/文本为辅助通道（仅视觉无法完成时使用）',
);
assert.ok(
  !VISION_GUI_PROMPT.includes('browser_interact 定位精确且稳定，优先使用'),
  '通道选择准则：不得再出现 DOM 交互优先于视觉手势的表述',
);
assert.ok(
  VISION_GUI_PROMPT.includes('vision_gui'),
  '通道选择准则：视觉手势入口',
);
assert.ok(
  /第三次原地重试|换另一种通道/.test(VISION_GUI_PROMPT),
  '通道选择准则：两次失败必须换通道或说明阻塞',
);
assert.ok(
  VISION_GUI_PROMPT.includes('首要参考'),
  '规程必须强调截图是首要参考标志（grounding）',
);

// ── 8. 预设与钩子的职责分界：规程单一事实源在 vision-gui-prompt，
//      由 prompt-hooks 按工具面自动注入；预设正文不得自带同名分区——
//      一旦自带，marker 防重会让注入被静默跳过 ──
const { visionActionConfig } = await import('../../utils/agents/presets/vision-action');
const presetSystem = String(visionActionConfig.system);
assert.ok(
  !presetSystem.includes('<vision-gui-tool>'),
  '预设正文不得自带视觉规程分区（注入职责归 prompt-hooks）',
);
assert.ok(
  !presetSystem.includes('<dom-or-vision>'),
  '通道选择准则的单一事实源是 vision-gui-prompt，预设不得复制',
);
assert.ok(
  presetSystem.includes('<text-interaction-sop>'),
  '预设保留文本通道辅助规程',
);
assert.ok(
  presetSystem.includes('不改变「vision_gui 是默认执行通道」的定位'),
  '文本辅助规程前必须有辅助定位框架句',
);
// 观察变体：开放的三个只读 action 必须与引擎闸门
//（VISION_ASSISTANT_GUI_ACTIONS）保持同名同面
assert.ok(VISION_GUI_OBSERVE_PROMPT.includes('<observation-boundary>'), '观察变体必须声明观察者边界');
for (const action of ['read', 'read_scroll', 'zoom'])
  assert.ok(VISION_GUI_OBSERVE_PROMPT.includes(action), `观察变体必须说明 ${action}`);
// 观察变体的开放/排除清单由常量派生——此处断言规程正文与引擎闸门同源，
// 防止「闸门放行了一个规程没讲」或「规程讲了一个闸门不放行」的漂移
{
  const { VISION_ASSISTANT_GUI_ACTIONS } = await import('../../utils/agents/vision-assistant-policy');
  const { VISION_GUI_ACTIONS } = await import('../../tools/vision/gui-contract');
  const allowed = [...VISION_ASSISTANT_GUI_ACTIONS];
  const excluded = VISION_GUI_ACTIONS.filter((action) => !VISION_ASSISTANT_GUI_ACTIONS.has(action));
  assert.ok(
    VISION_GUI_OBSERVE_PROMPT.includes(`只开放 ${allowed.join(' / ')} 三个只读 action`),
    '观察变体的开放清单必须与引擎闸门一致',
  );
  assert.ok(
    VISION_GUI_OBSERVE_PROMPT.includes(`（${excluded.join('、')}）`),
    '观察变体的排除清单必须覆盖其余全部 action',
  );
}

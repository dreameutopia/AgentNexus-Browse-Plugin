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
import { VISION_ACTION_SOP } from '../../utils/agents/vision-action-sop';

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

// ── 6. 工具与协议写清引用语法（模型据此产标签）──
assert.ok(
  screenshotTool.metadata.description.includes('<agent-image id='),
  '截图工具描述必须说明引用语法',
);
assert.ok(
  VISION_ACTION_SOP.includes('<agent-image id='),
  '视觉操作协议必须说明引用语法',
);
assert.ok(
  VISION_ACTION_SOP.includes('imageId'),
  '视觉操作协议必须说明短 id 字段名',
);

/**
 * 用户消息气泡折叠规则纯函数回归（user-message-collapse）。
 *
 * 覆盖：
 *   - 行高解析：定值 px / 无单位比例 / normal / 缺省 四种 computed 形态；
 *   - 折叠高度：行数上限 × 行高，非法输入回落到默认口径（绝不返回 0）；
 *   - 溢出判定：阈值内不收起、阈值外收起、亚像素容差不误判。
 *
 * 运行：node tests/user-bubble/run.mjs（npm run test:user-bubble）
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_FONT_SIZE_PX,
  DEFAULT_LINE_HEIGHT_RATIO,
  OVERFLOW_TOLERANCE_PX,
  USER_MESSAGE_MAX_LINES,
  computeClampHeightPx,
  isContentOverflowing,
  resolveLineHeightPx,
} from '@/entrypoints/sidepanel/utils/chat/user-message-collapse';

// ── 行高解析 ──
assert.equal(resolveLineHeightPx('24.5px', 14), 24.5, '定值 px 直接取用');
assert.equal(resolveLineHeightPx('1.75', 14), 24.5, '无单位比例按字号换算');
assert.equal(resolveLineHeightPx('normal', 14), 24.5, 'normal 回落到默认比例');
assert.equal(resolveLineHeightPx('', 14), 24.5, '空值回落到默认比例');
assert.equal(resolveLineHeightPx('  20px  ', 14), 20, '空白容错');
assert.equal(resolveLineHeightPx('0px', 14), 24.5, '非法定值回落到默认比例');
assert.equal(
  resolveLineHeightPx('', Number.NaN),
  DEFAULT_FONT_SIZE_PX * DEFAULT_LINE_HEIGHT_RATIO,
  '字号也测不到时按默认字号换算',
);

// ── 折叠高度 ──
assert.equal(computeClampHeightPx(24.5), 147, '行数上限 × 行高');
assert.equal(computeClampHeightPx(24.5, 6), 147, '显式行数上限');
assert.equal(computeClampHeightPx(24.4), 147, '向上取整，最后一行不被切掉半个像素');
assert.equal(
  computeClampHeightPx(Number.NaN),
  Math.ceil(DEFAULT_FONT_SIZE_PX * DEFAULT_LINE_HEIGHT_RATIO * USER_MESSAGE_MAX_LINES),
  '行高非法时回落到默认口径',
);
assert.equal(
  computeClampHeightPx(24.5, 0),
  Math.ceil(24.5 * USER_MESSAGE_MAX_LINES),
  '行数上限非法时回落到默认行数，绝不返回 0（否则正文被完全截断）',
);
assert.ok(computeClampHeightPx(24.5) > 0, '折叠高度恒为正');

// ── 溢出判定 ──
assert.equal(isContentOverflowing(147, 147), false, '恰好等于阈值不收起');
assert.equal(isContentOverflowing(100, 147), false, '阈值内不收起');
assert.equal(
  isContentOverflowing(147 + OVERFLOW_TOLERANCE_PX, 147),
  false,
  '亚像素容差内的溢出不误判（scrollHeight 取整误差）',
);
assert.equal(isContentOverflowing(147 + OVERFLOW_TOLERANCE_PX + 1, 147), true, '超出容差即收起');
assert.equal(isContentOverflowing(Number.NaN, 147), false, '测量值非法按不溢出处理（宁可多显示几行）');
assert.equal(isContentOverflowing(200, Number.NaN), false, '阈值非法按不溢出处理');

console.log('[user-bubble] 用户消息折叠规则纯函数（行高解析 / 折叠高度 / 溢出判定）全部通过。');

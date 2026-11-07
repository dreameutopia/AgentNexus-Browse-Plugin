/**
 * 直播消息片段流装配回归（live-parts 纯函数 + App.vue 接线守卫）。
 *
 * 覆盖的场景是本条修复的核心：vision 自动首截图必须在消息片段流里按
 * 发生顺序内联，而不是退化成「消息末尾挂一张图」。
 *
 *   - assistant-start：占位建立，首截图置于片段流最前；
 *   - 首个内容事件（正文/推理/工具）：占位转真实消息，**首截图不得丢失**
 *     （此前此处清空片段流 → 首截图只剩引用 → 渲染层回退到消息底部图片区）；
 *   - 截图到达：按发生顺序追加，引用集合去重保序、片段流不去重
 *     （同 hash 的两次截屏是两次真实发生）；
 *   - 中止终态化：只截了屏就中止的轮次，截图本身即可见内容。
 *
 * 运行：node tests/message-collapse/run.mjs（npm run test:message-collapse）
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  startLiveMessage,
  beginLiveMessage,
  appendLiveImage,
  hasVisibleLiveContent,
} from '@/entrypoints/sidepanel/utils/chat/live-parts';
import type { MessagePart } from '@/entrypoints/sidepanel/types/chat';

const image = (ref: string): MessagePart => ({ type: 'image', imageRef: ref });
const text = (content: string): MessagePart => ({ type: 'text', content });
const kinds = (parts: readonly MessagePart[]): string[] => parts.map(part => part.type);

// ── 1. 占位建立：首截图置于片段流最前，正文占位随后 ──
{
  const state = startLiveMessage(['ref-1']);
  assert.deepEqual(kinds(state.parts), ['image', 'text'], '首截图在片段流最前，正文占位随后');
  assert.equal((state.parts[0] as { imageRef?: string }).imageRef, 'ref-1');
  assert.deepEqual(state.imageRefs, ['ref-1']);
  assert.equal(startLiveMessage().parts.length, 1, '无截图时只留正文占位');
  assert.deepEqual(startLiveMessage(['ref-1', 'ref-1', '']).imageRefs, ['ref-1'], '引用去重保序、空引用剔除');
}

// ── 2. 占位转真实消息：首截图必须保留（修复点） ──
{
  const begun = beginLiveMessage(startLiveMessage(['ref-1']));
  assert.deepEqual(kinds(begun.parts), ['image'], '正文占位丢弃，首截图保留');
  assert.equal((begun.parts[0] as { imageRef?: string }).imageRef, 'ref-1');
  assert.deepEqual(begun.imageRefs, ['ref-1'], '引用集合不受占位转换影响');
}

// ── 3. 完整事件序列：首截图在正文之前、每轮工具后的重截图紧跟其轮次 ──
{
  let state = startLiveMessage(['ref-1']); // assistant-start（首截图就位）
  state = beginLiveMessage(state); // 首个内容事件（推理/正文）
  state = { ...state, parts: [...state.parts, { type: 'reasoning', content: '思考' }] };
  state = { ...state, parts: [...state.parts, text('我来点击')] };
  state = { ...state, parts: [...state.parts, { type: 'tool', toolCall: { id: 't1', name: 'vision_gui', status: 'success' } }] };
  state = appendLiveImage(state, 'ref-2'); // 工具后的自动重截图
  state = { ...state, parts: [...state.parts, text('已完成')] };
  assert.deepEqual(
    kinds(state.parts),
    ['image', 'reasoning', 'text', 'tool', 'image', 'text'],
    '截图按发生顺序内联：首截图最前、轮次重截图紧跟其工具调用',
  );
  assert.deepEqual(
    state.parts.filter(part => part.type === 'image').map(part => (part as { imageRef?: string }).imageRef),
    ['ref-1', 'ref-2'],
    '两次截屏按序保留',
  );
  assert.deepEqual(state.imageRefs, ['ref-1', 'ref-2']);
}

// ── 4. 截图追加：引用去重、片段流不去重（同 hash 两次截屏是两次真实发生） ──
{
  const once = appendLiveImage(startLiveMessage(), 'ref-1');
  assert.deepEqual(kinds(once.parts), ['text', 'image']);
  assert.deepEqual(once.imageRefs, ['ref-1']);
  const twice = appendLiveImage(once, 'ref-1');
  assert.deepEqual(kinds(twice.parts), ['text', 'image', 'image'], '同引用仍是两次真实发生');
  assert.deepEqual(twice.imageRefs, ['ref-1'], '引用集合去重');
  assert.equal(appendLiveImage(once, '').parts.length, once.parts.length, '空引用不入流');
}

// ── 5. 中止终态化：只截了屏就中止 → 截图本身即可见内容 ──
{
  const state = beginLiveMessage(startLiveMessage(['ref-1']));
  assert.equal(hasVisibleLiveContent({ parts: state.parts }), true, '截图片段算可见内容');
  assert.equal(hasVisibleLiveContent({ content: '   ' }), false, '空白正文不算可见内容');
  assert.equal(hasVisibleLiveContent({ content: '正文' }), true);
  assert.equal(hasVisibleLiveContent({ reasoningContent: '思考' }), true);
  assert.equal(hasVisibleLiveContent({ toolCallCount: 1 }), true);
  assert.equal(hasVisibleLiveContent({ parts: [text('x')] }), false);
}

// ── 6. App.vue 接线守卫：片段流不得被整体清空（会连带丢掉首截图片段） ──
{
  const appSource = readFileSync(
    path.resolve(process.cwd(), 'entrypoints/sidepanel/views/App.vue'),
    'utf8',
  );
  assert.ok(
    !/parts\s*=\s*\[\]\s*;/.test(appSource),
    'App.vue 不得整体清空片段流（清空会连带丢掉首截图片段，截图退化为挂在消息最后）',
  );
  for (const fn of ['startLiveMessage(', 'beginLiveMessage(', 'appendLiveImage(']) {
    assert.ok(appSource.includes(fn), `App.vue 必须经 live-parts 装配片段流（缺少 ${fn}）`);
  }
}

console.log('[live-parts] 直播片段流装配全部场景通过（首截图保序内联 / 引用去重 / 中止可见性 / App.vue 接线守卫）。');

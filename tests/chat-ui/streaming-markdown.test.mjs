/**
 * 流式增量冻结渲染回归测试（stable-boundary 探测 + MarkdownText 宿主）
 *
 * 覆盖：
 *   1. findStableBoundary 纯函数：闭合围栏锚点、未闭合围栏、波浪线围栏、
 *      长闭合标记、info string、<think> / <api-error> 跨界保护、$$ 奇偶
 *      保护、边界单调性（追加内容不收缩边界）；
 *   2. MarkdownText 宿主（真实 SFC 挂载）：
 *      - 直播中围栏闭合 → 组件骨架立即落入冻结段（[data-md-stable]），
 *        活动尾部带 [data-streaming]（异步渲染器跳过契约）；
 *      - 追加不变量：已冻结段的 DOM 节点身份跨 token 更新保持不变
 *        （挂载其上的图表 iframe / Mermaid SVG 不被销毁重建）；
 *      - 流结束终排：剩余尾部冻结为最后一段，已冻结段身份依旧保持；
 *      - 前缀改写：稳定区整体重建（标记清除、内容重渲染）；
 *      - 历史片段（未经历直播）：一次性整渲染，无冻结段包裹层
 *        （与旧版 v-html 产物结构等价）。
 *
 * 运行：node tests/chat-ui/streaming-markdown.test.mjs   （或 npm run test:chat-ui）
 */

import { readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { parse, compileScript } from '@vue/compiler-sfc';
// compileTemplate 不需要：inlineTemplate 把渲染函数内联进组件产物

const root = process.cwd();

// —— DOM 环境（先于任何被测模块导入）——
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'https://example.test/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'SVGElement', 'MutationObserver', 'ResizeObserver']) {
  if (dom.window[key] !== undefined) globalThis[key] = dom.window[key];
}

// —— 打包 1：stable-boundary 纯函数 ——
const utilOut = path.resolve('node_modules/.cache/stable-boundary.mjs');
mkdirSync(path.dirname(utilOut), { recursive: true });
await build({
  stdin: {
    contents: "export { findStableBoundary } from './entrypoints/sidepanel/utils/chat/stable-boundary';",
    loader: 'ts',
    resolveDir: root,
  },
  outfile: utilOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const { findStableBoundary } = await import(pathToFileURL(utilOut).href);

// —— 打包 2：MarkdownText SFC（真实编译，含模板与响应式绑定）——
// markdown-renderer / stable-boundary 真连打进 bundle（JSDOM 已就绪，
// document 委托可正常安装；fence 分发与图表骨架产出走生产代码路径）
const file = path.resolve('entrypoints/sidepanel/components/chat/MarkdownText.vue');
const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file });
const script = compileScript(descriptor, { id: 'markdown-stream-test', inlineTemplate: true });
const sfcOut = path.resolve('node_modules/.cache/markdown-stream-test.mjs');
await build({
  stdin: { contents: script.content, loader: 'ts', resolveDir: path.dirname(file) },
  outfile: sfcOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['vue'],
  loader: { '.css': 'empty' },
});

const { createApp, h, nextTick, reactive } = await import('vue');
const { default: MarkdownText } = await import(pathToFileURL(sfcOut).href);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==================== 1. findStableBoundary 纯函数 ====================

{
  assert.equal(findStableBoundary(''), 0, '空内容边界为 0');
  assert.equal(findStableBoundary('普通文本段落'), 0, '无围栏恒为 0');
  const closedAtEof = '```component\n{"a":1}\n```';
  assert.equal(findStableBoundary(closedAtEof), closedAtEof.length, '末行闭合围栏（无尾换行）边界到末尾');
  assert.equal(findStableBoundary(closedAtEof + '\n'), closedAtEof.length + 1, '闭合围栏后带换行，边界含换行');

  const fenceThenText = '```js\ncode\n```\n后续正文';
  assert.equal(
    findStableBoundary(fenceThenText),
    fenceThenText.indexOf('后续正文'),
    '围栏之后的正文留在活动尾部',
  );

  assert.equal(findStableBoundary('```component\n{"a":1'), 0, '未闭合围栏不可冻结');
  // CommonMark：闭合标记长度 ≥ 开标记即有效（更长的闭合可以关闭短的开启）
  const longClose = '```\ncode\n````\ntail';
  assert.equal(findStableBoundary(longClose), longClose.indexOf('tail'), '更长的闭合标记有效');
  // 反向：开标记 4 个反引号，3 个的闭合无效 → 围栏未闭合
  assert.equal(findStableBoundary('````\ncode\n```\n'), 0, '闭合标记短于开标记不算闭合');

  const tilde = '~~~\ncode\n~~~\ntail';
  assert.equal(findStableBoundary(tilde), tilde.indexOf('tail'), '波浪线围栏识别');

  const twoFences = '前言\n```js\na\n```\n中间\n```js\nb\n```\n尾巴';
  const lastClose = twoFences.indexOf('```js\nb');
  assert.equal(
    findStableBoundary(twoFences),
    twoFences.indexOf('\n尾巴') + 1,
    '多个围栏取最后一个闭合点',
  );
  assert.ok(lastClose > 0);

  // think 跨界保护
  assert.equal(findStableBoundary('<think>\n```js\nx\n```'), 0, '未闭合 think 内的围栏闭合不可冻结');
  const thinkClosedLater = '<think>a\n```js\nx\n```\n</think>\n正文\n```js\ny\n```\n';
  assert.equal(
    findStableBoundary(thinkClosedLater),
    thinkClosedLater.length,
    'think 闭合后的围栏闭合可冻结（覆盖全部前缀）',
  );

  // api-error 跨界保护（同 think）
  assert.equal(findStableBoundary('<api-error kind="http">\n```js\nx\n```'), 0, '未闭合 api-error 不可冻结');

  // $$ 奇偶保护：奇数 $$ 后的围栏闭合不可冻结；补齐后可
  const dollarOdd = '公式开始\n$$\nE=mc^2\n```js\ncode\n```\n';
  assert.equal(findStableBoundary(dollarOdd), 0, '未闭合块级公式的围栏闭合不可冻结');
  const dollarEven = dollarOdd + '$$\n收尾\n```js\nmore\n```\n';
  assert.equal(findStableBoundary(dollarEven), dollarEven.length, '$$ 补齐后的围栏闭合可冻结');

  // 围栏内的 $$ 与标签是字面量（extractLatex 跳过代码段语义）……但 think 摘出
  // 先于围栏识别（renderMessage 行为对齐）：围栏内的 <think> 标签仍计数
  const thinkInFence = '```js\n<think>\n```\n';
  assert.equal(findStableBoundary(thinkInFence), 0, '围栏内 think 标签仍阻断（对齐 renderMessage 摘出行为）');
  const dollarInFence = '```js\n$$\n```\n';
  assert.equal(findStableBoundary(dollarInFence), dollarInFence.length, '围栏内 $$ 是字面量不阻断');

  // 单调性（追加内容不收缩边界）
  let content = '```\na\n```\n';
  const b1 = findStableBoundary(content);
  for (const chunk of ['text ', 'more ', '```\nb\n```\n', 'tail ', '```js\nc\n```']) {
    content += chunk;
    const boundary = findStableBoundary(content);
    assert.ok(boundary >= b1, '追加内容不得收缩已冻结边界');
  }
}

// ==================== 2. MarkdownText 宿主（SFC 真实挂载） ====================

async function mountHost(initial) {
  // 单次挂载 + reactive 状态原地 patch props：组件实例（及其 DOM）跨更新
  // 存活——这正是被测不变量（追加式冻结）的前提条件
  const state = reactive({ ...initial });
  const mountPoint = document.createElement('div');
  document.body.appendChild(mountPoint);
  const app = createApp({
    render: () => h(MarkdownText, { content: state.content, streaming: state.streaming }),
  });
  app.mount(mountPoint);
  return {
    host: () => mountPoint.firstElementChild,
    set: async patch => {
      Object.assign(state, patch);
      await nextTick();
    },
    unmount: () => {
      app.unmount();
      mountPoint.remove();
    },
  };
}

const CHART_FENCE = '```component\n{"type":"chart","columns":["日期","新增"],"rows":[["周一",12],["周二",18]]}\n```';

{
  // 直播：围栏闭合即冻结，追加 token 不触碰已冻结段
  const host = await mountHost({ content: '结论先行：\n\n', streaming: true });
  await host.set({ content: '结论先行：\n\n' + CHART_FENCE + '\n' });
  await host.set({ content: '结论先行：\n\n' + CHART_FENCE + '\n补充解释正在输入' });
  await sleep(160); // 让节流生效

  const root = host.host();
  const segments = root.querySelectorAll(':scope > .md-seg-stable');
  assert.ok(segments.length >= 1, '围栏闭合后产生冻结段');
  const tail = root.querySelector(':scope > .md-live-tail');
  assert.ok(tail, '活动尾部节点存在');
  assert.ok(root.lastElementChild === tail, '活动尾部恒为最后一个子节点');
  assert.equal(tail.getAttribute('data-streaming'), '1', '尾部带直播标记（渲染器跳过契约）');

  const chartBlock = segments[0].querySelector('.chart-block');
  assert.ok(chartBlock, '冻结段内含图表骨架');
  assert.equal(chartBlock.getAttribute('data-chart-input'), 'envelope');
  assert.ok(tail.textContent.includes('补充解释'), '尾部实时渲染新 token');

  // 追加不变量：给首个冻结段打标记，后续 token 不得销毁它
  const firstSegment = segments[0];
  firstSegment.dataset.probeMarker = 'keep-me';
  const chartBefore = segments[0].querySelector('.chart-block');
  chartBefore?.setAttribute('data-probe', 'mounted');

  await host.set({ content: '结论先行：\n\n' + CHART_FENCE + '\n补充解释正在输入，更多内容' });
  await sleep(160);
  await host.set({
    content: '结论先行：\n\n' + CHART_FENCE + '\n补充解释完成。\n\n' + CHART_FENCE.replace('"周一"', '"周日"') + '\n',
  });
  await sleep(160);

  const rootAfter = host.host();
  const kept = rootAfter.querySelector('.md-seg-stable[data-probe-marker="keep-me"]');
  assert.ok(kept, '已冻结段节点身份跨更新保持');
  assert.equal(kept.querySelector('.chart-block')?.getAttribute('data-probe'), 'mounted', '段内挂载产物未被重建');
  const segmentsAfter = rootAfter.querySelectorAll(':scope > .md-seg-stable');
  assert.ok(segmentsAfter.length >= 2, '第二个闭合围栏追加为新冻结段');

  // 终排：流结束，剩余尾部全部冻结，既有段身份不变
  await host.set({
    content: '结论先行：\n\n' + CHART_FENCE + '\n补充解释完成。\n\n' + CHART_FENCE.replace('"周一"', '"周日"') + '\n最终结论一句话。',
    streaming: false,
  });
  await nextTick();
  const finalRoot = host.host();
  assert.ok(
    finalRoot.querySelector('.md-seg-stable[data-probe-marker="keep-me"]'),
    '终排不销毁已冻结段',
  );
  assert.ok(
    [...finalRoot.querySelectorAll('.md-seg-stable')].some(s => s.textContent.includes('最终结论一句话')),
    '终排把尾部冻结为最后一段',
  );
  const finalTail = finalRoot.querySelector(':scope > .md-live-tail');
  assert.equal(finalTail?.textContent, '', '终排后活动尾部清空');
  host.unmount();
}

{
  // 前缀改写：稳定区整体重建（标记清除）
  const host = await mountHost({ content: '```\nold\n```\n', streaming: true });
  await sleep(160);
  let root = host.host();
  let segment = root.querySelector(':scope > .md-seg-stable');
  assert.ok(segment, '首个冻结段存在');
  segment.dataset.probeMarker = 'first';

  await host.set({ content: '改写后的开头\n```\nnew\n```\n', streaming: true });
  await sleep(160);
  root = host.host();
  assert.ok(!root.querySelector('[data-probe-marker]'), '前缀改写触发稳定区重建');
  assert.ok(
    [...root.querySelectorAll('.md-seg-stable')].some(s => s.textContent.includes('new')),
    '重建后渲染新前缀',
  );
  host.unmount();
}

{
  // 历史片段（未经历直播）：一次性整渲染，无冻结段包裹层（与旧 v-html 等价）
  const host = await mountHost({ content: '普通段落\n\n' + CHART_FENCE + '\n', streaming: false });
  await nextTick();
  const root = host.host();
  assert.equal(root.querySelectorAll('.md-seg-stable').length, 0, '历史片段无冻结段包裹');
  assert.equal(root.querySelectorAll('.md-live-tail').length, 0, '历史片段无尾部节点');
  assert.ok(root.querySelector('.chart-block'), '图表骨架照常产出（由扫描器挂载）');
  assert.ok(root.innerHTML.startsWith('<p>'), '产物结构为裸渲染 HTML（等价 v-html）');
  host.unmount();
}

console.log('[chat-ui] Streaming incremental freeze: boundary detection + MarkdownText host invariants passed.');

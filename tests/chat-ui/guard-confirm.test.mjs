/**
 * 循环守卫确认条回归测试（设计语言对齐任务计划卡片后的结构与行为）
 *
 * 挂载真实编译产物（compileScript 内联模板 render），覆盖：
 *   1. 卡片结构：卡壳 / 图标徽标（kind 修饰类）/ 标题 / 倒计时辅助行 /
 *      停止 + 继续按钮 / 卡底倒计时轨道（fill + is-urgent）
 *   2. 三类守卫文案与徽标：max-iterations / max-duration / tool-failures
 *      （tool-failures 徽标取语义红修饰类，其余两类保持中性）
 *   3. 倒计时轨道占比：secondsLeft / totalSeconds，超界钳制到 0–100%；
 *      末 10s（含 10）轨道转 is-urgent，11s 仍为中性
 *   4. 意图透传：点击「停止」/「继续运行」分别 emit stop / continue
 *
 * 运行：node tests/chat-ui/guard-confirm.test.mjs   （或 npm run test:chat-ui）
 */

import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const file = path.resolve('entrypoints/sidepanel/components/chat/GuardConfirmBar.vue');
const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file });
// 显式 inlineTemplate：<script setup> 的模板编译为内联 render 一并产出
// （3.5 的 compileScript 默认不内联，缺 render 会挂出空组件）
const script = compileScript(descriptor, { id: 'guard-confirm-regression', inlineTemplate: true });
const outfile = path.resolve('node_modules/.cache/guard-confirm-regression.mjs');
mkdirSync(path.dirname(outfile), { recursive: true });
await build({
  // 尾附 i18n 再导出：文案断言用真实 zh-CN 词条（与 api-error-card 测试同口径，
  // 纯 node ESM 解析不了 core 的无扩展名内部导入，须随 esbuild 一并打包）
  stdin: {
    contents: script.content + "\nexport { t, setLocale } from '@/utils/i18n';",
    loader: 'ts',
    resolveDir: path.dirname(file),
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // vue 与 lucide 图标用真实实现（模板里 Transition 与图标组件都会真实挂载）
  external: ['vue', 'lucide-vue-next'],
  loader: { '.css': 'empty' },
  plugins: [
    {
      name: 'i18n-real-core',
      setup(api) {
        api.onResolve({ filter: /^@\/utils\/i18n$/ }, () => ({
          path: path.resolve('utils/i18n/core.ts'),
        }));
      },
    },
  ],
});

// —— DOM 环境（必须在导入被测模块之前就绪）——
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'https://extension.test/sidepanel.html',
  pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) {
  globalThis[key] = dom.window[key];
}
// <Transition> 进出场帧回调（对齐 tests/plugins/dom-setup.mjs 的做法）
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);

const { createApp, h, reactive, nextTick } = await import('vue');
const { default: GuardConfirmBar, t, setLocale } = await import(pathToFileURL(outfile).href);
setLocale('zh-CN');

/** 以受控 props 挂载组件，返回根元素与事件记录器 */
async function mountGuard(props) {
  const events = [];
  const state = reactive({ ...props });
  const app = createApp({
    setup: () => () =>
      h(GuardConfirmBar, {
        ...state,
        onContinue: () => events.push('continue'),
        onStop: () => events.push('stop'),
      }),
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const vm = app.mount(host);
  await nextTick();
  return { state, events, el: vm.$el, unmount: () => { app.unmount(); host.remove(); } };
}

// —— 1. 结构：max-iterations 全宽轨道（60/60）——
{
  const { el, events, unmount } = await mountGuard({
    visible: true,
    kind: 'max-iterations',
    count: 30,
    secondsLeft: 60,
    totalSeconds: 60,
  });
  const card = el;
  assert.ok(card.classList.contains('guard-confirm-bar'), '根节点为守卫卡片');
  const mark = card.querySelector('.guard-bar-mark');
  assert.ok(mark, '图标徽标存在');
  assert.ok(mark.classList.contains('is-max-iterations'), '徽标带 kind 修饰类');
  assert.ok(mark.querySelector('svg'), '徽标内渲染图标 svg');
  assert.equal(card.querySelector('.guard-bar-title').textContent,
    t('sidepanel.chat.guardTitleIterations', { count: 30 }), '标题为轮次上限文案');
  assert.match(card.querySelector('.guard-bar-hint').textContent, /60/, '辅助行含倒计时秒数');
  const buttons = card.querySelectorAll('.guard-btn');
  assert.equal(buttons.length, 2, '停止 + 继续两个按钮');
  assert.ok(buttons[0].classList.contains('guard-btn-stop'), '左侧为次行动（停止）');
  assert.ok(buttons[1].classList.contains('guard-btn-continue'), '右侧为主行动（继续）');
  assert.equal(buttons[1].textContent, '继续运行', '主行动按钮文案');
  const fill = card.querySelector('.guard-bar-track-fill');
  assert.ok(fill, '卡底倒计时轨道存在');
  assert.match(fill.style.width, /^100(\.00)?%$/, '60/60 → 全宽');
  assert.ok(!fill.classList.contains('is-urgent'), '60s 不紧迫');

  // —— 4. 意图透传 ——
  buttons[0].click();
  buttons[1].click();
  assert.deepEqual(events, ['stop', 'continue'], '点击分别 emit stop / continue');
  unmount();
}

// —— 2. max-duration：中性徽标 + 真实时长文案 ——
{
  const { el, unmount } = await mountGuard({
    visible: true,
    kind: 'max-duration',
    minutes: 20,
    secondsLeft: 37,
    totalSeconds: 60,
  });
  const mark = el.querySelector('.guard-bar-mark');
  assert.ok(mark.classList.contains('is-max-duration'), '时长守卫徽标修饰类');
  assert.ok(!mark.classList.contains('is-tool-failures'), '非失败守卫保持中性');
  assert.equal(el.querySelector('.guard-bar-title').textContent,
    t('sidepanel.chat.guardTitleDuration', { minutes: 20 }), '标题为时长上限文案');
  assert.equal(el.querySelector('.guard-bar-track-fill').style.width, '61.67%', '37/60 → 61.67%');
  unmount();
}

// —— 3. tool-failures：语义红徽标修饰类 ——
{
  const { el, unmount } = await mountGuard({
    visible: true,
    kind: 'tool-failures',
    count: 3,
    secondsLeft: 52,
    totalSeconds: 60,
  });
  assert.ok(el.querySelector('.guard-bar-mark').classList.contains('is-tool-failures'),
    '连续失败守卫徽标带语义红修饰类');
  assert.equal(el.querySelector('.guard-bar-title').textContent,
    t('sidepanel.chat.guardTitleFailures', { count: 3 }), '标题为连续失败文案');
  unmount();
}

// —— 3b. 紧迫边界：10s 触发、11s 不触发；超界钳制 ——
{
  const { state, el, unmount } = await mountGuard({
    visible: true,
    kind: 'max-iterations',
    count: 30,
    secondsLeft: 11,
    totalSeconds: 60,
  });
  const fill = el.querySelector('.guard-bar-track-fill');
  assert.ok(!fill.classList.contains('is-urgent'), '11s 仍为中性');
  state.secondsLeft = 10;
  await nextTick();
  assert.ok(fill.classList.contains('is-urgent'), '10s 起轨道转紧迫红');
  state.secondsLeft = 120; // 超界（守卫串行触发等防御路径）
  await nextTick();
  assert.match(fill.style.width, /^100(\.00)?%$/, '超界钳制到 100%');
  state.secondsLeft = -5; // 归零后兜底
  await nextTick();
  assert.equal(fill.style.width, '0%', '负值钳制到 0%');
  state.visible = false;
  await nextTick();
  unmount();
}

console.log('[chat-ui] Guard confirm bar structure, kinds, countdown track and intent emissions passed.');

/** Actual interact tool -> shared UI queue -> result callback, as used by local
 * learning/validation and by the ordinary chat question transport. */
import { build } from 'esbuild';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { JSDOM } from 'jsdom';
const outfile = path.resolve('node_modules/.cache/questions-ui.mjs');
await build({ stdin: { contents: `
  export * from './entrypoints/sidepanel/composables/use-interact';
  export * from './tools/interact/interact-ui-bridge';
  export { interactTool } from './tools/interact/interact-tool';
  export { default as InteractDialog } from './entrypoints/sidepanel/components/feedback/InteractDialog.vue';
  export { default as SiteLearnModal } from './entrypoints/sidepanel/components/learn/SiteLearnModal.vue';
  export { default as LearnDialog } from './entrypoints/sidepanel/components/learn/LearnDialog.vue';
`, resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true,
  platform: 'node', format: 'esm', external: ['vue'], loader: { '.css': 'empty' }, plugins: [{
    name: 'question-settings', setup(api) {
      api.onResolve({ filter: /@\/utils\/i18n$/ }, args => ({ path: args.path, namespace: 'i18n' }));
      api.onLoad({ filter: /.*/, namespace: 'i18n' }, () => ({ contents: 'export const t=key=>key;' }));
      api.onLoad({ filter: /\.vue$/ }, args => {
        if (!/(?:InteractDialog|SiteLearnModal|LearnDialog)\.vue$/.test(args.path))
          return { contents: 'export default {render:()=>null};', loader: 'js' };
        const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
        return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content,
          loader: 'ts', resolveDir: path.dirname(args.path) };
      });
      api.onResolve({ filter: /utils\/channels$/ }, args => ({ path: args.path, namespace: 'settings' }));
      api.onLoad({ filter: /.*/, namespace: 'settings' }, () => ({ contents: `
        export const INTERACT_TIMEOUT_MIN_MINUTES=1,INTERACT_TIMEOUT_MAX_MINUTES=60,INTERACT_TIMEOUT_DEFAULT_MINUTES=20;
        export const appSettingsStore={getInteractTimeoutMinutes:()=>1};
      ` }));
    },
  }] });
const previousWindow = globalThis.window;
const dom = new JSDOM('<div id="questions"></div>', { url: 'https://example.test/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver'])
  globalThis[key] = dom.window[key];
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
const { createApp, h, ref, nextTick } = await import('vue');
const api = await import(pathToFileURL(outfile).href);
const ticks = new Map();
let nextTimer = 0;
window.setInterval = fn => { ticks.set(++nextTimer, fn); return nextTimer; };
window.clearInterval = id => ticks.delete(id);
const resetEpoch = ref(1), visible = ref(true), confirmation = ref(null);
const submissions = [], errors = [], choices = [];
const app = createApp({ render: () => h('div', [
  h(api.SiteLearnModal, { visible: visible.value, resetEpoch: resetEpoch.value, errors: {}, modelCandidates: [], onSubmit: raw => submissions.push(raw) }),
  h(api.LearnDialog, { view: confirmation.value, onAnswer: (...args) => choices.push(args) }),
  h(api.InteractDialog),
]) });
app.config.errorHandler = error => errors.push(error);
app.mount('#questions');
const state = api.useInteractDialog();
const ask = () => api.interactTool.execute({ question: '请在网站中完成登录后继续', sensitive: true }, { chatId: 'learning' });
try {
  // Exercise the actual textarea -> emitted config -> back-to-edit/reset behavior.
  const fields = document.querySelectorAll('.learn-field__textarea');
  assert.equal(document.querySelector('.learn-advanced').open, false, '高级设置默认折叠');
  const budgetInputs = document.querySelectorAll('.learn-budget input');
  assert.deepEqual([...budgetInputs].map(input => input.value), ['60', '30', '60', '30']);
  for (const [index, value] of ['12', '7', '8', '4'].entries()) {
    budgetInputs[index].value = value; budgetInputs[index].dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  assert.equal(fields.length, 2, '额外描述紧随学习目标');
  fields[0].value = '采集商品 SKU'; fields[0].dispatchEvent(new window.Event('input', { bubbles: true }));
  fields[1].value = '先选颜色\n再选尺寸，已处理的跳过'; fields[1].dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('.learn-modal .learn-btn--primary').click();
  assert.equal(submissions[0].additionalDescription, '先选颜色\n再选尺寸，已处理的跳过');
  assert.deepEqual(submissions[0].learningLimits, { maxIterations: 12, maxDurationMinutes: 7 });
  assert.deepEqual(submissions[0].validationLimits, { maxIterations: 8, maxDurationMinutes: 4 });
  document.querySelector('.learn-toggle').click(); await nextTick();
  assert.equal(document.querySelectorAll('.learn-budget').length, 1, '关闭验证隐藏验证预算');
  document.querySelector('.learn-modal .learn-btn--primary').click();
  assert.equal(submissions[1].validationLimits, undefined, '关闭验证不提交隐藏预算');
  document.querySelector('.learn-toggle').click(); await nextTick();
  visible.value = false; confirmation.value = { mode: 'start', config: { ...submissions[0], modelRef: { channelId: 'a', modelId: 'b' } }, modelLabel: 'test' };
  await nextTick();
  assert.ok(document.querySelector('.learn-summary').textContent.includes('先选颜色\n再选尺寸'), '确认页保留多行描述');
  confirmation.value = null; visible.value = true; await nextTick();
  assert.equal(document.querySelectorAll('.learn-field__textarea')[1].value, submissions[0].additionalDescription, '返回修改保留描述');
  resetEpoch.value++; await nextTick();
  assert.equal(document.querySelectorAll('.learn-field__textarea')[1].value, '', '新学习意图清空旧描述');
  assert.deepEqual([...document.querySelectorAll('.learn-budget input')].map(input => input.value), ['60', '30', '60', '30'], '新意图恢复默认预算');
  visible.value = false; await nextTick();
  for (const phase of ['learning', 'validating']) {
    confirmation.value = { mode: 'limitWrapUp', phase, reason: 'max-duration', iterations: 60, minutes: 30, extraIterations: 15 };
    await nextTick();
    const input = document.querySelector('.learn-extension__input');
    const buttons = document.querySelectorAll('.learn-limit-actions button');
    assert.equal(buttons.length, 3, '两个阶段均提供三种触限选择');
    assert.equal(input.value, '15');
    for (const bad of ['0', '-1', '1.5', '']) {
      input.value = bad; input.dispatchEvent(new window.Event('input', { bubbles: true })); await nextTick();
      assert.equal(buttons[0].disabled, true, '非法追加轮次禁用继续');
    }
    input.value = '1'; input.dispatchEvent(new window.Event('input', { bubbles: true })); await nextTick();
    buttons[0].click(); assert.deepEqual(choices.at(-1), ['extend', 1], '用户自定义轮次作为第二参数回传');
    buttons[1].click(); assert.equal(choices.at(-1)[0], 'summarize');
    buttons[2].click(); assert.equal(choices.at(-1)[0], 'discard');
    confirmation.value = null; await nextTick();
  }
  for (const phase of ['learning', 'validating']) {
    const pending = api.interactTool.execute({ question: `${phase}: 用户流程与页面不符，请澄清`, options: [{ label: '使用新的入口' }] }, { chatId: phase });
    await nextTick();
    assert.ok(document.querySelector('.interact-question').textContent.includes(phase), '真实交互组件显示阶段问题');
    if (phase === 'learning') document.querySelector('.interact-option').click();
    else {
      const input = document.querySelector('.interact-custom-input');
      input.value = '按已确认的新路径继续'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
      await nextTick(); document.querySelector('.interact-btn-primary').click();
    }
    assert.equal((await pending).data.answer, phase === 'learning' ? '使用新的入口' : '按已确认的新路径继续', '组件上的真实答复回到工具');
    await nextTick();
  }
  const answered = ask();
  assert.equal(state.value.visible, true, 'Learning interact must open the shared UI');
  api.minimizeInteract(); assert.equal(state.value.phase, 'ball');
  api.reopenInteract(); assert.equal(state.value.phase, 'dialog');
  api.submitInteractAnswer('已完成登录，可以继续', 'custom');
  assert.equal((await answered).data.answer, '已完成登录，可以继续');
  assert.equal(state.value.visible, false);
  const declined = ask(); api.declineInteract();
  assert.equal((await declined).data.status, 'declined');
  const timeout = ask();
  const now = Date.now;
  try { Date.now = () => now() + 61000; [...ticks.values()][0](); }
  finally { Date.now = now; }
  assert.equal((await timeout).data.status, 'timeout');
  const first = ask(), second = ask();
  api.dismissPendingInteracts();
  for (const pending of [first, second]) assert.equal((await pending).data.status, 'dismissed');
  assert.equal(state.value.visible, false);
  assert.equal(ticks.size, 0, 'Abort/exit must clear every question timer');
  assert.deepEqual(errors, [], '配置和实际交互组件挂载/回调无运行错误');
  console.log('[chat-ui] Actual interact tool, shared question UI, answer/decline/timeout/abort and queued callbacks passed.');
} finally {
  api.dismissPendingInteracts(); app.unmount();
  // Let Vue's queued transition frames finish before disposing the browser surface.
  await new Promise(resolve => setTimeout(resolve, 50));
  dom.window.close(); globalThis.window = previousWindow;
}

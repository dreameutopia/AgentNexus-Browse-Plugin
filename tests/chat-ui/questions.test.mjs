/** Actual interact tool -> shared UI queue -> result callback, as used by the
 * ordinary chat question transport. */
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
`, resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true,
  platform: 'node', format: 'esm', external: ['vue'], loader: { '.css': 'empty' }, plugins: [{
    name: 'question-settings', setup(api) {
      api.onResolve({ filter: /@\/utils\/i18n$/ }, args => ({ path: args.path, namespace: 'i18n' }));
      api.onLoad({ filter: /.*/, namespace: 'i18n' }, () => ({ contents: 'export const t=key=>key;' }));
      api.onLoad({ filter: /\.vue$/ }, args => {
        if (!/InteractDialog\.vue$/.test(args.path))
          return { contents: 'export default {render:()=>null};', loader: 'js' };
        const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
        return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content,
          loader: 'ts', resolveDir: path.dirname(args.path) };
      });
      api.onResolve({ filter: /utils\/channels$/ }, args => ({ path: args.path, namespace: 'settings' }));
      api.onLoad({ filter: /.*/, namespace: 'settings' }, () => ({ contents: `
        export const USER_RESPONSE_TIMEOUT_MIN_MINUTES=1,USER_RESPONSE_TIMEOUT_MAX_MINUTES=120,USER_RESPONSE_TIMEOUT_DEFAULT_MINUTES=20;
        export const resolveUserResponseWaitMs=minutes=>(Number.isFinite(minutes)?Math.min(120,Math.max(1,Math.floor(minutes))):20)*60000;
        export const appSettingsStore={getUserResponseTimeoutMinutes:()=>1};
      ` }));
    },
  }] });
const previousWindow = globalThis.window;
const dom = new JSDOM('<div id="questions"></div>', { url: 'https://example.test/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver'])
  globalThis[key] = dom.window[key];
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
const { createApp, h, nextTick } = await import('vue');
const api = await import(pathToFileURL(outfile).href);
const ticks = new Map();
let nextTimer = 0;
window.setInterval = fn => { ticks.set(++nextTimer, fn); return nextTimer; };
window.clearInterval = id => ticks.delete(id);
const errors = [];
const app = createApp({ render: () => h('div', [
  h(api.InteractDialog),
]) });
app.config.errorHandler = error => errors.push(error);
app.mount('#questions');
const state = api.useInteractDialog();
const ask = () => api.interactTool.execute({ question: '请在网站中完成登录后继续', sensitive: true }, { chatId: 'learning' });
try {
  // 多选（multiSelect=true）：点选项只切换勾选，须点「提交所选」一次性答复
  {
    const pending = api.interactTool.execute({
      question: '这次要处理哪几项？',
      multiSelect: true,
      options: [{ label: '字段 A' }, { label: '字段 B' }, { label: '字段 C' }],
    }, { chatId: 'multi' });
    await nextTick();
    const buttons = [...document.querySelectorAll('.interact-option')];
    assert.equal(buttons.length, 3, '多选弹窗渲染全部候选');
    assert.equal(document.querySelectorAll('.interact-option.is-selectable').length, 3, '每个选项进入多选态');
    assert.equal(buttons[0].getAttribute('aria-pressed'), 'false', '未勾选项 aria-pressed=false');
    // 结构契约：问题/背景/选项在中部滚动区内，作答区与底部固定在卡片直下
    assert.ok(document.querySelector('.interact-body .interact-question'), '问题位于中部滚动区');
    assert.ok(document.querySelector('.interact-body .interact-options'), '选项位于中部滚动区');
    assert.ok(
      document.querySelector('.interact-body > .interact-multi-hint'),
      '多选提示在选项容器之外（选项滚动时不被带走）',
    );
    assert.ok(
      document.querySelector('.interact-dialog > .interact-custom'),
      '作答区固定在中部滚动区之外（始终可见可输入）',
    );
    assert.ok(
      document.querySelector('.interact-dialog > .interact-footer'),
      '底部固定在中部滚动区之外（倒计时与按钮始终可见）',
    );

    buttons[0].click(); await nextTick();
    buttons[2].click(); await nextTick();
    assert.equal(document.querySelectorAll('.interact-option.is-selected').length, 2, '勾选两项');
    assert.equal(state.value.visible, true, '点选项不立即提交（与单选的关键差异）');
    assert.ok(
      document.querySelector('.interact-options').classList.contains('has-selection'),
      '容器标记已有勾选（推荐高亮让位于选中态）',
    );
    assert.equal(buttons[0].getAttribute('aria-pressed'), 'true', '已勾选项 aria-pressed=true');

    buttons[0].click(); await nextTick();
    assert.equal(document.querySelectorAll('.interact-option.is-selected').length, 1, '再点一次取消勾选');

    const submit = document.querySelector('.interact-btn-primary');
    buttons[0].click(); await nextTick();
    assert.ok(
      submit.textContent.includes('submitSelected'),
      '无自定义文本时主按钮走「提交所选」文案（i18n 桩返回 key）',
    );
    assert.equal(submit.disabled, false, '有勾选时可提交');
    submit.click();
    const multiResult = await pending;
    assert.equal(multiResult.data.answer, '字段 A、字段 C', '多选答复按选项顺序拼接');
    assert.deepEqual(multiResult.data.answers, ['字段 A', '字段 C'], '结构化清单回传');
    await nextTick();
    assert.equal(state.value.visible, false, '提交后弹窗收敛');
  }

  // 多选的空选禁用与自定义覆盖：无勾选禁用主按钮；有自定义文本时以自定义为准
  {
    const pending = api.interactTool.execute({
      question: '还要补充处理哪些？',
      multiSelect: true,
      options: [{ label: '字段 D' }, { label: '字段 E' }],
    }, { chatId: 'multi-custom' });
    await nextTick();
    assert.equal(document.querySelectorAll('.interact-option.is-selected').length, 0, '新询问不带上一次的勾选');
    const submit = document.querySelector('.interact-btn-primary');
    assert.equal(submit.disabled, true, '未勾选且无自定义文本时禁用提交');
    submit.click();
    assert.equal(state.value.visible, true, '禁用态点击不收敛');

    const input = document.querySelector('.interact-custom-input');
    input.value = '只处理字段 D 的历史遗留数据';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await nextTick();
    assert.equal(submit.disabled, false, '有自定义文本即可提交');
    submit.click();
    const customResult = await pending;
    assert.equal(customResult.data.answer, '只处理字段 D 的历史遗留数据', '自定义文本覆盖勾选');
    assert.equal(customResult.data.answers, undefined, '自定义答复不带多选清单');
    await nextTick();
    assert.equal(state.value.visible, false, '自定义提交后弹窗收敛');
  }

  // —— 布局契约（静态断言：JSDOM 不做布局，高度分配靠样式表本身保证）——
  // 回归背景：问题/背景带 overflow-y:auto 的 flex 子项，其自动最小高度为 0，
  // 卡片超高时全部收缩量被它们吸收 → 问题被压成一两行；选项是 overflow:visible
  // 的 flex 子项，最小高度 = 内容高度，一行都不肯让。防线见下。
  {
    const css = readFileSync(
      path.resolve('entrypoints/sidepanel/components/feedback/interact-dialog.css'),
      'utf8',
    );
    const rule = name => {
      const matched = css.match(new RegExp(`\\.${name}\\s*\\{[^}]*`));
      assert.ok(matched, `存在 .${name} 规则`);
      return matched[0];
    };
    // 卡片：82vh 封顶 + 极矮窗口下的兜底整卡滚动
    assert.match(rule('interact-dialog'), /max-height:\s*82vh/, '卡片 82vh 封顶');
    assert.match(rule('interact-dialog'), /overflow-y:\s*auto/, '卡片兜底滚动，不裁切内容');
    // 中部滚动区：吃掉剩余高度 + 下限 + 自身滚动
    assert.match(rule('interact-body'), /flex:\s*1 1 auto/, '中部吃掉卡片剩余高度');
    assert.match(rule('interact-body'), /min-height:\s*72px/, '中部有收缩下限，不塌成 0 高度');
    assert.match(rule('interact-body'), /overflow-y:\s*auto/, '中部内容超出在此滚动');
    // 各分区：只封顶、不收缩（问题被压扁的直接防线），且各自有滚动条。
    // 上限一律 clamp(下限, 占比, 上限)：占比随视口等比，绝对下限保证极矮
    // 视口（vh 归零）也不会把分区压成一条缝。
    for (const [name, vh] of [
      ['interact-question', '26vh'],
      ['interact-context', '16vh'],
      ['interact-options', '38vh'],
    ]) {
      const text = rule(name);
      assert.match(text, /flex:\s*0 0 auto/, `.${name} 不参与收缩`);
      assert.match(
        text,
        new RegExp(`max-height:\\s*clamp\\([^)]*${vh}`),
        `.${name} 按 ${vh} 占比封顶且带绝对下限`,
      );
      assert.match(text, /overflow-y:\s*auto/, `.${name} 超出块内滚动`);
    }
    // 固定段：头部 / 作答区 / 底部任何情况下不被压缩
    for (const name of ['interact-header', 'interact-custom', 'interact-footer']) {
      assert.match(rule(name), /flex-shrink:\s*0/, `.${name} 固定不收缩`);
    }
    // 作答区与输入框：整体与输入框都按占比封顶（长答复块内滚动）
    assert.match(
      rule('interact-custom'),
      /max-height:\s*clamp\([^)]*22vh/,
      '作答区按 22vh 占比封顶',
    );
    assert.match(
      rule('interact-custom-input'),
      /max-height:\s*clamp\([^)]*12vh/,
      '输入框按 12vh 占比封顶',
    );
    assert.match(rule('interact-custom-input'), /overflow-y:\s*auto/, '输入框超出块内滚动');
    // 滚动区统一防滚轮穿透 + 细滚动条（与侧边栏其它滚动区一致）
    for (const name of ['interact-dialog', 'interact-body', 'interact-options']) {
      assert.match(rule(name), /overscroll-behavior:\s*contain/, `.${name} 防滚轮穿透`);
      assert.match(rule(name), /scrollbar-width:\s*thin/, `.${name} 细滚动条`);
    }
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

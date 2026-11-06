/** 自动滚动跟随回归：滚动容器解析（找 overflow 祖先而非内容节点）、
 *  用户接管/释放、程序滚动忽略窗口。JSDOM 无布局，滚动属性以实例级
 *  defineProperty 伪造（scrollTop 可写、scrollHeight 固定值）。 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const file = path.resolve('entrypoints/sidepanel/components/chat/ChatMessageList.vue');
const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file });
const script = compileScript(descriptor, { id: 'scroll-follow-test', genDefaultAs: '_sfc_main' });
const template = compileTemplate({
  source: descriptor.template.content,
  filename: file,
  id: 'scroll-follow-test',
  compilerOptions: { bindingMetadata: script.bindings },
});
const outfile = path.resolve('node_modules/.cache/chat-scroll-follow.mjs');
mkdirSync(path.dirname(outfile), { recursive: true });
await build({
  stdin: {
    contents: `${script.content}\n${template.code}\n_sfc_main.render = render;\nexport default _sfc_main;\n`,
    loader: 'ts',
    resolveDir: path.dirname(file),
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['vue'],
  loader: { '.css': 'empty' },
  plugins: [
    {
      name: 'scroll-follow-stubs',
      setup(api) {
        api.onResolve({ filter: /\.vue$|@\/utils\/i18n$|-renderer$/ }, args => ({ path: args.path, namespace: 'stub' }));
        api.onLoad({ filter: /.*/, namespace: 'stub' }, args => {
          if (args.path === '@/utils/i18n') return { contents: 'export const t=(k)=>k;' };
          if (args.path.endsWith('-renderer')) {
            return {
              contents:
                'export const installDiagramRenderer=()=>{};export const processDiagrams=()=>{};export const installChartRenderer=()=>{};export const processCharts=()=>{};export const installAgentImageRenderer=()=>{};export const processAgentImages=()=>{};',
            };
          }
          return { contents: 'export default { render: () => null };' };
        });
      },
    },
  ],
});

const dom = new JSDOM('<div id="app"></div>', { url: 'https://example.test/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver', 'Event']) {
  globalThis[key] = dom.window[key];
}
const { createApp, h, nextTick, reactive } = await import('vue');
const ChatMessageList = (await import(pathToFileURL(outfile).href)).default;

/** 伪造滚动几何：scrollHeight 定值、scrollTop 可写可读、clientHeight 0 */
const fakeScrollGeometry = (el, scrollHeight) => {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 0 });
  let top = 0;
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: v => { top = v; } });
  return el;
};

const mountList = async scrollerStyle => {
  const state = reactive({ messages: [], showChatMode: true, isAiResponding: false });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const Parent = {
    setup: () => () =>
      scrollerStyle
        ? h('div', { style: scrollerStyle }, [h(ChatMessageList, state)])
        : h(ChatMessageList, state),
  };
  const app = createApp(Parent);
  const errors = [];
  app.config.errorHandler = error => errors.push(error);
  app.mount(container);
  return { state, container, errors, unmount: () => { app.unmount(); container.remove(); } };
};

const msg = id => ({ id, role: 'assistant', content: `内容${id}`, parts: [{ type: 'text', content: `内容${id}` }], toolCalls: [] });

// ── 1. 滚动容器解析：跟随滚动必须落在 overflow 祖先上，而不是内容节点 ──
{
  const { state, container, errors, unmount } = await mountList('overflow-y: auto');
  assert.deepEqual(errors, []);
  const content = container.querySelector('.chat-content');
  const inner = container.querySelector('.messages-container');
  assert.ok(content && inner, '组件结构完整');
  // 内容节点与组件根都不是滚动容器（根无 overflow 声明），外层包裹层才是
  const scroller = content.parentElement;
  fakeScrollGeometry(scroller, 1000);
  fakeScrollGeometry(content, 500);
  fakeScrollGeometry(inner, 500);

  state.isAiResponding = true;
  state.messages = [msg('m1')];
  await nextTick();
  await nextTick();
  assert.equal(scroller.scrollTop, 1000, '跟随滚动解析到 overflow 祖先并落到其底部');
  assert.equal(content.scrollTop, 0, '不再对非滚动的内容/根节点做无效 scrollTop 赋值');
  unmount();
}

// ── 2. 用户接管与恢复：离开底部即接管，滚回底部恢复跟随 ──
{
  const { state, container, errors, unmount } = await mountList('overflow-y: auto');
  assert.deepEqual(errors, []);
  const scroller = container.querySelector('.chat-content').parentElement;
  fakeScrollGeometry(scroller, 1000);

  state.isAiResponding = true;
  state.messages = [msg('m1')];
  await nextTick();
  await nextTick();
  assert.equal(scroller.scrollTop, 1000, '初始跟随到底部');

  // 用户拖动滚动条离开底部（不经容器内滚轮的路径，scroll 事件兜底接管）；
  // 先等程序滚动的忽略窗口（64ms）过去——真实用户的拖动永远晚于该窗口
  await new Promise(resolve => setTimeout(resolve, 80));
  scroller.scrollTop = 400;
  scroller.dispatchEvent(new Event('scroll'));
  // 流式输出 = 同一条消息内容增长（length 不变，不触发会重置接管的 length 观察者）
  state.messages[state.messages.length - 1].content += ' 流式增量';
  await nextTick();
  await nextTick();
  assert.equal(scroller.scrollTop, 400, '接管后不再强制滚动，保持用户阅读位置');

  // 用户滚回底部附近 → 解除接管，恢复跟随
  scroller.scrollTop = 1000;
  scroller.dispatchEvent(new Event('scroll'));
  state.messages[state.messages.length - 1].content += ' 流式增量2';
  await nextTick();
  await nextTick();
  assert.equal(scroller.scrollTop, 1000, '回到底部后恢复跟随');
  unmount();
}

// ── 3. 程序滚动的忽略窗口：自己的跟随滚动不误判为用户离开底部 ──
{
  const { state, container, errors, unmount } = await mountList('overflow-y: auto');
  assert.deepEqual(errors, []);
  const scroller = container.querySelector('.chat-content').parentElement;
  fakeScrollGeometry(scroller, 1000);

  state.isAiResponding = true;
  state.messages = [msg('m1')];
  await nextTick();
  await nextTick();
  assert.equal(scroller.scrollTop, 1000);

  // 忽略窗口内的 scroll 不剥夺跟随
  scroller.scrollTop = 380;
  scroller.dispatchEvent(new Event('scroll'));
  state.messages[state.messages.length - 1].content += ' 流式增量';
  await nextTick();
  await nextTick();
  assert.equal(scroller.scrollTop, 1000, '忽略窗口内的 scroll 不剥夺跟随');

  // 窗口过后真实离开底部 → 接管
  await new Promise(resolve => setTimeout(resolve, 80));
  scroller.scrollTop = 300;
  scroller.dispatchEvent(new Event('scroll'));
  state.messages[state.messages.length - 1].content += ' 流式增量2';
  await nextTick();
  await nextTick();
  assert.equal(scroller.scrollTop, 300, '窗口外的离开底部正常接管');
  unmount();
}

dom.window.close();
console.log('[chat-ui] Scroll follow: scroller resolution, takeover/release and programmatic-window regression passed.');

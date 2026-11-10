/**
 * 用户消息气泡测试运行器（自动收起 + 右下角复制按钮）
 *
 * 用法：node tests/user-bubble/run.mjs
 *       npm run test:user-bubble
 *
 * 两段结构（对齐 tests/message-collapse）：
 *   1. 纯函数断言（user-message-collapse.test.ts 经 esbuild 打包后在 Node 执行）；
 *   2. 真实 SFC 挂载（UserMessageBubble / MessageItem 编译模板后在 JSDOM 渲染），
 *      验证模板接线：超长收起、展开/收起交互、复制按钮、用户消息走气泡渲染。
 * 产物写到 node_modules/.cache（不进版本库）。
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { buildSync, build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import process from 'node:process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const workDir = path.join(root, 'node_modules', '.cache', 'agentnexus-user-bubble');
mkdirSync(workDir, { recursive: true });

// ── 1. 纯函数测试 ──
{
  const suite = 'user-message-collapse.test.ts';
  const out = path.join(workDir, suite.replace(/\.ts$/, '.mjs'));
  try {
    buildSync({
      entryPoints: [path.join(here, suite)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      alias: { '@': root },
      outfile: out,
      logLevel: 'warning',
    });
  } catch (error) {
    console.error(`[user-bubble] ${suite} esbuild 打包失败:`, error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const pure = spawnSync(process.execPath, [out], { stdio: 'inherit' });
  assert.equal(pure.status, 0, `${suite} 纯函数测试`);
}

// ── 2. SFC 挂载测试 ──
/**
 * 编译单个 SFC 为可执行 ESM：script setup + 模板 → 带真实 render 的组件。
 * 重依赖（i18n / markdown 渲染器 / toast）与次要子组件以同名 stub 顶替；
 * vueImports 可把指定 .vue 导入指到预构建产物（MessageItem 复用真实
 * UserMessageBubble，保住「用户消息走气泡」的跨组件接线断言）。
 */
async function compileComponent(file, { vueImports = {} } = {}) {
  const source = readFileSync(file, 'utf8');
  const { descriptor } = parse(source, { filename: file });
  const script = compileScript(descriptor, { id: 'user-bubble-test', genDefaultAs: '_sfc_main' });
  const template = compileTemplate({
    source: descriptor.template.content,
    filename: file,
    id: 'user-bubble-test',
    compilerOptions: { bindingMetadata: script.bindings },
  });
  const code = `${script.content}\n${template.code}\n_sfc_main.render = render;\nexport default _sfc_main;\n`;
  const outfile = path.join(workDir, `${path.basename(file, '.vue')}.mjs`);
  await build({
    stdin: { contents: code, loader: 'ts', resolveDir: path.dirname(file) },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    // vue 与 lucide 图标走真实实现（气泡的引用标记图标），不进 bundle——
    // lucide 是 CJS，被 esbuild 内联后会触发 ESM 的 dynamic require 报错
    external: ['vue', 'lucide-vue-next'],
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'heavy-dep-stubs',
        setup(api) {
          const stubFilter = /\.vue$|@\/utils\/i18n$|^\.\/message$|markdown-renderer$|note-nav$|chat\/message$/;
          api.onResolve({ filter: stubFilter }, args => {
            const normalized = args.path.replace(/\\/g, '/');
            for (const [suffix, target] of Object.entries(vueImports)) {
              if (normalized.endsWith(suffix)) return { path: target, namespace: 'file' };
            }
            return { path: args.path, namespace: 'stub' };
          });
          api.onLoad({ filter: /.*/, namespace: 'stub' }, args => {
            if (args.path === '@/utils/i18n') return { contents: 'export const t=(k)=>k;' };
            // MarkdownText 桩件：保留 .message-content 类名（承载字号/行高，
            // 折叠高度正是从它测出来的），正文按纯文本输出
            if (args.path.endsWith('MarkdownText.vue')) {
              return {
                contents: `import {h} from 'vue';export default {name:'MarkdownText',props:['content','streaming'],setup(p){return()=>h('div',{class:'message-content'},p.content);}};`,
                loader: 'js',
              };
            }
            if (args.path.endsWith('UserMessageBubble.vue')) {
              return {
                contents: `import {h} from 'vue';export default {name:'UserMessageBubble',props:['content','messageId','quote'],setup(p){return()=>h('div',{class:'user-bubble'},[p.quote?h('blockquote',{class:'user-bubble-quote'},String(p.quote.text)):'',String(p.content||'')]);}};`,
                loader: 'js',
              };
            }
            if (args.path.endsWith('MessageParts.vue')) {
              return {
                contents: `import {h} from 'vue';export default {name:'MessageParts',props:['parts','messageId','streaming'],setup(){return()=>h('div',{class:'message-parts-stub'});}};`,
                loader: 'js',
              };
            }
            if (args.path.endsWith('MessageImages.vue')) {
              return {
                contents: `import {h} from 'vue';export default {name:'MessageImages',props:['imageRefs'],setup(){return()=>h('div',{class:'message-images'});}};`,
                loader: 'js',
              };
            }
            if (args.path.endsWith('markdown-renderer')) {
              return { contents: 'export const markdownRenderer={renderMessage:(s)=>String(s)};' };
            }
            if (args.path.endsWith('note-nav')) return { contents: 'export const openNoteDetail=()=>{};' };
            // toast（复制失败提示）
            if (args.path.endsWith('message')) {
              return { contents: 'export const message={error(){},success(){},info(){}};' };
            }
            return { contents: 'export default { render: () => null };' };
          });
        },
      },
    ],
  });
  return import(pathToFileURL(outfile).href);
}

const dom = new JSDOM('<div id="app"></div>', { url: 'https://example.test/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver']) {
  globalThis[key] = dom.window[key];
}
// Node 24 的 globalThis.navigator 是只读访问器，只能用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});
const { createApp, h, nextTick, reactive } = await import('vue');

/**
 * JSDOM 不做排版：scrollHeight 恒为 0、行高也测不出来。
 * 这里用可变的替身模拟「正文多高」——被测组件读到的就是它。
 */
let fakeContentHeight = 0;
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get() {
    return fakeContentHeight;
  },
});

/** 剪贴板替身：记录写入内容，供复制行为断言 */
const clipboardWrites = [];
Object.defineProperty(dom.window.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async text => {
      clipboardWrites.push(text);
    },
  },
});

/** 挂载组件：包一层响应式父组件渲染被测组件 */
const mount = async (component, props) => {
  const state = reactive({ ...props });
  const Parent = { setup: () => () => h(component, state) };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const app = createApp(Parent);
  const errors = [];
  app.config.errorHandler = error => errors.push(error);
  app.mount(container);
  await nextTick();
  return {
    container,
    state,
    errors,
    unmount: () => {
      app.unmount();
      container.remove();
    },
  };
};

const click = el => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

const UserMessageBubble = (await compileComponent(
  path.join(root, 'entrypoints/sidepanel/components/chat/UserMessageBubble.vue'),
)).default;
const MessageItem = (await compileComponent(
  path.join(root, 'entrypoints/sidepanel/components/chat/MessageItem.vue'),
  { vueImports: { 'UserMessageBubble.vue': path.join(workDir, 'UserMessageBubble.mjs') } },
)).default;

// ── A. 超长用户消息：自动收起 + 展开/收起交互 ──
{
  fakeContentHeight = 400;
  const { container, errors, unmount } = await mount(UserMessageBubble, {
    content: '这是一条很长的用户消息'.repeat(20),
  });
  assert.deepEqual(errors, [], '气泡渲染不得抛错');
  const bubble = container.querySelector('.user-bubble');
  assert.ok(bubble, '渲染出用户消息气泡');
  assert.ok(bubble.classList.contains('is-clamped'), '超长正文默认收起');
  const clip = container.querySelector('.user-bubble-clip');
  const clampHeight = Number.parseFloat(clip.style.maxHeight);
  assert.ok(Number.isFinite(clampHeight) && clampHeight > 0, '收起态写入折叠高度');
  assert.ok(container.querySelector('.user-bubble-fade'), '收起态出现底缘渐隐层');
  const expand = container.querySelector('.user-bubble-expand');
  assert.ok(expand, '超长时提供展开入口');
  assert.equal(expand.getAttribute('aria-expanded'), 'false', '收起态 aria-expanded');

  click(expand);
  await nextTick();
  assert.ok(bubble.classList.contains('is-expanded'), '点击后展开');
  assert.equal(expand.getAttribute('aria-expanded'), 'true', '展开态 aria-expanded 同步');
  assert.equal(clip.style.maxHeight, '', '展开态解除折叠高度');
  assert.equal(container.querySelectorAll('.user-bubble-fade').length, 0, '展开态不再有渐隐层');

  click(container.querySelector('.user-bubble-expand'));
  await nextTick();
  assert.ok(bubble.classList.contains('is-clamped'), '再次点击回到收起态');
  assert.ok(Number.parseFloat(clip.style.maxHeight) > 0, '收起态恢复折叠高度');
  unmount();
}

// ── B. 短消息：不收起、无展开入口，但复制按钮常驻 ──
{
  fakeContentHeight = 40;
  const { container, errors, unmount } = await mount(UserMessageBubble, { content: '短消息' });
  assert.deepEqual(errors, []);
  const bubble = container.querySelector('.user-bubble');
  assert.ok(!bubble.classList.contains('is-clamped'), '短消息不收起');
  assert.equal(container.querySelectorAll('.user-bubble-expand').length, 0, '短消息无展开入口');
  assert.ok(container.querySelector('.user-bubble-copy'), '复制按钮常驻');
  unmount();
}

// ── C. 复制按钮：写入剪贴板 + 成功态反馈；空正文禁用 ──
{
  fakeContentHeight = 40;
  clipboardWrites.length = 0;
  const { container, errors, unmount } = await mount(UserMessageBubble, { content: '可复制的用户消息' });
  assert.deepEqual(errors, []);
  const copy = container.querySelector('.user-bubble-copy');
  assert.ok(copy && !copy.disabled, '复制按钮可用');
  click(copy);
  await nextTick();
  await nextTick();
  assert.deepEqual(clipboardWrites, ['可复制的用户消息'], '复制按钮写入用户正文');
  assert.ok(copy.classList.contains('copied'), '复制成功进入成功态');
  unmount();

  clipboardWrites.length = 0;
  const empty = await mount(UserMessageBubble, { content: '' });
  const emptyCopy = empty.container.querySelector('.user-bubble-copy');
  assert.ok(emptyCopy.disabled, '空正文的复制按钮禁用（不留死按钮）');
  empty.unmount();
}

// ── D. MessageItem 接线：用户消息走气泡渲染，正文不重复渲染 ──
{
  fakeContentHeight = 40;
  const { container, errors, unmount } = await mount(MessageItem, {
    message: {
      id: 'm-user',
      role: 'user',
      content: '用户输入的内容',
      parts: [{ type: 'text', content: '用户输入的内容' }],
      toolCalls: [],
    },
    isLive: false,
  });
  assert.deepEqual(errors, [], '用户消息渲染不得抛错');
  assert.ok(container.querySelector('.user-bubble'), '用户消息渲染出气泡');
  assert.equal(container.querySelectorAll('.message-parts-stub').length, 0, '用户消息不走模型消息的片段渲染');
  assert.equal(container.querySelectorAll('.message-content').length, 1, '正文只渲染一次（气泡内的正文）');
  assert.equal(container.querySelectorAll('.user-bubble-quote').length, 0, '无 pageQuote 的消息不渲染引用块');
  unmount();
}

// ── D2. MessageItem 接线：pageQuote 透传进气泡并渲染引用块 ──
{
  fakeContentHeight = 40;
  const { container, errors, unmount } = await mount(MessageItem, {
    message: {
      id: 'm-user-quote',
      role: 'user',
      content: '请解释这段话',
      parts: [{ type: 'text', content: '请解释这段话' }],
      toolCalls: [],
      pageQuote: {
        text: '被引用的网页原文',
        source: { url: 'https://example.com/article', title: '示例文章' },
      },
    },
    isLive: false,
  });
  assert.deepEqual(errors, [], '带引用的用户消息渲染不得抛错');
  assert.ok(container.querySelector('.user-bubble'), '渲染出用户消息气泡');
  assert.ok(container.querySelector('.user-bubble-quote'), 'MessageItem 的 pageQuote 透传进气泡并渲染引用块');
  unmount();
}

// ── F. 引用块结构：标记 / 来源 / 原文；独立于正文折叠层 ──
{
  fakeContentHeight = 40;
  const { container, errors, unmount } = await mount(UserMessageBubble, {
    content: '基于这段引用作答',
    quote: {
      text: '被引用的网页原文',
      source: { url: 'https://example.com/article', title: '示例文章' },
    },
  });
  assert.deepEqual(errors, [], '带引用的气泡渲染不得抛错');
  const quote = container.querySelector('.user-bubble-quote');
  assert.ok(quote, '渲染引用块');
  assert.ok(
    container.querySelector('.user-bubble .user-bubble-quote'),
    '引用块在气泡内',
  );
  assert.ok(
    !container.querySelector('.user-bubble-clip .user-bubble-quote'),
    '引用块在正文折叠层之外（正文收起不裁剪引用）',
  );
  // i18n 桩返回 key 本体，断言用 key 而非中文文案
  assert.equal(
    container.querySelector('.user-bubble-quote-tag').textContent.trim(),
    'sidepanel.chat.userMessageQuoteTag',
    '引用标记可见',
  );
  assert.equal(
    container.querySelector('.user-bubble-quote-source').textContent.trim(),
    '示例文章',
    '来源显示页面标题',
  );
  assert.equal(
    container.querySelector('.user-bubble-quote-text').textContent,
    '被引用的网页原文',
    '引用原文逐字可见',
  );
  assert.equal(container.querySelectorAll('.message-content').length, 1, '正文照常渲染');
  unmount();
}

// ── G. 来源回退：标题缺失时取域名，都缺则中性文案 ──
{
  fakeContentHeight = 40;
  const noTitle = await mount(UserMessageBubble, {
    content: '正文',
    quote: { text: '原文', source: { url: 'https://docs.example.org/page', title: '' } },
  });
  assert.equal(
    noTitle.container.querySelector('.user-bubble-quote-source').textContent.trim(),
    'docs.example.org',
    '标题缺失时来源回退到主机名',
  );
  noTitle.unmount();

  const noSource = await mount(UserMessageBubble, {
    content: '正文',
    quote: { text: '原文', source: { url: '', title: '' } },
  });
  assert.equal(
    noSource.container.querySelector('.user-bubble-quote-source').textContent.trim(),
    'sidepanel.chat.userMessageQuoteSourceFallback',
    '来源全缺时回落到中性文案（key）',
  );
  noSource.unmount();
}

// ── H. 复制口径：引用原文计入；引用独存时复制不禁用 ──
{
  fakeContentHeight = 40;

  // 引用 + 正文：两段都复制（引用在前，与「这条消息实际发了什么」一致）
  clipboardWrites.length = 0;
  const both = await mount(UserMessageBubble, {
    content: '请解释这段话',
    quote: { text: '被引用的网页原文', source: { url: '', title: '' } },
  });
  click(both.container.querySelector('.user-bubble-copy'));
  await nextTick();
  await nextTick();
  assert.deepEqual(clipboardWrites, ['被引用的网页原文\n请解释这段话'], '复制 = 引用原文 + 正文');
  both.unmount();

  // 仅引用（正文为空）：气泡不渲染正文区，但复制按钮可用且复制的是引用
  clipboardWrites.length = 0;
  const quoteOnly = await mount(UserMessageBubble, {
    content: '',
    quote: { text: '被引用的网页原文', source: { url: '', title: '' } },
  });
  assert.deepEqual(quoteOnly.errors, [], '引用独存的气泡渲染不得抛错');
  assert.ok(quoteOnly.container.querySelector('.user-bubble-quote'), '引用块可见');
  assert.equal(
    quoteOnly.container.querySelectorAll('.user-bubble-body').length,
    0,
    '正文为空时不渲染正文区',
  );
  const quoteCopy = quoteOnly.container.querySelector('.user-bubble-copy');
  assert.ok(quoteCopy && !quoteCopy.disabled, '引用独存时复制按钮不禁用');
  click(quoteCopy);
  await nextTick();
  await nextTick();
  assert.deepEqual(clipboardWrites, ['被引用的网页原文'], '复制的是引用原文');
  quoteOnly.unmount();
}

// ── E. 助手消息不受影响（仍走片段渲染，无用户气泡） ──
{
  fakeContentHeight = 40;
  const { container, errors, unmount } = await mount(MessageItem, {
    message: {
      id: 'm-assistant',
      role: 'assistant',
      content: '模型回复',
      parts: [{ type: 'text', content: '模型回复' }],
      toolCalls: [],
    },
    isLive: false,
  });
  assert.deepEqual(errors, []);
  assert.equal(container.querySelectorAll('.user-bubble').length, 0, '助手消息不渲染用户气泡');
  assert.equal(container.querySelectorAll('.message-parts-stub').length, 1, '助手消息仍走片段渲染');
  unmount();
}

// ── I. 宽度链防回归（静态样式断言：JSDOM 无排版引擎，坍缩类缺陷只能在源码层兜底）──
{
  const bubbleCss = readFileSync(
    path.join(root, 'entrypoints/sidepanel/components/chat/user-message-bubble.css'),
    'utf8',
  );
  // 气泡处在 fit-content 宽度链（.message.user auto 宽 → wrapper 100% → 气泡 100%）
  // 上：任何 container-type（布局/行内尺寸容器化）都会把气泡的内在宽度贡献
  // 归零，整条链坍缩成 ~30px 细竖条（2026-11 宽度坍塌事故）。
  // 窄宽度降级必须走 @media（侧边栏文档视口 = 面板宽度）。
  assert.ok(
    !/container-type\s*:/.test(bubbleCss),
    'user-message-bubble.css 禁止 container-type（会坍塌气泡宽度）',
  );
  assert.match(
    bubbleCss,
    /@media \(max-width: 360px\)/,
    '引用块窄宽度降级走 @media 断点',
  );
}

dom.window.close();
console.log('[user-bubble] SFC 挂载渲染（超长自动收起 / 展开交互 / 复制按钮 / 用户消息接线 / 网页引用块）与宽度链防回归全部通过。');

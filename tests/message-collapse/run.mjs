/**
 * 消息折叠分组测试运行器
 *
 * 用法：node tests/message-collapse/run.mjs
 *       npm run test:message-collapse
 *
 * 两段结构：
 *   1. 纯函数断言（collapse.test.ts 经 esbuild 打包后在 Node 执行）；
 *   2. 真实 SFC 挂载（MessageParts / MessageItem 编译模板后在 JSDOM 渲染），
 *      验证模板接线：终态折叠条 / 直播小折叠条 / 展开与自动复位交互。
 * 产物写到系统临时目录，不污染仓库（对齐 message-meta 的做法）。
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
// 产物放在 node_modules/.cache（与 chat-ui 同做法）：SFC 产物 external 引用
// 的 vue 必须能从产物位置解析到项目依赖，系统临时目录下 Node 找不到包
const workDir = path.join(root, 'node_modules', '.cache', 'agentnexus-message-collapse');
mkdirSync(workDir, { recursive: true });

// ── 1. 纯函数测试 ──
for (const suite of ['collapse.test.ts', 'live-parts.test.ts', 'compaction-part.test.ts']) {
  const pureOut = path.join(workDir, suite.replace(/\.ts$/, '.mjs'));
  try {
    buildSync({
      entryPoints: [path.join(here, suite)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      alias: { '@': root },
      outfile: pureOut,
      logLevel: 'warning',
    });
  } catch (error) {
    console.error(`[message-collapse] ${suite} esbuild 打包失败:`, error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const pure = spawnSync(process.execPath, [pureOut], { stdio: 'inherit' });
  assert.equal(pure.status, 0, `${suite} 纯函数测试`);
}

// ── 2. SFC 挂载测试 ──
/**
 * 编译单个 SFC 为可执行 ESM：script setup + 模板 → 带真实 render 的组件。
 * 重依赖（i18n / markdown 渲染器 / toast）与次要子组件以同名 stub 顶替；
 * vueImports 可把指定 .vue 导入指到预构建产物（MessageItem 复用真实
 * MessageParts，保住跨组件的分组接线断言）。
 * 注意：import URL 追加自增查询串——同一 SFC 可能以不同接线编译多次
 * （如 MessageParts 在桩件版与真实 CompactionItem 版各一次），Node 的
 * ESM 缓存按 URL 键控且不感知文件覆写，不破坏缓存就会拿到旧模块。
 */
let compileSeq = 0;
async function compileComponent(file, { vueImports = {} } = {}) {
  const source = readFileSync(file, 'utf8');
  const { descriptor } = parse(source, { filename: file });
  const script = compileScript(descriptor, { id: 'msg-collapse-test', genDefaultAs: '_sfc_main' });
  const template = compileTemplate({
    source: descriptor.template.content,
    filename: file,
    id: 'msg-collapse-test',
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
    external: ['vue'],
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'heavy-dep-stubs',
        setup(api) {
          const stubFilter = /\.vue$|@\/utils\/i18n$|markdown-renderer$|note-nav$|chat\/message$/;
          api.onResolve({ filter: stubFilter }, args => {
            const normalized = args.path.replace(/\\/g, '/');
            for (const [suffix, target] of Object.entries(vueImports)) {
              if (normalized.endsWith(suffix)) return { path: target, namespace: 'file' };
            }
            return { path: args.path, namespace: 'stub' };
          });
          api.onLoad({ filter: /.*/, namespace: 'stub' }, args => {
            if (args.path === '@/utils/i18n') return { contents: 'export const t=(k)=>k;' };
            // 内联截屏容器 / 底部图片区：桩件渲染可断言的标记，
            // 用于验证「截图按发生顺序内联」与「不回退到底部图片区」
            if (args.path.endsWith('MessageImagePart.vue')) {
              return {
                contents: `import {h} from 'vue';export default {name:'MessageImagePart',props:['imageRef'],setup(p){return()=>h('div',{class:'screen-container','data-image-ref':p.imageRef});}};`,
                loader: 'js',
              };
            }
            if (args.path.endsWith('MessageImages.vue')) {
              return {
                contents: `import {h} from 'vue';export default {name:'MessageImages',props:['imageRefs'],setup(p){return()=>h('div',{class:'message-images','data-image-count':String((p.imageRefs||[]).length)});}};`,
                loader: 'js',
              };
            }
            if (args.path.endsWith('markdown-renderer')) {
              return { contents: 'export const markdownRenderer={renderMessage:(s)=>String(s)};' };
            }
            if (args.path.endsWith('note-nav')) return { contents: 'export const openNoteDetail=()=>{};' };
            if (args.path.endsWith('chat/message')) {
              return { contents: 'export const message={error(){},success(){},info(){}};' };
            }
            return { contents: 'export default { render: () => null };' };
          });
        },
      },
    ],
  });
  return import(`${pathToFileURL(outfile).href}?c=${++compileSeq}`);
}

const dom = new JSDOM('<div id="app"></div>', { url: 'https://example.test/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver']) {
  globalThis[key] = dom.window[key];
}
const { createApp, h, nextTick, reactive } = await import('vue');

/** 挂载组件：包一层响应式父组件渲染被测组件，返回的 state 就地更新即驱动重渲染
 *  （createApp 根 props 的整键替换不保证触发更新，经父组件 render 传递才可靠） */
const mount = async (component, props) => {
  const state = reactive({ ...props });
  const Parent = { setup: () => () => h(component, state) };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const app = createApp(Parent);
  const errors = [];
  app.config.errorHandler = error => errors.push(error);
  app.mount(container);
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

// ── 片段构造（携带真实内容以通过渲染层空片段过滤） ──
const textPart = content => ({ type: 'text', content });
const reasoningPart = (content = '思考过程内容') => ({ type: 'reasoning', content });
const toolPart = (id, status = 'success', executionTime) => ({
  type: 'tool',
  toolCall: { id, name: id, status, arguments: '{}', ...(executionTime === undefined ? {} : { executionTime }) },
});
const noticePart = (content = '已停止：任务已提交') => ({ type: 'notice', content });
const click = el => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

// MessageParts 先行构建，供 MessageItem 以真实子组件复用
const MessageParts = (await compileComponent(
  path.join(root, 'entrypoints/sidepanel/components/chat/MessageParts.vue'),
)).default;
const MessageItem = (await compileComponent(
  path.join(root, 'entrypoints/sidepanel/components/chat/MessageItem.vue'),
  { vueImports: { 'MessageParts.vue': path.join(workDir, 'MessageParts.mjs') } },
)).default;

// ── A. 中止：正文后残留工具 → 折叠条下方不得再出现过程内容 ──
{
  const { container, errors, unmount } = await mount(MessageItem, {
    message: {
      id: 'm-abort',
      role: 'assistant',
      content: '我来处理',
      parts: [textPart('我来处理'), toolPart('t1'), toolPart('t2')],
      toolCalls: [toolPart('t1').toolCall, toolPart('t2').toolCall],
    },
    isLive: false,
  });
  assert.deepEqual(errors, [], '中止消息渲染不得抛错');
  const prelude = container.querySelector('.answer-prelude');
  assert.ok(prelude, '中止消息必须出现前奏折叠条');
  assert.ok(prelude.classList.contains('collapsed'), '折叠条默认收起');
  const innerBar = prelude.querySelector('.cluster-bar');
  assert.ok(innerBar, '前奏内部的小折叠同样生效（两个工具收拢成簇）');
  assert.equal(prelude.querySelectorAll('.message-part').length, 1, '簇内仅最新工具保持可见');
  assert.equal(container.querySelectorAll('.message-part').length, 2, '折叠条之外仅剩末段正文');
  // 前奏内的小折叠可展开：点击后组内工具逐项渲染
  innerBar.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await nextTick();
  assert.equal(prelude.querySelectorAll('.message-part').length, 2, '展开小折叠后工具逐项渲染');
  unmount();
}

// ── B. 学习模式收尾（无正文）：折叠条独立成立，终态注记保持可见 ──
{
  const { container, errors, unmount } = await mount(MessageItem, {
    message: {
      id: 'm-learn',
      role: 'assistant',
      content: '',
      parts: [toolPart('t1'), toolPart('submit_skill'), noticePart()],
      toolCalls: [toolPart('t1').toolCall, toolPart('submit_skill').toolCall],
    },
    isLive: false,
  });
  assert.deepEqual(errors, []);
  const prelude = container.querySelector('.answer-prelude');
  assert.ok(prelude, '无正文的学习收尾同样完整折叠');
  assert.ok(prelude.querySelector('.cluster-bar'), '前奏内部两个工具收拢为小折叠');
  assert.equal(prelude.querySelectorAll('.message-part').length, 1, '簇内仅最新工具可见');
  const notice = container.querySelector('.system-notice');
  assert.ok(notice, '终态注记有渲染');
  assert.ok(!prelude.contains(notice), '注记在折叠条之外，不被折叠遮蔽');
  unmount();
}

// ── C. 中止于纯思考：折叠条单独承载（修复点：此前完全不折叠） ──
{
  const { container, errors, unmount } = await mount(MessageItem, {
    message: {
      id: 'm-reasoning',
      role: 'assistant',
      content: '',
      parts: [reasoningPart()],
      toolCalls: [],
    },
    isLive: false,
  });
  assert.deepEqual(errors, []);
  const prelude = container.querySelector('.answer-prelude');
  assert.ok(prelude, '纯思考中止也必须折叠');
  assert.equal(prelude.querySelectorAll('.message-part').length, 1);
  assert.equal(container.querySelectorAll('.message-part').length, 1, '折叠条之外无残余');
  unmount();
}

// ── D. 直播：连续 3 个工具调用 → 小折叠条 + 最新一个可见；耗时合计；点击展开；簇生长自动复位 ──
{
  const { container, errors, state, unmount } = await mount(MessageItem, {
    message: {
      id: 'm-live',
      role: 'assistant',
      content: '',
      parts: [toolPart('t1', 'success', 1500), toolPart('t2', 'error', 1000), toolPart('t3', 'pending')],
      toolCalls: [
        toolPart('t1', 'success', 1500).toolCall,
        toolPart('t2', 'error', 1000).toolCall,
        toolPart('t3', 'pending').toolCall,
      ],
    },
    isLive: true,
  });
  assert.deepEqual(errors, []);
  assert.ok(!container.querySelector('.answer-prelude'), '直播态不出现终态折叠条');
  const bar = container.querySelector('.cluster-bar');
  assert.ok(bar, '连续工具达到阈值出现小折叠条');
  assert.equal(container.querySelectorAll('.message-part').length, 1, '仅最新工具保持可见');
  assert.equal(bar.getAttribute('aria-expanded'), 'false', '收起态的 aria-expanded');
  assert.equal(bar.querySelector('.cluster-duration')?.textContent, '2.5s', '已结算工具耗时合计（未结算的 pending 不计）');
  click(bar);
  await nextTick();
  assert.equal(bar.getAttribute('aria-expanded'), 'true', '展开后 aria-expanded 同步');
  assert.equal(container.querySelectorAll('.message-part').length, 3, '展开后组内工具逐项渲染');
  // 簇生长（新工具到达）→ 版本变化自动复位收起
  state.message = {
    ...state.message,
    parts: [toolPart('t1'), toolPart('t2'), toolPart('t3'), toolPart('t4', 'pending')],
    toolCalls: [...state.message.toolCalls, toolPart('t4', 'pending').toolCall],
  };
  await nextTick();
  assert.equal(container.querySelectorAll('.message-part').length, 1, '簇生长后自动复位收起（最新工具仍可见）');
  unmount();
}

// ── E. 结束态（streaming=false）小折叠同样生效（前奏展开后内部可收拢） ──
{
  const { container, errors, unmount } = await mount(MessageParts, {
    parts: [
      { index: 0, part: toolPart('t1') },
      { index: 1, part: toolPart('t2') },
      { index: 2, part: toolPart('t3') },
    ],
    messageId: 'm-parts',
    streaming: false,
  });
  assert.deepEqual(errors, []);
  const bar = container.querySelector('.cluster-bar');
  assert.ok(bar, '结束态同样启用小折叠（不与 streaming 绑定）');
  assert.equal(container.querySelectorAll('.message-part').length, 1, '仅最新工具可见');
  unmount();
}

// ── F. 直播：思考+工具混合簇同样小折叠（任意过程形态满足条件即折叠） ──
{
  const { container, errors, unmount } = await mount(MessageParts, {
    parts: [
      { index: 0, part: reasoningPart() },
      { index: 1, part: toolPart('t1') },
      { index: 2, part: toolPart('t2') },
    ],
    messageId: 'm-mix',
    streaming: true,
  });
  assert.deepEqual(errors, []);
  const bar = container.querySelector('.cluster-bar');
  assert.ok(bar, '思考+工具混合簇出现小折叠条');
  assert.equal(container.querySelectorAll('.message-part').length, 1, '仅最新工具可见');
  const summary = bar.querySelector('.cluster-summary').textContent;
  assert.ok(summary.includes('sidepanel.chat.clusterReasoning'), '摘要包含思考计数文案');
  assert.ok(summary.includes('sidepanel.chat.preludeTools'), '摘要包含工具计数文案');
  unmount();
}

// ── G. 旧记录兼容：仅有 reasoning_content、无片段正文 → 折叠条并入旧思考 ──
{
  const { container, errors, unmount } = await mount(MessageItem, {
    message: {
      id: 'm-legacy',
      role: 'assistant',
      content: '',
      reasoning_content: '旧版思考内容',
      parts: [noticePart()],
      toolCalls: [],
      _reasoningContentCollapsed: true,
    },
    isLive: false,
  });
  assert.deepEqual(errors, []);
  const prelude = container.querySelector('.answer-prelude');
  assert.ok(prelude, '旧版 reasoning_content 同样驱动折叠条（不依赖正文存在）');
  assert.ok(prelude.querySelector('.prelude-legacy-reasoning'), '旧思考并入折叠条内部');
  const notice = container.querySelector('.system-notice');
  assert.ok(notice && !prelude.contains(notice), '注记仍在折叠条之外');
  unmount();
}

// ── H. 畸形输入防御：parts 非数组不拖垮渲染 ──
{
  const { container, errors, unmount } = await mount(MessageParts, {
    parts: null,
    messageId: 'm-bad',
    streaming: true,
  });
  assert.deepEqual(errors, [], 'parts 非数组时安静收敛为空渲染');
  assert.equal(container.querySelectorAll('.message-part').length, 0);
  assert.equal(container.querySelectorAll('.cluster-bar').length, 0);
  unmount();
}

// ── I. 截屏片段：按发生顺序内联，且不回退到底部图片区（修复点） ──
{
  const imagePart = ref => ({ type: 'image', imageRef: ref });
  const { container, errors, unmount } = await mount(MessageItem, {
    message: {
      id: 'm-vision',
      role: 'assistant',
      content: '我来点击',
      parts: [imagePart('ref-1'), textPart('我来点击'), toolPart('t1'), imagePart('ref-2')],
      toolCalls: [toolPart('t1').toolCall],
      imageRefs: ['ref-1', 'ref-2'],
    },
    isLive: true,
  });
  assert.deepEqual(errors, []);
  const screens = [...container.querySelectorAll('.screen-container')];
  assert.deepEqual(
    screens.map(el => el.getAttribute('data-image-ref')),
    ['ref-1', 'ref-2'],
    '两次截屏按发生顺序内联在片段流中',
  );
  assert.equal(
    container.querySelectorAll('.message-images').length,
    0,
    '内联截屏存在时不得回退到底部图片区（截图不再挂在消息最后）',
  );
  unmount();
}

// ── J. 旧记录兜底：有引用但无截图片段 → 底部图片区保留展示入口 ──
{
  const { container, errors, unmount } = await mount(MessageItem, {
    message: {
      id: 'm-legacy-image',
      role: 'assistant',
      content: '旧记录',
      parts: [textPart('旧记录')],
      toolCalls: [],
      imageRefs: ['ref-1'],
    },
    isLive: false,
  });
  assert.deepEqual(errors, []);
  const gallery = container.querySelector('.message-images');
  assert.ok(gallery, '旧记录（截图早于内联部件形态）保留底部图片区兜底');
  assert.equal(gallery.getAttribute('data-image-count'), '1');
  unmount();
}

// ── K. 压缩片段渲染（CompactionItem，真实组件经 MessageParts 接线）──
// 验证：pending 旋转行不可交互；success 行呈现 token 收益并可展开摘要全文；
// error 行呈现行内错误；连续压缩按过程簇收拢（摘要含压缩计数）。
// 展开事件经 MessageParts → toggle-compaction-collapse 契约回传
// （partIndex 定位原始下标），父级翻转 expanded 后详情区渲染。
{
  // 先行构建真实 CompactionItem，MessageParts 以真实子组件复用
  const CompactionItem = (await compileComponent(
    path.join(root, 'entrypoints/sidepanel/components/chat/CompactionItem.vue'),
  )).default;
  const MessagePartsReal = (await compileComponent(
    path.join(root, 'entrypoints/sidepanel/components/chat/MessageParts.vue'),
    { vueImports: { 'CompactionItem.vue': path.join(workDir, 'CompactionItem.mjs') } },
  )).default;

  const compactionPart = state => ({ type: 'compaction', compaction: state });
  // 三种状态用正文断片隔开：各自单行可见（不进簇），逐行断言状态语义
  const base = {
    parts: [
      { index: 0, part: compactionPart({ status: 'pending', trigger: 'runtime', originalTokens: 147968 }) },
      { index: 1, part: textPart('收到，正在整理') },
      { index: 2, part: compactionPart({ status: 'success', trigger: 'runtime', originalTokens: 147968, summaryTokens: 2560, summary: '<summary><task>分析页面结构</task></summary>', durationMs: 8500 }) },
      { index: 3, part: textPart('压缩完成，继续执行') },
      { index: 4, part: compactionPart({ status: 'error', trigger: 'runtime', error: '压缩请求失败: 连接超时', durationMs: 1200 }) },
    ],
    messageId: 'm-compaction',
    streaming: true,
  };
  const { container, errors, state, unmount } = await mount(MessagePartsReal, base);
  assert.deepEqual(errors, [], '压缩片段渲染不得抛错');
  const rows = [...container.querySelectorAll('.compaction-row')];
  assert.equal(rows.length, 3, '三段压缩各占一行（正文断片隔离，不进簇）');
  assert.ok(rows[0].classList.contains('pending') && rows[1].classList.contains('success') && rows[2].classList.contains('error'), '状态类名挂载');
  assert.ok(rows[0].querySelector('.tool-row-main').hasAttribute('disabled'), 'pending 行不可交互');
  // success 行右侧压缩收益（K = 1024 口径）与耗时
  const tokensLabel = rows[1].querySelector('.compaction-tokens')?.textContent;
  assert.ok(tokensLabel.includes('144.5K') && tokensLabel.includes('2.5K'), `token 收益标签: ${tokensLabel}`);
  assert.equal(rows[1].querySelector('.tool-time')?.textContent, '8.5s', '耗时标签');
  // error 行内错误摘要
  assert.ok(rows[2].querySelector('.tool-error-inline')?.textContent.includes('压缩请求失败'), '行内错误摘要');
  // 展开契约：点击 success 行 → toggle-compaction-collapse 事件回传原始下标；
  // 父级（此处为测试宿主）翻转 expanded 后详情区渲染摘要全文
  let toggled = null;
  state.onToggleCompactionCollapse = (messageId, partIndex) => { toggled = { messageId, partIndex }; };
  await nextTick();
  rows[1].querySelector('.tool-row-main').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(toggled, { messageId: 'm-compaction', partIndex: 2 }, '展开事件携带 messageId 与原始下标');
  state.parts = base.parts.map((entry, i) => i === 2
    ? { index: 2, part: compactionPart({ status: 'success', trigger: 'runtime', summary: '<summary><task>分析页面结构</task></summary>', expanded: true }) }
    : entry);
  await nextTick();
  const detail = container.querySelector('.compaction-row.success .tool-detail pre');
  assert.ok(detail && detail.textContent.includes('<task>分析页面结构'), '展开后渲染摘要全文');
  unmount();

  // 连续压缩（无断片）按过程簇收拢：摘要条出现且计数文案为压缩
  {
    const { container: c2, errors: e2, unmount: u2 } = await mount(MessagePartsReal, {
      parts: [
        { index: 0, part: compactionPart({ status: 'success', trigger: 'runtime', originalTokens: 1000, summaryTokens: 100 }) },
        { index: 1, part: compactionPart({ status: 'pending', trigger: 'runtime' }) },
      ],
      messageId: 'm-compaction-cluster',
      streaming: true,
    });
    assert.deepEqual(e2, []);
    const bar = c2.querySelector('.cluster-bar');
    assert.ok(bar, '连续压缩成簇出现摘要条');
    assert.ok(bar.textContent.includes('sidepanel.chat.clusterCompactions'), '摘要条计数为压缩计数');
    assert.equal(c2.querySelectorAll('.compaction-row').length, 1, '仅最新压缩条外可见');
    u2();
  }
}

dom.window.close();
console.log('[message-collapse] SFC 挂载渲染（终态折叠条 / 直播小折叠 / 展开交互 / 截屏按序内联 / 压缩片段 / 旧记录与畸形输入防御）全部通过。');

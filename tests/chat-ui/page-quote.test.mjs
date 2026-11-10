/**
 * 网页引用条回归测试（待引用 / 已引用两态 + 引用信封 + 正文拼装顺序）
 *
 * 覆盖三类契约：
 *   1. 组件结构与意图透传（真实编译产物挂载，JSDOM 断言 DOM）：
 *      - 待引用态：标签「待引用:」+ 确认引用主行动 + 放弃图标按钮
 *      - 已引用态：标签「已引用:」+ 取消引用次行动（无确认 / 无放弃）
 *      - 来源标题存在时渲染；点击分别 emit confirm / discard / cancel
 *   2. 引用信封（纯函数）：<page_quote> 结构、XML 转义、超长截断、空正文
 *   3. 正文拼装顺序（纯函数）：用户输入 → 引用信封 → 附件信封；
 *      无引用信封时与既有实现逐字一致（缓存前缀稳定）
 *
 * 运行：node tests/chat-ui/page-quote.test.mjs   （或 npm run test:chat-ui）
 */

import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = process.cwd();

// ── 1. 纯函数模块（引用信封 + 正文拼装）─────────────────────────────
const domainOut = path.resolve('node_modules/.cache/page-quote-domain.mjs');
mkdirSync(path.dirname(domainOut), { recursive: true });
await build({
  stdin: {
    contents:
      "export * from './entrypoints/sidepanel/utils/chat/page-quote.ts';" +
      "export { composeUserMessageBody } from './entrypoints/sidepanel/utils/chat/llm-message-body.ts';" +
      "export { readSelectedText, getDeepActiveElement } from './utils/selection/read-selection.ts';",
    loader: 'ts',
    resolveDir: root,
  },
  outfile: domainOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'warning',
});
const domain = await import(pathToFileURL(domainOut).href);
const {
  buildPageQuoteEnvelope,
  normalizePageQuoteSource,
  normalizeQuoteText,
  pageQuoteSourceDisplay,
  PAGE_QUOTE_MAX_CHARS,
  composeUserMessageBody,
  readSelectedText,
  getDeepActiveElement,
} = domain;
// —— 2. 引用信封：结构与转义 ——
{
  const envelope = buildPageQuoteEnvelope({
    text: '  正文 <b>&amp;</b>  ',
    source: { url: 'https://example.com/a?x=1&y=2', title: '标题 <T>' },
  });
  assert.ok(envelope.startsWith('<page_quote>\n'), '信封以 <page_quote> 开头');
  assert.ok(envelope.trimEnd().endsWith('</page_quote>'), '信封以 </page_quote> 结尾');
  assert.ok(
    envelope.includes('<source_url>https://example.com/a?x=1&amp;y=2</source_url>'),
    'URL 中的 & 被转义',
  );
  assert.ok(
    envelope.includes('<source_title>标题 &lt;T&gt;</source_title>'),
    '标题中的尖括号被转义',
  );
  assert.ok(
    envelope.includes('<quote_text>正文 &lt;b&gt;&amp;amp;&lt;/b&gt;</quote_text>'),
    '正文去首尾空白并转义',
  );
  assert.equal(
    buildPageQuoteEnvelope({ text: '   ', source: { url: '', title: '' } }),
    '',
    '空正文不产出信封',
  );
}

// —— 2b. 超长选区：截断并留痕（不让一条长选区挤爆上下文预算）——
{
  const long = 'A'.repeat(PAGE_QUOTE_MAX_CHARS + 500);
  const normalized = normalizeQuoteText(long);
  assert.ok(
    normalized.startsWith('A'.repeat(PAGE_QUOTE_MAX_CHARS)),
    '正文按上限截断',
  );
  assert.ok(normalized.length > PAGE_QUOTE_MAX_CHARS, '截断后追加截断标记');
  assert.ok(normalized.includes('截断'), '截断标记明示正文不完整');
}

// —— 2c. 来源归一：缺失字段退化为空串（不出现 undefined 字面量）——
{
  const source = normalizePageQuoteSource(undefined, null);
  assert.equal(source.url, '', '缺失 URL → 空串');
  assert.equal(source.title, '', '缺失标题 → 空串');
}

// —— 2d. 来源展示口径：标题 → 主机名 → 空串（展示层再回落中性文案）——
{
  const withTitle = { text: 'x', source: { url: 'https://a.example/path', title: ' 页面标题 ' } };
  assert.equal(pageQuoteSourceDisplay(withTitle), '页面标题', '标题优先（去首尾空白）');
  const noTitle = { text: 'x', source: { url: 'https://docs.example.org/p?x=1', title: '' } };
  assert.equal(pageQuoteSourceDisplay(noTitle), 'docs.example.org', '标题缺失取主机名（不带路径/查询）');
  const nothing = { text: 'x', source: { url: 'not-a-url', title: '' } };
  assert.equal(pageQuoteSourceDisplay(nothing), 'not-a-url', '非法 URL 原样返回');
  const empty = { text: 'x', source: { url: '', title: '  ' } };
  assert.equal(pageQuoteSourceDisplay(empty), '', '全缺 → 空串');
}

// —— 3. 正文拼装顺序：用户输入 → 引用信封 → 附件信封 ——
{
  assert.equal(
    composeUserMessageBody('Q', '', 'A'),
    'Q\n\nA',
    '无引用信封时与既有实现逐字一致',
  );
  assert.equal(
    composeUserMessageBody('Q', '<page_quote>X</page_quote>', 'A'),
    'Q\n\n<page_quote>X</page_quote>\n\nA',
    '引用信封夹在用户正文与附件信封之间',
  );
  assert.equal(
    composeUserMessageBody('Q', '<page_quote>X</page_quote>', ''),
    'Q\n\n<page_quote>X</page_quote>',
    '无附件信封时引用信封仍在用户正文之后',
  );
  assert.equal(
    composeUserMessageBody('', '<page_quote>X</page_quote>', ''),
    '<page_quote>X</page_quote>',
    '仅引用无正文时不产生前导空行',
  );
}

// ── 4. 组件（真实编译产物挂载）───────────────────────────────────────
const file = path.resolve('entrypoints/sidepanel/components/chat/PageQuoteBar.vue');
const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file });
const script = compileScript(descriptor, { id: 'page-quote-regression', inlineTemplate: true });
const outfile = path.resolve('node_modules/.cache/page-quote-bar-regression.mjs');
mkdirSync(path.dirname(outfile), { recursive: true });
await build({
  stdin: {
    contents: script.content + "\nexport { t, setLocale } from '@/utils/i18n';",
    loader: 'ts',
    resolveDir: path.dirname(file),
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
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

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://extension.test/sidepanel.html',
  pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'HTMLInputElement', 'HTMLTextAreaElement']) {
  globalThis[key] = dom.window[key];
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);

const { createApp, h, reactive, nextTick } = await import('vue');
const { default: PageQuoteBar, t, setLocale } = await import(pathToFileURL(outfile).href);
setLocale('zh-CN');

async function mountBar(props) {
  const events = [];
  const state = reactive({ ...props });
  const app = createApp({
    setup: () => () =>
      h(PageQuoteBar, {
        ...state,
        onConfirm: () => events.push('confirm'),
        onCancel: () => events.push('cancel'),
        onDiscard: () => events.push('discard'),
      }),
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const vm = app.mount(host);
  await nextTick();
  return { state, events, el: vm.$el, unmount: () => { app.unmount(); host.remove(); } };
}

// —— 4a. 待引用态：标签 + 确认引用主行动 + 放弃图标按钮 ——
{
  const { el, events, unmount } = await mountBar({
    state: 'pending',
    text: '这是一段被选中的网页原文',
    sourceTitle: '示例页面',
    sourceUrl: 'https://example.com/a',
  });
  assert.ok(el.classList.contains('page-quote-bar'), '根节点为引用条');
  assert.ok(el.classList.contains('is-pending'), '待引用态带 is-pending 修饰类');
  assert.equal(
    el.querySelector('.pq-label').textContent,
    t('sidepanel.app.pendingQuoteLabel'),
    '标签为「待引用:」',
  );
  assert.equal(el.querySelector('.pq-text').textContent, '这是一段被选中的网页原文', '原文可见');
  assert.equal(el.querySelector('.pq-text').getAttribute('title'), '这是一段被选中的网页原文', '原文带完整提示');
  assert.equal(el.querySelector('.pq-source').textContent, '示例页面', '来源标题可见');

  const confirmBtn = el.querySelector('.pq-btn-confirm');
  const ghostBtn = el.querySelector('.pq-btn-ghost');
  assert.ok(confirmBtn, '存在确认引用按钮');
  assert.ok(ghostBtn, '存在放弃按钮');
  assert.ok(!el.querySelector('.pq-btn-cancel'), '待引用态没有取消引用按钮');
  assert.equal(confirmBtn.textContent.trim(), '确认引用', '主行动按钮文案');

  confirmBtn.click();
  ghostBtn.click();
  assert.deepEqual(events, ['confirm', 'discard'], '点击分别 emit confirm / discard');
  unmount();
}

// —— 4b. 已引用态：标签 + 取消引用次行动（无确认 / 无放弃）——
{
  const { el, events, unmount } = await mountBar({
    state: 'confirmed',
    text: '已确认的原文',
    sourceTitle: '',
    sourceUrl: '',
  });
  assert.ok(el.classList.contains('is-confirmed'), '已引用态带 is-confirmed 修饰类');
  assert.equal(
    el.querySelector('.pq-label').textContent,
    t('sidepanel.app.confirmedQuoteLabel'),
    '标签为「已引用:」',
  );
  assert.equal(el.querySelector('.pq-text').textContent, '已确认的原文', '原文固定可见');
  assert.ok(!el.querySelector('.pq-source'), '无来源标题时不渲染来源节点');

  const cancelBtn = el.querySelector('.pq-btn-cancel');
  assert.ok(cancelBtn, '存在取消引用按钮');
  assert.ok(!el.querySelector('.pq-btn-confirm'), '已引用态没有确认按钮');
  assert.ok(!el.querySelector('.pq-btn-ghost'), '已引用态没有放弃按钮');
  assert.equal(cancelBtn.textContent.trim(), '取消引用', '次行动按钮文案');

  cancelBtn.click();
  assert.deepEqual(events, ['cancel'], '点击 emit cancel');
  unmount();
}

// —— 5. 样式契约（静态断言：JSDOM 不做布局，宽度适配靠样式表本身保证）——
{
  const css = readFileSync(
    path.resolve('entrypoints/sidepanel/components/chat/page-quote-bar.css'),
    'utf8',
  );
  // 降级链三档（来源标题 → 按钮文字 → 整条换行）都在
  for (const bp of ['340px', '260px', '200px']) {
    assert.ok(css.includes(`@container (max-width: ${bp})`), `容器查询断点 ${bp} 存在`);
  }
  // 溢出防线：原文三行封顶 + 块内滚动 + 操作区不被压缩 + 容器自身裁剪
  assert.match(css, /\.pq-text\s*\{[^}]*max-height:\s*calc\(3 \* 1\.45em\)/, '原文最多三行（行高 1.45 × 3）');
  assert.match(css, /\.pq-text\s*\{[^}]*overflow-y:\s*auto/, '超出三行出现滚动条（块内滚动）');
  assert.match(css, /\.pq-text\s*\{[^}]*white-space:\s*pre-wrap/, '多行选区保留换行');
  assert.match(css, /\.pq-text\s*\{[^}]*min-width:\s*0/, '原文允许收缩到 0（不撑破容器）');
  assert.match(css, /\.pq-actions\s*\{[^}]*flex:\s*0 0 auto/, '操作区不被压缩');
  assert.match(css, /\.page-quote-bar\s*\{[^}]*overflow:\s*hidden/, '引用条自身裁剪溢出');
  // 窄宽度降级动作确实存在
  assert.match(css, /\.pq-source\s*\{[^}]*display:\s*none/, '窄宽度隐藏来源标题');
  assert.match(css, /\.pq-btn-text\s*\{[^}]*display:\s*none/, '窄宽度按钮收为纯图标');
}

// ── 6. 选区读取（content script 四通道事件共用的单一事实源）──
{
  const doc = dom.window.document;

  // 6a. 表单控件：input 选区走 selectionStart/End 切片（getSelection 对其恒空）
  const input = doc.createElement('input');
  doc.body.appendChild(input);
  input.value = 'hello world';
  input.focus();
  input.setSelectionRange(0, 5);
  assert.equal(readSelectedText(), 'hello', 'input 选区走切片读取');
  input.setSelectionRange(0, 0);
  assert.equal(readSelectedText(), '', 'input 无选区 → 回落文档选区（此处为空）');
  input.blur();
  input.remove();

  // 6b. open Shadow DOM 内的 textarea：document.activeElement 宿主重定向 → 下钻
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<textarea>shadow inner text</textarea>';
  const textarea = shadow.querySelector('textarea');
  textarea.focus();
  textarea.setSelectionRange(7, 12);
  assert.equal(getDeepActiveElement(), textarea, '深层 activeElement 穿透 open shadow');
  assert.equal(readSelectedText(), 'inner', 'shadow 内表单选区可读（下钻 + 切片）');
  textarea.blur();
  host.remove();

  // 6c. 文档选区直读（普通 DOM 正文的 Selection.toString 路径）
  const para = doc.createElement('div');
  para.textContent = 'hello world text';
  doc.body.appendChild(para);
  const range = doc.createRange();
  range.setStart(para.firstChild, 0);
  range.setEnd(para.firstChild, 5);
  const selection = doc.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  assert.equal(readSelectedText(), 'hello', '文档选区 Selection.toString 直读');

  // 6d. 序列化缺口兜底：toString 返回空串但 rangeCount > 0（Shadow DOM 跨根
  // 选区在真实浏览器里的缺口形态）→ Range 级克隆收集仍能拿到原文
  const nativeToString = selection.toString;
  selection.toString = () => '';
  assert.equal(readSelectedText(), 'hello', 'toString 空串时 Range 克隆兜底生效');
  selection.toString = nativeToString;

  // 6e. 空选区：直读与兜底都不产出内容（光标态不误报）
  selection.removeAllRanges();
  assert.equal(readSelectedText(), '', '无选区 → 空串');
  para.remove();
}

console.log('[chat-ui] Page quote bar (pending/confirmed), envelope escaping/truncation, message body ordering, responsive style contract and selection reader passed.');
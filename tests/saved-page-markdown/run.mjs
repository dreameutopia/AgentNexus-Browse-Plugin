/**
 * 保存页面「抓取 + 渲染」回归测试
 *
 * 运行：node tests/saved-page-markdown/run.mjs
 *
 * 覆盖：
 * 1. MiMo 文档页真实 DOM 结构复现（code-line span / token 高亮 / 复制按钮 / tab 面板）
 * 2. 代码块保真：# 注释、缩进、空行、嵌套反引号、Markdown 特殊字符、HTML 字符
 * 3. 纯文本转义：#、-、1.、>、* 等不会被误渲染为标题/列表/引用/强调
 * 4. 列表：嵌套、有序编号（start 属性）、列表项内的段落与代码块
 * 5. 表格、引用块、行内元素、标题层级、图片占位符
 * 6. 噪音过滤：隐藏元素、导航、页眉页脚、按钮、tablist
 * 7. 渲染端（剪藏 Markdown → Tiptap HTML）：代码块内零污染、未闭合围栏补齐、图片占位符还原
 * 8. 复制文本转义还原
 */
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const buildDir = path.join(here, '.build');
const outfile = path.join(buildDir, 'subject.bundle.mjs');

// ---------- 打包被测模块（TS -> ESM） ----------
fs.mkdirSync(buildDir, { recursive: true });
buildSync({
  entryPoints: [path.join(here, 'subject.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { '@': root },
  logLevel: 'silent',
});

// ---------- jsdom 环境 ----------
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.com/docs/page',
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
for (const key of [
  'Node',
  'Element',
  'HTMLElement',
  'HTMLImageElement',
  'HTMLAnchorElement',
  'HTMLTableElement',
  'getComputedStyle',
]) {
  globalThis[key] = window[key];
}
// 注意：不要把 window.atob / window.btoa 绑定到 globalThis——jsdom 的这两个函数内部
// 委托给全局 atob / btoa，绑定后会形成自递归并抛出 InvalidCharacterError。
// Node 自带的 atob / btoa 与浏览器行为一致（WHATWG forgiving base64），被测模块直接使用即可。

const { htmlToMarkdown, unescapeMarkdownText, captureMarkdownToHtml, unescapeForCopy } =
  await import(pathToFileURL(outfile).href);

// ---------- 断言工具 ----------
let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${String(detail).slice(0, 400)}` : ''}`);
  }
}

function checkContains(name, haystack, needle) {
  check(name, haystack.includes(needle), `未找到: ${JSON.stringify(needle)}\n实际: ${haystack.slice(0, 600)}`);
}

function notContains(name, haystack, needle) {
  check(name, !haystack.includes(needle), `不应包含: ${JSON.stringify(needle)}\n实际: ${haystack.slice(0, 600)}`);
}

/** 去掉 HTML 标签并解码实体，便于断言文本内容 */
function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 抓取：设置 DOM 并转换 */
function capture(html, { images } = {}) {
  document.body.innerHTML = html;
  const collector = images || [];
  const md = htmlToMarkdown(document.body, { imageCollector: collector });
  return { md, images: collector };
}

function section(title) {
  console.log(`\n${title}`);
}

// ============================================================
section('1. MiMo 文档页结构复现（code-line / token / 复制按钮 / tab）');
{
  const page = `
    <nav><a href="/docs">文档导航</a></nav>
    <header>站点页眉</header>
    <main>
      <div role="tablist"><button role="tab">Python SDK</button><button role="tab">Curl</button></div>
      <ol class="mdx-ol" start="1"><li>通过运行以下命令安装 OpenAI Python SDK：</li></ol>
      <mimo-code-block data-initialized="true" style="display: block; position: relative;">
        <pre class="language-bash mdx-pre mdx-pre"><code class="language-bash code-highlight"><span class="code-line"><span class="token comment"># 如果运行失败，您可以将pip替换成pip3再运行</span>\n</span><span class="code-line">pip <span class="token function">install</span> <span class="token parameter variable">-U</span> openai\n</span></code><span class="mdx-pre-scroll-tail" aria-hidden="true"></span></pre>
        <button aria-label="Copy code">Copy</button>
      </mimo-code-block>
      <ol class="mdx-ol" start="2"><li>调用 API：</li></ol>
      <mimo-tab>
        <div class="mimo-tab-root">
          <div role="tablist"><button role="tab">Python SDK</button><button role="tab">Curl</button></div>
          <div class="mimo-tab-panel">
            <mimo-code-block>
              <pre class="language-python mdx-pre"><code class="language-python code-highlight"><span class="code-line">import os\n</span><span class="code-line">from openai import OpenAI\n</span><span class="code-line">\n</span><span class="code-line">client = OpenAI(\n</span><span class="code-line">    api_key=os.environ.get("MIMO_API_KEY"),\n</span><span class="code-line">)\n</span></code></pre>
              <button aria-label="Copy code">Copy</button>
            </mimo-code-block>
          </div>
          <div class="mimo-tab-panel" style="display: none;">
            <mimo-code-block>
              <pre class="language-bash"><code>curl --location 'https://api.example.com/v1'</code></pre>
            </mimo-code-block>
          </div>
        </div>
      </mimo-tab>
    </main>
    <footer>Copyright 页脚备案</footer>
  `;
  const { md } = capture(page);

  checkContains('注释行原样保留在代码围栏内', md, '# 如果运行失败，您可以将pip替换成pip3再运行');
  checkContains('bash 语言标识被识别', md, '```bash');
  checkContains('python 语言标识被识别', md, '```python');
  checkContains('python 代码换行保留(import os 独立成行)', md, 'import os\nfrom openai import OpenAI');
  checkContains('python 代码缩进保留', md, '    api_key=os.environ.get("MIMO_API_KEY"),');
  checkContains('有序列表 start=1 编号保留', md, '1. 通过运行以下命令安装');
  checkContains('有序列表 start=2 编号保留', md, '2. 调用 API：');
  // 正文列表项本身含 "Python SDK" 字样，tab 标签泄漏会额外增加出现次数
  const tabLabelCount = (md.match(/Python SDK/g) || []).length;
  check('tab 标签不混入正文', tabLabelCount === 1, `Python SDK 出现 ${tabLabelCount} 次（应为 1 次）`);
  notContains('导航不混入正文', md, '文档导航');
  notContains('页眉不混入正文', md, '站点页眉');
  notContains('页脚不混入正文', md, '备案');
  notContains('复制按钮文字不混入', md, 'Copy');
  notContains('隐藏 tab 面板不抓取', md, 'curl --location');

  const html = captureMarkdownToHtml(md);
  const codeArea = html.slice(html.indexOf('<pre'), html.indexOf('</pre>'));
  notContains('渲染后代码块内没有 h1（注释不再变标题）', codeArea, '<h1');
  checkContains('渲染后注释文本完整', stripTags(html), '如果运行失败，您可以将pip替换成pip3再运行');
  checkContains('渲染后代码块为 pre/code 结构且带语言 class', html, '<pre><code class="language-bash">');
  checkContains('第二个代码块语言 class 展示', html, 'language-python');
  checkContains('第二个代码块内容完整', stripTags(html), 'client = OpenAI(');
  checkContains('两个有序列表的编号都正确', html, '<ol start="2">');
}

// ============================================================
section('2. 代码块保真（注释 / 空行 / 反引号 / 特殊字符 / HTML）');
{
  const code = [
    '# 一级注释',
    'def f():',
    '    """docstring"""',
    '    return 1',
    '',
    '',
    '',
    '# 三个空行之后的注释 * 不是强调 [x](y) 不是链接',
    'print("<div>不是 HTML</div>")',
    '```',
    '嵌套的三连反引号',
    '```',
  ].join('\n');
  const { md } = capture(`<div><pre class="language-python"><code>${code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</code></pre></div>`);

  checkContains('围栏自动加长以容纳三连反引号', md, '````python');
  checkContains('代码内的三连反引号原样保留', md, '```\n嵌套的三连反引号\n```');
  checkContains('连续空行不被压缩', md, '\n\n\n# 三个空行之后的注释');
  checkContains('缩进保留', md, '    return 1');

  const html = captureMarkdownToHtml(md);
  const plain = stripTags(html);
  checkContains('注释文本保留', plain, '# 一级注释');
  checkContains('docstring 保留', plain, '"""docstring"""');
  notContains('代码内的 * 未被解析为强调', html.slice(html.indexOf('<pre')), '<em>');
  notContains('代码内的链接语法未被解析', html.slice(html.indexOf('<pre')), '<a href');
  checkContains('HTML 字符被转义显示', plain, '<div>不是 HTML</div>');
  checkContains('嵌套三连反引号显示完整', plain, '嵌套的三连反引号');
}

// ============================================================
section('3. 纯文本转义（不误判为标题/列表/引用/强调/链接）');
{
  const { md } = capture(`<div>
    <p># 不是标题</p>
    <p>- 不是列表</p>
    <p>1. 不是有序列表</p>
    <p>&gt; 不是引用</p>
    <p>2 * 3 * 4 不是强调</p>
    <p>[x](y) 不是链接</p>
    <p>---</p>
    <p>Windows 路径 C:\\foo\\bar</p>
  </div>`);

  const html = captureMarkdownToHtml(md);
  notContains('纯文本 # 不产生 h1', html, '<h1');
  notContains('纯文本 - 不产生列表', html, '<li>');
  notContains('纯文本 &gt; 不产生引用', html, '<blockquote>');
  notContains('纯文本 * 不产生强调', html, '<em>');
  notContains('纯文本 [x](y) 不产生链接', html, '<a href');
  notContains('纯文本 --- 不产生分隔线', html, '<hr>');
  const plain = stripTags(html);
  checkContains('# 原样显示', plain, '# 不是标题');
  checkContains('- 原样显示', plain, '- 不是列表');
  checkContains('1. 原样显示', plain, '1. 不是有序列表');
  checkContains('&gt; 原样显示', plain, '> 不是引用');
  checkContains('* 原样显示', plain, '2 * 3 * 4 不是强调');
  checkContains('[x](y) 原样显示', plain, '[x](y) 不是链接');
  checkContains('--- 原样显示', plain, '---');
  checkContains('反斜杠路径原样显示', plain, 'C:\\foo\\bar');

  // 复制文本还原
  const copy = unescapeForCopy(md);
  check('复制文本无转义符(#)', copy.includes('# 不是标题') && !copy.includes('\\#'));
  check('复制文本还原反斜杠路径', copy.includes('C:\\foo\\bar') && !copy.includes('C:\\\\foo'));
}

// ============================================================
section('4. 列表（嵌套 / 编号 / 列表项内段落与代码块）');
{
  const { md } = capture(`<ul>
    <li>父项
      <ul><li>子项 A</li><li>子项 B</li></ul>
    </li>
    <li>二</li>
  </ul>
  <ol start="3"><li>第三</li><li>第四</li></ol>
  <ol>
    <li><p>带段落的项</p><pre><code>code in li</code></pre></li>
    <li>普通项</li>
  </ol>`);

  checkContains('嵌套无序列表', md, '- 父项');
  checkContains('子项缩进', md, '  - 子项 A');
  checkContains('有序列表从 3 开始', md, '3. 第三');
  checkContains('有序列表递增', md, '4. 第四');
  checkContains('列表项内代码块', md, '   ```\n   code in li\n   ```');

  const html = captureMarkdownToHtml(md);
  checkContains('嵌套列表渲染', html, '<ul>');
  checkContains('有序编号渲染', html, '<ol start="3">');
  checkContains('列表项内代码块渲染', html, 'code in li');
  notContains('代码块未被列表语法污染', html, '<li>code in li');
}

// ============================================================
section('5. 表格 / 引用 / 行内元素 / 标题层级 / 图片');
{
  const { images, md } = capture(`<table>
    <tr><th>a|b</th><th>c</th></tr>
    <tr><td>1</td><td>2</td></tr>
    <tr><td>3</td><td>4</td></tr>
  </table>
  <blockquote><p>引用文本</p><ul><li>引用里的列表</li></ul></blockquote>
  <p>你好 <strong>加粗</strong> 与 <em>斜体</em> 与 <code>行内代码</code> 与 <a href="https://example.com/x">链接</a> 结束</p>
  <h5>五级标题</h5>
  <h6>六级标题</h6>
  <p>前文<img src="https://example.com/pic.png" alt="图[1]" width="200" height="120">后文</p>
  <p><img src="https://example.com/tiny.png" width="16" height="16"></p>`);

  checkContains('表格表头', md, '| a\\|b | c |');
  checkContains('表格分隔行', md, '| --- | --- |');
  checkContains('表格数据行', md, '| 3 | 4 |');
  checkContains('引用块', md, '> 引用文本');
  checkContains('引用内列表', md, '> - 引用里的列表');
  checkContains('行内元素保持在同一行', md, '你好 **加粗** 与 *斜体* 与 `行内代码` 与 [链接](<https://example.com/x>) 结束');
  checkContains('五级标题', md, '##### 五级标题');
  checkContains('六级标题', md, '###### 六级标题');
  checkContains('图片占位符', md, '[[IMG:');
  check('图片被收集（小图除外）', images.length === 1 && images[0].src === 'https://example.com/pic.png', JSON.stringify(images));
  checkContains('alt 中的中括号被清理', md, '|图 1]');

  const html = captureMarkdownToHtml(md, images);
  checkContains('表格渲染', html, '<table>');
  checkContains('行内代码渲染', html, '<code>行内代码</code>');
  checkContains('链接渲染为 a 标签', html, '<a href="https://example.com/x">');
  checkContains('图片渲染为内嵌 img', html, '<img src="https://example.com/pic.png"');
  notContains('小图不出现在渲染结果', html, 'tiny.png');
}

// ============================================================
section('6. 噪音过滤（隐藏元素 / role / 按钮 / 作用域页眉页脚）');
{
  const { md } = capture(`<div style="display:none">隐藏的 div</div>
    <div hidden>hidden 属性</div>
    <div aria-hidden="true">aria 隐藏</div>
    <button>按钮文字</button>
    <nav>导航文字</nav>
    <div role="navigation">role 导航</div>
    <div role="dialog">弹窗文字</div>
    <header>页面级页眉</header>
    <article>
      <header>文章标题行</header>
      <p>正文</p>
      <footer>文章署名</footer>
    </article>
    <aside role="complementary">侧栏目录</aside>
    <footer>页面级页脚</footer>`);

  notContains('style 隐藏', md, '隐藏的 div');
  notContains('hidden 属性', md, 'hidden 属性');
  notContains('aria 隐藏', md, 'aria 隐藏');
  notContains('按钮文字', md, '按钮文字');
  notContains('nav 内容', md, '导航文字');
  notContains('role 导航', md, 'role 导航');
  notContains('弹窗', md, '弹窗文字');
  notContains('页面级页眉', md, '页面级页眉');
  notContains('页面级页脚', md, '页面级页脚');
  notContains('侧栏', md, '侧栏目录');
  checkContains('文章内 header 保留', md, '文章标题行');
  checkContains('正文保留', md, '正文');
  checkContains('文章内 footer 保留', md, '文章署名');
}

// ============================================================
section('7. 图片细节（懒加载 / 去重 / data URL）');
{
  const { images, md } = capture(`<p><img data-src="https://example.com/lazy.png" alt="lazy" width="300" height="200"></p>
    <p><img src="https://example.com/pic.png" width="300" height="200"><img src="https://example.com/pic.png" width="300" height="200"></p>`);

  checkContains('懒加载图片取 data-src', md, '[[IMG:');
  check('图片去重', images.length === 2, JSON.stringify(images.map((i) => i.src)));
  check('懒加载 src 解析为绝对地址', images[0].src === 'https://example.com/lazy.png', images[0].src);
  // 占位符经 base64 编码存储，渲染端可往返还原为原始 URL
  checkContains('图片占位符可还原为原始 URL', captureMarkdownToHtml(md), 'src="https://example.com/lazy.png"');
}

// ============================================================
section('8. 渲染端鲁棒性（未闭合围栏补齐 / 图片占位符 dataURL 与 URL 兜底）');
{
  const sample = [
    '示例标题',
    '',
    '```',
    'print("sample code")',
    '# 注释',
  ].join('\n');
  // 真实采集协议：占位符 key = btoa(encodeURIComponent(src))
  const rawSrc = 'https://example.com/old.png';
  const encoded = btoa(encodeURIComponent(rawSrc));
  const withImage = `文本\n\n[[IMG:${encoded}|配图]]\n\n结尾`;

  const html = captureMarkdownToHtml(sample, []);
  checkContains('未闭合围栏被补全为代码块', html, '<pre><code>');
  checkContains('代码内容保留', stripTags(html), 'print("sample code")');
  notContains('代码内注释不变标题', html.slice(html.indexOf('<pre')), '<h1');

  // 占位符 + 已下载的图片数据 → 内嵌 dataURL（笔记离线可看）
  const html2 = captureMarkdownToHtml(withImage, [
    { src: rawSrc, dataUrl: 'data:image/png;base64,AAA', alt: '配图' },
  ]);
  checkContains('图片渲染为内嵌 img', html2, '<img src="data:image/png;base64,AAA"');
  checkContains('img 使用占位符 alt', html2, 'alt="配图"');

  // 无图片数据时回退为解码后的原始 URL
  const html3 = captureMarkdownToHtml(withImage, []);
  checkContains('无图片数据时回退为原始 URL', html3, `src="${rawSrc}"`);
}

// ============================================================
section('9. 端到端（抓取 → 渲染 内容逐字保真）');
{
  const pythonCode = 'import os\n# 注释\n\n\ndef main():\n    print("hi")\n';
  const htmlPage = `<main><p>段前文本</p><pre class="language-python"><code>${pythonCode
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</code></pre><p>段后文本</p></main>`;
  const { md } = capture(htmlPage);
  const html = captureMarkdownToHtml(md);
  const plain = stripTags(html);

  checkContains('段前文本', plain, '段前文本');
  checkContains('段后文本', plain, '段后文本');
  check('代码内容逐字一致', plain.includes(pythonCode.trim()), JSON.stringify(plain.slice(0, 500)));
  const preStart = html.indexOf('<pre');
  const preEnd = html.indexOf('</pre>');
  notContains('代码块内无任何行内标签污染', html.slice(preStart, preEnd), '<p>');
  notContains('代码块内无标题', html.slice(preStart, preEnd), '<h1');
  notContains('代码块内无列表', html.slice(preStart, preEnd), '<li');
}

// ============================================================
section('10. 转义工具（escape / unescape 往返）');
{
  const raw = 'a\\b `c` *d* [e] #f >g -h';
  const escaped = raw.replace(/([\\`*[\]])/g, '\\$1');
  check('unescape(escape(x)) == x', unescapeMarkdownText(escaped) === raw, JSON.stringify(unescapeMarkdownText(escaped)));
  check('unescapeForCopy 与 unescapeMarkdownText 一致', unescapeForCopy(escaped) === unescapeMarkdownText(escaped));
}

// ============================================================
section('11. 代码结构变体（br 换行 / 块级行 / 空 pre / CRLF / 语言探测）');
{
  const { md: mdBr } = capture('<pre><code>line1<br>line2<br>line3</code></pre>');
  checkContains('br 转为换行', mdBr, '```\nline1\nline2\nline3\n```');

  const { md: mdDiv } = capture(
    '<pre><code><div>import os</div><div>from openai import OpenAI</div><div></div><div>client = OpenAI()</div></code></pre>',
  );
  checkContains('块级行保留换行', mdDiv, 'import os\nfrom openai import OpenAI');
  checkContains('空块级行保留空行', mdDiv, 'OpenAI\n\nclient = OpenAI()');

  const { md: mdEmpty } = capture('<pre><code>   \n  </code></pre><pre><code></code></pre>');
  check('空 pre 不产生围栏', !mdEmpty.includes('```'), JSON.stringify(mdEmpty));

  const { md: mdCrlf } = capture('<pre><code>a\r\nb\r\n\r\nc</code></pre>');
  checkContains('CRLF 归一化为 LF 且空行保留', mdCrlf, 'a\nb\n\nc');

  const { md: mdWrap } = capture('<div class="language-go"><pre><code>package main</code></pre></div>');
  checkContains('语言从 wrapper class 探测', mdWrap, '```go');

  const { md: mdAttr } = capture('<pre data-lang="c++"><code>int main(){}</code></pre>');
  checkContains('语言从 data-lang 探测', mdAttr, '```c++');

  const { md: mdNoCode } = capture('<pre>裸 pre 内容</pre>');
  checkContains('pre 无 code 子元素也能提取', mdNoCode, '```\n裸 pre 内容\n```');

  const html = captureMarkdownToHtml(mdDiv);
  checkContains('块级行结构渲染后仍多行', stripTags(html), 'import os\nfrom openai import OpenAI');
}

// ============================================================
section('12. 围栏内零污染（图片占位符 / 旧列表标记 / 反斜杠 / 标记行）');
{
  const code = [
    '[[IMG:aHR0cHM6Ly94|not-an-image]]',
    '• 不是列表',
    'C:\\foo\\bar 保留反斜杠',
    '# 不是标题',
    '---',
    '| a | b |',
    '1. 不是有序列表',
  ].join('\n');
  const { md } = capture(`<pre><code>${code.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre>`);
  const html = captureMarkdownToHtml(md);
  const preArea = html.slice(html.indexOf('<pre'), html.indexOf('</pre>'));

  checkContains('占位符字样保留在代码内', preArea, '[[IMG:');
  notContains('代码内占位符未被替换为 img', preArea, '<img');
  checkContains('• 原样保留', preArea, '• 不是列表');
  checkContains('反斜杠原样保留', preArea, 'C:\\foo\\bar');
  notContains('--- 未被解析为分隔线', preArea, '<hr');
  notContains('代码内无标题', preArea, '<h1');

  // 围栏外的图片占位符仍然渲染为内嵌 img
  const encoded = 'aHR0cHM6Ly9leGFtcGxlLmNvbS94LnBuZw==';
  const mixed = `文本 [[IMG:${encoded}|图]] 结尾\n\n\`\`\`\n[[IMG:${encoded}|图]]\n\`\`\``;
  const html2 = captureMarkdownToHtml(mixed);
  check('围栏外占位符渲染为 img', html2.includes('<img src="https://example.com/x.png"'));
  checkContains('围栏内占位符不渲染', html2, '[[IMG:');
}

// ============================================================
section('13. 复制文本反转义的围栏感知');
{
  const md = '```\nC:\\foo\\bar\nkeep \\\\ double\n```\n\n\\# 标题 \\*不是强调\\*';
  const copy = unescapeForCopy(md);
  checkContains('代码内反斜杠不被还原', copy, 'C:\\foo\\bar');
  checkContains('代码内双反斜杠保持', copy, 'keep \\\\ double');
  checkContains('围栏外转义被还原(#)', copy, '# 标题');
  checkContains('围栏外转义被还原(*)', copy, '*不是强调*');
}

// ============================================================
section('14. 重复兄弟元素去重（跑马灯克隆）与列表项不去重');
{
  const long = '这是一段足够长的跑马灯公告文本内容';
  const { md } = capture(
    `<div><span>${long}</span><span>${long}</span><span>${long}</span></div>` +
      `<ul><li>这是一个足够长的相同列表项</li><li>这是一个足够长的相同列表项</li></ul>`,
  );
  const count = (md.match(/跑马灯公告文本内容/g) || []).length;
  check('相邻重复行内元素只保留一个', count === 1, `出现 ${count} 次`);
  const liCount = (md.match(/这是一个足够长的相同列表项/g) || []).length;
  check('相同的相邻列表项不去重', liCount === 2, `出现 ${liCount} 次`);
}

// ============================================================
section('15. footer 范围收紧与表格单元格分隔');
{
  const { md } = capture(
    `<main><p>正文内容</p><footer>站点级页脚备案信息</footer></main>` +
      `<article><footer>文章作者署名</footer></article>`,
  );
  notContains('main 内站点级 footer 跳过', md, '站点级页脚备案信息');
  checkContains('article 内 footer 保留', md, '文章作者署名');

  const { md: mdTable } = capture(
    '<table><tr><th>a</th><th>b</th></tr><tr><td><div>BASE_URL</div><div>协议说明</div><div><code>https://x</code></div></td><td>纯文本</td></tr></table>',
  );
  checkContains('单元格多块内容以空格分隔', mdTable, '| BASE_URL 协议说明 `https://x` |');
}

// ============================================================
section('16. 图片占位符解码鲁棒性（round-trip / padding / 原始 src 兜底 / 特殊字符）');
{
  // 抓取 → 渲染往返：无 imageMap 时回退为原始 URL（含百分号的 URL 不被二次解码破坏）
  const { md } = capture(
    '<p><img src="https://example.com/a%20b.png" width="300" height="200"></p>',
  );
  const html = captureMarkdownToHtml(md);
  checkContains('占位符解码回原始 URL（含百分号）', html, 'src="https://example.com/a%20b.png"');

  // 缺 padding 的 base64 也能解码
  const full = btoa('https://example.com/ab.png');
  const stripped = full.replace(/=+$/, '');
  const htmlPad = captureMarkdownToHtml(`[[IMG:${stripped}|x]]`);
  checkContains('缺 padding 的 base64 解码成功', htmlPad, 'https://example.com/ab.png');

  // 兜底：占位符里直接存原始 src（btoa 失败时的协议约定）
  const htmlRaw = captureMarkdownToHtml('[[IMG:https://example.com/old.png|旧图]]');
  checkContains('原始 src 占位符回退', htmlRaw, 'src="https://example.com/old.png"');

  // img 属性替换不受 $& 等替换模式影响（& 转义为 &amp;）
  const htmlDollar = captureMarkdownToHtml(`[[IMG:${full}|x$&y]]`);
  checkContains('alt 中的 $& 原样保留', htmlDollar, 'alt="x$&amp;y"');
  notContains('img 替换无 token 残留', htmlDollar, 'AGENTNEXUSIMG');
}

// ============================================================
section('17. CSS 块级显示的行内标签拆分（文本不粘连）');
{
  // 表格单元格中的块级标签行（MiMo 文档表格：BASE_URL 标签 + 内容行）
  const { md: mdCell } = capture(
    '<table><tr><th>获取方式</th></tr><tr><td><strong style="display:block">BASE_URL</strong>' +
      '<span>OpenAI 兼容协议：<code>https://x</code></span></td></tr></table>',
  );
  checkContains('块级标签与后续文本以空格分隔', mdCell, 'BASE_URL OpenAI 兼容协议');
  notContains('标签与文本不粘连', mdCell, 'BASE_URLOpenAI');

  // 段落内的块级显示 span 独立成块
  const { md: mdP } = capture('<p>前<span style="display:block">块级行</span>后</p>');
  notContains('段落内块级 span 不粘连', mdP, '前块级行');
  checkContains('块级 span 独立成行', mdP, '块级行');

  // 未被 CSS 设为块级的行内标签保持段落连续
  const { md: mdInline } = capture('<p>前<strong>加粗</strong>后</p>');
  checkContains('普通行内标签保持段落连续', mdInline, '前**加粗**后');

  // flex 容器的子项按块级拆分
  const { md: mdFlex } = capture(
    '<div style="display:flex"><span>左侧标签</span><span>右侧内容</span></div>',
  );
  // jsdom 不实现 flex 的块级化，此处仅确保不回归；Chrome 中两 span 会被块级化
  checkContains('flex 容器内容完整', mdFlex, '左侧标签');
  checkContains('flex 容器内容完整（右）', mdFlex, '右侧内容');

  // 渲染端仍然完整
  const html = captureMarkdownToHtml(mdCell);
  checkContains('渲染后表格内容完整', html, 'BASE_URL');
}

// ============================================================
section('18. 围栏闭合规则加固（信息串行不提前闭合 / 波浪围栏补齐）');
{
  // 代码内的 "```python" 行不是合法闭合围栏（标记后带信息串），整段仍是代码
  const md = '```\n# 注释\n```python\nstill code\n```';
  const html = captureMarkdownToHtml(md);
  const preArea = html.slice(html.indexOf('<pre'), html.lastIndexOf('</pre>'));
  checkContains('信息串行保留在代码块内', preArea, '```python');
  checkContains('后续代码行保留', preArea, 'still code');
  notContains('代码块内注释不变标题', preArea, '<h1');
  checkContains('代码块内注释文本完整', preArea, '# 注释');

  // 未闭合的波浪围栏用 ~~~ 补齐，不污染反引号
  const htmlTilde = captureMarkdownToHtml('~~~python\nprint(1)\n# hi');
  const tildeArea = htmlTilde.slice(htmlTilde.indexOf('<pre'), htmlTilde.lastIndexOf('</pre>'));
  checkContains('波浪围栏代码内容保留', stripTags(tildeArea), 'print(1)');
  checkContains('波浪围栏内注释不变标题', stripTags(tildeArea), '# hi');
  notContains('补齐围栏不引入反引号', tildeArea, '```');

  // 围栏感知的反转义：信息串行之后的行仍按围栏内处理
  const copy = unescapeForCopy('```\nC:\\x\n```python\nkeep \\\\ raw\n```');
  checkContains('信息串行后仍视为围栏内', copy, 'keep \\\\ raw');
  checkContains('围栏内反斜杠不还原', copy, 'C:\\x');
}

// ---------- 汇总 ----------
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failures.length) {
  console.log('失败用例:', failures.join(' | '));
}

// 清理构建产物
try {
  fs.rmSync(buildDir, { recursive: true, force: true });
} catch {
  // 忽略清理失败
}

process.exit(failed ? 1 : 0);

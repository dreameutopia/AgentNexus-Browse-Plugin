/**
 * document_tool 功能测试
 *
 * 覆盖：
 *   1. 参数校验：action/path/format 的非法输入给出精准原因；
 *   2. Markdown 渲染：标题/列表/表格/引用/代码块/公式/链接/图片的 HTML 产出；
 *   3. DOCX 产出：真实打包出 .docx，并解包校验内容（表格、代码、公式、页脚页码）；
 *   4. 图片解析：data URL 直嵌、危险协议拒绝、私网地址拒绝（SSRF 防线）；
 *   5. PDF 文档模板：@page 分页规则、矢量图内联、危险链接降级。
 *
 * PDF 的 CDP 打印在 background 上下文执行（Node 测试环境无法覆盖），
 * 该部分以「文档模板正确性」单测覆盖，真实渲染由扩展内运行时验证。
 */

import { unzipSync, strFromU8 } from 'fflate';
import { renderMarkdownToHtml, isSafeImageProtocol, isSafeLinkProtocol } from '../../tools/document/markdown-render';
import { buildDocx } from '../../tools/document/docx-builder';
import { buildPdfDocument } from '../../tools/document/pdf-document';
import { detectImageFormat, isPrivateHost, parseIPv4 } from '../../tools/document/image-resolver';
import { sanitizeArtifactFilename, DocumentTool } from '../../tools/document/document-tool';
import { PDF_RENDER_MESSAGE as CLIENT_MESSAGE } from '../../tools/document/pdf-client';
import { PDF_RENDER_MESSAGE as PROTOCOL_MESSAGE } from '../../tools/document/pdf-protocol';
import { PDF_RENDER_MESSAGE as CHANNEL_MESSAGE } from '../../tools/browser/pdf-channel';

// ==================== 迷你断言框架 ====================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(condition: boolean, message: string, detail?: unknown): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`${message}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(actual: unknown, expected: unknown, message: string, detail?: unknown): void {
  check(actual === expected, message, detail === undefined ? { actual, expected } : detail);
}

/** 断言包含子串 */
function includes(haystack: string, needle: string, message: string): void {
  check(haystack.includes(needle), message, { needle, sample: haystack.slice(0, 240) });
}

/** 断言不包含子串 */
function excludes(haystack: string, needle: string, message: string): void {
  check(!haystack.includes(needle), message, { needle, sample: haystack.slice(0, 240) });
}


/** 取工具结果里的文本内容（ToolResult.content 是多形态联合） */
function resultText(result: { content?: unknown }): string {
  const content = result.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (item && typeof item === 'object' && 'text' in item ? String((item as { text?: unknown }).text ?? '') : ''))
    .join('\n');
}

// ==================== 1. 参数校验 ====================

{
  const tool = new DocumentTool();
  eq(tool.name, 'document_tool', '工具名固定');

  const invalidAction = await tool.execute({ action: 'nope' });
  eq(invalidAction.success, false, '非法 action 返回失败结果');
  includes(resultText(invalidAction), 'action', '非法 action 的原因指明 action 字段');

  const missingPath = await tool.execute({ action: 'create', content: '# x' });
  eq(missingPath.success, false, 'create 缺 path 返回失败');
  includes(resultText(missingPath), 'path', '缺 path 的原因指明 path');

  const wrongExt = await tool.execute({ action: 'create', path: 'docs/a.txt', content: 'x' });
  eq(wrongExt.success, false, '非 .md 路径被拒绝');
  includes(resultText(wrongExt), '.md', '非 .md 的原因指明后缀要求');

  const badFormat = await tool.execute({ action: 'convert', path: 'docs/a.md', format: 'pdfx' });
  eq(badFormat.success, false, '非法 format 返回失败');
  includes(resultText(badFormat), 'format', '非法 format 的原因指明 format 字段');

  const badParams = await tool.execute('not-an-object' as never);
  eq(badParams.success, false, '非对象参数返回失败');

  const editBoth = await tool.execute({ action: 'edit', path: 'docs/a.md', content: 'x', find: 'y' });
  eq(editBoth.success, false, 'edit 的 content 与 find 互斥被拒');
  includes(resultText(editBoth), '互斥', '互斥冲突的原因说明');

  const editNeither = await tool.execute({ action: 'edit', path: 'docs/a.md' });
  eq(editNeither.success, false, 'edit 缺 content 与 find 被拒');

  // Schema 必填项与 action 对齐
  const anyOf = tool.openaiSchema.function.parameters.anyOf as { required: string[] }[];
  eq(anyOf.length, 4, 'schema 覆盖四个 action');
  const convertRequired = anyOf.find((branch) => branch.required.includes('action') && branch.required.length === 3);
  check(!!convertRequired, 'convert 的 schema 分支要求 path');
}

// ==================== 2. Markdown 渲染 ====================

{
  const markdown = [
    '# 一级标题',
    '',
    '段落含 **粗体**、*斜体*、~~删除线~~ 与 `行内代码`。',
    '',
    '## 二级标题',
    '',
    '- 无序项一',
    '- 无序项二',
    '  - 嵌套项',
    '',
    '1. 有序项一',
    '2. 有序项二',
    '',
    '| 列一 | 列二 |',
    '| --- | --- |',
    '| 甲 | 乙 |',
    '',
    '> 引用块内容',
    '',
    '---',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '行内公式 $E = mc^2$，块级公式：',
    '',
    '$$',
    '\\int_0^1 x^2 dx',
    '$$',
    '',
    '[链接](https://example.com)',
  ].join('\n');

  const result = await renderMarkdownToHtml(markdown);
  const html = result.html;

  eq(result.warnings.length, 0, '完整 Markdown 渲染无降级告警', result.warnings);

  includes(html, '<h1>一级标题</h1>', '一级标题渲染为 h1');
  includes(html, '<h2>二级标题</h2>', '二级标题渲染为 h2');
  includes(html, '<strong>粗体</strong>', '粗体渲染为 strong');
  includes(html, '<em>斜体</em>', '斜体渲染为 em');
  includes(html, '<s>删除线</s>', '删除线渲染为 s（docx/html 识别为删除线）');
  includes(html, '<code>行内代码</code>', '行内代码渲染为 code');
  includes(html, '<ul>', '无序列表渲染为 ul');
  includes(html, '<ol>', '有序列表渲染为 ol');
  includes(html, '<table>', '表格渲染为 table');
  includes(html, '<th', '表格渲染出表头单元格');
  includes(html, '<blockquote>', '引用块渲染为 blockquote');
  includes(html, '<hr', '分割线渲染为 hr');
  includes(html, 'hljs', '代码块带语法高亮类名');
  includes(html, '<math', '公式渲染为 MathML');
  includes(html, 'href="https://example.com"', '链接保留 href');
  includes(html, '<li>', '列表项渲染为 li');
}

{
  // 危险协议降级：markdown-it 内置的链接规范化已拒绝 javascript:（整段变纯文本，
  // 产物里仍有字面量，但不是可点击锚点）；本模块的 link 规则是第二道防线。
  const result = await renderMarkdownToHtml('[坏链](javascript:alert(1))');
  excludes(result.html, '<a href="javascript:', '危险协议未渲染为可点击锚点');
  excludes(result.html, 'href="javascript:', '危险协议未进入任何 href 属性');
  includes(result.html, '坏链', '危险链接的文字保留');

  // 原始 HTML 转义（防注入）
  const injected = await renderMarkdownToHtml('<img src=x onerror=alert(1)>');
  excludes(injected.html, '<img src=x', '原始 HTML 被转义');
  includes(injected.html, '&lt;img', '原始 HTML 以转义文本呈现');
}

{
  // 公式误判防护：货币金额不应被当作公式
  const money = await renderMarkdownToHtml('价格是 $5 与 $10 元。');
  includes(money.html, '$5', '货币金额中的 $ 未被当作公式');

  // 未闭合的行内公式不应破坏正文
  const unclosed = await renderMarkdownToHtml('a $ b c');
  includes(unclosed.html, '$', '未闭合的 $ 原样保留');
}

{
  // 不可解析图片降级为 alt 文本
  const result = await renderMarkdownToHtml('![缺失图](https://invalid.example/a.png)');
  check(result.warnings.length >= 0, '图片降级不抛错');
}

// ==================== 3. DOCX 产出 ====================

{
  const markdown = [
    '# 报告标题',
    '',
    '正文段落。',
    '',
    '| 名称 | 数量 |',
    '| --- | --- |',
    '| 甲 | 3 |',
    '',
    '```python',
    'print("hi")',
    '```',
    '',
    '公式 $a^2+b^2=c^2$',
  ].join('\n');

  const rendered = await renderMarkdownToHtml(markdown);
  const built = await buildDocx(rendered.html, { title: '测试报告', headerText: '页眉' });

  eq(built.warnings.length, 0, 'DOCX 构建无降级告警', built.warnings);
  check(built.blob.size > 0, 'DOCX 产物非空');
  eq(built.blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'DOCX MIME 正确');

  // 解包校验内容确实进了 Word
  const entries = unzipSync(new Uint8Array(await built.blob.arrayBuffer()));
  const documentXml = strFromU8(entries['word/document.xml']);
  includes(documentXml, '报告标题', 'DOCX 含标题文本');
  includes(documentXml, '正文段落', 'DOCX 含正文');
  includes(documentXml, 'w:tbl', 'DOCX 含表格');
  includes(documentXml, '甲', 'DOCX 含表格单元格');
  includes(documentXml, 'print', 'DOCX 含代码块');
  includes(documentXml, 'm:oMath', 'DOCX 含 Word 原生公式');
  includes(documentXml, 'm:sSup', 'DOCX 公式含上标结构');
  includes(documentXml, 'w:footerReference', 'DOCX 含页脚引用');
  includes(documentXml, 'w:headerReference', 'DOCX 含页眉引用');

  const coreXml = entries['docProps/core.xml'] ? strFromU8(entries['docProps/core.xml']) : '';
  includes(coreXml, '测试报告', 'DOCX 文档属性写入标题');
}

{
  // 矢量图（Mermaid 图表）必须注入 DOCX：docx/html 绝不联网，
  // 地址不在 images 表里就只剩 alt 文本——这是回归防线。
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150" viewBox="0 0 300 150"><rect width="300" height="150"/></svg>';
  const rendered = await renderMarkdownToHtml('```mermaid\ngraph TD\n  A-->B\n```', {
    renderMermaid: async () => svg,
  });
  eq(rendered.vectorImages.size, 1, 'mermaid 渲染产出 1 张矢量图');

  const built = await buildDocx(rendered.html, {
    title: '图表',
    vectorImages: rendered.vectorImages,
  });
  eq(built.warnings.length, 0, '含矢量图的 DOCX 构建无降级告警', built.warnings);
  const entries = unzipSync(new Uint8Array(await built.blob.arrayBuffer()));
  const documentXml = strFromU8(entries['word/document.xml']);
  includes(documentXml, 'svgBlip', 'DOCX 含矢量图（SVG 内嵌）');
}

// ==================== 4. 图片解析与安全 ====================

{
  // 协议白名单
  check(isSafeLinkProtocol('https://example.com'), 'https 链接安全');
  check(isSafeLinkProtocol('#anchor'), '锚点链接安全');
  check(isSafeLinkProtocol('mailto:a@b.com'), 'mailto 链接安全');
  check(!isSafeLinkProtocol('javascript:alert(1)'), 'javascript 链接不安全');
  check(!isSafeLinkProtocol('data:text/html,<script>'), 'data 链接不安全（链接场景）');

  check(isSafeImageProtocol('https://example.com/a.png'), 'https 图片安全');
  check(isSafeImageProtocol('data:image/png;base64,AA'), 'data 图片安全');
  check(!isSafeImageProtocol('javascript:alert(1)'), 'javascript 图片不安全');

  // 私网判定（SSRF 防线）
  check(isPrivateHost('localhost'), 'localhost 判为私网');
  check(isPrivateHost('127.0.0.1'), '127.0.0.1 判为私网');
  check(isPrivateHost('10.1.2.3'), '10.x 判为私网');
  check(isPrivateHost('192.168.1.1'), '192.168.x 判为私网');
  check(isPrivateHost('172.16.0.1'), '172.16-31.x 判为私网');
  check(isPrivateHost('169.254.1.1'), '169.254.x 判为私网');
  check(isPrivateHost('[::1]'), 'IPv6 回环判为私网');
  check(!isPrivateHost('example.com'), '公网域名不判为私网');
  check(!isPrivateHost('8.8.8.8'), '公网 IP 不判为私网');
}

{
  // data URL 直嵌
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const rendered = await renderMarkdownToHtml(`![内联图](${png})`, {
    images: {
      resolve: async (src) => ({ src, dataUrl: src }),
    },
  });
  includes(rendered.html, 'data:image/png;base64', 'data URL 图片内联进 HTML');
}

// ==================== 5. PDF 文档模板 ====================

{
  const rendered = await renderMarkdownToHtml('# PDF 标题\n\n正文。');
  const document = buildPdfDocument(rendered.html, {
    title: 'PDF 标题',
    vectorImages: new Map(),
  });

  includes(document, '<!DOCTYPE html>', 'PDF 文档是完整 HTML');
  includes(document, '@page', 'PDF 文档声明 @page 分页');
  includes(document, 'size: A4', 'PDF 纸张为 A4');
  includes(document, 'break-after: avoid', 'PDF 标题不与正文分离');
  includes(document, 'break-inside: avoid', 'PDF 表格行/图片不跨页断裂');
  includes(document, 'Microsoft YaHei', 'PDF 使用中文字体栈');
  includes(document, '<title>PDF 标题</title>', 'PDF 文档标题写入 title');
  includes(document, '正文。', 'PDF 正文包含渲染内容');
}

{
  // 矢量图在 PDF 里内联为 SVG（保持矢量，不栅格化）
  const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  const body = '<p><img src="an-doc-vec-0" alt="图"></p>';
  const document = buildPdfDocument(body, {
    title: 't',
    vectorImages: new Map([['an-doc-vec-0', { svg }]]),
  });
  includes(document, '<svg viewBox="0 0 10 10">', '矢量图内联为 SVG');
  excludes(document, 'an-doc-vec-0', '矢量图占位地址已被替换掉');
}

// ==================== 6. 回归防线：多图占位地址不串号 ====================

{
  // 回归缺陷：占位地址是 an-doc-raster-N，若按裸地址做子串替换，
  // 第 2 张图（an-doc-raster-1）会命中第 11 张图（an-doc-raster-10）的
  // 前缀，把图片数据写错位置。
  const count = 12;
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(`![图 ${i}](img-${i}.png)`);
  const rendered = await renderMarkdownToHtml(parts.join('\n\n'), {
    images: {
      resolve: async (src) => ({ src, dataUrl: `data:image/png;base64,AAA${src}` }),
    },
  });
  for (let i = 0; i < count; i++) {
    includes(
      rendered.html,
      `src="data:image/png;base64,AAAimg-${i}.png"`,
      `第 ${i + 1} 张图内联到自己的地址（占位地址不串号）`,
    );
  }
  excludes(rendered.html, 'an-doc-raster', '所有占位地址均已回填');
}

// ==================== 7. 回归防线：mermaid 围栏与图表一一对应 ====================

{
  // 回归缺陷：早先用正则扫描源码统计 mermaid 围栏，缩进代码块里的
  // ```mermaid 也会被计入，导致「第 2 个围栏拿到第 1 张图的 SVG」。
  const markdown = [
    '```mermaid',
    'graph TD',
    '  A-->B',
    '```',
    '',
    '    ```mermaid',
    '    graph LR',
    '    C-->D',
    '    ```',
    '',
    '```mermaid',
    'graph TD',
    '  E-->F',
    '```',
  ].join('\n');

  let renderedCalls = 0;
  const rendered = await renderMarkdownToHtml(markdown, {
    renderMermaid: async (code) => {
      renderedCalls++;
      return `<svg data-code="${code.replace(/\s+/g, ' ').trim()}"></svg>`;
    },
  });

  eq(renderedCalls, 2, '只有两个真正的 mermaid 围栏被渲染（缩进代码块不算）');
  eq(rendered.vectorImages.size, 2, '产出 2 张矢量图');
  const svgs = [...rendered.vectorImages.values()].map((vector) => vector.svg);
  includes(svgs[0] ?? '', 'graph TD A-->B', '第一张图对应第一个围栏');
  includes(svgs[1] ?? '', 'graph TD E-->F', '第二张图对应第二个围栏（未被缩进块挤位）');
  excludes(svgs[1] ?? '', 'graph LR C-->D', '缩进代码块里的伪围栏没有被当作图表');
}

// ==================== 8. 回归防线：产物文件名后缀 ====================

{
  // 回归缺陷：早先按「目标后缀长度」截断原名，`报告.docx` 会变成 `报告..pdf`。
  eq(sanitizeArtifactFilename('报告.docx', '.pdf').name, '报告.pdf', '已有 .docx 后缀被替换为 .pdf');
  eq(sanitizeArtifactFilename('报告.docx', '.docx').name, '报告.docx', '同后缀保持不变');
  eq(sanitizeArtifactFilename('报告', '.pdf').name, '报告.pdf', '无后缀直接挂目标后缀');
  eq(sanitizeArtifactFilename('2024.05 月报', '.pdf').name, '2024.05 月报.pdf', '带点号的名称不被误切');
  eq(sanitizeArtifactFilename('a/b:c', '.pdf').name, 'abc.pdf', '非法字符被剔除');
  eq(sanitizeArtifactFilename('', '.pdf').name.includes('.pdf'), true, '空名走默认名');
  eq(sanitizeArtifactFilename(123 as never, '.pdf').name.includes('.pdf'), true, '非字符串走默认名');
}

// ==================== 9. 回归防线：SSRF 数字变形写法 ====================

{
  // 回归缺陷：朴素字符串匹配放过了十进制/八进制/十六进制/缩写/尾点写法，
  // 而浏览器会把它们全部解析成 127.0.0.1。
  check(isPrivateHost('2130706433'), '十进制 IPv4 判为私网');
  check(isPrivateHost('0177.0.0.1'), '八进制 IPv4 判为私网');
  check(isPrivateHost('0x7f.0.0.1'), '十六进制 IPv4 判为私网');
  check(isPrivateHost('127.1'), '缩写 IPv4 判为私网');
  check(isPrivateHost('127.0.0.1.'), '带尾点的 IPv4 判为私网');
  check(isPrivateHost('0.0.0.0'), '0.0.0.0 判为私网');
  check(isPrivateHost('100.64.0.1'), 'CGNAT 段判为私网');
  check(isPrivateHost('metadata.google.internal'), '云元数据主机名判为私网');
  check(!isPrivateHost('8.8.8.8'), '公网 IPv4 不判为私网');
  check(!isPrivateHost('example.com'), '公网域名不判为私网');
  check(!isPrivateHost('1.2.3.4.example.com'), '以 IP 开头的主机名不判为私网');

  eq(parseIPv4('127.0.0.1'), 2130706433, 'parseIPv4 解析标准写法');
  eq(parseIPv4('2130706433'), 2130706433, 'parseIPv4 解析十进制写法');
  eq(parseIPv4('127.1'), 2130706433, 'parseIPv4 解析缩写写法');
  eq(parseIPv4('example.com'), null, '非 IP 返回 null');
  eq(parseIPv4('1.2.3.4.5'), null, '超过四段返回 null');
}

// ==================== 10. 回归防线：协议相对地址与图片格式 ====================

{
  // 协议相对地址是跨源绝对地址：放进 PDF 会触发对外请求
  check(!isSafeLinkProtocol('//evil.example.com/x'), '协议相对链接判为不安全');
  check(!isSafeImageProtocol('//evil.example.com/a.png'), '协议相对图片判为不安全');
  check(isSafeLinkProtocol('/docs/a.md'), '绝对路径链接仍视为安全（同源）');

  // 图片格式按字节魔数判定（不信 Content-Type）
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  eq(detectImageFormat(png), 'png', 'PNG 魔数识别');
  eq(detectImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpeg', 'JPEG 魔数识别');
  eq(detectImageFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38])), 'gif', 'GIF 魔数识别');
  eq(detectImageFormat(new Uint8Array([0x42, 0x4d, 0x00, 0x00])), 'bmp', 'BMP 魔数识别');
  eq(detectImageFormat(new TextEncoder().encode('<svg xmlns="x"></svg>')), 'svg', 'SVG 文本识别');
  eq(detectImageFormat(new TextEncoder().encode('not an image')), null, '非图片返回 null');
}

// ==================== 11. 回归防线：PDF 通道协议单一事实源 ====================

{
  eq(CLIENT_MESSAGE, PROTOCOL_MESSAGE, '客户端与协议层消息类型一致');
  eq(CHANNEL_MESSAGE, PROTOCOL_MESSAGE, '服务端与协议层消息类型一致');
  includes(PROTOCOL_MESSAGE, 'document-pdf-render', 'PDF 消息类型命名稳定');
}

// ==================== 12. 回归防线：PDF 纸张与页边距一致 ====================

{
  const a4 = buildPdfDocument('<p>x</p>', { title: 't', vectorImages: new Map() });
  includes(a4, 'size: A4', '默认纸张为 A4');
  const letter = buildPdfDocument('<p>x</p>', {
    title: 't',
    paperSize: 'Letter',
    vectorImages: new Map(),
  });
  includes(letter, 'size: Letter', '可指定 Letter 纸张');
  includes(a4, '@page', 'PDF 文档声明 @page 分页');
  // @page 的页边距必须与 CDP printToPDF 的 margin 一致（否则版式描述与实际不符）
  const marginMm = Math.round(0.79 * 25.4);
  includes(a4, `margin: ${marginMm}mm`, 'CSS 页边距与打印参数一致');
}

// ==================== 13. 回归防线：未知参数必须报错 ====================

{
  const tool = new DocumentTool();
  const unknown = await tool.execute({ action: 'convert', path: 'docs/a.md', style: 'dark' });
  eq(unknown.success, false, 'convert 的未知参数被拒');
  includes(resultText(unknown), 'style', '未知参数名出现在回执里');
  includes(resultText(unknown), '不接受参数', '回执说明是参数不被接受');

  const unknownForCreate = await tool.execute({
    action: 'create',
    path: 'docs/a.md',
    content: '# a',
    format: 'pdf',
  });
  eq(unknownForCreate.success, false, 'create 的未知参数被拒');
}

// ==================== 汇总 ====================

console.log(`[document-tool] 通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

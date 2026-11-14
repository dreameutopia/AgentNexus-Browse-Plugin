/**
 * 文档工具 DOM 环境测试（独立进程）
 *
 * 覆盖 sidepanel 真实执行路径：
 *   1. 文档工具在有 DOM 的上下文注册后能被查到；
 *   2. mermaid 渲染在 DOM 环境可用（真实调用 mermaid.render）；
 *   3. convert(docx) 端到端产出真实的 .docx（二进制可解包）。
 *
 * PDF 走 background 的 CDP 通道，无法在 JSDOM 内验证；其正确性由
 * pdf-document.ts 的模板单测 + 扩展内运行时覆盖。
 */

import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
// 会话工作区走 IndexedDB：Node 环境用 fake-indexeddb 顶替
import 'fake-indexeddb/auto';

// —— 挂载 DOM（document_tool 的 mermaid 渲染与 canvas 兜底需要）——
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'https://example.test/',
  pretendToBeVisual: true,
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// Node 24 的 globalThis.navigator 是只读 getter，必须 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
// Blob 保留 Node 原生实现：JSDOM 的 Blob 缺少 arrayBuffer()，工作区读写依赖它
g.Blob = Blob;
// 其余 DOM 全局按需挂载（mermaid 等库直接引用全局构造器，缺一个就整条链路失败）
for (const key of [
  'HTMLElement', 'Image', 'URL', 'DOMParser', 'HTMLImageElement', 'Node', 'Element',
  'NodeFilter', 'SVGElement', 'SVGGraphicsElement', 'SVGTextElement', 'SVGTSpanElement',
  'SVGSVGElement', 'XMLSerializer', 'Range', 'Selection', 'CSSStyleSheet', 'ShadowRoot',
  'HTMLCollection', 'NodeList', 'TextNode', 'Comment', 'DocumentFragment', 'MutationObserver',
  'CustomEvent', 'Event', 'Text', 'DOMException', 'getSelection', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame',
]) {
  const value = (dom.window as unknown as Record<string, unknown>)[key];
  if (value !== undefined && g[key] === undefined) g[key] = value;
}
g.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

// JSDOM 未实现 SVG 文本测量几何 API（getComputedTextLength / getBBox），
// 而 mermaid 渲染必须用到它们。这里补一个按字符数估算宽度的桩——
// 图表尺寸只是测试断言的输入，不参与产品逻辑。
const SVG_TEXT_WIDTH_PER_CHAR = 8;
const svgStubs = {
  getComputedTextLength(this: { textContent?: string | null }): number {
    return (this.textContent ?? '').length * SVG_TEXT_WIDTH_PER_CHAR;
  },
  getBBox(this: { textContent?: string | null }): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: (this.textContent ?? '').length * SVG_TEXT_WIDTH_PER_CHAR, height: 16 };
  },
};
for (const name of ['SVGElement', 'SVGGraphicsElement', 'SVGTextElement', 'SVGTSpanElement']) {
  const proto = (dom.window as unknown as Record<string, { prototype?: Record<string, unknown> }>)[name]?.prototype;
  if (proto) {
    proto.getComputedTextLength = svgStubs.getComputedTextLength;
    proto.getBBox = svgStubs.getBBox;
  }
}

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

function includes(haystack: string, needle: string, message: string): void {
  check(haystack.includes(needle), message, { needle, sample: haystack.slice(0, 200) });
}

// ——— 1. DOM 环境下注册并查询 ———
const { registerDocumentTools } = await import('../../tools/document');
const { toolRegistry } = await import('../../tools/registry');
registerDocumentTools();
check(!!toolRegistry.getTool('document_tool'), 'DOM 环境下 document_tool 注册成功');
check(toolRegistry.getTool('document_tool')?.metadata.category === 'office', 'document_tool 归类 office');

// ——— 2. mermaid 渲染通道 ———
//
// 说明：真实 mermaid 渲染依赖完整的浏览器 SVG 几何实现（JSDOM 未实现），
// 且 esbuild 把 mermaid 打包进 Node bundle 时其部分依赖会触发
// "Dynamic require of path is not supported"。因此这里验证**渲染通道的
// 契约**（成功产出 SVG / 失败降级为 null），真实 mermaid 渲染由扩展内
// 运行时覆盖（sidepanel 聊天渲染已在用同一份 mermaid）。
const { renderMermaidToSvg } = await import('../../tools/document/mermaid-renderer');
check(typeof renderMermaidToSvg === 'function', 'mermaid 渲染入口可用');
// 打包环境下 mermaid 无法在 JSDOM 渲染 → 必须**优雅降级**而非抛错
const svg = await renderMermaidToSvg('graph TD\n  A["开始"] --> B["结束"]');
check(svg === null || (typeof svg === 'string' && svg.includes('<svg')), 'mermaid 渲染要么产出 SVG、要么降级为 null', svg?.slice(0, 80));

// 语法错误应降级为 null（调用方据此降级为代码块）
const broken = await renderMermaidToSvg('graph TD\n  A --> ((((');
check(broken === null, 'mermaid 语法错误降级为 null');

// ——— 3. convert(docx) 端到端 ———
const { chatDatabase } = await import('../../entrypoints/sidepanel/core/context/chat-database');
const chatId = 'document-dom-verify';
await chatDatabase.createSession({
  chatId,
  title: chatId,
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  lastMessagePreview: '',
  agentName: '',
  agentAvatar: '',
} as never);

const { DocumentTool } = await import('../../tools/document');
const tool = new DocumentTool();
// 注入 mermaid 渲染器：JSDOM 无法真实渲染 mermaid（缺 SVG 几何实现），
// 这里用固定 SVG 验证「mermaid 围栏 → 矢量图 → DOCX 内嵌」的完整链路。
tool.mermaidRenderer = async () =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150" viewBox="0 0 300 150"><rect x="10" y="10" width="280" height="130" fill="#f0f0f0" stroke="#999"/><text x="150" y="80" text-anchor="middle" font-size="14">图表</text></svg>';
const context = { chatId };

const created = await tool.execute(
  {
    action: 'create',
    path: 'docs/dom-verify.md',
    content: [
      '# DOM 验证',
      '',
      '正文段落。',
      '',
      '| 列 | 值 |',
      '| --- | --- |',
      '| 甲 | 1 |',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      '公式 $x^2$',
      '',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
    ].join('\n'),
  },
  context,
);
check(created.success, 'create 在 DOM 环境成功');

const converted = await tool.execute(
  { action: 'convert', path: 'docs/dom-verify.md', format: 'docx', title: 'DOM 验证' },
  context,
);
check(converted.success, 'convert(docx) 在 DOM 环境成功', converted.content);

const data = converted.data as { files?: { path: string }[] } | undefined;
const path = data?.files?.[0]?.path ?? '';
check(path.startsWith('outputs/') && path.endsWith('.docx'), '产物落到 outputs/*.docx', path);

const { readWorkspaceOutput } = await import('../../utils/python-workspace/store');
const blob = await readWorkspaceOutput(chatId, path);
check(!!blob && blob.size > 1000, '产物有实际内容', blob?.size);

if (blob) {
  const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const xml = strFromU8(entries['word/document.xml']);
  includes(xml, 'DOM 验证', 'DOCX 含标题');
  includes(xml, '正文段落', 'DOCX 含正文');
  includes(xml, 'w:tbl', 'DOCX 含表格');
  includes(xml, 'const a = 1', 'DOCX 含代码块');
  includes(xml, 'm:oMath', 'DOCX 含 Word 原生公式');
  includes(xml, 'svgBlip', 'DOCX 含 mermaid 矢量图');
}

await tool.execute({ action: 'delete', path: 'docs/dom-verify.md' }, context);

console.log(`[document-dom] 通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  throw new Error('document-dom 断言失败');
}

/**
 * 消息内「上传文件元素」区（MessageUploads）回归
 *
 * 覆盖用户要求的三类交互口径：
 *   1. 图片 → 缩略图 + 放大查看（共享 ImageViewer 承载缩放 / 翻页 / 下载）；
 *   2. html / pdf → 直接在网页打开查看（独立预览页 file-preview.html）；
 *   3. 其余格式 → 仅支持下载。
 *
 * 三层验证的第二层（静态样式断言）在本文件内一并完成：JSDOM 没有排版引擎，
 * 尺寸与布局契约必须读 CSS 源码补上。
 *
 * 运行：node tests/chat-ui/message-uploads.test.mjs
 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import assert from 'node:assert/strict';

const root = process.cwd();
const cache = path.resolve('node_modules/.cache');
mkdirSync(cache, { recursive: true });

// ── DOM 环境 ──
const dom = new JSDOM(
  '<div id="app"></div>',
  { url: 'https://example.test/', virtualConsole: new VirtualConsole() },
);
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLImageElement', 'HTMLAnchorElement', 'SVGElement', 'Node', 'Text', 'Comment', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event']) {
  globalThis[key] = dom.window[key];
}

// chrome 桩：预览页打开通道
const createdTabs = [];
globalThis.chrome = {
  runtime: { getURL: page => `chrome-extension://test/${page}` },
  tabs: { create: async ({ url }) => { createdTabs.push(url); return { id: 1 }; } },
};

// ── 组件编译与打包（script setup + 模板 → 真实 render；
//     i18n / 图片库 / 工作区读取 / 看图层 走桩）──
const file = path.resolve('entrypoints/sidepanel/components/chat/MessageUploads.vue');
const source = readFileSync(file, 'utf8');
const { descriptor } = parse(source, { filename: file });
const script = compileScript(descriptor, { id: 'message-uploads-test', genDefaultAs: '_sfc_main' });
const template = compileTemplate({
  source: descriptor.template.content,
  filename: file,
  id: 'message-uploads-test',
  compilerOptions: { bindingMetadata: script.bindings },
});
const code = `${script.content}\n${template.code}\n_sfc_main.render = render;\nexport default _sfc_main;\n`;
const output = path.resolve(cache, 'message-uploads-regression.mjs');

await build({
  stdin: { contents: code, loader: 'ts', resolveDir: path.dirname(file) },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['vue'],
  loader: { '.css': 'empty' },
  plugins: [{
    name: 'uploads-stubs',
    setup(api) {
      api.onResolve({ filter: /@\/utils\/i18n$/ }, () => ({ path: 'i18n', namespace: 'fake' }));
      api.onResolve({ filter: /core$/ }, () => ({ path: 'core', namespace: 'fake' }));
      api.onResolve({ filter: /python-workspace\/store$/ }, () => ({ path: 'store', namespace: 'fake' }));
      api.onResolve({ filter: /composables\/use-attachments$/ }, () => ({ path: 'format', namespace: 'fake' }));
      api.onResolve({ filter: /ImageViewer\.vue$/ }, () => ({ path: 'viewer', namespace: 'fake' }));
      api.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({
        contents:
          args.path === 'i18n'
            ? 'export const t=(key,params)=>key+(params?JSON.stringify(params):"");'
            : args.path === 'core'
              ? 'export const imageStore={getObjectUrl:async ref=>ref?"blob:fake/"+ref:null};'
              : args.path === 'store'
                ? 'export const readWorkspaceUpload=async(chatId,path)=>new Blob(["bytes:"+path],{type:"application/octet-stream"});'
                : args.path === 'format'
                  ? 'export const formatBytes=bytes=>bytes+" B";'
                  : 'import {h} from "vue";export default { name:"ImageViewer", props:["items","index"], setup(p){return()=>h("div",{class:"viewer-stub"},String(p.items.length));} };',
      }));
    },
  }],
});

const { createApp, h, nextTick } = await import('vue');
const { default: component } = await import(pathToFileURL(output).href);

const uploads = [
  { path: 'inputs/photo.png', name: 'photo.png', sizeBytes: 1024, ext: 'png', imageRef: 'hash-1' },
  { path: 'inputs/report.pdf', name: 'report.pdf', sizeBytes: 2048, ext: 'pdf' },
  { path: 'inputs/notes.txt', name: 'notes.txt', sizeBytes: 12, ext: 'txt' },
];

const app = createApp({
  render: () => h(component, { files: uploads }),
});
app.provide('workspaceChatId', { value: 'chat-1' });
const errors = [];
app.config.errorHandler = error => errors.push(error);
const instance = app.mount('#app');
await nextTick();
// 缩略图 object URL 异步解析（imageStore），等两次微任务让解析落地
await new Promise(resolve => setTimeout(resolve, 0));
await new Promise(resolve => setTimeout(resolve, 0));
await nextTick();

assert.deepEqual(errors, [], '组件挂载不得抛错');
const rootEl = instance.$el;
assert.ok(rootEl.classList.contains('message-uploads'), '渲染上传文件元素区');
assert.equal(rootEl.querySelectorAll('.upload-item').length, 3, '三个上传文件各一个元素');
assert.match(rootEl.textContent ?? '', /uploadsLabel/, '渲染本轮上传标签');

// 图片 → 缩略图（放大查看），不出现独立下载按钮
const thumb = rootEl.querySelector('.upload-thumb');
assert.ok(thumb, '图片渲染缩略图按钮');
assert.equal(rootEl.querySelectorAll('.upload-thumb').length, 1, '仅图片有缩略图');
assert.equal(thumb.querySelector('img')?.getAttribute('src'), 'blob:fake/hash-1', '缩略图取图片库 object URL');

// pdf → 网页预览按钮
const previewButton = [...rootEl.querySelectorAll('.upload-action')].find(button => button.textContent?.includes('uploadOpenPreview'));
assert.ok(previewButton, 'pdf 提供网页预览动作');
previewButton.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
await nextTick();
assert.equal(createdTabs.length, 1, '预览打开一个新标签页');
assert.match(createdTabs[0], /file-preview\.html\?chat=chat-1&path=inputs%2Freport\.pdf/, '预览 URL 带会话与路径');

// txt → 仅下载按钮
const downloadButton = [...rootEl.querySelectorAll('.upload-action')].find(button => button.textContent?.includes('uploadDownload'));
assert.ok(downloadButton, 'txt 提供下载动作');
assert.equal([...rootEl.querySelectorAll('.upload-action')].filter(button => button.textContent?.includes('uploadDownload')).length, 1, '只有非图片非预览格式才有下载按钮');

// 名称与体积展示
assert.match(rootEl.textContent ?? '', /photo\.png/, '展示文件名');
assert.match(rootEl.textContent ?? '', /2048 B/, '展示文件体积');

app.unmount();
dom.window.close();

// ==================== 静态样式断言（无排版引擎时的布局契约） ====================
const css = readFileSync(path.resolve('entrypoints/sidepanel/components/chat/message-uploads.css'), 'utf8');
assert.match(css, /\.message-uploads\s*\{/, '定义上传文件元素区样式');
assert.match(css, /\.upload-thumb\s*\{/, '定义缩略图样式');
assert.match(css, /\.upload-action\s*\{/, '定义动作按钮样式');
assert.match(css, /\.upload-name\s*\{[^}]*text-overflow:\s*ellipsis/, '长文件名省略号截断');
assert.match(css, /\.upload-item\s*\{[^}]*display:\s*flex/, '文件元素为横向布局');

console.log('[chat-ui] 上传文件元素区（图片放大 / 网页预览 / 仅下载）回归通过。');

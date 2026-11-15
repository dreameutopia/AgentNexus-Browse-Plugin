/**
 * 回答内截图（<agent-image>）渲染 + 共享看图层回归
 *
 * 覆盖用户提出的三条要求：
 *   1. 卡片底部不再出现短 id 标题（"截图 6zxtjw14"）——只展示图片本身，
 *      画面说明（alt）移到图片 title 悬浮提示，短 id 继续作为下载文件名；
 *   2. 点击图片在侧边栏内挂载遮罩看图层（共享 ImageViewer，Teleport 到 body）；
 *   3. 看图层底部按钮组齐备：缩小 / 放大 / 在网页中打开 / 下载。
 *
 * 三层验证的第二层（静态样式断言）在本文件内一并完成：JSDOM 没有排版引擎，
 * 尺寸与布局契约必须读 CSS 源码补上。
 *
 * 运行：node tests/chat-ui/agent-image-viewer.test.mjs
 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import assert from 'node:assert/strict';

const root = process.cwd();
const cache = path.resolve('node_modules/.cache');
mkdirSync(cache, { recursive: true });

// ── DOM 环境（JSDOM；空 VirtualConsole 吞掉 anchor 点击的导航告警）──
const dom = new JSDOM(
  '<div id="app"></div><div id="fixture"></div>',
  { url: 'https://example.test/', virtualConsole: new VirtualConsole() },
);
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLImageElement', 'HTMLAnchorElement', 'SVGElement', 'Node', 'Text', 'Comment', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event']) {
  globalThis[key] = dom.window[key];
}
const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

// ==================== 一、渲染层：图片注入与卡片形态 ====================
const rendererFile = path.resolve('entrypoints/sidepanel/utils/chat/agent-image-renderer.ts');
const rendererOut = path.resolve(cache, 'agent-image-renderer.mjs');
await build({
  stdin: { contents: readFileSync(rendererFile, 'utf8'), loader: 'ts', resolveDir: path.dirname(rendererFile) },
  outfile: rendererOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [{
    name: 'renderer-stubs',
    setup(api) {
      api.onResolve({ filter: /@\/utils\/i18n$/ }, () => ({ path: 'i18n', namespace: 'fake' }));
      api.onResolve({ filter: /core\/images\/image-store$/ }, () => ({ path: 'store', namespace: 'fake' }));
      api.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({
        contents: args.path === 'i18n'
          ? 'export const t=key=>key;'
          : 'export const imageStore={resolveShortId:async id=>id==="abcd1234"?"hash-ref-1":null,getObjectUrl:async ref=>ref?"blob:fake/"+ref:null};',
      }));
    },
  }],
});
const renderer = await import(pathToFileURL(rendererOut).href);

const fixture = document.getElementById('fixture');
fixture.innerHTML =
  '<div class="agent-image-card" data-agent-image-id="abcd1234" data-agent-image-alt="订单已提交" data-agent-image-state="pending">' +
  '<div class="agent-image-body"><span class="agent-image-placeholder">loading</span></div></div>';
renderer.installAgentImageRenderer();
renderer.processAgentImages(fixture);
await settle();

const card = fixture.querySelector('.agent-image-card');
assert.ok(card, '截图引用卡片应存在');
const image = card.querySelector('.agent-image-body img');
assert.ok(image, '图片本体应注入卡片');
assert.equal(card.dataset.agentImageState, 'done', '卡片状态应推进到 done');
assert.equal(card.dataset.agentImageRef, 'hash-ref-1', '卡片应带上内容哈希引用（下载取 MIME 用）');
assert.equal(
  card.querySelector('.agent-image-caption'),
  null,
  '卡片底部不再出现短 id 标题（"截图 abcd1234"）',
);
assert.equal(image.getAttribute('alt'), '订单已提交', '图片保留 alt（无障碍名）');
assert.equal(
  image.getAttribute('title'),
  '订单已提交',
  '画面说明移到 title 悬浮提示（信息不丢，只是不再占底部一行）',
);

// ==================== 二、点击 → 派发看图层请求 ====================
let openDetail = null;
document.addEventListener(renderer.AGENT_IMAGE_OPEN_EVENT, event => {
  openDetail = event.detail;
});
image.click();
assert.ok(openDetail, '点击截图应派发看图层请求事件');
assert.equal(openDetail.ref, 'hash-ref-1', '载荷携带内容哈希引用');
assert.equal(openDetail.name, 'screenshot-abcd1234', '短 id 继续作为下载文件名主干');
assert.equal(openDetail.alt, '订单已提交', '载荷携带画面说明');
assert.ok(openDetail.url.startsWith('blob:'), '载荷携带可展示的 object URL');

// ==================== 三、共享看图层：遮罩 + 四键按钮组 ====================
const viewerFile = path.resolve('entrypoints/sidepanel/components/chat/ImageViewer.vue');
const { descriptor } = parse(readFileSync(viewerFile, 'utf8'), { filename: viewerFile });
const viewerScript = compileScript(descriptor, { id: 'image-viewer-test', inlineTemplate: true });
const viewerOut = path.resolve(cache, 'image-viewer-test.mjs');
await build({
  stdin: { contents: viewerScript.content, loader: 'ts', resolveDir: path.dirname(viewerFile) },
  outfile: viewerOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['vue'],
  loader: { '.css': 'empty' },
  plugins: [{
    name: 'viewer-stubs',
    setup(api) {
      api.onResolve({ filter: /@\/utils\/i18n$/ }, () => ({ path: 'i18n', namespace: 'fake' }));
      api.onResolve({ filter: /core$/ }, () => ({ path: 'core', namespace: 'fake' }));
      api.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({
        contents: args.path === 'i18n'
          ? 'export const t=key=>key;'
          : 'export const imageStore={getObjectUrl:async()=>null,getMeta:async()=>({mime:"image/png",byteSize:1})};',
      }));
    },
  }],
});

const opened = [];
dom.window.open = (...args) => {
  opened.push(args);
  return { opener: null };
};
const downloads = [];
dom.window.HTMLAnchorElement.prototype.click = function () {
  downloads.push({ download: this.download, href: this.href });
};

const { createApp, h, nextTick } = await import('vue');
const { default: ImageViewer } = await import(pathToFileURL(viewerOut).href);
let closed = false;
const app = createApp({
  render: () => h(ImageViewer, {
    items: [{ ref: 'hash-ref-1', url: 'blob:fake/hash-ref-1', name: 'screenshot-abcd1234', alt: '订单已提交' }],
    index: 0,
    onClose: () => { closed = true; },
  }),
});
app.mount('#app');
await nextTick();
await settle();

const overlay = document.querySelector('.image-viewer');
assert.ok(overlay, '看图层遮罩应渲染在侧边栏文档内');
assert.equal(overlay.getAttribute('role'), 'dialog', '遮罩是模态对话框');

const toolbar = overlay.querySelector('.viewer-toolbar');
assert.ok(toolbar, '底部按钮组存在');
const buttons = [...toolbar.querySelectorAll('.viewer-btn')];
const labels = buttons.map(button => button.textContent.trim());
assert.ok(
  labels.includes('sidepanel.chat.imageZoomOut'),
  `按钮组应含「缩小」，实际：${JSON.stringify(labels)}`,
);
assert.ok(
  labels.includes('sidepanel.chat.imageZoomIn'),
  `按钮组应含「放大」，实际：${JSON.stringify(labels)}`,
);
assert.ok(
  labels.includes('sidepanel.chat.imageOpenInBrowser'),
  `按钮组应含「在网页中打开」，实际：${JSON.stringify(labels)}`,
);
assert.ok(
  labels.includes('sidepanel.chat.imageDownload'),
  `按钮组应含「下载」，实际：${JSON.stringify(labels)}`,
);
assert.equal(buttons.length, 4, '按钮组恰好四个动作（无多余项）');

const viewerImage = overlay.querySelector('img.viewer-img');
assert.ok(viewerImage, '看图层展示图片本体');
assert.equal(viewerImage.getAttribute('alt'), '订单已提交', '看图层沿用画面说明作为无障碍名');

// 缩放：原图尺寸未知前不放行；尺寸已知后按原始像素 × 档位给显式宽高
const zoomIn = buttons.find(button => button.textContent.includes('imageZoomIn'));
const zoomOut = buttons.find(button => button.textContent.includes('imageZoomOut'));
assert.equal(zoomIn.disabled, true, '原图尺寸未知时「放大」不可用');
assert.equal(zoomOut.disabled, true, '未放大时「缩小」不可用');
Object.defineProperty(viewerImage, 'naturalWidth', { value: 800, configurable: true });
Object.defineProperty(viewerImage, 'naturalHeight', { value: 600, configurable: true });
viewerImage.dispatchEvent(new dom.window.Event('load'));
await nextTick();
zoomIn.click();
await nextTick();
assert.equal(zoomIn.disabled, false, '原图尺寸已知后「放大」可用');
assert.match(viewerImage.getAttribute('style') ?? '', /width:\s*800px/, '放大按原始像素给出显式宽度');
assert.match(viewerImage.getAttribute('style') ?? '', /height:\s*600px/, '放大按原始像素给出显式高度');
zoomIn.click();
await nextTick();
assert.match(viewerImage.getAttribute('style') ?? '', /width:\s*1200px/, '再放大一档按 1.5 倍给宽');
zoomOut.click();
await nextTick();
assert.match(viewerImage.getAttribute('style') ?? '', /width:\s*800px/, '缩小回退一档');

// 在网页中打开：新标签页打开当前图片
const openButton = buttons.find(button => button.textContent.includes('imageOpenInBrowser'));
openButton.click();
assert.equal(opened.length, 1, '「在网页中打开」应打开一个新标签页');
assert.equal(opened[0][0], 'blob:fake/hash-ref-1', '新标签页打开的是当前图片 URL');
assert.equal(opened[0][1], '_blank', '新标签页打开');

// 下载：文件名带短 id，扩展名按 MIME
const downloadButton = buttons.find(button => button.textContent.includes('imageDownload'));
downloadButton.click();
await settle();
assert.equal(downloads.length, 1, '「下载」应触发一次下载');
assert.equal(downloads[0].download, 'screenshot-abcd1234.png', '下载文件名沿用短 id 与 MIME 扩展名');

// 关闭
overlay.querySelector('.viewer-close').click();
assert.equal(closed, true, '关闭按钮应回传关闭事件');

// ==================== 四、静态样式断言（尺寸 / 布局契约） ====================
const viewerCss = readFileSync(path.resolve('entrypoints/sidepanel/components/chat/image-viewer.css'), 'utf8');
assert.match(viewerCss, /\.viewer-img\s*\{[^}]*margin:\s*auto/, '图片用 margin:auto 居中（溢出时可滚动到底）');
assert.match(viewerCss, /\.viewer-img\.zoomed\s*\{[^}]*max-width:\s*none/, '放大态解除宽度约束');
assert.match(viewerCss, /\.viewer-toolbar\s*\{[^}]*flex-wrap:\s*wrap/, '按钮组允许换行（窄侧边栏不横向溢出）');
assert.match(viewerCss, /\.viewer-toolbar\s*\{[^}]*max-width:\s*calc\(100vw - 24px\)/, '按钮组不超出视口宽度');
assert.match(viewerCss, /\.viewer-stage\s*\{[^}]*align-items:\s*flex-start/, '舞台顶对齐（放大后顶部不被裁掉）');
const listCss = readFileSync(path.resolve('entrypoints/sidepanel/components/chat/chat-message-list.css'), 'utf8');
assert.equal(
  /\.agent-image-caption/.test(listCss),
  false,
  '截图卡片不再保留短 id 标题样式（元素已下线）',
);
assert.match(listCss, /\.agent-image-card \.agent-image-body img\s*\{[^}]*cursor:\s*zoom-in/, '图片仍提示可放大');

console.log('[agent-image-viewer] 卡片去标题、点击开遮罩看图层、缩小/放大/在网页中打开/下载四键按钮组回归通过。');
app.unmount();
dom.window.close();

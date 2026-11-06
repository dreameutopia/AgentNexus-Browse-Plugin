/**
 * API 错误卡片回归测试（「请求模型」浮层 / 重试按钮 / 分类配色 / 防御）
 *
 * 覆盖：
 *   1. 顶栏不再平铺「协议 / 模型 / 端点」三段文本——长端点 URL 会把顶栏撑开、
 *      把状态徽章挤到换行；现收进单个按钮点开的浮层卡
 *   2. 浮层默认隐藏，内容含协议 / 模型 / 端点三行（值来自卡片 data-*，与复制报告同源）
 *   3. 交互：点击展开、点击外部收起、Esc 收起并把焦点交还触发按钮
 *   4. 一键复制错误报告仍携带协议 / 模型 / 端点（改从 data-* 读取）
 *   5. 重试按钮：点击经 document 委托转发到应用层回调；注销后不再触发
 *   6. 分类配色钩子：卡片根节点带 kind-* 修饰类（CSS 据此切换分类配色）
 *   7. 防御：kind 白名单——存储层被篡改的非法 kind 归入 error，
 *      不向 class 注入任意 token
 *
 * 运行：node tests/chat-ui/api-error-card.test.mjs   （或 npm run test:chat-ui）
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const outfile = path.resolve('node_modules/.cache/api-error-card.mjs');
mkdirSync(path.dirname(outfile), { recursive: true });

await build({
  stdin: {
    contents: [
      "export { markdownRenderer } from './entrypoints/sidepanel/utils/chat/markdown-renderer';",
      "export { ApiRequestError, toApiErrorBlock } from './entrypoints/sidepanel/utils/stream/errors';",
      "export { t, setLocale } from './utils/i18n/core';",
      "export { setApiErrorRetryHandler } from './entrypoints/sidepanel/utils/chat/api-error-retry';",
    ].join('\n'),
    loader: 'ts',
    resolveDir: root,
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  loader: { '.css': 'empty' },
  plugins: [
    {
      name: 'alias-at',
      setup(api) {
        // '@/' → 仓库根；补齐 ts / index.ts 扩展名解析
        api.onResolve({ filter: /^@\// }, args => {
          const base = path.join(root, args.path.slice(2));
          for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
            if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate };
          }
          return { path: base };
        });
      },
    },
  ],
});

// —— DOM 环境（必须在导入被测模块之前就绪：模块加载时即安装 document 级委托）——
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'MouseEvent', 'KeyboardEvent']) {
  globalThis[key] = dom.window[key];
}
let copied = '';
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    language: 'zh-CN',
    clipboard: {
      writeText: async text => {
        copied = text;
      },
    },
  },
});

const { markdownRenderer, ApiRequestError, toApiErrorBlock, t, setLocale, setApiErrorRetryHandler } = await import(
  pathToFileURL(outfile).href
);
setLocale('zh-CN');

const PROVIDER = 'openai-responses';
const MODEL = 'gpt-4o-mini';
const URL = 'https://api.openai.com/v1/responses?beta=true';

const error = new ApiRequestError({
  provider: PROVIDER,
  model: MODEL,
  url: URL,
  status: 400,
  statusText: 'Bad Request',
  rawBody: '{"error":{"message":"unsupported parameter"}}',
});

const host = dom.window.document.createElement('div');
host.innerHTML = markdownRenderer.renderMessage(toApiErrorBlock(error));
dom.window.document.body.appendChild(host);

const card = host.querySelector('.api-error-card');
assert.ok(card, '应渲染出错误卡片');

// —— 1. 顶栏不再平铺协议 / 模型 / 端点 ——
assert.equal(
  host.querySelectorAll('.api-error-head .api-error-provider').length,
  0,
  '顶栏不应再平铺协议 / 模型 / 端点文本',
);
assert.equal(card.getAttribute('data-provider'), PROVIDER, '卡片应携带协议（data-provider）');
assert.equal(card.getAttribute('data-model'), MODEL, '卡片应携带模型（data-model）');
assert.equal(card.getAttribute('data-url'), URL, '卡片应携带端点（data-url）');

const button = card.querySelector('.api-error-model-btn');
assert.ok(button, '顶栏应有「请求模型」按钮');
assert.equal(button.getAttribute('aria-expanded'), 'false', '按钮初始为收起态');

// —— 2. 浮层默认隐藏，内容含三行 ——
const panel = card.querySelector('.api-error-model-panel');
assert.ok(panel, '按钮旁应有浮层面板');
assert.equal(panel.hidden, true, '浮层默认隐藏');
assert.equal(button.getAttribute('aria-controls'), panel.id, '按钮应指向浮层面板');
assert.equal(panel.querySelectorAll('.api-error-model-row').length, 3, '浮层应含协议 / 模型 / 端点三行');
assert.ok(panel.textContent.includes(MODEL), '浮层应展示模型名');
assert.ok(panel.textContent.includes(URL), '浮层应展示端点');
assert.ok(
  panel.textContent.includes(t('sidepanel.chat.apiErrorModelProtocol')),
  '浮层应有协议行标题',
);
assert.ok(panel.textContent.includes(t('sidepanel.chat.apiErrorModelModel')), '浮层应有模型行标题');
assert.ok(panel.textContent.includes(t('sidepanel.chat.apiErrorModelUrl')), '浮层应有端点行标题');

// —— 3. 交互：展开 / 收起 / Esc ——
const wrapper = card.querySelector('.api-error-model');
button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
assert.equal(panel.hidden, false, '点击按钮后浮层展开');
assert.equal(wrapper.classList.contains('is-open'), true, '展开态应有 is-open 类');
assert.equal(button.getAttribute('aria-expanded'), 'true', '展开后 aria-expanded 应为 true');

dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
assert.equal(panel.hidden, true, '点击浮层之外应收起');
assert.equal(wrapper.classList.contains('is-open'), false, '收起后 is-open 类应移除');

button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
assert.equal(panel.hidden, false, '再次点击应重新展开');
dom.window.document.dispatchEvent(
  new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
);
assert.equal(panel.hidden, true, 'Esc 应收起浮层');
assert.equal(dom.window.document.activeElement, button, 'Esc 后焦点应回到触发按钮');

// —— 4. 复制报告仍携带协议 / 模型 / 端点 ——
const copyButton = card.querySelector('.api-error-copy-btn');
assert.ok(copyButton, '卡片应有复制按钮');
copyButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(copied.includes(PROVIDER), '错误报告应携带协议');
assert.ok(copied.includes(MODEL), '错误报告应携带模型');
assert.ok(copied.includes(URL), '错误报告应携带端点');

// —— 5. 重试按钮：顶栏主操作，点击经 document 委托转发到应用层回调 ——
const retryButton = card.querySelector('.api-error-retry-btn');
assert.ok(retryButton, '卡片应有重试按钮');
assert.ok(retryButton.textContent.includes(t('sidepanel.chat.apiErrorRetry')), '重试按钮文案走 i18n');
let retryCalls = 0;
setApiErrorRetryHandler(() => {
  retryCalls++;
});
retryButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
assert.equal(retryCalls, 1, '点击重试应调用一次应用层回调');
setApiErrorRetryHandler(null);
retryButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
assert.equal(retryCalls, 1, '注销回调后点击重试不得再触发');

// —— 6. 分类配色钩子：卡片根节点带 kind-* 修饰类（CSS 据此切换分类配色）——
assert.equal(card.classList.contains('kind-http'), true, 'HTTP 错误卡应带 kind-http 修饰类');
const timeoutError = new ApiRequestError({ provider: 'openai', timeoutMs: 30000 });
const timeoutCardHost = dom.window.document.createElement('div');
timeoutCardHost.innerHTML = markdownRenderer.renderMessage(toApiErrorBlock(timeoutError));
dom.window.document.body.appendChild(timeoutCardHost);
assert.equal(
  timeoutCardHost.querySelector('.api-error-card')?.classList.contains('kind-timeout'),
  true,
  '超时错误卡应带 kind-timeout 修饰类',
);

// —— 7. 防御：kind 白名单——篡改的非法 kind 归入 error，不注入任意 class token ——
const tamperedHost = dom.window.document.createElement('div');
tamperedHost.innerHTML = markdownRenderer.renderMessage(
  '<api-error kind="http is-open" label="x"><summary>被篡改的块</summary></api-error>',
);
const tamperedCard = tamperedHost.querySelector('.api-error-card');
assert.ok(tamperedCard, '篡改块仍应渲染出卡片（信息不丢）');
assert.equal(tamperedCard.classList.contains('kind-error'), true, '非法 kind 应归入 error');
assert.equal(
  tamperedCard.classList.contains('is-open'),
  false,
  '篡改 kind 里的任意 token 不得进入 class',
);
assert.deepEqual(
  [...tamperedCard.classList].sort(),
  ['api-error-card', 'kind-error'],
  'class 应只含 api-error-card 与白名单 kind',
);

console.log('[chat-ui] API 错误卡片「请求模型」浮层回归测试通过。');
dom.window.close();

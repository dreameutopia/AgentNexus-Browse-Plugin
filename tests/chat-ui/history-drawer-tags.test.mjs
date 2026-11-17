/**
 * 历史会话抽屉 · 标签编辑与重命名回归
 *
 * 覆盖三层契约：
 *   1. JSDOM 结构/行为：打开编辑器草稿回显 → 添加 → 保存 → 列表渲染 →
 *      再次打开草稿仍在 → 抽屉重开（loadSessions）后仍在；
 *      输入框里未点「添加」的文本在保存时并入草稿（中文输入法 Enter 只确认
 *      候选词的场景，否则表现为「保存了却看不到标签」）；
 *      打开编辑器后焦点落在标签输入框（回归：v-for 内模板 ref 被编译成
 *      ref_for，value 变数组导致 focus 抛 TypeError）。
 *   2. 静态样式：重命名输入框/确认取消按钮走抽屉自有视觉语言（不再是 UA 默认按钮）。
 *   3. 图标：标签编辑按钮为纯标签形状（无铅笔叠层）。
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const file = path.resolve('entrypoints/sidepanel/components/chat/ChatHistoryDrawer.vue');
const source = readFileSync(file, 'utf8');
const { descriptor } = parse(source, { filename: file });
const script = compileScript(descriptor, { id: 'chat-history-drawer', inlineTemplate: true });
const out = path.resolve('node_modules/.cache/chat-history-drawer-test.mjs');
mkdirSync(path.dirname(out), { recursive: true });

// 编译产物不得再出现 ref_for：标签输入框位于 v-for 内，模板 ref 会被打成
// ref_for（Vue 运行时把值收集成数组），focus 必抛错——从源头锁死回归。
assert.ok(
  !script.content.includes('ref_for: true'),
  '标签输入框不得编译出 ref_for（v-for 内模板 ref 回归）',
);

// 静态样式断言（JSDOM 无排版引擎，尺寸/描边契约只能读 CSS；源文件为美化格式，允许换行与空格）
const css = readFileSync(
  path.resolve('entrypoints/sidepanel/components/chat/chat-history-drawer.css'),
  'utf8',
);
assert.match(
  css,
  /\.history-rename input\s*\{[^}]*border:\s*1px solid var\(--line-soft/,
  '重命名输入框使用抽屉描边令牌而非硬编码强调色',
);
assert.match(
  css,
  /\.history-rename input:focus\s*\{[^}]*box-shadow/,
  '重命名输入框聚焦有可见焦点环',
);
assert.match(
  css,
  /\.rename-confirm,\s*\.rename-cancel\s*\{[^}]*border:\s*1px solid/,
  '确认/取消按钮为描边胶囊（不再是 UA 默认按钮底）',
);
assert.match(
  css,
  /\.rename-confirm:hover\s*\{[^}]*background:\s*rgba\(16, 185, 129/,
  '确认按钮有悬停反馈',
);
assert.match(
  css,
  /\.rename-cancel:hover\s*\{[^}]*background:\s*rgba\(239, 68, 68/,
  '取消按钮有悬停反馈',
);

// 图标契约：标签编辑按钮的 path 不再包含铅笔叠层（M17.5,12.5L11,19…）
const tagEditButtonSource = source.slice(
  source.indexOf('data-tag-edit'),
  source.indexOf('data-tag-edit') + 600,
);
assert.ok(tagEditButtonSource.includes('M5.5,3H13.8L21,10.2'), '标签按钮保留标签外形路径');
assert.ok(
  !tagEditButtonSource.includes('M17.5,12.5L11,19'),
  '标签按钮已移除铅笔叠层，改为纯标签样式',
);

// In-memory session store standing in for transcriptEngine（引擎读写链路由
// chat-database.test.mjs 覆盖；本用例专注组件 UI 流）。
const seedSessions = [
  {
    chatId: 'chat-1', title: '会话一', createdAt: 1, updatedAt: Date.now(),
    messageCount: 4, lastMessagePreview: '预览内容', agentName: '文本通用助手',
    tags: [{ id: 'tag_seed', label: '种子标签' }],
  },
  {
    chatId: 'chat-2', title: '会话二', createdAt: 1, updatedAt: Date.now() - 5000,
    messageCount: 2, lastMessagePreview: '另一预览', agentName: '文本通用助手',
  },
];

await build({
  stdin: { contents: script.content, loader: 'ts', resolveDir: path.dirname(file) },
  outfile: out, bundle: true, platform: 'node', format: 'esm', external: ['vue'],
  plugins: [{
    name: 'drawer-test-stubs', setup(api) {
      api.onResolve({ filter: /\/core$/ }, () => ({ path: 'core-stub', namespace: 'stub' }));
      api.onLoad({ filter: /^core-stub$/, namespace: 'stub' }, () => ({
        resolveDir: process.cwd(),
        contents: `
          const store = globalThis.__drawerSessions;
          export const transcriptEngine = {
            async listSessions() {
              return store.list.map(s => ({ ...s, tags: s.tags ? s.tags.map(t => ({ ...t })) : undefined }));
            },
            async setSessionTags(chatId, tags) {
              const item = store.list.find(s => s.chatId === chatId);
              if (!item) return null;
              store.calls.push({ chatId, tags: tags.map(t => ({ ...t })) });
              if (tags.length > 0) item.tags = tags.map(t => ({ ...t })); else delete item.tags;
              return { ...item, tags: item.tags ? item.tags.map(t => ({ ...t })) : undefined };
            },
            async renameSession(chatId, title) {
              const item = store.list.find(s => s.chatId === chatId);
              if (!item) return null;
              item.title = title;
              return { ...item };
            },
          };
          export const agentEngine = { resolveRef: (id, name) => (name ? { id, name } : null) };
          export const sessionDeletionEngine = { async deleteSession() { return { issues: [] }; } };
        `,
      }));
      api.onResolve({ filter: /^@\/utils\/i18n$/ }, () => ({ path: 'i18n-stub', namespace: 'stub' }));
      api.onLoad({ filter: /^i18n-stub$/, namespace: 'stub' }, () => ({
        resolveDir: process.cwd(),
        contents: `export const t = (key, values) => { let text = key; for (const [n, v] of Object.entries(values || {})) text = text.replace('{' + n + '}', String(v)); return text; };`,
      }));
      api.onResolve({ filter: /use-app-dialog$/ }, () => ({ path: 'dialog-stub', namespace: 'stub' }));
      api.onLoad({ filter: /^dialog-stub$/, namespace: 'stub' }, () => ({
        resolveDir: process.cwd(), contents: `export const showConfirm = async () => true;`,
      }));
      api.onResolve({ filter: /use-agent-display$/ }, () => ({ path: 'agent-display-stub', namespace: 'stub' }));
      api.onLoad({ filter: /^agent-display-stub$/, namespace: 'stub' }, () => ({
        resolveDir: process.cwd(),
        contents: `export const useAgentDisplay = () => ({ displayNameOf: agent => agent?.name ?? '' });`,
      }));
      // '@/' 别名 → 项目根（esbuild 不给无扩展名路径自动补 .ts，按存在性补全）
      api.onResolve({ filter: /^@\// }, args => {
        const base = path.resolve(process.cwd(), args.path.slice(2));
        for (const candidate of [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts')]) {
          if (existsSync(candidate)) return { path: candidate };
        }
        return { path: base };
      });
    },
  }],
});

const dom = new JSDOM('<div id="app"></div>', { url: 'https://extension.test/' });
// Document/ShadowRoot：Vue v-model 的 beforeUpdate 用 `instanceof Document` 判焦点，
// 不拷贝会在 JSDOM 下抛 ReferenceError（浏览器环境天然存在，非产品缺陷）
for (const key of ['window', 'document', 'Document', 'ShadowRoot', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'])
  if (dom.window[key]) globalThis[key] = dom.window[key];
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = id => clearTimeout(id);
}

globalThis.__drawerSessions = { list: seedSessions, calls: [] };

const { createApp, h, reactive } = await import('vue');
const { default: Drawer } = await import(pathToFileURL(out).href);
const props = reactive({ visible: false, activeChatId: 'chat-1' });
const app = createApp({
  setup: () => () => h(Drawer, { ...props, onClose: () => { props.visible = false; } }),
});
app.directive('tip', {}); // v-tip 在子组件模板中解析，须注册为全局指令
const runtimeErrors = [];
app.config.errorHandler = error => runtimeErrors.push(error);
process.on('unhandledRejection', error => runtimeErrors.push(error));
app.mount('#app');
// 抽屉只在 visible 翻转为 true 时加载列表（与真实打开路径一致）
props.visible = true;

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
const items = () => [...document.querySelectorAll('.history-item')];
const tagEditBtn = (i = 0) => items()[i].querySelector('[data-tag-edit]');
const editor = () => document.querySelector('.history-tag-editor');
const tagInput = () => editor()?.querySelector('.history-tag-editor-input');
const draftChips = () => editor()
  ? [...editor().querySelectorAll('.history-tag')].map(el => el.textContent.trim().replace(/\s+$/, ''))
  : null;
const listChips = i => [...items()[i].querySelectorAll('.history-item-tags .history-tag')].map(el => el.textContent.trim());
const saveBtn = () => [...editor().querySelectorAll('button')].find(b => b.classList.contains('primary'));

await settle();
assert.equal(items().length, 2, '会话列表渲染');
assert.deepEqual(listChips(0), ['种子标签'], '已有标签在列表中渲染');

// ── 打开编辑器：草稿带出已有标签，焦点落在标签输入框（ref_for 回归点） ──
tagEditBtn(0).click(); await settle();
assert.ok(editor(), '编辑器打开');
assert.deepEqual(draftChips(), ['种子标签'], '打开编辑器草稿带出已有标签');
assert.equal(
  document.activeElement, tagInput(),
  '焦点落在标签输入框（v-for 内模板 ref 不再被编译成 ref_for）',
);

// ── 添加标签 ──
const input = tagInput();
input.value = '新标签A';
input.dispatchEvent(new Event('input', { bubbles: true }));
await settle();
editor().querySelector('.history-tag-editor-add').click(); await settle();
assert.deepEqual(draftChips(), ['种子标签', '新标签A'], '添加后草稿含两个标签');

// ── 保存 → 列表渲染 → 再次打开草稿仍在 ──
saveBtn().click(); await settle();
assert.equal(globalThis.__drawerSessions.calls.length, 1, '保存被调用');
assert.deepEqual(listChips(0), ['种子标签', '新标签A'], '保存后列表渲染标签');
tagEditBtn(0).click(); await settle();
assert.deepEqual(draftChips(), ['种子标签', '新标签A'], '再次打开编辑器草稿仍见已保存标签');
// 取消收起，为下一个场景复位
[...editor().querySelectorAll('button')].find(b => b.textContent.includes('tagsCancel')).click();
await settle();

// ── 输入框残留文本在保存时并入（中文输入法 Enter 只确认候选词的场景） ──
tagEditBtn(0).click(); await settle();
const pending = tagInput();
pending.value = '未点添加的标签';
pending.dispatchEvent(new Event('input', { bubbles: true }));
await settle();
saveBtn().click(); await settle();
assert.equal(globalThis.__drawerSessions.calls.length, 2, '第二次保存被调用');
assert.deepEqual(
  globalThis.__drawerSessions.calls[1].tags.map(t => t.label),
  ['种子标签', '新标签A', '未点添加的标签'],
  '保存把输入框残留文本并入草稿一并落库',
);
assert.deepEqual(listChips(0), ['种子标签', '新标签A', '未点添加的标签'], '残留文本并入后列表渲染');

// ── 抽屉关闭再打开（loadSessions 重载路径） ──
[...document.querySelectorAll('button')].find(b => b.classList.contains('history-close-btn'))?.click();
await settle();
props.visible = true; await settle();
assert.deepEqual(listChips(0), ['种子标签', '新标签A', '未点添加的标签'], '抽屉重开后标签仍在');

// ── 重命名 UI：输入框 + 描边确认/取消按钮（样式契约见静态断言） ──
items()[1].querySelector('.item-op:nth-child(2)').click(); await settle();
const renameInput = document.querySelector('.history-rename input');
assert.ok(renameInput, '重命名输入框存在');
assert.equal(renameInput.value, '会话二');
assert.ok(document.querySelector('.rename-confirm'), '确认按钮存在');
assert.ok(document.querySelector('.rename-cancel'), '取消按钮存在');

assert.deepEqual(runtimeErrors, [], '交互全程无运行时错误（focus/ref 回归）');

app.unmount();
console.log('[history-drawer] tag edit/save/flush/reopen/reload, focus and rename UI passed.');

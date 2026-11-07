/**
 * 管理中心 · 技能编辑器（高级模式）回归测试
 *
 * 覆盖本轮重构的关键契约：
 *   1. 模式切换控件位于标题栏右侧、且在「返回列表」按钮左侧；
 *   2. 实时校验面板位于文件树与文件编辑器**下方**（通栏状态条），不再嵌在编辑器内部；
 *   3. 文件树为 VS Code 式结构：入口文件置顶、目录行可折叠、文件行可拖拽，
 *      行内无任何左侧色条（CSS 源码级断言）；
 *   4. 文件树交互：新建文件（可带目录前缀）、拖拽移入目录、拖回根目录、
 *      同级重排；移动后路径与选中态同步。
 *
 * 运行：node tests/hub/skill-editor.test.mjs
 * 产物写入 node_modules/.cache（仓库内缓存，天然被 git 忽略）。
 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const outfile = path.resolve('node_modules/.cache/hub-skill-editor-test.mjs');
mkdirSync(path.dirname(outfile), { recursive: true });

// ──── 打包：真实 SkillManager + 真实控件，存储层与 i18n 用可控替身 ────

await build({
  stdin: {
    contents: `
export { default as SkillManager } from './entrypoints/hub/skills/SkillManager.vue';
export { __skills } from './utils/skills/skill-store';
`,
    resolveDir: root,
    loader: 'ts',
  },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['vue'],
  loader: { '.css': 'empty' },
  alias: { '@': root },
  plugins: [
    {
      name: 'hub-stubs',
      setup(api) {
        // i18n：直接读真实 zh-CN 文案（键对齐由 tests/i18n 保证）
        api.onResolve({ filter: /@\/utils\/i18n$/ }, args => ({ path: args.path, namespace: 'locale' }));
        api.onLoad({ filter: /.*/, namespace: 'locale' }, () => ({
          contents: `import {ref} from 'vue'; import zh from '${path.resolve('utils/i18n/locales/zh-CN.ts').replaceAll('\\', '/')}';
export const t=(key,p={})=>String(key.split('.').reduce((v,k)=>v?.[k],zh)??key).replace(/\\{(\\w+)\\}/g,(_,k)=>p[k]??'');
export const useLocale=()=>({locale:ref('zh-CN'),switchLocale:()=>{}});export const LOCALE_OPTIONS=[];`,
          resolveDir: root,
        }));
        // 技能存储：内存替身（本用例只关心编辑器交互，不关心持久层）
        // 同时覆盖 '@/utils/skills/skill-store' 与 utils/skills 内部的相对导入
        // （统一映射到同一 path，确保组件与测试入口拿到同一个模块实例）
        api.onResolve({ filter: /skill-store$/ }, () => ({ path: 'skill-store-stub', namespace: 'skill-store' }));
        api.onLoad({ filter: /.*/, namespace: 'skill-store' }, () => ({
          contents: `
export const __skills = new Map();
const listeners = new Set();
export function getAllSkills(){ return [...__skills.values()]; }
export function onSkillsChange(fn){ listeners.add(fn); return () => listeners.delete(fn); }
export function setCustomSkill(input){
  const record = { source:'custom', enabled:true, tags:[], allowedTools:[], category:'general', updatedAt:Date.now(), ...input };
  __skills.set(record.id, record);
  for (const fn of listeners) fn();
  return { ok:true, skill:record };
}
export function removeCustomSkill(id){ __skills.delete(id); for (const fn of listeners) fn(); }
export function setSkillEnabled(id, enabled){ const s=__skills.get(id); if(s){ s.enabled=enabled; for (const fn of listeners) fn(); } }
export function flushSkillStoreWrites(){ return Promise.resolve({ ok:true }); }
export function rollbackCustomSkills(){}
export function snapshotCustomSkills(){ return {}; }
`,
        }));
        // 智能体存储：分类选择器会读它
        api.onResolve({ filter: /@\/utils\/agents\/agent-store$/ }, args => ({ path: args.path, namespace: 'agent-store' }));
        api.onLoad({ filter: /.*/, namespace: 'agent-store' }, () => ({
          contents: `export function getAllAgents(){ return []; } export function onAgentsChange(){ return () => {}; }`,
        }));
        // 学习交接：与本用例无关的空实现
        api.onResolve({ filter: /@\/utils\/learn\/learn-draft-store$/ }, args => ({ path: args.path, namespace: 'learn-store' }));
        api.onLoad({ filter: /.*/, namespace: 'learn-store' }, () => ({
          contents: `
export const LEARN_TRANSFER_MARKER = 'x-agentnexus-learn-transfer';
export async function readLearnDraft(){ return { status:'not-found' }; }
export async function claimLearnDraftEditor(){ return { ok:false, error:'stub' }; }
export async function saveLearnDraftEditor(){ return { ok:true }; }
export async function completeLearnDraft(){ return { ok:true }; }
export function isLearnDraftEditorState(){ return false; }
`,
        }));
        api.onLoad({ filter: /\.vue$/ }, args => {
          const real = /hub[\\/]skills[\\/]SkillManager\.vue$|hub[\\/]skills[\\/]SkillDraftConfirm\.vue$|hub[\\/]components[\\/](CategorySelect|TagInput|HubSelect|HubSwitch|HubSegmented)\.vue$/.test(args.path);
          if (!real) return { contents: `export default {render:()=>null};`, loader: 'js' };
          const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
          return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content, loader: 'ts', resolveDir: path.dirname(args.path) };
        });
      },
    },
  ],
  logLevel: 'silent',
});

// ──── 宿主 ────

const dom = new JSDOM('<div id="app"></div>', { url: 'https://extension.test/hub.html' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver', 'localStorage']) {
  globalThis[key] = dom.window[key];
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.chrome = { storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } }, onChanged: { addListener() {}, removeListener() {} } };

const api = await import(pathToFileURL(outfile).href);
const { createApp, nextTick } = await import('vue');
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { await tick(); await nextTick(); };

// ──── 种子技能（带一个目录 + 两个资源文件） ────

api.__skills.set('demo-skill', {
  id: 'demo-skill',
  name: 'demo-skill',
  description: '示例技能',
  category: 'general',
  tags: [],
  allowedTools: [],
  enabled: true,
  source: 'custom',
  updatedAt: 0,
  body: '# 指令\n\n正文内容\n',
  files: {
    'SKILL.md': '---\nname: demo-skill\ndescription: 示例技能\ncategory: general\n---\n\n# 指令\n\n正文内容\n',
    'references/REF.md': '# 参考\n',
    'notes.txt': 'notes\n',
  },
});

const app = createApp(api.SkillManager);
const errors = [];
app.config.errorHandler = error => errors.push(error);
// 删除类操作走二次确认：测试环境统一放行（JSDOM 的 confirm 未实现）
dom.window.confirm = () => true;
app.mount('#app');
await flush();

const q = selector => document.querySelector(selector);
const qa = selector => [...document.querySelectorAll(selector)];

// ──── 1. 进入编辑态 ────

const editButton = qa('.hub-card-ops .hub-op').find(button => button.textContent.trim() === '编辑');
assert.ok(editButton, '技能卡片提供编辑入口');
editButton.click();
await flush();
assert.ok(q('.hub-editor'), '进入技能编辑态');

// ──── 2. 模式切换在标题栏右侧、返回列表左侧 ────

const headActions = q('.hub-editor-head-actions');
assert.ok(headActions, '标题栏右侧存在动作组');
const seg = headActions.querySelector('.hub-seg');
const back = headActions.querySelector('.hub-btn');
assert.ok(seg && back, '动作组内含模式分段控件与返回列表按钮');
assert.ok(
  seg.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING,
  '模式切换控件排在返回列表按钮左侧',
);
// 头部动作顺序：返回列表 → 取消 → 保存（取消与保存在返回列表右侧）
const headLabels = [...headActions.querySelectorAll('.hub-btn')].map(b => b.textContent.trim());
assert.deepEqual(headLabels, ['返回列表', '取消', '保存'], '头部动作顺序为 返回列表 → 取消 → 保存');
assert.equal(q('.hub-editor-footer .hub-btn'), null, '页脚不再保留取消 / 保存按钮（已移至标题栏）');
assert.equal(q('.hub-editor-mode'), null, '旧的独立模式切换行已移除');

// ──── 2b. 简单模式同样填满：编辑器吃满剩余高度，提示词占满窗口剩余空间 ────

assert.ok(q('.hub-editor').classList.contains('is-fill'), '简单模式编辑器也是填满态（不吃满会留底部空白）');
const simpleSplit = q('.hub-editor-split--skill-simple');
assert.ok(simpleSplit, '简单模式为左右两列');
const promptArea = simpleSplit.querySelector('.hub-field--grow textarea');
assert.ok(promptArea, '右列提供提示词（技能正文）编辑区');
assert.ok(promptArea.classList.contains('hub-field--fill'), '提示词编辑区弹性填满剩余高度');
assert.ok(
  /\.hub-editor-split--skill-simple\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/s.test(
    readFileSync(path.join(root, 'entrypoints/hub/hub.css'), 'utf8'),
  ),
  '简单模式为单行网格：列高 = 容器高，提示词据此占满剩余空间',
);

// ──── 3. 切到高级模式：文件树 + 编辑器 + 下方状态条 ────

const advancedButton = [...seg.querySelectorAll('.hub-seg__btn')].find(button => button.textContent.trim() === '高级模式');
assert.ok(advancedButton, '分段控件含「高级」选项');
advancedButton.click();
await flush();

assert.ok(q('.hub-tree'), '高级模式展示文件树');
assert.ok(q('.hub-code'), '高级模式展示文件编辑器');
const status = q('.hub-editor-status');
assert.ok(status, '高级模式展示通栏状态条');
assert.ok(status.querySelector('.hub-validation'), '状态条内承载实时校验');
assert.equal(q('.hub-code .hub-validation'), null, '实时校验不再嵌在文件编辑器内部');
assert.equal(q('.hub-code').contains(status), false, '状态条位于文件编辑器之外');

// ──── 4. 文件树结构 ────

const rows = () => qa('.hub-tree-row');
const rowByName = name => rows().find(row => row.querySelector('.hub-tree-name')?.textContent.trim() === name);
assert.ok(rowByName('SKILL.md'), '入口文件 SKILL.md 置顶');
assert.ok(rowByName('references'), '目录 references 存在');
assert.ok(rowByName('REF.md'), '目录内文件 REF.md 存在');
assert.ok(rowByName('notes.txt'), '根级文件 notes.txt 存在');
assert.equal(rowByName('SKILL.md').getAttribute('draggable'), null, '入口文件不可拖动');
assert.equal(rowByName('notes.txt').getAttribute('draggable'), 'true', '资源文件行可拖拽');
assert.equal(qa('.hub-tree-row.is-folder').length, 1, '目录行以 is-folder 标识');

// ──── 5. 新建文件（带目录前缀） ────

q('.hub-tree-add').click();
await flush();
const createInput = q('.hub-tree-input-row input');
assert.ok(createInput, '新建文件输入行出现');
createInput.value = 'steps/plan.md';
createInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
createInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await flush();
assert.ok(rowByName('steps'), '新建文件自动建出目录 steps');
assert.ok(rowByName('plan.md'), '新建文件出现在树中');
assert.equal(q('.hub-tree-input-row'), null, '确认后输入行收起');

// ──── 6. 拖拽：根级文件移入目录 ────

function dragEvent(type, target) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  event.dataTransfer = { effectAllowed: '', setData() {}, getData: () => '' };
  target.dispatchEvent(event);
  return event;
}

const notesRow = rowByName('notes.txt');
notesRow.click();
await flush();
assert.equal(q('.hub-code-path')?.textContent.trim(), 'notes.txt', '点击文件行即在右侧打开');
dragEvent('dragstart', notesRow);
await flush();
assert.ok(notesRow.classList.contains('is-dragging'), '拖拽源行标记为拖拽中');
const referencesRow = rowByName('references');
dragEvent('dragover', referencesRow);
await flush();
assert.ok(referencesRow.classList.contains('is-drop-target'), '悬停目录行出现放置高亮');
dragEvent('drop', referencesRow);
await flush();
const movedRow = rows().find(row => row.querySelector('.hub-tree-name')?.textContent.trim() === 'notes.txt');
assert.ok(movedRow, '移动后的文件行仍在树中');
/** 行缩进层级：文件行的 --depth 挂在行容器上，目录行直接挂在行本身 */
const depthOf = row =>
  row.style.getPropertyValue('--depth') ||
  row.closest('.hub-tree-item')?.style.getPropertyValue('--depth') ||
  '';
assert.equal(movedRow.getAttribute('title'), 'references/notes.txt', '文件路径已改为目录内路径');
assert.equal(depthOf(movedRow), '1', '文件缩进一级（进入目录）');
assert.ok(rowByName('references'), '目标目录仍在树中');
// 移动后选中态跟随新路径
assert.equal(q('.hub-code-path')?.textContent.trim(), 'references/notes.txt', '编辑器路径跟随移动后的文件');

// ──── 7. 拖回根目录（落到文件标题栏） ────

dragEvent('dragstart', movedRow);
await flush();
const treeHead = q('.hub-tree-head');
dragEvent('dragover', treeHead);
await flush();
assert.ok(treeHead.classList.contains('is-drop-root'), '悬停标题栏提示放回根目录');
dragEvent('drop', treeHead);
await flush();
const rootRow = rows().find(row => row.querySelector('.hub-tree-name')?.textContent.trim() === 'notes.txt');
assert.ok(rootRow, '文件回到根级');
assert.equal(rootRow.getAttribute('title'), 'notes.txt', '路径已回到根级');
assert.equal(depthOf(rootRow), '0', '回到根级后不再有缩进');

// ──── 7b. 同级重排：拖到另一个文件上 = 插到它前面 ────

q('.hub-tree-add').click();
await flush();
const secondInput = q('.hub-tree-input-row input');
secondInput.value = 'b.txt';
secondInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
secondInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await flush();
const rootFileOrder = () => rows()
  .filter(row => row.classList.contains('is-file') && depthOf(row) === '0')
  .map(row => row.querySelector('.hub-tree-name')?.textContent.trim());
assert.deepEqual(rootFileOrder(), ['notes.txt', 'b.txt'], '新建文件追加在同级末尾');
const bRow = rowByName('b.txt');
dragEvent('dragstart', bRow);
await flush();
dragEvent('dragover', rowByName('notes.txt'));
await flush();
dragEvent('drop', rowByName('notes.txt'));
await flush();
assert.deepEqual(rootFileOrder(), ['b.txt', 'notes.txt'], '拖到文件行即插到它之前');

// ──── 8. 新建文件 / 新建文件夹：两个独立按钮 ────

const addButtons = qa('.hub-tree-add');
assert.equal(addButtons.length, 2, '文件树头部提供「新建文件」与「新建文件夹」两个独立按钮');
assert.notEqual(addButtons[0].getAttribute('title'), addButtons[1].getAttribute('title'), '两个按钮语义不同');

addButtons[1].click();
await flush();
const folderInput = q('.hub-tree-input-row input');
assert.ok(folderInput, '新建文件夹同样走树内内联输入行');
folderInput.value = 'assets';
folderInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
folderInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await flush();
assert.ok(rowByName('assets'), '新建的目录出现在树中');
assert.equal(q('.hub-tree-input-row'), null, '确认后输入行收起');

// ──── 9. 右键菜单：新建 / 副本 / 重命名 / 复制路径 / 删除 ────

function contextMenuOn(target) {
  target.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
}

const assetsRow = rowByName('assets');
contextMenuOn(assetsRow);
await flush();
const menu = q('.hub-menu');
assert.ok(menu, '右键文件树元素弹出自定义菜单卡片');
const menuLabels = () => [...menu.querySelectorAll('.hub-menu-item')].map(item => item.textContent.trim());
assert.ok(menuLabels().includes('在此新建文件'), '目录菜单提供「在此新建文件」');
assert.ok(menuLabels().includes('在此新建文件夹'), '目录菜单提供「在此新建文件夹」');
assert.ok(menuLabels().includes('重命名文件夹'), '目录菜单提供「重命名文件夹」');
assert.ok(menuLabels().includes('删除文件夹'), '目录菜单提供「删除文件夹」');

// 目录菜单 → 在此新建文件（落在该目录内）
[...menu.querySelectorAll('.hub-menu-item')].find(item => item.textContent.trim() === '在此新建文件').click();
await flush();
assert.equal(q('.hub-menu'), null, '菜单在执行动作后关闭');
const inFolderInput = q('.hub-tree-input-row input');
assert.ok(inFolderInput, '在目录内新建文件的输入行出现');
assert.equal(q('.hub-tree-input-prefix')?.textContent.trim(), 'assets/', '输入行显示目标目录前缀');
inFolderInput.value = 'logo.txt';
inFolderInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
inFolderInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await flush();
const logoRow = rows().find(row => row.querySelector('.hub-tree-name')?.textContent.trim() === 'logo.txt');
assert.ok(logoRow, '文件创建在目标目录内');
assert.equal(logoRow.getAttribute('title'), 'assets/logo.txt', '路径带目标目录前缀');
assert.equal(depthOf(logoRow), '1', '文件缩进一级（位于目录内）');

// 文件菜单 → 创建副本
const logoButton = logoRow;
contextMenuOn(logoButton);
await flush();
const fileMenu = q('.hub-menu');
assert.ok(fileMenu, '右键文件弹出菜单');
const fileLabels = [...fileMenu.querySelectorAll('.hub-menu-item')].map(item => item.textContent.trim());
assert.ok(fileLabels.includes('创建副本'), '文件菜单提供「创建副本」');
assert.ok(fileLabels.includes('重命名'), '文件菜单提供「重命名」');
assert.ok(fileLabels.includes('复制路径'), '文件菜单提供「复制路径」');
assert.ok(fileLabels.includes('删除'), '文件菜单提供「删除」');
[...fileMenu.querySelectorAll('.hub-menu-item')].find(item => item.textContent.trim() === '创建副本').click();
await flush();
assert.ok(rowByName('logo-copy.txt'), '副本文件出现在树中');
assert.equal(
  rows().find(row => row.querySelector('.hub-tree-name')?.textContent.trim() === 'logo-copy.txt')?.getAttribute('title'),
  'assets/logo-copy.txt',
  '副本与源文件同目录',
);

// 文件菜单 → 删除
contextMenuOn(rows().find(row => row.querySelector('.hub-tree-name')?.textContent.trim() === 'logo-copy.txt'));
await flush();
[...q('.hub-menu').querySelectorAll('.hub-menu-item')].find(item => item.textContent.trim() === '删除').click();
await flush();
assert.equal(rowByName('logo-copy.txt'), undefined, '副本已删除');

// 文件菜单 → 重命名（回车确认）
contextMenuOn(rows().find(row => row.querySelector('.hub-tree-name')?.textContent.trim() === 'logo.txt'));
await flush();
[...q('.hub-menu').querySelectorAll('.hub-menu-item')].find(item => item.textContent.trim() === '重命名').click();
await flush();
const renameInput = q('.hub-tree-input-row input');
assert.ok(renameInput, '重命名输入行出现');
assert.equal(renameInput.value, 'logo.txt', '重命名输入框预填文件名');
renameInput.value = 'brand.txt';
renameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
renameInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await flush();
assert.ok(rowByName('brand.txt'), '重命名生效');
assert.equal(rowByName('logo.txt'), undefined, '旧文件名不再出现');

// ──── 10. 实时校验：默认收起，只报「{n} 个问题」；点击向上弹出悬浮卡片 ────

const statusHead = q('.hub-validation-head');
assert.ok(statusHead, '状态条提供校验标题行');
assert.equal(q('.hub-validation-body'), null, '默认收起时不渲染问题明细');
assert.ok(q('.hub-validation-ok-badge'), '校验通过时收起态展示「通过」徽标');
// 高级模式为填满态：文件树 + 编辑器吃满剩余高度，状态条贴底
assert.ok(q('.hub-editor').classList.contains('is-fill'), '高级模式编辑器为填满态（吃满剩余高度）');

// 让入口文件失效 → 收起态应只报「{n} 个问题」
const rawInput = q('.hub-code-input');
assert.ok(rawInput, '入口文件编辑区可编辑');
rawInput.value = '';
rawInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
const countBadge = q('.hub-validation-count');
assert.ok(countBadge, '收起态展示问题计数徽标');
assert.ok(countBadge.textContent.includes('个问题'), '计数徽标为「{n} 个问题」文字而非纯数字');
assert.ok(/^\d+\s*个问题$/.test(countBadge.textContent.trim()), '计数徽标格式为「N 个问题」');
assert.equal(q('.hub-validation-body'), null, '仍处于收起态（不自动展开明细）');
statusHead.click();
await flush();
const floatingBody = q('.hub-validation-body');
assert.ok(floatingBody, '点击标题行展开问题明细');
assert.ok(floatingBody.querySelector('.hub-validation-items'), '悬浮卡片内承载逐条问题');
assert.ok(q('.hub-editor-status').contains(floatingBody), '悬浮卡片锚定在状态条上（向上弹出）');
statusHead.click();
await flush();
assert.equal(q('.hub-validation-body'), null, '再次点击收起问题明细');

// ──── 11. 目录也可拖拽：整棵子树随迁 ────

const referencesFolder = rowByName('references');
assert.ok(referencesFolder, 'references 目录行存在');
assert.equal(referencesFolder.getAttribute('draggable'), 'true', '目录行可拖拽');
dragEvent('dragstart', referencesFolder);
await flush();
dragEvent('dragover', rowByName('assets'));
await flush();
dragEvent('drop', rowByName('assets'));
await flush();
assert.ok(
  rows().some(row => row.getAttribute('title') === 'assets/references/REF.md'),
  '目录内文件随目录整体迁移',
);
assert.equal(
  rows().filter(row => row.querySelector('.hub-tree-name')?.textContent.trim() === 'references' && depthOf(row) === '0').length,
  0,
  '原目录位置不再存在（目录已迁入 assets）',
);

// ──── 12. 样式契约：文件树行不得有左侧色条 ────

const hubCss = readFileSync(path.join(root, 'entrypoints/hub/hub.css'), 'utf8');
assert.equal(/inset 2\.5px 0 0/.test(hubCss), false, '文件树选中行不得使用左侧色条');
assert.equal(/102,\s*126,\s*234/.test(hubCss), false, 'hub 样式不得残留品牌靛紫');
assert.equal(/#4f46e5|#667eea|#764ba2|#f093fb/.test(hubCss), false, 'hub 样式不得残留蓝紫硬编码色');

// 布局契约：文件树与文件编辑器同处网格首行（等高、吃满剩余高度），状态条通栏贴底
const advancedRule = hubCss.match(/\.hub-editor-split--skill-advanced\s*\{[^}]*\}/)?.[0] ?? '';
assert.ok(/grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto/.test(advancedRule), '高级模式为「首行等高 + 次行状态条」的两行网格');
assert.ok(/height:\s*auto/.test(advancedRule), '高级模式高度来自 is-fill 弹性链（不吃魔法数，底部不留空白）');
assert.ok(/\.hub-editor\.is-fill \.hub-editor-split\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0/s.test(hubCss), '填满态 split 吃满编辑器剩余空间');
assert.ok(/\.hub-tree\s*\{[^}]*grid-row:\s*1/.test(hubCss), '文件树位于网格首行');
assert.ok(/\.hub-code\s*\{[^}]*grid-row:\s*1/.test(hubCss), '文件编辑器位于网格首行（与文件树同高）');
assert.ok(/\.hub-editor-status\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(hubCss), '状态条横向通栏，位于最底部');
// 悬浮卡片契约：向上弹出、绝对定位（不占状态条布局高度）
assert.ok(/\.hub-validation-body\s*\{[^}]*position:\s*absolute[^}]*bottom:\s*calc\(100%/s.test(hubCss), '问题明细为向上弹出的悬浮卡片');

assert.deepEqual(errors, [], '组件渲染与交互过程无未捕获异常');
console.log('[hub] 技能编辑器：填满态布局、VS Code 式文件树、右键菜单、拖拽、校验收起（{n} 个问题 + 向上悬浮卡片）—— 通过');
app.unmount();
dom.window.close();

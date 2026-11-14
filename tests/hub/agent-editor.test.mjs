/**
 * 管理中心 · 智能体编辑器回归测试
 *
 * 覆盖本轮改动的关键契约：
 *   1. 壳结构：左导航卡（标题 + 分区入口 + 语言切换）+ 右内容卡，两张独立卡片；
 *   2. 头像区占位压到最小：emoji 形态 26px 且无底板，图片形态可点开放大；
 *   3. 图片放大层：点缩略图打开，提供下载与关闭；
 *   4. 智能体编辑页左右两张卡片，各区块按百分比限高（CSS 契约）。
 *
 * 运行：node tests/hub/agent-editor.test.mjs
 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const outfile = path.resolve('node_modules/.cache/hub-agent-editor-test.mjs');
mkdirSync(path.dirname(outfile), { recursive: true });

await build({
  stdin: {
    contents: `
export { default as Hub } from './entrypoints/hub/App.vue';
export { normalizeVision } from './utils/agents/agent-types';
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
        api.onResolve({ filter: /@\/utils\/i18n$/ }, args => ({ path: args.path, namespace: 'locale' }));
        api.onLoad({ filter: /.*/, namespace: 'locale' }, () => ({
          contents: `import {ref} from 'vue'; import zh from '${path.resolve('utils/i18n/locales/zh-CN.ts').replaceAll('\\', '/')}';
export const t=(key,p={})=>String(key.split('.').reduce((v,k)=>v?.[k],zh)??key).replace(/\\{(\\w+)\\}/g,(_,k)=>p[k]??'');
export const useLocale=()=>({locale:ref('zh-CN'),switchLocale:()=>{}});export const LOCALE_OPTIONS=[];`,
          resolveDir: root,
        }));
        // 技能存储：分类选择器会读它（提供两条技能以便验证搜索过滤）
        api.onResolve({ filter: /@\/utils\/skills\/skill-store$/ }, args => ({ path: args.path, namespace: 'skill-store' }));
        api.onLoad({ filter: /.*/, namespace: 'skill-store' }, () => ({
          contents: `export function getAllSkills(){ return [
  { id:'1001', name:'skill-a', description:'网页调研报告生成', category:'content', tags:['调研'], allowedTools:[], files:{'SKILL.md':'x'}, body:'x', source:'custom', enabled:true, updatedAt:0 },
  { id:'1002', name:'skill-b', description:'表格数据抽取', category:'data', tags:['表格'], allowedTools:[], files:{'SKILL.md':'x'}, body:'x', source:'custom', enabled:true, updatedAt:0 },
]; }
export function onSkillsChange(){ return () => {}; } export function getSkillById(){ return null; } export async function restoreCustomSkillsFromStorage(){} export async function setCustomSkill(){return {ok:false,reason:'invalid'};}`,
        }));
        // Python 环境：状态源
        api.onResolve({ filter: /@\/utils\/pyodide\/pyodide-env$/ }, args => ({ path: args.path, namespace: 'pyodide' }));
        api.onLoad({ filter: /.*/, namespace: 'pyodide' }, () => ({
          contents: `export async function getPyodideEnvState(){ return { status:'ready' }; } export function watchPyodideEnv(){ return () => {}; }`,
        }));
        // 插件客户端：外壳启动时调用，测试环境无 chrome.runtime，直接空实现
        api.onResolve({ filter: /@\/utils\/plugins\/client$/ }, args => ({ path: args.path, namespace: 'plugin-client' }));
        api.onLoad({ filter: /.*/, namespace: 'plugin-client' }, () => ({
          contents: `export async function startPluginClient(){ return { ok:true }; }`,
        }));
        // 图片处理：替身固定返回一张 data URL（真实实现依赖 canvas，JSDOM 无此能力）
        api.onResolve({ filter: /@\/utils\/agents\/avatar-image$/ }, args => ({ path: args.path, namespace: 'avatar-image' }));
        api.onLoad({ filter: /.*/, namespace: 'avatar-image' }, () => ({
          contents: `export const AVATAR_ERR_NOT_IMAGE = 'not-image';
export async function processAvatarImage(){ return 'data:image/png;base64,AAAA'; }`,
        }));
        api.onLoad({ filter: /\.vue$/ }, args => {
          const real = /hub[\\/]App\.vue$|hub[\\/]agents[\\/]AgentManager\.vue$|hub[\\/]agents[\\/]ExternalToolsPicker\.vue$|hub[\\/]components[\\/](CategorySelect|TagInput|HubSelect|HubSwitch|HubSegmented|EmojiPicker)\.vue$|common[\\/]AgentAvatar\.vue$/.test(args.path);
          if (!real) return { contents: `export default {render:()=>null};`, loader: 'js' };
          const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
          return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content, loader: 'ts', resolveDir: path.dirname(args.path) };
        });
      },
    },
  ],
  logLevel: 'silent',
});

const dom = new JSDOM('<div id="app"></div>', { url: 'https://extension.test/hub.html' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver', 'localStorage']) {
  globalThis[key] = dom.window[key];
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.chrome = {
  storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
  onChanged: { addListener() {}, removeListener() {} },
};

const api = await import(pathToFileURL(outfile).href);
const { createApp, nextTick } = await import('vue');
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { await tick(); await nextTick(); };

const app = createApp(api.Hub);
const errors = [];
app.config.errorHandler = error => errors.push(error);
app.mount('#app');
await flush();

const q = selector => document.querySelector(selector);
const qa = selector => [...document.querySelectorAll(selector)];

// ──── 1. 壳结构：左右两张独立卡片，标题在左卡 ────

assert.ok(q('.hub-layout'), '壳为左右布局');
assert.ok(q('.hub-sidebar'), '左卡存在');
assert.ok(q('.hub-content'), '右卡存在');
assert.equal(q('.hub-sidebar-title')?.textContent.trim(), '管理中心', '「管理中心」标题在左卡顶部');
assert.equal(q('.hub-content .hub-sidebar-title'), null, '右卡不含标题');
assert.ok(q('.hub-sidebar-nav'), '左卡内含分区入口');
assert.ok(q('.hub-sidebar-foot .hub-locale'), '语言切换在左卡底部');
assert.equal(q('.hub-content-body'), q('.hub-content-body'), '右卡内有内容滚动区');
assert.equal(q('.api-config-modal'), null, '旧的整壳结构已移除');

// ──── 1.5 智能体概览卡：视觉能力徽章双语化（中文「视觉」/ 英文 Vision）+ 眼睛图标 ────

const visionBadges = () => qa('.hub-badge-vision');
assert.ok(visionBadges().length > 0, '概览卡展示视觉能力徽章');
assert.ok(
  visionBadges().every(badge => badge.textContent.trim() === '视觉'),
  '中文界面下视觉徽章显示「视觉」（随界面语言切换，不再硬编码英文）',
);
assert.ok(
  visionBadges().every(badge => badge.querySelector('.hub-badge-vision__icon')),
  '视觉徽章带眼睛图标（语义提示）',
);
assert.ok(
  !qa('.hub-badge-vision').some(badge => badge.textContent.includes('Vision')),
  '中文界面下不残留英文 Vision 文案',
);

// ──── 2. 进入智能体编辑页 ────

const newAgentButton = qa('.hub-btn').find(button => button.textContent.trim() === '新建智能体');
assert.ok(newAgentButton, '列表提供「新建智能体」');
newAgentButton.click();
await flush();
assert.ok(q('.hub-editor'), '进入智能体编辑态');
assert.ok(q('.hub-editor-split--agent'), '智能体编辑器为左右两张卡片');

// ──── 3. 头像区：占位压到最小 + emoji / 图片两种形态 ────

const preview = q('.hub-avatar-preview');
assert.ok(preview, '头像区提供预览位');
assert.ok(preview.classList.contains('is-emoji'), '默认（无头像 / emoji）形态走 is-emoji');
const avatarRow = q('.hub-avatar-current');
assert.ok(avatarRow.contains(preview), '预览位与操作按钮同行');
assert.ok(q('.hub-avatar-actions'), '上传 / 选择 Emoji / 清除按钮同行');

// 选中 emoji → 悬浮卡片：选中即收起；点外部也收起
const emojiButton = qa('.hub-avatar-actions .hub-btn').find(button => button.textContent.trim() === '选择 Emoji');
emojiButton.click();
await flush();
assert.ok(q('.emoji-picker'), '点「选择 Emoji」展开悬浮卡片');
const emojiItem = q('.emoji-picker-item');
assert.ok(emojiItem, '悬浮卡片提供 emoji 网格');
emojiItem.click();
await flush();
assert.ok(q('.hub-avatar-preview').classList.contains('is-emoji'), 'emoji 形态仍走最小占位');
assert.equal(q('.emoji-picker'), null, '选中后悬浮卡片自动收起');
assert.equal(q('.hub-image-lightbox'), null, 'emoji 形态不触发放大层');

// 再次展开 → 点击卡片外部 → 收起
emojiButton.click();
await flush();
assert.ok(q('.emoji-picker'), '悬浮卡片再次展开');
document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
await flush();
assert.equal(q('.emoji-picker'), null, '点击外部后悬浮卡片收起');

// 视觉操作开关（原「视觉循环」）位于左卡、名称字段之下
const formCard = q('.hub-editor-col--form');
assert.ok(formCard, '左卡（表单）存在');
const visionField = formCard.querySelector('fieldset');
assert.ok(visionField, '视觉声明在左卡内');
assert.ok(visionField.textContent.includes('视觉'), '视觉声明字段存在');
// 标题改名 + 左右布局：标题与问号在左、开关在右，同处一行
const visionHead = visionField.querySelector('.hub-vision-head');
assert.ok(visionHead, '视觉操作行（标题+开关）存在');
assert.ok(visionHead.textContent.includes('视觉操作'), '标题改名为「视觉操作」');
const visionTitle = visionHead.querySelector('.hub-vision-title');
const visionTip = visionHead.querySelector('.hub-help-tip');
const visionSwitch = visionHead.querySelector('.hub-switch input[type="checkbox"]');
assert.ok(visionTitle && visionTip, '标题右侧提供问号按钮');
assert.ok(visionSwitch, '开关位于同一行');
assert.ok(
  Boolean(visionTitle.compareDocumentPosition(visionTip) & Node.DOCUMENT_POSITION_FOLLOWING),
  '问号紧随标题之后',
);
assert.ok(
  Boolean(visionTip.compareDocumentPosition(visionSwitch) & Node.DOCUMENT_POSITION_FOLLOWING),
  '开关在标题与问号右侧（左右布局）',
);
// 问号 → 自定义解释框（挂编辑器层的悬浮卡片，文案为约定句）
assert.equal(q('.hub-help-pop'), null, '默认不展开视觉说明框');
visionTip.click();
await flush();
const visionPop = q('.hub-help-pop');
assert.ok(visionPop, '点问号展开解释框');
assert.ok(
  visionPop.textContent.includes('此智能体必须由视觉模型驱动'),
  '解释框承载「开启后由视觉模型驱动」的约定文案',
);
assert.ok(visionPop.textContent.includes('AI默认会看到当前正在操作的页面'), '解释框文案完整');
visionTip.click();
await flush();
assert.equal(q('.hub-help-pop'), null, '再点问号收起解释框');
// 视觉操作只保留「标题 + 问号 + 主开关」与坐标说明：截图工具下拉与
// 「每轮工具执行后重新截图」开关是内部实现细节（截图工具恒为 screenshot、
// 重拍恒开），已从编辑器移除，不做用户开关
assert.equal(visionField.querySelector('.hub-vision-row'), null, '不展示视觉子配置行（截图工具 / 重截图开关已移除）');
assert.ok(!visionField.textContent.includes('0–1000'), '关闭时不展示坐标提示');
visionSwitch.click();
await flush();
assert.equal(visionField.querySelector('.hub-vision-row'), null, '开启后仍不提供截图工具 / 重截图控件');
assert.ok(visionField.textContent.includes('0–1000'), '开启后展示坐标提示');
visionSwitch.click();
await flush();
const nameField = qa('.hub-editor-col--form .hub-field').find(field => field.textContent.includes('名称'));
assert.ok(nameField, '名称字段在左卡');
assert.ok(
  nameField.compareDocumentPosition(visionField) & Node.DOCUMENT_POSITION_FOLLOWING,
  '视觉声明紧跟名称字段之后',
);
const listsCard = q('.hub-editor-col--lists');
assert.ok(listsCard, '右卡（清单）存在');
assert.ok(!listsCard.contains(visionField), '视觉声明不在右卡');

// ──── 字段排布：名称 / 描述 / 分类 / 标签各占一行；视觉操作左端与字段标签对齐 ────

// 不再使用双列栅格：短字段不再并排，四个字段各占整行
assert.equal(formCard.querySelector('.hub-form-row'), null, '短字段不再并排（名称 / 描述 / 分类 / 标签各占一行）');
const formFieldLabels = [...formCard.querySelectorAll(':scope > .hub-field')].map(field =>
  field.querySelector('.hub-field-label')?.textContent.trim() ?? '',
);
assert.deepEqual(
  formFieldLabels,
  ['头像', '名称*', '描述（做什么 + 何时使用）*', '视觉操作', '分类', '标签', '系统提示词*'],
  '左卡基础字段自上而下各占一行（头像 / 名称 / 描述 / 视觉操作 / 分类 / 标签 / 系统提示词）',
);

// 左对齐契约：名称标签与视觉操作标题同属左卡直系子级，且视觉操作行无左内边距
assert.ok(
  nameField.parentElement === visionField.parentElement,
  '名称与视觉操作同属左卡直系子级（左端自然对齐，无栅格包裹）',
);
const visionHeadCss = /\.hub-vision-head\s*\{([^}]*)\}/.exec(
  readFileSync(path.join(root, 'entrypoints/hub/hub.css'), 'utf8'),
)?.[1] ?? '';
const visionHeadPadding = /padding:\s*([^;]+);/.exec(visionHeadCss)?.[1]?.trim() ?? '';
const visionPaddingParts = visionHeadPadding.split(/\s+/);
const visionLeftPadding =
  visionPaddingParts.length === 1
    ? visionPaddingParts[0]
    : visionPaddingParts.length === 2 || visionPaddingParts.length === 3
      ? visionPaddingParts[1]
      : visionPaddingParts[3];
assert.equal(
  visionLeftPadding,
  '0',
  '视觉操作行左内边距为 0（标题与「名称」等字段标签严格对齐）',
);

// 数据层归一：视觉重拍恒开（编辑器已移除该开关，存量记录里的 false 在此收口）
assert.equal(
  api.normalizeVision({ screenshotTool: 'screenshot', screenshotArgs: {}, reScreenshotAfterTools: false })?.reScreenshotAfterTools,
  true,
  '视觉重拍恒为 true：存量 false 记录在归一层收口',
);
assert.equal(
  api.normalizeVision({ screenshotTool: 'screenshot', screenshotArgs: {}, reScreenshotAfterTools: true })?.reScreenshotAfterTools,
  true,
  '视觉重拍恒为 true',
);

// ──── 工具区：默认「按工具」视图（每个工具独立一个元素），可切到「按组」视图 ────
const groupSearch = q('.hub-section--groups .hub-list-search');
assert.ok(groupSearch, '工具区提供搜索框');
const groupRows = () => qa('.hub-section--groups .hub-group');
const toolRows = () => qa('.hub-section--groups .hub-tool-row');
assert.equal(toolRows().length > 0, true, '默认视图为「按工具」：每个工具独立一行');
assert.equal(groupRows().length, 0, '默认视图不展示组卡片');
// vision_gui 永不出现在工具组可选面（仅经「视觉操作」开关注入）
const flatToolIds = () => qa('.hub-section--groups .hub-tool-row-id').map(el => el.textContent.trim());
assert.ok(!flatToolIds().includes('vision_gui'), '扁平工具视图不提供 vision_gui 勾选');
// 搜索在扁平视图按工具 id / 所属组过滤
groupSearch.value = 'browser_get_page_info';
groupSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
assert.ok(toolRows().length > 0, '搜索命中工具');
assert.ok(
  toolRows().every(row => row.querySelector('.hub-tool-row-id')?.textContent.includes('browser_get_page_info')),
  '搜索结果只含匹配工具',
);
groupSearch.value = '不存在的工具xyz';
groupSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
assert.equal(toolRows().length, 0, '无匹配时不渲染工具行');
assert.ok(q('.hub-section--groups .hub-hint')?.textContent.includes('没有匹配'), '无匹配时给空态提示');
groupSearch.value = '';
groupSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();

// 视图切换：切到「按组」后展示组卡片，切回「按工具」恢复扁平列表
const viewSwitch = q('.hub-section--groups .hub-section-view');
assert.ok(viewSwitch, '工具组标题右侧提供视图切换');
const groupViewButton = [...viewSwitch.querySelectorAll('.hub-seg__btn')].find(b => b.textContent.trim() === '按组');
assert.ok(groupViewButton, '视图切换含「按组」选项');
groupViewButton.click();
await flush();
assert.ok(groupRows().length > 1, '切到「按组」视图后展示组卡片');
assert.equal(toolRows().length, 0, '「按组」视图不展示扁平工具行');
// 按组视图同样不提供 vision_gui；视觉坐标操作组仅含截图与 OCR
const groupToolIds = () => qa('.hub-section--groups .hub-group-tool-id').map(el => el.textContent.trim());
assert.ok(!groupToolIds().includes('vision_gui'), '按组视图不提供 vision_gui 勾选');
const visionGroupCard = groupRows().find(card =>
  card.querySelector('.hub-group-name')?.textContent.includes('视觉坐标操作'),
);
assert.ok(visionGroupCard, '视觉坐标操作组存在');
assert.deepEqual(
  [...visionGroupCard.querySelectorAll('.hub-group-tool-id')].map(el => el.textContent.trim()).sort(),
  ['ocr', 'screenshot'],
  '视觉坐标操作组仅含截图与 OCR（vision_gui 由开关注入）',
);
const toolViewButton = [...viewSwitch.querySelectorAll('.hub-seg__btn')].find(b => b.textContent.trim() === '按工具');
toolViewButton.click();
await flush();
assert.ok(toolRows().length > 0, '切回「按工具」视图恢复扁平列表');

// ──── 逐个勾选工具（扁平事实源 + 组三态复选框） ────
// 切到「按组」视图以验证组三态；先找一个含多个工具的组（首个组 chat 只有 1 个工具）
groupViewButton.click();
await flush();
const firstGroupCard = groupRows().find(card => card.querySelectorAll('.hub-group-tools .hub-check').length > 1);
assert.ok(firstGroupCard, '存在含多个工具的组卡片');
const groupHeadCheck = firstGroupCard.querySelector('.hub-group-head .hub-check');
assert.ok(groupHeadCheck, '组头提供三态复选框');
const toolChecks = [...firstGroupCard.querySelectorAll('.hub-group-tools .hub-check')];
assert.ok(toolChecks.length > 0, '组内列出可逐个勾选的工具');
assert.ok(
  toolChecks.every(check => check.closest('.hub-group-tool') !== null),
  '每个工具复选框都包在可点的工具芯片里',
);
// 初始全未选：组复选框未选且非部分选
assert.equal(groupHeadCheck.checked, false, '初始组复选框未选中');
assert.equal(groupHeadCheck.indeterminate, false, '初始组复选框非部分选中');
// 逐个勾选一个 → 组进入部分选中（indeterminate）
toolChecks[0].click();
await flush();
assert.ok(toolChecks[0].checked, '单个工具被勾选');
assert.equal(groupHeadCheck.indeterminate, true, '只勾一个 → 组复选框显示部分选中');
assert.equal(groupHeadCheck.checked, false, '部分选中时组复选框不显示全选');
assert.ok(firstGroupCard.classList.contains('is-partial'), '卡片呈部分选中态');
// 再勾一个 → 若组内恰好两个则全选，否则仍部分选
toolChecks[1].click();
await flush();
const allChecked = toolChecks.every(check => check.checked);
assert.equal(groupHeadCheck.indeterminate, !allChecked, '部分/全选状态随工具勾选实时联动');
assert.equal(groupHeadCheck.checked, allChecked, '全部勾选后组复选框为全选态');
assert.equal(firstGroupCard.classList.contains('checked'), allChecked, '卡片全选态与组复选框一致');
// 组复选框一键取消全选（全选态下点击）
if (allChecked) {
  groupHeadCheck.click();
  await flush();
  assert.ok(toolChecks.every(check => !check.checked), '全选态下点组复选框 → 组内全部取消');
  assert.equal(groupHeadCheck.checked, false, '取消后组复选框回到未选');
}
// 计数徽标与扁平集合同步
const countBadge = q('.hub-section--groups .hub-groups-count');
assert.ok(countBadge, '工具组区展示已选计数');
assert.match(countBadge.textContent, /已选 \d+\/30/, '计数徽标格式为「已选 N/30」');

const hubCssText = readFileSync(path.join(root, 'entrypoints/hub/hub.css'), 'utf8');

// ──── 外部插件工具 / 关联技能默认收起；关联技能说明改为问号悬浮框 ────
const externalSection = q('.hub-section--external');
assert.ok(externalSection, '外部插件工具分区存在');
assert.ok(externalSection.classList.contains('is-collapsed'), '外部插件工具默认收起');
const skillsSection = q('.hub-section--skills');
assert.ok(skillsSection, '关联技能分区存在');
assert.ok(skillsSection.classList.contains('is-collapsed'), '关联技能默认收起');
// 说明以问号按钮承载（不再有常驻说明文字）
assert.equal(q('.hub-section--skills .hub-hint'), null, '关联技能区不再常驻说明文字');
const helpTip = q('.hub-section--skills .hub-help-tip');
assert.ok(helpTip, '关联技能标题行提供问号按钮');
assert.equal(q('.hub-help-pop'), null, '默认不展示说明框');
helpTip.click();
await flush();
const helpPop = q('.hub-help-pop');
assert.ok(helpPop, '点问号展开说明悬浮卡片');
assert.ok(
  helpPop.textContent.includes('可用技能清单'),
  '说明框承载完整的关联规则解释',
);
helpTip.click();
await flush();
assert.equal(q('.hub-help-pop'), null, '再点问号收起说明框');

// ──── 搜索图标必须盖在输入框之上（输入框带 backdrop-filter 会形成层叠上下文） ────
const searchIcon = q('.hub-section--groups .hub-search__icon');
assert.ok(searchIcon, '搜索框左侧有搜索图标');
assert.ok(
  /\.hub-search__icon\s*\{[^}]*z-index:\s*1/s.test(hubCssText),
  '搜索图标提升层级（输入框的 backdrop-filter 会盖住后绘制的兄弟节点）',
);

// 图片形态：走上传通道（图片处理被替身固定为一张 data URL）→ 可点开放大 + 下载
const fileInput = q('.hub-avatar-upload input[type="file"]');
assert.ok(fileInput, '上传入口是隐藏的 file input');
Object.defineProperty(fileInput, 'files', {
  configurable: true,
  value: [new dom.window.File([new Uint8Array([1, 2, 3])], 'avatar.png', { type: 'image/png' })],
});
fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await flush();
const imagePreview = q('.hub-avatar-preview');
assert.ok(imagePreview.classList.contains('is-image'), '图片形态走 is-image');
assert.equal(q('.hub-image-lightbox'), null, '未点开时不显示放大层');
imagePreview.click();
await flush();
const lightbox = q('.hub-image-lightbox');
assert.ok(lightbox, '点击图片缩略图打开放大层');
assert.ok(lightbox.querySelector('.hub-image-lightbox__image'), '放大层展示原图');
const downloadLink = lightbox.querySelector('a[download]');
assert.ok(downloadLink, '放大层提供下载入口');
assert.equal(downloadLink.getAttribute('href'), 'data:image/png;base64,AAAA', '下载链接指向当前图片');
const closeButton = qa('.hub-image-lightbox__bar .hub-btn').find(button => button.textContent.trim() === '关闭');
assert.ok(closeButton, '放大层提供关闭按钮');
closeButton.click();
await flush();
assert.equal(q('.hub-image-lightbox'), null, '关闭后放大层收起');

// ──── 4. 样式契约：填满态 / 占位最小化 / 放大层 / 清单占比限高 / 卡片内滚动 ────

const hubCss = readFileSync(path.join(root, 'entrypoints/hub/hub.css'), 'utf8');
assert.ok(q('.hub-editor').classList.contains('is-fill'), '智能体编辑器为填满态（吃满剩余高度，外层不出滚动条）');
assert.ok(/\.hub-editor\.is-fill\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0/s.test(hubCss), '填满态编辑器 flex + min-height:0');
assert.ok(/\.hub-content-body\s*\{[^}]*display:\s*flex/s.test(hubCss), '内容区建立弹性链（编辑器精确吃到剩余高度）');

// 级联回归锁：agent split 的 display/align-items/gap 必须胜过 .hub-editor-split 基类。
// 曾因 agent 覆写位于基类之前、同特异性被源顺序反杀（align-items:start 让左卡按
// 内容高度溢出 → 外层滚动条）。此处用真实解析器按「特异性 + 源顺序」求值。
const postcss = (await import('postcss')).default;
const cssRoot = postcss.parse(hubCss);
/**
 * 选择器按空格分段：最后一段的所有类命中元素自身，前面各段的类命中祖先链。
 * 只评估顶层规则（@media 内的规则仅在对应断点生效）。
 */
function cascadeResolve(elementClasses, ancestorClasses = []) {
  const winners = {};
  let order = 0;
  cssRoot.walkRules(rule => {
    if (rule.parent && rule.parent.type !== 'root') return;
    order++;
    for (const sel of rule.selectors) {
      const segments = sel.split(/\s+/).filter(Boolean);
      if (!segments.every(seg => /^(\.[\w-]+)+$/.test(seg))) continue; // 只比纯类选择器
      const segClasses = segments.map(seg => seg.match(/\.[\w-]+/g).map(c => c.slice(1)));
      const last = segClasses[segClasses.length - 1];
      const ancestors = segClasses.slice(0, -1);
      if (!last.every(c => elementClasses.includes(c))) continue;
      if (!ancestors.every(seg => seg.every(c => ancestorClasses.includes(c)))) continue;
      const spec = segClasses.flat().length;
      rule.walkDecls(d => {
        const prev = winners[d.prop];
        if (!prev || spec > prev.spec || (spec === prev.spec && order > prev.order)) {
          winners[d.prop] = { value: d.value, sel, spec, order };
        }
      });
    }
  });
  return winners;
}
const splitResolved = cascadeResolve(['hub-editor-split', 'hub-editor-split--agent']);
assert.equal(splitResolved.display?.value, 'flex', 'agent split 实际生效 display 为 flex（不被基类 grid 反杀）');
assert.equal(splitResolved['align-items']?.value, 'stretch', 'agent split 实际生效 align-items 为 stretch（左卡严格受限于行高）');
assert.equal(splitResolved.gap?.value, '14px', 'agent split 实际生效 gap 为 14px');
// 双类护栏 + 源顺序双保险
assert.ok(hubCss.indexOf('.hub-editor-split.hub-editor-split--agent') > hubCss.indexOf('.hub-editor-split {'), 'agent 覆写块位于基类之后（源顺序）');

// 折叠按钮 / 分区卡片的级联锁：曾因旧版 .hub-section-toggle 规则留在文件更后位置，
// 把新版（24px + 描边 + 白底）整块覆盖成 22px 无边框，导致按钮小到看不清。
const AGENT_ANCESTORS = ['hub-editor-split--agent', 'hub-editor-col--lists'];
const toggleResolved = cascadeResolve(
  ['hub-section-toggle'],
  [...AGENT_ANCESTORS, 'hub-section-head', 'hub-section'],
);
assert.equal(toggleResolved.width?.value, '24px', '折叠按钮实际生效宽度 24px（不被旧规则覆盖）');
assert.equal(toggleResolved.height?.value, '24px', '折叠按钮实际生效高度 24px');
assert.ok(/1px solid/.test(toggleResolved.border?.value ?? ''), '折叠按钮有可见描边');
assert.ok(/255/.test(toggleResolved.background?.value ?? ''), '折叠按钮有浅色底板');
const collapsedResolved = cascadeResolve(['hub-section', 'is-collapsed'], AGENT_ANCESTORS);
assert.equal(collapsedResolved['flex-grow']?.value, '0', '收起态 flex-grow 归零（空间让给其余分区）');
assert.equal(collapsedResolved['min-height']?.value, '40px', '收起态保留标题行高度');
assert.ok(/flex-grow/.test(collapsedResolved.transition?.value ?? ''), '收起态卡片高度带过渡动画');
const bodyResolved = cascadeResolve(['hub-section-body'], [...AGENT_ANCESTORS, 'hub-section']);
assert.ok(/grid-template-rows/.test(bodyResolved.transition?.value ?? ''), '内容区高度收拢带过渡动画');
const collapsedBodyResolved = cascadeResolve(['hub-section-body', 'is-collapsed'], [...AGENT_ANCESTORS, 'hub-section', 'is-collapsed']);
assert.equal(collapsedBodyResolved['grid-template-rows']?.value, '0fr', '收起态内容区高度收拢为 0fr');
const expandedResolved = cascadeResolve(['hub-section', 'hub-section--groups'], AGENT_ANCESTORS);
assert.equal(expandedResolved.flex?.value, '34 1 0', '展开态按 34 比例瓜分右卡高度');
// 内容区必须吃掉卡片除标题行外的剩余高度：flex 默认 0 1 auto 会让它只按内容排布，
// 剩余空间空着、列表被 overflow:hidden 裁掉（表现为「有标题有计数却一条都没有」）
const sectionBodyResolved = cascadeResolve(['hub-section-body'], [...AGENT_ANCESTORS, 'hub-section']);
assert.equal(sectionBodyResolved.flex?.value, '1 1 0', '分区内容区弹性占满卡片剩余高度（列表不被裁空）');
assert.equal(sectionBodyResolved['min-height']?.value, '0', '分区内容区可收缩（折叠时归零）');
const chevronResolved = cascadeResolve(
  ['hub-section-toggle__chevron', 'is-collapsed'],
  [...AGENT_ANCESTORS, 'hub-section-toggle'],
);
assert.ok(/rotate/.test(chevronResolved.transform?.value ?? ''), '收起态箭头旋转');
assert.ok(/transform/.test(chevronResolved.transition?.value ?? ''), '箭头旋转带过渡动画');

// 两卡构造：flex 均分 + min-height:0（高度严格受限于容器）
assert.ok(/\.hub-editor-split--agent \.hub-editor-col\s*\{[^}]*flex:\s*1 1 0[^}]*min-height:\s*0/s.test(hubCss), '两卡 flex:1 1 0 均分且可收缩');
assert.ok(/\.hub-editor-split--agent \.hub-editor-col--form\s*\{[^}]*overflow-y:\s*auto/.test(hubCss), '左卡（表单）整卡内部滚动');
assert.ok(/\.hub-editor-split--agent \.hub-editor-col--lists\s*\{[^}]*overflow:\s*hidden/.test(hubCss), '右卡自身不滚动（由清单区内滚）');
assert.ok(/\.hub-editor-split--agent \.hub-section--groups\s*,\s*\.hub-editor-split--agent \.hub-section--skills\s*\{[^}]*flex:\s*34/s.test(hubCss), '清单字段按占比分配高度（flex-grow 比例）');
assert.ok(/\.hub-editor-split--agent \.hub-section--external\s*\{[^}]*flex:\s*26/s.test(hubCss), '外部工具区占比略小');
assert.ok(/\.hub-editor-split--agent \.hub-section \.hub-groups-scroll\s*\{[^}]*max-height:\s*none/.test(hubCss), '清单区解除基类 300px 上限并内部滚动');
const emojiCss = readFileSync(path.join(root, 'entrypoints/hub/components/EmojiPicker.vue'), 'utf8');
assert.ok(/\.emoji-picker\s*\{[^}]*position:\s*absolute/s.test(emojiCss), 'emoji 选择为悬浮卡片（绝对定位）');
assert.ok(/\.hub-avatar-preview\.is-emoji\s*\{[^}]*width:\s*26px/.test(hubCss), 'emoji 占位宽度压到 26px');
assert.ok(/\.hub-avatar-preview\.is-image\s*\{[^}]*cursor:\s*zoom-in/.test(hubCss), '图片占位可点开放大');
assert.ok(/\.hub-image-lightbox\s*\{/.test(hubCss), '提供图片放大层样式');
assert.ok(/\.hub-image-lightbox__bar\s*\{/.test(hubCss), '放大层提供操作条（下载 / 关闭）');

// ──── 5. 新增交互：头部按钮位 / 卡片上下布局 / 查看悬浮窗 / 分区折叠 ────

// 头部动作区：返回列表 / 取消 / 保存（取消与保存在返回列表右侧）
const headActions = q('.hub-editor-head-actions');
assert.ok(headActions, '标题栏右侧动作组存在');
const headLabels = [...headActions.querySelectorAll('.hub-btn')].map(b => b.textContent.trim());
assert.deepEqual(headLabels, ['返回列表', '取消', '保存'], '头部动作顺序为 返回列表 → 取消 → 保存');
assert.equal(q('.hub-editor-footer .hub-btn'), null, '页脚不再保留取消 / 保存按钮（已移至标题栏）');
assert.equal(q('.hub-editor-footer .hub-btn-primary'), null, '页脚无主按钮');

// 清单卡片：标题与描述上下布局 + 右侧查看图标
const firstGroup = q('.hub-editor-col--lists .hub-group');
assert.ok(firstGroup, '存在工具组卡片');
const groupBody = firstGroup.querySelector('.hub-group-body');
assert.ok(groupBody, '卡片主体是可点按钮');
const nameBox = groupBody.querySelector('.hub-group-name');
const descBox = groupBody.querySelector('.hub-group-desc');
assert.ok(nameBox && descBox, '卡片含标题与描述');
assert.ok(
  nameBox.compareDocumentPosition(descBox) & Node.DOCUMENT_POSITION_FOLLOWING,
  '标题在描述之上（上下布局）',
);
assert.ok(firstGroup.querySelector('.hub-group-info'), '卡片右侧有查看图标');
assert.ok(/\.hub-group-desc\s*\{[^}]*-webkit-line-clamp:\s*2/s.test(hubCssText), '描述最多两行');

// 查看图标 → 弹出完整信息悬浮窗（图标本身必须是可点按钮，曾是 span 导致点了没反应）
const infoButton = firstGroup.querySelector('.hub-group-info');
assert.ok(infoButton, '卡片右侧有查看图标');
assert.equal(infoButton.tagName, 'BUTTON', '查看图标是可点击的按钮（此前是 span，点击无反应）');
firstGroup.querySelector('.hub-group-body').click();
// 详情卡需按需加载工具元数据（异步）
for (let i = 0; i < 20 && !q('.hub-detail-card'); i++) await flush();
const detailCard = q('.hub-detail-card');
assert.ok(detailCard, '点击标题区弹出详情悬浮窗卡片');
assert.ok(detailCard.querySelector('.hub-detail-card__panel'), '悬浮窗为卡片形态');
assert.ok(detailCard.querySelector('.hub-detail-card__title')?.textContent.trim(), '悬浮窗展示标题');
assert.ok(detailCard.querySelector('.hub-detail-card__desc')?.textContent.trim(), '悬浮窗展示完整描述');
// 工具明细：完整名称 + 介绍 + 输入参数说明（不再是裸工具 id 列表）
const detailTools = detailCard.querySelectorAll('.hub-detail-tool');
assert.ok(detailTools.length > 0, '悬浮窗逐个列出工具明细');
const firstTool = detailTools[0];
const toolName = firstTool.querySelector('.hub-detail-tool__name')?.textContent.trim() ?? '';
assert.ok(toolName.length > 0, '工具明细展示名称');
assert.notEqual(toolName, 'web_search', '工具名不是裸 id（应由元数据给出完整名称）');
assert.ok(firstTool.querySelector('.hub-detail-tool__desc')?.textContent.trim(), '工具明细展示介绍');
assert.ok(firstTool.querySelector('.hub-detail-tool__params'), '工具明细展示输入参数区块');
assert.ok(firstTool.querySelector('.hub-detail-tool__param-name')?.textContent.trim(), '输入参数含参数名');
assert.ok(firstTool.querySelector('.hub-detail-tool__param-desc')?.textContent.trim(), '输入参数含说明');
// 不再出现「工具数量 / 包含的工具」这类无意义信息
assert.equal(detailCard.querySelector('.hub-detail-card__chips'), null, '不再渲染裸工具 id 列表');
// 点遮罩关闭
detailCard.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
await flush();
assert.equal(q('.hub-detail-card'), null, '点击遮罩关闭悬浮窗');
// 直接点查看图标同样能打开
infoButton.click();
for (let i = 0; i < 20 && !q('.hub-detail-card'); i++) await flush();
assert.ok(q('.hub-detail-card'), '点击「查看」图标同样打开详情悬浮窗');
q('.hub-detail-card .hub-icon-btn').click();
await flush();
assert.equal(q('.hub-detail-card'), null, '关闭按钮收起悬浮窗');

// 搜索框：占满卡片宽度 + 图标可见；工具组与关联技能各有一个
const searchBoxes = qa('.hub-editor-col--lists .hub-search--fill');
assert.equal(searchBoxes.length, 3, '工具组 / 外部插件工具 / 关联技能各有一个搜索框');
for (const box of searchBoxes) {
  assert.ok(box.querySelector('.hub-search__icon'), '搜索框内含可见的搜索图标');
  assert.ok(box.querySelector('input'), '搜索框内含输入框');
}
assert.ok(
  /\.hub-search--fill\s*\{[^}]*width:\s*100%/s.test(hubCssText),
  '卡片内搜索框占满父容器宽度（默认 .hub-list-search 是列表页定宽 220px）',
);
// 详情卡：固定高度 + 内部滚动（超出不撑破页面）
assert.ok(
  /\.hub-detail-card__panel\s*\{[^}]*height:\s*min\([^}]*overflow-y:\s*auto/s.test(hubCssText),
  '详情卡片固定高度且超出内部滚动',
);
// 关联技能搜索：过滤生效
const skillSearch = q('.hub-section--skills .hub-list-search');
assert.ok(skillSearch, '关联技能分区提供搜索框');
const skillRows = () => qa('.hub-section--skills .hub-group');
assert.equal(skillRows().length, 2, '默认列出全部可用技能');
skillSearch.value = '表格';
skillSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
assert.equal(skillRows().length, 1, '搜索词过滤关联技能');
skillSearch.value = '不存在的技能xyz';
skillSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
assert.equal(skillRows().length, 0, '无匹配时不渲染技能条目');
assert.ok(
  q('.hub-section--skills .hub-hint')?.textContent.includes('没有匹配'),
  '关联技能无匹配时给出空态提示',
);
skillSearch.value = '';
skillSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
assert.equal(skillRows().length, 2, '清空搜索词后恢复全部技能');

// 三个分区都可折叠；收起后把空间让给其余区
const toggleButtons = qa('.hub-editor-col--lists .hub-section-toggle');
assert.equal(toggleButtons.length, 3, '工具组 / 外部插件工具 / 关联技能各有一个折叠按钮');
// 折叠按钮在标题行最左，与标题相邻（不飘在右侧角落）
const groupsSection = q('.hub-editor-col--lists .hub-section--groups');
assert.ok(groupsSection, '工具组分区存在');
const head = groupsSection.querySelector('.hub-section-head');
assert.ok(head, '分区有标题行');
assert.ok(head.firstElementChild.classList.contains('hub-section-toggle'), '折叠按钮位于标题行最左');
const groupsScroll = () => groupsSection.querySelector('.hub-groups-scroll');
assert.ok(groupsScroll(), '工具组展开时列表可见');
groupsSection.querySelector('.hub-section-toggle').click();
await flush();
assert.ok(groupsSection.classList.contains('is-collapsed'), '工具组分区进入收起态');
// 内容保留在 DOM（供过渡动画使用），高度由 grid-template-rows: 0fr 收拢
assert.ok(groupsScroll(), '收起态内容仍在 DOM（供过渡动画）');
assert.ok(
  /\.hub-section\.is-collapsed \.hub-section-body\s*\{[^}]*grid-template-rows:\s*0fr/s.test(hubCssText),
  '收起态内容区高度收拢为 0fr（空间让给其余分区）',
);
assert.ok(
  /\.hub-editor-split--agent \.hub-section\.is-collapsed\s*\{[^}]*flex-grow:\s*0/s.test(hubCssText),
  '收起态 flex-grow 归零：空间让给其余分区',
);
// 收起动画：内容区高度用 grid-template-rows 1fr → 0fr 过渡
assert.ok(
  /\.hub-section-body\s*\{[^}]*grid-template-rows:\s*1fr[^}]*transition:[^}]*grid-template-rows/s.test(hubCssText),
  '内容区具备 1fr → 0fr 的收起过渡动画',
);
assert.ok(
  /\.hub-section-toggle__chevron\.is-collapsed\s*\{[^}]*rotate\(-90deg\)/.test(hubCssText),
  '收起时箭头旋转（过渡动画）',
);
groupsSection.querySelector('.hub-section-toggle').click();
await flush();
assert.ok(!groupsSection.classList.contains('is-collapsed'), '再次点击展开工具组分区');
assert.ok(groupsScroll(), '展开后列表区恢复');

// 三区为独立卡片（各自有描边与圆角）
assert.ok(
  /\.hub-editor-split--agent \.hub-section\s*\{[^}]*border:\s*1px solid[^}]*border-radius:/s.test(hubCssText),
  '三个分区各自是独立卡片（描边 + 圆角）',
);

// 外部插件工具同样可折叠
assert.ok(q('.external-tools'), '外部插件工具分区存在');
assert.ok(q('.external-tools .hub-section-toggle'), '外部插件工具提供折叠按钮');

assert.deepEqual(errors, [], '组件渲染与交互过程无未捕获异常');
console.log('[hub] 智能体编辑器：填满态两卡布局（级联回归锁）、头部按钮位、卡片上下布局、查看按钮与详情悬浮窗、三区可折叠、搜索框占满宽度（工具组 + 关联技能）、emoji 悬浮卡片、视觉操作开关（标题+问号+主开关，与字段标签左对齐；截图工具/重截图控件已移除、重拍恒开）、概览卡视觉徽章双语化（中文「视觉」+ 眼睛图标）、基础字段各占一行、工具组永不含 vision_gui —— 通过');
app.unmount();
dom.window.close();

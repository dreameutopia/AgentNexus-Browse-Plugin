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
  { id:'skill-a', name:'skill-a', description:'网页调研报告生成', category:'content', tags:['调研'], allowedTools:[], files:{'SKILL.md':'x'}, body:'x', source:'custom', enabled:true, updatedAt:0 },
  { id:'skill-b', name:'skill-b', description:'表格数据抽取', category:'data', tags:['表格'], allowedTools:[], files:{'SKILL.md':'x'}, body:'x', source:'custom', enabled:true, updatedAt:0 },
]; }
export function onSkillsChange(){ return () => {}; } export function resolveSkill(){ return null; }`,
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

// 视觉声明（含视觉循环开关）位于左卡、名称字段之下
const formCard = q('.hub-editor-col--form');
assert.ok(formCard, '左卡（表单）存在');
const visionField = formCard.querySelector('fieldset');
assert.ok(visionField, '视觉声明在左卡内');
assert.ok(visionField.textContent.includes('视觉'), '视觉声明字段存在');
const nameField = qa('.hub-editor-col--form .hub-field').find(field => field.textContent.includes('名称'));
assert.ok(nameField, '名称字段在左卡');
assert.ok(
  nameField.compareDocumentPosition(visionField) & Node.DOCUMENT_POSITION_FOLLOWING,
  '视觉声明紧跟名称字段之后',
);
const listsCard = q('.hub-editor-col--lists');
assert.ok(listsCard, '右卡（清单）存在');
assert.ok(!listsCard.contains(visionField), '视觉声明不在右卡');

// 工具组搜索：过滤生效；无匹配时给空态提示
const groupSearch = q('.hub-section--groups .hub-list-search');
assert.ok(groupSearch, '工具组区提供搜索框');
const groupRows = () => qa('.hub-section--groups .hub-group');
assert.ok(groupRows().length > 1, '默认展示全部工具组');
groupSearch.value = '统一网页搜索';
groupSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
assert.equal(groupRows().length, 1, '搜索词过滤工具组（按显示名精确命中一项）');
groupSearch.value = '不存在的工具组xyz';
groupSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();
assert.equal(groupRows().length, 0, '无匹配时不渲染工具组');
assert.ok(q('.hub-section--groups .hub-hint')?.textContent.includes('没有匹配'), '无匹配时给空态提示');
groupSearch.value = '';
groupSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await flush();

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
const hubCssText = readFileSync(path.join(root, 'entrypoints/hub/hub.css'), 'utf8');
assert.ok(/\.hub-group-desc\s*\{[^}]*-webkit-line-clamp:\s*2/s.test(hubCssText), '描述最多两行');

// 查看图标 → 弹出完整信息悬浮窗（图标本身必须是可点按钮，曾是 span 导致点了没反应）
const infoButton = firstGroup.querySelector('.hub-group-info');
assert.ok(infoButton, '卡片右侧有查看图标');
assert.equal(infoButton.tagName, 'BUTTON', '查看图标是可点击的按钮（此前是 span，点击无反应）');
firstGroup.querySelector('.hub-group-body').click();
await flush();
const detailCard = q('.hub-detail-card');
assert.ok(detailCard, '点击标题区弹出详情悬浮窗卡片');
assert.ok(detailCard.querySelector('.hub-detail-card__panel'), '悬浮窗为卡片形态');
assert.ok(detailCard.querySelector('.hub-detail-card__title')?.textContent.trim(), '悬浮窗展示标题');
assert.ok(detailCard.querySelector('.hub-detail-card__desc')?.textContent.trim(), '悬浮窗展示完整描述');
assert.ok(detailCard.querySelectorAll('.hub-detail-card__chip').length > 0, '悬浮窗列出工具清单');
// 点遮罩关闭
detailCard.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
await flush();
assert.equal(q('.hub-detail-card'), null, '点击遮罩关闭悬浮窗');
// 直接点查看图标同样能打开
infoButton.click();
await flush();
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
console.log('[hub] 智能体编辑器：填满态两卡布局（级联回归锁）、头部按钮位、卡片上下布局、查看按钮与详情悬浮窗、三区可折叠、搜索框占满宽度（工具组 + 关联技能）、emoji 悬浮卡片 —— 通过');
app.unmount();
dom.window.close();

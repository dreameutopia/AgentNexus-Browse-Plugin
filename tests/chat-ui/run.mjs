/** Mount the actual compiled script-setup component. A source-order string test
 * would miss TDZ failures introduced by future watcher dependencies. */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const file=path.resolve('entrypoints/sidepanel/components/chat/ChatMessageList.vue');
const {descriptor}=parse(readFileSync(file,'utf8'),{filename:file});
const script=compileScript(descriptor,{id:'chat-list-regression'});
const output=path.resolve('node_modules/.cache/chat-list-regression.mjs');
mkdirSync(path.dirname(output),{recursive:true});
await build({stdin:{contents:script.content,loader:'ts',resolveDir:path.dirname(file)},outfile:output,
  bundle:true,platform:'node',format:'esm',external:['vue'],loader:{'.css':'empty'},plugins:[{
    name:'unrelated-view-stubs',setup(api){
      api.onResolve({filter:/\.vue$|@\/utils\/i18n$|utils\/chat\/(diagram|chart|agent-image)-renderer$/},args=>({path:args.path,namespace:'ui-stub'}));
      api.onLoad({filter:/.*/,namespace:'ui-stub'},args=>({contents:args.path.endsWith('.vue')?'export default {};':args.path==='@/utils/i18n'?'export const t=key=>key;':'export const installDiagramRenderer=()=>{};export const processDiagrams=()=>{};export const installChartRenderer=()=>{};export const processCharts=()=>{};export const installAgentImageRenderer=()=>{};export const processAgentImages=()=>{};'}));
    },
  }]});
const dom=new JSDOM('<div id="app"></div>',{url:'https://example.test/'});
for(const key of ['window','document','Element','HTMLElement','SVGElement','Node','MutationObserver'])globalThis[key]=dom.window[key];
const {createApp,h,nextTick,reactive}=await import('vue');
const {default:component}=await import(pathToFileURL(output).href);
const props=reactive({messages:[],showChatMode:true,isAiResponding:false});
const errors=[];
const app=createApp({...component,render(){return h('div');}},props);
app.config.errorHandler=error=>errors.push(error);
try{
  const instance=app.mount('#app');
  assert.deepEqual(errors,[],'Initial setup/watch source evaluation must not throw');
  props.messages.push({id:'one',content:'first'},{id:'one',content:'duplicate'},{id:'ignored',content:'hidden',isIgnore:true},{content:'without id'});
  props.isAiResponding=true;
  await nextTick();
  const messages=instance.$.setupState.filteredMessages;
  assert.equal(messages.length,2);assert.equal(messages[0].content,'first');
  props.messages[0].content+=' streamed token';
  await nextTick();assert.deepEqual(errors,[],'Streaming updates must not recreate the initialization error');
  console.log('[chat-ui] Actual ChatMessageList script setup, initial watcher evaluation, filtering and streaming updates passed.');
}finally{app.unmount();dom.window.close();}
// 使用统计 UI 已迁至管理中心，覆盖随组件迁至 tests/hub/usage-python.test.mjs
// （侧边栏旧组件与其回归用例一并移除，避免悬空测试）
const learn = spawnSync(process.execPath, [path.resolve('tests/chat-ui/learn-session.test.mjs')], { stdio: 'inherit' });
assert.equal(learn.status, 0, 'Learning/validation chat UI regression');
const questions = spawnSync(process.execPath, [path.resolve('tests/chat-ui/questions.test.mjs')], { stdio: 'inherit' });
assert.equal(questions.status, 0, 'Shared user question callback regression');
const limits = spawnSync(process.execPath, [path.resolve('tests/chat-ui/learn-limits.test.mjs')], { stdio: 'inherit' });
assert.equal(limits.status, 0, 'Learning/validation budget choices regression');
const handoff = spawnSync(process.execPath, [path.resolve('tests/chat-ui/learn-handoff.test.mjs')], { stdio: 'inherit' });
assert.equal(handoff.status, 0, 'Learning result durable handoff regression');
const recovery = spawnSync(process.execPath, [path.resolve('tests/chat-ui/learn-recovery.test.mjs')], { stdio: 'inherit' });
assert.equal(recovery.status, 0, 'Learning result receipt sync and persistent dismissal regression');
const scroll = spawnSync(process.execPath, [path.resolve('tests/chat-ui/scroll-follow.test.mjs')], { stdio: 'inherit' });
assert.equal(scroll.status, 0, 'Scroll follow regression');
const apiErrorCard = spawnSync(process.execPath, [path.resolve('tests/chat-ui/api-error-card.test.mjs')], { stdio: 'inherit' });
assert.equal(apiErrorCard.status, 0, 'API error card request-model panel regression');
const richComponents = spawnSync(process.execPath, [path.resolve('tests/chat-ui/rich-components.test.mjs')], { stdio: 'inherit' });
assert.equal(richComponents.status, 0, 'Rich components (envelope/registry/derivation/blocks) regression');
const streamingMarkdown = spawnSync(process.execPath, [path.resolve('tests/chat-ui/streaming-markdown.test.mjs')], { stdio: 'inherit' });
assert.equal(streamingMarkdown.status, 0, 'Streaming incremental freeze (boundary + MarkdownText host) regression');
const pythonWorkspace = spawnSync(process.execPath, [path.resolve('tests/chat-ui/python-workspace.test.mjs')], { stdio: 'inherit' });
assert.equal(pythonWorkspace.status, 0, 'Python workspace storage and download card regression');
const chatDatabase = spawnSync(process.execPath, [path.resolve('tests/chat-ui/chat-database.test.mjs')], { stdio: 'inherit' });
assert.equal(chatDatabase.status, 0, 'Chat database migrations and stream persistence regression');
const visionTimeline = spawnSync(process.execPath, [path.resolve('tests/chat-ui/vision-timeline.test.mjs')], { stdio: 'inherit' });
assert.equal(visionTimeline.status, 0, 'Vision screenshot timeline ordering regression');
const guardConfirm = spawnSync(process.execPath, [path.resolve('tests/chat-ui/guard-confirm.test.mjs')], { stdio: 'inherit' });
assert.equal(guardConfirm.status, 0, 'Guard confirm bar (plan-card design language) regression');

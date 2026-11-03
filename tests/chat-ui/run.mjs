/** Mount the actual compiled script-setup component. A source-order string test
 * would miss TDZ failures introduced by future watcher dependencies. */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const file=path.resolve('entrypoints/sidepanel/components/chat/ChatMessageList.vue');
const {descriptor}=parse(readFileSync(file,'utf8'),{filename:file});
const script=compileScript(descriptor,{id:'chat-list-regression'});
const output=path.resolve('node_modules/.cache/chat-list-regression.mjs');
mkdirSync(path.dirname(output),{recursive:true});
await build({stdin:{contents:script.content,loader:'ts',resolveDir:path.dirname(file)},outfile:output,
  bundle:true,platform:'node',format:'esm',external:['vue'],loader:{'.css':'empty'},plugins:[{
    name:'unrelated-view-stubs',setup(api){
      api.onResolve({filter:/\.vue$|@\/utils\/i18n$|utils\/chat\/(diagram|chart)-renderer$/},args=>({path:args.path,namespace:'ui-stub'}));
      api.onLoad({filter:/.*/,namespace:'ui-stub'},args=>({contents:args.path.endsWith('.vue')?'export default {};':args.path==='@/utils/i18n'?'export const t=key=>key;':'export const installDiagramRenderer=()=>{};export const processDiagrams=()=>{};export const installChartRenderer=()=>{};export const processCharts=()=>{};'}));
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

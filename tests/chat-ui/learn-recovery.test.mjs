/** Actual App recovery markup/click handler + controller + custom dialog + durable outbox. */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const root=process.cwd(), file=path.resolve('entrypoints/sidepanel/views/App.vue');
const {descriptor}=parse(readFileSync(file,'utf8'));
const ast=ts.createSourceFile('App.ts',descriptor.scriptSetup.content,ts.ScriptTarget.Latest,true);
const retry=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='retryCreateSkillFromLearn').getText(ast);
const template=descriptor.template.content, position=template.indexOf('class="learn-recover-notice"');
const recovery=template.slice(template.lastIndexOf('<div',position),template.indexOf('<!-- 未配置提示',position));
const dialog=template.match(/<LearnRecoveryDismissDialog\b[^>]*\/>/)[0];
const outfile=path.resolve('node_modules/.cache/learn-recovery-test.mjs');mkdirSync(path.dirname(outfile),{recursive:true});
await build({stdin:{contents:`export * from './utils/learn/learn-draft-store';export {default as Recovery} from 'recovery-wrapper';`,resolveDir:root,loader:'ts'},outfile,bundle:true,platform:'node',format:'esm',external:['vue'],alias:{'@':root},loader:{'.css':'empty'},plugins:[{name:'recovery-ui',setup(api){
  api.onResolve({filter:/^recovery-wrapper$/},()=>({path:'wrapper',namespace:'wrapper'}));
  api.onLoad({filter:/.*/,namespace:'wrapper'},()=>{
    const source=`<script setup lang="ts">import {computed,ref} from 'vue';import {t} from '@/utils/i18n';import {useLearnRecovery} from '@/entrypoints/sidepanel/composables/use-learn-recovery';import LearnRecoveryDismissDialog from '@/entrypoints/sidepanel/components/learn/LearnRecoveryDismissDialog.vue';import {saveLearnDraft} from '@/utils/learn/learn-draft-store';import {learnDraftHash} from '@/utils/learn/learn-types';const props=defineProps<{source:any}>();const learnRecoverySource=computed(()=>props.source),learnRecoveryState=useLearnRecovery(learnRecoverySource),retryingLearnDraft=ref(false);const learn={isLearnActive:{value:false}};const {toast,openHubWithHash,downloadLearnRecovery}=globalThis.__recoveryPorts;${retry}defineExpose({state:learnRecoveryState});</script><template>${recovery}${dialog}</template>`;
    const {descriptor}=parse(source);return {contents:compileScript(descriptor,{id:'recovery-wrapper',inlineTemplate:true}).content,loader:'ts',resolveDir:root};
  });
  api.onResolve({filter:/@\/utils\/i18n$/},()=>({path:'locale',namespace:'locale'}));
  api.onLoad({filter:/.*/,namespace:'locale'},()=>({contents:`import zh from './utils/i18n/locales/zh-CN';export const t=(key)=>key.split('.').reduce((value,key)=>value?.[key],zh)??key;`,loader:'ts',resolveDir:root}));
  api.onLoad({filter:/\.vue$/},args=>{const {descriptor}=parse(readFileSync(args.path,'utf8'));return {contents:compileScript(descriptor,{id:args.path,inlineTemplate:true}).content,loader:'ts',resolveDir:path.dirname(args.path)};});
}}],logLevel:'silent'});

const dom=new JSDOM('<button id="prior-focus">Previous</button>',{url:'https://extension.test/sidepanel.html',pretendToBeVisual:true});
for(const key of ['window','document','Element','HTMLElement','HTMLButtonElement','SVGElement','Node','MutationObserver'])globalThis[key]=dom.window[key];
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const writes=new Map();Object.defineProperty(navigator,'locks',{value:{request(name,work){const task=(writes.get(name)??Promise.resolve()).catch(()=>{}).then(work);writes.set(name,task);return task;}},configurable:true});
const storage={}, listeners=new Set();let failRead=false,failWrite=false,notify=true,writeCount=0,gate=null;
globalThis.chrome={storage:{local:{
  async get(keys){if(failRead)throw Error('read unavailable');const result=Object.fromEntries((keys==null?Object.keys(storage):Array.isArray(keys)?keys:[keys]).filter(key=>key in storage).map(key=>[key,structuredClone(storage[key])]));if(gate){const wait=gate;gate=null;wait.enter();await wait.promise;}return result;},
  async getKeys(){if(failRead)throw Error('read unavailable');return Object.keys(storage);},
  async set(values){if(failWrite)throw Error('quota unavailable');writeCount++;const changes={};for(const [key,value]of Object.entries(values)){changes[key]={oldValue:structuredClone(storage[key]),newValue:structuredClone(value)};storage[key]=structuredClone(value);}if(notify)queueMicrotask(()=>listeners.forEach(listener=>listener(changes,'local')));},
},onChanged:{addListener:listener=>listeners.add(listener),removeListener:listener=>listeners.delete(listener)}}};
const opened=[],downloads=[],toasts=[];
globalThis.__recoveryPorts={openHubWithHash:async hash=>{opened.push(hash);return true;},downloadLearnRecovery:()=>downloads.push(true),toast:{error:value=>toasts.push(value),info:value=>toasts.push(value)}};
const api=await import(pathToFileURL(outfile).href);
const {createApp,h,ref,nextTick}=await import('vue');
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check,label){for(let i=0;i<150;i++){await tick();await nextTick();if(await check())return;}throw Error('Timed out: '+label);}
const draft={name:'example-search-items',description:'查找条目',category:'search',tags:[],body:'可复用步骤',allowedTools:['browser_observe'],mode:'text'};
const source=id=>({chatId:id,draft:structuredClone(draft)});
const mounted=[];const errors=[];
function mount(value){const candidate=ref(value),host=document.createElement('div');document.body.append(host);let instance;const app=createApp({setup:()=>()=>h(api.Recovery,{source:candidate.value,ref:value=>instance=value})});app.config.errorHandler=error=>errors.push(error);app.mount(host);const result={app,host,candidate,get state(){return instance.state;},close(){app.unmount();host.remove();}};mounted.push(result);return result;}
const button=(ui,which)=>ui.host.querySelector(which==='ignore'?'.learn-recover-btn--ignore':'.learn-recover-btn--primary');

try{
  const savedSource=source('saved');const saved=await api.saveLearnDraft(savedSource.draft,savedSource.chatId);await api.completeLearnDraft(saved.id,'skill-1');
  const savedUI=mount(savedSource);assert.equal(savedUI.host.querySelector('.learn-recover-notice'),null,'初始核对期间不闪现已处理提示');
  await until(()=>savedUI.state.status.value==='saved','saved receipt');assert.equal(savedUI.host.querySelector('.learn-recover-notice'),null);
  savedUI.close();const reopened=mount(source('saved'));await until(()=>reopened.state.status.value==='saved','history reopened');assert.equal(button(reopened,'create'),null,'重开历史会话仍隐藏');

  const stale=source('missed-event'),receipt=await api.saveLearnDraft(stale.draft,stale.chatId),staleUI=mount(stale);
  await until(()=>button(staleUI,'create'),'stale banner');notify=false;await api.completeLearnDraft(receipt.id,'skill-2');notify=true;
  assert.ok(button(staleUI,'create'),'模拟漏投storage事件');button(staleUI,'create').click();await until(()=>!button(staleUI,'create'),'click preflight synchronizes');assert.equal(opened.length,0,'已创建时点击不再导航管理中心');

  const shared=source('cross-context'),sharedReceipt=await api.saveLearnDraft(shared.draft,shared.chatId),first=mount(shared),second=mount(source(shared.chatId));
  await until(()=>button(first,'create')&&button(second,'create'),'both contexts visible');
  await api.completeLearnDraft(sharedReceipt.id,'skill-3');await until(()=>!button(first,'create')&&!button(second,'create'),'remote save hides both banners');

  const ignored=mount(source('ignore')),ignoredPeer=mount(source('ignore'));await until(()=>button(ignored,'ignore')&&button(ignoredPeer,'ignore'),'ignore controls');
  button(ignored,'ignore').focus();button(ignored,'ignore').click();await until(()=>document.querySelector('[role="alertdialog"]'),'custom confirmation');
  assert.ok(document.querySelector('#learn-dismiss-title').textContent.includes('忽略本次学习'));
  const cancel=document.querySelector('.learn-dismiss-footer .learn-btn--ghost');assert.equal(document.activeElement,cancel,'默认聚焦取消，避免误确认');
  cancel.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true}));assert.equal(document.activeElement,document.querySelector('.learn-dismiss-footer .learn-btn--primary'),'Tab焦点不离开弹窗');
  cancel.click();await until(()=>!document.querySelector('[role="alertdialog"]'),'cancel');assert.ok(button(ignored,'create'));assert.equal(document.activeElement,button(ignored,'ignore'),'关闭恢复原触发按钮焦点');
  button(ignored,'ignore').click();await nextTick();failWrite=true;document.querySelector('.learn-dismiss-footer .learn-btn--primary').click();
  await until(()=>document.querySelector('.learn-dismiss-error'),'ignore write failure');assert.ok(button(ignored,'create'),'写入失败不隐藏恢复副本');assert.equal((await api.readLearnRecovery(draft,'ignore')).status,'available');
  failWrite=false;const confirm=document.querySelector('.learn-dismiss-footer .learn-btn--primary'),before=writeCount;confirm.click();confirm.click();
  await until(()=>!button(ignored,'create')&&!button(ignoredPeer,'create'),'ignore sync');assert.equal(writeCount,before+1,'双击只写入一次');
  const ignoreState=await api.readLearnRecovery(draft,'ignore'),original=await api.readLearnDraft(ignoreState.transferId);
  assert.equal(ignoreState.status,'ignored');assert.equal(original.transfer.draft.body,draft.body,'忽略保留原稿');assert.equal(original.transfer.status,'pending','不使已打开的编辑失效');
  assert.ok(!(await api.listLearnDrafts()).transfers.some(item=>item.id===ignoreState.transferId),'管理中心待接收列表也隐藏');
  ignored.close();const restoredIgnore=mount(source('ignore'));await until(()=>restoredIgnore.state.status.value==='ignored','ignore after reopen');assert.equal(button(restoredIgnore,'create'),null);
  failRead=true;window.dispatchEvent(new window.Event('focus'));await tick();await nextTick();assert.equal(button(restoredIgnore,'create'),null,'已确认忽略不会因后续读取失败重现');failRead=false;
  assert.equal((await api.completeLearnDraft(ignoreState.transferId,'skill-open-editor')).ok,true,'忽略前已打开的编辑仍可保存确认');

  const independent=mount(source('other-chat'));await until(()=>button(independent,'create'),'other session unaffected');
  button(independent,'ignore').click();await nextTick();independent.candidate.value=source('new-chat');await until(()=>button(independent,'create')&&!document.querySelector('[role="alertdialog"]'),'switch closes confirmation');
  assert.equal((await api.readLearnRecovery(draft,'new-chat')).status,'available','不忽略切换后的会话');
  const racing=source('racing');const racingReceipt=await api.saveLearnDraft(draft,racing.chatId);
  await Promise.all([api.dismissLearnRecovery(draft,racing.chatId),api.completeLearnDraft(racingReceipt.id,'skill-race')]);
  const final=(await api.readLearnDraft(racingReceipt.id)).transfer;assert.equal(final.status,'saved');assert.equal(final.recoveryDismissed,true,'忽略和保存并发不覆盖彼此状态');
  const mismatched=await api.saveLearnDraft(draft,'bad-source');storage[api.LEARN_TRANSFER_PREFIX+mismatched.id].sourceChatId='different-chat';
  assert.equal((await api.readLearnRecovery(draft,'bad-source')).ok,false,'不采信与会话不匹配的记录');
  assert.equal((await api.dismissLearnRecovery(draft,'bad-source')).ok,false,'不修改不匹配的其他会话记录');

  const delayed=mount(source('delayed'));await until(()=>button(delayed,'create'),'delayed source');const delayedReceipt=await api.saveLearnDraft(draft,'delayed');await tick();
  let release,entered=false;gate={enter:()=>entered=true,promise:new Promise(resolve=>release=resolve)};
  const reading=delayed.state.refresh();await until(()=>entered,'pending read captured');await api.completeLearnDraft(delayedReceipt.id,'skill-delayed');
  await until(()=>delayed.state.status.value==='saved','new status wins');release();await reading;
  assert.equal(button(delayed,'create'),null,'旧异步结果不能覆盖较新的保存状态');
  const switching=mount(source('switch-create'));await until(()=>button(switching,'create'),'switch create source');
  let releaseCreate,enteredCreate=false;gate={enter:()=>enteredCreate=true,promise:new Promise(resolve=>releaseCreate=resolve)};
  button(switching,'create').click();await until(()=>enteredCreate,'create preflight captured');switching.candidate.value=source('switch-create-new');
  await until(()=>switching.state.visible.value,'new source visible');releaseCreate();await tick();await nextTick();
  assert.equal(opened.length,0,'检查期间切换会话，不导航旧成果');
  const oldState=await api.readLearnRecovery(draft,'switch-create');assert.equal((await api.readLearnDraft(oldState.transferId)).status,'none','不留下旧会话孤立交接记录');
  failRead=true;const unavailable=mount(source('unavailable'));await until(()=>unavailable.state.syncError.value,'read failure');assert.ok(button(unavailable,'create'),'存储异常仍保留下载入口');
  button(unavailable,'create').click();await tick();await nextTick();assert.equal(opened.length,0,'状态不明禁止再创建');unavailable.host.querySelectorAll('.learn-recover-btn')[1].click();assert.equal(downloads.length,1);failRead=false;
  assert.deepEqual(errors,[]);
  console.log('[chat-ui] Recovery receipt sync, click preflight, persistent ignore, confirmation/cancel/failure/focus, cross-context updates, races and history reopening passed.');
}finally{for(const ui of mounted)if(ui.host.isConnected)ui.close();assert.equal(listeners.size,0,'unmount removes all storage listeners');dom.window.close();}

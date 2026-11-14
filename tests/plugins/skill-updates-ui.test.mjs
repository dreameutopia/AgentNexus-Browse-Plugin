import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
const file=path.resolve('entrypoints/hub/plugins/components/PluginSkillUpdates.vue');
const script=compileScript(parse(readFileSync(file,'utf8'),{filename:file}).descriptor,{id:'plugin-skill-ui-test',inlineTemplate:true});
const out=path.resolve('node_modules/.cache/plugin-skill-ui-test.mjs');mkdirSync(path.dirname(out),{recursive:true});
await build({stdin:{contents:script.content,loader:'ts',resolveDir:path.dirname(file)},outfile:out,bundle:true,platform:'node',format:'esm',external:['vue'],plugins:[{name:'ports',setup(api){api.onResolve({filter:/utils\/(plugins\/managed-skills|skills\/(skill-import-export|skill-store)|i18n)$/},args=>({path:args.path,namespace:'fake'}));api.onLoad({filter:/.*/,namespace:'fake'},args=>({contents:args.path.endsWith('managed-skills')?`export const MANAGED_SKILLS_KEY='managed';export const pendingPluginSkillUpdateSummaries=async()=>globalThis.pending.map(({pending,localContent,incomingContent,resourceChanges,...item})=>({...item,pending:{digest:pending.digest,version:pending.version}}));export const pendingPluginSkillUpdates=async(ref)=>{globalThis.detailReads++;return structuredClone(globalThis.pending.filter(item=>!ref||item.ref===ref));};export const approvePluginSkillUpdate=async(...args)=>{globalThis.approvals.push(args);if(globalThis.failApproval)throw Error('changed');globalThis.pending=[];};`:args.path.endsWith('skill-import-export')?'export const downloadSkillZip=skill=>globalThis.downloads.push(skill);':args.path.endsWith('skill-store')?'export const getSkillById=()=>({name:"fixture",files:{"SKILL.md":"local"}});':'export const t=key=>key;'}));}}]});
const dom=new JSDOM('<div id="app"></div>',{url:'https://example.com'});for(const key of ['window','document','Element','HTMLElement','SVGElement','Node','MutationObserver'])globalThis[key]=dom.window[key];
const listeners=new Set();globalThis.chrome={storage:{onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}}};
globalThis.pending=[{ref:'plugin/skill',id:'1001',name:'example-export',pluginName:'Example',version:'1',localContent:'User workflow',localUpdatedAt:10,pending:{digest:'hash2',version:'2',input:{name:'example-export',files:{'SKILL.md':'Improved workflow'}}},incomingContent:'Improved workflow',resourceChanges:[{path:'resources/export.js',kind:'changed',oldText:'old',newText:'new'}]}];
globalThis.approvals=[];globalThis.downloads=[];globalThis.detailReads=0;
const {createApp,nextTick}=await import('vue'),{default:Component}=await import(pathToFileURL(out).href);
const app=createApp(Component);app.mount('#app');
const tick=async()=>{await new Promise(resolve=>setTimeout(resolve,0));await nextTick();};
const click=async(selector)=>{assert.ok(document.querySelector(selector),selector);document.querySelector(selector).click();await tick();};
try {
 await tick();await click('.psu-entry');assert.ok(document.querySelector('.psu-count').textContent.includes('1'));assert.equal(document.querySelector('.psu-approve'),null);assert.equal(detailReads,0,'资源差异在用户审阅时才加载');
 await click('.psu-item header button');assert.match(document.querySelector('.psu-review').textContent,/User workflow/);assert.match(document.querySelector('.psu-review').textContent,/Improved workflow/);assert.match(document.querySelector('details').textContent,/resources\/export.js/);assert.equal(approvals.length,0);
 await click('.psu-downloads button:last-child');assert.equal(downloads.length,1);
 pending[0].localUpdatedAt=11;pending[0].localContent='Edited while reviewing';listeners.forEach(fn=>fn({agentNexusCustomSkills:{}},'local'));await tick();assert.equal(document.querySelector('.psu-approve'),null,'Local edits invalidate the prior review');
 await click('.psu-item header button');globalThis.failApproval=true;await click('.psu-approve');assert.deepEqual(approvals[0],['plugin/skill','hash2',11]);assert.match(document.querySelector('[role="alert"]').textContent,/changed/);
 globalThis.failApproval=false;await click('.psu-approve');assert.equal(document.querySelector('.psu-item'),null);assert.ok(document.querySelector('.psu-content').textContent.includes('skillUpdatesEmpty'));
 console.log('[plugin-skill-ui] Pending count, side-by-side content/resource review, full download, stale-review invalidation and approval failure/success passed.');
} finally {app.unmount();assert.equal(listeners.size,0);dom.window.close();}

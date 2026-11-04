import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { visionReadPayload } from '../../tools/vision/read-payload';
import { validateReadArgs, createVisionReadTools } from '../../tools/vision/read-tools';
import { filterVisionAssistantTools, isVisionAssistantTool } from '../../utils/agents/vision-assistant-policy';
import { needsVisionRefresh, takeVisionToolImage, withoutVisionImage } from '../../entrypoints/sidepanel/core/conversation/vision-feedback';

assert.deepEqual(filterVisionAssistantTools(['screenshot','browser_page_exec','browser_scroll','vision_gui','vision_read','vision_read']), ['screenshot','vision_read']);
for (const id of ['browser_navigate','browser_interact','browser_inject_script','vision_gui','vision_gui']) assert.equal(isVisionAssistantTool(id), false);
for (const tool of createVisionReadTools()) assert.equal(isVisionAssistantTool(tool.name), true);
for (const [action, args] of [
  ['read', null], ['read', []], ['read', { screenshotId:'s',code:'document.body.click()' }],
  ['constructor', {}], ['__proto__', {}],
  ['scroll', { screenshotId:'s',direction:'down',clickBox:[0,0,1,1] }],
  ['scroll', { screenshotId:'s',direction:'down',modifiers:['Control'] }],
  ['scroll', { screenshotId:'s',direction:'down',percent:NaN }],
  ['scroll', { screenshotId:'s',direction:'down',percent:101 }],
  ['scroll', { screenshotId:'s',direction:'diagonal' }],
  ['zoom', { screenshotId:'s',region:{x:900,y:0,width:200,height:10} }],
  ['zoom', { screenshotId:'s',region:{x:0,y:0,width:0,height:10} }],
  ['zoom', { screenshotId:'s',region:{x:0,y:0,width:10,height:10},scale:Infinity }],
  ['wait', { timeoutMs:5001 }], ['wait', { screenshotId:'s' }],
  ['read', { screenshotId:'s',point:{x:0,y:0,z:1} }],
] as const) assert.throws(() => validateReadArgs(action, args), `${action} must reject ${JSON.stringify(args)}`);
validateReadArgs('zoom', { screenshotId:'s',region:{x:0,y:0,width:1000,height:1000} });
validateReadArgs('scroll', { screenshotId:'s',direction:'left',percent:1 });

const imageResult = { success:true, data:{ screenshot:'data:image/png;base64,cG5n',text:'source s',screenshotId:'s' } };
const image = takeVisionToolImage(imageResult, 0)!;
assert.ok(image);
assert.equal(JSON.stringify(withoutVisionImage(imageResult)).includes('base64'), false);
assert.equal(imageResult.data.screenshot.includes('base64'), true, 'Extraction must not mutate UI result');
const none = () => undefined;
assert.equal(needsVisionRefresh(['screenshot'], [image], none), false);
assert.equal(needsVisionRefresh(['screenshot','vision_read','plan_tool'], [image], none), false);
assert.equal(needsVisionRefresh(['screenshot','vision_gui'], [image], none), true);
assert.equal(needsVisionRefresh(['vision_gui','screenshot'], [{...image,callIndex:1}], none), false);
assert.equal(needsVisionRefresh(['screenshot'], [], none), true);
assert.equal(needsVisionRefresh(['vision_read_wait'], [], ()=>'none'), true);
assert.equal(needsVisionRefresh(['unknown_tool'], [], none), true);
assert.equal(needsVisionRefresh(['vision_read_zoom'], [{...image,kind:'region'}], none), false);
assert.equal(needsVisionRefresh(['vision_read_scroll'], [], ()=>'after'), true);

// Execute serialized production payload in an independent realm.
const dom = new JSDOM('<!doctype html><style>body{opacity:1}</style><button id="pay" disabled>Pay</button><input id="secret" type="password" value="private-secret"><div id="off">OFFSCREEN</div><div id="scroller" style="overflow-y:auto;overflow-x:auto;opacity:1"><button id="inside">Inside</button></div>', {runScripts:'outside-only'} as any);
const w = dom.window as any;
w.HTMLElement.prototype.getBoundingClientRect = function () {
  const y = this.id === 'off' ? 2000 : 20;
  return { x:20,y,left:20,top:y,right:220,bottom:y+60,width:200,height:60 };
};
w.Range.prototype.getClientRects = () => [{left:20,top:20,right:220,bottom:80}];
const payload = w.eval(`(${visionReadPayload.toString()})`);
const read = await payload('read', {});
assert.ok(read.text.includes('Pay'));
assert.equal(read.text.includes('OFFSCREEN'), false);
assert.equal(JSON.stringify(read).includes('private-secret'), false);
assert.equal(read.controls.find((el:any)=>el.name==='Pay').disabled, true);
assert.equal(read.coverage.complete, false);
const secret = w.document.querySelector('#secret');
w.document.elementFromPoint = () => secret;
const pointRead = await payload('read', {point:{x:30,y:30}});
assert.equal(pointRead.controls[0].password,true);
assert.equal(JSON.stringify(pointRead).includes('private-secret'),false);
const scroller = w.document.querySelector('#scroller'), inside = w.document.querySelector('#inside');
for (const [key,value] of Object.entries({clientWidth:200,clientHeight:100,scrollWidth:600,scrollHeight:1000})) Object.defineProperty(scroller,key,{value});
let clicks=0, focus=0;
w.document.addEventListener('click',()=>clicks++);
w.document.addEventListener('focusin',()=>focus++);
w.document.elementFromPoint = () => inside;
scroller.scrollTo = ({left,top}:any) => { scroller.scrollLeft=Math.max(0,Math.min(400,left)); scroller.scrollTop=Math.max(0,Math.min(900,top)); };
const down = await payload('scroll', {point:{x:30,y:30},direction:'down',percent:75});
assert.equal(down.delta.y,75); assert.equal(down.moved,true);
assert.equal(down.settled,true); assert.equal(w.scrollY,0);
const right = await payload('scroll', {point:{x:30,y:30},direction:'right',percent:50});
assert.equal(right.delta.x,100);
scroller.scrollTop=900;
const edge = await payload('scroll', {point:{x:30,y:30},direction:'down',percent:75});
assert.equal(edge.moved,false); assert.equal(w.scrollY,0,'Must not fall through to document at component edge');
assert.equal(clicks,0); assert.equal(focus,0);
Object.defineProperty(w.document,'scrollingElement',{value:w.document.documentElement});
w.document.documentElement.style.overflowY='hidden';
const locked = await payload('scroll', {direction:'down',percent:75});
assert.equal(locked.moved,false); assert.match(locked.reason,/locked/);
// Large pages must preserve valid bounded JSON and its coverage/truncation flags.
w.document.documentElement.style.overflowY='';
w.document.body.innerHTML=Array.from({length:100},()=>'<button>'+('large label '.repeat(80))+'</button>').join('');
const large = await payload('read', {});
assert.equal(large.truncated,true); assert.ok(JSON.stringify(large).length<=6500);
dom.window.close();

// Real execution gateway rejects invented/skill-expanded tools before execution
// or approval; this must hold even if a provider ignores advertised schemas.
const { ConversationEngine } = await import('../../entrypoints/sidepanel/core/conversation/conversation-engine');
const { setCustomSkill } = await import('../../utils/skills/skill-store');
const { runtimeBuilder } = await import('../../entrypoints/sidepanel/core/runtime/runtime-builder');
const { modelRegistry } = await import('../../entrypoints/sidepanel/utils/channels');
const { imageStore } = await import('../../entrypoints/sidepanel/core/images/image-store');
let executed = 0, approvals = 0;
const previousWindow=(globalThis as any).window;
(globalThis as any).window=globalThis;
const engine = new ConversationEngine({
  executeTool: async () => { executed++; return {success:true,data:{text:'ok'}}; },
  requiresApproval: () => { approvals++; return false; },
  sendStream: async () => { throw new Error('Not used'); }, sendVision: async () => { throw new Error('Not used'); },
} as any) as any;
const runtime:any = { chatId:'vision-guide-test',toolPolicy:'vision-assistant',toolIds:['screenshot','vision_read','load_skill','browser_get_page_text'],vision:null,
  limits:{maxDurationMs:60000,toolTimeoutMs:1000} };
const handle:any = {abortController:new AbortController(),dynamicToolIds:new Set(['browser_page_exec']),record:{toolCalls:[],parts:[]},toolCallCount:0};
const calls = (name:string,args:any={}) => [{id:'c',type:'function',function:{name,arguments:JSON.stringify(args)}}];
for (const name of ['browser_page_exec','vision_gui','unadvertised']) {
  const outcome = await engine.executeToolCalls(runtime,handle,calls(name),{},()=>{},Date.now()+60000);
  assert.equal(outcome.anyFailure,true); assert.match(outcome.messages[0].content,/TOOL_NOT_ALLOWED/);
}
const targeted = await engine.executeToolCalls(runtime,handle,calls('browser_get_page_text',{tabId:999}),{},()=>{},Date.now()+60000);
assert.equal(targeted.anyFailure,true);
assert.equal(executed,0); assert.equal(approvals,0);
let captures = 0;
let captureParameters:unknown;
const visualEngine = new ConversationEngine({
  executeTool: async (_name:string,parameters:unknown) => { captures++; captureParameters=parameters; return imageResult; }, requiresApproval:()=>false,
  sendStream: async()=>{throw new Error('Not used');},sendVision:async()=>{throw new Error('Not used');},
} as any) as any;
const visualRuntime={...runtime,vision:{screenshotTool:'screenshot',screenshotArgs:{},reScreenshotAfterTools:true}};
const imageWrite=imageStore.putFromDataUrl;
imageStore.putFromDataUrl=async()=> 'test-image-ref';
try {
  const outcome=await visualEngine.executeToolCalls(visualRuntime,handle,calls('screenshot',{mode:'action'}),{},()=>{},Date.now()+60000);
  assert.deepEqual(captureParameters,{mode:'observe'},'Guide cannot cause debugger attachment via mode override');
  assert.equal(outcome.images.length,1);assert.equal(outcome.messages[0].content.includes('base64'),false);
  const feedback=await visualEngine.buildVisionContinuationMessage(visualRuntime,calls('screenshot'),outcome.messages,outcome.images,new AbortController().signal);
  assert.equal(captures,1,'Manual screenshot must not be recaptured');
  assert.equal(feedback.message.content.filter((part:any)=>part.type==='image_url').length,1);
  assert.equal(feedback.message.content.find((part:any)=>part.type==='image_url').image_url.detail,'high');
  assert.deepEqual(feedback.imageRefs,['test-image-ref']);
  const passive=await visualEngine.buildVisionContinuationMessage(visualRuntime,calls('vision_read'),[{role:'tool',content:'{"success":true}'}],[],new AbortController().signal);
  assert.equal(passive,null);assert.equal(captures,1);
  const regionImage={...image,kind:'region' as const};
  const regionFeedback=await visualEngine.buildVisionContinuationMessage({...visualRuntime,vision:{...visualRuntime.vision,reScreenshotAfterTools:false}},calls('vision_read_zoom'),[{role:'tool',content:'{"success":true}'}],[regionImage],new AbortController().signal);
  assert.equal(regionFeedback.message.content.filter((part:any)=>part.type==='image_url').length,1);
  assert.equal(captures,1,'Read zoom must not recapture or disappear when auto-refresh is disabled');
} finally { imageStore.putFromDataUrl=imageWrite; }
const dangerous = setCustomSkill({name:'guide-forbidden-skill',files:{'SKILL.md':'---\nname: guide-forbidden-skill\ndescription: Test forbidden execution\n---\nExecute code'},allowedTools:['browser_page_exec']});
assert.equal(dangerous.ok,true);
if (dangerous.ok) {
  const denied = await engine.executeToolCalls(runtime,handle,calls('load_skill',{skill_name:dangerous.skill.id}),{},()=>{},Date.now()+60000);
  assert.equal(denied.anyFailure,true); assert.equal(executed,0);
  engine.injectSkillTools(runtime,handle,{data:{skill:dangerous.skill.id}});
  handle.dynamicToolIds.clear();
  engine.injectSkillTools(runtime,handle,{data:{skill:dangerous.skill.id}});
  assert.equal(handle.dynamicToolIds.size,0);
}
// Build the real runtime with only endpoint resolution stubbed; no network.
const savedRequire = modelRegistry.require;
(modelRegistry as any).require=()=>({contextThreshold:32000});
try {
  const built = await runtimeBuilder.build({chatId:'guide-build',userInput:'解释页面',agentName:'视觉助手',
    skillNames:dangerous.ok?[dangerous.skill.id]:[],extraToolIds:['browser_page_exec','vision_gui'],priorRecords:[]});
  assert.equal(built.toolPolicy,'vision-assistant');
  assert.equal(built.toolIds.every(isVisionAssistantTool),true);
  assert.equal(built.activationContext.length,0);
  assert.ok(built.systemPrompt.includes('已跳过激活'));
  assert.equal(built.systemPrompt.includes('必须优先调用 browser_get_page_text'),false);
  const action = await runtimeBuilder.build({chatId:'action-build',userInput:'执行',agentName:'视觉通用助手',skillNames:[],priorRecords:[]});
  assert.equal(action.toolPolicy,undefined); assert.ok(action.toolIds.includes('vision_gui'));
  assert.equal(action.systemPrompt.split('<vision-gui-tool>').length-1,1,'Built-in action prompt carries one XML GUI guide');
  const customAction = await runtimeBuilder.build({chatId:'custom-action',userInput:'执行',agentName:null,skillNames:[],extraToolIds:['vision_gui'],priorRecords:[],agentSystemOverride:'按当前截图完成任务。'});
  assert.equal(customAction.systemPrompt.split('<vision-gui-tool>').length-1,1,'Custom agents receive the same guide');
  const safe=setCustomSkill({name:'guide-safe-skill',files:{'SKILL.md':'---\nname: guide-safe-skill\ndescription: Safe reading\n---\nRead current page'},allowedTools:['vision_read']});
  assert.equal(safe.ok,true);
  if(safe.ok){
    const safeRuntime=await runtimeBuilder.build({chatId:'safe-guide',userInput:'解释页面',agentName:'视觉助手',skillNames:[safe.skill.id],priorRecords:[]});
    assert.equal(safeRuntime.activationContext.length,2);assert.equal(safeRuntime.toolIds.every(isVisionAssistantTool),true);
    const unselected=await runtimeBuilder.build({chatId:'safe-guide',userInput:'解释页面',agentName:'视觉助手',skillNames:[],priorRecords:[]});
    assert.equal(safeRuntime.systemPrompt,unselected.systemPrompt,'Selecting a listed skill must not rewrite the system prefix');
    assert.deepEqual(safeRuntime.advertisedToolIds,unselected.advertisedToolIds,'Skill activation must not change the advertised schemas');
    assert.ok(safeRuntime.advertisedToolIds?.every(isVisionAssistantTool));
    engine.injectSkillTools(runtime,handle,{data:{skill:safe.skill.id}});
    assert.equal(handle.dynamicToolIds.has('vision_read'),true);
  }
} finally { modelRegistry.require=savedRequire; (globalThis as any).window=previousWindow; }
console.log('[vision-assistant] Observation payload, no-click nested scrolling, argument defenses, image continuation, runtime/skill capability ceiling passed.');

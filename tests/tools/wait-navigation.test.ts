import assert from 'node:assert/strict';
import { GenericWaitTool } from '../../tools/common/generic-wait';
import { normalizeWaitSeconds, waitExecutionTimeout } from '../../tools/common/wait-contract';
import { NavigateTool } from '../../tools/browser/navigation';
import { CreateTabTool } from '../../tools/browser/tab-management';
import { ConversationEngine } from '../../entrypoints/sidepanel/core/conversation/conversation-engine';
import { imageStore } from '../../entrypoints/sidepanel/core/images/image-store';
import { SCENARIO_PRESETS } from '../../utils/tools/tool-presets';

for (const scenario of ['automation','visionAgent','visionAssist'] as const) assert.ok(SCENARIO_PRESETS[scenario].includes('generic_wait'));
assert.equal(normalizeWaitSeconds(1000),600);assert.equal(normalizeWaitSeconds(0.25),0.25);
for(const value of [NaN,Infinity,-1,'600',undefined]) assert.throws(()=>normalizeWaitSeconds(value));
assert.equal(waitExecutionTimeout({waitSeconds:1000},120000),605000);
const wait = new GenericWaitTool();
for(const value of [null,[],{}, {waitSeconds:-1},{waitSeconds:NaN},{waitSeconds:10,script:'x'}]) assert.equal((await wait.execute(value as any)).success,false);

// Virtual clock: exercise the full ten-minute wait and engine timeout without
// spending ten real minutes or weakening the production duration contract.
const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout,originalNow=Date.now;
const oldWindow=(globalThis as any).window;
const scheduled=new Map<number,{callback:()=>void;ms:number}>();let sequence=0,clock=1000;
(globalThis as any).window=globalThis;
(globalThis as any).setTimeout=(callback:()=>void,ms:number)=>{const id=++sequence;scheduled.set(id,{callback,ms});return id;};
(globalThis as any).clearTimeout=(id:number)=>scheduled.delete(id);
Date.now=()=>clock;
const takeTimer=(ms:number)=>{const entry=[...scheduled].find(([,value])=>value.ms===ms);assert.ok(entry,`Expected timer ${ms}`);scheduled.delete(entry[0]);entry[1].callback();};
try {
  const pending=wait.execute({waitSeconds:900});
  takeTimer(600000);const capped=await pending;
  assert.equal(capped.success,true);assert.equal(capped.data.capped,true);assert.equal(capped.data.waitSeconds,600);
  const controller=new AbortController();const cancelled=wait.execute({waitSeconds:600},{signal:controller.signal});
  controller.abort();assert.equal((await cancelled).success,false);assert.equal(scheduled.size,0);
  const stopped=new AbortController();stopped.abort();assert.equal((await wait.execute({waitSeconds:600},{signal:stopped.signal})).success,false);assert.equal(scheduled.size,0);
  const engine=new ConversationEngine({executeTool:async(name:string,args:any,context:any)=>name==='generic_wait'?wait.execute(args,context):{success:true,data:{text:'read'}},requiresApproval:()=>false} as any) as any;
  const runtime:any={chatId:'wait-contract',toolIds:['generic_wait','browser_get_page_text'],vision:null,limits:{maxDurationMs:10000,toolTimeoutMs:120000}};
  const handle:any={abortController:new AbortController(),dynamicToolIds:new Set(),record:{toolCalls:[],parts:[]},toolCallCount:0};
  const call=(name:string,args:any)=>({id:name,type:'function',function:{name,arguments:JSON.stringify(args)}});
  const enginePending=engine.executeToolCalls(runtime,handle,[call('generic_wait',{waitSeconds:10000}),call('browser_get_page_text',{})],{},()=>{},clock+10000);
  assert.ok([...scheduled.values()].some(timer=>timer.ms===605000),'Engine must not apply the normal 120s timeout to long waits');
  clock+=600000;takeTimer(600000);
  const outcome=await enginePending;
  assert.equal(outcome.anyFailure,false);assert.equal(outcome.messages.length,2);assert.equal(outcome.waitedMs,600000);
  assert.equal(scheduled.size,0,'Every success/abort path cleans its timer');
} finally {globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;Date.now=originalNow;}

// Assert ordering at the actual continuation boundary, including cancellation
// during the mandatory gap. Reused manual screenshots need no second capture.
const order:string[]=[];
const shot={success:true,data:{screenshot:'data:image/png;base64,cG5n',text:'new viewport'}};
const visual=new ConversationEngine({executeTool:async()=>{order.push('capture');return shot;},requiresApproval:()=>false} as any) as any;
visual.interruptibleDelay=async(ms:number)=>{assert.equal(ms,3000);order.push('delay');};
const imageWrite=imageStore.putFromDataUrl;imageStore.putFromDataUrl=async()=>null;
const visualRuntime:any={chatId:'settle',vision:{screenshotTool:'screenshot',screenshotArgs:{},reScreenshotAfterTools:true}};
const actionCall={id:'a',type:'function',function:{name:'vision_gui',arguments:'{"action":"click"}'}};
try {
  await visual.buildVisionContinuationMessage(visualRuntime,[actionCall],[{role:'tool',content:'{"success":true}'}],[],new AbortController().signal);
  assert.deepEqual(order,['delay','capture']);
  order.length=0;
  const batchEngine=new ConversationEngine({executeTool:async(name:string)=>{order.push(name);return name==='screenshot'?shot:{success:true,data:{text:'clicked'}};},requiresApproval:()=>false} as any) as any;
  batchEngine.interruptibleDelay=async(ms:number)=>{assert.equal(ms,3000);order.push('delay');};
  const batchHandle:any={abortController:new AbortController(),dynamicToolIds:new Set(),record:{toolCalls:[],parts:[]},toolCallCount:0};
  await batchEngine.executeToolCalls({...visualRuntime,toolIds:['vision_gui','screenshot'],limits:{maxDurationMs:10000,toolTimeoutMs:1000}},batchHandle,
    [actionCall,{id:'s',type:'function',function:{name:'screenshot',arguments:'{}'}}],{},()=>{},Date.now()+10000);
  assert.deepEqual(order,['vision_gui','delay','screenshot'],'Explicit screenshot in the same batch must also respect the 3s gap');
  assert.equal(batchHandle.captureGapPending,false);
  order.length=0;const cancel=new AbortController();visual.interruptibleDelay=async()=>{order.push('delay');cancel.abort();};
  assert.equal(await visual.buildVisionContinuationMessage(visualRuntime,[actionCall],[{role:'tool',content:'{"success":true}'}],[],cancel.signal),null);
  assert.deepEqual(order,['delay']);
}finally{imageStore.putFromDataUrl=imageWrite;(globalThis as any).window=oldWindow;}

// Navigation API mocks fail loudly if any path attempts to create a window.
const originalChrome=(globalThis as any).chrome;let windowCreates=0,tabCreates:any[]=[],updated:any[]=[];
let tabs:any[]=[{id:1,windowId:7,url:'https://old.example/',status:'complete'}],windowAvailable=true;
(globalThis as any).chrome={runtime:{getManifest:()=>({})},windows:{
  create:async()=>{windowCreates++;throw new Error('Forbidden window creation');},
  getLastFocused:async()=>windowAvailable?{id:7,type:'normal'}:{},update:async()=>({id:7})},tabs:{
  query:async()=>tabs,get:async(id:number)=>tabs.find(tab=>tab.id===id),reload:async()=>{},
  update:async(id:number,args:any)=>{updated.push({id,args});const tab=tabs.find(tab=>tab.id===id);Object.assign(tab,args);return tab;},
  create:async(args:any)=>{assert.equal(args.windowId,7,'Always specify existing windowId');tabCreates.push(args);const tab={id:2+tabCreates.length,windowId:7,url:args.url,status:'complete'};tabs.push(tab);return tab;},
}};
try {
  const nav=new NavigateTool();assert.equal('newWindow' in nav.openaiSchema.function.parameters.properties,false);
  assert.equal((await nav.execute({url:'https://new.example/',waitForLoad:false})).success,true);
  assert.equal(tabCreates.length,1);assert.equal(updated.length,0,'Default navigation preserves the original page');
  assert.equal((await nav.execute({url:'https://current.example/',newTab:false,waitForLoad:false})).success,true);
  assert.equal(tabCreates.length,1);assert.equal(updated[0].args.url,'https://current.example/');
  assert.equal((await nav.execute({url:'https://bad.example/',newWindow:true} as any)).success,false);
  assert.equal((await nav.execute({url:'https://bad.example/',newTab:'true'} as any)).success,false);
  tabs=[];windowAvailable=false;const before=tabCreates.length;
  assert.equal((await nav.execute({url:'https://no-window.example/',waitForLoad:false})).success,false);
  assert.equal((await new CreateTabTool().execute({url:'https://no-window.example/'})).success,false);
  assert.equal(tabCreates.length,before);assert.equal(windowCreates,0);
  windowAvailable=true;
  assert.equal((await nav.execute({url:'https://fallback-tab.example/',newTab:false,waitForLoad:false})).success,true);
  assert.equal(tabCreates.length,before+1);assert.equal(windowCreates,0,'No-window fallback must never create a window');
}finally{(globalThis as any).chrome=originalChrome;}
console.log('[wait-navigation] Capped/cancellable 10-minute waits, engine deadlines, mandatory 3s capture gap and tab-only navigation passed.');

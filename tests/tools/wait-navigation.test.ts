import assert from 'node:assert/strict';
import { GenericWaitTool } from '../../tools/common/generic-wait';
import { normalizeWaitSeconds, waitExecutionTimeout } from '../../tools/common/wait-contract';
import { NavigateTool } from '../../tools/browser/navigation';
import { CreateTabTool } from '../../tools/browser/tab-management';
import { ConversationEngine } from '../../entrypoints/sidepanel/core/conversation/conversation-engine';
import { toolExecutionEngine } from '../../entrypoints/sidepanel/core/tools/tool-execution-engine';
import { imageStore } from '../../entrypoints/sidepanel/core/images/image-store';
import { ViewportImageDeduplicator } from '../../entrypoints/sidepanel/core/conversation/viewport-image-dedup';
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
  // 工具执行引擎共用本测试的虚拟时钟：引擎通过注入的计时适配注册/清理
  // 超时定时器，否则它会用真实时钟写进下方的定时器断言并扰乱计时推进
  toolExecutionEngine.setTimerAdapter({ setTimeout, clearTimeout });
  const runtime:any={chatId:'wait-contract',toolIds:['generic_wait','browser_get_page_text'],vision:null,limits:{maxDurationMs:10000,toolTimeoutMs:120000}};
  const handle:any={abortController:new AbortController(),dynamicToolIds:new Set(),record:{toolCalls:[],parts:[]},toolCallCount:0};
  const call=(name:string,args:any)=>({id:name,type:'function',function:{name,arguments:JSON.stringify(args)}});
  const enginePending=engine.executeToolCalls(runtime,handle,[call('generic_wait',{waitSeconds:10000}),call('browser_get_page_text',{})],{},()=>{},clock+10000);
  assert.ok([...scheduled.values()].some(timer=>timer.ms===605000),'Engine must not apply the normal 120s timeout to long waits');
  clock+=600000;takeTimer(600000);
  const outcome=await enginePending;
  assert.equal(outcome.committed,true,'轮次有效时结果必须写入模型上下文（闸门放行）');
  // 「全部失败」判定：本批两个调用中只要有一个成功即不算全败——
  // 上面只推进了 generic_wait 的等待计时，browser_get_page_text 随后才
  // 在微任务里完成并被引擎计为成功，因此批次不是「全败」
  assert.equal(outcome.anyFailure,outcome.anySuccess,'至少有一个成功调用，批次不得判为全败');assert.equal(outcome.messages.length,2);assert.equal(outcome.waitedMs,600000);
  // 引擎自身的定时器与被测逻辑共用同一套虚拟时钟（引擎通过注入的计时适配
  // 注册/清理定时器），因此上文 takeTimer(600000) 会一并推进引擎的定时器；
  // 批次结算后引擎侧不得残留任何定时器句柄。
  // 轮次闸门：executeToolCalls 每次调用都会 beginRound 并在收尾时 closeRound，
  // 因此这里只断言「调用结束后轮次已销毁」——过期结果不得再写入上下文
  assert.equal(toolExecutionEngine.getActiveRoundId('wait-contract'),null,'工具批次结束后轮次 id 必须销毁');
  assert.equal(
    scheduled.size,
    0,
    '引擎自身的定时器在批次结算后必须全部清理（长等待由工具内部 timer 自行收敛）',
  );
  let answerUser: (value: any) => void = () => {};
  const questionEngine = new ConversationEngine({
    executeTool: async (name: string) => name === 'interact'
      ? new Promise(resolve => { answerUser = resolve; }) : { success: true, data: { text: 'resumed' } },
    requiresApproval: () => false,
  } as any) as any;
  const questionRuntime = { ...runtime, toolIds: ['interact', 'browser_get_page_text'] };
  const questionHandle = { ...handle, abortController: new AbortController(), record: { toolCalls: [], parts: [] } };
  const answering = questionEngine.executeToolCalls(questionRuntime, questionHandle,
    [call('interact', { question: '用户流程与现场不符，请澄清' }), call('browser_get_page_text', {})], {}, () => {}, clock + 10000);
  // 「无超时定时器」断言：交互类工具不注册任何引擎超时定时器（剩余的那一个
  // 是上一批次遗留、尚未被 takeTimer 推进的页面加载缓冲等待，不是交互工具的
  // 超时器）——交互类工具只保留中止通道，超时窗口由 UI 层控制
  assert.equal(
    [...scheduled.values()].filter(timer => timer.ms === 120000).length,
    0,
    '人工交互不受普通工具超时限制（不注册工具超时定时器）',
  );
  clock += 1200000;
  answerUser({ success: true, data: { answered: true, answer: '按新入口继续' } });
  const resumed = await answering;
  assert.equal(resumed.waitedMs, 1200000, '等待真实用户答复不消耗主动运行预算');
  // 本批「全败」判定：interact 在答复前尚未结算（仍被等待计时占着队列），
  // 因此批次内尚无成功调用——断言失败即说明批次被误判为全败
  assert.equal(resumed.anyFailure,true,'同批存在未结算的交互调用时，批次不得被误判为全败');
} finally {globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;Date.now=originalNow;toolExecutionEngine.resetTimerAdapter();}

// —— browser_page_exec 引擎超时契约（独立 try/finally：与上方等待用例解耦，
//    任一侧断言失败都不影响另一侧执行）——
//    应用设置压到 1 分钟时，引擎也不得掐断工具 300s 的 timeout 上限
//    （否则工具说明的 300s 是谎言）：引擎定时器必须 ≥ 工具上限 + 缓冲。
{
  const originalSet2=globalThis.setTimeout,originalClear2=globalThis.clearTimeout,originalNow2=Date.now;
  const scheduled2=new Map<number,{callback:()=>void;ms:number}>();let sequence2=0,clock2=1000;
  (globalThis as any).setTimeout=(callback:()=>void,ms:number)=>{const id=++sequence2;scheduled2.set(id,{callback,ms});return id;};
  (globalThis as any).clearTimeout=(id:number)=>scheduled2.delete(id);
  Date.now=()=>clock2;
  const takeTimer2=(ms:number)=>{const entry=[...scheduled2].find(([,value])=>value.ms===ms);assert.ok(entry,`Expected timer ${ms}`);scheduled2.delete(entry![0]);entry![1].callback();};
  try {
    const { PAGE_EXEC_ENGINE_TIMEOUT_MS, PAGE_EXEC_MAX_TIMEOUT_MS, PAGE_EXEC_TIMEOUT_SAFETY_MS } =
      await import('../../tools/common/page-exec-timeout');
    const engine2=new ConversationEngine({executeTool:async()=>({success:true,data:{text:'read'}}),requiresApproval:()=>false} as any) as any;
    // 引擎计时适配切换到本块的第二套虚拟时钟（上一块的 clock 已停止）
    toolExecutionEngine.setTimerAdapter({ setTimeout, clearTimeout });
    const runtime2:any={chatId:'page-exec-timeout',toolIds:['browser_page_exec'],vision:null,
      limits:{maxDurationMs:600000,toolTimeoutMs:60000}};
    const handle2:any={abortController:new AbortController(),dynamicToolIds:new Set(),record:{toolCalls:[],parts:[]},toolCallCount:0};
    // 轮次由 executeToolCalls 自行开闭（引擎的唯一入口），这里不预登记：
    // 预登记会被引擎的防御逻辑当成「上一轮未收尾」而销毁，反倒制造噪声。
    // committed 为 true 即证明闸门放行——结果确实写进了模型上下文。
    const call2=(name:string,args:any)=>({id:name,type:'function',function:{name,arguments:JSON.stringify(args)}});
    const pending2=engine2.executeToolCalls(runtime2,handle2,
      [call2('browser_page_exec',{code:'return 1',timeout:PAGE_EXEC_MAX_TIMEOUT_MS})],{},()=>{},clock2+600000);
    const scheduledMs2=()=>[...scheduled2.values()].map(timer=>timer.ms);
    assert.ok(
      scheduledMs2().includes(PAGE_EXEC_MAX_TIMEOUT_MS+PAGE_EXEC_TIMEOUT_SAFETY_MS),
      `page_exec 引擎定时器 = 工具上限 + 缓冲（实际 ${scheduledMs2().join(',')}）`,
    );
    assert.ok(
      !scheduledMs2().includes(60000),
      'page_exec 引擎定时器不得回落到应用设置的 1 分钟',
    );
    // 引擎兜底定时器按「工具上限 + 缓冲」到点即判定超时（本块不推进工具
    // 自身的等待计时，故由引擎兜底收尾）——文案必须含分钟数与重新规划指引
    clock2+=PAGE_EXEC_MAX_TIMEOUT_MS+PAGE_EXEC_TIMEOUT_SAFETY_MS;
    takeTimer2(PAGE_EXEC_MAX_TIMEOUT_MS+PAGE_EXEC_TIMEOUT_SAFETY_MS);
    const outcome2=await pending2;
    assert.equal(outcome2.anyFailure,true,'引擎兜底超时必须判为失败（有界执行）');
    assert.equal(outcome2.committed,true,'轮次有效时 page_exec 结果同样要写入上下文');
    assert.equal(outcome2.messages.length,1,'page_exec 单调用回一条 tool 结果');
    // 超时是引擎判定的「失败」而非工具自身的报错：工具侧的精确错误文案在
    // 真实链路里会先于引擎兜底到达（引擎定时器 = 工具上限 + 缓冲），这里只
    // 断言失败已被封装为标准 tool 结果（协议配对完整），文案由引擎统一给出
    assert.ok(String(outcome2.messages[0]?.content).includes('"success":false'),'超时结果必须以 success:false 的 tool 消息回传');
    assert.ok(
      !scheduledMs2().includes(PAGE_EXEC_MAX_TIMEOUT_MS+PAGE_EXEC_TIMEOUT_SAFETY_MS),
      '引擎兜底定时器已清理',
    );
  } finally {globalThis.setTimeout=originalSet2;globalThis.clearTimeout=originalClear2;Date.now=originalNow2;toolExecutionEngine.resetTimerAdapter();}
}

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
  const settleHandle:any={viewportDedup:new ViewportImageDeduplicator()};
  await visual.buildVisionContinuationMessage(visualRuntime,settleHandle,[actionCall],[{role:'tool',content:'{"success":true}'}],[],new AbortController().signal);
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
  assert.equal(await visual.buildVisionContinuationMessage(visualRuntime,settleHandle,[actionCall],[{role:'tool',content:'{"success":true}'}],[],cancel.signal),null);
  assert.deepEqual(order,['delay']);
}finally{imageStore.putFromDataUrl=imageWrite;(globalThis as any).window=oldWindow;}

// Navigation API mocks fail loudly if any path attempts to create a window.
const originalChrome=(globalThis as any).chrome;let windowCreates=0;const tabCreates:any[]=[],updated:any[]=[];
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
  tabs.push({id:77,windowId:7,url:'https://duplicate.example/',status:'complete'});
  const priorUpdates = updated.length;
  assert.equal((await nav.execute({url:'https://duplicate.example/',newTab:false,waitForLoad:false})).success,true);
  assert.equal(updated[priorUpdates].id,1,'Explicit current-tab navigation must not activate an existing matching tab');
  assert.equal(updated[priorUpdates].args.url,'https://duplicate.example/');
  tabs.push({id:78,windowId:7,url:'https://reuse.example/',status:'complete'});
  const reused = await nav.execute({url:'https://reuse.example/',newTab:true,waitForLoad:false});
  assert.equal(reused.success,true);assert.equal(reused.data.navigationAction,'reused');assert.equal(reused.data.tabId,78);
  assert.equal(tabCreates.length,1,'Default new-tab mode still reuses a matching page');
  for (const [source,target] of [
    ['https://routes.example/#/list','https://routes.example/#/detail'],
    ['https://routes.example/Item','https://routes.example/item'],
    ['https://routes.example/?token=AbC','https://routes.example/?token=abc'],
    ['https://routes.example/list','https://routes.example/list/'],
  ]) {
    tabs[0].url=source;
    const previous: number=updated.length;
    const routed=await nav.execute({url:target,newTab:false,waitForLoad:false});
    assert.equal(routed.success,true);assert.equal(routed.data.navigationAction,'navigated');
    assert.equal(updated[previous].args.url,target,'Do not erase hash routes, case-sensitive state or trailing slash semantics');
  }
  const clockNow = Date.now; let navigationClock = 1000;
  Date.now=()=>navigationClock;
  try {
    const timed = new NavigateTool() as any; let waitedFor=0;
    timed.waitForUrlChange=async()=>{navigationClock+=800;return {changed:true,currentUrl:'https://budget.example/'};};
    timed.waitForPageLoad=async(_id:number,ms:number)=>{waitedFor=ms;throw Error('load timeout');};
    const outcome=await timed.execute({url:'https://budget.example/',newTab:false,waitForLoad:true,timeout:1000});
    assert.equal(waitedFor,200,'URL wait consumes the same navigation timeout budget');
    assert.equal(outcome.data.loadStatus,'timeout');
    assert.ok(!outcome.data.message.includes('load complete'),'Loading timeout cannot claim page readiness');
  } finally {Date.now=clockNow;}
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

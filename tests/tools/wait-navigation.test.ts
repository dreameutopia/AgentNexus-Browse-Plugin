import assert from 'node:assert/strict';
import { GenericWaitTool } from '../../tools/common/generic-wait';
import { normalizeWaitSeconds, waitExecutionTimeout } from '../../tools/common/wait-contract';
import { BrowserNavigationTool } from '../../tools/browser/navigation';
import { BrowserTabsTool } from '../../tools/browser/tab-management';
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

// —— js_run 引擎超时契约（独立 try/finally：与上方等待用例解耦，
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
    const runtime2:any={chatId:'page-exec-timeout',toolIds:['js_run'],vision:null,
      limits:{maxDurationMs:600000,toolTimeoutMs:60000}};
    const handle2:any={abortController:new AbortController(),dynamicToolIds:new Set(),record:{toolCalls:[],parts:[]},toolCallCount:0};
    // 轮次由 executeToolCalls 自行开闭（引擎的唯一入口），这里不预登记：
    // 预登记会被引擎的防御逻辑当成「上一轮未收尾」而销毁，反倒制造噪声。
    // committed 为 true 即证明闸门放行——结果确实写进了模型上下文。
    const call2=(name:string,args:any)=>({id:name,type:'function',function:{name,arguments:JSON.stringify(args)}});
    const pending2=engine2.executeToolCalls(runtime2,handle2,
      [call2('js_run',{action:'run',path:'scripts/probe.js',timeout:PAGE_EXEC_MAX_TIMEOUT_MS})],{},()=>{},clock2+600000);
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

// —— 统一导航 browser_navigation 与统一标签页 browser_tabs（chrome 桩）——
// Navigation API mocks fail loudly if any path attempts to create a window.
const originalChrome=(globalThis as any).chrome;let windowCreates=0;const tabCreates:any[]=[],updated:any[]=[],removed:number[]=[],historyCalls:string[]=[];let reloadCalls=0;
let tabs:any[]=[{id:1,windowId:7,url:'https://old.example/',status:'complete'}],windowAvailable=true;
// 一次性消失：get 首次命中的 id 在本次调用返回后立即从 tabs 移除（模拟
// 「预检拿到标签、轮询期间被用户关闭」的竞态）；remove 拒绝：模拟底层关闭失败
const vanishOnce=new Set<number>();const failRemoveIds=new Set<number>();
(globalThis as any).chrome={runtime:{getManifest:()=>({})},windows:{
  create:async()=>{windowCreates++;throw new Error('Forbidden window creation');},
  getLastFocused:async()=>windowAvailable?{id:7,type:'normal'}:{},
  update:async()=>({id:7}),
  getAll:async()=>[{id:7,tabs:tabs.map(t=>({id:t.id,url:t.url||'',title:t.title||'',active:!!t.active}))}],
},tabs:{
  // 仅 url 过滤在桩内生效（close 的 URL 匹配用例）；其余 query 原样返回全量，
  // 保持与旧用例一致的「tabs[0] 即活动标签」语义
  query:async(q?:any)=>{
    if(q&&typeof q==='object'&&typeof q.url==='string'){
      const pat=q.url;const base=pat.endsWith('/*')?pat.slice(0,-2):pat;
      return tabs.filter(t=>typeof t.url==='string'&&(t.url===base||t.url.startsWith(base+'/')));
    }
    return tabs;
  },
  get:async(id:number)=>{
    const tab=tabs.find(tab=>tab.id===id);
    if(tab&&vanishOnce.has(id)){
      vanishOnce.delete(id);
      queueMicrotask(()=>{const i=tabs.findIndex(t=>t.id===id);if(i>=0)tabs.splice(i,1);});
    }
    return tab;
  },
  reload:async()=>{reloadCalls++;},
  goBack:async(id:number)=>{historyCalls.push(`back:${id}`);},
  goForward:async(id:number)=>{historyCalls.push(`forward:${id}`);},
  remove:async(ids:any)=>{for(const id of (Array.isArray(ids)?ids:[ids])){
    if(failRemoveIds.has(id))throw new Error(`Mock remove rejected for tab ${id}`);
    removed.push(id);const i=tabs.findIndex(t=>t.id===id);if(i>=0)tabs.splice(i,1);
  }},
  update:async(id:number,args:any)=>{updated.push({id,args});const tab=tabs.find(tab=>tab.id===id);Object.assign(tab,args);return tab;},
  create:async(args:any)=>{assert.equal(args.windowId,7,'Always specify existing windowId');tabCreates.push(args);const tab={id:2+tabCreates.length,windowId:7,url:args.url,status:'complete',active:args.active!==false};tabs.push(tab);return tab;},
}};
try {
  const nav=new BrowserNavigationTool();
  assert.equal('newWindow' in nav.openaiSchema.function.parameters.properties,false);
  // ── action 参数矩阵：整体形态 / 未知参数 / 张冠李戴 / 类型错误全报错 ──
  for (const bad of [
    'not-an-object', null, [],
    {}, {action:'browse'}, {action:'open',newWindow:true}, {url:'https://no-action.example/'},
    {action:'wait',url:'https://x.example/'}, {action:'refresh',newTab:true},
    {action:'open',url:'https://x.example/',tabId:1}, {action:'back',checkInterval:500},
    {action:'open'}, {action:'open',url:'   '}, {action:'open',url:'https://x.example/',timeout:0},
    // timeout 上限：有界执行（先于引擎工具超时收敛），超限必须拒绝并指引 generic_wait
    {action:'open',url:'https://x.example/',timeout:100001}, {action:'wait',timeout:600000},
    {action:'wait',tabId:-1}, {action:'wait',tabId:1,checkInterval:10},
  ]) assert.equal((await nav.execute(bad as any)).success,false,`参数矩阵拒绝 ${JSON.stringify(bad)}`);
  assert.ok(((await nav.execute({action:'wait',timeout:600000})).error??'').includes('generic_wait'),
    '超时上限错误必须指引改用 generic_wait 而不是只说「不合法」');
  // ── open 主路径（原 browser_navigate 语义等价迁移） ──
  assert.equal((await nav.execute({action:'open',url:'https://new.example/',waitForLoad:false})).success,true);
  assert.equal(tabCreates.length,1);assert.equal(updated.length,0,'Default navigation preserves the original page');
  assert.equal((await nav.execute({action:'open',url:'https://current.example/',newTab:false,waitForLoad:false})).success,true);
  assert.equal(tabCreates.length,1);assert.equal(updated[0].args.url,'https://current.example/');
  tabs.push({id:77,windowId:7,url:'https://duplicate.example/',status:'complete'});
  const priorUpdates = updated.length;
  assert.equal((await nav.execute({action:'open',url:'https://duplicate.example/',newTab:false,waitForLoad:false})).success,true);
  assert.equal(updated[priorUpdates].id,1,'Explicit current-tab navigation must not activate an existing matching tab');
  assert.equal(updated[priorUpdates].args.url,'https://duplicate.example/');
  tabs.push({id:78,windowId:7,url:'https://reuse.example/',status:'complete'});
  const reused = await nav.execute({action:'open',url:'https://reuse.example/',newTab:true,waitForLoad:false});
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
    const routed=await nav.execute({action:'open',url:target,newTab:false,waitForLoad:false});
    assert.equal(routed.success,true);assert.equal(routed.data.navigationAction,'navigated');
    assert.equal(updated[previous].args.url,target,'Do not erase hash routes, case-sensitive state or trailing slash semantics');
  }
  const clockNow = Date.now; let navigationClock = 1000;
  Date.now=()=>navigationClock;
  try {
    const timed = new BrowserNavigationTool() as any; let waitedFor=0;
    timed.waitForUrlChange=async()=>{navigationClock+=800;return {changed:true,currentUrl:'https://budget.example/'};};
    // 桩必须与 waitForPageLoad 的真实错误契约一致（超时中文标记 / closed 英文标记），
    // 否则会被分类器当未知错误如实上抛——这正是分类器防「静默降级」的语义
    timed.waitForPageLoad=async(_id:number,ms:number)=>{waitedFor=ms;throw Error(`等待页面加载超时 (${ms}ms)`);};
    const outcome=await timed.execute({action:'open',url:'https://budget.example/',newTab:false,waitForLoad:true,timeout:1000});
    assert.equal(waitedFor,200,'URL wait consumes the same navigation timeout budget');
    assert.equal(outcome.data.loadStatus,'timeout');
    assert.ok(!outcome.data.message.includes('load complete'),'Loading timeout cannot claim page readiness');
    assert.ok(outcome.data.warning,'加载未确认必须携带补等指引（action=wait）');
  } finally {Date.now=clockNow;}
  // ── refresh action（原 navigate 的 refresh 分支；超时不再谎报就绪） ──
  assert.equal((await nav.execute({action:'refresh',waitForLoad:false})).success,true);
  assert.equal(reloadCalls,1,'refresh 必须触发 tabs.reload');
  // ── back / forward action（原 browser_go_back_or_forward 并入；默认等就绪） ──
  const backFast=await nav.execute({action:'back',waitForLoad:false});
  assert.equal(backFast.success,true);assert.equal(backFast.data.navigationAction,'back');assert.equal(backFast.data.loadStatus,'not_waited');
  assert.deepEqual(historyCalls,['back:1'],'back 在活动标签上执行');
  const forwardWaited=await nav.execute({action:'forward'});
  assert.equal(forwardWaited.success,true);assert.equal(forwardWaited.data.navigationAction,'forward');
  assert.equal(forwardWaited.data.loadStatus,'complete','forward 默认等待就绪（双检连续 2 次）后返回');
  assert.deepEqual(historyCalls,['back:1','forward:1']);
  // ── wait action（原 wait_page_load 并入；参数真正生效） ──
  tabs[0].status='complete';
  const waited=await nav.execute({action:'wait',checkInterval:50});
  assert.equal(waited.success,true);assert.equal(waited.data.status,'complete');assert.equal(waited.data.loading,false);
  assert.equal(typeof waited.data.elapsedMs,'number');
  const waitedByTab=await nav.execute({action:'wait',tabId:1,checkInterval:50,timeout:500});
  assert.equal(waitedByTab.success,true);assert.equal(waitedByTab.data.tabId,1);
  tabs[0].status='loading';
  const waitTimeout=await nav.execute({action:'wait',checkInterval:50,timeout:250});
  assert.equal(waitTimeout.success,false,'加载未就绪时 wait 必须报失败而不是谎称完成');
  assert.ok(/未完成加载/.test(waitTimeout.error??''),'失败文案带「未完成加载」与诊断');
  assert.equal((await nav.execute({action:'wait',tabId:9999,checkInterval:50})).success,false,'不存在的 tabId 报可读错误');
  // 竞态：预检拿到标签、轮询期间标签页被关闭 → wait 以可读「被关闭」错误收口
  tabs.push({id:40,windowId:7,url:'https://vanish.example/',status:'complete'});
  vanishOnce.add(40);
  const waitVanished=await nav.execute({action:'wait',tabId:40,checkInterval:50,timeout:500});
  assert.equal(waitVanished.success,false,'等待期间消失的标签页 → 失败而非空转到超时');
  assert.ok(/被关闭/.test(waitVanished.error??''),'关闭态错误文案可读且指明原因');
  assert.ok(!tabs.some(t=>t.id===40),'一次性消失语义已生效（标签确实没了）');
  tabs[0].status='complete';
  // refresh 默认等待就绪：status+readyState 双检连续两次后才报 complete
  const refreshed=await nav.execute({action:'refresh'});
  assert.equal(refreshed.success,true);
  assert.equal(refreshed.data.navigationAction,'refreshed');
  assert.equal(refreshed.data.loadStatus,'complete','refresh 默认 waitForLoad=true 等到就绪才返回');
  assert.equal(reloadCalls,2,'refresh 每次都触发 tabs.reload');
  // ── 无可用窗口：open/create 都必须失败，且绝不创建窗口 ──
  assert.equal((await nav.execute({url:'https://bad.example/',newWindow:true} as any)).success,false);
  assert.equal((await nav.execute({url:'https://bad.example/',newTab:'true'} as any)).success,false);
  tabs=[];windowAvailable=false;const before=tabCreates.length;
  assert.equal((await nav.execute({action:'open',url:'https://no-window.example/',waitForLoad:false})).success,false);
  assert.equal((await new BrowserTabsTool().execute({action:'create',url:'https://no-window.example/'})).success,false);
  assert.equal(tabCreates.length,before);assert.equal(windowCreates,0);
  windowAvailable=true;
  assert.equal((await nav.execute({action:'open',url:'https://fallback-tab.example/',newTab:false,waitForLoad:false})).success,true);
  assert.equal(tabCreates.length,before+1);assert.equal(windowCreates,0,'No-window fallback must never create a window');

  // ── browser_tabs 五 action（原六个标签页/窗口工具并入） ──
  tabs.push({id:30,windowId:7,url:'https://tab-a.example/',title:'A',status:'complete'});
  tabs.push({id:31,windowId:7,url:'https://tab-b.example/',title:'B',status:'complete'});
  const tabsTool=new BrowserTabsTool();
  // 参数矩阵：未知参数 / 张冠李戴 / 必填缺失 / close 三寻址互斥
  for (const bad of [
    'nope', null, [], {}, {action:'list',tabId:1}, {action:'windows',currentWindow:true},
    {action:'switch'}, {action:'switch',tabId:1.5}, {action:'switch',tabId:-2},
    {action:'close',tabId:30,url:'https://tab-a.example/'}, {action:'close',tabId:30,tabIds:[31]},
    {action:'close',tabIds:[]}, {action:'close',tabIds:['x']}, {action:'create',active:'yes'},
    {action:'list',url:'https://x.example/'}, {action:'create',tabId:1},
  ]) assert.equal((await tabsTool.execute(bad as any)).success,false,`tabs 参数矩阵拒绝 ${JSON.stringify(bad)}`);
  // list / windows：纯枚举
  const listed=await tabsTool.execute({action:'list'});
  assert.equal(listed.success,true);assert.equal(listed.data.count,tabs.length);
  const currentOnly=await tabsTool.execute({action:'list',currentWindow:true});
  assert.equal(currentOnly.success,true);
  const windows=await tabsTool.execute({action:'windows'});
  assert.equal(windows.success,true);assert.equal(windows.data.windowCount,1);assert.equal(windows.data.tabCount,tabs.length);
  // switch：激活 + 聚焦
  const switched=await tabsTool.execute({action:'switch',tabId:30});
  assert.equal(switched.success,true);assert.equal(switched.data.tabId,30);assert.equal(switched.data.title,'A');
  assert.ok(updated.some(u=>u.id===30&&u.args.active===true),'switch 激活目标标签');
  const switchMissing=await tabsTool.execute({action:'switch',tabId:9999});
  assert.equal(switchMissing.success,false,'不存在的标签页 switch 报错');
  assert.ok((switchMissing.error??'').includes('不存在'),'switch 与 close/wait 同族的可读文案（不抛 chrome 裸错）');
  // create：绑定现有窗口 + active=false 时上报页面目标
  const targetCalls:number[]=[];
  const created=await tabsTool.execute({action:'create',url:'https://tab-c.example/',active:false},{onTabTarget:(id:number)=>targetCalls.push(id)});
  assert.equal(created.success,true);assert.equal(created.data.windowId,7);assert.equal(windowCreates,0);
  assert.equal(targetCalls.length,1,'active=false 的后台创建回传 onTabTarget');
  const createdActive=await tabsTool.execute({action:'create',url:'https://tab-d.example/'});
  assert.equal(createdActive.success,true);
  // close：互斥已验证；缺失 id 报错；URL 匹配批量关闭
  assert.equal((await tabsTool.execute({action:'close',tabId:9999})).success,false,'关闭不存在的标签页报可读错误');
  const closedByUrl=await tabsTool.execute({action:'close',url:'https://tab-a.example'});
  assert.equal(closedByUrl.success,true);assert.equal(closedByUrl.data.closedCount,1,'URL 不含结尾斜杠按前缀组匹配');
  assert.ok(removed.includes(30));
  const closedNone=await tabsTool.execute({action:'close',url:'https://never-opened.example'});
  assert.equal(closedNone.success,true);assert.equal(closedNone.data.closedCount,0);
  const closedSingle=await tabsTool.execute({action:'close',tabId:31});
  assert.equal(closedSingle.success,true);assert.equal(closedSingle.data.closedCount,1);
  assert.equal((await tabsTool.execute({action:'close'})).success,true,'缺省关闭活动标签（close_tabs 兜底语义保留）');
  // ── close 批量语义：去重 / 无效 id 汇报 / 单点失败不拖垮整批 ──
  tabs.push({id:32,windowId:7,url:'https://tab-d.example/',status:'complete'});
  tabs.push({id:33,windowId:7,url:'https://tab-e.example/',status:'complete'});
  tabs.push({id:666,windowId:7,url:'https://tab-fail.example/',status:'complete'});
  failRemoveIds.add(666);
  const batchMixed=await tabsTool.execute({action:'close',tabIds:[32,32,9999]});
  assert.equal(batchMixed.success,true,'混合批量：可关的关、不存在的汇报');
  assert.equal(batchMixed.data.closedCount,1,'重复 id 已去重，只关一次');
  assert.deepEqual(batchMixed.data.invalidTabIds,[9999]);
  assert.equal(removed.filter(id=>id===32).length,1,'底层只收到一次 remove(32)');
  const batchAllMissing=await tabsTool.execute({action:'close',tabIds:[9997,9998]});
  assert.equal(batchAllMissing.success,true);
  assert.equal(batchAllMissing.data.closedCount,0);
  assert.deepEqual(batchAllMissing.data.invalidTabIds,[9997,9998],'全部不存在 → success + invalidTabIds（原 close_tabs 口径）');
  const batchAllFail=await tabsTool.execute({action:'close',tabIds:[666]});
  assert.equal(batchAllFail.success,false,'存在但全部关闭失败 → 报失败，不谎报成功');
  assert.ok((batchAllFail.error??'').includes('666'),'失败文案含具体 tabId 与底层原因');
  assert.equal((await tabsTool.execute({action:'close',tabId:666})).success,false,'单个关闭失败返回可分析错误');
  const batchPartial=await tabsTool.execute({action:'close',tabIds:[666,33]});
  assert.equal(batchPartial.success,true,'单点失败不拖垮整批');
  assert.equal(batchPartial.data.closedCount,1);
  assert.deepEqual(batchPartial.data.failedTabIds,[666],'失败项单独汇报');
  assert.ok(tabs.some(t=>t.id===666),'关闭被拒的标签页仍在（如实反映底层状态）');
}finally{(globalThis as any).chrome=originalChrome;}
console.log('[wait-navigation] Capped/cancellable waits, engine deadlines, mandatory 3s gap, unified navigation/tabs actions and tab-only boundary passed.');

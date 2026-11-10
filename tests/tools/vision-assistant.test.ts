import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { visionReadPayload } from '../../tools/vision/read-payload';
import { validateReadActionArgs, validateReadScrollArgs } from '../../tools/vision/read-actions';
import { validateZoomArgs } from '../../tools/vision/observation-actions';
import { validateVisionGuiArgs } from '../../tools/vision/gui-tool';
import { filterVisionAssistantTools, isVisionAssistantTool, VISION_ASSISTANT_GUI_ACTIONS } from '../../utils/agents/vision-assistant-policy';
import { needsVisionRefresh, takeVisionToolImage, withoutVisionImage } from '../../entrypoints/sidepanel/core/conversation/vision-feedback';
import { userVisibleImageRefs } from '../../entrypoints/sidepanel/core/context/transcript-engine';
import { ViewportImageDeduplicator } from '../../entrypoints/sidepanel/core/conversation/viewport-image-dedup';
import { collectPriorViewportRefs } from '../../entrypoints/sidepanel/core/context/viewport-ref-collector';
// 用户气泡底部图片区口径：只展示用户上传；vision 首截图引用留在 imageRefs
// （GC 计数需要）但不进用户气泡，避免与助手「查看屏幕」双显
assert.deepEqual(userVisibleImageRefs({ uploadImageRefs:['a'], imageRefs:['a','b'] }), ['a']);
assert.deepEqual(userVisibleImageRefs({ imageRefs:['a','b'] }), ['a','b'], 'Legacy records fall back to imageRefs');
assert.deepEqual(userVisibleImageRefs({ uploadImageRefs:[], imageRefs:['shot'] }), [], 'Engine-injected refs stay out of the user bubble');
assert.deepEqual(userVisibleImageRefs({}), []);
// 旧记录反推：引擎注入的视口截图必然也在助手记录里（助手消息是展示主体），
// 据此从用户记录的引用中剔除，还原用户真正的上传
assert.deepEqual(
  userVisibleImageRefs({ imageRefs:['upload1','shot1'] }, new Set(['shot1'])),
  ['upload1'],
  'Legacy user bubble excludes engine-injected screenshots found in assistant records');
assert.deepEqual(
  userVisibleImageRefs({ imageRefs:['shot1'] }, new Set(['shot1'])),
  ['shot1'],
  'Fully engine-injected legacy record keeps its reference (no upload to fall back to)');
assert.deepEqual(
  userVisibleImageRefs({ imageRefs:['upload1'] }, new Set(['shot1'])),
  ['upload1'],
  'Unrelated assistant refs must not drop user uploads');

// 历史视口图引用提取（跨轮次同图判重的输入）
{
  const H='a'.repeat(64);
  const records:any[] = [
    // 新记录：上传子集之外的引用 = 引擎注入的视口截图
    { role:'user', imageRefs:['up1',H], uploadImageRefs:['up1'] },
    // 助手记录：全部引用都是 vision 自动截图
    { role:'assistant', imageRefs:[H,'b'.repeat(64)] },
    // 旧记录：无上传子集字段 → 保守不计入（无法区分用户上传与引擎截图）
    { role:'user', imageRefs:['legacy1'] },
  ];
  assert.deepEqual(
    collectPriorViewportRefs(records),
    [H,'b'.repeat(64)],
    'Only engine-injected viewport refs are collected for dedup');
  assert.deepEqual(collectPriorViewportRefs([]), [], 'Empty history yields no refs');
  assert.deepEqual(
    collectPriorViewportRefs([{ role:'user', imageRefs:[], uploadImageRefs:[] } as any]),
    [],
    'A user record without any image contributes nothing');
  // 脏数据防御：非法引用形态（非 hex / 长度不符）被剔除，不污染判重集合
  assert.deepEqual(
    collectPriorViewportRefs([{ role:'assistant', imageRefs:['not-a-hash','z'.repeat(64),'b'.repeat(64)] } as any]),
    ['b'.repeat(64)],
    'Malformed references are dropped');
}

// 视口图判重器（内容哈希口径）：只对视口全景判重，区域图与缺失引用不判重
{
  const dedup = new ViewportImageDeduplicator();
  assert.equal(dedup.isDuplicate({ ref:'h1', kind:'viewport' }), false, 'Unregistered reference is not a duplicate');
  dedup.remember('h1');
  assert.equal(dedup.isDuplicate({ ref:'h1', kind:'viewport' }), true, 'Same content hash is a duplicate');
  assert.equal(dedup.isDuplicate({ ref:'h2', kind:'viewport' }), false, 'Different content is not a duplicate');
  assert.equal(dedup.isDuplicate({ ref:'h1', kind:'region' }), false, 'Region images never dedupe against viewport evidence');
  assert.equal(dedup.isDuplicate({ ref:null, kind:'viewport' }), false, 'Missing reference must not be treated as duplicate');
  assert.equal(dedup.isDuplicate({ ref:'', kind:'viewport' }), false, 'Empty reference must not be treated as duplicate');
  dedup.remember(null); dedup.remember(undefined); dedup.remember('');
  assert.equal(dedup.size, 1, 'Invalid references never enter the registry');
  dedup.remember('h1');
  assert.equal(dedup.size, 1, 'remember is idempotent');
}
import { skillEngine } from '../../entrypoints/sidepanel/core/registry/skill-engine';

assert.deepEqual(filterVisionAssistantTools(['screenshot','browser_page_exec','browser_scroll','vision_gui','vision_gui','ocr']), ['screenshot','vision_gui']);
for (const id of ['browser_navigate','browser_interact','browser_inject_script','ocr','browser_page_exec']) assert.equal(isVisionAssistantTool(id), false);
// 合并后的观察者能力面：vision_gui 进白名单，开放面收敛为 action 级闸门
assert.equal(isVisionAssistantTool('vision_gui'), true);
assert.deepEqual([...VISION_ASSISTANT_GUI_ACTIONS].sort(), ['read','read_scroll','zoom']);
// 观察 action 参数边界（合并后各验证器独立成立；unknown-action / 跨 action
// 字段防线由 validateVisionGuiArgs 与 vision-gui.test 承担）
for (const [label, fn, args] of [
  ['read null', validateReadActionArgs, null],
  ['read array', validateReadActionArgs, []],
  ['read code injection', validateReadActionArgs, { screenshotId:'s',code:'document.body.click()' }],
  ['read point z-key', validateReadActionArgs, { screenshotId:'s',point:{x:0,y:0,z:1} }],
  ['read point XOR region', validateReadActionArgs, { screenshotId:'s',point:{x:1,y:1},region:{x:0,y:0,width:10,height:10} }],
  ['read missing screenshotId', validateReadActionArgs, { point:{x:1,y:1} }],
  ['scroll clickBox', validateReadScrollArgs, { screenshotId:'s',direction:'down',clickBox:[0,0,1,1] }],
  ['scroll modifiers', validateReadScrollArgs, { screenshotId:'s',direction:'down',modifiers:['Control'] }],
  ['scroll containerPercent NaN', validateReadScrollArgs, { screenshotId:'s',direction:'down',containerPercent:NaN }],
  ['scroll containerPercent 101', validateReadScrollArgs, { screenshotId:'s',direction:'down',containerPercent:101 }],
  ['scroll gesture percent name', validateReadScrollArgs, { screenshotId:'s',direction:'down',percent:50 }],
  ['scroll direction diagonal', validateReadScrollArgs, { screenshotId:'s',direction:'diagonal' }],
  ['scroll missing direction', validateReadScrollArgs, { screenshotId:'s' }],
  ['zoom region overflow', validateZoomArgs, { screenshotId:'s',region:{x:900,y:0,width:200,height:10} }],
  ['zoom zero width', validateZoomArgs, { screenshotId:'s',region:{x:0,y:0,width:0,height:10} }],
  ['zoom infinite scale', validateZoomArgs, { screenshotId:'s',region:{x:0,y:0,width:10,height:10},scale:Infinity }],
] as const) assert.throws(() => (fn as (a: unknown) => unknown)(args), `${label} must be rejected`);
for (const bad of [{action:'constructor'}, {action:'__proto__'}])
  assert.throws(() => validateVisionGuiArgs(bad), `Unknown action ${bad.action} must be rejected`);
validateReadActionArgs({ screenshotId:'s',region:{x:0,y:0,width:1000,height:1000} });
validateReadActionArgs({ screenshotId:'s',point:{x:500,y:500} });
validateReadScrollArgs({ screenshotId:'s',direction:'left',containerPercent:1 });

const imageResult = { success:true, data:{ screenshot:'data:image/png;base64,cG5n',text:'source s',screenshotId:'s' } };
const image = takeVisionToolImage(imageResult, 0)!;
assert.ok(image);
assert.equal(JSON.stringify(withoutVisionImage(imageResult)).includes('base64'), false);
assert.equal(imageResult.data.screenshot.includes('base64'), true, 'Extraction must not mutate UI result');
// noVisionRecapture 策略回调：marked 与注册表契约清单同源（tools.test.ts 有注册表级断言）
const marked = (name: string) => ['browser_get_page_text','browser_get_page_info','browser_get_all_tabs','browser_window',
  'browser_observe','browser_dom_explore','browser_network_capture',
  'plan_tool','interact','note_tool','data_ref_tool','load_skill','read_skill_file'].includes(name);
const guiCall = (action: string) => [{function:{name:'vision_gui',arguments:JSON.stringify({action, screenshotId:'s'})}}];
const none = () => false;
assert.equal(needsVisionRefresh(['screenshot'], [image], none), false);
assert.equal(needsVisionRefresh(['screenshot','browser_observe','plan_tool'], [image], marked), false);
assert.equal(needsVisionRefresh(['screenshot','vision_gui'], [image], none), true);
assert.equal(needsVisionRefresh(['vision_gui','screenshot'], [{...image,callIndex:1}], none), false);
assert.equal(needsVisionRefresh(['screenshot'], [], none), true);
assert.equal(needsVisionRefresh([{function:{name:'vision_gui',arguments:'{'}}], [], none), true,
  'Malformed GUI arguments recover conservatively');
assert.equal(needsVisionRefresh(['unknown_tool'], [], none), true);
// vision_gui 按 action 判定生命周期：read 纯读豁免 / zoom 区域图不重拍 / read_scroll 消耗重拍
assert.equal(needsVisionRefresh(guiCall('read'), [], none), false);
assert.equal(needsVisionRefresh(guiCall('zoom'), [{...image,kind:'region'}], marked), false);
assert.equal(needsVisionRefresh(guiCall('read_scroll'), [], none), true);
assert.equal(needsVisionRefresh(guiCall('check'), [], none), false);
assert.equal(needsVisionRefresh(guiCall('click'), [], none), true);
// 纯读豁免（本轮修复的核心）：整批 noVisionRecapture=true 不触发重拍
assert.equal(needsVisionRefresh(['browser_get_all_tabs'], [], marked), false);
assert.equal(needsVisionRefresh(['browser_window'], [], marked), false);
assert.equal(needsVisionRefresh(['browser_dom_explore','browser_network_capture'], [], marked), false);
// browser_get_page_text 带 url = 前台打开（激活标签页、等加载后提取）→ 用户眼前的
// 页面已经变了，截图身份失效：即便该工具声明了纯读豁免也必须重拍
assert.equal(needsVisionRefresh(['browser_get_page_text'], [], marked), false,
  '不带 url 的正文读取是纯读，豁免重拍');
assert.equal(
  needsVisionRefresh([{function:{name:'browser_get_page_text',arguments:JSON.stringify({url:'https://x.example/'})}}], [], marked),
  true,
  '带 url 的前台打开必须重拍（视图已变）',
);
assert.equal(
  needsVisionRefresh([{function:{name:'browser_get_page_text',arguments:JSON.stringify({url:'   '})}}], [], marked),
  false,
  '空白 url 不算前台打开',
);
// 混批：任一未豁免调用（含未知工具）保守重拍
assert.equal(needsVisionRefresh(['browser_get_page_text','unknown_tool'], [], marked), true);
assert.equal(needsVisionRefresh([{function:{name:'browser_get_page_text',arguments:'{}'}},{function:{name:'vision_gui',arguments:'{"action":"click"}'}}], [], marked), true);

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
const down = await payload('scroll', {point:{x:30,y:30},direction:'down',containerPercent:75});
assert.equal(down.delta.y,75); assert.equal(down.moved,true);
assert.equal(down.settled,true); assert.equal(w.scrollY,0);
const right = await payload('scroll', {point:{x:30,y:30},direction:'right',containerPercent:50});
assert.equal(right.delta.x,100);
scroller.scrollTop=900;
const edge = await payload('scroll', {point:{x:30,y:30},direction:'down',containerPercent:75});
assert.equal(edge.moved,false); assert.equal(w.scrollY,0,'Must not fall through to document at component edge');
assert.equal(clicks,0); assert.equal(focus,0);
Object.defineProperty(w.document,'scrollingElement',{value:w.document.documentElement});
w.document.documentElement.style.overflowY='hidden';
const locked = await payload('scroll', {direction:'down',containerPercent:75});
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
const { runtimeBuilder, applyVisionToggleToolSurface } = await import('../../entrypoints/sidepanel/core/runtime/runtime-builder');
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
const runtime:any = { chatId:'vision-guide-test',toolPolicy:'vision-assistant',toolIds:['screenshot','vision_gui','load_skill','browser_get_page_text'],vision:null,
  limits:{maxDurationMs:60000,toolTimeoutMs:1000} };
const handle:any = {abortController:new AbortController(),dynamicToolIds:new Set(['browser_page_exec']),record:{toolCalls:[],parts:[]},toolCallCount:0};
const calls = (name:string,args:any={}) => [{id:'c',type:'function',function:{name,arguments:JSON.stringify(args)}}];
// 工具面之外的工具（含技能扩容的 browser_page_exec 与凭空捏造的工具名）先于一切被拒
for (const name of ['browser_page_exec','unadvertised']) {
  const outcome = await engine.executeToolCalls(runtime,handle,calls(name),{},()=>{},Date.now()+60000);
  assert.equal(outcome.anyFailure,true); assert.match(outcome.messages[0].content,/TOOL_NOT_ALLOWED/);
}
// 观察者 action 闸门（fail-closed）：手势、断言检查与缺失/畸形 action 一律拒绝，
// 且必须在审批与执行之前——不允许先弹审批再失败
for (const args of [{action:'click',point:{x:1,y:2}},{action:'check'},{},{action:'constructor'}]) {
  const outcome = await engine.executeToolCalls(runtime,handle,calls('vision_gui',args),{},()=>{},Date.now()+60000);
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
  const freshHandle:any={viewportDedup:new ViewportImageDeduplicator()};
  const feedback=await visualEngine.buildVisionContinuationMessage(visualRuntime,freshHandle,calls('screenshot'),outcome.messages,outcome.images,new AbortController().signal);
  assert.equal(captures,1,'Manual screenshot must not be recaptured');
  assert.equal(feedback.message.content.filter((part:any)=>part.type==='image_url').length,1);
  assert.equal(feedback.message.content.find((part:any)=>part.type==='image_url').image_url.detail,'high');
  assert.deepEqual(feedback.imageRefs,['test-image-ref']);
  // 模型可见上下文同图去重（按内容哈希判重）：同一张视口截图再次进入
  // 上下文时只送描述文本（携带新 screenshotId），不再重复附图；归档照常
  const dupHandle:any={viewportDedup:new ViewportImageDeduplicator()};
  dupHandle.viewportDedup.remember('test-image-ref');
  const dupFeedback=await visualEngine.buildVisionContinuationMessage(visualRuntime,dupHandle,calls('screenshot'),outcome.messages,outcome.images,new AbortController().signal);
  assert.equal(captures,1,'Deduped delivery must not trigger another capture');
  assert.equal(dupFeedback.message.content.filter((part:any)=>part.type==='image_url').length,0,'Same-content viewport must not repeat the image part');
  assert.ok(dupFeedback.message.content.some((part:any)=>part.type==='text'&&/pixel-identical/.test(part.text)),'Deduped delivery keeps the description carrying the new screenshotId');
  assert.deepEqual(dupFeedback.imageRefs,['test-image-ref'],'Archiving continues for deduped captures');
  assert.equal(dupHandle.viewportDedup.size,1,'Dedup registers the delivered viewport image');
  const passive=await visualEngine.buildVisionContinuationMessage(visualRuntime,freshHandle,calls('vision_gui',{action:'read',screenshotId:'s'}),[{role:'tool',content:'{"success":true}'}],[],new AbortController().signal);
  assert.equal(passive,null);assert.equal(captures,1);
  const regionImage={...image,kind:'region' as const};
  const regionFeedback=await visualEngine.buildVisionContinuationMessage({...visualRuntime,vision:{...visualRuntime.vision,reScreenshotAfterTools:false}},freshHandle,calls('vision_gui',{action:'zoom',screenshotId:'s'}),[{role:'tool',content:'{"success":true}'}],[regionImage],new AbortController().signal);
  assert.equal(regionFeedback.message.content.filter((part:any)=>part.type==='image_url').length,1);
  assert.equal(captures,1,'GUI zoom must not recapture or disappear when auto-refresh is disabled');
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
// 观察闸门的放行面：只读 read 通过闸门并真正执行
//（放在上述「executed === 0」断言之后，验证放行不误伤）
{
  const before = executed;
  const allowed = await engine.executeToolCalls(runtime,handle,calls('vision_gui',{action:'read',screenshotId:'s'}),{},()=>{},Date.now()+60000);
  assert.notEqual(allowed.anyFailure, true, 'Read-only observation must pass the observer gate');
  assert.equal(executed, before + 1, 'Allowed observation executes exactly once');
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
  assert.ok(built.systemPrompt.includes('<observation-boundary>'),'观察者获得观察变体规程');
  const action = await runtimeBuilder.build({chatId:'action-build',userInput:'执行',agentName:'视觉通用助手',skillNames:[],priorRecords:[]});
  assert.equal(action.toolPolicy,undefined); assert.ok(action.toolIds.includes('vision_gui'));
  assert.equal(action.systemPrompt.split('<vision-gui-tool>').length-1,1,'Built-in action prompt carries one XML GUI guide');
  assert.ok(action.systemPrompt.includes('<dom-or-vision>'),'运行时提示词携带通道选择准则（由钩子注入）');
  assert.ok(action.systemPrompt.indexOf('<vision-gui-tool>') < action.systemPrompt.indexOf('<text-interaction-sop>'),
    '注入锚点保证视觉规程先于文本辅助规程');
  const customAction = await runtimeBuilder.build({chatId:'custom-action',userInput:'执行',agentName:null,skillNames:[],extraToolIds:['vision_gui'],priorRecords:[],agentSystemOverride:'按当前截图完成任务。'});
  assert.equal(customAction.systemPrompt.split('<vision-gui-tool>').length-1,1,'Custom agents receive the same guide');
  // ── 视觉操作开关注入时序（自定义智能体全链路）──
  // 第 1 步：开关（AgentConfig.vision）驱动 runtime 向工具面注入 vision_gui；
  // 第 2 步：装配检测到 vision_gui → 钩子向 systemPrompt 注入 vision_gui 规程。
  // 反向：开关关闭时工具面恒无 vision_gui，规程随之不注入——
  // 「vision_gui ∈ 工具面 ⇔ 开关开启 ⇔ 规程注入」三者恒等。
  // 分层：数据层（normalizeAgentConfig 写入即剔除残留）+ 装配层
  //（applyVisionToggleToolSurface 兜底插件/预置等未过归一的来源）。
  // 写入与清理同置 try/finally：任一断言失败也不泄漏测试智能体。
  const agentStore = await import('../../utils/agents/agent-store');
  try {
    const toggleOnWrite = agentStore.setAgentConfig({
      id: 'vision-toggle-on', name: 'vision-toggle-on', description: '视觉开关注入用例',
      system: '按当前截图完成任务。', tools: ['browser_navigate'], category: 'general', tags: [],
      vision: { screenshotTool: 'screenshot', screenshotArgs: {}, reScreenshotAfterTools: true },
    });
    assert.ok(toggleOnWrite.ok, '开启视觉操作的自定义智能体写入成功');
    const toggleOffWrite = agentStore.setAgentConfig({
      id: 'vision-toggle-off', name: 'vision-toggle-off', description: '视觉开关剔除用例',
      system: '按当前截图完成任务。', tools: ['browser_navigate', 'vision_gui'], category: 'general', tags: [],
    });
    assert.ok(toggleOffWrite.ok, '未开启视觉操作但残留 vision_gui 的智能体写入成功');
    // 数据层归一（L0）：写入即剔除 vision_gui，存储的 tools 恒不含该受控工具
    const storedOff = agentStore.getAgentConfig('vision-toggle-off');
    assert.ok(storedOff && !storedOff.tools.includes('vision_gui'),
      '数据层归一：写入时剔除 vision_gui 残留（normalizeAgentConfig）');
    const storedOn = agentStore.getAgentConfig('vision-toggle-on');
    assert.ok(storedOn && !storedOn.tools.includes('vision_gui'),
      '数据层归一：开关开启的智能体同样只存选择面，vision_gui 由运行时注入');
    // 装配层（L3）纯函数分支：注入 / 幂等去重 / 剔除并上报残留 / 无残留干净通过
    const injected = applyVisionToggleToolSurface(['browser_navigate'], true);
    assert.ok(injected.toolIds.includes('vision_gui') && !injected.strippedResidue,
      '归一函数：开关开启 → 注入 vision_gui');
    const deduped = applyVisionToggleToolSurface(['vision_gui', 'browser_navigate'], true);
    assert.equal(deduped.toolIds.filter(id => id === 'vision_gui').length, 1,
      '归一函数：已存在 vision_gui 时幂等去重');
    const stripped = applyVisionToggleToolSurface(['browser_navigate', 'vision_gui'], false);
    assert.deepEqual(stripped.toolIds, ['browser_navigate'], '归一函数：开关关闭 → 剔除残留');
    assert.equal(stripped.strippedResidue, true, '归一函数：剔除时上报残留供告警');
    const clean = applyVisionToggleToolSurface(['browser_navigate'], false);
    assert.deepEqual(clean.toolIds, ['browser_navigate'], '归一函数：无残留时原样通过');
    assert.equal(clean.strippedResidue, false, '归一函数：无残留不上报告警');
    // 端到端链路：开 → 工具面 + 规程；关 → 两者皆无
    const toggleOn = await runtimeBuilder.build({chatId:'vision-toggle-on-run',userInput:'执行',agentName:'vision-toggle-on',skillNames:[],priorRecords:[]});
    assert.ok(toggleOn.toolIds.includes('vision_gui'), '时序第 1 步：开关开启 → 工具面注入 vision_gui');
    assert.ok(toggleOn.systemPrompt.split('<vision-gui-tool>').length-1 === 1, '时序第 2 步：检测到 vision_gui → 注入规程（恰好一份）');
    assert.ok(toggleOn.vision, '视觉循环配置随开关生效');
    assert.ok((toggleOn.advertisedToolIds ?? []).includes('vision_gui'), '注入的 vision_gui 同步进入 advertisedToolIds');
    const toggleOff = await runtimeBuilder.build({chatId:'vision-toggle-off-run',userInput:'执行',agentName:'vision-toggle-off',skillNames:[],priorRecords:[]});
    assert.ok(!toggleOff.toolIds.includes('vision_gui'), '开关关闭 → 交付工具面恒无 vision_gui');
    assert.ok(!toggleOff.systemPrompt.includes('<vision-gui-tool>'), '工具面无 vision_gui → 不注入规程');
    assert.ok(!toggleOff.vision, '未开启时视觉循环配置不生效');
  } finally {
    agentStore.removeAgentConfig('vision-toggle-on');
    agentStore.removeAgentConfig('vision-toggle-off');
  }
  // 装配不变量（承载校验后必须恒成立）：工具目录里每一项都可执行——
  // advertisedToolIds ⊆ toolIds。三种会话形态同测（观察型 / 动作型 / 无智能体
  // 默认对话）；此断言曾能拦下 web-research-report 携带工具进入多智能体目录
  // 的「看得见调不了」死链（无智能体回落全部启用技能是同根因的最后漏洞）
  for (const rt of [built, action, customAction]) {
    assert.ok((rt.advertisedToolIds ?? []).every(id => rt.toolIds.includes(id)),
      `advertised ⊆ toolIds（${rt.agentId || '无智能体'} 会话无死链工具）`);
  }
  // 无智能体会话不再回落全部启用技能：可用技能同样满足承载校验
  //（库中存在 browser_page_exec 专属技能，旧「全部启用」行为会把它列进
  //  仅含核心工具的默认对话——此断言在旧行为下必失败）
  const noAgentSkills = skillEngine.resolveAvailableSkills(null, customAction.toolIds);
  assert.ok(noAgentSkills.every(s => s.allowedTools.every(t => customAction.toolIds.includes(t))),
    '无智能体可用技能同样满足承载校验');
  const safe=setCustomSkill({name:'guide-safe-skill',files:{'SKILL.md':'---\nname: guide-safe-skill\ndescription: Safe reading\n---\nRead current page'},allowedTools:['vision_gui']});
  assert.equal(safe.ok,true);
  if(safe.ok){
    const safeRuntime=await runtimeBuilder.build({chatId:'safe-guide',userInput:'解释页面',agentName:'视觉助手',skillNames:[safe.skill.id],priorRecords:[]});
    assert.equal(safeRuntime.activationContext.length,2);assert.equal(safeRuntime.toolIds.every(isVisionAssistantTool),true);
    const unselected=await runtimeBuilder.build({chatId:'safe-guide',userInput:'解释页面',agentName:'视觉助手',skillNames:[],priorRecords:[]});
    assert.equal(safeRuntime.systemPrompt,unselected.systemPrompt,'Selecting a listed skill must not rewrite the system prefix');
    assert.deepEqual(safeRuntime.advertisedToolIds,unselected.advertisedToolIds,'Skill activation must not change the advertised schemas');
    assert.ok(safeRuntime.advertisedToolIds?.every(isVisionAssistantTool));
    engine.injectSkillTools(runtime,handle,{data:{skill:safe.skill.id}});
    assert.equal(handle.dynamicToolIds.has('vision_gui'),true);
  }
} finally { modelRegistry.require=savedRequire; (globalThis as any).window=previousWindow; }
console.log('[vision-assistant] Observation payload, no-click nested scrolling, argument defenses, image continuation, runtime/skill capability ceiling passed.');

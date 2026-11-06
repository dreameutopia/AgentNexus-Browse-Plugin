import { JSDOM } from 'jsdom';
import { BrowserObserveTool } from '../../tools/browser/observe';
import { BrowserInteractTool } from '../../tools/browser/interact';

/** Public-tool regression scenarios; all payloads are re-evaluated without module scope. */
export async function testComplexControls(
  check: (condition: boolean, label: string, detail?: unknown) => void,
  eq: (actual: unknown, expected: unknown, label: string) => void,
) {
  const savedChrome = globalThis.chrome;
  const keys = ['document','window','Node','Element','XPathResult','CSS','MouseEvent','Event','getComputedStyle'];
  const saved = keys.map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  const dom = new JSDOM('<!doctype html><body></body>',{url:'https://complex.example/',pretendToBeVisual:true});
  const win = dom.window;
  win.Element.prototype.getBoundingClientRect = function() {
    return {x:10,y:10,left:10,top:10,right:110,bottom:40,width:100,height:30,toJSON(){}} as DOMRect;
  };
  win.Element.prototype.getClientRects = function() {return [this.getBoundingClientRect()] as unknown as DOMRectList;};
  (win.document as any).elementFromPoint = () => null;
  const restore = () => {for (const [key,descriptor] of saved) {if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete (globalThis as any)[key];}};
  const install = () => Object.assign(globalThis,{document:win.document,window:win,Node:win.Node,Element:win.Element,XPathResult:win.XPathResult,
    CSS:{escape:(s:string)=>s.replace(/[^a-z0-9_-]/gi,c=>'\\'+c)},MouseEvent:win.MouseEvent,Event:win.Event,getComputedStyle:win.getComputedStyle.bind(win)});
  const observer = new BrowserObserveTool();
  const interact = new BrowserInteractTool();
  const data = (r:any) => r.data || {};
  try {
    globalThis.chrome = {...savedChrome,tabs:{...savedChrome.tabs,query:async()=>[{id:71,url:'https://complex.example/'}]},scripting:{...savedChrome.scripting,
      executeScript:async (p:any) => {install(); try {return [{frameId:0,result:await (0,eval)('('+p.func.toString()+')')(...p.args)}];} finally {restore();}}
    }} as unknown as typeof chrome;
    const read = async (id:string) => {
      for (const view of ['structure','controls'] as const) {
        let rows = await observer.execute({view,regex:id});
        check(rows.success,'复杂控件扫描 '+id,rows.error);
        while (rows.success) {
          for (const item of data(rows).details || []) {
            const detail = data(await observer.execute({view:'element',elementId:item.elementId,frameId:0}));
            if (detail.attributes?.id === id) return {ref:{elementId:item.elementId,frameId:0},detail};
          }
          if (data(rows).nextPage === null) break;
          rows = await observer.execute({snapshotId:data(rows).snapshotId,page:data(rows).nextPage});
        }
      }
      throw new Error('Missing fixture '+id);
    };
    const act = async (action:any,id:string,values:Record<string,unknown>={}) => interact.execute({action,...(await read(id)).ref,...values,description:'复杂控件回归'});
    win.document.body.innerHTML = `
      <div id="range" data-date-range><input id="start" type="date" aria-label="开始日期" value="2026-11-05"><input id="end" type="date" aria-label="结束日期" value="2026-11-09"><input type="password" value="range-secret"></div>
      <div id="timeRange" data-time-range><input type="time" value="10:00"><input type="time" value="11:00"></div>
      <div data-calendar id="calendar" role="grid" aria-rowcount="6" aria-colcount="7"><div role="row"><button id="day" role="gridcell" aria-selected="false" aria-label="2026年11月5日" data-date="2026-11-05" aria-rowindex="2" aria-colindex="5">5</button></div></div>
      <span id="segment" role="spinbutton" contenteditable="true" tabindex="0" data-type="month" aria-valuemin="1" aria-valuemax="12" aria-valuenow="11">11</span>
      <table id="table"><tr id="head"><th id="header" aria-sort="ascending" colspan="2">地区</th><th scope="row" id="rowHeader">名称</th></tr><tr><td colspan="2">甲</td><td id="mergedAfter">乙</td></tr></table>
      <div id="virtual" role="treegrid" aria-rowcount="1000000" aria-colcount="50" aria-multiselectable="true"><div id="virtualRow" role="row" aria-rowindex="450" aria-expanded="false"><div id="virtualCell" role="gridcell" aria-colindex="12" aria-selected="false" aria-readonly="true">A</div></div></div>
      <div id="outer" role="listbox"><div id="outerOption" role="option" aria-selected="false">外层</div><div role="listbox"><div id="innerOption" role="option" aria-selected="false">内层</div></div></div>
      <div role="listbox" aria-multiselectable="true"><div id="multiOption" role="option" aria-selected="true">多选项</div></div>
      <button id="focusDisabled">聚焦禁用</button><input id="focusInput" value="old"><button id="throws">异常</button>
      <button id="duplicate">重复甲</button><button id="duplicate">重复乙</button>
      <progress id="progress" max="100" value="20"></progress><meter id="meter" min="0" max="100" low="20" high="80" value="60"></meter>`;
    const range = (await read('range')).detail.semantics;
    eq(range.states.fields.length,2,'日期区间字段关系排除密码');
    check(range.patterns.includes('date-range'),'日期区间保留复合模式');
    check(!JSON.stringify(range).includes('range-secret'),'区间元数据不暴露密码');
    (win.document.querySelector('input[type="password"]') as HTMLInputElement).setCustomValidity('invalid range-secret');
    check(!JSON.stringify(data(await observer.execute({view:'structure'}))).includes('range-secret'),'密码自定义校验文案也不泄漏密码');
    const timeRange = (await read('timeRange')).detail.semantics;
    check(timeRange.patterns.includes('time-range') && timeRange.states.fields.length===2 && timeRange.states.fields[0].value==='10:00','时间区间保留两个时间字段和值');
    check(data(await observer.execute({categories:['date-range']})).totalElements >= 2,'区间模式可作为类别筛选');
    const calendar = data(await observer.execute({categories:['calendar']}));
    check(calendar.details.some((d:any)=>d.category==='grid') && calendar.details.some((d:any)=>d.category==='gridcell'),'日历筛选保留 grid 和日期单元格基础类别');
    const day = (await read('day')).detail.semantics;
    eq(day.states['data-date'],'2026-11-05','日期单元格保留明确日期，不按日数字猜月份');
    eq(day.states.colindex,'5','保留日历逻辑列索引');
    const segment = (await read('segment')).detail.semantics;
    check(segment.patterns.includes('date-segment') && segment.states.segment==='month','分段日期保留年月日组成');
    check(!segment.actions.includes('fill'),'分段日期不建议覆盖整个 DOM');
    const segmentFill = await act('fill','segment',{value:'12'});
    check(!segmentFill.success && data(segmentFill).cause.errorCode==='UNSUPPORTED_FILL','拒绝破坏分段日期 DOM 且返回原因');
    eq((await read('table')).detail.semantics.category,'table','原生表格分类');
    const header = (await read('header')).detail.semantics;
    check(header.category==='columnheader' && header.states.sort==='ascending' && header.states.colspan===2,'表头排序及合并单元格感知');
    eq((await read('rowHeader')).detail.semantics.category,'rowheader','行头分类');
    const merged = (await read('mergedAfter')).detail.semantics.states;
    check(merged.domCellIndex===1 && merged.colindex===undefined,'含 colspan 时不把 DOM 序号伪造成逻辑列号');
    const virtual = (await read('virtual')).detail.semantics;
    eq(virtual.states.rowcount,'1000000','虚拟多维表格保留声明总行数');
    const cell = (await read('virtualCell')).detail.semantics;
    check(cell.states.colindex==='12' && cell.states.readonly,'虚拟表格列索引和只读状态');
    const oldCell = (await read('virtualCell')).ref;
    win.document.getElementById('virtualRow')!.setAttribute('aria-rowindex','451');
    check(!(await interact.execute({action:'click',...oldCell,description:'不得操作被复用行'})).success,'虚拟行复用时拒绝旧单元格引用');
    check(!(await act('select','outer',{values:['内层']})).success,'不能穿透嵌套列表误选内层项');
    check((await act('set_selected','outerOption',{selected:false})).success,'已取消的单选项允许无副作用返回');
    win.document.getElementById('outerOption')!.setAttribute('aria-selected','true');
    let singleClicks=0; win.document.getElementById('outerOption')!.onclick=()=>{singleClicks++;};
    check(!(await act('set_selected','outerOption',{selected:false})).success && singleClicks===0,'单选项不能靠重复点击取消');
    win.document.getElementById('multiOption')!.onclick=()=>win.document.getElementById('multiOption')!.setAttribute('aria-selected','false');
    check((await act('set_selected','multiOption',{selected:false})).success,'明确多选组允许取消选中');
    const input=win.document.getElementById('focusInput') as HTMLInputElement;
    input.addEventListener('focus',()=>{input.disabled=true;});
    const focusResult=await act('fill','focusInput',{value:'new'});
    check(!focusResult.success && input.value==='old','聚焦后变为 disabled 不写入');
    (win.document.getElementById('throws') as any).click=()=>{throw null;};
    const failure=await act('click','throws');
    check(!failure.success && data(failure).outcome==='unknown' && data(failure).cause.errorCode==='UNEXPECTED_DOM_ERROR' && String(failure.error).includes('null'),'null 异常保留阶段与原因且不重放');
    const all = data(await observer.execute({view:'buttons',regex:'重复'}));
    for (const item of all.details.filter((d:any)=>d.name?.startsWith('重复'))) {
      const detail=data(await observer.execute({view:'element',elementId:item.elementId,frameId:0}));
      const matched=win.document.evaluate(detail.xpath,win.document,null,win.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);
      check(matched.snapshotLength===1 && matched.snapshotItem(0)?.textContent===detail.text,'重复 HTML id 的 XPath 仍唯一定位原节点');
    }
    const progress=(await read('progress')).detail.semantics;
    check(progress.category==='progress' && progress.states.valuemax===100,'原生进度元素感知');
    eq((await read('meter')).detail.semantics.states.high,80,'原生 meter 阈值感知');
    const guarded=win.document.createElement('div');
    guarded.innerHTML='<button id="opacityGuard" role="button">隐藏祖先防御</button><button id="duplicateRelation" role="combobox" aria-controls="samePopup">重复关联</button><div id="samePopup" role="listbox"><div role="option" aria-selected="false">唯一项</div></div><div id="samePopup" role="listbox"><div role="option" aria-selected="false">其他项</div></div>';
    win.document.body.append(guarded);
    const opacityRef=(await read('opacityGuard')).ref;
    guarded.style.opacity='0.01';
    const hidden=await interact.execute({action:'click',...opacityRef,description:'不能操作透明祖先下控件'});
    check(!hidden.success && data(hidden).outcome==='not_dispatched' && data(hidden).cause.errorCode==='NOT_RENDERED','祖先透明时不可操作且错误可分析');
    guarded.style.opacity='1';
    const ambiguous=(await read('duplicateRelation')).detail.semantics;
    check(ambiguous.states.relationWarnings?.some((warning:any)=>warning.reason==='duplicate_id'),'重复关系 ID 明确告警而非绑定首个节点');
    const ambiguousSelect=await act('select','duplicateRelation',{values:['唯一项']});
    check(!ambiguousSelect.success && data(ambiguousSelect).cause.errorCode==='AMBIGUOUS_RELATION','重复 aria-controls ID 不会选错列表');
    const deepRow=win.document.createElement('div'); deepRow.setAttribute('role','row'); deepRow.setAttribute('aria-rowindex','900');
    let wrapper=deepRow; for(let i=0;i<12;i++){const child=win.document.createElement('div');wrapper.append(child);wrapper=child;}
    wrapper.innerHTML='<span id="deepCell" role="gridcell">不变文字</span>'; win.document.body.append(deepRow);
    const deepRef=(await read('deepCell')).ref; deepRow.setAttribute('aria-rowindex','901');
    check(!(await interact.execute({action:'click',...deepRef,description:'深层虚拟行复用防御'})).success,'深层包装仍能识别虚拟行身份变化');
  } finally {globalThis.chrome=savedChrome;restore();win.close();}
}

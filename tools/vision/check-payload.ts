export interface VisualExpectation {
  urlIncludes?:string; textIncludes?:string; nameIncludes?:string;
  enabled?:boolean; editable?:boolean; checked?:boolean; valueEquals?:string;
}
export interface PointEvidence {
  identity:string; signature:string; name:string; tag:string;
  rect:{x:number;y:number;width:number;height:number};
  enabled:boolean; editable:boolean; checked:boolean|null; opaqueFrame:boolean; opaqueContent:boolean;
}
/** Self-contained isolated-world observation; no focus, input, click, or supplied code. */
export function checkPagePayload(point: {x:number;y:number}|undefined, expect:VisualExpectation={}) {
  const clean=(s:string|null|undefined,max=300)=>(s??'').replace(/\s+/g,' ').trim().slice(0,max);
  const inViewport=(r:DOMRect)=>r.width>0 && r.height>0 && r.right>0 && r.bottom>0 && r.left<innerWidth && r.top<innerHeight;
  const parentOf=(el:Element):Element|null=>el.parentElement || (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null);
  const visible=(el:Element)=>{
    const r=el.getBoundingClientRect();
    if(!inViewport(r)) return false;
    for(let e:Element|null=el,depth=0;e && depth<40;depth++,e=parentOf(e)) {
      const style=getComputedStyle(e),p=e.getBoundingClientRect();
      if(style.display==='none' || style.visibility!=='visible' || style.opacity==='0') return false;
      if(/hidden|clip|auto|scroll/.test(style.overflowX) && (r.right<=p.left || r.left>=p.right)) return false;
      if(/hidden|clip|auto|scroll/.test(style.overflowY) && (r.bottom<=p.top || r.top>=p.bottom)) return false;
    }
    return true;
  };
  const win=window as any;
  const registry=win.__agentNexusVisualChecks ??= {documentId:crypto.randomUUID(),ids:new WeakMap<Element,number>(),next:1};
  let receiver:Element|null=null, element:Element|null=null;
  if(point) {
    receiver=document.elementFromPoint(point.x,point.y);
    for(let i=0;receiver?.shadowRoot && i<20;i++) {
      const inner=receiver.shadowRoot.elementFromPoint(point.x,point.y);
      if(!inner || inner===receiver) break;
      receiver=inner;
    }
    element=receiver;
    for(let e=receiver,depth=0;e && depth<12;depth++,e=parentOf(e)) {
      if(e.matches('button,a[href],input,textarea,select,[role],[contenteditable]')) {element=e;break;}
    }
  }
  let target:PointEvidence|null=null;
  let secret=false, localValue:string|undefined;
  if(element) {
    const r=element.getBoundingClientRect();
    let disabled=false;
    for(let e:Element|null=element,depth=0;e && depth<40;depth++,e=parentOf(e)) {
      if(e.matches(':disabled,[aria-disabled="true"],[inert]')) disabled=true;
    }
    const control=element as HTMLInputElement;
    secret=element.matches('input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"]');
    const editable=(element instanceof HTMLInputElement && ['text','search','url','tel','email','number','password'].includes(element.type) ||
      element instanceof HTMLTextAreaElement || (element as HTMLElement).isContentEditable) && !disabled && !control.readOnly;
    const checked=element.matches('input[type="checkbox"],input[type="radio"]') ? !!control.checked :
      ['true','false'].includes(element.getAttribute('aria-checked')??'') ? element.getAttribute('aria-checked')==='true' : null;
    const name=clean(element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || (secret ? '' : element.textContent));
    if(!registry.ids.has(element)) registry.ids.set(element,registry.next++);
    const identity=`${registry.documentId}:${registry.ids.get(element)}`;
    const rect={x:r.x,y:r.y,width:r.width,height:r.height};
    const signature=JSON.stringify([identity,name,disabled,!!editable,checked,
      element.getAttribute('href')?.slice(0,2000),element.getAttribute('type'),element.getAttribute('aria-expanded'),element.getAttribute('aria-pressed'),element.getAttribute('aria-valuenow'),
      rect.x,rect.y,rect.width,rect.height]);
    target={identity,signature,name,tag:element.localName,rect,enabled:!disabled,editable:!!editable,checked,
      opaqueFrame:element instanceof HTMLIFrameElement,opaqueContent:element.matches('canvas,video,object,embed') || !!receiver?.matches('canvas,video,object,embed')};
    if(!secret) {
      if(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) localValue=element.value;
      else if((element as HTMLElement).isContentEditable) localValue=(element as HTMLElement).innerText;
    }
  }
  const dialogs=Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]')).slice(0,20)
    .filter(visible)
    .slice(0,5).map(el=>({tag:el.localName,name:clean(el.getAttribute('aria-label')||el.textContent,200)}));
  const checks:{kind:string;status:'passed'|'failed'|'unknown';reason?:string}[]=[];
  const check=(kind:string,matches:boolean|undefined,reason?:string)=>checks.push({kind,status:matches===undefined?'unknown':matches?'passed':'failed',...(reason?{reason}:{})});
  if(expect.urlIncludes!==undefined) check('urlIncludes',location.href.includes(expect.urlIncludes));
  if(expect.textIncludes!==undefined) {
    const deadline=performance.now()+150;
    const walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT);
    let node:Node|null, chars=0,nodes=0,truncated=false,matched=false;
    while((node=walker.nextNode())) {
      if(++nodes>3000 || chars>=8000 || performance.now()>deadline) {truncated=true;break;}
      const el=node.parentElement;
      if(!el || el.closest('script,style,noscript,input,textarea,[hidden],[aria-hidden="true"]')) continue;
      if(!visible(el)) continue;
      const text=(node.textContent??'').slice(0,8000-chars); chars+=text.length;
      let index=text.indexOf(expect.textIncludes), attempts=0;
      while(index>=0 && attempts++<8) {
        const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+expect.textIncludes.length);
        const rects=Array.from(range.getClientRects());
        matched=rects.length>0 && rects.every(r=>{
          if(!inViewport(r) || r.left<0 || r.top<0 || r.right>innerWidth || r.bottom>innerHeight) return false;
          for(let p:Element|null=el,depth=0;p && depth<40;depth++,p=parentOf(p)) {
            const style=getComputedStyle(p),clip=p.getBoundingClientRect();
            if(/hidden|clip|auto|scroll/.test(style.overflowX) && (r.left<clip.left-0.5 || r.right>clip.right+0.5)) return false;
            if(/hidden|clip|auto|scroll/.test(style.overflowY) && (r.top<clip.top-0.5 || r.bottom>clip.bottom+0.5)) return false;
          }
          const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          return !!hit && el.contains(hit);
        });
        if(matched) break;
        index=text.indexOf(expect.textIncludes,index+1);
      }
      if(matched) break;
    }
    // Missing matches are unknown: rendered text, iframe interiors and occlusion coverage are partial.
    check('textIncludes',matched?true:undefined,truncated?'Visible text scan reached its budget':'Literal substring ranges are checked in individual rendered text nodes; split/occluded text may be unknown');
  }
  for(const kind of ['enabled','editable','checked','nameIncludes','valueEquals'] as const) {
    if(expect[kind]===undefined) continue;
    if(!target || target.opaqueFrame) {check(kind,undefined,'No inspectable main-frame target at point');continue;}
    if(kind==='nameIncludes') check(kind,target.name.includes(expect.nameIncludes!));
    else if(kind==='valueEquals') check(kind,secret || localValue===undefined ? undefined : localValue===expect.valueEquals,
      secret?'Password value checks are not exposed':undefined);
    else check(kind,target[kind]===null?undefined:target[kind]===expect[kind]);
  }
  return {target,receiver:receiver?{tag:receiver.localName}:null,checks,
    page:{url:location.href,title:clean(document.title),readyState:document.readyState,visibility:document.visibilityState,
      focused:document.hasFocus(),scroll:{x:scrollX,y:scrollY}},
    loading:{documentComplete:document.readyState==='complete',ariaBusyCount:Math.min(100,document.querySelectorAll('[aria-busy="true"]').length)},dialogs,
    coverage:{complete:false,scope:'main-frame point and bounded visible DOM',limitations:'Opaque frames, Canvas contents, closed shadow roots and full visual occlusion are not inferred. Geometry stability is not network or business readiness.'}};
}

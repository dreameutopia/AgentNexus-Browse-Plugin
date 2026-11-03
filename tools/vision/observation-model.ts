import { GuiError } from './gui-errors';
import { finiteRange, relativePoint, type RelativePoint } from './coordinates';

export interface ImageRegion { x:number; y:number; width:number; height:number }
export interface CropPlan { x:number; y:number; width:number; height:number; outputWidth:number; outputHeight:number; region:ImageRegion }
export function imageRegion(raw: unknown): ImageRegion {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['x','y','width','height'].includes(k)))
    throw new GuiError('INVALID_ARGUMENT','region requires only x/y/width/height in original screenshot coordinates');
  const r = raw as ImageRegion;
  finiteRange(r.x,'region.x',0,1000); finiteRange(r.y,'region.y',0,1000);
  finiteRange(r.width,'region.width',0.001,1000); finiteRange(r.height,'region.height',0.001,1000);
  if (r.x+r.width > 1000+1e-8 || r.y+r.height > 1000+1e-8) throw new GuiError('INVALID_ARGUMENT','region extends beyond the original screenshot');
  return {...r};
}
export function planCrop(size:{width:number;height:number}, raw:unknown, scale=2): CropPlan {
  const r = imageRegion(raw); finiteRange(scale,'scale',1,4);
  finiteRange(size.width,'image.width',1,32768); finiteRange(size.height,'image.height',1,32768);
  const x=Math.floor(r.x*size.width/1000), y=Math.floor(r.y*size.height/1000);
  const right=Math.min(size.width,Math.ceil((r.x+r.width)*size.width/1000));
  const bottom=Math.min(size.height,Math.ceil((r.y+r.height)*size.height/1000));
  const width=right-x,height=bottom-y;
  if (width<1 || height<1) throw new GuiError('INVALID_ARGUMENT','region has no source pixels');
  const factor=Math.min(scale,2048/Math.max(width,height),Math.sqrt(4_000_000/(width*height)));
  return {x,y,width,height,outputWidth:Math.max(1,Math.round(width*factor)),outputHeight:Math.max(1,Math.round(height*factor)),
    region:{x:x/size.width*1000,y:y/size.height*1000,width:width/size.width*1000,height:height/size.height*1000}};
}

interface View { screenshotId:string; region:ImageRegion }
interface TargetGuard { screenshotId:string; point:RelativePoint; signature:string }
const views=new Map<string,View>(), guards=new Map<string,TargetGuard>();
export function registerView(screenshotId:string,region:ImageRegion):string {
  if(typeof screenshotId!=='string' || !screenshotId || screenshotId.length>128) throw new GuiError('INVALID_ARGUMENT','Invalid view parent screenshotId');
  const id=crypto.randomUUID(); views.set(id,{screenshotId,region:imageRegion(region)});
  if(views.size>32) views.delete(views.keys().next().value!); return id;
}
export function mapViewPoint(screenshotId:string,viewId:unknown,raw:unknown):RelativePoint {
  const p=relativePoint(raw);
  if(viewId===undefined) return p;
  const view=typeof viewId==='string' ? views.get(viewId) : undefined;
  if(!view || view.screenshotId!==screenshotId) throw new GuiError('STALE_SCREENSHOT','Unknown or stale zoom viewId; zoom the latest screenshot again');
  return {x:Math.max(0,Math.min(1000,view.region.x+p.x*view.region.width/1000)),y:Math.max(0,Math.min(1000,view.region.y+p.y*view.region.height/1000))};
}
export function registerTargetGuard(screenshotId:string,point:RelativePoint,signature:string):string {
  if(typeof screenshotId!=='string' || !screenshotId || screenshotId.length>128 || typeof signature!=='string' || !signature || signature.length>8192) throw new GuiError('INVALID_ARGUMENT','Invalid target guard metadata');
  const id=crypto.randomUUID(); guards.set(id,{screenshotId,point:relativePoint(point),signature});
  if(guards.size>64) guards.delete(guards.keys().next().value!); return id;
}
export function targetGuard(id:unknown,screenshotId:string,point:RelativePoint):Readonly<TargetGuard> {
  const guard=typeof id==='string' ? guards.get(id) : undefined;
  if(!guard || guard.screenshotId!==screenshotId || Math.abs(guard.point.x-point.x)>0.001 || Math.abs(guard.point.y-point.y)>0.001)
    throw new GuiError('STALE_SCREENSHOT','Target guard does not belong to this screenshot and action point; check the target again');
  return guard;
}

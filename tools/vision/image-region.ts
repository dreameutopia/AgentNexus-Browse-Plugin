import { bounded, GuiError } from './gui-errors';
import { pngDimensions } from './coordinates';
import { planCrop, type CropPlan } from './observation-model';

/** Self-contained browser/SW payload; no page capture or DOM access. */
export async function renderPngCrop(data:string,plan:CropPlan) {
  const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));
  const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
  try {
    const canvas=new OffscreenCanvas(plan.outputWidth,plan.outputHeight), context=canvas.getContext('2d');
    if(!context) throw new Error('2D crop context unavailable');
    context.imageSmoothingEnabled=false;
    context.drawImage(bitmap,plan.x,plan.y,plan.width,plan.height,0,0,canvas.width,canvas.height);
    const blob=await canvas.convertToBlob({type:'image/png'});
    if(blob.size>16*1024*1024) throw new Error('Crop output exceeds 16 MiB');
    const result=new Uint8Array(await blob.arrayBuffer());
    let binary='';
    for(let i=0;i<result.length;i+=8192) binary+=String.fromCharCode(...result.subarray(i,i+8192));
    return {screenshot:`data:image/png;base64,${btoa(binary)}`,imageSize:{width:canvas.width,height:canvas.height}};
  } finally {bitmap.close();}
}
export async function cropOriginalImage(data:string|undefined,region:unknown,scale=2) {
  if(!data) throw new GuiError('INVALID_SCREENSHOT','Original screenshot image is unavailable or exceeds the bounded cache limit',{},
    'Capture once if this is an old image. If the same image remains too large, reduce the capture window or use DOM inspection; do not repeatedly recapture unchanged content.');
  if(typeof OffscreenCanvas==='undefined' || typeof createImageBitmap==='undefined') throw new GuiError('UNSUPPORTED_CONTEXT','Image cropping requires OffscreenCanvas/createImageBitmap');
  const size=pngDimensions(data);
  if(size.width*size.height>64_000_000) throw new GuiError('INVALID_SCREENSHOT','Source image exceeds the 64MP decoding budget',{imageSize:size},'Reduce the capture window before requesting a crop.');
  const plan=planCrop(size,region,scale);
  try {
    const image=await bounded(renderPngCrop(data,plan),5000,'Render screenshot region');
    return {...image,region:plan.region,sourcePixels:{x:plan.x,y:plan.y,width:plan.width,height:plan.height}};
  } catch(error) {
    if(error instanceof GuiError) throw error;
    throw new GuiError('INVALID_SCREENSHOT','Original PNG could not be decoded or cropped',
      {cause:error instanceof Error?error.message:String(error)},'Capture a fresh screenshot or reduce the capture size before retrying the observation.');
  }
}

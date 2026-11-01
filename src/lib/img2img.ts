// v1.7.0 Img2Img: the source is fitted to the generation size here, so the GPU request stays small
// (bounded by width x height, not by the uploaded file) and the latent size always matches the masks/maps.
const MAX_PNG=4*1024*1024,MAX_SOURCE=8*1024*1024;
// Exactly Diffusers get_timesteps(): Img2Img runs int(steps*strength) of the requested steps.
export const denoiseSteps=(steps:number,strength:number)=>Math.min(Math.floor(steps*strength),steps);
export function img2imgError(steps:number,denoise:number){
 if(!Number.isFinite(denoise)||denoise<=0||denoise>1)return 'Img2Img: Denoise должен быть больше 0 и не больше 1.';
 if(denoiseSteps(steps,denoise)<1)return 'Img2Img: при таком Denoise не выполняется ни одного шага. Увеличьте Denoise или Steps.';
 return '';
}
const round8=(v:number)=>Math.min(1536,Math.max(256,Math.round(v/8)*8));
// About 1 megapixel with the source aspect ratio (SDXL native area), multiples of 8 within 256–1536.
export function sizeFromSource(w:number,h:number){const r=w/h;const width=round8(Math.sqrt(1048576*r));return {width,height:round8(width/r)}}
export async function prepareSource(file:File,width:number,height:number):Promise<string>{
 const bitmap=await createImageBitmap(file).catch(()=>{throw Error('Не удалось прочитать исходное изображение.')});
 try{
  // Centre crop (cover), never stretched or padded; same rule as the engine-side fallback.
  const scale=Math.max(width/bitmap.width,height/bitmap.height),sw=width/scale,sh=height/scale;
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d');if(!ctx)throw Error('Не удалось подготовить исходное изображение.');
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height);// transparent areas become white, not black
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.drawImage(bitmap,(bitmap.width-sw)/2,(bitmap.height-sh)/2,sw,sh,0,0,width,height);
  let url=canvas.toDataURL('image/png');
  if(url.length>MAX_PNG)url=canvas.toDataURL('image/jpeg',.95);
  canvas.width=canvas.height=0;
  if(url.length>MAX_SOURCE)throw Error('Исходное изображение слишком велико. Уменьшите размеры.');
  return url;
 }finally{bitmap.close()}
}

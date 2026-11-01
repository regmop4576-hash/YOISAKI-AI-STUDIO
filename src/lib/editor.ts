export type Stroke={points:number[];size:number;erase:boolean};
export type Box={x:number;y:number;width:number;height:number};
export type EditorInput={init_image:string;denoising_strength:number;mask_image?:string;face_region?:Box;mask_blur:number;mask_padding:number;inpaint_region:'crop'|'full'};
export function boundedBox(b:Box,w:number,h:number):Box{
 const width=Math.max(2,Math.min(w,b.width)),height=Math.max(2,Math.min(h,b.height));
 return {x:Math.max(0,Math.min(w-width,b.x)),y:Math.max(0,Math.min(h-height,b.y)),width,height};
}
export function sourcePoint(x:number,y:number,originX:number,originY:number,scale:number,w:number,h:number){
 return {x:Math.max(0,Math.min(w,(x-originX)/scale)),y:Math.max(0,Math.min(h,(y-originY)/scale))};
}
export function maskCanvas(width:number,height:number,strokes:Stroke[]){
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
 const ctx=canvas.getContext('2d');if(!ctx)throw Error('Не удалось создать маску.');
 ctx.fillStyle='black';ctx.fillRect(0,0,width,height);
 for(const s of strokes){
  ctx.strokeStyle=s.erase?'black':'white';ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=s.size;ctx.lineCap='round';ctx.lineJoin='round';
  ctx.beginPath();ctx.moveTo(s.points[0],s.points[1]);for(let i=2;i<s.points.length;i+=2)ctx.lineTo(s.points[i],s.points[i+1]);ctx.stroke();
  ctx.beginPath();ctx.arc(s.points[0],s.points[1],s.size/2,0,Math.PI*2);ctx.fill();
 }
 return canvas;
}
export async function normalizedImage(file:File):Promise<HTMLImageElement>{
 if(file.size>25*1024*1024||!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('Нужен PNG, JPEG или WebP до 25 МБ.');
 const bytes=new Uint8Array(await file.slice(0,12).arrayBuffer());
 const png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71;
 const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 const webp=String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
 if(!(file.type==='image/png'&&png||file.type==='image/jpeg'&&jpeg||file.type==='image/webp'&&webp))throw Error('Формат файла не совпадает с MIME.');
 const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
 try{
  if(Math.min(bitmap.width,bitmap.height)<16||Math.max(bitmap.width,bitmap.height)>8192||bitmap.width*bitmap.height>16777216)throw Error('Источник: до 16 Мп и 8192 по стороне.');
  const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;
  c.getContext('2d')!.drawImage(bitmap,0,0);
  const url=c.toDataURL('image/png');c.width=c.height=0;
  if(url.length>8*1024*1024)throw Error('PNG для отправки превышает 6 МБ. Уменьшите исходник. Размер не изменён автоматически.');
  const image=new Image();image.src=url;await image.decode();return image;
 }finally{bitmap.close()}
}

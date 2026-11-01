export type Stroke={points:[number,number][];size:number};
export type Region={id:string;name:string;enabled:boolean;visible:boolean;lora_id:string;trigger:string;prompt:string;negative_prompt:string;weight:number;rect:[number,number,number,number]|null;strokes:Stroke[]};
export type Regional={mode:'OFF'|'2 CHARACTERS'|'3 CHARACTERS'|'CUSTOM';regions:Region[]};
export const makeRegions=(count:number,layout='vertical'):Region[]=>Array.from({length:count},(_,i)=>({id:crypto.randomUUID(),name:'Region '+String.fromCharCode(65+i),enabled:true,visible:true,lora_id:'',trigger:'',prompt:'',negative_prompt:'',weight:.8,rect:layout==='horizontal'?[0,i/count,1,1/count]:[i/count,0,1/count,1],strokes:[]}));
export function paintMask(ctx:CanvasRenderingContext2D,r:Region,w:number,h:number){
 ctx.fillStyle='#fff';ctx.strokeStyle='#fff';ctx.lineCap='round';ctx.lineJoin='round';
 if(r.rect)ctx.fillRect(r.rect[0]*w,r.rect[1]*h,r.rect[2]*w,r.rect[3]*h);
 for(const stroke of r.strokes){ctx.lineWidth=stroke.size*Math.min(w,h);ctx.beginPath();stroke.points.forEach(([x,y],i)=>i?ctx.lineTo(x*w,y*h):ctx.moveTo(x*w,y*h));ctx.stroke();if(stroke.points.length===1){ctx.beginPath();ctx.arc(stroke.points[0][0]*w,stroke.points[0][1]*h,ctx.lineWidth/2,0,Math.PI*2);ctx.fill()}}
}
export function exportRegions(config:Regional|undefined,w:number,h:number){
 if(!config||normalizeRegionalMode(config.mode)==='OFF')return [];
 return config.regions.filter(r=>r.enabled).map(r=>{const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d')!;ctx.fillStyle='#000';ctx.fillRect(0,0,w,h);paintMask(ctx,r,w,h);return {name:r.name,enabled:r.enabled,lora_id:r.lora_id,trigger:r.trigger,prompt:r.prompt,negative_prompt:r.negative_prompt,weight:r.weight,mask:c.toDataURL('image/png')}});
}

/** OFF keeps the draft; re-enabling it must never replace masks or character prompts. */
export function regionalMode(value:Regional,mode:Regional['mode']):Regional{
 if(mode==='OFF')return {...value,mode};
 const count=mode==='CUSTOM'?(value.regions.length||1):mode==='2 CHARACTERS'?2:3;
 if(value.regions.length===count)return {...value,mode};
 return {mode,regions:makeRegions(count).map((r,i)=>value.regions[i]||r)};
}
export const hasActiveRegions=(value:Regional)=>normalizeRegionalMode(value.mode)!=='OFF'&&value.regions.some(r=>r.enabled);

/** Legacy localization changed implicit <option> values; repair saved labels without touching regions. */
export function normalizeRegionalMode(mode:unknown):Regional['mode']{
 const modes:Record<string,Regional['mode']>={'OFF':'OFF','ВЫКЛ':'OFF','2 CHARACTERS':'2 CHARACTERS','2 ПЕРСОНАЖА':'2 CHARACTERS','3 CHARACTERS':'3 CHARACTERS','3 ПЕРСОНАЖА':'3 CHARACTERS','CUSTOM':'CUSTOM','СВОИ ОБЛАСТИ':'CUSTOM'};
 return modes[String(mode).toUpperCase()]||'OFF';
}
export function normalizeRegional(value:Regional|undefined):Regional{
 return {mode:normalizeRegionalMode(value?.mode),regions:Array.isArray(value?.regions)?value.regions:[]};
}

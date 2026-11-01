export type Stroke={points:[number,number][];size:number};
export type Region={id:string;name:string;enabled:boolean;visible:boolean;lora_id:string;trigger:string;prompt:string;negative_prompt:string;weight:number;rect:[number,number,number,number]|null;strokes:Stroke[]};
/** `regions` is the saved draft (up to 3). Only the first `activeCount()` of them are shown, masked and sent:
 *  a template with fewer characters keeps the rest as inactive drafts instead of deleting them.
 *  `count` is the number of regions configured in CUSTOM mode. */
export type Regional={mode:'OFF'|'2 CHARACTERS'|'3 CHARACTERS'|'CUSTOM';regions:Region[];count?:number};
export const MAX_REGIONS=3;
const layoutRect=(i:number,count:number,layout='vertical'):[number,number,number,number]=>layout==='horizontal'?[0,i/count,1,1/count]:[i/count,0,1/count,1];
/** `start`/`total`: new regions appended after existing ones get their place in a `total`-region layout. */
export const makeRegions=(count:number,layout='vertical',start=0,total=start+count):Region[]=>Array.from({length:count},(_,k)=>{const i=start+k;return {id:crypto.randomUUID(),name:'Region '+String.fromCharCode(65+i),enabled:true,visible:true,lora_id:'',trigger:'',prompt:'',negative_prompt:'',weight:.8,rect:layoutRect(i,total,layout),strokes:[]}});
export function paintMask(ctx:CanvasRenderingContext2D,r:Region,w:number,h:number){
 ctx.fillStyle='#fff';ctx.strokeStyle='#fff';ctx.lineCap='round';ctx.lineJoin='round';
 if(r.rect)ctx.fillRect(r.rect[0]*w,r.rect[1]*h,r.rect[2]*w,r.rect[3]*h);
 for(const stroke of r.strokes){ctx.lineWidth=stroke.size*Math.min(w,h);ctx.beginPath();stroke.points.forEach(([x,y],i)=>i?ctx.lineTo(x*w,y*h):ctx.moveTo(x*w,y*h));ctx.stroke();if(stroke.points.length===1){ctx.beginPath();ctx.arc(stroke.points[0][0]*w,stroke.points[0][1]*h,ctx.lineWidth/2,0,Math.PI*2);ctx.fill()}}
}
const clampCount=(n:unknown,fallback:number)=>Number.isInteger(n)?Math.max(0,Math.min(MAX_REGIONS,n as number)):Math.max(0,Math.min(MAX_REGIONS,fallback));
/** Number of regions that are shown as tabs, drawn as masks and sent to the GPU. OFF → 0. */
export function activeCount(value:Regional):number{
 const mode=normalizeRegionalMode(value.mode);
 if(mode==='OFF')return 0;
 if(mode==='2 CHARACTERS')return 2;
 if(mode==='3 CHARACTERS')return 3;
 return Math.min(clampCount(value.count,value.regions.length),value.regions.length);
}
export const activeRegions=(value:Regional):Region[]=>value.regions.slice(0,activeCount(value));
export function exportRegions(config:Regional|undefined,w:number,h:number){
 if(!config)return [];
 return activeRegions(config).filter(r=>r.enabled).map(r=>{const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d')!;ctx.fillStyle='#000';ctx.fillRect(0,0,w,h);paintMask(ctx,r,w,h);return {name:r.name,enabled:r.enabled,lora_id:r.lora_id,trigger:r.trigger,prompt:r.prompt,negative_prompt:r.negative_prompt,weight:r.weight,mask:c.toDataURL('image/png')}});
}
const sameRect=(a:Region['rect'],b:Region['rect'])=>!!a&&!!b&&a.every((x,i)=>Math.abs(x-b[i])<1e-6);
/** A rectangle exactly equal to a built-in layout slot (never hand-edited). */
const defaultLayout=(r:Region,i:number)=>r.strokes.length?null:[1,2,3].flatMap(n=>['vertical','horizontal'].map(l=>[n,l] as const)).find(([n,l])=>i<n&&sameRect(r.rect,layoutRect(i,n,l)))?.[1]??null;
/** Pads the draft so that `count` regions exist. Untouched default masks follow the new layout;
 *  hand-drawn masks, prompts, LoRA and triggers are never changed. */
function withCount(regions:Region[],count:number):Region[]{
 const out=regions.slice(0,MAX_REGIONS);
 if(out.length<count)out.push(...makeRegions(count-out.length,'vertical',out.length,count));
 for(let i=0;i<count;i++){const layout=defaultLayout(out[i],i);if(layout)out[i]={...out[i],rect:layoutRect(i,count,layout)}}
 return out;
}
/** Mode switch. OFF only disables applying regions: the draft (incl. inactive regions) is kept.
 *  `count` remembers the last active number of regions, so OFF → CUSTOM restores what was used. */
export function regionalMode(value:Regional,mode:Regional['mode']):Regional{
 const current=normalizeRegional(value);const last=current.mode==='OFF'?current.count:activeCount(current);
 if(mode==='OFF')return {...current,mode,...(last===undefined?{}:{count:last})};
 const count=mode==='2 CHARACTERS'?2:mode==='3 CHARACTERS'?3:clampCount(last,current.regions.length)||1;
 return {mode,regions:withCount(current.regions,count),count};
}
/** Layout template (left/right, top/bottom, three columns). Applies default masks to the first `count`
 *  regions, keeps their prompts/LoRA, and makes exactly `count` regions active. */
export function applyTemplate(value:Regional,count:number,layout='vertical'):Regional{
 const current=normalizeRegional(value);const regions=withCount(current.regions,count).map((r,i)=>i<count?{...r,rect:layoutRect(i,count,layout),strokes:[]}:r);
 return {...current,mode:current.mode==='CUSTOM'?'CUSTOM':count===2?'2 CHARACTERS':'3 CHARACTERS',regions,count};
}
/** CUSTOM: + Region reveals a saved inactive region first, otherwise creates a new one. */
export function addCustomRegion(value:Regional):Regional{
 const n=activeCount(value);if(n>=MAX_REGIONS)return value;
 const regions=value.regions.length>n?value.regions:[...value.regions,...makeRegions(1,'vertical',n,n+1)];
 return {...value,regions,count:n+1};
}
export function removeCustomRegion(value:Regional,index:number):Regional{
 const n=activeCount(value);if(index<0||index>=n)return value;
 return {...value,regions:value.regions.filter((_,i)=>i!==index),count:n-1};
}
export const hasActiveRegions=(value:Regional)=>activeRegions(value).some(r=>r.enabled);

/** Legacy localization changed implicit <option> values; repair saved labels without touching regions. */
export function normalizeRegionalMode(mode:unknown):Regional['mode']{
 const modes:Record<string,Regional['mode']>={'OFF':'OFF','ВЫКЛ':'OFF','2 CHARACTERS':'2 CHARACTERS','2 ПЕРСОНАЖА':'2 CHARACTERS','3 CHARACTERS':'3 CHARACTERS','3 ПЕРСОНАЖА':'3 CHARACTERS','CUSTOM':'CUSTOM','СВОИ ОБЛАСТИ':'CUSTOM'};
 return modes[String(mode).trim().toUpperCase()]||'OFF';
}
const isRegion=(r:unknown):r is Region=>!!r&&typeof r==='object'&&typeof (r as Region).id==='string'&&Array.isArray((r as Region).strokes);
/** Saved settings → consistent state: known mode, at most 3 regions, enough regions for the mode.
 *  Old builds saved "2 ПЕРСОНАЖА" with three regions; the third stays saved but inactive. */
export function normalizeRegional(value:Regional|undefined):Regional{
 const mode=normalizeRegionalMode(value?.mode);
 const regions=(Array.isArray(value?.regions)?value.regions:[]).filter(isRegion).slice(0,MAX_REGIONS);
 const count=value&&Number.isInteger(value.count)?clampCount(value.count,regions.length):undefined;
 const need=mode==='2 CHARACTERS'?2:mode==='3 CHARACTERS'?3:0;
 return {mode,regions:regions.length<need?[...regions,...makeRegions(need-regions.length,'vertical',regions.length,need)]:regions,...(count===undefined?{}:{count})};
}

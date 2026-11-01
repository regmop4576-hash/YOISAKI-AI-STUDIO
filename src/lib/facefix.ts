// v1.8.1 SMART FACE FIX: pure helpers shared by the page and tests. Coordinates are source pixels.
import type {Box} from './editor';
export type Detector='auto'|'anime'|'human';
export type DetectedFace=Box&{id:string;confidence:number;detector:string;label:'face';auto_selectable:boolean};
export type Detection={detector:Detector;detectors_run:string[];min_confidence:number;auto_select_confidence:number;image:{width:number;height:number};faces:DetectedFace[];selected:string|null;selection_required:boolean;duration_ms:number|null};
// Separate Face Fix profile: never written into the Generate page settings.
export type FaceProfile={detector:Detector;minConfidence:number;padding:number;expand:number;shape:'ellipse'|'box';featherAuto:boolean;feather:number;steps:number;cfg:number;sampler:string;scheduler:string;workWidth:number;workHeight:number;randomSeed:boolean;seed:string};
export const FACE_DEFAULTS:Omit<FaceProfile,'sampler'|'scheduler'>={detector:'auto',minConfidence:.35,padding:.5,expand:.08,shape:'ellipse',featherAuto:true,feather:8,steps:25,cfg:5.5,workWidth:1024,workHeight:1024,randomSeed:true,seed:''};
export const DEFAULT_STRENGTH=.3;
/** Faces shown by default: confident ones. Uncertain ones only on request, never auto-selected. */
export function visibleFaces(d:Detection|null,showUncertain:boolean){return d?d.faces.filter(f=>showUncertain||f.auto_selectable):[]}
export function initialSelection(d:Detection):string[]{return d.selected?[d.selected]:[]}
/** Inward feather relative to the smallest selected face, clamped to the engine range. */
export function autoFeather(boxes:Box[]){const side=Math.min(...boxes.map(b=>Math.min(b.width,b.height)));return Number.isFinite(side)?Math.max(2,Math.min(32,Math.round(side*.08))):8}
/** Topmost (smallest) face containing a tap; source pixels. */
export function hitFace(faces:DetectedFace[],x:number,y:number){return faces.filter(f=>x>=f.x&&x<=f.x+f.width&&y>=f.y&&y<=f.y+f.height).sort((a,b)=>a.width*a.height-b.width*b.height)[0]||null}
export function profileError(p:FaceProfile,strength:number,prompt:string){
 if(!prompt.trim())return 'Добавьте Positive Prompt (описание персонажа) на странице Generate или в расширенных настройках.';
 if(!Number.isFinite(strength)||strength<=0||strength>1||Math.floor(p.steps*strength)<1)return 'Сила исправления слишком мала для выбранного числа шагов.';
 if(p.workWidth%8||p.workHeight%8||p.workWidth<256||p.workHeight<256||p.workWidth>1536||p.workHeight>1536||p.workWidth*p.workHeight>2097152)return 'Рабочий размер: 256–1536, кратно 8, до 2 Мп.';
 if(p.steps<1||p.steps>60||p.cfg<1||p.cfg>20)return 'Steps 1–60, CFG 1–20.';
 if(p.sampler==='Euler a'&&p.scheduler==='Karras')return 'Euler a работает только с Normal.';
 if(!p.randomSeed&&(!/^\d+$/.test(p.seed)||Number(p.seed)>2147483647))return 'Seed: целое число 0–2147483647.';
 return '';
}
type Global={prompt:string;negative:string;checkpoint:string;vae:string;loras:{id:string;weight:number;enabled:boolean}[]};
/** /generate body. Checkpoint, VAE, LoRA and prompts come unchanged from the shared settings. */
export function faceFixRequest(g:Global,p:FaceProfile,strength:number,image:string,target:{select:string[]}|{box:Box},auto:boolean,boxes:Box[]){
 const base={client_request_id:crypto.randomUUID(),regions:[],kind:'facefix',mode:'facefix',prompt:g.prompt,negative_prompt:g.negative,checkpoint_id:g.checkpoint,vae_id:g.vae||'auto',
  lora_adapters:g.loras.filter(l=>l.enabled).map(l=>({id:l.id,weight:l.weight})),width:p.workWidth,height:p.workHeight,steps:p.steps,cfg_scale:p.cfg,sampler:p.sampler,scheduler:p.scheduler,
  seed:p.randomSeed?-1:Number(p.seed),batch_size:1,controlnet_config:{enabled:false},init_image:image,denoising_strength:strength,
  mask_blur:p.featherAuto?autoFeather(boxes):p.feather,mask_padding:p.padding,inpaint_region:'crop' as const};
 const where='select' in target?{face_detection:{detector:p.detector,min_confidence:p.minConfidence,select:target.select}}:{face_region:{...target.box}};
 // Old engines (v1.8.0) do not know face_options; the local server also refuses to forward them there.
 return {...base,...where,...(auto?{face_options:{mask_shape:p.shape,mask_expand:p.expand,work_fit:'aspect' as const}}:{})};
}

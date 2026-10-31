'use client';
// v1.9.0 PIXEL FANTASY · Generate page and the shared generation controls (also used by Editor Img2Img / Inpaint /
// Face Fix). The request body, validation and job polling are unchanged from v1.8.1; only the layout moved into
// tiles and pickers. Img2Img source and ControlNet reference survive page switches (session store + IndexedDB).
import type {EditorInput} from '@/lib/editor';
import {controlKey,controlError,readControlFile,posePreprocessor,posePreprocessors,type ControlMap} from '@/lib/controlnet';
import {prepareSource,sizeFromSource,denoiseSteps,img2imgError} from '@/lib/img2img';
import {JobHistory} from './JobHistory';
import {RegionalControl} from './RegionalControl';
import {JobProgress,stageOf} from './JobProgress';
import {exportRegions} from '@/lib/regional';
import {localApi} from '@/lib/local-api';
import {useDirect,directFetch,imageFromDirect} from '@/lib/engine/direct';
import {useState,useRef,useEffect,useMemo,type ReactNode} from 'react';
import Link from 'next/link';
import {navigate} from '@/compat/navigation';
import {useStudio,defaults,type Parameters,type Preset,type LoRA} from '@/stores/studio';
import {useSession} from '@/stores/session';
import {api,type LiveEngine,type LiveModel} from '@/lib/engine/live';
import {Prompt,Slider,ImageUpload,downloadJSON,Tabs} from './Common';
import {LoraTagEditor} from './LoraTagEditor';
import {type LoraTags,joinTags,appendTags,selectedTags} from '@/lib/lora-tags';
import {Copy,RefreshCw,Plus,Trash2,Download,Boxes,Sparkles,ChevronRight,Ratio,Sliders,Image as ImageIcon,Search,Dice,Layers,Grid,Star,WandSparkles,Paintbrush,Smile,Check,X,Hourglass} from './icons';
import {Modal,PageHead,SectionTitle,toast,copyText,Mascot,Meter} from './ui';
import {useI18n,tr} from '@/i18n';
import {saveDraft,loadDraft,clearDraft,newImageId} from '@/lib/storage/drafts';
const ratios:[string,number,number][]=[['1:1',1024,1024],['3:4',768,1024],['4:3',1024,768],['9:16',576,1024],['16:9',1024,576]];
const SAMPLERS=['Euler','Euler a','DPM++ 2M'],SCHEDULERS=['Normal','Karras'];
export const TERMINAL=['COMPLETED','FAILED','CANCELLED','INTERRUPTED'];
export type LiveJob={terminal?:boolean;can_delete?:boolean;id:string;status:string;connection_error?:string;queue_position?:number;pending_jobs?:number;progress?:{elapsed_seconds?:number;eta_seconds?:number|null;percent?:number;step?:number;total_steps?:number;stage?:string};error?:string;result?:{image_keys?:string[];seed?:number}};
const fmtSize=(b:number|null)=>b===null?'—':b>1073741824?(b/1073741824).toFixed(2)+' GB':Math.round(b/1048576)+' MB';
const ratioLabel=(w:number,h:number)=>ratios.find(([,rw,rh])=>rw===w&&rh===h)?.[0]||`${w}×${h}`;
// v1.7.3: every model of a kind stays visible; incompatible ones are listed disabled with the engine's reason.
function ModelHealth({models}:{models:LiveModel[]}){
 const {t,locale}=useI18n();const direct=useDirect();const [busy,setBusy]=useState(false);const bad=models.filter(m=>m.compatible===false);const rejected=direct.models_rejected||[];
 const time=direct.models_updated_at?new Date(direct.models_updated_at).toLocaleTimeString(locale,{hour:'2-digit',minute:'2-digit'}):'';
 return <div className="stack tiny" style={{gap:6}}>
  <div className="row" style={{justifyContent:'space-between'}}><span className="muted">{models.length?t('models.count',{n:models.length})+(time?' · '+t('models.listFrom',{time}):''):t('models.emptyList')}</span><button type="button" className="pill" disabled={busy||!direct.url} onClick={async()=>{setBusy(true);try{await direct.refresh(true);const st=useDirect.getState();toast(st.models_error?'bad':'ok',st.models_error?t('models.notRefreshed',{err:st.models_error}):t('models.refreshed'))}finally{setBusy(false)}}}><RefreshCw size={14}/>{busy?t('models.refreshing'):t('models.refresh')}</button></div>
  {direct.url&&direct.models_error&&<div className="notice" role="alert">{t('models.notRefreshed',{err:direct.models_error})} {t('models.staleShown')}</div>}
  {bad.length>0&&<details><summary>{t('models.incompatible',{n:bad.length})}</summary><ul style={{margin:0,paddingLeft:18}}>{bad.map(m=><li key={m.id}><b>{m.name}</b> · {m.kind}{m.base_model?` · ${m.base_model}`:''}: {m.compatibility_reason||t('models.markedIncompatible')}</li>)}</ul></details>}
  {rejected.length>0&&<details><summary>{t('models.rejected',{n:rejected.length})}</summary><ul style={{margin:0,paddingLeft:18}}>{rejected.map((m,i)=><li key={i}><b>{m.name}</b>: {m.reason}</li>)}</ul></details>}
 </div>}
/** One model row; shows only real catalogue fields. */
export function ModelRow({m,on,onClick,right}:{m:LiveModel;on:boolean;onClick?:()=>void;right?:ReactNode}){
 const {t}=useI18n();
 return <button type="button" className={'px-row'+(on?' on':'')} aria-pressed={on} disabled={m.compatible===false} onClick={onClick}>
  <span className="thumb" aria-hidden><ImageIcon size={24}/></span>
  <span className="meta"><b title={m.name}>{m.name}</b><span>{m.architecture&&<span className="tag">{m.architecture}</span>}{m.base_model&&<span className="tag">{m.base_model}</span>}<span className={'tag '+(m.compatible===true?'ok':m.compatible===false?'bad':'warn')}>{m.compatible===true?t('models.compatible'):m.compatible===false?t('models.incompatibleShort'):t('models.unknownCompat')}</span></span>{m.compatible===false&&m.compatibility_reason&&<span className="tiny danger">{m.compatibility_reason}</span>}</span>
  <span className="side">{on&&<Check size={18}/>}{fmtSize(m.size_bytes)}{right}</span></button>;
}
/* ---------- pickers (07 · 08 · 09 of the concept) ---------- */
function ModelPicker({models,value,vae,onApply,onClose}:{models:LiveModel[];value:string;vae:string;onApply:(v:{checkpoint:string;vae:string})=>void;onClose:()=>void}){
 const {t}=useI18n();const [tab,setTab]=useState<'checkpoint'|'vae'>('checkpoint');const [q,setQ]=useState('');const [ck,setCk]=useState(value);const [v,setV]=useState(vae||'auto');const direct=useDirect();
 const list=models.filter(m=>m.kind===tab&&m.name.toLowerCase().includes(q.trim().toLowerCase()));
 return <Modal title={t('picker.modelTitle')} onClose={onClose} footer={<><button type="button" onClick={onClose}>{t('common.cancel')}</button><button type="button" className="primary" disabled={!ck&&tab==='checkpoint'&&!models.some(m=>m.kind==='checkpoint')} onClick={()=>{onApply({checkpoint:ck,vae:v});onClose()}}>{t('common.select')}</button></>}>
  <Tabs options={['checkpoint','vae']} value={tab} onChange={x=>setTab(x as 'checkpoint'|'vae')} labels={{checkpoint:'Checkpoints',vae:'VAE'}}/>
  <div className="row"><input className="grow" type="search" value={q} onChange={e=>setQ(e.target.value)} placeholder={t('picker.searchModels')} aria-label={t('picker.searchModels')}/><button type="button" className="icon" aria-label={t('models.refresh')} disabled={!direct.url} onClick={()=>void direct.refresh(true)}><RefreshCw size={18}/></button></div>
  <div className="px-list" role="listbox" aria-label={tab==='checkpoint'?'Checkpoints':'VAE'}>
   {tab==='vae'&&<button type="button" className={'px-row'+(v==='auto'?' on':'')} aria-pressed={v==='auto'} onClick={()=>setV('auto')}><span className="thumb" aria-hidden><Layers size={22}/></span><span className="meta"><b>{t('picker.vaeDefault')}</b><span className="tiny muted">{t('picker.vaeDefaultHint')}</span></span></button>}
   {list.map(m=><ModelRow key={m.id} m={m} on={tab==='checkpoint'?ck===m.id:v===m.id} onClick={()=>tab==='checkpoint'?setCk(m.id):setV(m.id)}/>)}
   {!list.length&&<div className="empty-models"><Boxes size={32}/><p>{models.length?t('picker.nothingFound'):t('picker.noModels')}</p>{!direct.url&&<Link href="/engine" className="btn">{t('gen.openGpu')}</Link>}</div>}
  </div>
 </Modal>;
}
function LoraPicker({models,value,onApply,onClose,onTags}:{models:LiveModel[];value:LoRA[];onApply:(l:LoRA[])=>void;onClose:()=>void;onTags:(x:{id:string;name:string})=>void}){
 const {t}=useI18n();const [q,setQ]=useState('');const [stack,setStack]=useState<LoRA[]>(value);
 const loras=models.filter(m=>m.kind==='lora'&&m.name.toLowerCase().includes(q.trim().toLowerCase()));
 const missing=stack.filter(l=>!models.some(m=>m.id===l.id));
 const toggle=(m:LiveModel)=>setStack(s=>s.some(l=>l.id===m.id)?s.filter(l=>l.id!==m.id):[...s,{id:m.id,name:m.name,trigger:'',weight:.8,enabled:true}]);
 const patch=(id:string,p:Partial<LoRA>)=>setStack(s=>s.map(l=>l.id===id?{...l,...p}:l));
 return <Modal title={t('picker.loraTitle')} onClose={onClose} footer={<><button type="button" onClick={onClose}>{t('common.cancel')}</button><button type="button" className="primary" onClick={()=>{onApply(stack);onClose()}}>{t('common.apply')}</button></>}>
  <input type="search" value={q} onChange={e=>setQ(e.target.value)} placeholder={t('picker.searchLora')} aria-label={t('picker.searchLora')}/>
  <div className="px-list">
   {loras.map(m=>{const l=stack.find(x=>x.id===m.id);return <div key={m.id} className={'card stack'+(l?' on':'')} style={{gap:6}}>
    <label className="row" style={{gap:10}}><input type="checkbox" checked={!!l} disabled={m.compatible===false&&!l} onChange={()=>toggle(m)} aria-label={m.name}/><span className="grow" style={{minWidth:0}}><b style={{display:'block',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{m.name}</b><span className="tag">LoRA</span>{m.architecture&&<span className="tag">{m.architecture}</span>}{m.compatible===false&&<span className="tag bad">{t('models.incompatibleShort')}</span>}{m.compatible===null&&<span className="tag warn">{t('models.unknownCompat')}</span>}</span><span className="tiny muted">{fmtSize(m.size_bytes)}</span></label>
    {l&&<><Slider label={'Weight '+m.name} caption={t('lora.weight')} min={0} max={2} step={.05} value={l.weight} onChange={weight=>patch(l.id,{weight})}/><div className="row"><label className="row tiny grow"><input type="checkbox" checked={l.enabled} onChange={e=>patch(l.id,{enabled:e.target.checked})}/>{t('lora.enabled')}</label><button type="button" className="pill" onClick={()=>onTags({id:m.id,name:m.name})}>{t('lora.tags')}</button></div></>}
   </div>})}
   {missing.length>0&&<div className="notice tiny">{t('picker.loraMissing')}: {missing.map(l=>l.name).join(', ')}</div>}
   {!loras.length&&<div className="empty-models"><Sparkles size={30}/><p>{models.some(m=>m.kind==='lora')?t('picker.nothingFound'):t('picker.noLora')}</p></div>}
  </div>
 </Modal>;
}
function ParamsModal({s,onApply,onClose,editing}:{s:Parameters;onApply:(p:Partial<Parameters>)=>void;onClose:()=>void;editing:boolean}){
 const {t}=useI18n();const [d,setD]=useState({width:s.width,height:s.height,steps:s.steps,cfg:s.cfg,sampler:s.sampler,scheduler:s.scheduler,seed:s.seed,randomSeed:s.randomSeed,batch:s.batch});
 const up=(p:Partial<typeof d>)=>setD(x=>({...x,...p}));
 return <Modal title={t('params.title')} onClose={onClose} footer={<><button type="button" onClick={onClose}>{t('common.cancel')}</button><button type="button" className="primary" onClick={()=>{onApply(d);onClose()}}>{t('common.apply')}</button></>}>
  {editing&&<div className="notice tiny">{t('params.editingNote')}</div>}
  <div className="field"><label>{t('params.aspect')}</label><div className="tile-grid" style={{gridTemplateColumns:'repeat(5,minmax(0,1fr))'}}>{ratios.map(([label,w,h])=>{const on=d.width===w&&d.height===h;return <button type="button" key={label} className={'pill'+(on?' selected':'')} aria-pressed={on} style={{flexDirection:'column',minHeight:62,padding:2}} onClick={()=>up({width:w,height:h})}><span aria-hidden style={{width:w/64,height:h/64,boxShadow:'inset 0 0 0 2px currentColor'}}/>{label}</button>})}</div></div>
  <div className="grid2 keep"><div className="field"><label>{t('params.width')}</label><input aria-label="Width" type="number" inputMode="numeric" min="256" max="1536" step="8" value={d.width} onChange={e=>up({width:Number(e.target.value)})}/></div><div className="field"><label>{t('params.height')}</label><input aria-label="Height" type="number" inputMode="numeric" min="256" max="1536" step="8" value={d.height} onChange={e=>up({height:Number(e.target.value)})}/></div></div>
  <Slider label="Steps" caption={t('params.steps')} min={1} max={60} step={1} value={d.steps} onChange={steps=>up({steps})}/>
  <Slider label="CFG Scale" caption="CFG" min={1} max={20} step={.5} value={d.cfg} onChange={cfg=>up({cfg})}/>
  <div className="grid2 keep"><div className="field"><label>Sampler</label><select aria-label="Sampler" value={d.sampler} onChange={e=>up({sampler:e.target.value})}>{SAMPLERS.map(x=><option key={x}>{x}</option>)}</select></div><div className="field"><label>Scheduler</label><select aria-label="Scheduler" value={d.scheduler} onChange={e=>up({scheduler:e.target.value})}>{SCHEDULERS.map(x=><option key={x}>{x}</option>)}</select></div></div>
  {d.sampler==='Euler a'&&d.scheduler==='Karras'&&<div className="notice dangernotice tiny">{t('params.eulerKarras')}</div>}
  <label className="px-switch"><span>{t('params.randomSeed')}</span><input type="checkbox" role="switch" checked={d.randomSeed} onChange={e=>up({randomSeed:e.target.checked})}/></label>
  <div className="row"><input className="grow" inputMode="numeric" aria-label="Seed" placeholder={t('params.seedPh')} disabled={d.randomSeed} value={d.seed} onChange={e=>up({seed:e.target.value.replace(/[^\d-]/g,'')})}/><button type="button" className="icon" aria-label={t('params.copySeed')} disabled={!d.seed} onClick={()=>void copyText(d.seed,t('toast.copied'),t('toast.copyFailed'))}><Copy size={16}/></button><button type="button" className="icon" aria-label={t('params.newSeed')} onClick={()=>up({randomSeed:false,seed:String(Math.floor(Math.random()*2147483647))})}><Dice size={16}/></button></div>
  {!editing&&<Slider label="Batch size" caption={t('params.batch')} min={1} max={2} step={1} value={d.batch} onChange={batch=>up({batch})}/>}
 </Modal>;
}
/** Concept tile: label + current value + chevron; opens a picker. */
function Tile({icon,label,value,onClick,empty}:{icon:ReactNode;label:string;value:ReactNode;onClick:()=>void;empty?:boolean}){return <button type="button" className={'tile'+(empty?' is-empty':'')} onClick={onClick}><span className="tile-label">{icon}{label}</span><span className="tile-value"><span>{value}</span><ChevronRight size={16}/></span></button>}
/** The main action button: its label and fill always come from the submitted job, never from a timer. */
function HeroButton({sending,job,onClick,mode,disabled}:{sending:boolean;job:LiveJob|null;onClick:()=>void;mode:string;disabled?:boolean}){
 const {t,tv}=useI18n();const active=!!job&&!TERMINAL.includes(job.status);const prev=useRef<string|undefined>(job?.status);const [flash,setFlash]=useState<'done'|'error'|''>('');
 useEffect(()=>{const before=prev.current;prev.current=job?.status;if(!job||!before||before===job.status||TERMINAL.includes(before))return;if(job.status==='COMPLETED'){setFlash('done');toast('ok',t('gen.doneToast'))}else if(TERMINAL.includes(job.status)){setFlash('error');if(job.status==='FAILED')toast('bad',job.error||t('gen.failedToast'))}const id=setTimeout(()=>setFlash(''),2600);return()=>clearTimeout(id)},[job?.status]);// eslint-disable-line react-hooks/exhaustive-deps
 const main=({inpaint:t('gen.applyInpaint'),facefix:t('gen.applyFaceFix'),img2img:t('gen.runImg2Img')} as Record<string,string>)[mode]||t('gen.generate');
 const stage=job?stageOf(job):'';const p=job?.progress;
 const state=sending||active?'busy':flash||'idle';
 return <button type="button" className="hero-btn" data-state={state} aria-busy={state==='busy'} disabled={disabled||sending} onClick={onClick} data-testid="generate-button">
  {state==='busy'&&<span className="hero-fill" style={{'--p':(sending?6:Math.max(4,p?.percent??0))+'%'} as React.CSSProperties} aria-hidden/>}
  <span className="hero-spark l" aria-hidden/><span className="hero-spark r" aria-hidden/>
  <span className="hero-main">{state==='busy'?<Hourglass size={26}/>:state==='done'?<Check size={26}/>:state==='error'?<X size={26}/>:<ImageIcon size={26}/>}{sending?t('gen.sending'):active?tv('stage',stage):state==='done'?t('gen.done'):state==='error'?t('gen.failed'):main}</span>
  {state==='busy'&&!sending&&<span className="hero-sub">{p?.total_steps?`${p.step??0}/${p.total_steps} · ${p.percent??0}%`:job?.status==='QUEUED'?t('gen.queuePos',{n:job.queue_position??'—'}):''}{' · '+t('gen.tapToQueue')}</span>}
 </button>;
}
export function GenerationControls({currentJob,setCurrentJob,lockedMode,editorInput}:{editorInput?:()=>Promise<EditorInput>;compact?:boolean;lockedMode?:Parameters['mode']|'inpaint'|'facefix';currentJob:LiveJob|null;setCurrentJob:(job:LiveJob|null)=>void}){
 const {t}=useI18n();
 const stored=useStudio(x=>x.settings),updateSettings=useStudio(x=>x.update),faceSize=useStudio(x=>x.editor.faceRegion),setFaceRegion=useStudio(x=>x.setFaceRegion);
 const faceEditing=lockedMode==='facefix';const s=faceEditing?{...stored,width:faceSize.width,height:faceSize.height}:stored;
 const update=(partial:Partial<Parameters>)=>{if(faceEditing){const {width,height,...rest}=partial;if(width!==undefined||height!==undefined)setFaceRegion({width:width??faceSize.width,height:height??faceSize.height});if(Object.keys(rest).length)updateSettings(rest)}else updateSettings(partial)};
 const mode=lockedMode??s.mode;const editing=mode==='inpaint'||mode==='facefix';
 const submitting=useRef(false);const [sending,setSending]=useState(false);const [notice,setNotice]=useState('');const [processing,setProcessing]=useState(false);
 const [picker,setPicker]=useState<''|'model'|'lora'|'params'>('');
 // Img2Img source and ControlNet reference: session store (page switches) + IndexedDB draft (reload).
 const session=useSession();const source=session.img2img.file,controlFile=session.control.file,controlMap=session.controlMap,setControlMap=session.setControlMap,revision=session.controlRevision,prepared=session.controlPrepared;
 const setPrepared=(v:boolean)=>session.setControl({controlPrepared:v});
 useEffect(()=>{for(const slot of ['img2img','control'] as const){if(useSession.getState()[slot].restored)continue;useSession.getState().setSource(slot,{restored:true});void loadDraft(slot).then(d=>{if(d&&!useSession.getState()[slot].file)useSession.getState().setSource(slot,{file:new File([d.blob],d.name,{type:d.type}),imageId:d.imageId})})}},[]);
 const preview=useMemo(()=>source?URL.createObjectURL(source):null,[source]);useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview)},[preview]);
 const controlPreview=useMemo(()=>controlFile?URL.createObjectURL(controlFile):null,[controlFile]);useEffect(()=>()=>{if(controlPreview)URL.revokeObjectURL(controlPreview)},[controlPreview]);
 const [sourceSize,setSourceSize]=useState<{width:number;height:number}|null>(null);
 useEffect(()=>{setSourceSize(null);if(!source)return;let live=true;createImageBitmap(source).then(b=>{if(live)setSourceSize({width:b.width,height:b.height});b.close()}).catch(()=>{});return()=>{live=false}},[source]);
 const processRevision=useRef(0);const poseChoice=posePreprocessor(s.controlType,s.controlPreprocessor);const poseSource=prepared?'':poseChoice;const mapKey=controlKey(s.controlType,s.width,s.height,prepared,revision,poseSource);
 useEffect(()=>{processRevision.current++;setProcessing(false);const m=useSession.getState().controlMap;if(m&&m.key!==mapKey)setControlMap(null)},[mapKey]);// eslint-disable-line react-hooks/exhaustive-deps
 const save=(f:File,kind:'source'|'control')=>{const imageId=newImageId();if(kind==='source'){session.setSource('img2img',{file:f,imageId});void saveDraft('img2img',imageId,f,f.name).catch(()=>toast('warn',t('draft.notSaved')))}else{session.setSource('control',{file:f,imageId});session.setControl({controlRevision:revision+1});setControlMap(null);void saveDraft('control',imageId,f,f.name).catch(()=>toast('warn',t('draft.notSaved')))}};
 const [tagMap,setTagMap]=useState<Record<string,LoraTags>>({});const [tagEdit,setTagEdit]=useState<{id:string;name:string}|null>(null);const direct=useDirect();const [engines,setEngines]=useState<LiveEngine[]>([]);const [selectedEngine,setSelectedEngine]=useState('');
 useEffect(()=>{if(direct.url){setEngines([{id:'direct',state:direct.state,provider:direct.provider==='cloudcompute'?'CloudCompute':'Colab Tunnel',models:direct.models,telemetry:{gpu_name:direct.info?.gpu_name||undefined,vram_total_mb:direct.info?.vram_total_mb||undefined,vram_available_mb:direct.info?.vram_available_mb||undefined}}]);setSelectedEngine('direct')}else{setEngines([]);setSelectedEngine('')}},[direct.url,direct.state,direct.models,direct.info]);
 useEffect(()=>{let live=true;api<{items:LoraTags[]}>('lora-tags').then(x=>{if(live)setTagMap(Object.fromEntries(x.items.map(m=>[m.model_id,m])))}).catch(()=>{});return()=>{live=false}},[]);
 const preprocessControl=async()=>{if(!controlFile){setNotice(t('cn.uploadFirst'));return}const ticket=++processRevision.current;const key=mapKey;setProcessing(true);setControlMap(null);setNotice('');try{const image=await readControlFile(controlFile);const body=JSON.stringify({image,type:s.controlType,prepared,width:s.width,height:s.height,...(poseSource?{preprocessor:poseSource}:{})});const request=()=>directFetch<ControlMap&{status?:string}>(direct.url,direct.token,'controlnet/preprocess',{method:'POST',body});let result=await request();/* AUD-006: the engine keeps working and answers PENDING; repeat the identical request to resume it. */while(result.status==='PENDING'&&ticket===processRevision.current)result=await request();if(ticket===processRevision.current){setControlMap({...result,key});toast('ok',t('cn.ready'))}}catch(e){if(ticket===processRevision.current)setNotice((e as Error).message)}finally{if(ticket===processRevision.current)setProcessing(false)}};
 const engine=engines.find(e=>e.id===selectedEngine);const models=engine?.models||[];
 useEffect(()=>{if(!currentJob||TERMINAL.includes(currentJob.status))return;let active=true;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const next=await directFetch<LiveJob>(direct.url,direct.token,'jobs/'+encodeURIComponent(currentJob.id));if(active){setCurrentJob(next);if(next.connection_error)setNotice(next.connection_error)}}catch(e){if(active)setNotice((e as Error).message)}if(active)timer=setTimeout(poll,3000)};timer=setTimeout(poll,1000);return()=>{active=false;clearTimeout(timer)}},[currentJob?.id,currentJob?.status]);// eslint-disable-line react-hooks/exhaustive-deps
 const invalid=(editing&&s.batch!==1)||!s.prompt.trim()||(s.sampler==='Euler a'&&s.scheduler==='Karras')||!Number.isFinite(s.width)||!Number.isFinite(s.height)||s.width<256||s.height<256||s.width>1536||s.height>1536||s.width%8!==0||s.height%8!==0||s.steps<1||s.steps>60||s.cfg<1||s.cfg>20||s.batch<1||s.batch>2||!SAMPLERS.includes(s.sampler)||!SCHEDULERS.includes(s.scheduler)||(!s.randomSeed&&(!Number.isInteger(Number(s.seed))||Number(s.seed)<0||Number(s.seed)>2147483647))||s.width*s.height*s.batch>2097152||(mode==='img2img'&&!!img2imgError(s.steps,s.denoise));
 const submit=async()=>{if(submitting.current)return;if(invalid){setNotice(t('gen.fixParams'));toast('bad',t('gen.fixParams'));return}if(mode==='img2img'&&!source){setNotice(t('gen.needSource'));return}if(!engine||!direct.url||!['READY','BUSY'].includes(direct.state)){setNotice(t('gen.gpuOffline'));toast('bad',t('gen.gpuOffline'));return}if(!s.checkpoint){setNotice(t('gen.needCheckpoint'));setPicker('model');return}if(editing&&(s.controlEnabled||s.regional.regions.some(r=>r.enabled)&&s.regional.mode!=='OFF')){setNotice(t('gen.editNoControl'));return}if(editing&&direct.info?.capabilities?.[mode]!==true){setNotice(t('gen.engineTooOld'));return}const controlProblem=editing?'':controlError(s,controlMap,mapKey,exportRegions(s.regional,s.width,s.height).some(r=>r.enabled));if(controlProblem){setNotice(controlProblem);return}
  try{submitting.current=true;setSending(true);setNotice('');const edit=editing?await editorInput?.():undefined;if(editing&&!edit)throw Error(t('gen.needRegion'));const body={engine_id:engine.id,request:{client_request_id:crypto.randomUUID(),regions:editing?[]:exportRegions(s.regional,s.width,s.height),kind:mode,mode,prompt:s.prompt,negative_prompt:s.negative,checkpoint_id:s.checkpoint,vae_id:s.vae||'auto',lora_adapters:s.loras.filter(l=>l.enabled).map(l=>({id:l.id,weight:l.weight})),width:s.width,height:s.height,steps:s.steps,cfg_scale:s.cfg,sampler:s.sampler,scheduler:s.scheduler,seed:s.randomSeed?-1:Number(s.seed),batch_size:s.batch,controlnet_config:!editing&&s.controlEnabled?{enabled:true,type:s.controlType,map_type:controlMap!.type,...(controlMap!.preprocessor?{preprocessor:controlMap!.preprocessor}:{}),image:controlMap!.image,strength:s.controlStrength,start:s.controlStart,end:s.controlEnd}:{enabled:false},...(mode==='img2img'?{init_image:await prepareSource(source!,s.width,s.height),denoising_strength:s.denoise}:{}),...(edit||{})}};const job=await directFetch<{id:string;status:string}>(direct.url,direct.token,'generate',{method:'POST',body:JSON.stringify(body.request)});setCurrentJob(job);toast('info',t('gen.accepted'))}catch(e){setNotice((e as Error).message);toast('bad',(e as Error).message)}finally{submitting.current=false;setSending(false)}};
 const checkpoint=models.find(m=>m.id===s.checkpoint);const activeLoras=s.loras.filter(l=>l.enabled);
 return <div className="stack">
  {mode==='img2img'&&<section className="panel stack"><SectionTitle icon={<ImageIcon size={20}/>}>{t('i2i.source')}</SectionTitle>
   <div className="row"><ImageUpload onFile={f=>save(f,'source')} label={source?t('i2i.replace'):t('i2i.choose')}/>{source&&<button type="button" className="danger" onClick={()=>{session.setSource('img2img',{file:null,imageId:''});void clearDraft('img2img')}}><Trash2 size={16}/>{t('common.remove')}</button>}</div>
   {preview&&<img src={preview} alt={t('i2i.sourceAlt')} style={{width:'100%',maxHeight:230,objectFit:'contain',background:'#000'}}/>}
   {sourceSize&&<div className="row"><span className="tiny muted grow">{t('i2i.sizeNote',{sw:sourceSize.width,sh:sourceSize.height,w:s.width,h:s.height})}</span><button type="button" onClick={()=>update(sizeFromSource(sourceSize.width,sourceSize.height))}>{t('i2i.fitSource')}</button></div>}
   <Slider label="Denoise strength" caption={t('i2i.denoise')} min={.05} max={1} step={.05} value={s.denoise} onChange={denoise=>update({denoise})}/>
   <span className="tiny muted">{t('i2i.denoiseNote',{n:denoiseSteps(s.steps,s.denoise),total:s.steps})}</span>
   {img2imgError(s.steps,s.denoise)&&<div className="notice dangernotice">{img2imgError(s.steps,s.denoise)}</div>}
  </section>}
  <section className="panel stack">
   <Prompt label="Positive Prompt" value={s.prompt} onChange={prompt=>update({prompt})}/>
   {activeLoras.length>0&&<div className="card stack" style={{gap:6}}><h3 className="px-section-title"><Sparkles size={16}/>{t('lora.activeTags')}</h3>{activeLoras.map(l=>{const meta=tagMap[l.id];const tags=meta?joinTags([meta]):[];return <div key={l.id} className="stack" style={{gap:4}}><div className="row" style={{justifyContent:'space-between'}}><b className="tiny">{l.name}</b><div className="row"><button type="button" className="pill" onClick={()=>setTagEdit({id:l.id,name:l.name})}>{t('lora.tags')}</button><button type="button" className="pill" disabled={!tags.length} onClick={()=>void copyText(tags.join(', '),t('lora.tagsCopied'),t('toast.copyFailed'))}>{t('common.copy')}</button></div></div><p className="tiny muted" style={{overflowWrap:'anywhere'}}>{tags.join(', ')||t('lora.noTags')}</p></div>})}
    <div className="row"><button type="button" onClick={()=>void copyText(joinTags(selectedTags(s.loras,tagMap)).join(', '),t('lora.allCopied'),t('toast.copyFailed'))}>{t('lora.copyAll')}</button><button type="button" className="primary" onClick={()=>{update({prompt:appendTags(s.prompt,joinTags(selectedTags(s.loras,tagMap)))});toast('ok',t('lora.inserted'))}}>{t('lora.insert')}</button></div></div>}
   <Prompt label="Negative Prompt" value={s.negative} onChange={negative=>update({negative})}/>
  </section>
  <section className="panel stack">
   <div className="tile-grid">
    <Tile icon={<Boxes size={16}/>} label={t('tile.model')} value={checkpoint?.name||(s.checkpoint?t('tile.modelMissing'):t('tile.choose'))} empty={!checkpoint} onClick={()=>setPicker('model')}/>
    <Tile icon={<Sparkles size={16}/>} label="LoRA" value={activeLoras.length?activeLoras.length===1?activeLoras[0].name:t('tile.loraN',{n:activeLoras.length}):t('tile.none')} empty={!activeLoras.length} onClick={()=>setPicker('lora')}/>
   </div>
   <div className="tile-grid three">
    <Tile icon={<Ratio size={16}/>} label={t('tile.aspect')} value={ratioLabel(s.width,s.height)} onClick={()=>setPicker('params')}/>
    <Tile icon={<Sliders size={16}/>} label={t('params.steps')} value={s.steps} onClick={()=>setPicker('params')}/>
    <Tile icon={<Grid size={16}/>} label="CFG" value={s.cfg} onClick={()=>setPicker('params')}/>
   </div>
   <div className="tile-grid">
    <Tile icon={<Star size={16}/>} label="Sampler" value={s.sampler} onClick={()=>setPicker('params')}/>
    <Tile icon={<Layers size={16}/>} label="Scheduler" value={s.scheduler} onClick={()=>setPicker('params')}/>
   </div>
   <div className="row tiny muted" style={{justifyContent:'space-between'}}><span>{s.width} × {s.height} · {s.randomSeed?t('tile.seedRandom'):'Seed '+s.seed}{!editing?' · Batch '+s.batch:''}{s.vae&&s.vae!=='auto'?' · VAE: '+(models.find(m=>m.id===s.vae)?.name||s.vae):''}</span></div>
   {s.loras.length>0&&<div className="stack" style={{gap:6}}>{s.loras.map(l=><div className={'card stack'+(l.enabled?' on':'')} style={{gap:4}} key={l.id}><div className="row"><label className="row grow tiny" style={{minWidth:0}}><input type="checkbox" checked={l.enabled} onChange={e=>update({loras:s.loras.map(x=>x.id===l.id?{...x,enabled:e.target.checked}:x)})} aria-label={t('lora.enable',{name:l.name})}/><b style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{l.name}</b></label><button type="button" className="pill" onClick={()=>setTagEdit({id:l.id,name:l.name})}>{t('lora.tags')}</button><button type="button" aria-label={t('lora.remove',{name:l.name})} className="pill icon danger" onClick={()=>update({loras:s.loras.filter(x=>x.id!==l.id)})}><Trash2 size={15}/></button></div><Slider label={'Strength '+l.name} caption={t('lora.weight')} min={0} max={2} step={.05} value={l.weight} onChange={weight=>update({loras:s.loras.map(x=>x.id===l.id?{...x,weight}:x)})}/></div>)}{s.loras.length>1&&<div className="notice tiny">{t('lora.comboNote')}</div>}</div>}
   <ModelHealth models={models}/>
   {(s.width*s.height>1024*1024||s.batch>1)&&<div className="notice tiny">{t('gen.vramNote')}</div>}
   {editing&&<div className="notice tiny">{t('gen.editingRes')}</div>}
  </section>
  {!editing&&<details className="panel"><summary className="h-spark">ControlNet{s.controlEnabled?' · '+s.controlType:''}</summary><div className="stack" style={{marginTop:8}}>
   <label className="px-switch"><span>{t('cn.enable')}</span><input type="checkbox" role="switch" checked={s.controlEnabled} onChange={e=>update({controlEnabled:e.target.checked})}/></label>
   <div className="field"><label>{t('cn.type')}</label><select aria-label="Control type" value={s.controlType} onChange={e=>update({controlType:e.target.value})}>{['OpenPose','Canny','Depth'].map(x=><option key={x}>{x}</option>)}</select></div>
   {s.controlType==='OpenPose'&&<div className="field"><label>{t('cn.pose')}</label><select aria-label={t('cn.pose')} value={poseChoice} disabled={prepared} onChange={e=>update({controlPreprocessor:e.target.value})}>{posePreprocessors.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>}
   <div className="row"><ImageUpload label={controlFile?t('cn.replaceRef'):t('cn.reference')} onFile={f=>save(f,'control')}/>{controlFile&&<button type="button" className="danger" onClick={()=>{session.setSource('control',{file:null,imageId:''});setControlMap(null);void clearDraft('control')}}><Trash2 size={16}/>{t('common.remove')}</button>}</div>
   {controlPreview&&<img src={controlPreview} alt={t('cn.refAlt')} style={{maxHeight:180,maxWidth:'100%',objectFit:'contain',alignSelf:'center'}}/>}
   <label className="row tiny"><input type="checkbox" checked={prepared} onChange={e=>setPrepared(e.target.checked)}/>{t('cn.prepared')}</label>
   <p className="tiny muted">{s.controlType==='OpenPose'?(poseSource==='sdpose'?t('cn.sdposeNote'):t('cn.openposeNote')):s.controlType==='Canny'?t('cn.cannyNote'):t('cn.depthNote')}</p>
   <button type="button" className={processing?'is-loading':''} disabled={processing||!controlFile} onClick={preprocessControl}>{processing?t('cn.preparing'):t('cn.prepare')}</button>
   {controlMap?.key===mapKey&&<img src={controlMap.image} alt={t('cn.mapAlt',{type:controlMap.type})} style={{maxHeight:180,maxWidth:'100%',objectFit:'contain',alignSelf:'center'}}/>}
   <Slider label="Control strength" caption={t('cn.strength')} min={0} max={2} step={.05} value={s.controlStrength} onChange={controlStrength=>update({controlStrength})}/>
   <div className="grid2 keep"><Slider label="Start" caption={t('cn.start')} min={0} max={1} step={.05} value={s.controlStart} onChange={controlStart=>update({controlStart})}/><Slider label="End" caption={t('cn.end')} min={0} max={1} step={.05} value={s.controlEnd} onChange={controlEnd=>update({controlEnd})}/></div>
  </div></details>}
  {!editing&&<RegionalControl value={s.regional} onChange={regional=>update({regional})} models={models} width={s.width} height={s.height}/>}
  {!editing&&<Presets/>}
  {tagEdit&&<LoraTagEditor id={tagEdit.id} name={tagEdit.name} onClose={()=>setTagEdit(null)} onSaved={x=>{setTagMap(old=>({...old,[x.model_id]:x}));toast('ok',t('lora.tagsSaved'))}}/>}
  {picker==='model'&&<ModelPicker models={models} value={s.checkpoint} vae={s.vae} onApply={v=>update(v)} onClose={()=>setPicker('')}/>}
  {picker==='lora'&&<LoraPicker models={models} value={s.loras} onApply={loras=>update({loras})} onClose={()=>setPicker('')} onTags={x=>setTagEdit(x)}/>}
  {picker==='params'&&<ParamsModal s={s} editing={editing} onApply={update} onClose={()=>setPicker('')}/>}
  <section className="stack" style={{gap:8}}>
   {engines.length>0&&<div className="row tiny"><label className="muted" htmlFor="gpu-select">GPU</label><select id="gpu-select" className="grow" value={selectedEngine} onChange={e=>setSelectedEngine(e.target.value)}><option value="">{t('gen.chooseGpu')}</option>{engines.map(e=><option key={e.id} value={e.id}>{e.provider} · {e.state}</option>)}</select></div>}
   <HeroButton sending={sending} job={currentJob} mode={mode} onClick={submit}/>
   {notice&&<div className={'notice '+(invalid||/GPU/.test(notice)?'dangernotice':'')} role="status">{notice} {!invalid&&!direct.url&&<Link href="/engine" style={{fontWeight:700}}>{t('gen.openGpu')} ›</Link>}</div>}
   {invalid&&<div className="notice dangernotice tiny">{t('gen.limits')}</div>}
   {currentJob&&<div className="card stack"><JobProgress job={currentJob}/>{currentJob.status==='COMPLETED'&&currentJob.result?.image_keys?.map((_,i)=><DirectImage key={i} job={currentJob.id} index={i}/>)}{!TERMINAL.includes(currentJob.status)&&<button type="button" className="danger" onClick={async()=>{try{const result=await directFetch<{status:string}>(direct.url,direct.token,'jobs/'+encodeURIComponent(currentJob.id),{method:'DELETE'});setCurrentJob({...currentJob,status:result.status});toast('info',t('gen.cancelSent'))}catch(e){setNotice((e as Error).message)}}}><X size={16}/>{t('gen.cancelJob')}</button>}</div>}
   <span className="tiny muted" style={{textAlign:'center'}}>{t('gen.autosave')}</span>
  </section>
 </div>;
}
function Presets(){const {t}=useI18n();const st=useStudio(),[name,setName]=useState('');const inp=useRef<HTMLInputElement>(null);
 return <details className="panel"><summary className="h-spark">{t('presets.title')} ({st.presets.length})</summary><div className="stack" style={{marginTop:8}}>
  <div className="row"><input className="grow" aria-label={t('presets.name')} placeholder={t('presets.name')} value={name} onChange={e=>setName(e.target.value)}/><button type="button" disabled={!name.trim()} onClick={()=>{if(name.trim()){st.save(name.trim());setName('');toast('ok',t('presets.saved'))}}}><Plus size={16}/>{t('common.save')}</button></div>
  {st.presets.map(p=><div key={p.id} className="card row"><span className="grow" style={{fontSize:13,overflowWrap:'anywhere'}}>{p.name}</span><button type="button" className="pill" onClick={()=>{st.load(p.id);toast('ok',t('presets.loaded',{name:p.name}))}}>{t('presets.load')}</button><button type="button" className="pill" onClick={()=>{const n=prompt(t('presets.renamePrompt'),p.name);if(n?.trim())st.rename(p.id,n.trim())}}>{t('common.rename')}</button><button type="button" className="pill" onClick={()=>st.duplicate(p.id)}>{t('common.copy')}</button><button type="button" className="pill icon" aria-label={t('presets.export')} onClick={()=>downloadJSON(p,p.name.replace(/[^a-z0-9_-]/gi,'_')+'.json')}><Download size={15}/></button><button type="button" className="pill icon danger" aria-label={t('presets.delete')} onClick={()=>{if(confirm(t('presets.deleteConfirm')))st.remove(p.id)}}><Trash2 size={15}/></button></div>)}
  <p className="tiny muted">{t('presets.loadNote')}</p>
  <div className="row"><button type="button" onClick={()=>inp.current?.click()}>{t('presets.import')}</button><button type="button" onClick={()=>{if(confirm(t('presets.resetConfirm'))){st.reset();toast('ok',t('presets.reset'))}}}>{t('presets.restore')}</button></div>
  <input ref={inp} hidden type="file" accept=".json,application/json" onChange={async e=>{try{const f=e.target.files?.[0];if(!f)return;if(f.size>200000)throw Error(t('presets.tooLarge'));const p=JSON.parse(await f.text()) as Preset;if(p.version!==1||typeof p.name!=='string'||!p.name.trim()||!p.settings||typeof p.settings.prompt!=='string'||!Number.isInteger(p.settings.width)||p.settings.width<256||p.settings.width>1536||!Array.isArray(p.settings.loras))throw Error(t('presets.malformed'));st.addPreset({...p,settings:{...defaults,...p.settings}});toast('ok',t('presets.imported'))}catch(err){toast('bad',(err as Error).message)}e.target.value=''}}/>
 </div></details>}
export function Generator(){
 const {t,tv}=useI18n();const historyRevision=useRef(0);
 const s=useStudio(x=>x.settings),update=useStudio(x=>x.update),setEditor=useStudio(x=>x.setEditor);
 const job=useSession(x=>x.jobs.generate),setJobRaw=useSession(x=>x.setJob);
 const setJob=(v:LiveJob|null|((old:LiveJob|null)=>LiveJob|null))=>setJobRaw('generate',typeof v==='function'?v(useSession.getState().jobs.generate):v);
 const [history,setHistory]=useState<LiveJob[]>([]),[historyError,setHistoryError]=useState('');
 useEffect(()=>{let live=true;let timer:ReturnType<typeof setTimeout>;const refresh=async()=>{const revision=historyRevision.current;try{const x=await localApi<{items:LiveJob[]}>('/api/history');if(live&&revision===historyRevision.current){setHistory(x.items);setHistoryError('');setJob(old=>old?x.items.find(j=>j.id===old.id)||null:x.items[0]||null)}}catch(e){if(live)setHistoryError((e as Error).message)}if(live)timer=setTimeout(refresh,2000)};void refresh();return()=>{live=false;clearTimeout(timer)}},[]);// eslint-disable-line react-hooks/exhaustive-deps
 const preview=job?.status==='COMPLETED'?job:history.find(j=>j.status==='COMPLETED');const running=history.find(j=>j.status==='RUNNING'&&!j.connection_error);
 const modeTabs={text:t('gen.tabGenerate'),img2img:'Img2Img',inpaint:'Inpaint',facefix:'Face Fix'};
 return <div className="page stack"><PageHead icon={<WandSparkles size={24}/>} title={t('nav.generate')} detail={t('gen.detail')}/>
  <Tabs options={['text','img2img','inpaint','facefix']} value={s.mode==='img2img'?'img2img':'text'} fit labels={modeTabs} onChange={v=>{if(v==='text')update({mode:'text2img'});else if(v==='img2img')update({mode:'img2img'});else{setEditor({mode:v==='inpaint'?'INPAINT':'FACE FIX',classic:false});navigate('/edit')}}}/>
  <div className="generator"><GenerationControls currentJob={job} setCurrentJob={setJob}/>
   <div className="stack gen-side">
    <section className="panel stack"><SectionTitle icon={<ImageIcon size={20}/>} right={<span className="status" data-tone={job?.status==='COMPLETED'?'ok':job?.status==='FAILED'?'bad':job?'warn':'idle'}>{job?tv('status',job.status):t('status.none')}</span>}>{t('gen.preview')}</SectionTitle>
     <div className="preview" style={{aspectRatio:`${Math.max(1,s.width)}/${Math.max(1,s.height)}`,maxHeight:560}}>{preview?.result?.image_keys?.length?<DirectImage job={preview.id} index={0} preview/>:<div className="placeholder"><Mascot size={84} alt=""/><h3>{t('gen.previewEmpty')}</h3><p className="tiny">{job?.status?t('gen.taskStatus',{s:tv('status',job.status)}):t('gen.previewHint')}</p></div>}</div>
     <div className="row tiny muted"><span>{s.width} × {s.height} · {s.steps} {t('params.stepsShort')} · CFG {s.cfg}</span><span className="count">{preview?t('gen.savedResult'):t('gen.noImage')}</span></div>
     {preview?.result?.image_keys?.length?<DirectImage job={preview.id} index={0}/>:null}
    </section>
    <section className="panel stack"><SectionTitle icon={<Hourglass size={20}/>}>{t('queue.title')}</SectionTitle>
     <div className="grid2 keep tiny"><span>{t('queue.total')}: <b>{history.length}</b></span><span>{t('queue.waiting')}: <b>{history.filter(j=>j.status==='QUEUED').length}</b></span><span>{t('queue.done')}: <b className="ok-text">{history.filter(j=>j.status==='COMPLETED').length}</b></span><span>{t('queue.failed')}: <b className="danger">{history.filter(j=>j.status==='FAILED').length}</b></span></div>
     <div className="tiny muted">{t('queue.active')}: {historyError?t('queue.lost'):running?.id.slice(0,8)||t('queue.noneConfirmed')}</div>
     {running?.progress?.percent!=null&&<Meter value={running.progress.percent} label={t('queue.active')}/>}
     <JobHistory items={history} error={historyError} onSelect={setJob} onMutation={()=>{historyRevision.current++}} onChange={items=>{historyRevision.current++;setHistory(items);setJob(old=>old?items.find(j=>j.id===old.id)||null:null)}}/></section>
   </div></div>
 </div>;
}
export function DirectImage({job,index,preview=false}:{job:string;index:number;preview?:boolean}){
 const {t}=useI18n();const url=useDirect(x=>x.url),token=useDirect(x=>x.token),[src,setSrc]=useState(''),[error,setError]=useState('');
 useEffect(()=>{let active=true;let blob='';setError('');imageFromDirect(url,token,job,index).then(v=>{blob=v;if(active)setSrc(v);else URL.revokeObjectURL(v)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false;if(blob.startsWith('blob:'))URL.revokeObjectURL(blob)}},[url,token,job,index]);
 if(error)return <span role="alert" className="tiny danger">{error}</span>;if(!src)return <span className="tiny muted">{t('common.loadingImage')}</span>;
 return preview?<img src={src} alt={t('gen.resultAlt')} style={{height:'100%',width:'100%',objectFit:'contain'}}/>:<a className="btn" href={src} download={`yoisaki-${job}-${index}.png`}><Download size={16}/>{t('gen.download',{n:index+1})}</a>;
}
// Kept for callers that still import tr-based labels from this module.
export const generateLabel=()=>tr('gen.generate');

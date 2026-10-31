'use client';
// v1.8.1 SMART FACE FIX flow (upload → automatic detection → choose → Fix Face → compare → save), unchanged.
// v1.9.0: image, detection, selection, manual box, job and result live in the session store + IndexedDB draft;
// strength and the detection/mask/generation profile live in the persisted studio store.
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {ImageUpload,Slider,Prompt} from './Common';
import {JobProgress} from './JobProgress';
import {TERMINAL,type LiveJob} from './Generator';
import {useStudio} from '@/stores/studio';
import {useSession,type FaceFixSlot} from '@/stores/session';
import {useDirect,directFetch,imageFromDirect} from '@/lib/engine/direct';
import {normalizedImage,boundedBox,type Box} from '@/lib/editor';
import {visibleFaces,initialSelection,hitFace,profileError,faceFixRequest,autoFeather,type Detection,type FaceProfile,type Detector} from '@/lib/facefix';
import {downloadBlob} from '@/lib/storage/gallery';
import {saveDraft,loadDraft,clearDraft,newImageId,draftDataWriter} from '@/lib/storage/drafts';
import {Smile,Download,ScanSearch,Lasso,X,Cpu} from './icons';
import {SectionTitle,toast,EmptyState} from './ui';
import {useI18n} from '@/i18n';
type FaceData={detection:Detection|null;selected:string[];manual:boolean;box:Box|null;job:LiveJob|null;result:string};
const writeData=draftDataWriter('facefix');
export function FaceFix({onClassic}:{onClassic:()=>void}){
 const {t}=useI18n();
 const s=useStudio(x=>x.settings),updateSettings=useStudio(x=>x.update);
 const prefs=useStudio(x=>x.editor.faceFix),setFaceFix=useStudio(x=>x.setFaceFix);
 const profile:FaceProfile={...prefs.profile,sampler:prefs.profile.sampler||s.sampler,scheduler:prefs.profile.scheduler||s.scheduler};
 const strength=prefs.strength,showUncertain=prefs.showUncertain;
 const set=(x:Partial<FaceProfile>)=>setFaceFix({profile:x});
 const setStrength=(v:number)=>setFaceFix({strength:v});const setShowUncertain=(v:boolean)=>setFaceFix({showUncertain:v});
 const st=useSession(x=>x.facefix);const setSt=useSession(x=>x.setFaceFix);
 const image=st.img?.image||null,name=st.img?.name||'',detection=st.detection,selected=st.selected,manual=st.manual,box=st.box,job=st.job,result=st.result;
 const setDetection=(d:Detection|null)=>setSt({detection:d});const setSelected=(v:string[]|((o:string[])=>string[]))=>setSt(x=>({selected:typeof v==='function'?v(x.selected):v}));
 const setManual=(v:boolean)=>setSt({manual:v});const setBox=(b:Box|null)=>setSt({box:b});const setJob=(j:LiveJob|null)=>setSt({job:j});const setResult=(r:string)=>setSt({result:r});
 const direct=useDirect();
 const caps=direct.info?.capabilities||{};
 const connected=!!direct.url&&['READY','BUSY'].includes(direct.state);
 const auto=connected&&caps.auto_facefix===true&&caps.face_detect_contract===1;
 const legacy=connected&&!auto&&caps.facefix===true;
 const [detecting,setDetecting]=useState(false),[advanced,setAdvanced]=useState(false),[compare,setCompare]=useState(50),[status,setStatus]=useState(''),[sending,setSending]=useState(false);
 const revision=useRef(0),wrap=useRef<HTMLDivElement>(null),drag=useRef<{x:number;y:number}|null>(null);
 const faces=visibleFaces(detection,showUncertain);
 const uncertain=detection?detection.faces.filter(f=>!f.auto_selectable).length:0;
 const busy=!!job&&!TERMINAL.includes(job.status);
 // Restore the draft once per app session; its data belongs to the stored image only.
 useEffect(()=>{if(st.restored)return;setSt({restored:true});const rev=revision.current;void loadDraft<FaceData>('facefix').then(async d=>{if(!d||rev!==revision.current||useSession.getState().facefix.img)return;try{const img=await normalizedImage(new File([d.blob],d.name,{type:d.type}));if(rev!==revision.current)return;const x=d.data;const validDetection=x?.detection&&x.detection.image.width===img.width&&x.detection.image.height===img.height?x.detection:null;setSt({img:{imageId:d.imageId,name:d.name,image:img,file:d.blob},detection:validDetection,selected:validDetection?x?.selected||[]:[],manual:!!x?.manual||!validDetection&&!auto,box:x?.box||null,job:x?.job||null,result:x?.result||''});toast('info',t('editor.restored'));if(!validDetection&&!x?.result&&auto)void detect(img)}catch{void clearDraft('facefix')}})},[]);// eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{if(st.img)writeData(st.img.imageId,{detection,selected,manual,box,job,result} satisfies FaceData)},[st.img,detection,selected,manual,box,job,result]);
 const detect=async(img:HTMLImageElement,p:FaceProfile=profile)=>{
  const ticket=++revision.current;setDetecting(true);setStatus('');setDetection(null);setSelected([]);
  try{
   const d=await directFetch<Detection>(direct.url,direct.token,'facefix/detect',{method:'POST',body:JSON.stringify({image:img.src,detector:p.detector,min_confidence:p.minConfidence})});
   if(ticket!==revision.current)return;
   if(d.image.width!==img.width||d.image.height!==img.height)throw Error(t('ff.sizeMismatch'));
   setDetection(d);setSelected(initialSelection(d));
   const strong=d.faces.filter(f=>f.auto_selectable).length;
   if(!strong){setManual(true);setStatus(d.faces.length?t('ff.lowConfidence'):t('ff.noFace'))}
   else{setManual(false);toast('ok',strong===1?t('ff.foundOne'):t('ff.foundMany',{n:strong}))}
  }catch(e){if(ticket===revision.current){setStatus((e as Error).message);setManual(true)}}
  finally{if(ticket===revision.current)setDetecting(false)}
 };
 const onFile=async(f:File)=>{
  try{
   const img=await normalizedImage(f);++revision.current;const imageId=newImageId();
   setSt({img:{imageId,name:f.name,image:img,file:f},job:null,result:'',box:null,manual:false,detection:null,selected:[]});setStatus('');setCompare(50);
   void saveDraft('facefix',imageId,f,f.name,{detection:null,selected:[],manual:false,box:null,job:null,result:''}).catch(()=>toast('warn',t('draft.notSaved')));
   if(auto)await detect(img);
   else{setManual(true);setStatus(connected?'':t('ff.connectForAuto'))}
  }catch(e){setStatus((e as Error).message)}
 };
 // Poll the running job exactly like the shared generation controls do.
 useEffect(()=>{
  if(!job||TERMINAL.includes(job.status))return;
  let active=true,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{const next=await directFetch<LiveJob>(direct.url,direct.token,'jobs/'+encodeURIComponent(job.id));if(active){setJob(next);if(next.status==='COMPLETED')toast('ok',t('ff.done'));else if(next.status==='FAILED')toast('bad',next.error||t('gen.failedToast'))}}catch(e){if(active)setStatus((e as Error).message)}if(active)timer=setTimeout(poll,2000)};
  timer=setTimeout(poll,1000);return()=>{active=false;clearTimeout(timer)};
 },[job?.id,job?.status]);// eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{
  if(job?.status!=='COMPLETED'||!job.result?.image_keys?.length||result)return;
  let active=true;imageFromDirect(direct.url,direct.token,job.id,0).then(u=>{if(active)setResult(u)}).catch(e=>{if(active)setStatus((e as Error).message)});
  return()=>{active=false};
 },[job?.id,job?.status]);// eslint-disable-line react-hooks/exhaustive-deps
 const fix=async()=>{
  if(!image){setStatus(t('editor.needImage'));return}
  if(!connected){setStatus(t('gen.gpuOffline'));return}
  if(caps.facefix!==true){setStatus(t('ff.unsupported'));return}
  if(!s.checkpoint){setStatus(t('ff.needCheckpoint'));return}
  const problem=profileError(profile,strength,s.prompt);if(problem){setStatus(problem);return}
  const chosen=detection?detection.faces.filter(f=>selected.includes(f.id)):[];
  const useManual=manual||!chosen.length;
  if(useManual&&(!box||box.width<8||box.height<8)){setStatus(t('ff.chooseFace'));return}
  setSending(true);setStatus('');setResult('');
  try{
   const target=useManual?{box:boundedBox(box!,image.width,image.height)}:{select:chosen.map(f=>f.id)};
   const body=faceFixRequest(s,profile,strength,image.src,target,auto,useManual?[box!]:chosen);
   setJob(await directFetch<LiveJob>(direct.url,direct.token,'generate',{method:'POST',body:JSON.stringify(body)}));toast('info',t('gen.accepted'));
  }catch(e){setStatus((e as Error).message);toast('bad',(e as Error).message)}finally{setSending(false)}
 };
 const cancel=async()=>{if(!job)return;try{const r=await directFetch<{status:string}>(direct.url,direct.token,'jobs/'+encodeURIComponent(job.id),{method:'DELETE'});setJob({...job,status:r.status});toast('info',t('gen.cancelSent'))}catch(e){setStatus((e as Error).message)}};
 // Tap selects a face; in manual mode a drag draws the rectangle. Source-pixel coordinates (the stage has no border).
 const point=(e:React.PointerEvent)=>{const r=wrap.current!.getBoundingClientRect();return {x:Math.max(0,Math.min(image!.width,(e.clientX-r.left)/r.width*image!.width)),y:Math.max(0,Math.min(image!.height,(e.clientY-r.top)/r.height*image!.height))}};
 const choose=(id:string)=>{if(busy)return;setSelected(old=>old.includes(id)?(old.length>1?old.filter(i=>i!==id):old):(old.length>1?[...old,id]:[id]))};
 const down=(e:React.PointerEvent)=>{
  if(!image||busy)return;
  if(manual){const p=point(e);e.preventDefault();(e.currentTarget as Element).setPointerCapture?.(e.pointerId);drag.current=p;setBox({x:p.x,y:p.y,width:0,height:0});return}
  const p=point(e),hit=hitFace(faces,p.x,p.y);if(hit&&(e.target as Element)===e.currentTarget)choose(hit.id);
 };
 const move=(e:React.PointerEvent)=>{if(!manual||!drag.current||!image)return;e.preventDefault();const p=point(e),a=drag.current;setBox({x:Math.min(a.x,p.x),y:Math.min(a.y,p.y),width:Math.abs(p.x-a.x),height:Math.abs(p.y-a.y)})};
 const up=()=>{drag.current=null};
 const pct=(b:Box)=>image?{left:b.x/image.width*100+'%',top:b.y/image.height*100+'%',width:b.width/image.width*100+'%',height:b.height/image.height*100+'%'}:{};
 const strongFaces=detection?detection.faces.filter(f=>f.auto_selectable):[];
 const allSelected=strongFaces.length>1&&strongFaces.every(f=>selected.includes(f.id));
 const chosenBoxes=manual?(box?[box]:[]):(detection?.faces.filter(f=>selected.includes(f.id))||[]);
 const saveOriginal=async()=>downloadBlob(await (await fetch(image!.src)).blob(),'yoisaki-original.png');
 return <div className="facefix stack editor-layout" data-localized="true">
  <div className="stack">
  {connected&&!auto&&<div className="notice" role="alert">{legacy?t('ff.legacy',{v:direct.info?.engine_version||''}):t('ff.unsupported')}</div>}
  {!connected&&<div className="notice dangernotice row"><Cpu size={18}/><span className="grow">{t('ff.gpuOff')}</span><Link href="/engine" className="btn">{t('gen.openGpu')}</Link></div>}
  <section className="panel stack">
   <SectionTitle icon={<Smile size={20}/>}>Smart Face Fix</SectionTitle>
   <div className="row"><ImageUpload onFile={onFile} label={image?t('editor.replace'):t('editor.upload')}/><span className="tiny muted grow" style={{overflowWrap:'anywhere'}}>{image?`${image.width} × ${image.height} · ${name}`:t('editor.formats')}</span></div>
   {!image&&<EmptyState title={t('ff.emptyTitle')}>{t('ff.emptyText')}</EmptyState>}
   {image&&<div ref={wrap} className={'facefix-stage'+(manual?' manual':'')} style={{aspectRatio:`${image.width}/${image.height}`,width:`min(100%, calc(var(--ffh) * ${image.width/image.height}))`}} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} data-testid="facefix-stage">
    <img src={image.src} alt={t('editor.before')} draggable={false}/>
    {result&&<img src={result} alt={t('editor.after')} draggable={false} className="facefix-after" style={{clipPath:`inset(0 0 0 ${compare}%)`}}/>}
    {result&&<div className="facefix-divider" style={{left:compare+'%'}}/>}
    {!result&&!manual&&faces.map((f,i)=><div key={f.id} className={'facefix-face'+(selected.includes(f.id)?' selected':'')+(f.auto_selectable?'':' uncertain')} style={pct(f)}><span>{i+1}</span></div>)}
    {!result&&!manual&&faces.length>1&&faces.map((f,i)=><button key={'hit'+f.id} type="button" aria-pressed={selected.includes(f.id)} aria-label={t('ff.faceN',{n:i+1,c:Math.round(f.confidence*100)})} className="facefix-hit" style={{left:(f.x+f.width/2)/image.width*100+'%',top:(f.y+f.height/2)/image.height*100+'%',width:`max(44px,${f.width/image.width*100}%)`,height:`max(44px,${f.height/image.height*100}%)`}} onClick={()=>choose(f.id)}/>)}
    {!result&&manual&&box&&box.width>0&&<div className="facefix-face selected" style={pct(box)}/>}
    {detecting&&<div className="facefix-overlay">{t('ff.detecting')}</div>}
   </div>}
   {image&&!result&&detection&&(!manual||uncertain>0)&&<div className="tiny muted" role="status">{manual?'':strongFaces.length===1?t('ff.autoSelected'):strongFaces.length>1?t('ff.tapFace',{n:strongFaces.length}):showUncertain?t('ff.uncertainHint'):''}{uncertain>0&&<> <button type="button" className="pill" onClick={()=>{const next=!showUncertain;setShowUncertain(next);if(next){setManual(false);setBox(null)}else{setSelected(old=>old.filter(id=>strongFaces.some(f=>f.id===id)));if(!strongFaces.length)setManual(true)}}}>{showUncertain?t('ff.hideUncertain'):t('ff.showUncertain',{n:uncertain})}</button></>}</div>}
   {image&&!result&&strongFaces.length>1&&!manual&&<label className="row tiny"><input type="checkbox" checked={allSelected} onChange={e=>setSelected(e.target.checked?strongFaces.map(f=>f.id):initialSelection(detection!).length?initialSelection(detection!):[strongFaces[0].id])}/> {t('ff.fixAll',{n:strongFaces.length})}</label>}
   {image&&!result&&manual&&<div className="tiny muted">{t('ff.manualHint')} {detection&&strongFaces.length>0&&<button type="button" className="pill" onClick={()=>{setManual(false);setBox(null)}}>{t('ff.backToFound')}</button>}</div>}
   {image&&!result&&!manual&&detection&&<button type="button" className="pill" onClick={()=>{setManual(true);setBox(null)}}><Lasso size={15}/>{t('ff.manualOther')}</button>}
   {result&&<div className="stack"><Slider label="До / После" caption={t('editor.compare')} min={0} max={100} step={1} value={compare} onChange={setCompare}/><div className="row"><a className="btn primary" href={result} download={`yoisaki-facefix-${job?.id}.png`}><Download size={16}/>{t('editor.saveResult')}</a><button type="button" onClick={saveOriginal}>{t('editor.downloadSource')}</button><button type="button" onClick={()=>{setResult('');setJob(null)}}>{t('ff.retry')}</button></div><span className="tiny muted">{t('editor.savedToGallery')}</span></div>}
  </section>
  </div>
  <div className="stack gen-side">
  <section className="panel stack">
   <Slider label="Сила исправления" caption={t('ff.strength')} min={.1} max={.6} step={.05} value={strength} onChange={setStrength}/>
   <span className="tiny muted">{t('ff.strengthHint')}</span>
   <button type="button" className="hero-btn facefix-go" data-state={sending||busy?'busy':'idle'} aria-busy={sending||busy} disabled={!image||sending||busy||detecting||(!manual&&!chosenBoxes.length&&!!detection)} onClick={fix}>{(sending||busy)&&<span className="hero-fill" style={{'--p':Math.max(4,job?.progress?.percent??6)+'%'} as React.CSSProperties} aria-hidden/>}<span className="hero-spark l" aria-hidden/><span className="hero-spark r" aria-hidden/><span className="hero-main"><Smile size={24}/>{sending?t('gen.sending'):busy?t('ff.fixing'):chosenBoxes.length>1?t('ff.fixFaces',{n:chosenBoxes.length}):t('ff.fixFace')}</span></button>
   {job&&<div className="card stack"><JobProgress job={job}/>{busy&&<button type="button" className="danger" onClick={cancel}><X size={16}/>{t('gen.cancelJob')}</button>}</div>}
   {status&&<div role="status" className="notice dangernotice">{status}</div>}
   <span className="tiny muted" style={{overflowWrap:'anywhere'}}>{t('ff.uses',{model:s.checkpoint?t('ff.modelChosen'):t('ff.modelNone'),n:s.loras.filter(l=>l.enabled).length,prompt:s.prompt.trim()?t('ff.promptFromGen'):t('ff.promptEmpty')})}</span>
  </section>
  <details className="panel" open={advanced} onToggle={e=>setAdvanced((e.target as HTMLDetailsElement).open)}>
   <summary className="facefix-summary h-spark">{t('editor.advanced')}</summary>
   {advanced&&<div className="stack" style={{marginTop:12}}>
    <h3>{t('ff.detection')}</h3>
    <div className="field"><label>{t('ff.detector')}</label><select aria-label={t('ff.detector')} value={profile.detector} onChange={e=>set({detector:e.target.value as Detector})}><option value="auto">{t('ff.detAuto')}</option><option value="anime">{t('ff.detAnime')}</option><option value="human">{t('ff.detHuman')}</option></select></div>
    <Slider label="Порог уверенности" caption={t('ff.threshold')} min={.1} max={.9} step={.05} value={profile.minConfidence} onChange={minConfidence=>set({minConfidence})}/>
    <div className="grid2 keep"><button type="button" disabled={!image||!auto||detecting} onClick={()=>image&&detect(image)}><ScanSearch size={16}/>{t('ff.redetect')}</button><button type="button" onClick={()=>{setManual(true);setBox(null)}} disabled={!image}><Lasso size={16}/>{t('ff.manual')}</button></div>
    <h3>{t('ff.mask')}</h3>
    <div className="field"><label>{t('ff.shape')}</label><select aria-label={t('ff.shape')} value={profile.shape} onChange={e=>set({shape:e.target.value as 'ellipse'|'box'})}><option value="ellipse">{t('ff.shapeEllipse')}</option><option value="box">{t('ff.shapeBox')}</option></select></div>
    <Slider label="Расширение маски" caption={t('ff.expand')} min={0} max={.5} step={.02} value={profile.expand} onChange={expand=>set({expand})}/>
    <Slider label="Контекст вокруг лица (padding)" caption={t('ff.padding')} min={0} max={1} step={.05} value={profile.padding} onChange={padding=>set({padding})}/>
    <label className="row tiny"><input type="checkbox" checked={profile.featherAuto} onChange={e=>set({featherAuto:e.target.checked})}/> {t('ff.featherAuto')}{profile.featherAuto&&chosenBoxes.length?` (${autoFeather(chosenBoxes)} px)`:''}</label>
    {!profile.featherAuto&&<Slider label="Растушёвка внутрь (px)" caption={t('ff.feather')} min={0} max={64} step={1} value={profile.feather} onChange={feather=>set({feather})}/>}
    <h3>{t('ff.generation')}</h3>
    <Slider label="Steps" caption={t('params.steps')} min={1} max={60} step={1} value={profile.steps} onChange={steps=>set({steps})}/>
    <Slider label="CFG" caption="CFG" min={1} max={20} step={.5} value={profile.cfg} onChange={cfg=>set({cfg})}/>
    <div className="grid2 keep"><div className="field"><label>Sampler</label><select aria-label="Sampler" value={profile.sampler} onChange={e=>set({sampler:e.target.value})}>{['Euler','Euler a','DPM++ 2M'].map(x=><option key={x}>{x}</option>)}</select></div><div className="field"><label>Scheduler</label><select aria-label="Scheduler" value={profile.scheduler} onChange={e=>set({scheduler:e.target.value})}>{['Normal','Karras'].map(x=><option key={x}>{x}</option>)}</select></div></div>
    <div className="grid2 keep"><div className="field"><label>{t('ff.workW')}</label><input aria-label={t('ff.workW')} type="number" inputMode="numeric" min={256} max={1536} step={8} value={profile.workWidth} onChange={e=>set({workWidth:Number(e.target.value)})}/></div><div className="field"><label>{t('ff.workH')}</label><input aria-label={t('ff.workH')} type="number" inputMode="numeric" min={256} max={1536} step={8} value={profile.workHeight} onChange={e=>set({workHeight:Number(e.target.value)})}/></div></div>
    <span className="tiny muted">{t('ff.workNote')}</span>
    <label className="row tiny"><input type="checkbox" checked={profile.randomSeed} onChange={e=>set({randomSeed:e.target.checked})}/> {t('params.randomSeed')}</label>
    {!profile.randomSeed&&<input aria-label="Seed" inputMode="numeric" value={profile.seed} onChange={e=>set({seed:e.target.value.replace(/\D/g,'')})} placeholder="Seed"/>}
    <h3>{t('ff.promptModels')}</h3>
    <Prompt label="Positive Prompt" value={s.prompt} onChange={prompt=>updateSettings({prompt})}/>
    <Prompt label="Negative Prompt" value={s.negative} onChange={negative=>updateSettings({negative})}/>
    <span className="tiny muted">{t('ff.sharedNote')}</span>
    <button type="button" onClick={onClassic}>{t('ff.classic')}</button>
   </div>}
  </details>
  </div>
 </div>;
}

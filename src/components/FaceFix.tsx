'use client';
// v1.8.1 SMART FACE FIX: upload → automatic detection → (choose a face if several) → Fix Face → compare → save.
// Every advanced parameter is still available, collapsed. Checkpoint, VAE, LoRA and prompts are the shared settings.
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {ImageUpload,Slider,Prompt} from './Common';
import {JobProgress} from './JobProgress';
import type {LiveJob} from './Generator';
import {useStudio} from '@/stores/studio';
import {useDirect,directFetch,imageFromDirect} from '@/lib/engine/direct';
import {normalizedImage,boundedBox,type Box} from '@/lib/editor';
import {FACE_DEFAULTS,DEFAULT_STRENGTH,visibleFaces,initialSelection,hitFace,profileError,faceFixRequest,autoFeather,type Detection,type FaceProfile,type Detector} from '@/lib/facefix';
import {downloadBlob} from '@/lib/storage/gallery';

const TERMINAL=['COMPLETED','FAILED','CANCELLED','INTERRUPTED'];

export function FaceFix({onClassic}:{onClassic:()=>void}){
 const s=useStudio(x=>x.settings),updateSettings=useStudio(x=>x.update);
 const direct=useDirect();
 const caps=direct.info?.capabilities||{};
 const connected=!!direct.url&&['READY','BUSY'].includes(direct.state);
 const auto=connected&&caps.auto_facefix===true&&caps.face_detect_contract===1;
 const legacy=connected&&!auto&&caps.facefix===true;
 const [image,setImage]=useState<HTMLImageElement|null>(null),[name,setName]=useState('');
 const [detection,setDetection]=useState<Detection|null>(null),[detecting,setDetecting]=useState(false);
 const [selected,setSelected]=useState<string[]>([]),[showUncertain,setShowUncertain]=useState(false);
 const [manual,setManual]=useState(false),[box,setBox]=useState<Box|null>(null);
 const [strength,setStrength]=useState(DEFAULT_STRENGTH);
 const [profile,setProfile]=useState<FaceProfile>({...FACE_DEFAULTS,sampler:s.sampler,scheduler:s.scheduler});
 const [advanced,setAdvanced]=useState(false);
 const [job,setJob]=useState<LiveJob|null>(null),[result,setResult]=useState(''),[compare,setCompare]=useState(50);
 const [status,setStatus]=useState(''),[sending,setSending]=useState(false);
 const revision=useRef(0),wrap=useRef<HTMLDivElement>(null),drag=useRef<{x:number;y:number}|null>(null);
 const set=(x:Partial<FaceProfile>)=>setProfile(p=>({...p,...x}));
 const faces=visibleFaces(detection,showUncertain);
 const uncertain=detection?detection.faces.filter(f=>!f.auto_selectable).length:0;
 const busy=!!job&&!TERMINAL.includes(job.status);

 const detect=async(img:HTMLImageElement,p:FaceProfile=profile)=>{
  const ticket=++revision.current;setDetecting(true);setStatus('');setDetection(null);setSelected([]);
  try{
   const d=await directFetch<Detection>(direct.url,direct.token,'facefix/detect',{method:'POST',body:JSON.stringify({image:img.src,detector:p.detector,min_confidence:p.minConfidence})});
   if(ticket!==revision.current)return;
   if(d.image.width!==img.width||d.image.height!==img.height)throw Error('Размер изображения на GPU не совпал с загруженным. Загрузите файл заново.');
   setDetection(d);setSelected(initialSelection(d));
   const strong=d.faces.filter(f=>f.auto_selectable).length;
   if(!strong){setManual(true);setStatus(d.faces.length?'Лицо найдено только с низкой уверенностью. Проверьте варианты («Показать неуверенные») или выделите лицо вручную.':'Лицо не найдено. Исходник не изменён. Выделите лицо вручную: проведите пальцем по изображению.')}
   else setManual(false);
  }catch(e){if(ticket===revision.current){setStatus((e as Error).message);setManual(true)}}
  finally{if(ticket===revision.current)setDetecting(false)}
 };
 const onFile=async(f:File)=>{
  try{
   const img=await normalizedImage(f);
   setImage(img);setName(f.name);setJob(null);setResult('');setBox(null);setManual(false);setDetection(null);setSelected([]);setStatus('');setCompare(50);
   if(auto)await detect(img);
   else{setManual(true);setStatus(connected?'':'Подключите GPU (раздел GPU), чтобы найти лица автоматически. Можно выделить лицо вручную.')}
  }catch(e){setStatus((e as Error).message)}
 };
 // Poll the running job exactly like the shared generation controls do.
 useEffect(()=>{
  if(!job||TERMINAL.includes(job.status))return;
  let active=true,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{const next=await directFetch<LiveJob>(direct.url,direct.token,'jobs/'+encodeURIComponent(job.id));if(active)setJob(next)}catch(e){if(active)setStatus((e as Error).message)}if(active)timer=setTimeout(poll,2000)};
  timer=setTimeout(poll,1000);return()=>{active=false;clearTimeout(timer)};
 },[job?.id,job?.status]);
 useEffect(()=>{
  if(job?.status!=='COMPLETED'||!job.result?.image_keys?.length)return;
  let active=true;imageFromDirect(direct.url,direct.token,job.id,0).then(u=>{if(active)setResult(u)}).catch(e=>{if(active)setStatus((e as Error).message)});
  return()=>{active=false};
 },[job?.id,job?.status]);

 const fix=async()=>{
  if(!image){setStatus('Загрузите изображение.');return}
  if(!connected){setStatus('GPU отключён. Подключите его в разделе GPU.');return}
  if(caps.facefix!==true){setStatus('Подключённый движок не поддерживает Face Fix. Запустите YOISAKI ENGINE v1.8.1.');return}
  if(!s.checkpoint){setStatus('Выберите Checkpoint на странице Generate.');return}
  const problem=profileError(profile,strength,s.prompt);if(problem){setStatus(problem);return}
  const chosen=detection?detection.faces.filter(f=>selected.includes(f.id)):[];
  const useManual=manual||!chosen.length;
  if(useManual&&(!box||box.width<8||box.height<8)){setStatus('Выберите лицо касанием или выделите его вручную.');return}
  setSending(true);setStatus('');setResult('');
  try{
   const target=useManual?{box:boundedBox(box!,image.width,image.height)}:{select:chosen.map(f=>f.id)};
   const body=faceFixRequest(s,profile,strength,image.src,target,auto,useManual?[box!]:chosen);
   setJob(await directFetch<LiveJob>(direct.url,direct.token,'generate',{method:'POST',body:JSON.stringify(body)}));
  }catch(e){setStatus((e as Error).message)}finally{setSending(false)}
 };
 const cancel=async()=>{if(!job)return;try{const r=await directFetch<{status:string}>(direct.url,direct.token,'jobs/'+encodeURIComponent(job.id),{method:'DELETE'});setJob({...job,status:r.status})}catch(e){setStatus((e as Error).message)}};

 // Tap selects a face; in manual mode a drag draws the rectangle. Source-pixel coordinates.
 const point=(e:React.PointerEvent)=>{const r=wrap.current!.getBoundingClientRect();return {x:Math.max(0,Math.min(image!.width,(e.clientX-r.left)/r.width*image!.width)),y:Math.max(0,Math.min(image!.height,(e.clientY-r.top)/r.height*image!.height))}};
 // One face by default; once several are selected ("fix all"), taps toggle within that set.
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

 return <div className="facefix stack">
  {connected&&!auto&&<div className="notice" role="alert">{legacy?`Подключён YOISAKI ENGINE ${direct.info?.engine_version||''}: автоматический поиск лиц недоступен. Работает ручное выделение. Для автоматического Face Fix запустите блокнот YOISAKI ENGINE v1.8.1 SMART FACE FIX.`:'Подключённый движок не поддерживает Face Fix. Запустите YOISAKI ENGINE v1.8.1.'}</div>}
  {!connected&&<div className="notice">GPU не подключён. <Link href="/engine" style={{color:'var(--gold)',fontWeight:700}}>Подключить GPU ↗</Link></div>}
  <div className="panel stack">
   <div className="row"><ImageUpload onFile={onFile} label={image?'Заменить изображение':'Загрузить изображение'}/><span className="tiny muted grow">{image?`${image.width} × ${image.height} · ${name}`:'PNG / JPG / WEBP до 25 МБ'}</span></div>
   {image&&<div ref={wrap} className={'facefix-stage'+(manual?' manual':'')} style={{aspectRatio:`${image.width}/${image.height}`,width:`min(100%, calc(var(--ffh) * ${image.width/image.height}))`}} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} data-testid="facefix-stage">
    <img src={image.src} alt="Исходник" draggable={false}/>
    {result&&<img src={result} alt="Результат" draggable={false} className="facefix-after" style={{clipPath:`inset(0 0 0 ${compare}%)`}}/>}
    {result&&<div className="facefix-divider" style={{left:compare+'%'}}/>}
    {!result&&!manual&&faces.map((f,i)=><div key={f.id} className={'facefix-face'+(selected.includes(f.id)?' selected':'')+(f.auto_selectable?'':' uncertain')} style={pct(f)}><span>{i+1}</span></div>)}
    {!result&&!manual&&faces.length>1&&faces.map((f,i)=><button key={'hit'+f.id} type="button" aria-pressed={selected.includes(f.id)} aria-label={`Лицо ${i+1}, уверенность ${Math.round(f.confidence*100)}%`} className="facefix-hit" style={{left:(f.x+f.width/2)/image.width*100+'%',top:(f.y+f.height/2)/image.height*100+'%',width:`max(44px,${f.width/image.width*100}%)`,height:`max(44px,${f.height/image.height*100}%)`}} onClick={()=>choose(f.id)}/>)}
    {!result&&manual&&box&&box.width>0&&<div className="facefix-face selected" style={pct(box)}/>}
    {detecting&&<div className="facefix-overlay">Поиск лиц…</div>}
   </div>}
   {image&&!result&&detection&&(!manual||uncertain>0)&&<div className="tiny muted" role="status">{manual?'':strongFaces.length===1?'Лицо найдено и выбрано автоматически.':strongFaces.length>1?`Найдено лиц: ${strongFaces.length}. Коснитесь лица, которое нужно исправить.`:showUncertain?'Неуверенные варианты: коснитесь, только если это действительно лицо.':''}{uncertain>0&&<> <button className="pill" onClick={()=>{const next=!showUncertain;setShowUncertain(next);if(next){setManual(false);setBox(null)}else{setSelected(old=>old.filter(id=>strongFaces.some(f=>f.id===id)));if(!strongFaces.length)setManual(true)}}}>{showUncertain?'Скрыть неуверенные':`Показать неуверенные (${uncertain})`}</button></>}</div>}
   {image&&!result&&strongFaces.length>1&&!manual&&<label className="row tiny"><input type="checkbox" checked={allSelected} onChange={e=>setSelected(e.target.checked?strongFaces.map(f=>f.id):initialSelection(detection!).length?initialSelection(detection!):[strongFaces[0].id])}/> Исправить все найденные лица ({strongFaces.length}), по очереди</label>}
   {image&&!result&&manual&&<div className="tiny muted">Ручное выделение: проведите пальцем вокруг лица. {detection&&strongFaces.length>0&&<button className="pill" onClick={()=>{setManual(false);setBox(null)}}>Вернуться к найденным лицам</button>}</div>}
   {image&&!result&&!manual&&detection&&<button className="pill" onClick={()=>{setManual(true);setBox(null)}}>Выделить другое лицо вручную</button>}
   {result&&<div className="stack"><Slider label="До / После" min={0} max={100} step={1} value={compare} onChange={setCompare}/><div className="row"><a className="btn primary" href={result} download={`yoisaki-facefix-${job?.id}.png`}>Сохранить результат</a><button onClick={saveOriginal}>Скачать исходник</button><button onClick={()=>{setResult('');setJob(null)}}>Оставить оригинал / попробовать снова</button></div><span className="tiny muted">Результат также сохранён в галерею. Исходник не изменяется.</span></div>}
  </div>
  <div className="panel stack">
   <Slider label="Сила исправления" min={.1} max={.6} step={.05} value={strength} onChange={setStrength}/>
   <span className="tiny muted">0.3 — бережно (по умолчанию). Больше — сильнее перерисовка; характерные черты могут измениться.</span>
   <button className="primary facefix-go" disabled={!image||sending||busy||detecting||(!manual&&!chosenBoxes.length&&!!detection)} onClick={fix}>{sending?'Отправка…':busy?'Исправление…':chosenBoxes.length>1?`Исправить лица (${chosenBoxes.length})`:'Исправить лицо'}</button>
   {job&&<div className="card stack"><JobProgress job={job}/>{busy&&<button onClick={cancel}>Отменить</button>}</div>}
   {status&&<div role="status" className="notice dangernotice">{status}</div>}
   <span className="tiny muted" style={{overflowWrap:'anywhere'}}>Модель: {s.checkpoint?'выбрана на странице Generate':'не выбрана'} · LoRA: {s.loras.filter(l=>l.enabled).length} · Промпт: {s.prompt.trim()?'из Generate':'пустой'}</span>
  </div>
  <details className="panel" open={advanced} onToggle={e=>setAdvanced((e.target as HTMLDetailsElement).open)}>
   <summary className="facefix-summary">Расширенные настройки</summary>
   {advanced&&<div className="stack" style={{marginTop:12}}>
    <h3>Обнаружение</h3>
    <div className="field"><label>Детектор</label><select aria-label="Детектор" value={profile.detector} onChange={e=>set({detector:e.target.value as Detector})}><option value="auto">Авто (аниме + общий)</option><option value="anime">Аниме / иллюстрации</option><option value="human">Общий (реалистичные лица)</option></select></div>
    <Slider label="Порог уверенности" min={.1} max={.9} step={.05} value={profile.minConfidence} onChange={minConfidence=>set({minConfidence})}/>
    <button disabled={!image||!auto||detecting} onClick={()=>image&&detect(image)}>Найти лица заново</button>
    <button onClick={()=>{setManual(true);setBox(null)}} disabled={!image}>Ручное выделение лица</button>
    <h3>Маска</h3>
    <div className="field"><label>Форма маски</label><select aria-label="Форма маски" value={profile.shape} onChange={e=>set({shape:e.target.value as 'ellipse'|'box'})}><option value="ellipse">Овал (сохраняет уши, волосы, фон в углах)</option><option value="box">Прямоугольник</option></select></div>
    <Slider label="Расширение маски" min={0} max={.5} step={.02} value={profile.expand} onChange={expand=>set({expand})}/>
    <Slider label="Контекст вокруг лица (padding)" min={0} max={1} step={.05} value={profile.padding} onChange={padding=>set({padding})}/>
    <label className="row tiny"><input type="checkbox" checked={profile.featherAuto} onChange={e=>set({featherAuto:e.target.checked})}/> Растушёвка автоматически{profile.featherAuto&&chosenBoxes.length?` (${autoFeather(chosenBoxes)} px)`:''}</label>
    {!profile.featherAuto&&<Slider label="Растушёвка внутрь (px)" min={0} max={64} step={1} value={profile.feather} onChange={feather=>set({feather})}/>}
    <h3>Генерация</h3>
    <Slider label="Steps" min={1} max={60} step={1} value={profile.steps} onChange={steps=>set({steps})}/>
    <Slider label="CFG" min={1} max={20} step={.5} value={profile.cfg} onChange={cfg=>set({cfg})}/>
    <div className="grid2"><div className="field"><label>Sampler</label><select aria-label="Sampler" value={profile.sampler} onChange={e=>set({sampler:e.target.value})}>{['Euler','Euler a','DPM++ 2M'].map(t=><option key={t}>{t}</option>)}</select></div><div className="field"><label>Scheduler</label><select aria-label="Scheduler" value={profile.scheduler} onChange={e=>set({scheduler:e.target.value})}>{['Normal','Karras'].map(t=><option key={t}>{t}</option>)}</select></div></div>
    <div className="grid2"><div className="field"><label>Рабочая ширина</label><input aria-label="Рабочая ширина" type="number" min={256} max={1536} step={8} value={profile.workWidth} onChange={e=>set({workWidth:Number(e.target.value)})}/></div><div className="field"><label>Рабочая высота</label><input aria-label="Рабочая высота" type="number" min={256} max={1536} step={8} value={profile.workHeight} onChange={e=>set({workHeight:Number(e.target.value)})}/></div></div>
    <span className="tiny muted">Область лица вписывается в рабочий размер с сохранением пропорций; итог сохраняет размер исходника.</span>
    <label className="row tiny"><input type="checkbox" checked={profile.randomSeed} onChange={e=>set({randomSeed:e.target.checked})}/> Случайный seed</label>
    {!profile.randomSeed&&<input aria-label="Seed" value={profile.seed} onChange={e=>set({seed:e.target.value.replace(/\D/g,'')})} placeholder="Seed"/>}
    <h3>Промпт и модели (общие с Generate)</h3>
    <Prompt label="Positive Prompt" value={s.prompt} onChange={prompt=>updateSettings({prompt})}/>
    <Prompt label="Negative Prompt" value={s.negative} onChange={negative=>updateSettings({negative})}/>
    <span className="tiny muted">Checkpoint, VAE и LoRA с весами берутся со страницы Generate без изменений. ControlNet и Regional Control к Face Fix не применяются. Скрытые теги не добавляются.</span>
    <button onClick={onClassic}>Классический редактор Face Fix (v1.8.0)</button>
   </div>}
  </details>
 </div>;
}

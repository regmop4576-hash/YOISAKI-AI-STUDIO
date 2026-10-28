import {useEffect,useRef,useState} from 'react';
import {localApi,localFetch} from '@/lib/local-api';
import {useStudio} from '@/stores/studio';
import {useDirect} from '@/lib/engine/direct';

// v1.7.5 zero-terminal CloudCompute: select GPU → create GPU server → initialize engine → connect → sync models.
// v1.7.7: GPU availability monitor (official GET /offers, shared rate-limited snapshot, filters, notifications), a final
// re-verified configuration before the paid request, and separate, evidence-based "CloudCompute instance" and
// "YOISAKI ENGINE" states. Every price and every stage shown here comes from the CloudCompute API or from a stage signed
// by the engine; a refresh never reserves a GPU and nothing is ever rented automatically.
type Price={minor:number|null;raw?:number;currency:string;field:string;verified:boolean;basis:string};
type Match={ok:boolean;reasons:string[];preferred:boolean};
type Offer={id:number;gpu:string;gpus:number;vram_mb:number|null;price:Price|null;storage:{field:string;value:number}[];disk_gb:number|null;cuda:number|null;reliability:number|null;location:string;inet_down_mbps:number|null;compatible:boolean;reasons:string[];warnings:string[];model?:{label:string;cc:string}|null;match?:Match;taken?:boolean;first_seen?:number};
type Brief={id:number;gpu:string;gpus:number;vram_mb:number|null;price_minor:number|null;currency:string;disk_gb:number|null;preferred?:boolean};
type Filters={gpu_count:number;min_vram_gb:number;preferred_vram_gb:number;max_price_rub:number;min_disk_gb:number;require_known_cuda:boolean;name:string;sort:string};
type Settings={filters:Filters;interval_s:number;auto_minutes:number;browser_notifications:boolean};
type MonitorView={settings:Settings;limits:{min_interval_s:number;max_interval_s:number};requirements:Requirements;offers:Offer[];total:number;matching:number;updated_at:number|null;last_attempt_at:number|null;stale:boolean;
 error:{code:string;message:string;at:number}|null;rate_limit:{until:number;retry_in_s:number}|null;backoff_until:number|null;auto:{on:boolean;started_at:number|null;stops_at:number|null;next_run_at:number|null;stop_reason:string};
 gone:(Brief&{gone_at:number})[];taken:{id:number;at:number;message:string}[];notifications:{key:string;offer:Brief;preferred:boolean;at:number;acknowledged:boolean}[];cached?:boolean};
type Requirements={min_vram_mb:number;recommended_vram_mb:number;min_cuda:number;min_disk_gb:number;default_disk_gb:number;image_size_note_gb:number};
type ImageCheck={image:string;checked:boolean;accessible:boolean|null;message:string;linux_amd64?:boolean|null};
type Quote={offer_id:number;gpu:string;gpus:number;vram_mb:number|null;model:{label:string;cc:string}|null;cuda:number|null;reliability:number|null;location:string;price:Price|null;storage:{field:string;value:number}[];disk_gb:number;offer_disk_gb:number|null;
 image:string;image_check:ImageCheck;bootstrap_profile:string;onstart_bytes:number;onstart_budget_bytes:number;onstart_limit_bytes:number;warnings:string[];issues:string[];can_create:boolean;match:Match;checked_at:number;note:string};
type DriveState={state:string;message:string;summary?:{installed:number;missing:number;missing_bytes:number}|null}|null;
type Failure={component:string;code:string;message:string;terminal:boolean;at:number|null;provider_status?:string}|null;
type Deployment={instance_id:string;name:string;image:string;created_at:number;adopted:boolean;offer:{gpu:string;vram_mb:number|null;price_minor:number|null;currency:string}|null;disk_gb:number|null;auto_sync:boolean;
 stage:string;stage_message:string;stage_at:number|null;error:string;instance_status:string;url_found:boolean;url_host:string;gpu_stages:{stage:string;ts:number}[];drive:DriveState;watching:boolean;
 instance_running:boolean;engine_ready:boolean;provider:{status:string;phase:string;message:string;checked_at:number|null;fields:Record<string,string>}|null;failure:Failure;stage_history:{stage:string;at:number;source:string;provider_status:string}[];
 bootstrap_profile:string|null;terminal:{state:string;message:string;checked_at:number|null}|null;pending:boolean};
type ApiError=Error&{code?:string;details?:{alternatives?:Brief[];provider_message?:string;offer_id?:number}};
const FLOW=['GPU_CREATED','PROVIDER_BOOTSTRAPPING','IMAGE_PREPARING','INSTANCE_RUNNING','DOCKER_IMAGE_READY','ENGINE_STARTING','ENGINE_HEALTH_CHECK','GPU_READY'];
const END=['FAILED','TIMEOUT','INSTANCE_GONE'];
const PROFILES=['worker','access_only','full','none','provider_default'];
const DASHBOARD='https://app.cloudcompute.ru/';
const SHOWN_KEY='yoisaki.gpu-monitor.shown';

export function money(minor:number,currency:string){const v=(minor/100).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});return currency==='RUB'?v+' ₽':v+' '+currency}
const gbText=(mb:number|null)=>mb==null?'—':Math.round(mb/1024)+' ГБ';
const bytesText=(n:number)=>(n/1073741824).toFixed(n>=10737418240?0:1)+' ГБ';
const clock=(t:number|null|undefined)=>t?new Date(t).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const requestId=()=>typeof crypto!=='undefined'&&'randomUUID' in crypto?crypto.randomUUID():'req-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
function shownKeys():Set<string>{try{return new Set(JSON.parse(localStorage.getItem(SHOWN_KEY)||'[]'))}catch{return new Set()}}
function rememberShown(keys:Set<string>){try{localStorage.setItem(SHOWN_KEY,JSON.stringify([...keys].slice(-100)))}catch{/* storage unavailable: in-app list still dedupes */}}

export function CloudComputeDeploy({onInstancesChanged}:{onInstancesChanged:()=>void}){
 const en=useStudio(s=>s.language)==='English',t=(r:string,e:string)=>en?e:r;
 const gpu=useDirect();
 const [mon,setMon]=useState<MonitorView|null>(null),[draft,setDraft]=useState<Filters|null>(null),[showAll,setShowAll]=useState(false);
 const [selected,setSelected]=useState<Offer|Brief|null>(null),[quote,setQuote]=useState<Quote|null>(null),[reqId,setReqId]=useState('');
 const [disk,setDisk]=useState('80'),[autoSync,setAutoSync]=useState(true),[understood,setUnderstood]=useState(false),[previousAck,setPreviousAck]=useState(false);
 const [deployment,setDeployment]=useState<Deployment|null>(null),[defaultImage,setDefaultImage]=useState(''),[image,setImage]=useState(''),[skipCheck,setSkipCheck]=useState(false),[profile,setProfile]=useState('worker');
 const [busy,setBusy]=useState(''),[error,setError]=useState<ApiError|null>(null),[adoptId,setAdoptId]=useState(''),[command,setCommand]=useState('');
 const loading=useRef(false);
 const t2=(code:string)=>({cloudcompute:t('CloudCompute (провайдер)','CloudCompute (provider)'),docker:t('Docker на хосте CloudCompute','Docker on the CloudCompute host'),gpu_host:t('Драйвер / NVIDIA Container Toolkit на хосте','Host driver / NVIDIA Container Toolkit'),
  bootstrap:t('Инициализация инстанса (onstart / профиль)','Instance bootstrap (onstart / profile)'),engine:t('YOISAKI ENGINE (Python)','YOISAKI ENGINE (Python)'),gpu:t('Проверка GPU/CUDA движком','Engine GPU/CUDA check'),connection:t('Связь с движком','Engine connection')} as Record<string,string>)[code]||code;
 async function load(){if(loading.current)return;loading.current=true;try{const r=await localApi<{deployment:Deployment|null;default_image:string}>('/api/cloudcompute/deploy');setDeployment(r.deployment);setDefaultImage(r.default_image)}catch(e){setError(e as ApiError)}finally{loading.current=false}}
 async function loadMonitor(){try{const v=await localApi<MonitorView>('/api/cloudcompute/monitor');setMon(v);setDraft(d=>d||v.settings.filters)}catch{/* shown on the next explicit action */}}
 useEffect(()=>{void load();void loadMonitor()},[]);
 const active=!!deployment&&(deployment.watching||!['GPU_READY',...END].includes(deployment.stage)||['BINDING','CHECKING','SYNCING'].includes(deployment.drive?.state||''));
 useEffect(()=>{if(!active)return;const id=setInterval(()=>{if(document.visibilityState==='visible'){void load();void gpu.poll()}},4000);return ()=>clearInterval(id)},[active]);
 // While automatic monitoring runs on the local server, the page only reads the shared snapshot (no CloudCompute calls).
 useEffect(()=>{if(!mon?.auto.on)return;const id=setInterval(()=>void loadMonitor(),5000);return ()=>clearInterval(id)},[mon?.auto.on]);
 // New matching offers: in-app list always; a browser notification once per offer when enabled and permitted.
 useEffect(()=>{
  if(!mon?.settings.browser_notifications||typeof Notification==='undefined'||Notification.permission!=='granted')return;
  const shown=shownKeys();let changed=false;
  for(const n of mon.notifications)if(!n.acknowledged&&!shown.has(n.key)){shown.add(n.key);changed=true;
   try{new Notification('YOISAKI · '+t('новый подходящий GPU','new matching GPU'),{body:`${n.offer.gpu} · ${gbText(n.offer.vram_mb)} · ${n.offer.price_minor!=null?money(n.offer.price_minor,n.offer.currency)+t('/час','/hour'):''}`,tag:n.key})}catch{/* notifications may be blocked by the browser */}}
  if(changed)rememberShown(shown);
 },[mon?.notifications,mon?.settings.browser_notifications]);
 async function run(name:string,fn:()=>Promise<unknown>){setBusy(name);setError(null);try{await fn()}catch(e){setError(e as ApiError);if(['CC_OFFER_TAKEN','CC_OFFER_GONE','CC_RATE_LIMITED'].includes((e as ApiError).code||''))void loadMonitor()}finally{setBusy('')}}
 const effectiveImage=image.trim()||defaultImage;
 const refresh=()=>run('offers',async()=>{const v=await localApi<MonitorView>('/api/cloudcompute/monitor/refresh',{method:'POST',body:'{}'});setMon(v);setDraft(d=>d||v.settings.filters)});
 const saveSettings=(patch:Partial<Settings>)=>run('settings',async()=>{const v=await localApi<MonitorView>('/api/cloudcompute/monitor',{method:'PUT',body:JSON.stringify(patch)});setMon(v);setDraft(v.settings.filters)});
 const setAuto=(on:boolean)=>run('auto',async()=>{setMon(await localApi<MonitorView>('/api/cloudcompute/monitor/auto',{method:'POST',body:JSON.stringify({on})}))});
 const ack=(keys:string[])=>run('ack',async()=>{setMon(await localApi<MonitorView>('/api/cloudcompute/monitor/ack',{method:'POST',body:JSON.stringify({keys})}))});
 const toggleBrowser=(on:boolean)=>run('notify',async()=>{
  if(on&&typeof Notification!=='undefined'&&Notification.permission!=='granted'){const p=await Notification.requestPermission();if(p!=='granted')throw Object.assign(Error(t('Браузер не разрешил уведомления: остаются уведомления внутри приложения.','The browser did not allow notifications: in-app notifications remain.')),{code:'NOTIFY_DENIED'})}
  if(on&&typeof Notification==='undefined')throw Object.assign(Error(t('Этот браузер не поддерживает уведомления: остаются уведомления внутри приложения.','This browser has no notifications: in-app notifications remain.')),{code:'NOTIFY_UNSUPPORTED'});
  setMon(await localApi<MonitorView>('/api/cloudcompute/monitor',{method:'PUT',body:JSON.stringify({browser_notifications:on})}));
 });
 const choose=(o:Offer|Brief)=>{setSelected(o);setQuote(null);setUnderstood(false);setReqId('');const max=o.disk_gb!=null?Math.floor(o.disk_gb):null;const def=mon?.requirements.default_disk_gb||80;setDisk(String(max!=null?Math.min(def,max):def))};
 const diskNumber=Math.round(Number(disk));
 // Step 2: fresh data from CloudCompute; shown as the final configuration. Nothing is created or reserved here.
 const prepare=()=>run('prepare',async()=>{
  if(!selected)return;
  const r=await localApi<{quote:Quote}>('/api/cloudcompute/deploy/prepare',{method:'POST',body:JSON.stringify({offer_id:selected.id,disk_gb:diskNumber,bootstrap_profile:profile,...(image.trim()?{image:image.trim()}:{}),...(skipCheck?{skip_image_check:true}:{})})});
  setQuote(r.quote);setReqId(requestId());setUnderstood(false);void loadMonitor();
 });
 const price=quote?.price?.verified&&quote.price.minor!=null?quote.price:null;
 const canCreate=!!quote&&quote.can_create&&!!price&&understood&&!busy&&!!reqId;
 const create=()=>run('create',async()=>{
  if(!quote||!price)return;
  const text=t(`Создать ПЛАТНЫЙ GPU-сервер?\n\n${quote.gpu} · ${gbText(quote.vram_mb)} VRAM\nЦена GPU: ${money(price.minor!,price.currency)} в час (данные CloudCompute, проверено в ${clock(quote.checked_at)})\nДиск: ${quote.disk_gb} ГБ\nОбраз: ${quote.image}\nПрофиль инициализации: ${quote.bootstrap_profile}\n\nПроверка не резервирует GPU: CloudCompute может отказать, если хост успеют занять. Оплата начинается сразу после создания и идёт, пока инстанс существует.`,
   `Create a PAID GPU server?\n\n${quote.gpu} · ${gbText(quote.vram_mb)} VRAM\nGPU price: ${money(price.minor!,price.currency)} per hour (CloudCompute data, checked at ${clock(quote.checked_at)})\nDisk: ${quote.disk_gb} GB\nImage: ${quote.image}\nBootstrap profile: ${quote.bootstrap_profile}\n\nThe check does not reserve the GPU: CloudCompute may refuse if the host is taken meanwhile. Billing starts right after creation and runs while the instance exists.`);
  if(!confirm(text))return;
  const additional=!!deployment&&!END.includes(deployment.stage)&&!deployment.pending;
  if(additional&&!confirm(t(`Уже есть GPU-сервер #${deployment!.instance_id}. Он тоже оплачивается. Создать ещё один?`,`GPU server #${deployment!.instance_id} already exists and is billed too. Create another one?`)))return;
  const body={confirm:true,request_id:reqId,offer_id:quote.offer_id,accepted_price_minor:price.minor,currency:price.currency,disk_gb:quote.disk_gb,auto_sync:autoSync,bootstrap_profile:quote.bootstrap_profile,
   ...(image.trim()?{image:image.trim()}:{}),...(skipCheck?{skip_image_check:true}:{}),...(additional?{additional:true}:{}),...(previousAck?{previous_unconfirmed_ack:true}:{})};
  try{const r=await localApi<{deployment:Deployment}>('/api/cloudcompute/deploy',{method:'POST',body:JSON.stringify(body)});setDeployment(r.deployment);setUnderstood(false);setQuote(null);setSelected(null);setPreviousAck(false)}
  finally{onInstancesChanged();void load()}
 });
 const watch=()=>run('watch',async()=>{const r=await localApi<{deployment:Deployment}>('/api/cloudcompute/deploy/watch',{method:'POST'});setDeployment(r.deployment)});
 const connect=()=>run('connect',async()=>{const r=await localApi<{deployment:Deployment}>('/api/cloudcompute/deploy/connect',{method:'POST'});setDeployment(r.deployment);await gpu.poll()});
 const sync=()=>run('sync',async()=>{const r=await localApi<{deployment:Deployment}>('/api/cloudcompute/deploy/sync',{method:'POST',body:JSON.stringify({download:true})});setDeployment(r.deployment)});
 const terminal=()=>run('terminal',async()=>{const r=await localApi<{deployment:Deployment}>('/api/cloudcompute/deploy/terminal',{method:'POST',body:'{}'});setDeployment(r.deployment)});
 const diagnostics=()=>run('diagnostics',async()=>{
  const r=await localFetch('/api/cloudcompute/diagnostics');const blob=await r.blob();const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='YOISAKI_CLOUDCOMPUTE_DIAGNOSTICS.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
 });
 const connected=gpu.provider==='cloudcompute'&&!!gpu.url;
 const failed=!!deployment&&END.includes(deployment.stage);
 const shownStage=deployment?(failed?(deployment.stage_history.filter(h=>FLOW.includes(h.stage)).at(-1)?.stage||'GPU_CREATED'):deployment.stage):'';
 const stageIndex=FLOW.indexOf(shownStage);
 const stageAt=(s:string)=>deployment?.stage_history.filter(h=>h.stage===s).at(-1)?.at;
 const stageNames:Record<string,string>={GPU_CREATED:t('Инстанс создан в CloudCompute','Instance created in CloudCompute'),PROVIDER_BOOTSTRAPPING:t('CloudCompute готовит хост','CloudCompute prepares the host'),IMAGE_PREPARING:t('CloudCompute готовит образ','CloudCompute prepares the image'),
  INSTANCE_RUNNING:t('Инстанс CloudCompute работает','CloudCompute instance running'),DOCKER_IMAGE_READY:t('Контейнер YOISAKI запущен','YOISAKI container started'),ENGINE_STARTING:t('YOISAKI ENGINE запускается','YOISAKI ENGINE starting'),
  ENGINE_HEALTH_CHECK:t('Проверка состояния движка','Engine health check'),GPU_READY:t('YOISAKI ENGINE готов','YOISAKI ENGINE ready')};
 const offers=(mon?.offers||[]).filter(o=>showAll||o.match?.ok);
 const pendingNotes=(mon?.notifications||[]).filter(n=>!n.acknowledged);
 const f=draft;const setF=(k:keyof Filters,v:string|boolean)=>setDraft(d=>d?{...d,[k]:typeof v==='boolean'||k==='name'||k==='sort'?v:Number(v)}:d);
 const offerLine=(o:Offer|Brief)=>{const p='price' in o?(o.price?.minor!=null?money(o.price.minor,o.price.currency)+t('/час','/hour'):o.price?t('цена не подтверждена','price unverified'):t('нет цены','no price')):(o.price_minor!=null?money(o.price_minor,o.currency)+t('/час','/hour'):t('нет цены','no price'));return p};
 const tile=(title:string,ok:boolean|null,value:string,sub:string)=><div className="card stack" style={{gap:6,borderColor:ok?'#4f7a3a':ok===false?'#703a3a':undefined}}><span className="tiny muted">{title}</span><b style={{color:ok?'#9be37a':ok===false?'#ff9999':'var(--gold)',overflowWrap:'anywhere'}}>{value}</b><span className="tiny muted" style={{overflowWrap:'anywhere'}}>{sub}</span></div>;

 return <section className="panel stack" data-localized="true" aria-label={t('CloudCompute: запуск GPU','CloudCompute: GPU launch')}>
  <h2>CLOUDCOMPUTE</h2>
  <p className="tiny muted">{t('Аренда GPU и запуск YOISAKI ENGINE без SSH, Python и Termux. Управление арендой (API-ключ) и связь с движком (токен движка) — отдельные вещи: ключ CloudCompute никогда не передаётся на GPU.','Rent a GPU and start YOISAKI ENGINE without SSH, Python or Termux. Rental management (API key) and the engine connection (engine token) are separate: the CloudCompute key never reaches the GPU.')}</p>

  <div className="stack" role="group" aria-label={t('Шаги запуска','Launch steps')}>
   <button className={!deployment||failed?'primary':''} disabled={!!busy} onClick={()=>void refresh()}>{t('1. Найти GPU','1. Find GPU')}</button>
   <button className={selected&&!quote?'primary':''} disabled={!!busy||!selected} onClick={()=>void prepare()}>{t('2. Проверить предложение','2. Verify offer')}</button>
   <button className={canCreate?'primary':''} disabled={!canCreate} onClick={()=>void create()}>{t('3. Подтвердить аренду','3. Confirm rental')}</button>
   <button disabled={!!busy||!deployment||deployment.stage==='GPU_READY'&&connected} onClick={()=>void watch()}>{t('4. Инициализировать движок','4. Initialize engine')}</button>
   <button className={deployment?.url_found&&!connected?'primary':''} disabled={!!busy||!deployment||connected} onClick={()=>void connect()}>{t('5. Подключить','5. Connect')}</button>
   <button className={connected&&deployment?.drive?.state==='READY_TO_SYNC'?'primary':''} disabled={!!busy||!connected||!deployment||['BINDING','CHECKING','SYNCING'].includes(deployment.drive?.state||'')} onClick={()=>void sync()}>{t('6. Синхронизировать модели','6. Sync models')}</button>
  </div>
  {busy&&<progress aria-label={t('Запрос выполняется','Request in progress')}/>}
  {error&&<div className="notice dangernotice stack" role="alert" style={{gap:8}}>
   <span style={{overflowWrap:'anywhere'}}>{error.message}</span>
   {error.code==='CC_PREVIOUS_UNCONFIRMED'&&<label className="row tiny"><input type="checkbox" checked={previousAck} onChange={e=>setPreviousAck(e.target.checked)}/> {t('Я проверил панель CloudCompute: прошлого сервера там нет. Разрешить новое создание.','I checked the CloudCompute dashboard: the previous server is not there. Allow a new creation.')}</label>}
   {!!error.details?.alternatives?.length&&<div className="stack" style={{gap:6}}><b className="tiny">{t('Другие подходящие предложения (ваши фильтры сохранены):','Other matching offers (your filters are kept):')}</b>
    {error.details.alternatives.map(a=><div key={a.id} className="row tiny"><span className="grow" style={{overflowWrap:'anywhere'}}>{a.gpu} · {gbText(a.vram_mb)} · {offerLine(a)} · ID {a.id}</span><button onClick={()=>{choose(a);setError(null)}}>{t('Выбрать','Select')}</button></div>)}</div>}
  </div>}

  <div className="card stack" role="region" aria-label={t('Монитор доступности GPU','GPU availability monitor')}>
   <div className="row" style={{justifyContent:'space-between'}}><b>{t('МОНИТОР GPU','GPU MONITOR')}</b>
    <span className="tiny muted">{t('Обновлено','Updated')}: {clock(mon?.updated_at)}{mon?.cached?' · '+t('общий снимок','shared snapshot'):''}{mon?.stale?' · '+t('данные устарели','stale data'):''}</span></div>
   <div className="row">
    <button disabled={!!busy||!!mon?.rate_limit} onClick={()=>void refresh()}>{t('Обновить','Refresh')}</button>
    {mon?.auto.on?<button className="primary" disabled={busy==='auto'} onClick={()=>void setAuto(false)}>{t('Остановить мониторинг','Stop monitoring')}</button>
     :<button disabled={!!busy} onClick={()=>void setAuto(true)}>{t('Автообновление','Auto refresh')}</button>}
    <label className="row tiny">{t('каждые','every')} <select aria-label={t('Интервал','Interval')} value={mon?.settings.interval_s||60} onChange={e=>void saveSettings({interval_s:Number(e.target.value)})}>{[30,60,120,300,600].map(s=><option key={s} value={s}>{s<60?s+' с':s/60+' мин'}</option>)}</select></label>
    <label className="row tiny"><input type="checkbox" checked={!!mon?.settings.browser_notifications} onChange={e=>void toggleBrowser(e.target.checked)}/> {t('уведомления браузера','browser notifications')}</label>
   </div>
   {mon?.auto.on&&<p className="tiny muted">{t('Мониторинг работает на телефоне: следующий запрос','Monitoring runs on the phone: next request')} {clock(mon.auto.next_run_at)} · {t('остановится сам в','stops by itself at')} {clock(mon.auto.stops_at)}. {t('Аренда никогда не выполняется автоматически.','Nothing is ever rented automatically.')}</p>}
   {!mon?.auto.on&&mon?.auto.stop_reason&&<p className="tiny muted">{mon.auto.stop_reason}</p>}
   {mon?.rate_limit&&<p className="notice">{t(`CloudCompute ограничил частоту запросов: пауза ещё ${mon.rate_limit.retry_in_s} с.`,`CloudCompute rate limit: pausing for ${mon.rate_limit.retry_in_s} s.`)}</p>}
   {mon?.error&&!mon.rate_limit&&<p className="notice dangernotice">{mon.error.message}{mon.stale?' '+t('Показан последний успешный список.','The last successful list is shown.'):''}</p>}
   {pendingNotes.length>0&&<div className="stack" style={{gap:6}} role="status" aria-label={t('Новые подходящие GPU','New matching GPUs')}>
    {pendingNotes.map(n=><div key={n.key} className="notice row"><span className="grow" style={{overflowWrap:'anywhere'}}>★ {t('Новый подходящий GPU','New matching GPU')}: {n.offer.gpu} · {gbText(n.offer.vram_mb)} · {offerLine(n.offer)} · {clock(n.at)}</span>
     <button onClick={()=>{choose(n.offer);void ack([n.key])}}>{t('Выбрать','Select')}</button><button aria-label={t('Скрыть','Dismiss')} onClick={()=>void ack([n.key])}>✕</button></div>)}
   </div>}
   {f&&<details><summary className="tiny">{t('Фильтры','Filters')}: {f.gpu_count} GPU · ≥{f.min_vram_gb} ГБ ({t('желательно','preferred')} {f.preferred_vram_gb}) · ≤{f.max_price_rub} ₽/ч · {t('диск','disk')} ≥{f.min_disk_gb} ГБ</summary>
    <div className="stack" style={{marginTop:10}}>
     <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:10}}>
      <label className="field">{t('Число GPU','GPU count')}<input type="number" inputMode="numeric" min={1} max={16} value={f.gpu_count} onChange={e=>setF('gpu_count',e.target.value)}/></label>
      <label className="field">{t('VRAM от, ГБ','Min VRAM, GB')}<input type="number" inputMode="numeric" min={8} value={f.min_vram_gb} onChange={e=>setF('min_vram_gb',e.target.value)}/></label>
      <label className="field">{t('Желательно VRAM, ГБ','Preferred VRAM, GB')}<input type="number" inputMode="numeric" min={8} value={f.preferred_vram_gb} onChange={e=>setF('preferred_vram_gb',e.target.value)}/></label>
      <label className="field">{t('Цена GPU до, ₽/ч','Max GPU price, RUB/h')}<input type="number" inputMode="decimal" min={1} step="0.5" value={f.max_price_rub} onChange={e=>setF('max_price_rub',e.target.value)}/></label>
      <label className="field">{t('Диск от, ГБ','Min disk, GB')}<input type="number" inputMode="numeric" min={mon?.requirements.min_disk_gb||40} value={f.min_disk_gb} onChange={e=>setF('min_disk_gb',e.target.value)}/></label>
      <label className="field">{t('Название содержит','Name contains')}<input value={f.name} maxLength={40} placeholder="4090" onChange={e=>setF('name',e.target.value)}/></label>
      <label className="field">{t('Сортировка','Sort')}<select value={f.sort} onChange={e=>setF('sort',e.target.value)}><option value="price">{t('цена','price')}</option><option value="preferred">{t('желательный VRAM','preferred VRAM')}</option><option value="vram">VRAM</option><option value="reliability">{t('надёжность','reliability')}</option><option value="newest">{t('новые','newest')}</option></select></label>
     </div>
     <label className="row tiny"><input type="checkbox" checked={f.require_known_cuda} onChange={e=>setF('require_known_cuda',e.target.checked)}/> {t('Только с указанной версией CUDA (образу нужна 12.8+)','Only with a reported CUDA version (the image needs 12.8+)')}</label>
     <p className="tiny muted">{t('Незнакомые модели GPU не отбрасываются: совместимость оценивается по VRAM/CUDA из API, а движок проверяет GPU при запуске. Нестандартный объём VRAM отмечается предупреждением.','Unfamiliar GPU models are not discarded: compatibility is judged by the API VRAM/CUDA fields and the engine checks the GPU at start. Unusual VRAM sizes are flagged.')}</p>
     <div className="row"><button disabled={!!busy} onClick={()=>void saveSettings({filters:f})}>{t('Применить фильтры','Apply filters')}</button><button disabled={!!busy} onClick={()=>mon&&setDraft(mon.settings.filters)}>{t('Отменить изменения','Discard changes')}</button></div>
    </div></details>}
   {mon&&mon.updated_at!=null&&<>
    <div className="row" style={{justifyContent:'space-between'}}><span className="tiny">{t('Подходит','Matching')}: <b>{mon.matching}</b> {t('из','of')} {mon.total}</span><label className="row tiny"><input type="checkbox" checked={showAll} onChange={e=>setShowAll(e.target.checked)}/> {t('Показать неподходящие','Show unsuitable')}</label></div>
    {!offers.length&&<p className="notice">{t('Сейчас нет предложений под ваши фильтры. Включите автообновление — приложение сообщит о новом подходящем GPU.','No offers match your filters now. Turn on auto refresh — the app will tell you about a new matching GPU.')}</p>}
    <div className="stack" role="list">{offers.slice(0,40).map(o=><div role="listitem" key={o.id} className="card stack" style={{gap:8,borderColor:selected?.id===o.id?'var(--orange)':undefined}}>
     <div className="row" style={{justifyContent:'space-between'}}><b style={{overflowWrap:'anywhere'}}>{o.gpus>1?o.gpus+' × ':''}{o.gpu}{o.match?.preferred?' ★':''}{o.taken?' · '+t('ЗАНЯТ','TAKEN'):''}</b><b style={{color:'var(--gold)'}}>{offerLine(o)}</b></div>
     <div className="tiny muted">VRAM {gbText(o.vram_mb)} · {t('диск до','disk up to')} {o.disk_gb!=null?Math.floor(o.disk_gb)+' ГБ':'—'}{o.cuda!=null?' · CUDA '+o.cuda:''}{o.model?' · sm_'+o.model.cc.replace('.',''):''}{o.reliability!=null?' · '+t('надёжность','reliability')+' '+o.reliability+'%':''}{o.location?' · '+o.location:''}</div>
     {(o.match?.reasons||o.reasons).slice(0,4).map(r=><div key={r} className="tiny danger">✖ {r}</div>)}{o.warnings.map(w=><div key={w} className="tiny muted">⚠ {w}</div>)}
     <button className={selected?.id===o.id?'primary':''} disabled={!o.compatible||o.taken} aria-pressed={selected?.id===o.id} onClick={()=>choose(o)}>{selected?.id===o.id?t('Выбрано','Selected'):t('Выбрать','Select')} · ID {o.id}</button>
    </div>)}</div>
    {mon.gone.length>0&&<details><summary className="tiny">{t('Недавно исчезли','Recently disappeared')} ({mon.gone.length})</summary><div className="stack" style={{gap:4,marginTop:8}}>{mon.gone.map(g=><span key={g.id+'-'+g.gone_at} className="tiny muted">{clock(g.gone_at)} · {g.gpu} · {gbText(g.vram_mb)} · {offerLine(g)} · ID {g.id}</span>)}</div></details>}
   </>}
  </div>

  {selected&&<div className="card stack" aria-label={t('Итоговая конфигурация и подтверждение','Final configuration and confirmation')}>
   <b>{t('Выбрано','Selected')}: {selected.gpu} · {gbText(selected.vram_mb)} VRAM · Offer ID {selected.id}</b>
   <label className="field">{t('Диск, ГБ','Disk, GB')}<input type="number" inputMode="numeric" min={mon?.requirements.min_disk_gb||40} value={disk} onChange={e=>{setDisk(e.target.value);setQuote(null)}}/></label>
   <p className="tiny muted">{t(`Образ движка ≈ ${mon?.requirements.image_size_note_gb||13} ГБ на диске + модели (SDXL checkpoint ≈ 6,5 ГБ, ControlNet ≈ 2,5 ГБ, LoRA 0,1–0,9 ГБ) + кэш.`,`Engine image ≈ ${mon?.requirements.image_size_note_gb||13} GB on disk + models (SDXL checkpoint ≈ 6.5 GB, ControlNet ≈ 2.5 GB, LoRA 0.1–0.9 GB) + cache.`)}</p>
   <label className="row tiny"><input type="checkbox" checked={autoSync} onChange={e=>setAutoSync(e.target.checked)}/> {t('После запуска скачать модели, выбранные в «Модели → Google Drive» (уже имеющиеся не скачиваются; без выбора ничего не скачивается)','After start, download the models selected in “Models → Google Drive” (installed ones are skipped; nothing is downloaded without a selection)')}</label>
   {!quote&&<button className="primary" disabled={!!busy} onClick={()=>void prepare()}>{t('Проверить предложение в CloudCompute','Verify the offer with CloudCompute')}</button>}
   {quote&&<div className="stack" style={{gap:8}} role="region" aria-label={t('Итоговая конфигурация','Final configuration')}>
    <b className="tiny">{t('ИТОГОВАЯ КОНФИГУРАЦИЯ (проверено в','FINAL CONFIGURATION (checked at')} {clock(quote.checked_at)})</b>
    <div className="tiny">GPU: <b>{quote.gpus>1?quote.gpus+' × ':''}{quote.gpu}</b>{quote.model?` (${quote.model.label}, sm_${quote.model.cc.replace('.','')})`:''} · VRAM {gbText(quote.vram_mb)}{quote.cuda!=null?' · CUDA '+quote.cuda:''}</div>
    <div>{t('Цена GPU','GPU price')}: {price?<b>{money(price.minor!,price.currency)} {t('в час','per hour')}</b>:<b className="danger">{t('не подтверждена','not verified')}</b>} {price&&<span className="tiny muted">({t('поле API','API field')} {price.field}{price.basis?' · '+price.basis:''})</span>}</div>
    {price&&<div className="tiny">{t('Оценка без хранения диска','Estimate without disk storage')}: 1 {t('ч','h')} ≈ {money(price.minor!,price.currency)} · 3 {t('ч','h')} ≈ {money(price.minor!*3,price.currency)} · 8 {t('ч','h')} ≈ {money(price.minor!*8,price.currency)}</div>}
    <div className="tiny">{t('Диск','Disk')}: {quote.disk_gb} ГБ {quote.offer_disk_gb!=null?`(${t('предел предложения','offer limit')} ${Math.floor(quote.offer_disk_gb)} ГБ)`:''} · {t('Хранение','Storage')}: {quote.storage.length?quote.storage.map(s=>`${s.field} = ${s.value}`).join(' · ')+t(' (единицы API не описаны)',' (units not documented)'):t('API не сообщает стоимость хранения — проверьте в панели CloudCompute','storage price not reported by the API — check the dashboard')}</div>
    <div className="tiny">{t('Образ','Image')}: <code style={{overflowWrap:'anywhere'}}>{quote.image}</code> — {(quote.image_check.accessible?'✔ ':'✖ ')+quote.image_check.message}</div>
    <div className="tiny">{t('Профиль инициализации CloudCompute','CloudCompute bootstrap profile')}: <b>{quote.bootstrap_profile}</b> · onstart {quote.onstart_bytes} {t('байт из бюджета','bytes of the budget')} {quote.onstart_budget_bytes} ({t('общий лимит','combined limit')} {quote.onstart_limit_bytes})</div>
    {quote.warnings.map(w=><div key={w} className="tiny muted">⚠ {w}</div>)}
    {quote.issues.map(w=><div key={w} className="tiny danger">✖ {w}</div>)}
    <p className="tiny notice">{quote.note}</p>
    <label className="row tiny"><input type="checkbox" checked={understood} onChange={e=>setUnderstood(e.target.checked)}/> {t('Понимаю: оплата начинается сразу после создания и идёт, пока инстанс существует. «Отключиться» и закрытие приложения её не останавливают. Данные пользователя автоматически не удаляются.','I understand: billing starts right after creation and continues while the instance exists. Disconnecting or closing the app does not stop it. User data is never deleted automatically.')}</label>
    <div className="row"><button className={canCreate?'primary':''} disabled={!canCreate} onClick={()=>void create()}>{busy==='create'?t('Создаю… (повторная отправка заблокирована)','Creating… (resubmission blocked)'):t('Подтвердить аренду','Confirm rental')}</button><button disabled={!!busy} onClick={()=>void prepare()}>{t('Проверить заново','Verify again')}</button></div>
   </div>}
  </div>}

  {deployment&&<div className="card stack" role="status" aria-label={t('Ход инициализации','Initialization progress')}>
   <b style={{overflowWrap:'anywhere'}}>{deployment.name||'YOISAKI'} · #{deployment.instance_id}{deployment.offer?' · '+deployment.offer.gpu:''}{deployment.offer?.price_minor!=null?' · '+money(deployment.offer.price_minor,deployment.offer.currency)+t('/час','/hour'):''}</b>
   <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:10}}>
    {tile(t('ИНСТАНС CLOUDCOMPUTE','CLOUDCOMPUTE INSTANCE'),deployment.instance_running?true:deployment.provider?.phase==='FAILED'||deployment.provider?.phase==='GONE'||deployment.provider?.phase==='STOPPED'?false:null,
     deployment.pending?t('создание не подтверждено','creation unconfirmed'):deployment.instance_running?t('работает','running'):deployment.instance_status||t('нет данных','no data'),
     `${t('статус провайдера','provider status')}: ${deployment.instance_status||'—'} · ${clock(deployment.provider?.checked_at)}`)}
    {tile('YOISAKI ENGINE',deployment.engine_ready&&connected?true:failed||deployment.failure?.terminal?false:null,deployment.engine_ready?t('готов (проверка пройдена)','ready (health check passed)'):t('не готов','not ready'),
     stageNames[shownStage]||deployment.stage)}
   </div>
   <ol className="tiny" style={{margin:0,paddingLeft:18}}>{FLOW.map((s,i)=><li key={s} style={{opacity:i<=stageIndex?1:.45,fontWeight:s===shownStage?700:400}}>{(i<stageIndex||shownStage==='GPU_READY')&&s!==shownStage?(stageAt(s)?'✔ ':'↷ '):s===shownStage?(failed?'✖ ':shownStage==='GPU_READY'?'✔ ':'… '):''}{stageNames[s]}{stageAt(s)?' · '+clock(stageAt(s)):i<stageIndex?' · '+t('не наблюдался','not observed'):''}</li>)}</ol>
   {deployment.stage_message&&<p className={failed?'notice dangernotice':'tiny'}>{deployment.stage_message}</p>}
   {deployment.failure&&<div className={deployment.failure.terminal?'notice dangernotice':'notice'}><b>{t('Где сбой','Failure location')}: {t2(deployment.failure.component)}</b> · {deployment.failure.code}{deployment.failure.message?' — '+deployment.failure.message:''}{deployment.failure.terminal?' '+t('Автоматически это не исправится.','This will not recover by itself.'):''}</div>}
   <div className="tiny muted">{t('Профиль инициализации','Bootstrap profile')}: {deployment.bootstrap_profile||t('не записан','not recorded')}{deployment.url_host?' · '+t('адрес движка','engine address')+' '+deployment.url_host:''}{deployment.watching?' · '+t('наблюдение активно','watching'):''}{deployment.provider?.message?' · '+deployment.provider.message:''}</div>
   {deployment.error&&<p className="tiny danger">{deployment.error}</p>}
   {deployment.terminal&&<p className="tiny">{t('Веб-терминал','Web terminal')}: <b>{deployment.terminal.state==='AVAILABLE'?t('доступен','available'):t('недоступен','unavailable')}</b> · {deployment.terminal.message} · {clock(deployment.terminal.checked_at)}{deployment.terminal.state!=='AVAILABLE'&&deployment.bootstrap_profile==='worker'?' '+t('(профиль worker может не включать терминал — это не ошибка движка)','(the worker profile may not include a terminal — not an engine error)'):''}</p>}
   {deployment.drive&&<p className={deployment.drive.state==='ERROR'?'notice dangernotice':'tiny'}>{t('Модели','Models')}: {deployment.drive.message}{deployment.drive.summary?` (${t('есть','present')} ${deployment.drive.summary.installed}, ${t('не хватает','missing')} ${deployment.drive.summary.missing}${deployment.drive.summary.missing?', '+bytesText(deployment.drive.summary.missing_bytes):''})`:''}</p>}
   {deployment.stage==='GPU_READY'&&connected&&<p className="tiny">{t('Готово: откройте «Генерация». Оплата продолжается, пока инстанс существует — остановите или удалите его, когда закончите.','Ready: open Generate. Billing continues while the instance exists — stop or delete it when done.')}</p>}
   <div className="row"><button disabled={!!busy||deployment.pending} onClick={()=>void terminal()}>{t('Проверить веб-терминал','Check web terminal')}</button></div>
  </div>}

  <div className="row"><button disabled={!!busy} onClick={()=>void diagnostics()}>{t('Скачать диагностику (JSON)','Download diagnostics (JSON)')}</button><a className="btn" href={DASHBOARD} target="_blank" rel="noopener noreferrer">{t('Открыть панель CloudCompute','Open CloudCompute dashboard')}</a></div>
  <p className="tiny muted">{t('Диагностика не содержит API-ключа CloudCompute, токена движка, токенов Google и SSH-ключей. Остановить инстанс можно в панели CloudCompute (оплата GPU прекращается, хранение диска может оплачиваться). «Удалить инстанс» ниже прекращает оплату и удаляет его диск. «Отключиться» не останавливает оплату.','The diagnostics contain no CloudCompute API key, engine token, Google tokens or SSH keys. Stop the instance in the CloudCompute dashboard (GPU billing stops, disk storage may still be billed). «Delete instance» below stops billing and deletes its disk. «Disconnect» does not stop billing.')}</p>

  <details><summary className="tiny">{t('Расширенные настройки запуска','Advanced launch settings')}</summary><div className="stack" style={{marginTop:12}}>
   <label className="field">{t('Docker-образ движка','Engine Docker image')}<input value={image} placeholder={defaultImage} spellCheck={false} onChange={e=>{setImage(e.target.value);setQuote(null)}}/></label>
   <div className="tiny muted">{t('Используется','In use')}: <code style={{overflowWrap:'anywhere'}}>{effectiveImage}</code></div>
   <label className="row tiny"><input type="checkbox" checked={skipCheck} onChange={e=>{setSkipCheck(e.target.checked);setQuote(null)}}/> {t('Не проверять публичную доступность образа (только для собственного реестра)','Skip the public image check (own registry only)')}</label>
   <label className="field">{t('Профиль инициализации CloudCompute (bootstrap_profile)','CloudCompute bootstrap profile (bootstrap_profile)')}<select value={profile} onChange={e=>{setProfile(e.target.value);setQuote(null)}}>{PROFILES.map(p=><option key={p} value={p}>{p==='provider_default'?t('по умолчанию провайдера (как в 1.7.6)','provider default (as in 1.7.6)'):p}</option>)}</select></label>
   <p className="tiny muted">{t('worker — рекомендуется для образа YOISAKI: образ сам запускает движок, SSH/Jupyter не нужны. access_only / full добавляют доступ (веб-терминал, SSH) — выберите, если нужен терминал для ручной диагностики. Поведение профилей на реальном инстансе ещё не подтверждено.','worker — recommended for the YOISAKI image: it starts the engine itself, no SSH/Jupyter needed. access_only / full add access (web terminal, SSH) — choose them if you need a terminal for manual diagnostics. Profile behaviour on a real instance is not confirmed yet.')}</p>
   <div className="card stack">
    <b className="tiny">{t('Подготовить уже существующий инстанс','Prepare an existing instance')}</b>
    <p className="tiny muted">{t('Для инстанса, созданного не здесь: сайт выдаст новый токен и одну команду для веб-терминала инстанса в панели CloudCompute (вставить один раз). Команда содержит токен — не публикуйте её.','For an instance created elsewhere: the app issues a new token and one command for the instance web terminal in the CloudCompute dashboard (paste once). It contains the token — do not share it.')}</p>
    <label className="field">{t('ID инстанса','Instance ID')}<input value={adoptId} inputMode="numeric" onChange={e=>setAdoptId(e.target.value.trim())}/></label>
    <button disabled={!!busy||!/^[A-Za-z0-9_-]{1,100}$/.test(adoptId)} onClick={()=>void run('adopt',async()=>{if(!confirm(t(`Подготовить инстанс #${adoptId} для YOISAKI ENGINE? Будет выдан новый токен движка.`,`Prepare instance #${adoptId} for YOISAKI ENGINE? A new engine token is issued.`)))return;const r=await localApi<{deployment:Deployment;command:string}>('/api/cloudcompute/deploy/adopt',{method:'POST',body:JSON.stringify({confirm:true,instance_id:adoptId,auto_sync:autoSync,...(image.trim()?{image:image.trim()}:{})})});setDeployment(r.deployment);setCommand(r.command)})}>{t('Получить команду','Get the command')}</button>
    {command&&<><textarea readOnly value={command} aria-label={t('Команда для веб-терминала','Web terminal command')} style={{minHeight:140,fontSize:11}}/><button onClick={()=>void navigator.clipboard.writeText(command).catch(()=>{})}>{t('Скопировать команду','Copy command')}</button><button onClick={()=>setCommand('')}>{t('Скрыть команду','Hide command')}</button></>}
   </div>
   {deployment&&<button disabled={!!busy} onClick={()=>void run('forget',async()=>{if(!confirm(t('Забыть этот GPU-сервер на телефоне? Инстанс в CloudCompute НЕ удаляется и продолжает оплачиваться, пока существует.','Forget this GPU server on the phone? The CloudCompute instance is NOT deleted and stays billed while it exists.')))return;await localApi('/api/cloudcompute/deploy',{method:'DELETE',body:JSON.stringify({confirm:true})});setDeployment(null)})}>{t('Забыть сервер на телефоне','Forget server on this phone')}</button>}
  </div></details>
 </section>;
}

import {useEffect,useRef,useState} from 'react';
import {localApi} from '@/lib/local-api';
import {useStudio} from '@/stores/studio';
import {useDirect} from '@/lib/engine/direct';

// v1.7.5 zero-terminal CloudCompute: select GPU → create GPU server → initialize engine → connect → sync models.
// Every price and every stage shown here comes from the CloudCompute API or from a stage signed by the engine.
type Price={minor:number|null;raw?:number;currency:string;field:string;verified:boolean;basis:string};
type Offer={id:number;gpu:string;gpus:number;vram_mb:number|null;price:Price|null;storage:{field:string;value:number}[];disk_gb:number|null;cuda:number|null;reliability:number|null;location:string;inet_down_mbps:number|null;compatible:boolean;reasons:string[];warnings:string[]};
type Requirements={min_vram_mb:number;recommended_vram_mb:number;min_cuda:number;min_disk_gb:number;default_disk_gb:number;image_size_note_gb:number};
type DriveState={state:string;message:string;summary?:{installed:number;missing:number;missing_bytes:number}|null}|null;
type Deployment={instance_id:string;name:string;image:string;created_at:number;adopted:boolean;offer:{gpu:string;vram_mb:number|null;price_minor:number|null;currency:string}|null;disk_gb:number|null;auto_sync:boolean;
 stage:string;stage_message:string;error:string;instance_status:string;url_found:boolean;url_host:string;gpu_stages:{stage:string;ts:number}[];drive:DriveState;watching:boolean};
type ImageCheck={image:string;checked:boolean;accessible:boolean|null;message:string};
const FLOW=['GPU_CREATED','INSTANCE_INITIALIZING','DOCKER_IMAGE_READY','ENGINE_STARTING','ENGINE_HEALTH_CHECK','GPU_READY'];
const DASHBOARD='https://app.cloudcompute.ru/';

export function money(minor:number,currency:string){const v=(minor/100).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});return currency==='RUB'?v+' ₽':v+' '+currency}
const gbText=(mb:number|null)=>mb==null?'—':Math.round(mb/1024)+' ГБ';
const bytesText=(n:number)=>(n/1073741824).toFixed(n>=10737418240?0:1)+' ГБ';

export function CloudComputeDeploy({onInstancesChanged}:{onInstancesChanged:()=>void}){
 const en=useStudio(s=>s.language)==='English',t=(r:string,e:string)=>en?e:r;
 const gpu=useDirect();
 const [offers,setOffers]=useState<Offer[]|null>(null),[requirements,setRequirements]=useState<Requirements|null>(null),[selected,setSelected]=useState<Offer|null>(null);
 const [disk,setDisk]=useState('80'),[autoSync,setAutoSync]=useState(true),[understood,setUnderstood]=useState(false);
 const [deployment,setDeployment]=useState<Deployment|null>(null),[defaultImage,setDefaultImage]=useState(''),[image,setImage]=useState(''),[skipCheck,setSkipCheck]=useState(false),[check,setCheck]=useState<ImageCheck|null>(null);
 const [busy,setBusy]=useState(''),[error,setError]=useState(''),[adoptId,setAdoptId]=useState(''),[command,setCommand]=useState(''),[showAll,setShowAll]=useState(false);
 const loading=useRef(false);
 const effectiveImage=image.trim()||defaultImage;
 async function load(){if(loading.current)return;loading.current=true;try{const r=await localApi<{deployment:Deployment|null;default_image:string;requirements:Requirements}>('/api/cloudcompute/deploy');setDeployment(r.deployment);setDefaultImage(r.default_image);setRequirements(r.requirements)}catch(e){setError((e as Error).message)}finally{loading.current=false}}
 useEffect(()=>{void load()},[]);
 const active=!!deployment&&(deployment.watching||!['GPU_READY','FAILED','TIMEOUT','INSTANCE_GONE'].includes(deployment.stage)||['BINDING','CHECKING','SYNCING'].includes(deployment.drive?.state||''));
 useEffect(()=>{if(!active)return;const id=setInterval(()=>{if(document.visibilityState==='visible'){void load();void gpu.poll()}},4000);return ()=>clearInterval(id)},[active]);
 useEffect(()=>{if(!effectiveImage)return;let live=true;localApi<ImageCheck>('/api/cloudcompute/image?image='+encodeURIComponent(effectiveImage)).then(r=>{if(live)setCheck(r)}).catch(e=>{if(live)setCheck({image:effectiveImage,checked:false,accessible:null,message:(e as Error).message})});return ()=>{live=false}},[effectiveImage]);
 async function run(name:string,fn:()=>Promise<unknown>){setBusy(name);setError('');try{await fn()}catch(e){setError((e as Error).message)}finally{setBusy('')}}
 const loadOffers=()=>run('offers',async()=>{const r=await localApi<{offers:Offer[];requirements:Requirements;rejected:number}>('/api/cloudcompute/offers');setOffers(r.offers);setRequirements(r.requirements);if(selected)setSelected(r.offers.find(o=>o.id===selected.id)||null)});
 const diskNumber=Math.round(Number(disk));
 const diskError=!requirements?'':!Number.isFinite(diskNumber)||diskNumber<requirements.min_disk_gb?t(`Не меньше ${requirements.min_disk_gb} ГБ`,`At least ${requirements.min_disk_gb} GB`):selected?.disk_gb!=null&&diskNumber>selected.disk_gb?t(`Предложение даёт до ${Math.floor(selected.disk_gb)} ГБ`,`The offer allows up to ${Math.floor(selected.disk_gb)} GB`):'';
 const price=selected?.price?.verified&&selected.price.minor!=null?selected.price:null;
 const imageOk=check?.accessible===true||skipCheck;
 const canCreate=!!selected&&!!price&&selected.compatible&&understood&&!diskError&&imageOk&&!busy;
 const create=()=>run('create',async()=>{
  if(!selected||!price)return;
  const text=t(`Создать ПЛАТНЫЙ GPU-сервер?\n\n${selected.gpu} · ${gbText(selected.vram_mb)} VRAM\nЦена GPU: ${money(price.minor!,price.currency)} в час (данные CloudCompute)\nДиск: ${diskNumber} ГБ${selected.storage.length?'':' (стоимость хранения API не сообщил — проверьте в панели)'}\n\nОплата начинается сразу и идёт, пока инстанс существует. «Отключиться» её не останавливает.`,
   `Create a PAID GPU server?\n\n${selected.gpu} · ${gbText(selected.vram_mb)} VRAM\nGPU price: ${money(price.minor!,price.currency)} per hour (CloudCompute data)\nDisk: ${diskNumber} GB\n\nBilling starts immediately and runs while the instance exists. Disconnecting does not stop it.`);
  if(!confirm(text))return;
  const body={confirm:true,offer_id:selected.id,accepted_price_minor:price.minor,currency:price.currency,disk_gb:diskNumber,auto_sync:autoSync,...(image.trim()?{image:image.trim()}:{}),...(skipCheck?{skip_image_check:true}:{}),...(deployment&&!['FAILED','TIMEOUT','INSTANCE_GONE'].includes(deployment.stage)?{additional:true}:{})};
  if(body.additional&&!confirm(t(`Уже есть GPU-сервер #${deployment!.instance_id}. Он тоже оплачивается. Создать ещё один?`,`GPU server #${deployment!.instance_id} already exists and is billed too. Create another one?`)))return;
  try{const r=await localApi<{deployment:Deployment}>('/api/cloudcompute/deploy',{method:'POST',body:JSON.stringify(body)});setDeployment(r.deployment);setUnderstood(false);setOffers(null);setSelected(null)}finally{onInstancesChanged();void load()}
 });
 const watch=()=>run('watch',async()=>{const r=await localApi<{deployment:Deployment}>('/api/cloudcompute/deploy/watch',{method:'POST'});setDeployment(r.deployment)});
 const connect=()=>run('connect',async()=>{const r=await localApi<{deployment:Deployment}>('/api/cloudcompute/deploy/connect',{method:'POST'});setDeployment(r.deployment);await gpu.poll()});
 const sync=()=>run('sync',async()=>{const r=await localApi<{deployment:Deployment}>('/api/cloudcompute/deploy/sync',{method:'POST',body:JSON.stringify({download:true})});setDeployment(r.deployment)});
 const connected=gpu.provider==='cloudcompute'&&!!gpu.url;
 const stageIndex=deployment?FLOW.indexOf(deployment.stage):-1;
 const stageNames:Record<string,string>={GPU_CREATED:t('GPU-сервер создан','GPU created'),INSTANCE_INITIALIZING:t('Инстанс запускается','Instance initializing'),DOCKER_IMAGE_READY:t('Образ Docker готов','Docker image ready'),ENGINE_STARTING:t('YOISAKI ENGINE запускается','YOISAKI ENGINE starting'),ENGINE_HEALTH_CHECK:t('Проверка движка','Engine health check'),GPU_READY:t('GPU готов','GPU ready')};
 const failed=deployment&&['FAILED','TIMEOUT','INSTANCE_GONE'].includes(deployment.stage);
 const visibleOffers=(offers||[]).filter(o=>showAll||o.compatible);
 return <section className="panel stack" data-localized="true" aria-label={t('CloudCompute: запуск GPU','CloudCompute: GPU launch')}>
  <h2>CLOUDCOMPUTE</h2>
  <p className="tiny muted">{t('Аренда GPU и запуск YOISAKI ENGINE без SSH, Python и Termux. Управление арендой (API-ключ) и связь с движком (токен движка) — отдельные вещи: ключ CloudCompute никогда не передаётся на GPU.','Rent a GPU and start YOISAKI ENGINE without SSH, Python or Termux. Rental management (API key) and the engine connection (engine token) are separate: the CloudCompute key never reaches the GPU.')}</p>

  <div className="stack" role="group" aria-label={t('Шаги запуска','Launch steps')}>
   <button className={!deployment||failed?'primary':''} disabled={!!busy} onClick={()=>void loadOffers()}>{t('1. Выбрать GPU','1. Select GPU')}</button>
   <button className={canCreate?'primary':''} disabled={!canCreate} onClick={()=>void create()}>{t('2. Создать GPU-сервер','2. Create GPU server')}</button>
   <button disabled={!!busy||!deployment||deployment.stage==='GPU_READY'&&connected} onClick={()=>void watch()}>{t('3. Инициализировать движок','3. Initialize engine')}</button>
   <button className={deployment?.url_found&&!connected?'primary':''} disabled={!!busy||!deployment||connected} onClick={()=>void connect()}>{t('4. Подключить','4. Connect')}</button>
   <button className={connected&&deployment?.drive?.state==='READY_TO_SYNC'?'primary':''} disabled={!!busy||!connected||!deployment||['BINDING','CHECKING','SYNCING'].includes(deployment.drive?.state||'')} onClick={()=>void sync()}>{t('5. Синхронизировать модели','5. Sync models')}</button>
  </div>
  {busy&&<progress aria-label={t('Запрос выполняется','Request in progress')}/>}
  {error&&<p className="notice dangernotice" role="alert">{error}</p>}

  {offers&&<div className="stack" aria-label={t('Предложения GPU','GPU offers')}>
   <div className="row" style={{justifyContent:'space-between'}}><b>{t('Доступные GPU','Available GPUs')}</b><label className="row tiny"><input type="checkbox" checked={showAll} onChange={e=>setShowAll(e.target.checked)}/> {t('Показать неподходящие','Show unsuitable')}</label></div>
   {!visibleOffers.length&&<p className="notice">{t('CloudCompute не вернул подходящих предложений (нужно ≥12 ГБ VRAM, CUDA 12.8+, подтверждённая цена). Попробуйте позже или откройте панель CloudCompute.','CloudCompute returned no suitable offers (≥12 GB VRAM, CUDA 12.8+, verified price). Try again later or open the CloudCompute dashboard.')}</p>}
   <div className="stack" role="list">{visibleOffers.slice(0,40).map(o=><div role="listitem" key={o.id} className="card stack" style={{gap:8,borderColor:selected?.id===o.id?'var(--orange)':undefined}}>
    <div className="row" style={{justifyContent:'space-between'}}><b style={{overflowWrap:'anywhere'}}>{o.gpus>1?o.gpus+' × ':''}{o.gpu}</b><b style={{color:'var(--gold)'}}>{o.price?.minor!=null?money(o.price.minor,o.price.currency)+t('/час','/hour'):o.price?t('цена не подтверждена','price unverified'):t('нет цены','no price')}</b></div>
    <div className="tiny muted">VRAM {gbText(o.vram_mb)} · {t('диск до','disk up to')} {o.disk_gb!=null?Math.floor(o.disk_gb)+' ГБ':'—'}{o.cuda!=null?' · CUDA '+o.cuda:''}{o.reliability!=null?' · '+t('надёжность','reliability')+' '+o.reliability+'%':''}{o.location?' · '+o.location:''}{o.inet_down_mbps!=null?' · ↓'+Math.round(o.inet_down_mbps)+' Мбит/с':''}</div>
    {o.reasons.map(r=><div key={r} className="tiny danger">✖ {r}</div>)}{o.warnings.map(w=><div key={w} className="tiny muted">⚠ {w}</div>)}
    <button className={selected?.id===o.id?'primary':''} disabled={!o.compatible} aria-pressed={selected?.id===o.id} onClick={()=>{setSelected(o);setUnderstood(false);if(requirements)setDisk(String(Math.min(requirements.default_disk_gb,o.disk_gb!=null?Math.floor(o.disk_gb):requirements.default_disk_gb)))}}>{selected?.id===o.id?t('Выбрано','Selected'):t('Выбрать','Select')} · ID {o.id}</button>
   </div>)}</div>
  </div>}

  {selected&&<div className="card stack" aria-label={t('Стоимость и подтверждение','Cost and confirmation')}>
   <b>{t('Выбрано','Selected')}: {selected.gpu} · {gbText(selected.vram_mb)} VRAM · Offer ID {selected.id}</b>
   {price?<>
    <div>{t('Цена GPU','GPU price')}: <b>{money(price.minor!,price.currency)} {t('в час','per hour')}</b> <span className="tiny muted">({t('поле API','API field')} {price.field}{price.basis?' · '+price.basis:''})</span></div>
    <div className="tiny">{t('Оценка без хранения диска','Estimate without disk storage')}: 1 {t('ч','h')} ≈ {money(price.minor!,price.currency)} · 3 {t('ч','h')} ≈ {money(price.minor!*3,price.currency)} · 8 {t('ч','h')} ≈ {money(price.minor!*8,price.currency)}</div>
   </>:<p className="notice">{t('Цена этого предложения не подтверждена: создание отсюда недоступно.','This offer has no verified price: creation from here is disabled.')}</p>}
   <div className="tiny">{t('Хранение диска','Disk storage')}: {selected.storage.length?selected.storage.map(s=>`${s.field} = ${s.value}`).join(' · ')+t(' (единицы API не описаны; итог — в панели CloudCompute)',' (units not documented; see the dashboard)'):t('API не сообщает стоимость хранения — проверьте её в панели CloudCompute. Хранение может оплачиваться и у остановленного инстанса.','The API does not report the storage price — check it in the CloudCompute dashboard. Storage may be billed even for a stopped instance.')}</div>
   <label className="field">{t('Диск, ГБ','Disk, GB')}<input type="number" inputMode="numeric" min={requirements?.min_disk_gb||40} value={disk} onChange={e=>setDisk(e.target.value)}/></label>
   <p className="tiny muted">{t(`Образ движка ≈ ${requirements?.image_size_note_gb||11} ГБ на диске + модели (SDXL checkpoint ≈ 6,5 ГБ, ControlNet ≈ 2,5 ГБ, LoRA 0,1–0,9 ГБ) + кэш. Рекомендуется ${requirements?.default_disk_gb||80} ГБ.`,`Engine image ≈ ${requirements?.image_size_note_gb||11} GB on disk + models (SDXL checkpoint ≈ 6.5 GB, ControlNet ≈ 2.5 GB, LoRA 0.1–0.9 GB) + cache. ${requirements?.default_disk_gb||80} GB recommended.`)}</p>
   {diskError&&<p className="tiny danger">{diskError}</p>}
   <div className="tiny">{t('Образ','Image')}: <code style={{overflowWrap:'anywhere'}}>{effectiveImage}</code> — {check?(check.accessible?'✔ ':'✖ ')+check.message:t('проверяю…','checking…')}</div>
   <label className="row tiny"><input type="checkbox" checked={autoSync} onChange={e=>setAutoSync(e.target.checked)}/> {t('После запуска скачать недостающие модели из выбранной папки Google Drive (уже имеющиеся не скачиваются)','After start, download missing models from the selected Google Drive folder (existing ones are skipped)')}</label>
   <label className="row tiny"><input type="checkbox" checked={understood} onChange={e=>setUnderstood(e.target.checked)}/> {t('Понимаю: оплата начинается сразу после создания и идёт, пока инстанс существует. «Отключиться» и закрытие приложения её не останавливают. Данные пользователя автоматически не удаляются.','I understand: billing starts right after creation and continues while the instance exists. Disconnecting or closing the app does not stop it. User data is never deleted automatically.')}</label>
  </div>}

  {deployment&&<div className="card stack" role="status" aria-label={t('Ход инициализации','Initialization progress')}>
   <b style={{overflowWrap:'anywhere'}}>{deployment.name||'YOISAKI'} · #{deployment.instance_id}{deployment.offer?' · '+deployment.offer.gpu:''}{deployment.offer?.price_minor!=null?' · '+money(deployment.offer.price_minor,deployment.offer.currency)+t('/час','/hour'):''}</b>
   <ol className="tiny" style={{margin:0,paddingLeft:18}}>{FLOW.map((s,i)=><li key={s} style={{opacity:i<=stageIndex||failed?1:.45,fontWeight:s===deployment.stage?700:400}}>{i<stageIndex||deployment.stage==='GPU_READY'?'✔ ':s===deployment.stage?'… ':''}{stageNames[s]}</li>)}</ol>
   {deployment.stage_message&&<p className={failed?'notice dangernotice':'tiny'}>{deployment.stage_message}</p>}
   <div className="tiny muted">{t('Статус в CloudCompute','CloudCompute status')}: {deployment.instance_status||'—'}{deployment.url_host?' · '+t('адрес движка','engine address')+' '+deployment.url_host:''}{deployment.watching?' · '+t('наблюдение активно','watching'):''}</div>
   {deployment.error&&<p className="tiny danger">{deployment.error}</p>}
   {deployment.drive&&<p className={deployment.drive.state==='ERROR'?'notice dangernotice':'tiny'}>{t('Модели','Models')}: {deployment.drive.message}{deployment.drive.summary?` (${t('есть','present')} ${deployment.drive.summary.installed}, ${t('не хватает','missing')} ${deployment.drive.summary.missing}${deployment.drive.summary.missing?', '+bytesText(deployment.drive.summary.missing_bytes):''})`:''}</p>}
   {deployment.stage==='GPU_READY'&&connected&&<p className="tiny">{t('Готово: откройте «Генерация». Оплата продолжается, пока инстанс существует — остановите или удалите его, когда закончите.','Ready: open Generate. Billing continues while the instance exists — stop or delete it when done.')}</p>}
  </div>}

  <p className="tiny muted">{t('Остановить инстанс можно в панели CloudCompute (оплата GPU прекращается, хранение диска может оплачиваться). «Удалить инстанс» ниже прекращает оплату и удаляет его диск. «Отключиться» не останавливает оплату.','Stop the instance in the CloudCompute dashboard (GPU billing stops, disk storage may still be billed). «Delete instance» below stops billing and deletes its disk. «Disconnect» does not stop billing.')}</p>
  <a className="btn" href={DASHBOARD} target="_blank" rel="noopener noreferrer">{t('Открыть панель CloudCompute','Open CloudCompute dashboard')}</a>

  <details><summary className="tiny">{t('Расширенные настройки запуска','Advanced launch settings')}</summary><div className="stack" style={{marginTop:12}}>
   <label className="field">{t('Docker-образ движка','Engine Docker image')}<input value={image} placeholder={defaultImage} spellCheck={false} onChange={e=>setImage(e.target.value)}/></label>
   <label className="row tiny"><input type="checkbox" checked={skipCheck} onChange={e=>setSkipCheck(e.target.checked)}/> {t('Не проверять публичную доступность образа (только для собственного реестра)','Skip the public image check (own registry only)')}</label>
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

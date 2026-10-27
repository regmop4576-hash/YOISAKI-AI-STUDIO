'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {CloudDownload,Folder,ChevronRight} from 'lucide-react';
import {useDirect} from '@/lib/engine/direct';
import {useStudio} from '@/stores/studio';
import {localApi} from '@/lib/local-api';

type Item={path:string;name:string;kind:'checkpoint'|'lora'|'vae';size:number|null;state:string;reason:string;verification:string};
type Current={path:string;kind:string;phase:string;bytes_done:number|null;bytes_total:number|null;speed_bps:number|null;resumed_from:number|null};
type Job={id:string;type:'check'|'sync';state:string;phase:string;started_unix:number|null;finished_unix:number|null;error:string;error_code:string;cancel_requested:boolean;restart_recommended:boolean;overall:{files_total:number;files_done:number;files_failed:number;bytes_total:number;bytes_done:number};summary:Record<string,number>;current:Current|null};
export type SyncStatus={enabled:boolean;rclone_available:boolean;configured:boolean;source:string;scope:string;connection:{state:string;error:string;code:string};job:Job|null;disk:{free_bytes:number|null;total_bytes:number|null;reserve_bytes:number|null}|null;last_success_unix:number|null;last_check_unix:number|null;inventory_revision:number;verification:string;owner:'self'|'other';items:Item[];selective?:boolean;folder_select?:boolean;source_kind?:'path'|'folder'};
// v1.7.3 Easy Connect: the Drive link of this installation, kept by the local app (never the refresh token here).
type DriveFolder={id:string;name:string;path:string;root:'my'|'other'};
type Preview={folder_id:string;kinds:Record<'checkpoint'|'lora'|'vae',{files:number;bytes:number;rejected:number}>;kind_folders:string[];missing_folders:string[];ignored_folders:string[];loose_files:number;truncated:boolean;checked_at:number};
type DriveView={linked:boolean;client?:'own'|'public';account?:{email:string;name:string}|null;folder?:DriveFolder|null;linked_at?:number;auto_provision?:boolean;auto_sync?:boolean;reauth?:boolean;
 scope:string;client_available:boolean;public_client:boolean;own_client:boolean;own_client_id:string;public_client_error:string;redirect_uri:string;preview:Preview|null;error:{code:string;message:string}|null;
 last_result:{ok:boolean;code:string;message:string;at:number}|null;gpu:{state:string;message:string;code:string;at:number|null};gpu_online:boolean};

export function bytes(n:number|null|undefined){if(n==null)return '—';const u=['B','KB','MB','GB','TB'];let i=0,v=n;while(v>=1024&&i<u.length-1){v/=1024;i++}return (i?v.toFixed(v<10?2:v<100?1:0):String(v))+' '+u[i]}
const percent=(done:number|null|undefined,total:number|null|undefined)=>done!=null&&total?Math.min(100,Math.floor(done/total*100)):null;
const EN:Record<string,string>={DRIVE_OAUTH_NOT_CONFIGURED:'This installation has no Google OAuth client. Save the Client ID and Client Secret of your own OAuth client (type “Desktop app”).',
 DRIVE_REAUTH_REQUIRED:'Google Drive access expired or was revoked. Press “Sign in with Google” again.',DRIVE_PERMISSION:'Google Drive denied access: the “view Google Drive files” permission was not granted or the folder is not available to this account.',
 DRIVE_API_DISABLED:'The Google Drive API is not enabled in the Google Cloud project of this OAuth client: APIs & Services → Library → Google Drive API → Enable.',DRIVE_FOLDER_NOT_FOUND:'The folder was not found in Google Drive.',
 DRIVE_NOT_LINKED:'Google Drive is not connected.',DRIVE_NO_FOLDER:'Choose the model folder first.',DRIVE_RATE_LIMITED:'Google Drive is rate limiting requests. Try again in a minute.',GPU_OFFLINE:'The GPU is offline. Google Drive is handed to the server automatically when CloudCompute connects.',
 GOOGLE_NETWORK:'No connection to Google. Check the phone’s internet.',DRIVE_OAUTH_FAILED:'Google rejected the authorization. Try again.',DRIVE_SCOPE_DENIED:'Read-only Google Drive access was not granted on the Google screen: tick the permission and sign in again.',
 DRIVE_INVALID_CLIENT:'Client ID must look like 123…-abc….apps.googleusercontent.com, plus the Client Secret of a “Desktop app” client.',DRIVE_SYNC_UNAVAILABLE:'This GPU server has no Google Drive Auto Sync. Update the CloudCompute package.'};

/** Google Drive Easy Connect (account + model folder, no GPU needed) and the Auto Sync that runs on the GPU server. */
export function DriveSync(){
 const provider=useDirect(x=>x.provider),url=useDirect(x=>x.url),refreshModels=useDirect(x=>x.refresh);
 const english=useStudio(x=>x.language)==='English';const t=(ru:string,en:string)=>english?en:ru;
 const msg=(e:unknown)=>{const x=e as Error&{code?:string};return english&&x.code&&EN[x.code]?EN[x.code]:x.message};
 const [drive,setDrive]=useState<DriveView|null>(null),[status,setStatus]=useState<SyncStatus|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState('');
 const [picker,setPicker]=useState(false),[result,setResult]=useState<{ok:boolean;text:string}|null>(null),[picked,setPicked]=useState<Set<string>>(new Set());
 const gpuReady=provider==='cloudcompute'&&!!url;
 const revision=useRef<number|null>(null);const running=status?.job?.state==='RUNNING';
 const loadDrive=useCallback(async()=>{try{const v=await localApi<DriveView>('/api/drive');setDrive(v);return v}catch(e){setError(msg(e));return null}},[english]);
 const apply=useCallback((next:SyncStatus)=>{setStatus(next);
  // New files were installed on the server: reload the engine's real catalogue (no frontend rebuild, no restart).
  if(revision.current!==null&&next.inventory_revision!==revision.current)void refreshModels(true);
  revision.current=next.inventory_revision},[refreshModels]);
 const call=useCallback(async(action:string,body?:object)=>{setError('');try{apply(await localApi<SyncStatus>('/api/gpu/drive/'+action,action==='status'?undefined:{method:'POST',body:JSON.stringify(body||{})}));return true}catch(e){setError(msg(e));return false}},[apply,english]);
 useEffect(()=>{void loadDrive().then(v=>{
  // Back from Google (/models?drive_auth=1): show the outcome once; without a folder open the folder picker.
  if(v&&new URLSearchParams(location.search).get('drive_auth')==='1'){history.replaceState(null,'',location.pathname);if(v.last_result){setResult({ok:v.last_result.ok,text:v.last_result.message});if(v.last_result.ok&&!v.folder)setPicker(true)}}})},[loadDrive]);
 useEffect(()=>{revision.current=null;setStatus(null);if(gpuReady)void call('status')},[gpuReady,url,call]);
 // While the GPU side works (hand-over, check, download) follow it.
 const gpuBusy=drive?.gpu.state==='RUNNING'||drive?.gpu.state==='SYNCING';
 useEffect(()=>{if(!gpuReady||!(running||gpuBusy))return;const id=setInterval(()=>{if(document.visibilityState!=='visible')return;void call('status');void loadDrive()},2000);return()=>clearInterval(id)},[running,gpuBusy,gpuReady,call,loadDrive]);
 const act=async(label:string,fn:()=>Promise<unknown>)=>{setBusy(label);setError('');try{await fn()}catch(e){setError(msg(e))}finally{setBusy('')}};
 const driveCall=(label:string,route:string,init?:RequestInit)=>act(label,async()=>{setDrive(await localApi<DriveView>(route,init))});
 async function signIn(client?:'own'|'public'){setResult(null);await act('signin',async()=>{const r=await localApi<{url:string}>('/api/drive/oauth/start',{method:'POST',body:JSON.stringify(client?{client}:{})});location.href=r.url})}
 function disconnect(){if(confirm(t('Отключить Google Drive? Доступ будет отозван в Google (также на GPU-сервере). Скачанные модели на GPU не удаляются.','Disconnect Google Drive? Access is revoked at Google (also on the GPU server). Models already downloaded to the GPU are not deleted.')))void driveCall('unlink','/api/drive',{method:'DELETE'}).then(()=>{if(gpuReady)void call('status')})}
 const job=status?.job;const cur=job?.current;
 const curPct=cur&&['DOWNLOADING','HASHING_LOCAL'].includes(cur.phase)?percent(cur.bytes_done,cur.bytes_total):null;
 const allPct=job?.type==='sync'&&job.overall.bytes_total?percent(job.overall.bytes_done,job.overall.bytes_total):null;
 const when=(s:number|null|undefined)=>s?new Date(s*1000).toLocaleString(english?'en-GB':'ru-RU'):t('ещё не было','never');
 const stateName:Record<string,string>={INSTALLED:t('Установлена','Installed'),MISSING:t('Нет на сервере','Missing'),CHANGED:t('Изменена на Drive','Changed on Drive'),CONFLICT:t('Конфликт','Conflict'),REJECTED:t('Отклонена','Rejected'),DOWNLOADING:t('Загрузка','Downloading'),VERIFYING:t('Проверка','Verifying'),FAILED:t('Ошибка','Failed'),PENDING:t('Ожидает','Pending')};
 const phaseName:Record<string,string>={LISTING:t('Чтение списка Google Drive','Reading the Google Drive listing'),COMPARING:t('Сравнение с сервером','Comparing with the server'),HASHING_LOCAL:t('Проверка уже имеющегося файла','Checking an existing file'),DOWNLOADING:t('Загрузка','Downloading'),VERIFYING_PARTIAL:t('Проверка частичной загрузки','Checking the partial download'),VERIFYING:t('Проверка контрольной суммы и safetensors','Verifying checksum and safetensors'),INSTALLING:t('Установка','Installing'),DONE:t('Готово','Done')};
 const jobName:Record<string,string>={RUNNING:t('выполняется','running'),COMPLETED:t('завершено','completed'),FAILED:t('ошибка','failed'),CANCELLED:t('отменено','cancelled'),INTERRUPTED:t('прервано','interrupted')};
 const kindName={checkpoint:'Checkpoint',lora:'LoRA',vae:'VAE'};
 const pickable=(i:Item)=>!!status?.selective&&['MISSING','CHANGED'].includes(i.state);
 const togglePick=(path:string)=>setPicked(old=>{const next=new Set(old);if(next.has(path))next.delete(path);else next.add(path);return next});
 const chosen=status?status.items.filter(i=>pickable(i)&&picked.has(i.path)).map(i=>i.path):[];
 // Three separate states (5.6): Drive account / GPU engine / model synchronization.
 const authState=!drive?.linked?{v:t('Не подключён','Disconnected'),bad:false}:drive.reauth?{v:t('Нужен повторный вход','Sign-in required'),bad:true}:{v:t('Подключён','Connected'),bad:false};
 const engineState=gpuReady?t('Онлайн (CloudCompute)','Online (CloudCompute)'):url?t('Онлайн (Colab: синхронизация недоступна)','Online (Colab: no sync)'):t('Офлайн','Offline');
 const syncState=running?t('Выполняется','Running'):!drive?.linked||drive.reauth?t('Недоступна: нет доступа к Drive','Unavailable: no Drive access'):!gpuReady?t('Недоступна: нужен CloudCompute онлайн','Unavailable: CloudCompute must be online'):status&&!status.enabled?t('Отключена на сервере','Disabled on the server'):status&&!status.rclone_available?t('Недоступна: нет rclone на сервере','Unavailable: no rclone on the server'):t('Доступна','Available');
 const folderLabel=(f:DriveFolder)=>(f.root==='my'?t('Мой диск','My Drive')+'/':'…/')+f.path;
 const p=drive?.preview;
 const disabled=!!busy||!status||!status.enabled;
 return <div className="panel stack" data-localized="true" aria-label="GOOGLE DRIVE AUTO SYNC">
  <div className="row" style={{justifyContent:'space-between'}}><h2 style={{margin:0}}><CloudDownload size={18} style={{verticalAlign:'-3px'}}/> GOOGLE DRIVE</h2><span className="status" role="status">{running?(phaseName[job!.phase]||job!.phase):authState.v}</span></div>
  <div className="grid2 tiny" aria-label={t('Состояние','State')}>
   <div>{t('Аккаунт Google Drive','Google Drive account')}: <b className={authState.bad?'danger':''}>{authState.v}</b></div>
   <div>{t('GPU-движок','GPU engine')}: <b>{engineState}</b></div>
   <div>{t('Синхронизация моделей','Model synchronization')}: <b>{syncState}</b></div>
  </div>
  {!drive?null:!drive.linked?<div className="card stack">
   <b>{t('Подключите свой Google Drive','Connect your Google Drive')}</b>
   <p className="tiny">{t('Откроется страница Google: выберите аккаунт и разрешите просмотр файлов Google Drive. Затем выберите папку с моделями. GPU для этого не нужен — модели загрузятся на сервер, когда он подключится.','Google opens: choose the account and allow viewing Google Drive files. Then choose the model folder. No GPU is needed for this — the models are downloaded to the server once it connects.')}</p>
   {drive.client_available?<button className="primary" disabled={!!busy} onClick={()=>void signIn()}>{t('Войти через Google','Sign in with Google')}</button>:null}
   <OwnClient drive={drive} t={t} busy={!!busy} onSaved={v=>setDrive(v)} onError={setError} msg={msg}/>
  </div>:<div className="card stack">
   <div className="row" style={{justifyContent:'space-between'}}><b style={{overflowWrap:'anywhere'}}>{drive.account?.email||t('Аккаунт Google','Google account')}</b><span className="tiny muted">{drive.client==='public'?t('клиент приложения','app client'):t('собственный OAuth-клиент','own OAuth client')}</span></div>
   {drive.reauth&&<div className="notice dangernotice" role="alert">{t('Доступ к Google Drive истёк или отозван (у приложений Google в режиме Testing — через 7 дней). Войдите снова: папка сохранится, если аккаунт тот же.','Google Drive access expired or was revoked (for Google apps in Testing mode — after 7 days). Sign in again: the folder is kept for the same account.')}<div className="row" style={{marginTop:6}}><button className="primary" disabled={!!busy} onClick={()=>void signIn(drive.client)}>{t('Войти через Google снова','Sign in with Google again')}</button></div></div>}
   <div className="tiny">{t('Папка моделей','Model folder')}: <b style={{overflowWrap:'anywhere'}}>{drive.folder?folderLabel(drive.folder):t('не выбрана','not chosen')}</b></div>
   <div className="row">
    <button className={drive.folder?'':'primary'} disabled={!!busy||drive.reauth} onClick={()=>setPicker(!picker)} aria-expanded={picker}>{drive.folder?t('Изменить папку','Change folder'):t('Выбрать папку','Choose folder')}</button>
    <button disabled={!!busy||!drive.folder||drive.reauth} onClick={()=>void driveCall('check','/api/drive/check',{method:'POST',body:'{}'})}>{busy==='check'?t('Проверяю…','Checking…'):t('Проверить модели в Drive','Check models in Drive')}</button>
    <button className="danger" disabled={!!busy} onClick={disconnect}>{t('Отключить Google Drive','Disconnect Google Drive')}</button>
   </div>
   {picker&&<FolderPicker t={t} msg={msg} onPick={id=>void driveCall('folder','/api/drive/folder',{method:'POST',body:JSON.stringify({id})}).then(()=>{setPicker(false);setResult(null)})} onClose={()=>setPicker(false)} busy={busy==='folder'}/>}
   {p&&<div className="stack tiny" aria-label={t('Модели в папке Google Drive','Models in the Google Drive folder')}>
    <div className="grid2">{(['checkpoint','lora','vae'] as const).map(k=><div key={k}>{kindName[k]}: <b>{p.kinds[k].files}</b> · {bytes(p.kinds[k].bytes)}{p.kinds[k].rejected?` · ${t('не .safetensors','not .safetensors')}: ${p.kinds[k].rejected}`:''}</div>)}</div>
    {p.missing_folders.length===3?<div className="notice">{t('В этой папке нет подпапок checkpoints/, loras/ и vae/. Выберите папку, внутри которой они лежат (обычно YOISAKI_AI_STUDIO/models).','This folder has no checkpoints/, loras/ or vae/ subfolders. Choose the folder that contains them (usually YOISAKI_AI_STUDIO/models).')}</div>
     :p.missing_folders.length>0&&<span className="muted">{t('Нет подпапок: ','Missing subfolders: ')}{p.missing_folders.map(x=>x+'/').join(', ')}</span>}
    {p.loose_files>0&&<span className="muted">{t(`${p.loose_files} файл(ов) .safetensors лежат прямо в папке: они не загружаются — разложите их по checkpoints/, loras/ или vae/.`,`${p.loose_files} .safetensors file(s) lie directly in the folder: they are not downloaded — move them into checkpoints/, loras/ or vae/.`)}</span>}
    {p.ignored_folders.includes('controlnet')&&<span className="muted">{t('Папка controlnet/ не синхронизируется: ControlNet движка использует свои встроенные модели (OpenPose, Canny, Depth).','The controlnet/ folder is not synchronized: the engine’s ControlNet uses its built-in models (OpenPose, Canny, Depth).')}</span>}
    {p.truncated&&<span className="muted">{t('Папка очень большая: показана только часть.','The folder is very large: only part is shown.')}</span>}
   </div>}
   {drive.error&&<div className="notice dangernotice">{english&&EN[drive.error.code]?EN[drive.error.code]:drive.error.message}</div>}
   <label className="row tiny"><input type="checkbox" checked={!!drive.auto_provision} disabled={!!busy} onChange={e=>void driveCall('settings','/api/drive/settings',{method:'POST',body:JSON.stringify({auto_provision:e.target.checked})})}/>{t('Передавать доступ на мой GPU-сервер CloudCompute при подключении','Hand access to my CloudCompute GPU server when it connects')}</label>
   <label className="row tiny"><input type="checkbox" checked={!!drive.auto_sync} disabled={!!busy} onChange={e=>void driveCall('settings','/api/drive/settings',{method:'POST',body:JSON.stringify({auto_sync:e.target.checked})})}/>{t('Сразу загружать недостающие модели на GPU','Download missing models to the GPU right away')}</label>
   <p className="tiny muted">{t('Доступ — только просмотр файлов Google Drive (drive.readonly): приложение ничего не изменяет и не удаляет в Drive. Технически этот доступ позволяет читать любые файлы аккаунта; приложение читает только выбранную папку. Refresh token хранится в приложении на телефоне (файл 0600, не в браузере) и для загрузки передаётся только на ваш GPU-сервер.','Access is view-only (drive.readonly): the app never changes or deletes anything in Drive. Technically this access can read any file of the account; the app reads only the chosen folder. The refresh token is kept by the app on this phone (file 0600, not in the browser) and is handed only to your own GPU server for downloads.')}</p>
  </div>}
  {result&&<div className={'notice'+(result.ok?'':' dangernotice')} role="alert">{result.text}</div>}
  {gpuReady&&drive?.linked&&drive.gpu.state!=='IDLE'&&<div className={'notice'+(drive.gpu.state==='ERROR'?' dangernotice':'')} role="status">{english&&EN[drive.gpu.code]?EN[drive.gpu.code]:drive.gpu.message}
   {drive.gpu.state==='ERROR'&&!drive.reauth&&<div className="row" style={{marginTop:6}}><button disabled={!!busy} onClick={()=>void driveCall('provision','/api/drive/provision',{method:'POST',body:'{}'}).then(()=>call('status'))}>{t('Повторить передачу доступа','Retry the hand-over')}</button></div>}</div>}
  {!gpuReady?<p className="tiny muted">{provider==='cloudcompute'?t('Загрузка моделей выполняется на GPU-сервере CloudCompute: подключите его на странице GPU. Аккаунт и папку можно настроить уже сейчас.','Models are downloaded on the CloudCompute GPU server: connect it on the GPU page. The account and folder can be set up right now.'):t('Google Drive Auto Sync работает только с CloudCompute (на Colab модели загружаются блокнотом).','Google Drive Auto Sync works only with CloudCompute (on Colab the notebook loads the models).')}</p>:<>
   <div className="grid2 tiny">
    <div>{t('Источник на сервере','Source on the server')}: <b style={{overflowWrap:'anywhere'}}>{status?.source||'—'}</b> <span className="muted">({status?.source_kind==='folder'?t('выбранная папка','chosen folder'):t('путь из настроек сервера','server setting')})</span></div>
    <div>{t('Свободно на диске','Free disk space')}: <b>{status?.disk?`${bytes(status.disk.free_bytes)} / ${bytes(status.disk.total_bytes)}`:t('Нет данных','No data')}</b></div>
    <div>{t('Последняя успешная синхронизация','Last successful sync')}: <b>{when(status?.last_success_unix)}</b></div>
    <div>{t('Доступ на сервере','Access on the server')}: <b>{!status?t('Нет данных','No data'):!status.configured?t('не передан','not handed over'):status.connection.state==='OK'?t('проверен','verified'):status.connection.state==='ERROR'?t('ошибка','error'):t('передан, ещё не проверялся','handed over, not checked yet')}</b></div>
   </div>
   {status&&!status.rclone_available&&<div className="notice dangernotice">{t('На сервере нет rclone. Выполните на сервере ./start-cloudcompute.sh: он установит rclone.','rclone is missing on the server. Run ./start-cloudcompute.sh on the server: it installs rclone.')}</div>}
   {status&&!status.enabled&&<div className="notice">{t('Синхронизация отключена на сервере (YOISAKI_DRIVE_SYNC=0).','Sync is disabled on the server (YOISAKI_DRIVE_SYNC=0).')}</div>}
   {status?.owner==='other'&&<div className="notice">{t('Синхронизация запущена в терминале сервера; отменить её можно там (Ctrl+C).','A sync started in the server terminal is running; cancel it there (Ctrl+C).')}</div>}
   {drive?.folder&&status&&status.configured&&!status.folder_select&&<div className="notice">{t('Сервер CloudCompute старше 1.7.3: он не принимает выбранную папку и берёт YOISAKI_DRIVE_PATH из своих настроек. Обновите пакет на сервере.','The CloudCompute server is older than 1.7.3: it ignores the chosen folder and uses its own YOISAKI_DRIVE_PATH. Update the server package.')}</div>}
   <div className="row">
    <button disabled={disabled||running||!status?.configured} onClick={()=>void act('check',()=>call('check'))}>{t('Проверить модели на сервере','Check models on the server')}</button>
    <button className={status?.configured?'primary':''} disabled={disabled||running||!status?.configured} onClick={()=>void act('sync',()=>call('sync'))}>{t('Синхронизировать','Synchronize')}</button>
    <button className="danger" disabled={!!busy||!running||status?.owner==='other'||job?.cancel_requested} onClick={()=>void act('cancel',()=>call('cancel'))}>{t('Отменить загрузку','Cancel download')}</button>
    <button disabled={!!busy} onClick={()=>{void call('status');void refreshModels(true)}}>{t('Обновить список','Refresh list')}</button>
   </div>
   {job&&<div className="card stack" aria-live="polite">
    <div className="row tiny" style={{justifyContent:'space-between'}}><b>{job.type==='sync'?t('Синхронизация','Synchronization'):t('Проверка','Check')}: {jobName[job.state]||job.state}</b><span className="muted">{job.state==='RUNNING'?(phaseName[job.phase]||job.phase):when(job.finished_unix)}</span></div>
    {job.state==='RUNNING'&&cur&&<div className="stack" style={{gap:6}}>
     <span className="tiny" style={{overflowWrap:'anywhere'}}>{cur.path} · {phaseName[cur.phase]||cur.phase}</span>
     {curPct===null?<progress className="syncbar" aria-label={t('Текущий файл: прогресс неизвестен','Current file: progress unknown')}/>:<progress className="syncbar" max={100} value={curPct} aria-label={t('Текущий файл','Current file')}/>}
     <span className="tiny muted">{bytes(cur.bytes_done)} / {bytes(cur.bytes_total)}{curPct!==null?` · ${curPct}%`:''}{cur.speed_bps?` · ${bytes(cur.speed_bps)}/s`:''}{cur.resumed_from?` · ${t('продолжено с','resumed from')} ${bytes(cur.resumed_from)}`:''}</span>
    </div>}
    {job.state==='RUNNING'&&!cur&&<progress className="syncbar" aria-label={t('Выполняется, объём неизвестен','Working, size unknown')}/>}
    {job.type==='sync'&&job.overall.files_total>0&&<div className="stack" style={{gap:6}}>
     <span className="tiny">{t('Всего','Overall')}: {job.overall.files_done}/{job.overall.files_total} {t('файлов','files')} · {bytes(job.overall.bytes_done)} / {bytes(job.overall.bytes_total)}{allPct!==null?` · ${allPct}%`:''}{job.overall.files_failed?` · ${t('ошибок','failed')}: ${job.overall.files_failed}`:''}</span>
     {allPct!==null&&<progress className="syncbar" max={100} value={allPct} aria-label={t('Общий прогресс','Overall progress')}/>}
    </div>}
    {job.type==='sync'&&job.state==='COMPLETED'&&job.overall.files_total===0&&<span className="tiny">{t('Все модели уже установлены: загружать нечего.','All models are already installed: nothing to download.')}</span>}
    {job.error&&<div className={'notice'+(job.state==='CANCELLED'?'':' dangernotice')} role="alert">{job.error}</div>}
    {job.restart_recommended&&<div className="notice">{t('Обновлена модель, которая могла быть загружена в память GPU: новая версия применится после выбора другой модели или перезапуска движка.','A model that may be loaded in GPU memory was updated: the new version applies after switching models or restarting the engine.')}</div>}
   </div>}
   {status?.connection.state==='ERROR'&&status.connection.error&&!job?.error&&<div className="notice dangernotice" role="alert">{status.connection.error}</div>}
   {status&&(status.items.length?<div style={{overflowX:'auto',maxWidth:'100%'}}><table className="synctable"><thead><tr><th>{t('Модель','Model')}</th><th>{t('Тип','Type')}</th><th>{t('Статус','Status')}</th>{status.selective&&<th>{t('Выбрать','Pick')}</th>}</tr></thead><tbody>
    {status.items.map(i=><tr key={i.path} data-state={i.state}><td><b style={{overflowWrap:'anywhere'}}>{i.name.replace(/\.safetensors$/i,'')}</b><div className="tiny muted" style={{overflowWrap:'anywhere'}}>{i.path} · {bytes(i.size)}</div>{i.reason&&<div className="tiny muted">{i.reason}</div>}</td><td>{kindName[i.kind]}</td><td>{stateName[i.state]||i.state}</td>{status.selective&&<td>{pickable(i)&&<input type="checkbox" aria-label={t('Выбрать ','Pick ')+i.name} checked={picked.has(i.path)} disabled={!!busy||running} onChange={()=>togglePick(i.path)}/>}</td>}</tr>)}
   </tbody></table>{status.selective&&status.items.some(pickable)&&<div className="row"><button className="primary" disabled={disabled||running||!chosen.length} onClick={()=>void act('sync',async()=>{if(await call('sync',{paths:chosen}))setPicked(new Set())})}>{t(`Синхронизировать выбранные (${chosen.length})`,`Sync selected (${chosen.length})`)}</button><span className="tiny muted">{t('или «Синхронизировать» — все недостающие','or «Synchronize» for all missing')}</span></div>}</div>:<p className="tiny muted">{status.last_check_unix?t('В папке Google Drive нет моделей в checkpoints/, loras/ или vae/.','No models in checkpoints/, loras/ or vae/ of the Google Drive folder.'):t('Список ещё не проверялся: нажмите «Проверить модели на сервере».','Not checked yet: press “Check models on the server”.')}</p>)}
   {status?.verification&&<p className="tiny muted">{status.verification}</p>}
   <LegacyToken t={t} busy={!!busy||running} configured={!!status?.configured} onConnect={body=>act('connect',async()=>{if(await call('connect',body))await call('check')})} onDisconnect={()=>void act('disconnect',()=>call('disconnect'))}/>
  </>}
  {error&&<div className="notice dangernotice" role="alert">{error}</div>}
 </div>;
}

type T=(ru:string,en:string)=>string;
/** The user's own Google OAuth client ("Desktop app"): needed only when the installation ships no public client. */
function OwnClient({drive,t,busy,onSaved,onError,msg}:{drive:DriveView;t:T;busy:boolean;onSaved:(v:DriveView)=>void;onError:(e:string)=>void;msg:(e:unknown)=>string}){
 const [open,setOpen]=useState(!drive.client_available),[id,setId]=useState(''),[secret,setSecret]=useState('');
 const reload=async()=>onSaved(await localApi<DriveView>('/api/drive'));
 async function save(){try{await localApi('/api/drive/oauth',{method:'PUT',body:JSON.stringify({client_id:id.trim(),client_secret:secret.trim()})});setSecret('');await reload()}catch(e){onError(msg(e))}}
 async function forget(){if(!confirm(t('Удалить сохранённый OAuth-клиент Google с телефона?','Remove the saved Google OAuth client from this phone?')))return;try{await localApi('/api/drive/oauth',{method:'DELETE'});await reload()}catch(e){onError(msg(e))}}
 return <details open={open} onToggle={e=>setOpen((e.target as HTMLDetailsElement).open)}><summary className="tiny">{drive.own_client?t('Собственный OAuth-клиент Google: ','Own Google OAuth client: ')+drive.own_client_id:drive.public_client?t('Использовать свой OAuth-клиент Google (необязательно)','Use your own Google OAuth client (optional)'):t('Нужен OAuth-клиент Google (один раз, ~10 минут)','A Google OAuth client is needed (once, ~10 minutes)')}</summary>
  <div className="stack" style={{marginTop:8}}>
   {drive.public_client_error&&<div className="notice dangernotice">{drive.public_client_error}</div>}
   {!drive.public_client&&<p className="tiny">{t('В этой установке нет общего OAuth-клиента приложения, поэтому нужен ваш собственный (бесплатно, в вашем аккаунте Google):','This installation ships no app OAuth client, so your own is needed (free, in your Google account):')}</p>}
   <ol className="tiny" style={{margin:0,paddingLeft:18,display:'flex',flexDirection:'column',gap:6}}>
    <li>{t('console.cloud.google.com → создайте проект → «APIs & Services» → «Library» → включите Google Drive API.','console.cloud.google.com → create a project → APIs & Services → Library → enable Google Drive API.')}</li>
    <li>{t('«OAuth consent screen»: тип External, добавьте свой адрес Gmail в Test users. В режиме Testing доступ истекает через 7 дней; «In production» без проверки Google — с предупреждением о непроверенном приложении.','OAuth consent screen: External, add your Gmail to Test users. In Testing mode access expires after 7 days; In production without Google verification shows an unverified-app warning.')}</li>
    <li>{t('«Credentials» → «Create credentials» → «OAuth client ID» → тип «Desktop app» (Приложение для ПК). Скопируйте Client ID и Client Secret сюда.','Credentials → Create credentials → OAuth client ID → Desktop app. Copy Client ID and Client Secret here.')}</li>
   </ol>
   {drive.own_client?<div className="row"><button disabled={busy} onClick={()=>void forget()}>{t('Удалить свой OAuth-клиент','Remove own OAuth client')}</button></div>:<>
    <div className="grid2"><label className="field">Google Client ID<input autoComplete="off" spellCheck={false} value={id} onChange={e=>setId(e.target.value)} aria-label="Google Client ID" placeholder="123…-abc….apps.googleusercontent.com"/></label>
    <label className="field">Google Client Secret<input type="password" autoComplete="off" spellCheck={false} value={secret} onChange={e=>setSecret(e.target.value)} aria-label="Google Client Secret"/></label></div>
    <button disabled={busy||!id.trim()||!secret.trim()} onClick={()=>void save()}>{t('Сохранить OAuth-клиент на телефоне','Save the OAuth client on this phone')}</button></>}
   <p className="tiny muted">{t('Адрес возврата ','Redirect address ')}<code>{drive.redirect_uri}</code>{t(' — для клиента типа «Desktop app» его не нужно регистрировать.',' — a “Desktop app” client needs no registration of it.')}</p>
  </div>
 </details>;
}

/** Folder browser over the user's Drive (read-only, through the local app). */
function FolderPicker({t,msg,onPick,onClose,busy}:{t:T;msg:(e:unknown)=>string;onPick:(id:string)=>void;onClose:()=>void;busy:boolean}){
 const [trail,setTrail]=useState<{id:string;name:string}[]>([{id:'root',name:t('Мой диск','My Drive')}]);
 const [folders,setFolders]=useState<{id:string;name:string}[]|null>(null),[error,setError]=useState(''),[truncated,setTruncated]=useState(false);
 const here=trail[trail.length-1];
 useEffect(()=>{let live=true;setFolders(null);setError('');localApi<{folders:{id:string;name:string}[];truncated:boolean}>('/api/drive/folders?parent='+encodeURIComponent(here.id)).then(r=>{if(live){setFolders(r.folders);setTruncated(r.truncated)}}).catch(e=>{if(live)setError(msg(e))});return()=>{live=false}},[here.id]);
 return <div className="card stack" aria-label={t('Выбор папки Google Drive','Google Drive folder selection')}>
  <div className="row tiny">{(['root','shared'] as const).map(r=><button key={r} aria-pressed={trail[0].id===r} className={trail[0].id===r?'primary':''} onClick={()=>setTrail([{id:r,name:r==='root'?t('Мой диск','My Drive'):t('Доступные мне','Shared with me')}])}>{r==='root'?t('Мой диск','My Drive'):t('Доступные мне','Shared with me')}</button>)}</div>
  <div className="tiny" style={{overflowWrap:'anywhere'}}>{trail.map((x,i)=><span key={x.id}>{i>0&&' / '}<button className="tiny" style={{padding:'2px 6px'}} disabled={i===trail.length-1} onClick={()=>setTrail(trail.slice(0,i+1))}>{x.name}</button></span>)}</div>
  {error&&<div className="notice dangernotice">{error}</div>}
  {!folders&&!error?<p className="tiny muted">{t('Загружаю папки…','Loading folders…')}</p>:folders&&folders.length===0?<p className="tiny muted">{t('Вложенных папок нет.','No subfolders.')}</p>:
   <div className="stack" style={{gap:4,maxHeight:320,overflowY:'auto'}}>{folders?.map(f=><button key={f.id} className="row" style={{justifyContent:'space-between',textAlign:'left'}} onClick={()=>setTrail([...trail,f])}><span style={{overflowWrap:'anywhere'}}><Folder size={14} style={{verticalAlign:'-2px'}}/> {f.name}</span><ChevronRight size={14}/></button>)}</div>}
  {truncated&&<p className="tiny muted">{t('Показаны первые 200 папок.','The first 200 folders are shown.')}</p>}
  <div className="row">
   <button className="primary" disabled={busy||here.id==='root'||here.id==='shared'} onClick={()=>onPick(here.id)}>{busy?t('Проверяю папку…','Checking the folder…'):t(`Выбрать «${here.name}»`,`Choose “${here.name}”`)}</button>
   <button onClick={onClose}>{t('Закрыть','Close')}</button>
  </div>
  <p className="tiny muted">{t('Выберите папку, внутри которой лежат checkpoints/, loras/ и vae/ (например, YOISAKI_AI_STUDIO/models).','Choose the folder that contains checkpoints/, loras/ and vae/ (e.g. YOISAKI_AI_STUDIO/models).')}</p>
 </div>;
}

/** Fallback kept from 1.7.2: a token printed by `rclone authorize` (Termux). Not needed with the browser sign-in. */
function LegacyToken({t,busy,configured,onConnect,onDisconnect}:{t:T;busy:boolean;configured:boolean;onConnect:(b:object)=>void;onDisconnect:()=>void}){
 const [token,setToken]=useState(''),[own,setOwn]=useState(false),[clientId,setClientId]=useState(''),[clientSecret,setClientSecret]=useState('');
 return <details><summary className="tiny">{t('Дополнительно: ручная авторизация через Termux (rclone) и удаление доступа с сервера','Advanced: manual authorization through Termux (rclone) and removing access from the server')}</summary>
  <div className="stack" style={{marginTop:8}}>
   <p className="tiny muted">{t('Нужно только если вход через Google в браузере невозможен.','Only needed if the browser sign-in is impossible.')}</p>
   <ol className="tiny" style={{margin:0,paddingLeft:18,display:'flex',flexDirection:'column',gap:6}}>
    <li>{t('В Termux:','In Termux:')} <code>pkg install rclone</code></li>
    <li><code style={{overflowWrap:'anywhere'}}>rclone authorize "drive" "eyJzY29wZSI6ImRyaXZlLnJlYWRvbmx5In0"</code> {t('— доступ только на чтение (drive.readonly).','— read-only access (drive.readonly).')}</li>
    <li>{t('Откройте показанную ссылку в браузере телефона, войдите в Google, скопируйте строку {"access_token":…} целиком и вставьте ниже.','Open the printed link in the phone browser, sign in, copy the whole {"access_token":…} line and paste it below.')}</li>
   </ol>
   <label className="field">{t('Токен rclone (JSON)','rclone token (JSON)')}<input type="password" autoComplete="off" spellCheck={false} value={token} onChange={e=>setToken(e.target.value)} aria-label={t('Токен rclone (JSON)','rclone token (JSON)')} placeholder='{"access_token":"…","refresh_token":"…"}'/></label>
   <label className="row tiny"><input type="checkbox" checked={own} onChange={e=>setOwn(e.target.checked)}/>{t('Свой OAuth-клиент Google (если authorize запускался с client_id)','Own Google OAuth client (if authorize used a client_id)')}</label>
   {own&&<div className="grid2"><label className="field">Client ID<input autoComplete="off" spellCheck={false} value={clientId} onChange={e=>setClientId(e.target.value)} aria-label="Client ID"/></label><label className="field">Client Secret<input type="password" autoComplete="off" spellCheck={false} value={clientSecret} onChange={e=>setClientSecret(e.target.value)} aria-label="Client Secret"/></label></div>}
   <div className="row"><button disabled={busy||!token.trim().startsWith('{')||own&&(!clientId||!clientSecret)} onClick={()=>{const body={token:token.trim(),client_id:own?clientId.trim():'',client_secret:own?clientSecret.trim():''};setToken('');setClientSecret('');onConnect(body)}}>{t('Сохранить на сервере и проверить','Save on server and check')}</button>
    {configured&&<button className="danger" disabled={busy} onClick={()=>{if(confirm(t('Удалить токен Google Drive с GPU-сервера? Модели не удаляются.','Remove the Google Drive token from the GPU server? Models are not deleted.')))onDisconnect()}}>{t('Удалить доступ с GPU-сервера','Remove access from the GPU server')}</button>}</div>
  </div>
 </details>;
}

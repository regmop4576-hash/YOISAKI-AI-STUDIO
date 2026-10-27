'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {CloudDownload} from 'lucide-react';
import {useDirect} from '@/lib/engine/direct';
import {useStudio} from '@/stores/studio';
import {localApi} from '@/lib/local-api';

type Item={path:string;name:string;kind:'checkpoint'|'lora'|'vae';size:number|null;state:string;reason:string;verification:string};
type Current={path:string;kind:string;phase:string;bytes_done:number|null;bytes_total:number|null;speed_bps:number|null;resumed_from:number|null};
type Job={id:string;type:'check'|'sync';state:string;phase:string;started_unix:number|null;finished_unix:number|null;error:string;error_code:string;cancel_requested:boolean;restart_recommended:boolean;overall:{files_total:number;files_done:number;files_failed:number;bytes_total:number;bytes_done:number};summary:Record<string,number>;current:Current|null};
export type SyncStatus={enabled:boolean;rclone_available:boolean;configured:boolean;source:string;scope:string;connection:{state:string;error:string;code:string};job:Job|null;disk:{free_bytes:number|null;total_bytes:number|null;reserve_bytes:number|null}|null;last_success_unix:number|null;last_check_unix:number|null;inventory_revision:number;verification:string;owner:'self'|'other';items:Item[];selective?:boolean};
// v1.7.3 browser authorization: the user's own Google OAuth client (Desktop app) kept by the local app, never by the page.
type OAuthView={configured:boolean;client_id:string;redirect_uri:string;scope:string;last_result:{ok:boolean;code:string;message:string;at:number}|null};

export function bytes(n:number|null|undefined){if(n==null)return '—';const u=['B','KB','MB','GB','TB'];let i=0,v=n;while(v>=1024&&i<u.length-1){v/=1024;i++}return (i?v.toFixed(v<10?2:v<100?1:0):String(v))+' '+u[i]}
const percent=(done:number|null|undefined,total:number|null|undefined)=>done!=null&&total?Math.min(100,Math.floor(done/total*100)):null;

/** v1.7.2 · CloudCompute only. Shows only what the GPU server reports: no simulated progress or inventory. */
export function DriveSync(){
 const provider=useDirect(x=>x.provider),url=useDirect(x=>x.url),refreshModels=useDirect(x=>x.refresh);
 const english=useStudio(x=>x.language)==='English';const t=(ru:string,en:string)=>english?en:ru;
 const [status,setStatus]=useState<SyncStatus|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[form,setForm]=useState(false);
 const [token,setToken]=useState(''),[own,setOwn]=useState(false),[clientId,setClientId]=useState(''),[clientSecret,setClientSecret]=useState('');
 const revision=useRef<number|null>(null);const running=status?.job?.state==='RUNNING';
 const apply=useCallback((next:SyncStatus)=>{setStatus(next);
  // New files were installed on the server: reload the engine's real catalogue (no frontend rebuild, no restart).
  if(revision.current!==null&&next.inventory_revision!==revision.current)void refreshModels(true);
  revision.current=next.inventory_revision},[refreshModels]);
 const call=useCallback(async(action:string,body?:object)=>{setError('');try{apply(await localApi<SyncStatus>('/api/gpu/drive/'+action,action==='status'?undefined:{method:'POST',body:JSON.stringify(body||{})}));return true}catch(e){setError((e as Error).message);return false}},[apply]);
 useEffect(()=>{revision.current=null;setStatus(null);setError('');if(provider==='cloudcompute'&&url)void call('status')},[provider,url,call]);
 useEffect(()=>{if(!running||!url)return;const id=setInterval(()=>{if(document.visibilityState==='visible')void call('status')},2000);return()=>clearInterval(id)},[running,url,call]);
 const [oauth,setOauth]=useState<OAuthView|null>(null),[gId,setGId]=useState(''),[gSecret,setGSecret]=useState(''),[oauthMessage,setOauthMessage]=useState<{ok:boolean;text:string}|null>(null),[picked,setPicked]=useState<Set<string>>(new Set());
 useEffect(()=>{if(provider!=='cloudcompute')return;localApi<OAuthView>('/api/drive/oauth').then(view=>{setOauth(view);
  // Back from Google (/models?drive_auth=1): show the outcome once and check the Drive folder.
  if(new URLSearchParams(location.search).get('drive_auth')==='1'){history.replaceState(null,'',location.pathname);if(view.last_result){setOauthMessage({ok:view.last_result.ok,text:view.last_result.message});if(view.last_result.ok)void call('check')}}}).catch(()=>{})},[provider,call]);
 if(provider!=='cloudcompute')return null;
 const pickable=(i:Item)=>!!status?.selective&&['MISSING','CHANGED'].includes(i.state);
 const togglePick=(path:string)=>setPicked(old=>{const next=new Set(old);if(next.has(path))next.delete(path);else next.add(path);return next});
 const chosen=status?status.items.filter(i=>pickable(i)&&picked.has(i.path)).map(i=>i.path):[];
 async function saveClient(){setOauthMessage(null);try{setOauth(await localApi<OAuthView>('/api/drive/oauth',{method:'PUT',body:JSON.stringify({client_id:gId.trim(),client_secret:gSecret.trim()})}));setGSecret('')}catch(e){setOauthMessage({ok:false,text:(e as Error).message})}}
 async function signIn(){setOauthMessage(null);try{const {url}=await localApi<{url:string}>('/api/drive/oauth/start',{method:'POST',body:'{}'});location.href=url}catch(e){setOauthMessage({ok:false,text:(e as Error).message})}}
 async function forgetClient(){if(!confirm(t('Удалить сохранённый OAuth-клиент Google с телефона? Подключение на GPU-сервере не изменится.','Remove the saved Google OAuth client from this phone? The GPU server connection is unchanged.')))return;setOauth(await localApi<OAuthView>('/api/drive/oauth',{method:'DELETE'}))}
 const act=async(action:string,body?:object)=>{setBusy(true);try{return await call(action,body)}finally{setBusy(false)}};
 const job=status?.job;const cur=job?.current;
 const curPct=cur&&['DOWNLOADING','HASHING_LOCAL'].includes(cur.phase)?percent(cur.bytes_done,cur.bytes_total):null;
 const allPct=job?.type==='sync'&&job.overall.bytes_total?percent(job.overall.bytes_done,job.overall.bytes_total):null;
 const when=(s:number|null|undefined)=>s?new Date(s*1000).toLocaleString(english?'en-GB':'ru-RU'):t('ещё не было','never');
 const stateName:Record<string,string>={INSTALLED:t('Установлена','Installed'),MISSING:t('Нет на сервере','Missing'),CHANGED:t('Изменена на Drive','Changed on Drive'),CONFLICT:t('Конфликт','Conflict'),REJECTED:t('Отклонена','Rejected'),DOWNLOADING:t('Загрузка','Downloading'),VERIFYING:t('Проверка','Verifying'),FAILED:t('Ошибка','Failed'),PENDING:t('Ожидает','Pending')};
 const phaseName:Record<string,string>={LISTING:t('Чтение списка Google Drive','Reading the Google Drive listing'),COMPARING:t('Сравнение с сервером','Comparing with the server'),HASHING_LOCAL:t('Проверка уже имеющегося файла','Checking an existing file'),DOWNLOADING:t('Загрузка','Downloading'),VERIFYING_PARTIAL:t('Проверка частичной загрузки','Checking the partial download'),VERIFYING:t('Проверка контрольной суммы и safetensors','Verifying checksum and safetensors'),INSTALLING:t('Установка','Installing'),DONE:t('Готово','Done')};
 const jobName:Record<string,string>={RUNNING:t('выполняется','running'),COMPLETED:t('завершено','completed'),FAILED:t('ошибка','failed'),CANCELLED:t('отменено','cancelled'),INTERRUPTED:t('прервано','interrupted')};
 const kindName={checkpoint:'Checkpoint',lora:'LoRA',vae:'VAE'};
 const connection=!status?t('Нет данных','No data'):!status.configured?t('Не подключён','Not connected'):status.connection.state==='OK'?t('Подключён · доступ проверен','Connected · access verified'):status.connection.state==='ERROR'?t('Ошибка доступа','Access error'):t('Токен сохранён · доступ не проверен','Token stored · access not verified yet');
 const disabled=busy||!status||!status.enabled;
 return <div className="panel stack" data-localized="true" aria-label="GOOGLE DRIVE AUTO SYNC">
  <div className="row" style={{justifyContent:'space-between'}}><h2 style={{margin:0}}><CloudDownload size={18} style={{verticalAlign:'-3px'}}/> GOOGLE DRIVE AUTO SYNC</h2><span className="status" role="status">{running?(phaseName[job!.phase]||job!.phase):connection}</span></div>
  {!url?<p className="notice">{t('Подключите CloudCompute на странице GPU: синхронизация выполняется на GPU-сервере.','Connect CloudCompute on the GPU page: the sync runs on the GPU server.')}</p>:<>
  <div className="grid2 tiny">
   <div>{t('Google Drive','Google Drive')}: <b>{connection}</b></div>
   <div>{t('Папка-источник','Source folder')}: <b>{status?.source||'YOISAKI_AI_STUDIO/models'}</b> <span className="muted">({t('только чтение','read-only')})</span></div>
   <div>{t('Свободно на диске','Free disk space')}: <b>{status?.disk?`${bytes(status.disk.free_bytes)} / ${bytes(status.disk.total_bytes)}`:t('Нет данных','No data')}</b></div>
   <div>{t('Последняя успешная синхронизация','Last successful sync')}: <b>{when(status?.last_success_unix)}</b></div>
  </div>
  {status&&!status.rclone_available&&<div className="notice dangernotice">{t('На сервере нет rclone. Обновите пакет CloudCompute до 1.7.2 и выполните ./start-cloudcompute.sh.','rclone is missing on the server. Update the CloudCompute package to 1.7.2 and run ./start-cloudcompute.sh.')}</div>}
  {status&&!status.enabled&&<div className="notice">{t('Синхронизация отключена на сервере (YOISAKI_DRIVE_SYNC=0).','Sync is disabled on the server (YOISAKI_DRIVE_SYNC=0).')}</div>}
  {status?.owner==='other'&&<div className="notice">{t('Синхронизация запущена в терминале сервера; отменить её можно там (Ctrl+C).','A sync started in the server terminal is running; cancel it there (Ctrl+C).')}</div>}
  <div className="row">
   <button className={status?.configured?'':'primary'} disabled={disabled||running} aria-expanded={form} onClick={()=>setForm(!form)}>{t('Подключить Google Drive','Connect Google Drive')}</button>
   <button disabled={disabled||running||!status?.configured} onClick={()=>void act('check')}>{t('Проверить модели','Check models')}</button>
   <button className={status?.configured?'primary':''} disabled={disabled||running||!status?.configured} onClick={()=>void act('sync')}>{t('Синхронизировать','Synchronize')}</button>
   <button className="danger" disabled={busy||!running||status?.owner==='other'||job?.cancel_requested} onClick={()=>void act('cancel')}>{t('Отменить загрузку','Cancel download')}</button>
   <button disabled={busy} onClick={()=>{void act('status');void refreshModels(true)}}>{t('Обновить список','Refresh list')}</button>
  </div>
  {form&&<div className="card stack">
   <b>{t('Вариант 1: вход в Google в браузере (рекомендуется)','Option 1: sign in to Google in the browser (recommended)')}</b>
   {oauth?.configured?<div className="stack">
    <p className="tiny">{t('Откроется страница Google: выберите аккаунт с папкой YOISAKI_AI_STUDIO/models и разрешите доступ только на чтение. Потом вы вернётесь сюда автоматически.','Google opens: choose the account with YOISAKI_AI_STUDIO/models and allow read-only access. You return here automatically.')}</p>
    <div className="row"><button className="primary" disabled={busy||running} onClick={()=>void signIn()}>{t('Войти в Google и разрешить доступ','Sign in to Google and allow access')}</button><button disabled={busy} onClick={()=>void forgetClient()}>{t('Сменить OAuth-клиент','Change OAuth client')}</button></div>
    <p className="tiny muted">OAuth-клиент: {oauth.client_id}</p>
   </div>:<div className="stack">
    <p className="tiny">{t('Один раз нужен ваш собственный OAuth-клиент Google (Google не разрешает встроить общий клиент в приложение). Настройка в браузере телефона, около 10 минут:','Once you need your own Google OAuth client (Google does not allow a shared one in the app). Setup in the phone browser, about 10 minutes:')}</p>
    <ol className="tiny" style={{margin:0,paddingLeft:18,display:'flex',flexDirection:'column',gap:6}}>
     <li>{t('console.cloud.google.com → создайте проект → «APIs & Services» → «Library» → включите Google Drive API.','console.cloud.google.com → create a project → APIs & Services → Library → enable Google Drive API.')}</li>
     <li>{t('«OAuth consent screen»: тип External, добавьте свой адрес Gmail в Test users. Чтобы доступ не истекал через 7 дней, переведите приложение в «In production» (Google покажет предупреждение о непроверенном приложении — это ваше собственное приложение).','OAuth consent screen: External, add your Gmail to Test users. To avoid 7-day expiry switch to In production (Google warns about an unverified app — it is your own).')}</li>
     <li>{t('«Credentials» → «Create credentials» → «OAuth client ID» → тип «Desktop app» (Приложение для ПК). Скопируйте Client ID и Client Secret сюда.','Credentials → Create credentials → OAuth client ID → Desktop app. Copy Client ID and Client Secret here.')}</li>
    </ol>
    <div className="grid2"><label className="field">Google Client ID<input autoComplete="off" spellCheck={false} value={gId} onChange={e=>setGId(e.target.value)} aria-label="Google Client ID" placeholder="123…-abc….apps.googleusercontent.com"/></label>
    <label className="field">Google Client Secret<input type="password" autoComplete="off" spellCheck={false} value={gSecret} onChange={e=>setGSecret(e.target.value)} aria-label="Google Client Secret"/></label></div>
    <button disabled={busy||!gId.trim()||!gSecret.trim()} onClick={()=>void saveClient()}>{t('Сохранить OAuth-клиент на телефоне','Save the OAuth client on this phone')}</button>
    <p className="tiny muted">{t('Client ID и Secret хранятся только в приложении на телефоне (secrets.json, 0600). Доступ — только чтение Google Drive (drive.readonly). Refresh token уходит сразу на ваш GPU-сервер и на телефоне не сохраняется.','Client ID and Secret stay in the app on this phone (secrets.json, 0600). Access is read-only (drive.readonly). The refresh token goes straight to your GPU server and is not kept on the phone.')}</p>
   </div>}
   {oauthMessage&&<div className={'notice'+(oauthMessage.ok?'':' dangernotice')} role="alert">{oauthMessage.text}</div>}
   <b>{t('Вариант 2: однократная авторизация через Termux (rclone)','Option 2: one-time authorization in Termux (rclone)')}</b>
   <ol className="tiny" style={{margin:0,paddingLeft:18,display:'flex',flexDirection:'column',gap:6}}>
    <li>{t('В Termux:','In Termux:')} <code>pkg install rclone</code></li>
    <li><code style={{overflowWrap:'anywhere'}}>rclone authorize "drive" "eyJzY29wZSI6ImRyaXZlLnJlYWRvbmx5In0"</code> {t('— доступ только на чтение (drive.readonly).','— read-only access (drive.readonly).')}</li>
    <li>{t('Откройте показанную ссылку http://127.0.0.1:53682/… в браузере телефона, войдите в Google и разрешите доступ.','Open the printed http://127.0.0.1:53682/… link in the phone browser, sign in to Google and allow access.')}</li>
    <li>{t('Скопируйте из Termux строку {"access_token":…} целиком и вставьте ниже.','Copy the whole {"access_token":…} line from Termux and paste it below.')}</li>
   </ol>
   <label className="field">{t('Токен rclone (JSON)','rclone token (JSON)')}<input type="password" autoComplete="off" spellCheck={false} value={token} onChange={e=>setToken(e.target.value)} aria-label={t('Токен rclone (JSON)','rclone token (JSON)')} placeholder='{"access_token":"…","refresh_token":"…"}'/></label>
   <label className="row tiny"><input type="checkbox" checked={own} onChange={e=>setOwn(e.target.checked)}/>{t('Свой OAuth-клиент Google (если authorize запускался с client_id)','Own Google OAuth client (if authorize used a client_id)')}</label>
   {own&&<div className="grid2"><label className="field">Client ID<input autoComplete="off" spellCheck={false} value={clientId} onChange={e=>setClientId(e.target.value)} aria-label="Client ID"/></label><label className="field">Client Secret<input type="password" autoComplete="off" spellCheck={false} value={clientSecret} onChange={e=>setClientSecret(e.target.value)} aria-label="Client Secret"/></label></div>}
   <p className="tiny muted">{t('Токен передаётся один раз по HTTPS на ваш GPU-сервер и хранится только там (rclone.conf, права 0600). Студия его не сохраняет и не показывает. Публичные ссылки на файлы не нужны.','The token is sent once over HTTPS to your GPU server and stored only there (rclone.conf, mode 0600). The studio never stores or shows it. No public file links are needed.')}</p>
   <div className="row"><button className="primary" disabled={busy||!token.trim().startsWith('{')||own&&(!clientId||!clientSecret)} onClick={()=>{const body={token:token.trim(),client_id:own?clientId.trim():'',client_secret:own?clientSecret.trim():''};setToken('');setClientSecret('');void act('connect',body).then(ok=>{if(ok){setForm(false);void act('check')}})}}>{t('Сохранить на сервере и проверить','Save on server and check')}</button>
    {status?.configured&&<button className="danger" disabled={busy||running} onClick={()=>{if(confirm(t('Удалить токен Google Drive с GPU-сервера? Модели не удаляются.','Remove the Google Drive token from the GPU server? Models are not deleted.')))void act('disconnect')}}>{t('Отключить Google Drive','Disconnect Google Drive')}</button>}</div>
  </div>}
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
  {error&&<div className="notice dangernotice" role="alert">{error}</div>}
  {status&&(status.items.length?<div style={{overflowX:'auto'}}><table className="synctable"><thead><tr><th>{t('Модель','Model')}</th><th>{t('Тип','Type')}</th><th>{t('Статус','Status')}</th>{status.selective&&<th>{t('Выбрать','Pick')}</th>}</tr></thead><tbody>
   {status.items.map(i=><tr key={i.path} data-state={i.state}><td><b>{i.name.replace(/\.safetensors$/i,'')}</b><div className="tiny muted">{i.path} · {bytes(i.size)}</div>{i.reason&&<div className="tiny muted">{i.reason}</div>}</td><td>{kindName[i.kind]}</td><td>{stateName[i.state]||i.state}</td>{status.selective&&<td>{pickable(i)&&<input type="checkbox" aria-label={t('Выбрать ','Pick ')+i.name} checked={picked.has(i.path)} disabled={busy||running} onChange={()=>togglePick(i.path)}/>}</td>}</tr>)}
  </tbody></table>{status.selective&&status.items.some(pickable)&&<div className="row"><button className="primary" disabled={disabled||running||!chosen.length} onClick={()=>void act('sync',{paths:chosen}).then(ok=>{if(ok)setPicked(new Set())})}>{t(`Синхронизировать выбранные (${chosen.length})`,`Sync selected (${chosen.length})`)}</button><span className="tiny muted">{t('или «Синхронизировать» — все недостающие','or «Synchronize» for all missing')}</span></div>}</div>:<p className="tiny muted">{status.last_check_unix?t('В папке Google Drive нет моделей в checkpoints/, loras/ или vae/.','No models in checkpoints/, loras/ or vae/ of the Google Drive folder.'):t('Список ещё не проверялся: нажмите «Проверить модели».','Not checked yet: press “Check models”.')}</p>)}
  {status?.verification&&<p className="tiny muted">{status.verification}</p>}
  </>}
 </div>;
}

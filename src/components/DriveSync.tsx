'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {CloudDownload} from './icons';
import {useDirect} from '@/lib/engine/direct';
import {useStudio} from '@/stores/studio';
import {localApi} from '@/lib/local-api';

type Item={path:string;name:string;kind:'checkpoint'|'lora'|'vae';size:number|null;state:string;reason:string;verification:string};
type Current={path:string;kind:string;phase:string;bytes_done:number|null;bytes_total:number|null;speed_bps:number|null;resumed_from:number|null};
type Job={id:string;type:'check'|'sync';state:string;phase:string;started_unix:number|null;finished_unix:number|null;error:string;error_code:string;cancel_requested:boolean;restart_recommended:boolean;overall:{files_total:number;files_done:number;files_failed:number;bytes_total:number;bytes_done:number};summary:Record<string,number>;current:Current|null};
export type SyncStatus={enabled:boolean;rclone_available:boolean;configured:boolean;source:string;scope:string;connection:{state:string;error:string;code:string};job:Job|null;disk:{free_bytes:number|null;total_bytes:number|null;reserve_bytes:number|null}|null;last_success_unix:number|null;last_check_unix:number|null;inventory_revision:number;verification:string;owner:'self'|'other';items:Item[];selective?:boolean};
export function bytes(n:number|null|undefined){if(n==null)return '—';const u=['B','KB','MB','GB','TB'];let i=0,v=n;while(v>=1024&&i<u.length-1){v/=1024;i++}return (i?v.toFixed(v<10?2:v<100?1:0):String(v))+' '+u[i]}
const percent=(done:number|null|undefined,total:number|null|undefined)=>done!=null&&total?Math.min(100,Math.floor(done/total*100)):null;

/** v1.7.2 · CloudCompute only. Shows only what the GPU server reports: no simulated progress or inventory. */
export function DriveSync(){
 const provider=useDirect(x=>x.provider),url=useDirect(x=>x.url),refreshModels=useDirect(x=>x.refresh);
 const english=useStudio(x=>x.language)==='English';const t=(ru:string,en:string)=>english?en:ru;
 const [status,setStatus]=useState<SyncStatus|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const revision=useRef<number|null>(null);const running=status?.job?.state==='RUNNING';
 const apply=useCallback((next:SyncStatus)=>{setStatus(next);
  // New files were installed on the server: reload the engine's real catalogue (no frontend rebuild, no restart).
  if(revision.current!==null&&next.inventory_revision!==revision.current)void refreshModels(true);
  revision.current=next.inventory_revision},[refreshModels]);
 const call=useCallback(async(action:string,body?:object)=>{setError('');try{apply(await localApi<SyncStatus>('/api/gpu/drive/'+action,action==='status'?undefined:{method:'POST',body:JSON.stringify(body||{})}));return true}catch(e){setError((e as Error).message);return false}},[apply]);
 useEffect(()=>{revision.current=null;setStatus(null);setError('');if(provider==='cloudcompute'&&url)void call('status')},[provider,url,call]);
 useEffect(()=>{if(!running||!url)return;const id=setInterval(()=>{if(document.visibilityState==='visible')void call('status')},2000);return()=>clearInterval(id)},[running,url,call]);
 const [picked,setPicked]=useState<Set<string>>(new Set());
 useEffect(()=>{const refresh=()=>{if(provider==='cloudcompute'&&url)void call('status')};window.addEventListener('yoisaki-drive-bound',refresh);return()=>window.removeEventListener('yoisaki-drive-bound',refresh)},[provider,url,call]);
 if(provider!=='cloudcompute')return null;
 const pickable=(i:Item)=>!!status?.selective&&['MISSING','CHANGED'].includes(i.state);
 const togglePick=(path:string)=>setPicked(old=>{const next=new Set(old);if(next.has(path))next.delete(path);else next.add(path);return next});
 const chosen=status?status.items.filter(i=>pickable(i)&&picked.has(i.path)).map(i=>i.path):[];
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
   <button disabled={disabled||running||!status?.configured} onClick={()=>void act('check')}>{t('Проверить модели','Check models')}</button>
   <button className={status?.configured?'primary':''} disabled={disabled||running||!status?.configured} onClick={()=>void act('sync')}>{t('Синхронизировать','Synchronize')}</button>
   <button className="danger" disabled={busy||!running||status?.owner==='other'||job?.cancel_requested} onClick={()=>void act('cancel')}>{t('Отменить загрузку','Cancel download')}</button>
   <button disabled={busy} onClick={()=>{void act('status');void refreshModels(true)}}>{t('Обновить список','Refresh list')}</button>
  </div>
  {status?.configured&&<button className="danger" disabled={busy||running} onClick={()=>{if(confirm(t('Удалить доступ Google Drive с GPU? Модели сохранятся.','Remove Google Drive access from this GPU? Models are kept.')))void act('disconnect')}}>{t('Отключить Drive на GPU','Disconnect Drive on GPU')}</button>}
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

'use client';
import {create} from 'zustand';
import {localApi} from './local-api';
// v1.7.6 client state of the Google Drive library, the saved selection, the sync monitor and GPU readiness.
// Every value is a server answer; the page never computes progress, speed or availability on its own.
export type Kind='checkpoint'|'lora'|'vae'|'controlnet'|'unknown';
export type Header={checked_at:number;architecture:string;compatible:boolean|null;base_model:string;guess:string|null;payload:'OK'|'MISMATCH'|'INVALID'|'UNKNOWN';reason:string;header_bytes:number|null};
export type DriveItem={id:string;name:string;path:string;folder:string;size:number|null;modified:string|null;checksum:{type:string;value:string}|null;revision:string|null;can_download:boolean;shortcut:boolean;kind:Kind;format:string;visible:boolean;reason:string;sync:{eligible:boolean;reason:string};header?:Header;permission?:string;permission_reason?:string};
export type Inventory={folder:{id:string;name:string};account:string;verified_at:number;duration_ms:number;items:DriveItem[];folders_scanned:number;non_model_files:number;sync_rows:number;truncated:boolean;warnings:string[]};
export type Selection={folder_id:string;folder_name:string;items:Record<string,{id?:string;name:string;kind:Kind;size:number|null}>;updated_at:number}|null;
export type Estimate={count:number;total_bytes:number;download_bytes:number;installed_on_gpu:number;gpu_state_unknown:number;missing_on_drive:number;gpu_disk_required_bytes:number;reserve_bytes:number;disk_check:'UNKNOWN'|'OK'|'INSUFFICIENT'|'PLANNED_OK'|'PLANNED_INSUFFICIENT';disk_message:string;disk_free_bytes?:number;planned_disk_gb?:number};
export type CompareRow={path:string;name:string;kind:Kind;size:number|null;selected:boolean;category:'DRIVE_ONLY'|'INSTALLED'|'UPDATE'|'DOWNLOADING'|'FAILED'|'NOT_SYNCABLE';reason:string;gpu_state:string|null;gpu_model:{id:string;compatible:boolean|null;architecture:string;reason:string}|null};
export type LibraryState='VERIFIED'|'CACHED'|'NONE'|'NOT_CONNECTED'|'FOLDER_NOT_SELECTED'|'AUTH_EXPIRED'|'PERMISSION_DENIED'|'FOLDER_NOT_FOUND'|'OFFLINE'|'RATE_LIMITED'|'ERROR';
export type LibraryView={account:{connected:boolean;email:string;folder:{id:string;name:string}|null};state:LibraryState;verified_now?:boolean;inventory:Inventory|null;other_folder_inventory:{folder:{id:string;name:string};verified_at:number}|null;
 last_check:{at:number;ok:boolean;state:LibraryState;code:string;message:string}|null;checking:boolean;error?:{state:LibraryState;code:string;message:string};selection:Selection;estimate:Estimate;
 comparison:{rows:CompareRow[];gpu_only:{id:string;name:string;kind:Kind;compatible:boolean|null;reason:string}[];counts:Record<string,number>};
 gpu:{connected:boolean;provider:string|null;sync_observed_at:number|null;sync_live:boolean;models_updated_at:number|null;models_stale:boolean}};
export type SyncState='IDLE'|'CHECKING_DRIVE'|'COMPARING_FILES'|'WAITING_FOR_GPU'|'DOWNLOADING'|'VERIFYING'|'COMPLETED'|'CANCELLED'|'ERROR';
export type SyncEvent={at:number;type:string;job_id:string|null;[k:string]:unknown};
export type MonitorView={state:SyncState;state_text:[string,string];source:'LIVE'|'LAST_KNOWN'|'NONE';observed_at:number|null;
 gpu:{connected:boolean;same_origin:boolean;reachable:boolean;error:{code:string;message:string;at:number}|null};
 job:{id:string;type:'check'|'sync';state:string;phase:string;started_unix:number|null;finished_unix:number|null;error:string;error_code:string;cancel_requested:boolean;restart_recommended:boolean;owner:string}|null;
 current:{path:string;name:string;kind:string;phase:string;bytes_done:number|null;bytes_total:number|null;percent:number|null;resumed_from:number|null;speed_bps:number|null;speed_source:'GPU'|'OBSERVED'|null;eta_seconds:number|null}|null;
 overall:{files_total:number;files_done:number;files_failed:number;files_remaining:number;bytes_total:number;bytes_done:number;percent:number|null;eta_seconds:number|null}|null;
 error:{kind:'sync'|'gpu'|'drive';code:string;message:string;action?:string}|null;disk:{free_bytes:number|null;total_bytes:number|null;reserve_bytes:number|null}|null;
 drive_on_gpu:{configured:boolean;connection:{state:string;error:string;code:string};enabled:boolean;rclone_available:boolean}|null;last_success_unix:number|null;
 failures:{consecutive:number;last_code:string;last_at:number|null};discovery:{at:number;error:string;files:{path:string;name:string;kind:string|null;sync_state:string|null;gpu_model:{id:string;architecture:string;compatible:boolean|null}|null;generator:'AVAILABLE'|'AVAILABLE_UNVERIFIED'|'INCOMPATIBLE'|'NOT_FOUND'|'NOT_INSTALLED';reason:string}[]}|null;
 requested:string[]|null;events:SyncEvent[];selection_pending:number};
export type Readiness={cloudcompute:{api:'CONFIGURED'|'NOT_CONFIGURED';instance:{id:string;name:string;status:string;running:boolean;stage:string;stage_message:string;error:string}|null};
 engine:{state:'READY'|'NOT_CONNECTED'|'CONNECTING'|'LOADING'|'ERROR';provider:string|null;version:string|null;compatibility:string;error:string};cuda:'AVAILABLE'|'FAILED'|'UNKNOWN';
 gpu:{name:string|null;vram_total_mb:number|null;vram_available_mb:number|null};storage:{free_bytes:number|null;total_bytes:number|null;reserve_bytes:number|null;source:string}|null;
 drive:{phone:'CONNECTED'|'NOT_CONNECTED';email:string;folder:string|null;on_gpu:string};sync:{state:SyncState;source:string;files_done:number|null;files_total:number|null;files_failed:number|null}|null;
 ready_to_generate:boolean;ready_reason:string;warnings:{code:string;message:string;dashboard:boolean;billing:boolean}[];dashboard:string;checked_at:number};

export const SYNC_TEXT:Record<SyncState,[string,string]>={IDLE:['Ожидание','Idle'],CHECKING_DRIVE:['Чтение Google Drive','Checking Google Drive'],COMPARING_FILES:['Сравнение файлов','Comparing files'],WAITING_FOR_GPU:['Ожидание GPU','Waiting for GPU'],DOWNLOADING:['Загрузка','Downloading'],VERIFYING:['Проверка','Verifying'],COMPLETED:['Завершено','Completed'],CANCELLED:['Отменено','Cancelled'],ERROR:['Ошибка','Error']};
const JOB_KEY='yoisaki.sync.job';
export const savedJobId=()=>{try{return localStorage.getItem(JOB_KEY)||''}catch{return ''}};
const saveJobId=(id:string)=>{try{localStorage.setItem(JOB_KEY,id)}catch{}};
type Store={library:LibraryView|null;monitor:MonitorView|null;readiness:Readiness|null;busy:string;error:string;
 loadLibrary:()=>Promise<void>;check:()=>Promise<void>;inspect:(ids:string[])=>Promise<void>;select:(paths:string[])=>Promise<void>;
 loadMonitor:(live?:boolean)=>Promise<void>;start:(mode:'selected'|'missing'|'retry')=>Promise<void>;cancel:()=>Promise<void>;loadReadiness:()=>Promise<void>;clearError:()=>void};
export const useLibrary=create<Store>((set,get)=>{
 const run=async(name:string,fn:()=>Promise<void>)=>{set({busy:name,error:''});try{await fn()}catch(e){set({error:(e as Error).message})}finally{set({busy:''})}};
 const monitorSet=(m:MonitorView)=>{if(m.job?.id)saveJobId(m.job.id);set({monitor:m})};
 return {library:null,monitor:null,readiness:null,busy:'',error:'',clearError:()=>set({error:''}),
  loadLibrary:async()=>{try{set({library:await localApi<LibraryView>('/api/drive/library')})}catch(e){set({error:(e as Error).message})}},
  check:()=>run('check',async()=>{set({library:await localApi<LibraryView>('/api/drive/library/check',{method:'POST',body:'{}'})})}),
  inspect:ids=>run('inspect',async()=>{for(let i=0;i<ids.length;i+=20){const r=await localApi<LibraryView&{results:{id:string;ok:boolean;error?:string}[]}>('/api/drive/library/inspect',{method:'POST',body:JSON.stringify({ids:ids.slice(i,i+20)})});set({library:r});const bad=r.results.find(x=>!x.ok&&x.error);if(bad&&ids.length===1)set({error:bad.error})}}),
  // Optimistic: the tick shows at once; the server answer (or a reload after an error) is authoritative.
  select:paths=>{const lib=get().library;if(lib?.account.folder){const known=new Map((lib.inventory?.items||[]).map(i=>[i.path,i]));const items=Object.fromEntries(paths.map(p=>{const i=known.get(p);return [p,lib.selection?.items[p]||{id:i?.id,name:i?.name||p,kind:i?.kind||'unknown',size:i?.size??null}]}));set({library:{...lib,selection:{folder_id:lib.account.folder.id,folder_name:lib.account.folder.name,items,updated_at:Date.now()}}})}
   return run('select',async()=>{try{set({library:await localApi<LibraryView>('/api/drive/selection',{method:'PUT',body:JSON.stringify({paths})})})}catch(e){await get().loadLibrary();throw e}})},
  loadMonitor:async(live=true)=>{try{monitorSet(await localApi<MonitorView>('/api/sync/monitor'+(live?'':'?live=0')))}catch(e){set({error:(e as Error).message})}},
  start:mode=>run('start',async()=>{monitorSet(await localApi<MonitorView>('/api/sync/start',{method:'POST',body:JSON.stringify({mode})}));void get().loadLibrary()}),
  cancel:()=>run('cancel',async()=>{monitorSet(await localApi<MonitorView>('/api/sync/cancel',{method:'POST',body:'{}'}))}),
  loadReadiness:async()=>{try{set({readiness:await localApi<Readiness>('/api/system/readiness')})}catch{}},
 };
});
export function bytesText(n:number|null|undefined){if(n==null)return '—';const u=['B','KB','MB','GB','TB'];let i=0,v=n;while(v>=1024&&i<u.length-1){v/=1024;i++}return (i?v.toFixed(v<10?2:v<100?1:0):String(v))+' '+u[i]}
export function durationText(s:number|null,en:boolean){if(s==null)return '';if(s<60)return en?`about ${s} s`:`примерно ${s} с`;const m=Math.round(s/60);if(m<60)return en?`about ${m} min`:`примерно ${m} мин`;const h=Math.floor(m/60);return en?`about ${h} h ${m%60} min`:`примерно ${h} ч ${m%60} мин`}

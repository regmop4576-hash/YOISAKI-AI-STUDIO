import fs from 'node:fs/promises';
import path from 'node:path';
// v1.7.6 real-time Google Drive → CloudCompute monitor. The only input is the validated /sync/status answer of the
// GPU (cloudcompute/drive_sync.py, unchanged since 1.7.5): bytes, speed and file states measured by the sync job
// itself. Structured events are derived by comparing consecutive answers; nothing is interpolated or simulated.
// The last answer, the job ID and the events are kept in sync-monitor.json, so a reloaded page, a restarted phone
// app or a lost connection shows the real last-known state and then the live one, without restarting downloads.
export const SYNC_STATES=['IDLE','CHECKING_DRIVE','COMPARING_FILES','WAITING_FOR_GPU','DOWNLOADING','VERIFYING','COMPLETED','CANCELLED','ERROR'];
export const STATE_TEXT={IDLE:['Ожидание','Idle'],CHECKING_DRIVE:['Чтение Google Drive','Checking Google Drive'],COMPARING_FILES:['Сравнение файлов','Comparing files'],WAITING_FOR_GPU:['Ожидание GPU','Waiting for GPU'],DOWNLOADING:['Загрузка','Downloading'],VERIFYING:['Проверка','Verifying'],COMPLETED:['Завершено','Completed'],CANCELLED:['Отменено','Cancelled'],ERROR:['Ошибка','Error']};
const PHASE_STATE={LISTING:'CHECKING_DRIVE',COMPARING:'COMPARING_FILES',HASHING_LOCAL:'COMPARING_FILES',DOWNLOADING:'DOWNLOADING',VERIFYING_PARTIAL:'DOWNLOADING',VERIFYING:'VERIFYING',INSTALLING:'VERIFYING',DONE:'VERIFYING'};
const EVENTS_MAX=200,SAMPLE_WINDOW=30000,LIVE_MS=15000;
// Actionable advice per drive_sync.py error code; kind separates Drive authorization problems from sync problems.
const ADVICE={
 DISK_SPACE:['sync','Освободите место на диске GPU или снимите выбор с части моделей и повторите.'],
 AUTH_FAILED:['drive','Войдите в Google заново (Модели → Аккаунт и папка), затем «Повторить»: доступ будет передан GPU снова.'],
 NOT_CONFIGURED:['drive','Доступ Google Drive не передан этому GPU. «Повторить» передаст его автоматически.'],
 SOURCE_NOT_FOUND:['drive','Папка или файл не найдены на Google Drive. Проверьте папку в «Модели → Google Drive».'],
 RATE_LIMITED:['drive','Google временно ограничил скачивание. Повторите позже: уже загруженные файлы не скачиваются заново.'],
 NETWORK:['sync','Связь GPU с Google прервалась. «Повторить» продолжит загрузку с места остановки.'],
 INCOMPLETE:['sync','Передача прервалась. «Повторить» продолжит загрузку с места остановки.'],
 VERIFY_FAILED:['sync','Контрольная сумма не совпала: файл отброшен. Если ошибка повторяется, файл на Google Drive повреждён — загрузите его заново.'],
 INVALID_MODEL:['sync','Файл не прошёл проверку движка (safetensors/SDXL). Замените его на Google Drive.'],
 CONFLICT:['sync','На GPU уже есть другой файл с этим именем; он не перезаписывается.'],
 INTERRUPTED:['sync','Синхронизация прервана перезапуском движка. «Повторить» продолжит загрузку с места остановки.'],
 TOO_MANY_FILES:['drive','В папке больше 2000 файлов. Разделите библиотеку.'],
 BUSY:['sync','На GPU уже выполняется синхронизация.'],
 RCLONE_MISSING:['sync','На GPU нет rclone: используйте опубликованный образ YOISAKI ENGINE.'],
 READ_ONLY:['sync','Папка моделей на GPU только для чтения.'],
};
export function stageOf(status){
 const job=status?.job;if(!job)return 'IDLE';
 if(job.state==='RUNNING')return PHASE_STATE[job.phase]||'CHECKING_DRIVE';
 if(job.state==='COMPLETED')return job.overall.files_failed>0?'ERROR':'COMPLETED';
 if(job.state==='CANCELLED')return 'CANCELLED';
 return 'ERROR';
}
const pct=(done,total)=>Number.isFinite(done)&&total>0?Math.min(100,Math.floor(done/total*100)):null;
const compact=s=>({enabled:s.enabled,rclone_available:s.rclone_available,configured:s.configured,connection:s.connection,job:s.job,disk:s.disk,last_success_unix:s.last_success_unix,last_check_unix:s.last_check_unix,inventory_revision:s.inventory_revision,owner:s.owner,selective:s.selective,items:s.items});

export class SyncMonitor{
 constructor({dir,now=()=>Date.now()}){this.file=path.join(dir,'sync-monitor.json');this.now=now;this.data={version:1,job:null,last:null,events:[],failures:{consecutive:0,last_code:'',last_at:null},discovery:null,gpu_error:null};this.samples=[];this.savedAt=0;this.chain=Promise.resolve()}
 async init(){try{const raw=JSON.parse(await fs.readFile(this.file,'utf8'));if(raw?.version===1)this.data={...this.data,...raw}}catch(e){if(e.code!=='ENOENT')await fs.rename(this.file,this.file+'.damaged-'+Date.now()).catch(()=>{})}return this}
 save(force=false){
  if(this.closed)return this.chain;   // the app is shutting down: no writes after close()
  const t=this.now();if(!force&&t-this.savedAt<2000)return this.chain;this.savedAt=t;const bytes=JSON.stringify(this.data);
  const task=this.chain.then(async()=>{const temp=this.file+'.tmp';const h=await fs.open(temp,'w',0o600);try{await h.writeFile(bytes)}finally{await h.close()}await fs.rename(temp,this.file)});
  this.chain=task.catch(()=>{});return task;
 }
 event(type,detail={}){this.data.events.push({at:this.now(),job_id:this.data.job?.id||null,...detail,type});if(this.data.events.length>EVENTS_MAX)this.data.events.splice(0,this.data.events.length-EVENTS_MAX)}
 running(){return this.data.last?.status?.job?.state==='RUNNING'}
 lastItems(){return this.data.last?.status?.items||null}
 lastDisk(){return this.data.last?.status?.disk||null}
 // Paths this app asked the GPU to download (for the post-sync model discovery).
 request(paths,origin){this.pending={paths:paths?[...paths].slice(0,2000):null,origin,at:this.now()}}
 // Returns {finished:boolean, job} — finished is true once, when a sync job is first seen as ended.
 observe(status,origin){
  const t=this.now(),prev=this.data.last?.origin===origin?this.data.last.status:null,job=status.job,pj=prev?.job;let finished=false,changed=false;
  if(this.data.gpu_error){this.event('GPU_RECONNECTED',{origin_host:host(origin)});this.data.gpu_error=null;changed=true}
  if(job&&(!this.data.job||this.data.job.id!==job.id)){
   const requested=this.pending&&this.pending.origin===origin&&t-this.pending.at<120000?this.pending.paths:null;this.pending=null;
   this.data.job={id:job.id,type:job.type,origin,started_unix:job.started_unix,requested,seen:[],finish_recorded:job.state!=='RUNNING'};
   this.samples=[];
   this.event(job.state==='RUNNING'?'JOB_STARTED':'JOB_FOUND',{job_type:job.type,state:job.state});changed=true;
   if(job.type==='sync'&&job.state==='RUNNING')this.data.discovery=null;
  }
  if(job){
   const from=pj&&pj.id===job.id?stageOf(prev):null,to=stageOf(status);
   if(from!==to&&(from||job.state==='RUNNING')){this.event('STAGE',{from,to,phase:job.phase});changed=true}
   const cur=job.current,pcur=pj&&pj.id===job.id?pj.current:null;
   if(cur&&cur.path&&cur.path!==pcur?.path){this.event('FILE_STARTED',{path:cur.path,kind:cur.kind,bytes_total:cur.bytes_total,resumed_from:cur.resumed_from||null});changed=true;if(!this.data.job.seen.includes(cur.path))this.data.job.seen.push(cur.path)}
   if(prev&&pj?.id===job.id){
    const before=new Map(prev.items.map(i=>[i.path,i.state]));
    for(const i of status.items){const b=before.get(i.path);if(b===i.state)continue;
     if(i.state==='INSTALLED'&&['DOWNLOADING','VERIFYING','MISSING','CHANGED'].includes(b)){this.event('FILE_INSTALLED',{path:i.path,kind:i.kind,size:i.size,verification:i.verification});changed=true}
     else if(i.state==='FAILED'){this.event('FILE_FAILED',{path:i.path,kind:i.kind,reason:i.reason});changed=true}}
   }
   if(job.state==='RUNNING'&&job.type==='sync'){this.samples.push([t,job.overall.bytes_done]);while(this.samples.length>2&&t-this.samples[0][0]>SAMPLE_WINDOW)this.samples.shift()}
   if(job.state!=='RUNNING'&&!this.data.job.finish_recorded){
    this.data.job.finish_recorded=true;finished=job.type==='sync';changed=true;
    this.event('JOB_FINISHED',{job_type:job.type,state:job.state,files_done:job.overall.files_done,files_failed:job.overall.files_failed,error_code:job.error_code||null,error:job.error||null});
    if(job.type==='sync'){const bad=job.state!=='COMPLETED'&&job.state!=='CANCELLED'||job.overall.files_failed>0;this.data.failures=bad?{consecutive:this.data.failures.consecutive+1,last_code:job.error_code||'FILES_FAILED',last_at:t}:job.state==='COMPLETED'?{consecutive:0,last_code:'',last_at:null}:this.data.failures}
   }
  }
  this.data.last={status:compact(status),observed_at:t,origin};
  this.save(changed);return {finished,job};
 }
 gpuUnreachable(error,origin){
  if(!this.data.gpu_error){this.event('GPU_UNREACHABLE',{code:error.code||'LOCAL_ERROR',message:error.error,origin_host:host(origin)});}
  this.data.gpu_error={code:error.code||'LOCAL_ERROR',message:error.error,at:this.now(),origin};this.save(true);
 }
 setDiscovery(d){this.data.discovery=d;this.event('INVENTORY_REFRESHED',{found:d.files.filter(f=>f.gpu_model).length,total:d.files.length,error:d.error||null});this.save(true)}
 speed(job){
  const cur=job?.current;
  if(cur&&Number.isFinite(cur.speed_bps)&&cur.speed_bps>0)return {bps:cur.speed_bps,source:'GPU'};
  const s=this.samples;if(s.length>=2){const [t0,b0]=s[0],[t1,b1]=s.at(-1);if(t1-t0>=3000&&b1>b0)return {bps:Math.round((b1-b0)/((t1-t0)/1000)),source:'OBSERVED'}}
  return null;
 }
 view({connected=false,origin='',selectionPending=0,live=false}={}){
  const last=this.data.last,status=last?.status||null,job=status?.job||null,t=this.now();
  const sameGpu=!!connected&&last?.origin===origin;
  const fresh=sameGpu&&!this.data.gpu_error&&t-(last?.observed_at||0)<LIVE_MS;
  let state=status?stageOf(status):'IDLE';let error=null;
  const runningOnGpu=job?.state==='RUNNING';
  if(!connected||!sameGpu){
   if(runningOnGpu)error={kind:'gpu',code:'GPU_OFFLINE',message:'GPU не подключён к приложению. Показано последнее известное состояние: на GPU загрузка может продолжаться. Подключите GPU, чтобы увидеть текущий прогресс.'};
   else state=selectionPending>0?'WAITING_FOR_GPU':state==='IDLE'||!status?'IDLE':state;
  }else if(this.data.gpu_error)error={kind:'gpu',code:this.data.gpu_error.code,message:'Связь с GPU потеряна: '+this.data.gpu_error.message+' Синхронизация на GPU продолжается без телефона; показано последнее известное состояние.'};
  if(!error&&job&&state==='ERROR'){
   const [kind,action]=ADVICE[job.error_code]||['sync',job.overall.files_failed?'Нажмите «Повторить»: загрузятся только файлы с ошибкой, готовые не скачиваются заново.':'Нажмите «Повторить».'];
   error={kind,code:job.error_code||'FILES_FAILED',message:job.error||`Файлов с ошибкой: ${job.overall.files_failed}.`,action};
  }
  const sp=runningOnGpu?this.speed(job):null,cur=job?.current||null,downloading=runningOnGpu&&job.phase==='DOWNLOADING';
  const remaining=(total,done)=>sp&&downloading&&Number.isFinite(total)&&Number.isFinite(done)&&total>=done?Math.ceil((total-done)/sp.bps):null;
  const o=job?.overall;
  return {
   state,state_text:STATE_TEXT[state],source:!status?'NONE':fresh?'LIVE':'LAST_KNOWN',observed_at:last?.observed_at||null,live,
   gpu:{connected:!!connected,same_origin:sameGpu,reachable:sameGpu&&!this.data.gpu_error,error:this.data.gpu_error},
   job:job?{id:job.id,type:job.type,state:job.state,phase:job.phase,started_unix:job.started_unix,finished_unix:job.finished_unix,error:job.error,error_code:job.error_code,cancel_requested:job.cancel_requested,restart_recommended:job.restart_recommended,owner:status.owner}:null,
   current:runningOnGpu&&cur?{path:cur.path,name:cur.path.split('/').at(-1),kind:cur.kind,phase:cur.phase,bytes_done:cur.bytes_done,bytes_total:cur.bytes_total,percent:pct(cur.bytes_done,cur.bytes_total),resumed_from:cur.resumed_from,speed_bps:sp?.bps??null,speed_source:sp?.source??null,eta_seconds:remaining(cur.bytes_total,cur.bytes_done)}:null,
   overall:o?{files_total:o.files_total,files_done:o.files_done,files_failed:o.files_failed,files_remaining:Math.max(0,o.files_total-o.files_done-o.files_failed),bytes_total:o.bytes_total,bytes_done:o.bytes_done,percent:job.type==='sync'?pct(o.bytes_done,o.bytes_total):null,eta_seconds:remaining(o.bytes_total,o.bytes_done)}:null,
   error,disk:status?.disk||null,drive_on_gpu:status?{configured:status.configured,connection:status.connection,enabled:status.enabled,rclone_available:status.rclone_available}:null,
   last_success_unix:status?.last_success_unix||null,failures:this.data.failures,discovery:this.data.discovery,requested:this.data.job?.requested||null,
   events:this.data.events.slice(-60),selection_pending:selectionPending,
  };
 }
}
function host(origin){try{return new URL(origin).hostname}catch{return ''}}

// After a sync: which downloaded files the refreshed engine catalogue now lists, and whether the generator can use them.
export function discoveryReport(paths,items,models,{error=''}={}){
 const byPath=new Map((items||[]).map(i=>[i.path,i]));
 const files=[...new Set(paths)].map(p=>{
  const i=byPath.get(p),name=p.split('/').at(-1),kind=i?.kind||null;
  const m=(models||[]).find(x=>x.name===name&&(!kind||x.kind===kind));
  const generator=!i||i.state!=='INSTALLED'?'NOT_INSTALLED':!m?'NOT_FOUND':m.compatible===false?'INCOMPATIBLE':m.compatible===null?'AVAILABLE_UNVERIFIED':'AVAILABLE';
  const reason=generator==='NOT_INSTALLED'?(i?.reason||'Файл не установлен этой синхронизацией.'):generator==='NOT_FOUND'?'Файл установлен, но обновлённый каталог движка его не показывает. Нажмите «Обновить список GPU»; если не помогло — проверьте журнал GPU.':m.compatibility_reason||'';
  return {path:p,name,kind,sync_state:i?.state||null,gpu_model:m?{id:m.id,architecture:m.architecture,compatible:m.compatible}:null,generator,reason};
 });
 return {at:Date.now(),files,error};
}

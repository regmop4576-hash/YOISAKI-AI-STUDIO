// v1.7.6 independent GPU indicators. Each one is derived only from what this app observed: the CloudCompute key and
// the deployment watcher (instance status), the engine /health answer (engine, CUDA, GPU, VRAM), the sync status
// (storage, Drive on GPU) and the phone's own Google account. READY TO GENERATE requires a successful engine health
// check plus a usable checkpoint — a valid CloudCompute API key alone never makes anything READY.
const RUNNING_INSTANCE=/^(running|active|started|ready)$/i;
export function readiness({cloudConfigured,deployment,connection,state,info,lastCode,lastError,models,monitor,drive,compatibility}){
 const connected=!!connection&&connection.provider==='cloudcompute';
 const healthy=!!connection&&!!info&&['READY','BUSY'].includes(state);
 const engine=!connection?(state==='CONNECTING'?'CONNECTING':'NOT_CONNECTED'):state==='LOADING'?'LOADING':healthy?'READY':'ERROR';
 const gpuStages=(deployment?.gpu_stages||[]).map(s=>s.stage);
 const cuda=lastCode==='GPU_NOT_READY'||gpuStages.at(-1)==='GPU_CHECK_FAILED'?'FAILED':connection&&info&&info.gpu_name?'AVAILABLE':'UNKNOWN';
 const usable=(models||[]).some(m=>m.kind==='checkpoint'&&m.compatible!==false);
 // A created instance is billed until it is deleted (INSTANCE_GONE), even after a failed engine start.
 const billing=deployment?deployment.stage!=='INSTANCE_GONE':connected;
 const sync=monitor||null;
 const out={
  // v1.7.7: "instance running" (CloudCompute) and "engine ready" (health check passed) are separate facts.
  cloudcompute:{api:cloudConfigured?'CONFIGURED':'NOT_CONFIGURED',instance:deployment?{id:deployment.instance_id,name:deployment.name,status:deployment.instance_status||'UNKNOWN',
   running:deployment.provider?deployment.provider.phase==='RUNNING':RUNNING_INSTANCE.test(deployment.instance_status||''),provider_phase:deployment.provider?.phase||'UNKNOWN',
   engine_ready:connected&&healthy,stage:deployment.stage,stage_message:deployment.stage_message,error:deployment.error,failure:deployment.failure||null}:null},
  engine:{state:engine,provider:connection?.provider||null,version:info?.engine_version||null,compatibility,error:connection||state==='ERROR'?lastError||'':''},
  cuda,gpu:{name:connection&&info?.gpu_name||null,vram_total_mb:connection?info?.vram_total_mb??null:null,vram_available_mb:connection?info?.vram_available_mb??null:null},
  storage:sync?.disk?{...sync.disk,source:sync.source}:null,
  drive:{phone:drive.connected?'CONNECTED':'NOT_CONNECTED',email:drive.email||'',folder:drive.folder?.name||null,on_gpu:sync?.drive_on_gpu?sync.drive_on_gpu.configured?sync.drive_on_gpu.connection.state:'NOT_CONFIGURED':'UNKNOWN'},
  sync:sync?{state:sync.state,source:sync.source,files_done:sync.overall?.files_done??null,files_total:sync.overall?.files_total??null,files_failed:sync.overall?.files_failed??null}:null,
  ready_to_generate:healthy&&usable,
  ready_reason:!connection?'GPU-движок не подключён.':!healthy?'Проверка состояния движка (health) не пройдена.':!usable?'На GPU нет совместимого checkpoint: синхронизируйте модели.':'',
  warnings:[],
 };
 const warn=(code,message,dashboard=true)=>out.warnings.push({code,message,dashboard,billing});
 const bill=' Отключение сайта или закрытие приложения НЕ останавливает оплату GPU: остановите или удалите инстанс в панели CloudCompute.';
 if(cuda==='FAILED')warn('CUDA_FAILED','GPU не прошёл проверку CUDA: генерация невозможна.'+(billing?bill:''));
 const f=deployment?.failure;
 if(deployment?.stage==='FAILED'&&f&&['cloudcompute','docker','gpu_host'].includes(f.component))warn('INSTANCE_FAILED',({cloudcompute:'CloudCompute',docker:'Docker на хосте CloudCompute',gpu_host:'Драйвер/NVIDIA Container Toolkit на хосте'}[f.component])+': '+(f.message||deployment.stage_message)+(billing?bill:''));
 else if(gpuStages.at(-1)==='ENGINE_FAILED'||deployment?.stage==='FAILED')warn('ENGINE_FAILED','Движок YOISAKI не запустился на GPU: '+(deployment?.stage_message||deployment?.error||'см. журнал инстанса')+(billing?bill:''));
 if(f?.code==='INSTANCE_STOPPED')warn('INSTANCE_STOPPED','CloudCompute: '+f.message+'. Хранение диска может оплачиваться.');
 if(deployment?.stage==='TIMEOUT')warn('ENGINE_TIMEOUT',(deployment.stage_message||'Движок не сообщил о готовности.')+bill);
 if(billing&&connected&&engine==='ERROR')warn('ENGINE_UNREACHABLE','Связь с движком потеряна: '+(lastError||'нет ответа')+bill);
 if(drive.connected&&sync?.drive_on_gpu?.connection?.state==='ERROR'&&['AUTH_FAILED','NOT_CONFIGURED'].includes(sync.drive_on_gpu.connection.code))warn('DRIVE_AUTH_FAILED','GPU не может прочитать Google Drive: '+sync.drive_on_gpu.connection.error+(billing?bill:''),billing);
 if(sync?.error?.kind==='drive'&&billing)warn('DRIVE_SYNC_BLOCKED','Синхронизация не может начаться: '+sync.error.message+bill);
 if((sync?.failures?.consecutive||0)>=2)warn('SYNC_REPEATED_FAILURE',`Синхронизация завершилась с ошибкой ${sync.failures.consecutive} раз подряд (${sync.failures.last_code}).`+(billing?bill:''),billing);
 return out;
}

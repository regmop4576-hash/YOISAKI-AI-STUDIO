import {providerConfig,providerName,endpoint} from './providers.mjs';
import {validatePreprocess,validateControlImage,compactControlRequest} from './controlnet.mjs';
import {compactSourceRequest} from './img2img.mjs';
import {TERMINAL_STATUSES,HISTORY_LIMIT,isTerminal,matchesHistory} from './history.mjs';
import {WEBSITE_VERSION,STUDIO_EDITION,COMPATIBLE_ENGINE_FAMILY,engineCompatibility} from './release.mjs';
import {SYNC_ACTIONS,validateSyncStatus,validateConnect,validateSyncStart} from './drive-sync.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from './storage.mjs';
import {parseTunnel,requestUpstream,validateHealth,validateGeneration,supportsRegionalControl} from './upstream.mjs';
import {AppError,fail,publicError} from './errors.mjs';
import {parseInventory} from './inventory.mjs';
import {SecretStore} from './secrets.mjs';
import {classify,components} from './connect-flow.mjs';
import {discover,RENDEZVOUS_HOST} from './rendezvous.mjs';
import {OAuthFlows,exchangeCode,validateClient,redirectUri,SCOPE,postForm,loadPublicClient} from './google-oauth.mjs';
import {CloudComputeApi,loadContract,validateKey,INSTANCE_ID_RE,API_HOST,DOCS_URL,PANEL_URL} from './cloudcompute-api.mjs';
import {DriveAccount} from './drive-account.mjs';
import {httpsJson} from './https-json.mjs';
const ID=/^[a-f0-9-]{36}(?:_[0-3])?$/;
const terminal=TERMINAL_STATUSES;
async function readBody(req,max=12582912){const chunks=[];let n=0;for await(const b of req){n+=b.length;if(n>max)fail('BODY_TOO_LARGE','Слишком большой запрос.',413);chunks.push(b)}return Buffer.concat(chunks)}
async function jsonBody(req){try{return JSON.parse((await readBody(req)).toString())}catch(e){if(e instanceof AppError)throw e;fail('INVALID_JSON','Неверный JSON запроса.')}}
function send(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
export async function createLocalApp({dataDir,distDir,upstream=requestUpstream,serviceKey='',discoverAddress=discover,exchange=exchangeCode,sleep=ms=>new Promise(r=>setTimeout(r,ms).unref?.()),
 ccRequest=httpsJson,googlePost=postForm,driveRequest=httpsJson,appRoot=null,env=process.env,instanceWaitMs=10*60*1000}={}){
 const store=await new Store(dataDir).init();
 // v1.7.3: remembered connections and the Google OAuth client live in secrets.json (0600), never in state.json.
 const secrets=await new SecretStore(dataDir).init();const oauth=new OAuthFlows();let oauthResult=null;
 // v1.7.3 CloudCompute REST API (instance discovery/lifecycle; contract-driven, see cloudcompute-api.mjs) and the
 // GPU-independent Google Drive link. Neither the API key nor the refresh token ever reaches the page.
 const {contract,error:contractError}=await loadContract(dataDir);const cc=new CloudComputeApi({contract,request:ccRequest});
 const publicGoogle=await loadPublicClient({appRoot,env});
 const drive=new DriveAccount({secrets,publicClient:publicGoogle.client,post:googlePost,request:driveRequest});
 const ccState={instances:[],listed_at:null,error:'',code:''};let gpuFlow=null;
 const driveGpu={state:'IDLE',message:'',code:'',at:null,origin:null};
 if(store.data.history.some(j=>['RUNNING','QUEUED'].includes(j.status)))await store.change(d=>{for(const j of d.history)if(['RUNNING','QUEUED'].includes(j.status)){j.status='CONNECTION_LOST';j.connection_error='Состояние сохранено. Подключитесь к прежней сессии GPU для проверки.'}});
 let connection=null,info=null,state='OFFLINE',lastError='',lastCode='',epoch=0,refreshing=null,closed=false,polling=false,submissionChain=Promise.resolve();
 // v1.7.3 connection phase (OFFLINE…READY/ERROR) shown to the user, the running auto-connect and the model-list health.
 let refreshingForced=false,phase='OFFLINE',phaseMessage='',auto=null,connectedAt=0;const modelsState={error:'',code:''};
 const setPhase=(p,message='')=>{phase=p;phaseMessage=message};
 const jobs=new Map();const acknowledgements=new Map();const session=randomBytes(32).toString('hex');
 const diagnostics=[];
 const note=(code)=>{diagnostics.push({at:new Date().toISOString(),code});if(diagnostics.length>30)diagnostics.shift()};
 // No credentials are ever stored in state.json. Unfinished histories can resume on explicit reconnect.
 const historySnapshot=()=>({items:store.data.history.map(j=>({...j,terminal:isTerminal(j),can_delete:isTerminal(j)&&!jobs.has(j.id)})),limit:HISTORY_LIMIT});
 let providers=providerConfig(store.data.preferences);
 const currentPhase=()=>connection?(state==='ERROR'?'ERROR':state==='LOADING'?'LOADING':'READY'):phase;
 // v1.7.3: the provider side (CloudCompute instance via API) is a separate component from the engine behind it.
 const instanceComponent=()=>gpuFlow.step==='ERROR'&&String(lastCode).startsWith('CC_')?'ERROR':['INSTANCE_RUNNING','READY'].includes(gpuFlow.step)||!String(lastCode).startsWith('CC_')&&gpuFlow.step==='ERROR'?'READY':'WAITING';
 const status=()=>{
  const inv=store.data.inventory||null,p=currentPhase();
  return {provider:providers.selected,endpoints:{...providers.endpoints},url:connection?.origin||'',state,info,models:store.data.models,error:lastError,code:lastCode,storage_warning:store.warning,website_version:WEBSITE_VERSION,compatible_engine_family:COMPATIBLE_ENGINE_FAMILY,compatibility:engineCompatibility(info),
   // v1.7.3: the list is never presented as current when it is not (models_stale) and rejected entries are listed.
   phase:p,phase_message:connection&&p!=='ERROR'?'':phaseMessage,
   components:{...(gpuFlow?.api?{instance:instanceComponent()}:{}),...components({phase:p,info:connection?info:null,code:lastCode,modelsCount:store.data.models.length,modelsError:modelsState.error,usableCheckpoints:store.data.models.some(m=>m.kind==='checkpoint'&&m.compatible!==false)})},
   models_updated_at:inv?.updated_at||null,models_origin:inv?.origin||null,models_rejected:inv?.rejected||[],models_error:modelsState.error,models_code:modelsState.code,
   models_stale:!connection||!!modelsState.error||!!inv?.origin&&inv.origin!==connection.origin,
   connected_at:connection?connectedAt:null,remembered:secrets.publicView(),secrets_warning:secrets.warning,rendezvous_host:RENDEZVOUS_HOST,
   autoconnect:auto?{attempt:auto.attempt,started_at:auto.started_at,deadline:auto.deadline,origin:auto.origin}:null,
   gpu_flow:gpuFlow?{...gpuFlow}:null,cloudcompute_api:{configured:!!secrets.cloudcompute(),instance_id:secrets.cloudcompute()?.instance_id||null,available:cc.capabilities().get},
   drive_link:{linked:!!secrets.drive(),reauth:!!secrets.drive()?.reauth,folder:!!secrets.drive()?.folder},drive_gpu:{...driveGpu}};
 };
 async function disconnectSession(){
  const version=++epoch;refreshing=null;connection=null;info=null;state='OFFLINE';lastError='';lastCode='';jobs.clear();acknowledgements.clear();auto=null;connectedAt=0;setPhase('OFFLINE');modelsState.error='';modelsState.code='';gpuFlow=null;Object.assign(driveGpu,{state:'IDLE',message:'',code:'',at:null,origin:null});
  // Disconnect does not cancel GPU work. Preserve unresolved records for explicit reconnect.
  await store.change(d=>{for(const j of d.history)if(!terminal.includes(j.status)){j.status='CONNECTION_LOST';j.connection_error='GPU отключён. Подключитесь к прежнему провайдеру и адресу для проверки.'}});
  return version;
 }
 const sameProvider=(job,c)=>job.origin===c.origin&&(job.provider||'colab')===c.provider;
 // v1.7.3: stores the compact inventory (no safetensors metadata) and where/when it was read.
 const mergeModels=async(inv,c)=>store.change(d=>{d.models=inv.models;d.inventory={updated_at:Date.now(),provider:c?.provider||null,origin:c?.origin||null,revision:inv.revision||null,rejected:inv.rejected};for(const m of inv.models){if(m.kind!=='lora'||d.tags[m.id])continue;const source=inv.tagSources[m.id]||{};let words=source.trigger_words||source.sidecar?.trainedWords;const tags=Array.isArray(words)?words:typeof words==='string'&&!words.trim().startsWith('{')?words.split(/[,\n]/):[];d.tags[m.id]={model_id:m.id,trigger_words:tags.filter(x=>typeof x==='string').slice(0,64),recommended_tags:[],description:typeof source.sidecar?.description==='string'?source.sidecar.description.slice(0,4000):''}}});
 // CloudCompute 1.7.3 servers offer /inventory (compact list + revision). Older servers answer 404 (remembered for this
 // connection); any other failure of /inventory falls back to the engine's own /models for this one call.
 async function loadModels(c){
  if(c.provider==='cloudcompute'&&c.inventory!==false){try{return parseInventory(await upstream(c,'/inventory?models=1',{timeout:30000}))}catch(e){if(e.code==='AUTH_REJECTED')throw e;if(e.code==='JOB_NOT_FOUND')c.inventory=false;else note('INVENTORY_FALLBACK')}}
  return parseInventory(await upstream(c,'/models',{timeout:30000}));
 }
 // A failed model refresh keeps the old list but marks it stale with the reason; the GPU connection stays usable.
 async function syncModels(c,version){
  try{const inv=await loadModels(c);if(version!==epoch)return;await mergeModels(inv,c);modelsState.error='';modelsState.code=''}
  catch(e){if(version!==epoch)return;modelsState.error=publicError(e).error;modelsState.code=e.code||'LOCAL_ERROR';note('MODELS_'+modelsState.code)}
 }
 // Cheap change probe: models copied to the GPU (scp, Drive sync) appear without pressing anything.
 async function inventoryChanged(c){
  if(c.provider!=='cloudcompute'||c.inventory===false)return false;
  try{const r=await upstream(c,'/inventory',{timeout:15000});const rev=typeof r?.revision==='string'?r.revision:null;return !!rev&&(rev!==store.data.inventory?.revision||store.data.inventory?.origin!==c.origin)}
  catch(e){if(e.code==='JOB_NOT_FOUND')c.inventory=false;return false}
 }
 async function refresh(forceModels=false){if(!connection)return status();
 // v1.7.3: a forced model refresh is never swallowed by a plain status refresh that is already running.
 if(refreshing){if(!forceModels||refreshingForced)return refreshing;return refreshing.then(()=>refresh(true))}
 const current=connection,version=epoch;refreshingForced=forceModels;
 refreshing=(async()=>{try{const health=validateHealth(await upstream(current,'/health',{timeout:20000}));if(epoch!==version)return status();info=health;state=health.state;lastError='';lastCode='';
  if(forceModels||await inventoryChanged(current))await syncModels(current,version);
 }catch(e){if(epoch===version){state='ERROR';info=null;lastError=publicError(e).error;lastCode=e.code||'LOCAL_ERROR';note(lastCode)}}return status()})().finally(()=>{refreshing=null;refreshingForced=false});return refreshing;
 }
 // Shared by the manual link connect and the one-click auto-connect: health → models → activate.
 async function establish(c,version){
  setPhase('AUTHENTICATING','Проверяю токен и состояние движка…');
  const h=validateHealth(await upstream(c,'/health',{timeout:20000}));if(version!==epoch)fail('SUPERSEDED','Подключение отменено.',409);
  setPhase('LOADING','Движок отвечает. Загружаю список моделей…');
  let inv=null,modelsError=null;try{inv=await loadModels(c)}catch(e){if(e.code==='AUTH_REJECTED')throw e;modelsError=e}
  if(version!==epoch)fail('SUPERSEDED','Подключение отменено.',409);
  await store.change(d=>{for(const j of d.history)if(!['COMPLETED','FAILED','CANCELLED','INTERRUPTED'].includes(j.status)){j.status='CONNECTION_LOST';j.connection_error='Ожидается подтверждение GPU'}});
  if(version!==epoch)fail('SUPERSEDED','Подключение отменено.',409);jobs.clear();acknowledgements.clear();connection=c;info=h;state=h.state;auto=null;connectedAt=Date.now();if(gpuFlow)gpuFlow.step='READY';
  if(inv){await mergeModels(inv,c);modelsState.error='';modelsState.code=''}else{modelsState.error=publicError(modelsError).error;modelsState.code=modelsError.code||'LOCAL_ERROR';note('MODELS_'+modelsState.code)}
  await store.change(d=>{d.preferences={...d.preferences,last_host:c.origin}});
  if(version!==epoch)fail('SUPERSEDED','Подключение отменено.',409);
  for(const j of store.data.history){if(sameProvider(j,c)&&!['COMPLETED','FAILED','CANCELLED'].includes(j.status)){jobs.set(j.id,c);await setJob(j.id,{status:'CONNECTION_LOST',connection_error:'Проверяем прежнюю задачу…'})}}
  if(/^1\.[5-7]\./.test(h.engine_version||''))for(const j of store.data.history.filter(j=>sameProvider(j,c)&&j.status==='COMPLETED'&&j.result?.image_keys?.every((_,i)=>store.data.gallery.some(g=>g.id===j.id+'_'+i))))acknowledgements.set(j.id,c);
  lastError='';lastCode='';setPhase('READY');note('CONNECTED');
  // v1.7.3: the user's Drive link (set up on the phone, possibly while no GPU existed) reaches the GPU now.
  if(c.provider==='cloudcompute'&&secrets.drive())void provisionDrive(c,version).catch(()=>{});
 }
 // Hands the Drive link to the user's own CloudCompute server (rclone there) and, if enabled, starts the sync of
 // missing models. Failures are shown on the Models page; the GPU connection itself is never affected.
 async function provisionDrive(c,version,{force=false}={}){
  const d=secrets.drive();if(!d||c.provider!=='cloudcompute')return;
  const alive=()=>version===epoch&&connection===c;
  const done=(state,message='',code='')=>{if(alive()||force)Object.assign(driveGpu,{state,message,code,at:Date.now(),origin:c.origin})};
  try{
   if(d.reauth)return done('ERROR','Доступ к Google Drive истёк: войдите через Google заново.','DRIVE_REAUTH_REQUIRED');
   done('RUNNING','Передаю доступ к Google Drive на GPU-сервер…');
   const st=validateSyncStatus(await upstream(c,'/sync/status',{timeout:20000}));if(!alive()&&!force)return;
   if(!st.enabled)return done('ERROR','Синхронизация отключена на GPU-сервере (YOISAKI_DRIVE_SYNC=0).','DRIVE_DISABLED');
   if(!st.rclone_available)return done('ERROR','На GPU-сервере нет rclone: выполните ./start-cloudcompute.sh (он установит rclone).','DRIVE_RCLONE_MISSING');
   let note2='';
   if(force||drive.needsProvision(c.origin)||!st.configured){
    const cred=await drive.gpuCredentials();const body={token:cred.token,client_id:cred.client_id,client_secret:cred.client_secret};
    if(cred.folder&&st.folder_select){body.folder_id=cred.folder.id;body.folder_label=cred.folder.path||cred.folder.name}
    else if(cred.folder)note2=' Сервер CloudCompute старше 1.7.3 не принимает выбранную папку: он берёт папку из YOISAKI_DRIVE_PATH. Обновите пакет на сервере.';
    if(!alive()&&!force)return;
    validateSyncStatus(await upstream(c,'/sync/drive/connect',{method:'POST',body:validateConnect(body),timeout:30000}));await drive.markProvisioned(c.origin);note('DRIVE_PROVISIONED');
   }
   if(secrets.drive()?.auto_sync&&st.job?.state!=='RUNNING'&&(alive()||force)){
    try{await upstream(c,'/sync/start',{method:'POST',body:'{}',timeout:30000});note('DRIVE_AUTO_SYNC');return done('SYNCING','Google Drive подключён к GPU-серверу; загрузка недостающих моделей запущена.'+note2)}
    catch(e){if(e.code!=='DRIVE_BUSY')throw e}
   }
   done('DONE','Google Drive подключён к GPU-серверу.'+note2);
  }catch(e){done('ERROR',publicError(e).error,e.code||'DRIVE_ERROR');note('DRIVE_PROVISION_'+(e.code||'ERROR'))}
 }
 // v1.7.3 CONNECT GPU, provider part: the CloudCompute instance is checked (and, only when the user confirmed it,
 // started) through the documented API, then the unchanged engine connection runs. Stopping YOISAKI ENGINE is never
 // treated as stopping the instance, and nothing here can delete an instance.
 async function instanceStage(version,key,id,allowStart){
  const alive=()=>version===epoch&&!closed;const caps=cc.capabilities();
  setPhase('STARTING','Проверяю инстанс CloudCompute через API…');gpuFlow.step='INSTANCE_CHECK';
  let inst=await cc.get(key,id);if(!alive())return false;gpuFlow.instance_status=inst.status;gpuFlow.provider_status=inst.provider_status;gpuFlow.instance_name=inst.name;
  if(inst.status==='STOPPING')throw new AppError('CC_INSTANCE_STOPPING','Инстанс CloudCompute сейчас останавливается. Дождитесь остановки и нажмите «Подключить GPU» снова.',409);
  if(inst.status==='STOPPED'){
   if(!caps.start)throw new AppError('CC_START_UNSUPPORTED','Инстанс остановлен, а запуск через API не описан в проверенном описании CloudCompute API. Запустите его в панели CloudCompute и нажмите «Подключить GPU» снова.',409);
   if(!allowStart)throw new AppError('CC_INSTANCE_STOPPED','Инстанс CloudCompute остановлен. Подтвердите запуск: с этого момента начнётся оплата GPU.',409);
   gpuFlow.step='INSTANCE_STARTING';setPhase('STARTING','Запускаю инстанс CloudCompute (оплата GPU начинается)…');await cc.start(key,id);note('CC_INSTANCE_START');
  }
  const deadline=Date.now()+instanceWaitMs;let delay=5000;
  while(inst.status!=='RUNNING'){
   if(!alive())return false;
   if(inst.status==='ERROR')throw new AppError('CC_INSTANCE_ERROR',`CloudCompute сообщает об ошибке инстанса (статус «${inst.provider_status||'error'}»). Откройте панель CloudCompute.`,502);
   if(Date.now()>deadline)throw new AppError('CC_INSTANCE_TIMEOUT',`Инстанс не перешёл в состояние «работает» за ${Math.round(instanceWaitMs/60000)} мин (статус «${inst.provider_status||'?'}»). Проверьте панель CloudCompute.`,504);
   gpuFlow.step='INSTANCE_STARTING';setPhase('STARTING',`Инстанс CloudCompute запускается (статус «${inst.provider_status||inst.status}»)…`);
   await sleep(delay);delay=Math.min(delay+5000,15000);if(!alive())return false;
   inst=await cc.get(key,id);gpuFlow.instance_status=inst.status;gpuFlow.provider_status=inst.provider_status;
  }
  gpuFlow.step='INSTANCE_RUNNING';note('CC_INSTANCE_RUNNING');return true;
 }
 const failConnect=(e,version)=>{if(version===epoch){state='ERROR';connection=null;info=null;lastError=publicError(e).error;lastCode=e.code||'LOCAL_ERROR';setPhase('ERROR',classify(lastCode).message||lastError);note(lastCode)}};
 // One-click connect with a remembered server: waits while the GPU boots (tunnel/engine not up yet), stops at once
 // on errors waiting cannot fix (token rejected, wrong engine, no CUDA). Disconnect cancels it (epoch).
 async function autoLoop(version,provider,saved){
  let origin=saved.origin,delay=3000;const alive=()=>version===epoch&&!closed;
  while(alive()){
   auto.attempt++;let c;
   try{c=parseTunnel(origin+'/#token='+saved.token,provider);setPhase('CONNECTING',(auto.attempt===1?'Подключаюсь к ':`Попытка ${auto.attempt}: подключаюсь к `)+c.hostname+'…');await establish(c,version);
    if(!alive())return;
    if(c.origin!==saved.origin)await secrets.remember(provider,{origin:c.origin,token:saved.token});
    providers={...providers,endpoints:{...providers.endpoints,[provider]:c.origin}};await store.change(d=>{d.preferences={...d.preferences,gpu:providers}});return;
   }catch(e){
    if(!alive())return;
    if(c&&connection===c){connection=null;info=null;state='CONNECTING';jobs.clear();acknowledgements.clear()}  // failed after activation: not usable
    const code=e.code||'LOCAL_ERROR',rule=classify(code);lastCode=code;lastError=publicError(e).error;note(code);
    if(rule.retry&&auto&&Date.now()<auto.deadline){
     if(rule.discover&&saved.discover){
      setPhase('CONNECTING','Ищу новый адрес сервера…');
      try{const found=await discoverAddress(saved.token);if(alive()&&found&&found!==origin){endpoint(found,provider);origin=found;auto.origin=found;note('ADDRESS_DISCOVERED');continue}}catch(x){note(x.code||'DISCOVERY_FAILED')}
      if(!alive())return;
     }
     setPhase('STARTING',rule.message+' Жду запуска сервера…');await sleep(delay);delay=Math.min(Math.round(delay*1.5),20000);continue;
    }
    state='ERROR';connection=null;info=null;auto=null;setPhase('ERROR',(rule.message||lastError)+(rule.retry?' Время ожидания истекло: проверьте, запущен ли GPU-инстанс.':''));return;
   }
  }
 }
 async function setJob(id,patch){await store.change(d=>{const j=d.history.find(j=>j.id===id);if(j)Object.assign(j,patch,{updated:Date.now()})})}
 async function collect(job,remote,c){
  const collectEpoch=epoch;
  if(!remote.result||!Array.isArray(remote.result.image_keys)||remote.result.image_keys.length<1||remote.result.image_keys.length>2||!Number.isInteger(remote.result.seed))fail('INVALID_RESPONSE','Неверный результат GPU.',502);
  const image_keys=[];
  for(let i=0;i<remote.result.image_keys.length;i++){
   const id=job.id+'_'+i;const existing=store.data.gallery.find(x=>x.id===id);
   if(!existing){const bytes=await upstream(c,`/results/${job.id}?index=${i}`,{binary:true,timeout:90000});if(collectEpoch!==epoch||connection!==c)return;const item={id,name:`yoisaki-${job.id}-${i}.png`,created:Date.now(),favorite:false,prompt:job.request.prompt,origin:'generated',type:'image/png',job_id:job.id,seed:remote.result.seed,parameters:job.request,url:'/api/gallery/'+id+'/file'};await store.saveImage(item,bytes)}
   image_keys.push(String(i));
  }
  if(collectEpoch!==epoch||connection!==c)return;
  await setJob(job.id,{status:'COMPLETED',connection_error:undefined,progress:{...remote.progress,stage:'DONE'},result:{image_keys,seed:remote.result.seed},error:undefined});jobs.delete(job.id);
  if(/^1\.[5-7]\./.test(info?.engine_version||''))acknowledgements.set(job.id,c);
 }
 async function pollJobs(){if(closed||polling||(!jobs.size&&!acknowledgements.size))return;polling=true;
 try{for(const [id,c] of acknowledgements){try{await upstream(c,'/jobs/'+id+'/ack',{method:'POST',body:'{}'});acknowledgements.delete(id)}catch(e){if(e.code==='JOB_NOT_FOUND')acknowledgements.delete(id);else note('RESULT_ACK_PENDING')}break}
 for(const [id,c] of jobs){const job=store.data.history.find(x=>x.id===id);if(!job){jobs.delete(id);continue}
 try{const remote=await upstream(c,'/jobs/'+id,{timeout:20000});if(jobs.get(id)!==c||connection!==c)continue;if(remote.id!==id||!['QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED'].includes(remote.status))fail('INVALID_RESPONSE','Неверный статус задания.',502);
 if(remote.status==='COMPLETED'){await setJob(id,{status:'RUNNING',connection_error:undefined,progress:{...remote.progress,stage:'SAVING'}});await collect(job,remote,c);}
 else{await setJob(id,{status:remote.status,connection_error:undefined,queue_position:remote.queue_position,pending_jobs:remote.pending_jobs,progress:remote.progress,error:remote.error?String(remote.error).replace(/[a-f0-9]{64}/g,'[СКРЫТО]').slice(0,600):undefined});if(terminal.includes(remote.status))jobs.delete(id)}
 }catch(e){if(jobs.get(id)!==c||connection!==c)continue;await setJob(id,{status:'CONNECTION_LOST',connection_error:publicError(e).error});note(e.code||'JOB_ERROR');if(e.code==='JOB_NOT_FOUND'){jobs.delete(id);await setJob(id,{status:'INTERRUPTED',error:'Задача отсутствует в текущей сессии GPU; повторная генерация не запускалась.'})}if(e.code==='AUTH_REJECTED'){jobs.delete(id);await setJob(id,{status:'INTERRUPTED',error:'Токен отклонён. Подключитесь заново.'})}}
 }}finally{polling=false}}
 const pollTimer=setInterval(()=>{pollJobs().catch(()=>note('STORAGE_ERROR'))},3000);pollTimer.unref();
 const server=http.createServer(async(req,res)=>{
 try{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const host=req.headers.host;const port=server.address()?.port;const allowedHosts=[`127.0.0.1:${port}`,`localhost:${port}`];
  if(!allowedHosts.includes(host))fail('HOST_DENIED','Неверный адрес локального сервера.',403);
  const origin=req.headers.origin;if(origin&&!allowedHosts.some(h=>origin==='http://'+h))fail('ORIGIN_DENIED','Доступ разрешён только локальному приложению.',403);
  const u=new URL(req.url,'http://'+host);const route=u.pathname;const method=req.method;
  // v1.7.3: Google's OAuth redirect (cross-site navigation). Only a pending single-use state of this app is accepted.
  if(route==='/'&&method==='GET'&&oauth.has(u.searchParams.get('state')))return finishOAuth(u,res);
  if(req.headers['sec-fetch-site']&& !['same-origin','none'].includes(req.headers['sec-fetch-site']))fail('ORIGIN_DENIED','Внешняя страница не имеет доступа.',403);
  if(route==='/_yoisaki/service'){if(!serviceKey||req.headers['x-yoisaki-service']!==serviceKey)fail('LOCAL_ONLY','Нет доступа.',403);return send(res,{pid:process.pid,version:WEBSITE_VERSION})}
  if(route.startsWith('/api/')){
   const image=method==='GET'&&/^\/api\/gallery\/[a-f0-9_-]+\/file$/.test(route);
   if(!image&&req.headers['x-yoisaki-local']!=='1')fail('LOCAL_ONLY','Откройте приложение на 127.0.0.1.',403);
   if(route==='/api/session'&&method==='GET'){res.setHeader('Set-Cookie',`yoisaki_local=${session}; HttpOnly; SameSite=Strict; Path=/`);return send(res,{ok:true,version:WEBSITE_VERSION,storage_warning:store.warning})}
   if(!(req.headers.cookie||'').split(';').some(x=>x.trim()==='yoisaki_local='+session))fail('SESSION_REQUIRED','Локальная сессия завершилась. Обновите страницу.',401);
   if(route==='/api/gpu/provider'&&method==='POST'){
    const b=await jsonBody(req);const selected=providerName(b.provider);
    const saved=Object.hasOwn(b,'endpoint')?endpoint(b.endpoint,providers.selected):providers.endpoints[providers.selected];
    const version=await disconnectSession();if(version!==epoch)fail('SUPERSEDED','Выбор провайдера отменён.',409);
    providers={selected,endpoints:{...providers.endpoints,[providers.selected]:saved}};
    await store.change(d=>{d.preferences={...d.preferences,gpu:providers}});
    return send(res,status());
   }
   if(route==='/api/gpu/endpoint'&&method==='POST'){
    const b=await jsonBody(req);const provider=providerName(b.provider);const saved=endpoint(b.endpoint,provider);
    providers={...providers,endpoints:{...providers.endpoints,[provider]:saved}};
    await store.change(d=>{d.preferences={...d.preferences,gpu:providers}});return send(res,status());
   }
   if(route==='/api/version'&&method==='GET')return send(res,{studio_version:WEBSITE_VERSION,edition:STUDIO_EDITION,compatible_engine:COMPATIBLE_ENGINE_FAMILY,engine_version:info?.engine_version??null,api_version:info?.api_version??null});
   if(route==='/api/gpu/connect'&&method==='POST'){
    const body=await jsonBody(req);const {url}=body;const provider=providerName(body.provider??providers.selected);
    if(provider!==providers.selected)fail('PROVIDER_CHANGED','Сначала выберите провайдера.',409);
    if(typeof url!=='string'||url.length>1000)fail('INVALID_URL','Вставьте полную защищённую ссылку.');const c=parseTunnel(url,provider);
    const version=await disconnectSession();if(version!==epoch)fail('SUPERSEDED','Подключение отменено.',409);state='CONNECTING';lastError='';
    providers={...providers,endpoints:{...providers.endpoints,[provider]:c.origin}};
    await store.change(d=>{d.preferences={...d.preferences,gpu:providers}});
    setPhase('CONNECTING','Подключаюсь…');
    try{await establish(c,version);
     // v1.7.3: explicit opt-in only. remember:false forgets a previously remembered server of this provider.
     if(body.remember===true)await secrets.remember(provider,{origin:c.origin,token:c.token,discover:typeof body.discover==='boolean'?body.discover:undefined});else if(body.remember===false)await secrets.forget(provider);
     return send(res,status());
    }catch(e){failConnect(e,version);throw e}
   }
   if(route==='/api/gpu/autoconnect'&&method==='POST'){
    const body=await jsonBody(req);const provider=providerName(body.provider??providers.selected);
    if(provider!==providers.selected)fail('PROVIDER_CHANGED','Сначала выберите провайдера.',409);
    const saved=secrets.connection(provider);if(!saved)fail('NOT_REMEMBERED','Для этого провайдера нет сохранённого подключения. Вставьте ссылку один раз и отметьте «Запомнить».',409);
    const version=await disconnectSession();if(version!==epoch)fail('SUPERSEDED','Подключение отменено.',409);
    const minutes=Math.min(Math.max(Number(body.wait_minutes)||15,1),30);state='CONNECTING';
    auto={attempt:0,started_at:Date.now(),deadline:Date.now()+minutes*60000,origin:saved.origin};setPhase('CONNECTING','Подключаюсь к сохранённому серверу…');
    autoLoop(version,provider,saved).catch(e=>failConnect(e,version));
    return send(res,status(),202);
   }
   if(route==='/api/gpu/remembered'&&method==='POST'){
    const b=await jsonBody(req);const provider=providerName(b.provider);
    if(b.forget===true)await secrets.forget(provider);else if(typeof b.discover==='boolean'){if(!secrets.connection(provider))fail('NOT_REMEMBERED','Сначала запомните подключение.',409);await secrets.setDiscover(provider,b.discover)}
    else fail('INVALID_REQUEST','Неверный запрос.');
    note(b.forget===true?'CONNECTION_FORGOTTEN':'DISCOVERY_'+(b.discover?'ON':'OFF'));return send(res,status());
   }
   const oauthView=()=>{const g=secrets.google();return {configured:!!g,client_id:g?.client_id||'',redirect_uri:redirectUri(port),scope:SCOPE,last_result:oauthResult,public_client:!!publicGoogle.client,public_client_error:publicGoogle.error}};
   // ---- v1.7.3 CloudCompute REST API (key stays here; responses carry flags and instance data only) ----
   const ccView=()=>{const k=secrets.cloudcompute();return {configured:!!k,saved_at:k?.saved_at||null,validated_at:k?.validated_at||null,instance_id:k?.instance_id||null,api_host:API_HOST,docs_url:DOCS_URL,panel_url:PANEL_URL,
    contract:{verified:cc.contract.verified,verified_against:cc.contract.verified_against,error:contractError,capabilities:cc.capabilities()},instances:ccState.instances,listed_at:ccState.listed_at,error:ccState.error,code:ccState.code}};
   const ccKey=()=>{const k=secrets.cloudcompute();if(!k)fail('CC_NO_KEY','Сначала сохраните ключ CloudCompute API.',409);return k.api_key};
   const ccTry=async fn=>{try{const v=await fn();ccState.error='';ccState.code='';return v}catch(e){ccState.error=publicError(e).error;ccState.code=e.code||'LOCAL_ERROR';note(ccState.code);throw e}};
   const ccInstance=b=>{const id=typeof b?.instance_id==='string'?b.instance_id:'';if(!INSTANCE_ID_RE.test(id))fail('CC_INVALID_INSTANCE','Выберите инстанс из списка.');return id};
   if(route==='/api/cloudcompute'&&method==='GET')return send(res,ccView());
   if(route==='/api/cloudcompute/key'&&method==='PUT'){
    const key=validateKey((await jsonBody(req)).api_key);let validated=null;
    // A key the API definitively rejects is not stored; without a verified contract only the format is checked.
    if(cc.capabilities().validate){try{await cc.validate(key);validated=Date.now()}catch(e){if(['CC_AUTH_REJECTED','CC_INVALID_KEY'].includes(e.code)){ccState.error=publicError(e).error;ccState.code=e.code;throw e}ccState.error=publicError(e).error;ccState.code=e.code||'LOCAL_ERROR'}}
    const old=secrets.cloudcompute();await secrets.setCloudCompute({api_key:key,saved_at:Date.now(),validated_at:validated,instance_id:old?.instance_id||null});
    if(validated){ccState.error='';ccState.code=''}ccState.instances=[];ccState.listed_at=null;note('CC_KEY_SAVED');return send(res,ccView());
   }
   if(route==='/api/cloudcompute/key'&&method==='DELETE'){await secrets.setCloudCompute(null);Object.assign(ccState,{instances:[],listed_at:null,error:'',code:''});note('CC_KEY_REMOVED');return send(res,ccView())}
   if(route==='/api/cloudcompute/validate'&&method==='POST'){
    const key=ccKey();if(!cc.capabilities().validate)fail('CC_UNSUPPORTED','Проверка ключа на сервере CloudCompute недоступна: описание API ещё не сверено с документацией. Формат ключа верный.',409);
    await ccTry(()=>cc.validate(key));await secrets.setCloudCompute({validated_at:Date.now()});return send(res,ccView());
   }
   if(route==='/api/cloudcompute/instances'&&method==='GET'){
    const key=ccKey();if(!cc.capabilities().list)fail('CC_UNSUPPORTED','Список инстансов недоступен: описание CloudCompute API ещё не сверено с документацией.',409);
    ccState.instances=await ccTry(()=>cc.list(key));ccState.listed_at=Date.now();await secrets.setCloudCompute({validated_at:Date.now()});return send(res,ccView());
   }
   if(route==='/api/cloudcompute/select'&&method==='POST'){
    const b=await jsonBody(req);ccKey();const id=b.instance_id===null?null:ccInstance(b);
    if(id&&ccState.listed_at&&!ccState.instances.some(x=>x.id===id))fail('CC_NOT_FOUND','Этого инстанса нет в последнем списке. Обновите список.',404);
    await secrets.setCloudCompute({instance_id:id});return send(res,ccView());
   }
   const ccAction=route.match(/^\/api\/cloudcompute\/instance\/(start|stop|refresh)$/);
   if(ccAction&&method==='POST'){
    const b=await jsonBody(req);const key=ccKey();const id=ccInstance(b);const action=ccAction[1];
    if(action!=='refresh'&&b.confirm!==true)fail('CONFIRMATION_REQUIRED',action==='start'?'Подтвердите запуск инстанса: начнётся оплата GPU.':'Подтвердите остановку инстанса: генерация на нём станет недоступна.',409);
    if(action!=='refresh'&&!cc.capabilities()[action])fail('CC_UNSUPPORTED',(action==='start'?'Запуск':'Остановка')+' инстанса через API не описаны в проверенном описании CloudCompute API. Выполните это в панели CloudCompute.',409);
    if(action==='start')await ccTry(()=>cc.start(key,id));
    if(action==='stop'){await ccTry(()=>cc.stop(key,id));
     // The engine on that instance goes away: drop the session (history stays unresolved, never "completed").
     if(connection?.provider==='cloudcompute'&&secrets.cloudcompute()?.instance_id===id)await disconnectSession();}
    if(action!=='refresh')note('CC_INSTANCE_'+action.toUpperCase());
    const inst=await ccTry(()=>cc.get(key,id));ccState.instances=[...ccState.instances.filter(x=>x.id!==id),inst].sort((a,z)=>a.name.localeCompare(z.name));
    return send(res,{...ccView(),instance:inst});
   }
   if(route==='/api/gpu/connect-gpu'&&method==='POST'){
    const body=await jsonBody(req);
    if(providers.selected!=='cloudcompute')fail('PROVIDER_CHANGED','Сначала выберите CloudCompute.',409);
    const saved=secrets.connection('cloudcompute');
    if(!saved)fail('NOT_REMEMBERED','Нет сохранённой ссылки движка YOISAKI. Один раз вставьте ссылку из ./check-cloudcompute.sh link и отметьте «Запомнить»: ключ CloudCompute API даёт доступ к инстансу, но не к движку.',409);
    const k=secrets.cloudcompute();const useApi=!!(k?.instance_id&&cc.capabilities().get);
    const version=await disconnectSession();if(version!==epoch)fail('SUPERSEDED','Подключение отменено.',409);
    state='CONNECTING';auto={attempt:0,started_at:Date.now(),deadline:Date.now()+(useApi?instanceWaitMs:0)+15*60000,origin:saved.origin};
    gpuFlow={api:useApi,step:useApi?'INSTANCE_CHECK':'NO_API',instance_id:useApi?k.instance_id:null,instance_status:null,provider_status:'',instance_name:''};
    setPhase(useApi?'STARTING':'CONNECTING',useApi?'Проверяю инстанс CloudCompute…':'Подключаюсь к сохранённому серверу…');
    (async()=>{if(useApi&&!await instanceStage(version,k.api_key,k.instance_id,body.start_instance===true))return;if(version!==epoch)return;auto.deadline=Date.now()+15*60000;await autoLoop(version,'cloudcompute',saved)})()
     .catch(e=>{if(version===epoch){auto=null;if(gpuFlow)gpuFlow.step='ERROR';failConnect(e,version)}});
    return send(res,status(),202);
   }
   // ---- v1.7.3 Google Drive Easy Connect (works without a GPU) ----
   const driveView=()=>({...drive.view(),redirect_uri:redirectUri(port),own_client_id:secrets.google()?.client_id||'',public_client_error:publicGoogle.error,last_result:oauthResult,gpu:{...driveGpu},gpu_online:!!connection&&connection.provider==='cloudcompute'});
   if(route==='/api/drive'&&method==='GET')return send(res,driveView());
   if(route==='/api/drive'&&method==='DELETE'){
    // Revoking at Google ends the grant everywhere (also the copy on the GPU server); the GPU copy is removed too.
    const c=connection;let gpu=false;
    if(c?.provider==='cloudcompute'){try{await upstream(c,'/sync/drive/disconnect',{method:'POST',body:'{}',timeout:20000});gpu=true}catch{}}
    const {revoked}=await drive.unlink({revoke:u.searchParams.get('revoke')!=='0'});oauthResult=null;note('DRIVE_UNLINKED');
    return send(res,{...driveView(),unlinked:{revoked,gpu}});
   }
   if(route==='/api/drive/folders'&&method==='GET')return send(res,await drive.folders(u.searchParams.get('parent')||'root'));
   if(route==='/api/drive/folder'&&method==='POST'){const b=await jsonBody(req);const v=await drive.selectFolder(b.id);note('DRIVE_FOLDER_SELECTED');if(connection?.provider==='cloudcompute')void provisionDrive(connection,epoch).catch(()=>{});return send(res,{...v,...driveView()})}
   if(route==='/api/drive/check'&&method==='POST'){await drive.check();return send(res,driveView())}
   if(route==='/api/drive/account'&&method==='POST'){await drive.refreshAccount();return send(res,driveView())}
   if(route==='/api/drive/settings'&&method==='POST'){await drive.settings(await jsonBody(req));return send(res,driveView())}
   if(route==='/api/drive/provision'&&method==='POST'){
    if(!connection)fail('GPU_OFFLINE','GPU отключён. Google Drive подключится к серверу автоматически при подключении CloudCompute.',409);
    if(connection.provider!=='cloudcompute')fail('DRIVE_CLOUDCOMPUTE_ONLY','Google Drive Auto Sync доступна только для CloudCompute.',409);
    if(!secrets.drive())fail('DRIVE_NOT_LINKED','Сначала войдите через Google.',409);
    await provisionDrive(connection,epoch,{force:true});return send(res,driveView());
   }
   if(route==='/api/drive/oauth'){
    if(method==='GET')return send(res,oauthView());
    if(method==='PUT'){await secrets.setGoogle(validateClient(await jsonBody(req)));oauthResult=null;note('DRIVE_OAUTH_CLIENT_SAVED');return send(res,oauthView())}
    if(method==='DELETE'){await secrets.setGoogle(null);oauthResult=null;return send(res,oauthView())}
   }
   if(route==='/api/drive/oauth/start'&&method==='POST'){
    // v1.7.3: no GPU needed. The user's own client wins; otherwise the distribution's public client.
    const b=await jsonBody(req);const g=drive.client(['own','public'].includes(b.client)?b.client:undefined);
    if(!g)fail('DRIVE_OAUTH_NOT_CONFIGURED',publicGoogle.error||'В этой установке нет OAuth-клиента Google. Сохраните Client ID и Client Secret своего OAuth-клиента (тип «Приложение для ПК»).',409);
    oauthResult=null;return send(res,{url:oauth.start(g,port,{}),client:g.source});
   }
   const driveMatch=route.match(/^\/api\/gpu\/drive\/(status|check|sync|cancel|connect|disconnect)$/);
   if(driveMatch){
    const [remoteMethod,remoteRoute]=SYNC_ACTIONS[driveMatch[1]];
    if(method!==remoteMethod)fail('METHOD_DENIED','Метод не поддерживается.',405);
    if(!connection)fail('GPU_OFFLINE','GPU отключён. Подключите CloudCompute в разделе GPU.',409);
    if(connection.provider!=='cloudcompute')fail('DRIVE_CLOUDCOMPUTE_ONLY','Google Drive Auto Sync доступна только для CloudCompute.',409);
    // The connect body (OAuth token) is forwarded once and never stored, logged or echoed.
    const body=driveMatch[1]==='connect'?validateConnect(await jsonBody(req)):driveMatch[1]==='sync'?validateSyncStart(await readBody(req,1048576)):remoteMethod==='POST'?'{}':undefined;
    const c=connection;const result=await upstream(c,remoteRoute,{method:remoteMethod,body,timeout:30000});
    if(connection!==c)fail('SUPERSEDED','Провайдер изменён.',409);
    if(driveMatch[1]!=='status')note('DRIVE_'+driveMatch[1].toUpperCase());return send(res,validateSyncStatus(result));
   }
   if(route==='/api/gpu/disconnect'&&method==='POST'){await disconnectSession();return send(res,status())}
   if(route==='/api/gpu/status'&&method==='GET')return send(res,await refresh(u.searchParams.get('models')==='1'));
   if(route==='/api/gpu/controlnet/preprocess'&&method==='POST'){
    if(!connection||!['READY','BUSY'].includes(state))fail('GPU_OFFLINE','GPU отключён. Подключитесь в разделе GPU.',409);
    if(engineCompatibility(info)!=='COMPATIBLE')fail('ENGINE_UPGRADE_REQUIRED','Несовместимая версия движка. Требуется YOISAKI ENGINE v1.7.0.',409);
    const request=validatePreprocess(await jsonBody(req));
    // AUD-006: each hop stays below the browser (95 s) and Cloudflare (~100 s) limits; the engine answers
    // PENDING after 60 s and the page repeats the identical request to resume the same operation.
    const result=await upstream(connection,'/controlnet/preprocess',{method:'POST',body:JSON.stringify(request),timeout:90000});
    if(result?.status==='PENDING')return send(res,{status:'PENDING'});
    if(result?.type!==request.type||result?.width!==request.width||result?.height!==request.height||result?.preprocessor!==request.preprocessor)fail('INVALID_RESPONSE','Неверная карта ControlNet от GPU.',502);
    validateControlImage(result.image);return send(res,result);
   }
   if(route==='/api/gpu/generate'&&method==='POST'){
    if(!connection||!['READY','BUSY'].includes(state))fail('GPU_OFFLINE','GPU отключён. Подключитесь в разделе GPU.',409);
    const request=validateGeneration(await jsonBody(req),store.data.models);
    if(request.regions?.some(r=>r.enabled)&&!supportsRegionalControl(info))fail('ENGINE_UPGRADE_REQUIRED','Движок не объявляет поддержку Regional Control и не распознан как совместимый YOISAKI ENGINE 1.7.0.',409);
    request.client_request_id ||= randomUUID();
    const c=connection,requestEpoch=epoch;
    // AUD-002: ControlNet map and Img2Img source go to the GPU only; history/gallery keep digests.
    const stored=compactSourceRequest(compactControlRequest(request));
    const task=submissionChain.catch(()=>{}).then(async()=>{
      if(requestEpoch!==epoch||connection!==c)fail('SUPERSEDED','Провайдер изменён; задание не отправлено.',409);
      const existing=store.data.history.find(j=>j.request?.client_request_id===request.client_request_id);
      if(existing){if(JSON.stringify(existing.request)!==JSON.stringify(stored))fail('REQUEST_CONFLICT','Request ID conflict',409);return existing}
      const job={id:request.client_request_id,status:'CONNECTION_LOST',created:Date.now(),updated:Date.now(),request:stored,origin:c.origin,provider:c.provider};
      // Write the known ID before sending. An ambiguous response is reconciled with
      // GET only, never automatically replayed after reload/reconnect.
      await store.change(d=>{d.history.unshift(job)});
      try{
       if(requestEpoch!==epoch||connection!==c)fail('SUPERSEDED','Провайдер изменён; задание не отправлено.',409);
       const response=await upstream(c,'/generate',{method:'POST',body:JSON.stringify(request),timeout:20000});
       if(!response||!/^[a-f0-9-]{36}$/.test(response.id)||response.status!=='QUEUED')fail('INVALID_RESPONSE','GPU вернул неверное подтверждение задания.',502);
       await store.change(d=>{const j=d.history.find(x=>x.id===job.id);j.id=response.id;j.status='QUEUED'});
       if(requestEpoch===epoch&&connection===c){jobs.set(response.id,c);state='BUSY';}return store.data.history.find(x=>x.id===response.id);
      }catch(e){if(requestEpoch===epoch&&connection===c)jobs.set(job.id,c);await setJob(job.id,{connection_error:publicError(e).error});throw e}
    });
    submissionChain=task;return send(res,await task,201);
   }
   const jobMatch=route.match(/^\/api\/gpu\/jobs\/([a-f0-9-]{36})$/);
   if(jobMatch){const id=jobMatch[1];const job=store.data.history.find(x=>x.id===id);if(!job)fail('JOB_NOT_FOUND','Задание не найдено.',404);
    if(method==='GET')return send(res,job);
    if(method==='DELETE'){if(!terminal.includes(job.status)){const c=jobs.get(id)||(connection&&sameProvider(job,connection)?connection:null);if(!c)fail('GPU_OFFLINE','Нет связи с GPU. Отмена не подтверждена.',409);const remote=await upstream(c,'/jobs/'+id,{method:'DELETE'});if(remote.status==='CANCELLED'){jobs.delete(id);await setJob(id,{status:'CANCELLED',connection_error:undefined})}else{jobs.set(id,c);await pollJobs()}}return send(res,{status:store.data.history.find(x=>x.id===id)?.status||'CANCELLED'})}}
   if(route==='/api/history'&&method==='GET')return send(res,historySnapshot());
   const historyMatch=route.match(/^\/api\/history\/([a-f0-9-]{36})$/);
   if(historyMatch&&method==='DELETE'){
    const id=historyMatch[1];const existing=store.data.history.find(j=>j.id===id);
    if(!existing)fail('JOB_NOT_FOUND','Запись уже удалена.',404);
    // CONNECTION_LOST is unresolved, not terminal. Reconcile before deletion;
    // a completed remote job must be collected into Gallery first.
    if(existing.status==='CONNECTION_LOST'){
     if(!connection||!sameProvider(existing,connection))fail('JOB_UNCONFIRMED','Сначала подключитесь к прежней сессии GPU и проверьте задание. При потере связи оно может ещё выполняться.',409);
     jobs.set(id,connection);await pollJobs();
    }
    await store.change(d=>{
     const j=d.history.find(j=>j.id===id);
     if(j&&(!isTerminal(j)||jobs.has(id)))fail('JOB_ACTIVE','Задание ещё выполняется или его завершение не подтверждено. Используйте отмену или дождитесь проверки GPU.',409);
     d.history=d.history.filter(j=>j.id!==id);
    });
    return send(res,historySnapshot());
   }
   if(route==='/api/history/cleanup'&&method==='POST'){
    const body=await jsonBody(req);
    if(!['completed','unsuccessful','all'].includes(body.scope)||!Array.isArray(body.ids)||body.ids.length>1000||body.ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)))fail('INVALID_HISTORY','Неверный список очистки.');
    const selected=new Set(body.ids);let removed=0;
    await store.change(d=>{d.history=d.history.filter(j=>{
     const drop=selected.has(j.id)&&matchesHistory(j,body.scope)&&!jobs.has(j.id);
     if(drop)removed++;return !drop;
    })});
    return send(res,{...historySnapshot(),removed});
   }
   if(route==='/api/settings'){
    if(method==='GET')return send(res,{value:store.data.settings});
    if(method==='PUT'){const b=await jsonBody(req);if(!b.value||typeof b.value!=='object'||Array.isArray(b.value))fail('INVALID_SETTINGS','Неверные настройки.');await store.change(d=>{d.settings=b.value});return send(res,{ok:true})}}
   if(route==='/api/connect/lora-tags'){
    const id=u.searchParams.get('model_id');if(id&&!/^[a-f0-9]{32}$/.test(id))fail('INVALID_MODEL','Неверный ID модели.');
    if(method==='GET')return send(res,{items:Object.values(store.data.tags).filter(x=>!id||x.model_id===id)});
    if(method==='PUT'){const b=await jsonBody(req);if(!/^[a-f0-9]{32}$/.test(b.model_id)||!['trigger_words','recommended_tags'].every(k=>Array.isArray(b[k])&&b[k].length<=64&&b[k].every(x=>typeof x==='string'&&x.length<=160))||b.description!==undefined&&(typeof b.description!=='string'||b.description.length>4000))fail('INVALID_TAGS','Некорректные теги LoRA.');const item={...store.data.tags[b.model_id],model_id:b.model_id,trigger_words:[...new Set(b.trigger_words)],recommended_tags:[...new Set(b.recommended_tags)],...(b.description===undefined?{}:{description:b.description})};await store.change(d=>{d.tags[b.model_id]=item});return send(res,item)}}
   if(route==='/api/gallery'&&method==='GET')return send(res,{items:store.data.gallery});
   if(route==='/api/gallery'&&method==='DELETE'){for(const item of [...store.data.gallery])await store.deleteImage(item.id);return send(res,{ok:true})}
   const gm=route.match(/^\/api\/gallery\/([a-f0-9_-]+)(\/file)?$/);
   if(gm){const id=gm[1];if(!ID.test(id))fail('INVALID_ID','Неверный ID изображения.');const item=store.data.gallery.find(x=>x.id===id);
    if(gm[2]&&method==='GET'){if(!item)fail('NOT_FOUND','Изображение не найдено.',404);const bytes=await fs.readFile(path.join(dataDir,'images',id));res.writeHead(200,{'Content-Type':item.type,'Content-Length':bytes.length,'Cache-Control':'private, max-age=300'});return res.end(bytes)}
    if(method==='DELETE'){await store.deleteImage(id);return send(res,{ok:true})}
    if(method==='PATCH'){const b=await jsonBody(req);if(!item)fail('NOT_FOUND','Изображение не найдено.',404);if(typeof b.prompt!=='string'||b.prompt.length>10000||typeof b.favorite!=='boolean')fail('INVALID_METADATA','Некорректные данные изображения.');await store.change(d=>Object.assign(d.gallery.find(x=>x.id===id),{prompt:b.prompt,favorite:b.favorite}));return send(res,{ok:true})}
    if(method==='POST'){if(item)fail('EXISTS','Изображение уже существует.',409);const bytes=await readBody(req,25*1024*1024);const type=req.headers['content-type'];const sig=bytes.subarray(0,12);const valid=type==='image/png'&&sig.subarray(0,8).toString('hex')==='89504e470d0a1a0a'||type==='image/jpeg'&&sig.subarray(0,3).toString('hex')==='ffd8ff'||type==='image/webp'&&sig.subarray(0,4).toString()==='RIFF'&&sig.subarray(8,12).toString()==='WEBP';if(!valid)fail('INVALID_IMAGE','Разрешены PNG, JPEG и WebP.');const name=(u.searchParams.get('name')||'image').slice(0,200);return send(res,await store.saveImage({id,name,created:Date.now(),favorite:false,prompt:'',origin:'imported',type,url:'/api/gallery/'+id+'/file'},bytes),201)}
   }
   if(route==='/api/diagnostics'&&method==='GET'){const st=status();return send(res,{version:WEBSITE_VERSION,node:process.version,platform:process.platform,arch:process.arch,provider:providers.selected,engine_version:info?.engine_version??null,api_version:info?.api_version??null,state,code:lastCode,phase:st.phase,components:st.components,models:store.data.models.length,models_error:modelsState.code,models_rejected:st.models_rejected.length,remembered:Object.fromEntries(Object.entries(st.remembered).map(([k,v])=>[k,!!v])),cloudcompute_api:{key:!!secrets.cloudcompute(),contract_verified:cc.contract.verified,instance_selected:!!secrets.cloudcompute()?.instance_id},drive_link:{linked:!!secrets.drive(),folder:!!secrets.drive()?.folder,reauth:!!secrets.drive()?.reauth,client:secrets.drive()?.client||null,gpu:driveGpu.state},images:store.data.gallery.length,events:diagnostics})}
   fail('NOT_FOUND','API не найден.',404);
  }
  if(!['GET','HEAD'].includes(method))fail('METHOD_DENIED','Метод не поддерживается.',405);
  const relative=decodeURIComponent(route).replace(/^\//,'');let file=path.resolve(distDir,relative||'index.html');if(!file.startsWith(path.resolve(distDir)+path.sep))fail('PATH_DENIED','Недопустимый путь.',403);
  try{if(!(await fs.stat(file)).isFile())throw Error()}catch{if(!['/','/generate','/edit','/models','/gallery','/engine'].includes(route))fail('NOT_FOUND','Файл не найден.',404);file=path.join(distDir,'index.html')}
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp'}[path.extname(file)]||'application/octet-stream';const bytes=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-cache','Content-Length':bytes.length});res.end(method==='HEAD'?undefined:bytes);
 }catch(e){note(e.code||'LOCAL_ERROR');if(!res.headersSent)send(res,publicError(e),e.status||500);else res.destroy()}
 });
 // Completes the Google authorization: code → tokens (PKCE) → GPU /sync/drive/connect. Tokens are not kept here.
 async function finishOAuth(u,res){
  const pending=oauth.take(u.searchParams.get('state'));
  try{
   if(!pending)fail('DRIVE_OAUTH_STATE','Сеанс авторизации устарел. Нажмите «Подключить Google Drive» ещё раз.');
   if(u.searchParams.get('error'))fail('DRIVE_OAUTH_DENIED',u.searchParams.get('error')==='access_denied'?'Доступ к Google Drive не разрешён.':'Google отменил авторизацию.');
   const g=[drive.client('own'),drive.client('public')].find(x=>x&&x.client_id===pending.client_id);if(!g)fail('DRIVE_OAUTH_NOT_CONFIGURED','OAuth-клиент Google изменился во время авторизации. Повторите вход.');
   const token=await exchange(g,u.searchParams.get('code'),pending);
   const view=await drive.link(g,token);note('DRIVE_OAUTH_CONNECTED');
   let message='Google Drive подключён (только чтение)'+(view.account?.email?': '+view.account.email:'')+'.'+(view.folder?'':' Выберите папку с моделями.');
   const c=connection;if(c?.provider==='cloudcompute'){await provisionDrive(c,epoch);if(driveGpu.state==='ERROR')message+=' GPU-сервер: '+driveGpu.message}
   oauthResult={ok:true,code:'CONNECTED',message,at:Date.now()};
  }catch(e){oauthResult={ok:false,code:e.code||'DRIVE_OAUTH_FAILED',message:publicError(e).error,at:Date.now()};note(oauthResult.code)}
  res.writeHead(302,{Location:'/models?drive_auth=1','Cache-Control':'no-store'});res.end();
 }
 server.requestTimeout=100000;server.headersTimeout=10000;
 return {server,store,status,pollJobs,async close(){closed=true;clearInterval(pollTimer);connection=null;jobs.clear();acknowledgements.clear();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});while(polling)await new Promise(r=>setTimeout(r,20));await store.chain}};
}

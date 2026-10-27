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
import {discover,progress as rendezvousProgress,RENDEZVOUS_HOST} from './rendezvous.mjs';
import {CloudComputeAPI,instanceList} from './cloudcompute-api.mjs';
import {ENGINE_IMAGE,REQUIREMENTS,END_STAGES,DeploymentWatcher,offerList,createBody,createdInstanceId,checkImage,validateImage,onstartScript,newToken,instanceName,deploymentView} from './cloudcompute-deploy.mjs';
import {DriveAccount} from './drive-account.mjs';
import {providerHttp,providerBytes} from './provider-http.mjs';
import {DriveLibrary,selectionEstimate,compareSources} from './drive-library.mjs';
import {SyncMonitor,discoveryReport} from './sync-monitor.mjs';
import {readiness} from './readiness.mjs';
import {OAuthFlows,exchangeCode,validateClient,redirectUri,SCOPE} from './google-oauth.mjs';
const ID=/^[a-f0-9-]{36}(?:_[0-3])?$/;
const terminal=TERMINAL_STATUSES;
async function readBody(req,max=12582912){const chunks=[];let n=0;for await(const b of req){n+=b.length;if(n>max)fail('BODY_TOO_LARGE','Слишком большой запрос.',413);chunks.push(b)}return Buffer.concat(chunks)}
async function jsonBody(req){try{return JSON.parse((await readBody(req)).toString())}catch(e){if(e instanceof AppError)throw e;fail('INVALID_JSON','Неверный JSON запроса.')}}
function send(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
export async function createLocalApp({dataDir,distDir,upstream=requestUpstream,serviceKey='',discoverAddress=discover,discoverProgress=rendezvousProgress,exchange=exchangeCode,providerRequest=providerHttp,providerBytesRequest=providerBytes,defaultGoogle=null,sleep=ms=>new Promise(r=>setTimeout(r,ms).unref?.()),deployInterval=10000,driveInterval=3000,autoResume=true}={}){
 const store=await new Store(dataDir).init();
 // v1.7.3: remembered connections and the Google OAuth client live in secrets.json (0600), never in state.json.
 const secrets=await new SecretStore(dataDir).init();const oauth=new OAuthFlows();let oauthResult=null,oauthGeneration=0;
 const cloud=new CloudComputeAPI(secrets,providerRequest),drive=new DriveAccount(secrets,providerRequest,providerBytesRequest);
 // v1.7.6: Drive model library (no GPU needed) and the real-time sync monitor, each in its own 0600 file.
 const library=await new DriveLibrary({drive,dir:dataDir}).init(),monitor=await new SyncMonitor({dir:dataDir}).init();
 const googleClient=()=>secrets.google()||defaultGoogle;
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
 const status=()=>{
  const inv=store.data.inventory||null,p=currentPhase();
  return {provider:providers.selected,endpoints:{...providers.endpoints},url:connection?.origin||'',state,info,models:store.data.models,error:lastError,code:lastCode,storage_warning:store.warning,website_version:WEBSITE_VERSION,compatible_engine_family:COMPATIBLE_ENGINE_FAMILY,compatibility:engineCompatibility(info),
   // v1.7.3: the list is never presented as current when it is not (models_stale) and rejected entries are listed.
   phase:p,phase_message:connection&&p!=='ERROR'?'':phaseMessage,
   components:components({phase:p,info:connection?info:null,code:lastCode,modelsCount:store.data.models.length,modelsError:modelsState.error,usableCheckpoints:store.data.models.some(m=>m.kind==='checkpoint'&&m.compatible!==false)}),
   models_updated_at:inv?.updated_at||null,models_origin:inv?.origin||null,models_rejected:inv?.rejected||[],models_error:modelsState.error,models_code:modelsState.code,
   models_stale:!connection||state==='ERROR'||!inv||Date.now()-inv.updated_at>60000||!!modelsState.error||!!inv?.origin&&inv.origin!==connection.origin,
   connected_at:connection?connectedAt:null,remembered:secrets.publicView(),secrets_warning:secrets.warning,rendezvous_host:RENDEZVOUS_HOST,
   autoconnect:auto?{attempt:auto.attempt,started_at:auto.started_at,deadline:auto.deadline,origin:auto.origin}:null};
 };
 async function disconnectSession(){
  const version=++epoch;refreshing=null;connection=null;info=null;state='OFFLINE';lastError='';lastCode='';jobs.clear();acknowledgements.clear();auto=null;connectedAt=0;setPhase('OFFLINE');modelsState.error='';modelsState.code='';
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
  if(c.provider!=='cloudcompute'||c.inventory===false)return Date.now()-(store.data.inventory?.updated_at||0)>30000;
  try{const r=await upstream(c,'/inventory',{timeout:15000});const rev=typeof r?.revision==='string'?r.revision:null;if(!rev)fail('INVALID_RESPONSE','GPU не вернул ревизию каталога.',502);return !!modelsState.error||Date.now()-(store.data.inventory?.updated_at||0)>30000||rev!==store.data.inventory?.revision||store.data.inventory?.origin!==c.origin}
  catch(e){if(e.code==='JOB_NOT_FOUND'){c.inventory=false;return true}modelsState.error=publicError(e).error;modelsState.code=e.code||'INVENTORY_ERROR';return false}
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
  if(version!==epoch)fail('SUPERSEDED','Подключение отменено.',409);jobs.clear();acknowledgements.clear();connection=c;info=h;state=h.state;auto=null;connectedAt=Date.now();
  if(inv){await mergeModels(inv,c);modelsState.error='';modelsState.code=''}else{modelsState.error=publicError(modelsError).error;modelsState.code=modelsError.code||'LOCAL_ERROR';note('MODELS_'+modelsState.code)}
  await store.change(d=>{d.preferences={...d.preferences,last_host:c.origin}});
  if(version!==epoch)fail('SUPERSEDED','Подключение отменено.',409);
  for(const j of store.data.history){if(sameProvider(j,c)&&!['COMPLETED','FAILED','CANCELLED'].includes(j.status)){jobs.set(j.id,c);await setJob(j.id,{status:'CONNECTION_LOST',connection_error:'Проверяем прежнюю задачу…'})}}
  if(/^1\.[5-7]\./.test(h.engine_version||''))for(const j of store.data.history.filter(j=>sameProvider(j,c)&&j.status==='COMPLETED'&&j.result?.image_keys?.every((_,i)=>store.data.gallery.some(g=>g.id===j.id+'_'+i))))acknowledgements.set(j.id,c);
  lastError='';lastCode='';setPhase('READY');note('CONNECTED');
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
 // Shared by «One-click connect», the v1.7.5 deployment watcher and the reconnect after a restart of this app.
 async function startAutoconnect(provider,minutesWanted){
  const saved=secrets.connection(provider);if(!saved)fail('NOT_REMEMBERED','Для этого провайдера нет сохранённого подключения. Вставьте ссылку один раз и отметьте «Запомнить».',409);
  const version=await disconnectSession();if(version!==epoch)fail('SUPERSEDED','Подключение отменено.',409);
  const minutes=Math.min(Math.max(minutesWanted||15,1),30);state='CONNECTING';
  auto={attempt:0,started_at:Date.now(),deadline:Date.now()+minutes*60000,origin:saved.origin};setPhase('CONNECTING','Подключаюсь к сохранённому серверу…');
  autoLoop(version,provider,saved).catch(e=>failConnect(e,version));
 }
 // v1.7.6: every /sync/* answer of the connected GPU passes through the monitor (structured events, persistence).
 const background=new Set();   // post-sync discovery runs; close() waits for them
 function observeSync(c,result){
  const view=validateSyncStatus(result);
  if(c===connection){const r=monitor.observe(view,c.origin);if(r.finished){const task=afterSync(c).catch(()=>note('DISCOVERY_FAILED')).finally(()=>background.delete(task));background.add(task)}}
  return view;
 }
 // After a sync job: fresh engine catalogue, then which downloaded files the generator can now use (and why not).
 async function afterSync(c){
  await refresh(true);if(c!==connection)return;
  const job=monitor.data.job,items=monitor.lastItems()||[];
  const paths=new Set([...(job?.seen||[]),...(job?.requested||[]).filter(p=>items.some(i=>i.path===p&&i.state==='INSTALLED'))]);
  monitor.setDiscovery(discoveryReport([...paths],items,store.data.models,{error:modelsState.error}));
 }
 let syncPolling=null;
 function pollSync(force=false){
  const c=connection;if(!c||c.provider!=='cloudcompute')return Promise.resolve();if(syncPolling)return syncPolling;
  const last=monitor.data.last;if(!force&&last?.origin===c.origin&&!monitor.data.gpu_error&&Date.now()-last.observed_at<1500)return Promise.resolve();
  syncPolling=(async()=>{try{observeSync(c,await upstream(c,'/sync/status',{timeout:20000}))}
   catch(e){if(c===connection)monitor.gpuUnreachable(e.code==='JOB_NOT_FOUND'?{code:'SYNC_UNAVAILABLE',error:'этот GPU-сервер не поддерживает синхронизацию Google Drive (нужен образ YOISAKI ENGINE 1.7.2+).'}:publicError(e),c.origin)}})().finally(()=>{syncPolling=null});
  return syncPolling;
 }
 // While a job runs on the GPU the phone keeps following it (also when no page is open), every few seconds.
 const syncTimer=setInterval(()=>{if(monitor.running())pollSync().catch(()=>{})},Math.max(driveInterval,1000));syncTimer.unref();
 const selectionPending=()=>{const sel=library.selection();if(!sel)return 0;const items=monitor.lastItems();return Object.keys(sel.items).filter(p=>items?.find(i=>i.path===p)?.state!=='INSTALLED').length};
 const monitorView=()=>monitor.view({connected:connection?.provider==='cloudcompute',origin:connection?.origin||'',selectionPending:selectionPending()});
 const libraryView=(extra={})=>{
  const v={...library.view(),...extra},sel=library.selection(),d=secrets.deployment(),live=connection?.provider==='cloudcompute'&&monitor.data.last?.origin===connection.origin;
  v.selection=sel;
  v.estimate=selectionEstimate(sel,v.inventory,{gpuItems:monitor.lastItems(),disk:live?monitor.lastDisk():null,plannedDiskGb:d?.disk_gb??REQUIREMENTS.default_disk_gb,imageGb:REQUIREMENTS.image_size_note_gb});
  v.comparison=compareSources({inventory:v.inventory,gpuItems:monitor.lastItems(),gpuModels:store.data.models,currentPath:monitor.running()?monitor.data.last?.status?.job?.current?.path:null,selection:sel});
  v.gpu={connected:!!connection,provider:connection?.provider||null,sync_observed_at:monitor.data.last?.observed_at||null,sync_live:!!live&&!monitor.data.gpu_error,models_updated_at:store.data.inventory?.updated_at||null,models_stale:status().models_stale};
  return v;
 };
 const requireCloudGpu=()=>{const c=connection;if(!c)fail('GPU_OFFLINE','GPU не подключён. Подключите CloudCompute в разделе GPU; выбор моделей сохранён и будет использован.',409);if(c.provider!=='cloudcompute')fail('DRIVE_CLOUDCOMPUTE_ONLY','Синхронизация Google Drive доступна только для CloudCompute.',409);return c};
 // v1.7.5: Drive access goes only to the connected CloudCompute engine, over its authenticated HTTPS tunnel.
 async function bindDrive(c){
  const body=await drive.binding();if(c!==connection)fail('SUPERSEDED','GPU изменён.',409);
  const result=await upstream(c,'/sync/drive/connect',{method:'POST',body:validateConnect(body),timeout:30000});
  if(c!==connection)fail('SUPERSEDED','GPU изменён. Доступ был передан предыдущему серверу.',409);
  const view=observeSync(c,result);if(result.folder_selection!==true)fail('DRIVE_SERVER_UPGRADE','Обновите пакет GPU: сервер не подтвердил выбор папки.',409);
  return view;
 }
 // ---- v1.7.5 zero-terminal CloudCompute deployment -------------------------------------------------------------
 const imageChecks=new Map();
 async function imageStatus(image){const hit=imageChecks.get(image);if(hit&&Date.now()-hit.at<(hit.result.accessible?300000:30000))return hit.result;const result={...await checkImage(image,providerRequest),checked_at:Date.now()};imageChecks.set(image,{at:Date.now(),result});return result}
 const gb=n=>(n/1073741824).toFixed(n>=10737418240?0:1)+' ГБ';
 // Connects this app to the engine address the GPU published (signed with the deployment token).
 async function deployConnect(url,token,{automatic=false}={}){
  endpoint(url,'cloudcompute');
  if(connection&&connection.origin===url&&connection.token===token)return {message:''};
  if(automatic&&(connection||auto))return {message:'Адрес движка найден. Сейчас подключён другой сервер: нажмите «Подключить», чтобы переключиться.'};
  await secrets.remember('cloudcompute',{origin:url,token,discover:true});
  if(providers.selected!=='cloudcompute'){providers={...providers,selected:'cloudcompute'};await store.change(d=>{d.preferences={...d.preferences,gpu:providers}})}
  providers={...providers,endpoints:{...providers.endpoints,cloudcompute:url}};await store.change(d=>{d.preferences={...d.preferences,gpu:providers}});
  await startAutoconnect('cloudcompute',10);note('DEPLOY_CONNECT');
  return {message:'Подключаюсь к движку…'};
 }
 let driveRun=null;
 async function waitSyncJob(c,type,limitMs){
  const until=Date.now()+limitMs;
  for(;;){
   if(c!==connection)fail('SUPERSEDED','GPU отключён во время синхронизации.',409);
   const st=observeSync(c,await upstream(c,'/sync/status',{timeout:30000}));
   if(st.job&&st.job.type===type&&st.job.state!=='RUNNING')return st;
   if(Date.now()>until)fail('DRIVE_TIMEOUT','Синхронизация продолжается на GPU; прогресс виден в GOOGLE DRIVE AUTO SYNC.',504);
   await sleep(type==='check'?driveInterval:driveInterval*3);
  }
 }
 // Bind → check → (optionally) download only the missing/changed files → refresh the model inventory.
 function driveRoutine({download,automatic=false}){
  if(driveRun)return driveRun;
  const setDrive=patch=>watcher.update({drive:{...(watcher.get()?.drive||{}),...patch,at:Date.now()}});
  driveRun=(async()=>{
   try{
    const c=connection;if(!c||c.provider!=='cloudcompute')fail('GPU_OFFLINE','Сначала подключите GPU-сервер.',409);
    const view=drive.view();if(!view.connected||!view.folder){await setDrive({state:'SKIPPED',message:'Google Drive не подключён на телефоне или не выбрана папка моделей (раздел «Модели»). Модели можно добавить позже.',summary:null});return}
    await setDrive({state:'BINDING',message:'Передаю GPU доступ только для чтения к папке «'+view.folder.name+'»…'});await bindDrive(c);
    await setDrive({state:'CHECKING',message:'Сравниваю папку Google Drive с моделями на GPU…'});
    await upstream(c,'/sync/check',{method:'POST',body:'{}',timeout:30000});
    let st=await waitSyncJob(c,'check',15*60000);
    if(st.job.state!=='COMPLETED')fail('DRIVE_CHECK_FAILED',st.job.error||'Проверка папки не завершилась.',502);
    // v1.7.6: the saved selection (Models → Google Drive) decides what is downloaded; the whole collection is
    // never downloaded automatically. Without a selection only an explicit button press downloads all missing files.
    const sel=library.selection(),chosen=sel?new Set(Object.keys(sel.items)):null;
    const missing=st.items.filter(i=>['MISSING','CHANGED'].includes(i.state)),wanted=chosen?missing.filter(i=>chosen.has(i.path)):missing,bytes=wanted.reduce((n,i)=>n+(i.size||0),0);
    const summary={installed:st.items.filter(i=>i.state==='INSTALLED').length,missing:missing.length,missing_bytes:missing.reduce((n,i)=>n+(i.size||0),0),selected:chosen?chosen.size:null,wanted:wanted.length,wanted_bytes:bytes,conflicts:st.items.filter(i=>i.state==='CONFLICT').length,rejected:st.items.filter(i=>i.state==='REJECTED').length};
    if(!missing.length){await setDrive({state:'DONE',message:`Все ${summary.installed} моделей из папки уже на GPU.`,summary});await refresh(true);return}
    if(chosen&&!wanted.length){await setDrive({state:'DONE',message:`Все выбранные модели уже на GPU. В папке есть ещё ${missing.length} невыбранных файлов: их можно отметить в «Модели → Google Drive».`,summary});await refresh(true);return}
    if(!download||automatic&&!chosen){await setDrive({state:'READY_TO_SYNC',message:automatic&&!chosen?`Модели для загрузки не выбраны. На GPU уже ${summary.installed}; в папке ещё ${missing.length} файлов (${gb(summary.missing_bytes)}). Отметьте нужные в «Модели → Google Drive» и нажмите «Синхронизировать модели»: вся коллекция автоматически не скачивается.`:`На GPU уже ${summary.installed}; не хватает ${wanted.length} файлов (${gb(bytes)}). Нажмите «Синхронизировать модели».`,summary});return}
    await setDrive({state:'SYNCING',message:`Скачиваю ${chosen?'выбранные':'только недостающие'}: ${wanted.length} файлов (${gb(bytes)}). Прогресс — в «Модели → Синхронизация».`,summary});
    monitor.request(st.selective?wanted.map(i=>i.path):null,c.origin);
    observeSync(c,await upstream(c,'/sync/start',{method:'POST',body:st.selective?JSON.stringify({paths:wanted.map(i=>i.path)}):'{}',timeout:30000}));
    st=await waitSyncJob(c,'sync',6*3600000);
    await refresh(true);
    if(st.job.state!=='COMPLETED')fail('DRIVE_SYNC_FAILED',st.job.error||'Синхронизация завершилась с ошибкой: '+st.job.state,502);
    await setDrive({state:'DONE',message:`Готово: скачано и проверено ${st.job.overall.files_done} файлов. Список моделей обновлён.`,summary});
   }catch(e){await setDrive({state:'ERROR',message:publicError(e).error})}
  })().finally(()=>{driveRun=null});
  return driveRun;
 }
 const watcher=new DeploymentWatcher({secrets,cloud,progress:discoverProgress,interval:deployInterval,sleep,
  connect:deployConnect,connectionState:()=>({phase:currentPhase(),origin:connection?.origin||'',token:connection?.token||''}),
  afterReady:()=>{const d=secrets.deployment();if(d?.drive?.state&&d.drive.state!=='ERROR')return Promise.resolve();return driveRoutine({download:!!d?.auto_sync,automatic:true})}});
 // A creation whose answer was lost keeps a pending record (with its token) and is resolved by name, never re-sent.
 const resolvePending=async d=>{if(!d.instance_id.startsWith('pending-'))return;try{const found=instanceList(await cloud.request('GET','/instances')).find(i=>i.name===d.name);if(found){await secrets.change(x=>{if(x.deployment?.instance_id===d.instance_id)x.deployment.instance_id=found.id})}}catch{}};
 const originalTick=watcher.tick.bind(watcher);watcher.tick=async(d,alive)=>{if(d.instance_id.startsWith('pending-')){await resolvePending(d);d=secrets.deployment();if(!d||d.instance_id.startsWith('pending-')){if(Date.now()-d?.created_at>5*60000)await watcher.setStage('FAILED','CloudCompute не подтвердил создание и инстанс с именем '+d?.name+' не появился в списке. Проверьте панель CloudCompute; повторная попытка не выполнялась.');return}}return originalTick(d,alive)};
 let creating=false;
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
    await startAutoconnect(provider,Number(body.wait_minutes)||15);
    return send(res,status(),202);
   }
   if(route==='/api/gpu/remembered'&&method==='POST'){
    const b=await jsonBody(req);const provider=providerName(b.provider);
    if(b.forget===true)await secrets.forget(provider);else if(typeof b.discover==='boolean'){if(!secrets.connection(provider))fail('NOT_REMEMBERED','Сначала запомните подключение.',409);await secrets.setDiscover(provider,b.discover)}
    else fail('INVALID_REQUEST','Неверный запрос.');
    note(b.forget===true?'CONNECTION_FORGOTTEN':'DISCOVERY_'+(b.discover?'ON':'OFF'));return send(res,status());
   }
   if(route==='/api/cloudcompute/config'){
    if(method==='GET')return send(res,{configured:!!secrets.cloudKey()});
    if(method==='PUT'){const b=await jsonBody(req);await cloud.save(b.key);return send(res,{configured:true,validated_at:Date.now()})}
    if(method==='DELETE'){await secrets.setCloudKey(null);return send(res,{configured:false})}
   }
   if(route==='/api/cloudcompute/instances'){
    if(method==='GET')return send(res,await cloud.list());
    if(method==='POST'){const b=await jsonBody(req);if(b.confirm!==true)fail('CC_CONFIRM_REQUIRED','Подтвердите платное создание инстанса.');await cloud.create(b.instance);return send(res,{ok:true},201)}
   }
   const ccMatch=route.match(/^\/api\/cloudcompute\/instances\/([A-Za-z0-9_-]+)$/);
   if(ccMatch){
    if(method==='GET'){const raw=await cloud.detail(ccMatch[1]);return send(res,{instance:(await import('./cloudcompute-api.mjs')).instanceView(raw?.data||raw?.instance||raw),updated_at:Date.now()})}
    if(method==='PATCH'){await cloud.patch(ccMatch[1],await jsonBody(req));return send(res,{ok:true})}
    if(method==='DELETE'){const b=await jsonBody(req);if(b.confirm_id!==ccMatch[1])fail('CC_CONFIRM_REQUIRED','Подтвердите удаление ID инстанса.');await cloud.remove(ccMatch[1]);
     if(secrets.deployment()?.instance_id===ccMatch[1]){watcher.stop();await watcher.setStage('INSTANCE_GONE','Инстанс удалён по вашей команде. Оплата GPU прекращена; данные его диска удалены провайдером.')}
     return send(res,{ok:true})}
   }
   if(route==='/api/cloudcompute/offers'&&method==='GET')return send(res,{...offerList(await cloud.offers()),requirements:REQUIREMENTS,updated_at:Date.now()});
   if(route==='/api/cloudcompute/image'&&method==='GET'){const image=u.searchParams.get('image')||ENGINE_IMAGE;return send(res,await imageStatus(validateImage(image)))}
   if(route==='/api/cloudcompute/deploy'){
    if(method==='GET')return send(res,{deployment:watcher.view(),default_image:ENGINE_IMAGE,requirements:REQUIREMENTS});
    if(method==='DELETE'){const b=await jsonBody(req);if(b.confirm!==true)fail('CC_CONFIRM_REQUIRED','Подтвердите: забыть сервер на телефоне (инстанс в CloudCompute не удаляется).');watcher.stop();await secrets.setDeployment(null);note('DEPLOY_FORGOTTEN');return send(res,{deployment:null})}
    if(method==='POST'){
     const b=await jsonBody(req);
     if(b.confirm!==true)fail('CC_CONFIRM_REQUIRED','Подтвердите создание платного GPU-сервера.');
     if(creating)fail('CC_BUSY','Создание уже выполняется.',409);
     const existing=secrets.deployment();
     if(existing&&!END_STAGES.includes(existing.stage)&&b.additional!==true)fail('CC_DEPLOYMENT_EXISTS',`Уже есть GPU-сервер YOISAKI #${existing.instance_id}. Удалите его или подтвердите создание ещё одного (он тоже оплачивается).`,409);
     const image=b.image===undefined||b.image===''?ENGINE_IMAGE:validateImage(b.image);
     if(!Number.isSafeInteger(b.offer_id)||!Number.isSafeInteger(b.accepted_price_minor)||typeof b.currency!=='string')fail('CC_INVALID_CREATE','Выберите предложение GPU и подтвердите его цену.');
     creating=true;
     try{
      const check=await imageStatus(image);
      if(check.accessible!==true&&b.skip_image_check!==true)fail('CC_IMAGE_UNAVAILABLE',check.message+' Инстанс НЕ создан, деньги не списаны.',409);
      const offer=offerList(await cloud.offers()).offers.find(o=>o.id===b.offer_id);
      if(!offer)fail('CC_OFFER_GONE','Это предложение больше не доступно. Обновите список GPU. Инстанс не создан.',409);
      if(!offer.compatible)fail('CC_OFFER_INCOMPATIBLE',offer.reasons.join(' ')+' Инстанс не создан.',409);
      if(offer.price.minor!==b.accepted_price_minor||offer.price.currency!==b.currency)fail('CC_PRICE_CHANGED',`Цена изменилась: сейчас ${(offer.price.minor/100).toFixed(2)} ${offer.price.currency}/час. Подтвердите новую цену. Инстанс не создан.`,409);
      const token=newToken(),name=instanceName(),disk=b.disk_gb??REQUIREMENTS.default_disk_gb;
      const body=createBody({offer,disk_gb:disk,name,image,token,max_price_hour_minor:offer.price.minor,currency:offer.price.currency});
      const record={instance_id:'pending-'+name,token,image,name,created_at:Date.now(),offer:{id:offer.id,gpu:offer.gpu,vram_mb:offer.vram_mb,price_minor:offer.price.minor,currency:offer.price.currency},disk_gb:disk,auto_sync:b.auto_sync!==false,stage:'CREATING',stage_message:'Создаю GPU-сервер…',stage_at:Date.now()};
      // The token is saved BEFORE the paid request: an unanswered creation can still be connected later.
      await secrets.setDeployment(record);
      let json;
      try{json=await cloud.deploy(body)}
      catch(e){
       if(/^CC_HTTP_4/.test(e.code||'')){await secrets.setDeployment(existing||null);throw e}
       await watcher.setStage('CREATING','Ответ CloudCompute не получен. Ищу инстанс '+name+' в списке; повторное создание не выполняется.');watcher.start();note('DEPLOY_UNCONFIRMED');
       fail(e.code||'PROVIDER_NETWORK',publicError(e).error+' Повторное создание не выполнялось: проверьте список инстансов.',502);
      }
      const id=createdInstanceId(json);
      await secrets.change(d=>{if(d.deployment?.token===token){if(id)d.deployment.instance_id=id;Object.assign(d.deployment,{stage:'GPU_CREATED',stage_message:'GPU-сервер создан. Оплата идёт с этого момента.',stage_at:Date.now()})}});
      note('DEPLOY_CREATED');watcher.start();
      return send(res,{deployment:watcher.view()},201);
     }finally{creating=false}
    }
   }
   if(route==='/api/cloudcompute/deploy/watch'&&method==='POST')return send(res,{deployment:watcher.start()});
   if(route==='/api/cloudcompute/deploy/connect'&&method==='POST'){
    const d=secrets.deployment();if(!d)fail('CC_NO_DEPLOYMENT','Сначала создайте GPU-сервер YOISAKI.',409);
    if(!d.url){if(secrets.connection('cloudcompute')?.token===d.token){await startAutoconnect('cloudcompute',10);return send(res,{deployment:watcher.view(),status:status()},202)}fail('CC_NOT_READY','Движок ещё не сообщил свой адрес. Дождитесь этапа «Проверка движка» или нажмите «Инициализировать движок».',409)}
    await deployConnect(d.url,d.token);if(!watcher.running)watcher.start();return send(res,{deployment:watcher.view(),status:status()},202);
   }
   if(route==='/api/cloudcompute/deploy/sync'&&method==='POST'){
    const b=await jsonBody(req);if(!connection||connection.provider!=='cloudcompute')fail('GPU_OFFLINE','Сначала подключите GPU-сервер.',409);
    if(!secrets.deployment())fail('CC_NO_DEPLOYMENT','Синхронизация из этой панели работает для сервера, созданного здесь. Используйте GOOGLE DRIVE AUTO SYNC в разделе «Модели».',409);
    driveRoutine({download:b.download!==false}).catch(()=>{});await sleep(50);return send(res,{deployment:watcher.view()},202);
   }
   if(route==='/api/cloudcompute/deploy/adopt'&&method==='POST'){
    const b=await jsonBody(req);if(b.confirm!==true)fail('CC_CONFIRM_REQUIRED','Подтвердите подготовку существующего инстанса.');
    if(typeof b.instance_id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(b.instance_id))fail('CC_INVALID_ID','Некорректный ID инстанса.');
    const image=b.image?validateImage(b.image):ENGINE_IMAGE,token=newToken();
    const view=(await import('./cloudcompute-api.mjs')).instanceView((r=>r?.data||r?.instance||r)(await cloud.detail(b.instance_id)));
    watcher.stop();
    await secrets.setDeployment({instance_id:view.id,token,image,name:view.name,created_at:Date.now(),adopted:true,auto_sync:b.auto_sync!==false,stage:'INSTANCE_INITIALIZING',stage_message:'Выполните показанную команду один раз в веб-терминале инстанса (панель CloudCompute).',stage_at:Date.now()});
    note('DEPLOY_ADOPTED');watcher.start();
    // Shown once: the command contains the new engine token of this instance.
    return send(res,{deployment:watcher.view(),command:"bash <<'YOISAKI_ONSTART'\n"+onstartScript({image,token})+'YOISAKI_ONSTART\n'});
   }
   const oauthView=()=>{const g=googleClient();return {configured:!!g,client_id:g?.client_id||'',redirect_uri:redirectUri(port),scope:SCOPE,last_result:oauthResult,...drive.view()}};
   if(route==='/api/drive/oauth'){
    if(method==='GET')return send(res,oauthView());
    if(method==='PUT'){const g=validateClient(await jsonBody(req));oauthGeneration++;oauth.pending.clear();await secrets.change(d=>{d.google=g;d.drive=null});oauthResult=null;return send(res,oauthView())}
    if(method==='DELETE'){oauthGeneration++;oauth.pending.clear();await secrets.change(d=>{d.google=null;d.drive=null});oauthResult=null;return send(res,oauthView())}
   }
   if(route==='/api/drive/oauth/start'&&method==='POST'){
    const g=googleClient();if(!g)fail('DRIVE_OAUTH_NOT_CONFIGURED','OAuth-клиент Google ещё не настроен. Укажите его в настройках Google Drive.',409);
    oauthGeneration++;oauth.pending.clear();oauthResult=null;return send(res,{url:oauth.start(g,port,{client:g,generation:oauthGeneration})});
   }
   if(route==='/api/drive/folders'&&method==='GET')return send(res,await drive.folders(u.searchParams.get('parent')||'root',u.searchParams.get('page')||''));
   if(route==='/api/drive/folder'&&method==='PUT')return send(res,await drive.choose((await jsonBody(req)).id));
   if(route==='/api/drive/account'&&method==='DELETE'){oauthGeneration++;oauth.pending.clear();await secrets.setDrive(null);oauthResult=null;return send(res,drive.view())}
   if(route==='/api/drive/bind'&&method==='POST'){
    const c=connection;if(!c||c.provider!=='cloudcompute')fail('GPU_OFFLINE','Подключите CloudCompute, чтобы передать доступ выбранному GPU.',409);
    return send(res,await bindDrive(c));
   }
   // ---- v1.7.6 Google Drive model library, selection, sync monitor and GPU readiness ----------------------------
   if(route==='/api/drive/library'&&method==='GET')return send(res,libraryView());
   if(route==='/api/drive/library/check'&&method==='POST'){const r=await library.check();note(r.verified_now?'DRIVE_LIBRARY_VERIFIED':'DRIVE_LIBRARY_'+(r.error?.state||'ERROR'));return send(res,libraryView(r))}
   if(route==='/api/drive/library/browse'&&method==='GET')return send(res,await library.browse({folder:u.searchParams.get('folder')||'',page:u.searchParams.get('page')||'',query:u.searchParams.get('q')||'',path:u.searchParams.get('path')||'',outside:u.searchParams.get('outside')==='1'}));
   if(route==='/api/drive/library/parent'&&method==='GET')return send(res,await library.parent(u.searchParams.get('id')||''));
   if(route==='/api/drive/library/inspect'&&method==='POST'){const r=await library.inspect((await jsonBody(req)).ids);return send(res,{...libraryView(),results:r.results})}
   if(route==='/api/drive/selection'){
    if(method==='GET')return send(res,libraryView());
    if(method==='PUT'){await library.select((await jsonBody(req)).paths);note('DRIVE_SELECTION');return send(res,libraryView())}
   }
   if(route==='/api/sync/monitor'&&method==='GET'){if(u.searchParams.get('live')!=='0')await pollSync(true);return send(res,monitorView())}
   if(route==='/api/sync/start'&&method==='POST'){
    const b=await jsonBody(req);if(!['selected','missing','retry'].includes(b?.mode))fail('INVALID_REQUEST','Неверный режим синхронизации.');
    const c=requireCloudGpu();let paths=null;
    const saved=()=>{const sel=library.selection();return sel?Object.keys(sel.items):[]};
    if(b.mode==='selected'){paths=saved();if(!paths.length)fail('DRIVE_NOTHING_SELECTED','Модели не выбраны. Отметьте их на вкладке «Google Drive».',409)}
    if(b.mode==='retry'){const last=monitor.data.job;paths=last?.type==='sync'?last.requested:saved().length?saved():null}
    let st=observeSync(c,await upstream(c,'/sync/status',{timeout:30000}));
    if(st.job?.state==='RUNNING')fail('DRIVE_SYNC_BUSY','Синхронизация уже выполняется: прогресс показан на вкладке «Синхронизация».',409);
    if(!st.enabled)fail('DRIVE_SYNC_DISABLED','Синхронизация отключена на GPU-сервере (YOISAKI_DRIVE_SYNC=0).',409);
    // Drive access is (re)sent to this GPU when it has none or Google rejected the copy it has.
    if(!st.configured||st.connection.state==='ERROR'&&['AUTH_FAILED','NOT_CONFIGURED'].includes(st.connection.code))st=await bindDrive(c);
    if(paths&&!st.selective)fail('DRIVE_SERVER_UPGRADE','GPU-сервер не поддерживает выборочную синхронизацию: обновите образ движка.',409);
    monitor.request(paths,c.origin);
    observeSync(c,await upstream(c,'/sync/start',{method:'POST',body:validateSyncStart(JSON.stringify(paths?{paths}:{})),timeout:30000}));
    note('DRIVE_SYNC_'+b.mode.toUpperCase());return send(res,monitorView(),202);
   }
   if(route==='/api/sync/cancel'&&method==='POST'){const c=requireCloudGpu();observeSync(c,await upstream(c,'/sync/cancel',{method:'POST',body:'{}',timeout:30000}));note('DRIVE_CANCEL');return send(res,monitorView())}
   if(route==='/api/system/readiness'&&method==='GET'){
    await pollSync();
    return send(res,{...readiness({cloudConfigured:!!secrets.cloudKey(),deployment:watcher.view(),connection,state,info,lastCode,lastError,models:store.data.models,monitor:monitorView(),drive:library.account(),compatibility:engineCompatibility(info)}),dashboard:'https://app.cloudcompute.ru/',checked_at:Date.now()});
   }
   const driveMatch=route.match(/^\/api\/gpu\/drive\/(status|check|sync|cancel|connect|disconnect)$/);
   if(driveMatch){
    const [remoteMethod,remoteRoute]=SYNC_ACTIONS[driveMatch[1]];
    if(method!==remoteMethod)fail('METHOD_DENIED','Метод не поддерживается.',405);
    if(!connection)fail('GPU_OFFLINE','GPU отключён. Подключите CloudCompute в разделе GPU.',409);
    if(connection.provider!=='cloudcompute')fail('DRIVE_CLOUDCOMPUTE_ONLY','Google Drive Auto Sync доступна только для CloudCompute.',409);
    // The connect body (OAuth token) is forwarded once and never stored, logged or echoed.
    const body=driveMatch[1]==='connect'?validateConnect(await jsonBody(req)):driveMatch[1]==='sync'?validateSyncStart(await readBody(req,1048576)):remoteMethod==='POST'?'{}':undefined;
    const c=connection;if(driveMatch[1]==='sync')monitor.request(JSON.parse(body).paths||null,c.origin);const result=await upstream(c,remoteRoute,{method:remoteMethod,body,timeout:30000});
    if(connection!==c)fail('SUPERSEDED','Провайдер изменён.',409);
    if(driveMatch[1]!=='status')note('DRIVE_'+driveMatch[1].toUpperCase());return send(res,observeSync(c,result));
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
   if(route==='/api/diagnostics'&&method==='GET'){const st=status();return send(res,{version:WEBSITE_VERSION,node:process.version,platform:process.platform,arch:process.arch,provider:providers.selected,engine_version:info?.engine_version??null,api_version:info?.api_version??null,state,code:lastCode,phase:st.phase,components:st.components,models:store.data.models.length,models_error:modelsState.code,models_rejected:st.models_rejected.length,remembered:Object.fromEntries(Object.entries(st.remembered).map(([k,v])=>[k,!!v])),images:store.data.gallery.length,events:diagnostics})}
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
   const g=pending.context.client;
   if(pending.context.generation!==oauthGeneration||JSON.stringify(g)!==JSON.stringify(googleClient()))fail('DRIVE_CHANGED','OAuth-клиент изменён. Повторите вход.',409);
   const token=await exchange(g,u.searchParams.get('code'),pending);
   const account=await drive.accept(g,token);
   if(pending.context.generation!==oauthGeneration||JSON.stringify(g)!==JSON.stringify(googleClient()))fail('DRIVE_CHANGED','OAuth-клиент изменён.',409);
   await secrets.setDrive(account);
   oauthResult={ok:true,code:'CONNECTED',message:'Google Drive подключён на телефоне. Выберите папку моделей.',at:Date.now()};note('DRIVE_OAUTH_CONNECTED');
  }catch(e){oauthResult={ok:false,code:e.code||'DRIVE_OAUTH_FAILED',message:publicError(e).error,at:Date.now()};note(oauthResult.code)}
  res.writeHead(302,{Location:'/models?drive_auth=1','Cache-Control':'no-store'});res.end();
 }
 server.requestTimeout=100000;server.headersTimeout=10000;
 // v1.7.5: after a restart of this app an unfinished initialization continues; a finished one reconnects by itself.
 if(autoResume){const d=secrets.deployment();
  if(d&&!END_STAGES.includes(d.stage)&&d.stage!=='GPU_READY')watcher.start();
  else if(d?.stage==='GPU_READY'&&providers.selected==='cloudcompute'&&secrets.connection('cloudcompute')?.token===d.token)startAutoconnect('cloudcompute',3).catch(()=>{});}
 return {server,store,status,pollJobs,async close(){closed=true;watcher.stop();clearInterval(pollTimer);clearInterval(syncTimer);await Promise.allSettled([...background,syncPolling].filter(Boolean));connection=null;jobs.clear();acknowledgements.clear();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});while(polling)await new Promise(r=>setTimeout(r,20));await store.chain;monitor.closed=library.closed=true;await monitor.chain;await library.chain}};
}

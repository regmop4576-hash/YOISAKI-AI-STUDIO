import {providerConfig,providerName,endpoint} from './providers.mjs';
import {validatePreprocess,validateControlImage,compactControlRequest} from './controlnet.mjs';
import {compactSourceRequest} from './img2img.mjs';
import {TERMINAL_STATUSES,HISTORY_LIMIT,isTerminal,matchesHistory} from './history.mjs';
import {WEBSITE_VERSION,COMPATIBLE_ENGINE_FAMILY,engineCompatibility} from './release.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from './storage.mjs';
import {parseTunnel,requestUpstream,validateHealth,validateModels,validateGeneration,supportsRegionalControl} from './upstream.mjs';
import {AppError,fail,publicError} from './errors.mjs';
const ID=/^[a-f0-9-]{36}(?:_[0-3])?$/;
const terminal=TERMINAL_STATUSES;
async function readBody(req,max=12582912){const chunks=[];let n=0;for await(const b of req){n+=b.length;if(n>max)fail('BODY_TOO_LARGE','Слишком большой запрос.',413);chunks.push(b)}return Buffer.concat(chunks)}
async function jsonBody(req){try{return JSON.parse((await readBody(req)).toString())}catch(e){if(e instanceof AppError)throw e;fail('INVALID_JSON','Неверный JSON запроса.')}}
function send(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
export async function createLocalApp({dataDir,distDir,upstream=requestUpstream,serviceKey=''}={}){
 const store=await new Store(dataDir).init();
 if(store.data.history.some(j=>['RUNNING','QUEUED'].includes(j.status)))await store.change(d=>{for(const j of d.history)if(['RUNNING','QUEUED'].includes(j.status)){j.status='CONNECTION_LOST';j.connection_error='Состояние сохранено. Подключитесь к прежней сессии GPU для проверки.'}});
 let connection=null,info=null,state='OFFLINE',lastError='',lastCode='',epoch=0,refreshing=null,closed=false,polling=false,submissionChain=Promise.resolve();
 const jobs=new Map();const acknowledgements=new Map();const session=randomBytes(32).toString('hex');
 const diagnostics=[];
 const note=(code)=>{diagnostics.push({at:new Date().toISOString(),code});if(diagnostics.length>30)diagnostics.shift()};
 // No credentials are ever stored in state.json. Unfinished histories can resume on explicit reconnect.
 const historySnapshot=()=>({items:store.data.history.map(j=>({...j,terminal:isTerminal(j),can_delete:isTerminal(j)&&!jobs.has(j.id)})),limit:HISTORY_LIMIT});
 let providers=providerConfig(store.data.preferences);
 const status=()=>({provider:providers.selected,endpoints:{...providers.endpoints},url:connection?.origin||'',state,info,models:store.data.models,error:lastError,code:lastCode,storage_warning:store.warning,website_version:WEBSITE_VERSION,compatible_engine_family:COMPATIBLE_ENGINE_FAMILY,compatibility:engineCompatibility(info)});
 async function disconnectSession(){
  const version=++epoch;refreshing=null;connection=null;info=null;state='OFFLINE';lastError='';lastCode='';jobs.clear();acknowledgements.clear();
  // Disconnect does not cancel GPU work. Preserve unresolved records for explicit reconnect.
  await store.change(d=>{for(const j of d.history)if(!terminal.includes(j.status)){j.status='CONNECTION_LOST';j.connection_error='GPU отключён. Подключитесь к прежнему провайдеру и адресу для проверки.'}});
  return version;
 }
 const sameProvider=(job,c)=>job.origin===c.origin&&(job.provider||'colab')===c.provider;
 const mergeModels=async(models)=>store.change(d=>{d.models=models;for(const m of models){if(m.kind!=='lora'||d.tags[m.id])continue;let words=m.trigger_words||m.sidecar?.trainedWords;const tags=Array.isArray(words)?words:typeof words==='string'&&!words.trim().startsWith('{')?words.split(/[,\n]/):[];d.tags[m.id]={model_id:m.id,trigger_words:tags.filter(x=>typeof x==='string').slice(0,64),recommended_tags:[],description:typeof m.sidecar?.description==='string'?m.sidecar.description.slice(0,4000):''}}});
 async function refresh(forceModels=false){if(!connection)return status();if(refreshing)return refreshing;const current=connection,version=epoch;
 refreshing=(async()=>{try{const health=validateHealth(await upstream(current,'/health',{timeout:20000}));let models;if(forceModels)models=validateModels(await upstream(current,'/models',{timeout:30000}));if(epoch===version){if(models)await mergeModels(models);if(epoch!==version)return status();info=health;state=health.state;lastError='';lastCode=''}}catch(e){if(epoch===version){state='ERROR';info=null;lastError=publicError(e).error;lastCode=e.code||'LOCAL_ERROR';note(lastCode)}}return status()})().finally(()=>{refreshing=null});return refreshing;
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
  if(req.headers['sec-fetch-site']&& !['same-origin','none'].includes(req.headers['sec-fetch-site']))fail('ORIGIN_DENIED','Внешняя страница не имеет доступа.',403);
  const u=new URL(req.url,'http://'+host);const route=u.pathname;const method=req.method;
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
   if(route==='/api/version'&&method==='GET')return send(res,{studio_version:WEBSITE_VERSION,edition:'CLOUDCOMPUTE EDITION',compatible_engine:COMPATIBLE_ENGINE_FAMILY,engine_version:info?.engine_version??null,api_version:info?.api_version??null});
   if(route==='/api/gpu/connect'&&method==='POST'){
    const body=await jsonBody(req);const {url}=body;const provider=providerName(body.provider??providers.selected);
    if(provider!==providers.selected)fail('PROVIDER_CHANGED','Сначала выберите провайдера.',409);
    if(typeof url!=='string'||url.length>1000)fail('INVALID_URL','Вставьте полную защищённую ссылку.');const c=parseTunnel(url,provider);
    const version=await disconnectSession();if(version!==epoch)fail('SUPERSEDED','Подключение отменено.',409);state='CONNECTING';lastError='';
    providers={...providers,endpoints:{...providers.endpoints,[provider]:c.origin}};
    await store.change(d=>{d.preferences={...d.preferences,gpu:providers}});
    try{const h=validateHealth(await upstream(c,'/health',{timeout:20000}));const models=validateModels(await upstream(c,'/models',{timeout:30000}));if(version!==epoch)fail('SUPERSEDED','Подключение отменено.',409);
    await store.change(d=>{for(const j of d.history)if(!['COMPLETED','FAILED','CANCELLED','INTERRUPTED'].includes(j.status)){j.status='CONNECTION_LOST';j.connection_error='Ожидается подтверждение GPU'}});
    if(version!==epoch)fail('SUPERSEDED','Подключение отменено.',409);jobs.clear();acknowledgements.clear();connection=c;info=h;state=h.state;await mergeModels(models);await store.change(d=>{d.preferences={...d.preferences,last_host:c.origin}});
    if(version!==epoch)fail('SUPERSEDED','Подключение отменено.',409);
    for(const j of store.data.history){if(sameProvider(j,c)&&!['COMPLETED','FAILED','CANCELLED'].includes(j.status)){jobs.set(j.id,c);await setJob(j.id,{status:'CONNECTION_LOST',connection_error:'Проверяем прежнюю задачу…'})}}
    if(/^1\.[5-7]\./.test(h.engine_version||''))for(const j of store.data.history.filter(j=>sameProvider(j,c)&&j.status==='COMPLETED'&&j.result?.image_keys?.every((_,i)=>store.data.gallery.some(g=>g.id===j.id+'_'+i))))acknowledgements.set(j.id,c);
    lastError='';lastCode='';note('CONNECTED');return send(res,status());
    }catch(e){if(version===epoch){state='ERROR';connection=null;info=null;lastError=publicError(e).error;lastCode=e.code||'LOCAL_ERROR';note(lastCode)}throw e}
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
   if(route==='/api/diagnostics'&&method==='GET')return send(res,{version:WEBSITE_VERSION,node:process.version,platform:process.platform,arch:process.arch,provider:providers.selected,engine_version:info?.engine_version??null,api_version:info?.api_version??null,state,code:lastCode,models:store.data.models.length,images:store.data.gallery.length,events:diagnostics});
   fail('NOT_FOUND','API не найден.',404);
  }
  if(!['GET','HEAD'].includes(method))fail('METHOD_DENIED','Метод не поддерживается.',405);
  const relative=decodeURIComponent(route).replace(/^\//,'');let file=path.resolve(distDir,relative||'index.html');if(!file.startsWith(path.resolve(distDir)+path.sep))fail('PATH_DENIED','Недопустимый путь.',403);
  try{if(!(await fs.stat(file)).isFile())throw Error()}catch{if(!['/','/generate','/edit','/models','/gallery','/engine'].includes(route))fail('NOT_FOUND','Файл не найден.',404);file=path.join(distDir,'index.html')}
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp'}[path.extname(file)]||'application/octet-stream';const bytes=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-cache','Content-Length':bytes.length});res.end(method==='HEAD'?undefined:bytes);
 }catch(e){note(e.code||'LOCAL_ERROR');if(!res.headersSent)send(res,publicError(e),e.status||500);else res.destroy()}
 });
 server.requestTimeout=100000;server.headersTimeout=10000;
 return {server,store,status,pollJobs,async close(){closed=true;clearInterval(pollTimer);connection=null;jobs.clear();acknowledgements.clear();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});while(polling)await new Promise(r=>setTimeout(r,20));await store.chain}};
}

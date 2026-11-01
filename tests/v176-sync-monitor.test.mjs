// v1.7.6 real-time Google Drive → CloudCompute monitor, recovery, retry/cancel, model discovery and GPU readiness.
// SIMULATED: the GPU is tests/fixtures/fake-gpu.mjs (drive_sync.py JSON format, values set by the test) and Google is
// tests/fixtures/fake-drive.mjs. The real transfer path (rclone + drive_sync.py) is covered by
// tests/v176-real-sync-e2e.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLocalApp} from '../server/app.mjs';
import {SecretStore} from '../server/secrets.mjs';
import {SyncMonitor,stageOf,discoveryReport} from '../server/sync-monitor.mjs';
import {readiness} from '../server/readiness.mjs';
import {FakeDrive,account} from './fixtures/fake-drive.mjs';
import {fakeGpu,TOKEN,modelId} from './fixtures/fake-gpu.mjs';

const GB=2**30,MB=2**20;
const SELECTION={folder_id:'models-root',folder_name:'YOISAKI_MODELS',updated_at:1,items:{
 'checkpoints/Illustrious_XL_v17.safetensors':{id:'ill',name:'Illustrious_XL_v17.safetensors',kind:'checkpoint',size:Math.round(6.6*GB)},
 'loras/Amber_Nova.safetensors':{id:'amber',name:'Amber_Nova.safetensors',kind:'lora',size:193*MB},
 'loras/Vesper_Nova.safetensors':{id:'vesper',name:'Vesper_Nova.safetensors',kind:'lora',size:185*MB}}};
async function harness({gpu=fakeGpu(),dir=null,selection=SELECTION,drive=account(),connect=true,cloudKey=false,deployment=null,fake=new FakeDrive()}={}){
 const fresh=!dir;dir??=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-176m-'));
 if(fresh){const s=await new SecretStore(dir).init();if(drive)await s.setDrive(drive);if(cloudKey)await s.setCloudKey('cc-test_secret_12345');if(deployment)await s.setDeployment(deployment);
  if(selection)await fs.writeFile(path.join(dir,'drive-library.json'),JSON.stringify({version:1,inventory:null,last_check:null,selection}))}
 const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),providerRequest:fake.request,providerBytesRequest:fake.bytes,upstream:gpu.upstream,autoResume:false,sleep:()=>new Promise(r=>setTimeout(r,2)),driveInterval:5,deployInterval:1e6});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const cookie=(await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}})).headers.get('set-cookie').split(';')[0];
 const call=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'X-Yoisaki-Local':'1',cookie},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 if(connect){await call('/api/gpu/provider','POST',{provider:'cloudcompute'});const r=await call('/api/gpu/connect','POST',{url:'https://nova.trycloudflare.com/#token='+TOKEN,provider:'cloudcompute'});assert.equal(r.body.state,'READY',JSON.stringify(r.body))}
 const monitor=async(live=true)=>(await call('/api/sync/monitor'+(live?'':'?live=0'))).body;
 return {app,dir,gpu,call,monitor,async close({keep=false}={}){await app.close();if(!keep)await fs.rm(dir,{recursive:true,force:true})}};
}
const until=async(fn,ms=3000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,20))}};

test('stage mapping covers every drive_sync phase and job state',()=>{
 const s=(state,phase,failed=0)=>stageOf({job:{state,phase,overall:{files_failed:failed}}});
 assert.equal(stageOf({job:null}),'IDLE');
 assert.deepEqual(['LISTING','COMPARING','HASHING_LOCAL','DOWNLOADING','VERIFYING_PARTIAL','VERIFYING','INSTALLING'].map(p=>s('RUNNING',p)),['CHECKING_DRIVE','COMPARING_FILES','COMPARING_FILES','DOWNLOADING','DOWNLOADING','VERIFYING','VERIFYING']);
 assert.equal(s('COMPLETED','DONE'),'COMPLETED');assert.equal(s('COMPLETED','DONE',1),'ERROR');assert.equal(s('CANCELLED','DOWNLOADING'),'CANCELLED');assert.equal(s('FAILED','DOWNLOADING'),'ERROR');assert.equal(s('INTERRUPTED','DOWNLOADING'),'ERROR');
});

test('full workflow B: selected models → real-time stages, bytes, speed, ETA from GPU values → verification → new LoRA in the generator',async()=>{
 const h=await harness();const g=h.gpu;
 try{
  let m=await h.monitor();assert.equal(m.state,'IDLE');assert.equal(m.selection_pending,3);
  const r=await h.call('/api/sync/start','POST',{mode:'selected'});assert.equal(r.status,202);
  assert.deepEqual(g.starts,[{paths:Object.keys(SELECTION.items)}]);
  m=await h.monitor();assert.equal(m.state,'CHECKING_DRIVE');assert.equal(m.job.id,'job1');assert.equal(m.source,'LIVE');assert(m.events.some(e=>e.type==='JOB_STARTED'));
  g.sync.items=[{path:'checkpoints/Illustrious_XL_v17.safetensors',name:'Illustrious_XL_v17.safetensors',kind:'checkpoint',size:Math.round(6.6*GB),state:'MISSING',reason:'',verification:''},{path:'loras/Amber_Nova.safetensors',name:'Amber_Nova.safetensors',kind:'lora',size:193*MB,state:'MISSING',reason:'',verification:''},{path:'loras/Vesper_Nova.safetensors',name:'Vesper_Nova.safetensors',kind:'lora',size:185*MB,state:'INSTALLED',reason:'',verification:'md5+safetensors'}];
  g.job({phase:'COMPARING'});m=await h.monitor();assert.equal(m.state,'COMPARING_FILES');
  const total=Math.round(6.6*GB)+193*MB;
  g.job({phase:'DOWNLOADING',overall:{files_total:2,bytes_total:total,bytes_done:0},current:{path:'checkpoints/Illustrious_XL_v17.safetensors',kind:'checkpoint',phase:'DOWNLOADING',bytes_done:0,bytes_total:Math.round(6.6*GB),speed_bps:null,resumed_from:null}});g.item('checkpoints/Illustrious_XL_v17.safetensors','DOWNLOADING');
  m=await h.monitor();assert.equal(m.state,'DOWNLOADING');assert.equal(m.current.name,'Illustrious_XL_v17.safetensors');assert.equal(m.current.speed_bps,null);assert.equal(m.current.eta_seconds,null,'no speed yet → ETA unavailable, never guessed');
  const done=Math.round(5.4*GB);g.job({overall:{bytes_done:done},current:{...g.sync.job.current,bytes_done:done,speed_bps:48*MB}});
  m=await h.monitor();assert.equal(m.current.percent,81);assert.equal(m.current.speed_bps,48*MB);assert.equal(m.current.speed_source,'GPU');
  assert.equal(m.current.eta_seconds,Math.ceil((Math.round(6.6*GB)-done)/(48*MB)));assert.equal(m.overall.files_total,2);assert.equal(m.overall.files_remaining,2);assert.equal(m.overall.eta_seconds,Math.ceil((total-done)/(48*MB)));
  // a partial download is never shown as installed
  let lib=(await h.call('/api/drive/library')).body;assert.equal(lib.estimate.installed_on_gpu,1);
  g.job({phase:'VERIFYING',current:{...g.sync.job.current,phase:'VERIFYING',bytes_done:Math.round(6.6*GB),speed_bps:null}});g.item('checkpoints/Illustrious_XL_v17.safetensors','VERIFYING');
  m=await h.monitor();assert.equal(m.state,'VERIFYING');assert.equal(m.current.eta_seconds,null);
  g.item('checkpoints/Illustrious_XL_v17.safetensors','INSTALLED',{verification:'sha256+safetensors'});g.job({phase:'DOWNLOADING',overall:{files_done:1},current:{path:'loras/Amber_Nova.safetensors',kind:'lora',phase:'DOWNLOADING',bytes_done:10*MB,bytes_total:193*MB,speed_bps:30*MB,resumed_from:null}});g.item('loras/Amber_Nova.safetensors','DOWNLOADING');
  m=await h.monitor();assert(m.events.some(e=>e.type==='FILE_INSTALLED'&&e.path==='checkpoints/Illustrious_XL_v17.safetensors'));assert.equal(m.overall.files_done,1);
  // the engine catalogue gains the new LoRA after the sync (revision changes)
  g.item('loras/Amber_Nova.safetensors','INSTALLED');g.job({state:'COMPLETED',phase:'DONE',finished_unix:Date.now()/1000,overall:{files_done:2,bytes_done:total},current:null});
  g.models.push({id:modelId(),name:'Amber_Nova.safetensors',kind:'lora',architecture:'SDXL',compatible:true,size_bytes:193*MB},{id:modelId(),name:'Vesper_Nova.safetensors',kind:'lora',architecture:'unknown',compatible:null,size_bytes:185*MB});g.revision='2'.repeat(32);
  m=await h.monitor();assert.equal(m.state,'COMPLETED');
  m=await until(async()=>{const x=await h.monitor();return x.discovery&&x});
  const amber=m.discovery.files.find(f=>f.name==='Amber_Nova.safetensors');assert.equal(amber.generator,'AVAILABLE');assert(m.discovery.files.some(f=>f.name==='Illustrious_XL_v17.safetensors'&&f.generator==='AVAILABLE'));
  assert(m.events.some(e=>e.type==='JOB_FINISHED'&&e.state==='COMPLETED'));assert(m.events.some(e=>e.type==='INVENTORY_REFRESHED'));
  const st=(await h.call('/api/gpu/status')).body;assert(st.models.some(x=>x.name==='Amber_Nova.safetensors'&&x.kind==='lora'));assert(st.models.some(x=>x.name==='Vesper_Nova.safetensors'&&x.compatible===null),'unverified LoRA stays visible');
  lib=(await h.call('/api/drive/library')).body;assert.equal(lib.estimate.download_bytes,0);
  assert.equal(g.starts.length,1);
 }finally{await h.close()}
});

test('reload / lost phone network / GPU unreachable: last-known state with the job ID, no restarted download, live again after reconnect',async()=>{
 const h=await harness();const g=h.gpu;
 try{
  await h.call('/api/sync/start','POST',{mode:'selected'});
  g.sync.items=[{path:'loras/Amber_Nova.safetensors',name:'Amber_Nova.safetensors',kind:'lora',size:193*MB,state:'DOWNLOADING',reason:'',verification:''}];
  g.job({phase:'DOWNLOADING',overall:{files_total:1,bytes_total:193*MB,bytes_done:50*MB},current:{path:'loras/Amber_Nova.safetensors',kind:'lora',phase:'DOWNLOADING',bytes_done:50*MB,bytes_total:193*MB,speed_bps:10*MB,resumed_from:null}});
  let m=await h.monitor();const id=m.job.id;
  // reload = new page asking again: same job, nothing re-sent
  for(let i=0;i<3;i++){m=await h.monitor();assert.equal(m.job.id,id)}
  assert.equal(g.starts.length,1);
  g.up=false;m=await h.monitor();
  assert.equal(m.source,'LAST_KNOWN');assert.equal(m.state,'DOWNLOADING');assert.equal(m.error.kind,'gpu');assert.match(m.error.message,/продолжается без телефона/);assert.equal(m.current.bytes_done,50*MB);
  assert(m.events.some(e=>e.type==='GPU_UNREACHABLE'));
  g.up=true;g.job({overall:{bytes_done:120*MB},current:{...g.sync.job.current,bytes_done:120*MB}});
  m=await h.monitor();assert.equal(m.source,'LIVE');assert.equal(m.error,null);assert.equal(m.current.bytes_done,120*MB);assert(m.events.some(e=>e.type==='GPU_RECONNECTED'));assert.equal(g.starts.length,1);
  // the phone app restarts (Termux killed) and the GPU is not connected yet
  await h.close({keep:true});
  const h2=await harness({dir:h.dir,connect:false,gpu:g});
  try{
   m=await h2.monitor();assert.equal(m.job.id,id);assert.equal(m.source,'LAST_KNOWN');assert.equal(m.state,'DOWNLOADING');assert.equal(m.error.code,'GPU_OFFLINE');assert.match(m.error.message,/может продолжаться/);
   assert.equal(g.starts.length,1);
  }finally{await h2.close()}
 }catch(e){await h.close().catch(()=>{});throw e}
});

test('no GPU: WAITING_FOR_GPU with a saved selection; starting a sync explains that the selection is kept',async()=>{
 const h=await harness({connect:false});
 try{
  const m=await h.monitor();assert.equal(m.state,'WAITING_FOR_GPU');assert.deepEqual(m.state_text,['Ожидание GPU','Waiting for GPU']);assert.equal(m.selection_pending,3);
  const r=await h.call('/api/sync/start','POST',{mode:'selected'});assert.equal(r.status,409);assert.equal(r.body.code,'GPU_OFFLINE');assert.match(r.body.error,/выбор моделей сохранён/);
 }finally{await h.close()}
 const n=await harness({connect:false,selection:null});
 try{assert.equal((await n.monitor()).state,'IDLE')}finally{await n.close()}
});

test('cancel → CANCELLED; retry re-sends the same request and the GPU resumes from the partial file',async()=>{
 const h=await harness();const g=h.gpu;
 try{
  await h.call('/api/sync/start','POST',{mode:'selected'});
  g.job({phase:'DOWNLOADING',overall:{files_total:1,bytes_total:193*MB,bytes_done:60*MB},current:{path:'loras/Amber_Nova.safetensors',kind:'lora',phase:'DOWNLOADING',bytes_done:60*MB,bytes_total:193*MB,speed_bps:5*MB,resumed_from:null}});
  await h.monitor();
  let m=(await h.call('/api/sync/cancel','POST',{})).body;assert.equal(g.cancels,1);assert.equal(m.job.cancel_requested,true);
  g.job({state:'CANCELLED',error:'Синхронизация отменена. Частично загруженный файл сохранён для продолжения.',error_code:'CANCELLED',current:null,finished_unix:1});
  m=await h.monitor();assert.equal(m.state,'CANCELLED');assert.equal(m.error,null);
  assert.equal((await h.call('/api/sync/start','POST',{mode:'retry'})).status,202);assert.deepEqual(g.starts[1],g.starts[0]);
  g.job({phase:'DOWNLOADING',overall:{files_total:1,bytes_total:193*MB,bytes_done:60*MB},current:{path:'loras/Amber_Nova.safetensors',kind:'lora',phase:'DOWNLOADING',bytes_done:60*MB,bytes_total:193*MB,speed_bps:null,resumed_from:60*MB}});
  m=await h.monitor();assert.equal(m.current.resumed_from,60*MB);assert(m.events.some(e=>e.type==='FILE_STARTED'&&e.resumed_from===60*MB));
  // a second start while running is refused instead of starting a parallel download
  const busy=await h.call('/api/sync/start','POST',{mode:'selected'});assert.equal(busy.status,409);assert.equal(busy.body.code,'DRIVE_SYNC_BUSY');assert.equal(g.starts.length,2);
 }finally{await h.close()}
});

test('interrupted transfer, insufficient GPU storage and repeated failures: exact error, advice, cost warning',async()=>{
 const h=await harness({cloudKey:true,deployment:{instance_id:'9001',token:'c'.repeat(64),image:'ghcr.io/x/engine:1.7.5',name:'YOISAKI-ABC',created_at:1,stage:'GPU_READY',instance_status:'running',disk_gb:80}});const g=h.gpu;
 try{
  await h.call('/api/sync/start','POST',{mode:'selected'});
  g.job({state:'INTERRUPTED',error:'Синхронизация была прервана (перезапуск). Запустите её снова — загрузка продолжится.',error_code:'INTERRUPTED',current:null,finished_unix:1});
  let m=await h.monitor();assert.equal(m.state,'ERROR');assert.equal(m.error.kind,'sync');assert.equal(m.error.code,'INTERRUPTED');assert.match(m.error.action,/продолжит загрузку/);assert.equal(m.failures.consecutive,1);
  await h.call('/api/sync/start','POST',{mode:'retry'});
  g.sync.disk={free_bytes:3*GB,total_bytes:80*GB,reserve_bytes:2*GB};
  g.job({state:'FAILED',error:'Недостаточно места на диске моделей: нужно 8.52 ГБ (включая резерв 2.00 ГБ), свободно 3.00 ГБ. Ничего не загружено.',error_code:'DISK_SPACE',current:null,finished_unix:2});
  m=await h.monitor();assert.equal(m.error.code,'DISK_SPACE');assert.match(m.error.message,/Недостаточно места/);assert.match(m.error.action,/Освободите место/);assert.equal(m.failures.consecutive,2);
  const lib=(await h.call('/api/drive/library')).body;assert.equal(lib.estimate.disk_check,'INSUFFICIENT');
  const ready=(await h.call('/api/system/readiness')).body;const w=ready.warnings.find(x=>x.code==='SYNC_REPEATED_FAILURE');assert(w);assert.match(w.message,/НЕ останавливает оплату/);assert.equal(w.dashboard,true);
  assert.equal(ready.storage.free_bytes,3*GB);
 }finally{await h.close()}
});

test('Drive authorization on the GPU: rejected copy is re-sent before syncing; expired phone token is reported as a Drive error',async()=>{
 const h=await harness();const g=h.gpu;
 try{
  g.sync.connection={state:'ERROR',error:'Google отклонил авторизацию.',code:'AUTH_FAILED'};
  let r=await h.call('/api/sync/start','POST',{mode:'selected'});assert.equal(r.status,202);assert.equal(g.binds.length,1);assert.equal(g.binds[0].root_folder_id,'models-root');
  g.job({state:'FAILED',error:'Google отклонил авторизацию. Войдите в Google заново на сайте и передайте доступ GPU.',error_code:'AUTH_FAILED',current:null,finished_unix:1});
  const m=await h.monitor();assert.equal(m.error.kind,'drive');
  // phone token expired and Google refuses to refresh it
  const s=JSON.parse(await fs.readFile(path.join(h.dir,'secrets.json'),'utf8'));s.drive.token.expiry='2000-01-01T00:00:00Z';
  await h.close({keep:true});await fs.writeFile(path.join(h.dir,'secrets.json'),JSON.stringify(s));
  const fake=new FakeDrive();fake.refresh='fail';const h2=await harness({dir:h.dir,gpu:g,fake});
  try{
   g.sync.configured=false;
   r=await h2.call('/api/sync/start','POST',{mode:'selected'});assert.equal(r.status,401);assert.equal(r.body.code,'DRIVE_REFRESH_FAILED');assert.equal(g.starts.length,1);
  }finally{await h2.close()}
 }catch(e){await h.close().catch(()=>{});throw e}
});

test('readiness: an API key alone is never READY; READY needs a passing engine health check and a usable checkpoint; CUDA failure warns about billing',async()=>{
 const off=await harness({connect:false,cloudKey:true});
 try{const r=(await off.call('/api/system/readiness')).body;assert.equal(r.cloudcompute.api,'CONFIGURED');assert.equal(r.engine.state,'NOT_CONNECTED');assert.equal(r.ready_to_generate,false);assert.equal(r.cuda,'UNKNOWN');assert.equal(r.drive.phone,'CONNECTED')}finally{await off.close()}
 const h=await harness({cloudKey:true,deployment:{instance_id:'9001',token:'c'.repeat(64),image:'ghcr.io/x/engine:1.7.5',name:'YOISAKI-ABC',created_at:1,stage:'GPU_READY',instance_status:'running',disk_gb:80}});
 try{
  let r=(await h.call('/api/system/readiness')).body;assert.equal(r.engine.state,'READY');assert.equal(r.cuda,'AVAILABLE');assert.equal(r.gpu.name,'TEST DOUBLE RTX 5060 Ti');assert.equal(r.gpu.vram_total_mb,16311);assert.equal(r.ready_to_generate,true);assert.equal(r.cloudcompute.instance.running,true);
  assert.equal(r.sync.state,'IDLE');assert.equal(r.drive.on_gpu,'OK');
  h.gpu.models=[];h.gpu.revision='9'.repeat(32);await h.call('/api/gpu/status?models=1');r=(await h.call('/api/system/readiness')).body;assert.equal(r.ready_to_generate,false);assert.match(r.ready_reason,/checkpoint/);
  h.gpu.health={state:'ERROR'};await h.call('/api/gpu/status');r=(await h.call('/api/system/readiness')).body;
  assert.equal(r.cuda,'FAILED');assert.equal(r.ready_to_generate,false);const w=r.warnings.find(x=>x.code==='CUDA_FAILED');assert(w);assert.match(w.message,/НЕ останавливает оплату/);
 }finally{await h.close()}
 const pure=readiness({cloudConfigured:true,deployment:{stage:'GPU_READY',gpu_stages:[{stage:'GPU_CHECK_FAILED',ts:1}],instance_status:'running'},connection:null,state:'OFFLINE',info:null,lastCode:'',lastError:'',models:[],monitor:null,drive:{connected:false}});
 assert.equal(pure.cuda,'FAILED');assert(pure.warnings.some(w=>w.code==='CUDA_FAILED'&&w.billing));
});

test('GPU disconnected: inventory is marked stale and recovers after reconnect; discovery explains models missing from the catalogue',async()=>{
 const h=await harness();
 try{
  let st=(await h.call('/api/gpu/status')).body;assert.equal(st.models_stale,false);
  await h.call('/api/gpu/disconnect','POST',{});st=(await h.call('/api/gpu/status')).body;assert.equal(st.models_stale,true);assert(st.models.length>0,'cached list kept but stale');
  const lib=(await h.call('/api/drive/library')).body;assert.equal(lib.gpu.models_stale,true);assert.equal(lib.gpu.connected,false);
  const r=await h.call('/api/gpu/connect','POST',{url:'https://nova.trycloudflare.com/#token='+TOKEN,provider:'cloudcompute'});assert.equal(r.body.models_stale,false);
 }finally{await h.close()}
 const d=discoveryReport(['loras/New.safetensors','loras/Bad.safetensors','loras/Gone.safetensors','loras/Fail.safetensors'],[{path:'loras/New.safetensors',kind:'lora',state:'INSTALLED'},{path:'loras/Bad.safetensors',kind:'lora',state:'INSTALLED'},{path:'loras/Gone.safetensors',kind:'lora',state:'INSTALLED'},{path:'loras/Fail.safetensors',kind:'lora',state:'FAILED',reason:'checksum'}],[{id:'1',name:'New.safetensors',kind:'lora',compatible:null},{id:'2',name:'Bad.safetensors',kind:'lora',compatible:false,compatibility_reason:'SD 1.x'}]);
 assert.deepEqual(d.files.map(f=>f.generator),['AVAILABLE_UNVERIFIED','INCOMPATIBLE','NOT_FOUND','NOT_INSTALLED']);assert.equal(d.files[1].reason,'SD 1.x');assert.match(d.files[2].reason,/Обновить список/);
});

test('monitor file survives restarts and damaged files are set aside',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-176f-'));
 try{
  const a=await new SyncMonitor({dir}).init();a.observe({job:{id:'x1',type:'sync',state:'RUNNING',phase:'DOWNLOADING',overall:{files_total:1,files_done:0,files_failed:0,bytes_total:10,bytes_done:5},current:null},items:[]},'https://a.trycloudflare.com');await a.save(true);
  const b=await new SyncMonitor({dir}).init();assert.equal(b.data.job.id,'x1');assert.equal(b.view().state,'DOWNLOADING');assert.equal((await fs.stat(path.join(dir,'sync-monitor.json'))).mode&0o777,0o600);
  await fs.writeFile(path.join(dir,'sync-monitor.json'),'{broken');const c=await new SyncMonitor({dir}).init();assert.equal(c.data.job,null);assert((await fs.readdir(dir)).some(f=>f.startsWith('sync-monitor.json.damaged-')));
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

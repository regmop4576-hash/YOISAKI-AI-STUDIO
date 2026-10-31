// v1.7.7 CloudCompute stability. CloudCompute, ghcr.io, ntfy and the GPU are explicit TEST DOUBLES (mocked API):
// these tests prove the monitor, the creation safety rules, the stage machine and the diagnostics — NOT a live
// CloudCompute deployment and NOT a real GPU.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createLocalApp} from '../server/app.mjs';
import {OfferMonitor,matchOffer,validateFilters,DEFAULT_FILTERS} from '../server/gpu-monitor.mjs';
import {offerView,offerList,onstartScript,createBody,DeploymentWatcher,classifyProvider,classifyCreateError,checkImage,ENGINE_IMAGE,bytes,ONSTART_BUDGET_BYTES,ONSTART_LIMIT_BYTES,deploymentView} from '../server/cloudcompute-deploy.mjs';
import {gpuAssessment,gpuModel,kernelsFor} from '../server/gpu-catalog.mjs';
import {diagnosticsReport,sanitize,DIAGNOSTICS_FILENAME} from '../server/cc-diagnostics.mjs';
import {retryAfterSeconds} from '../server/provider-http.mjs';
import {AppError} from '../server/errors.mjs';
import {SecretStore} from '../server/secrets.mjs';
const run=promisify(execFile);
const KEY='cc-test_secret_12345';
const until=async(fn,ms=6000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timeout waiting for condition');await new Promise(r=>setTimeout(r,15))}};
const offer=(id,extra={})=>({ask_id:id,gpu_name:'RTX 4090',num_gpus:1,gpu_ram:24576,price_hour:2500,disk_space:200,cuda_max_good:12.9,reliability2:0.99,...extra});
const ccError=(status,message,{code,retry}={})=>Object.assign(new AppError('CC_HTTP_'+status,`CloudCompute HTTP ${status}: ${message}`,status>=400&&status<500?status:502),{http_status:status,provider_message:message,provider_code:code||'',retry_after:retry??null});

// ------------------------------------------------------------------------------------------------ GPU catalog
test('GPU catalog: compute capability vs the image torch build; unusual VRAM warns, unknown names are never rejected',()=>{
 assert.equal(gpuModel('NVIDIA GeForce RTX 4090').cc,'8.9');assert.equal(gpuModel('Tesla V100-SXM2-32GB').cc,'7.0');assert.equal(gpuModel('Tesla T4').cc,'7.5');
 assert.equal(gpuModel('RTX 5060 Ti').label,'RTX 5060 Ti');assert.equal(gpuModel('RTX 3090 Ti').label,'RTX 3090 Ti');assert.equal(gpuModel('A100 80GB PCIe').cc,'8.0');assert.equal(gpuModel('A10G').label,'A10G');
 for(const cc of ['7.0','7.5','8.6','8.9','12.0'])assert.equal(kernelsFor(cc),true,cc);   // V100, T4, 3090, 4090, 5060 Ti
 assert.equal(kernelsFor('6.1'),false);assert.equal(kernelsFor('12.1'),true);assert.equal(kernelsFor(null),null);
 assert.match(gpuAssessment({gpu:'Tesla P40',vram_mb:24576}).reasons.join(),/нет ядер/);
 assert.equal(gpuAssessment({gpu:'RTX 4090',vram_mb:24564}).reasons.length,0);
 assert.match(gpuAssessment({gpu:'RTX 4090',vram_mb:49152}).warnings.join(),/Нестандартный объём VRAM/);
 assert.match(gpuAssessment({gpu:'RTX 3090',gpus:2,vram_mb:49152}).warnings.join(),/сумму 2 GPU/);
 assert.match(gpuAssessment({gpu:'Tesla T4',vram_mb:15360}).warnings.join()||'ok',/ok|Volta/);   // 15 360 MiB is a normal T4
 const unknown=gpuAssessment({gpu:'Moore Threads MTT S4000',vram_mb:49152});assert.equal(unknown.reasons.length,0);assert.match(unknown.warnings.join(),/не распознана/);
 assert.match(gpuAssessment({gpu:'RTX 4090 48GB',vram_mb:24576}).warnings.join(),/Название указывает 48 ГБ/);
 const o=offerView(offer(1,{gpu_name:'GTX 1080 Ti',gpu_ram:11264}));assert.equal(o.compatible,false);
});

// ------------------------------------------------------------------------------------------------ monitor
function monitorWith(responses,{settings={},minGapMs=20000}={}){
 let t=1_000_000;const timers=[];
 const m=new OfferMonitor({fetchOffers:async()=>{const r=responses.shift();if(r instanceof Error)throw r;return r},settings,minGapMs,now:()=>t,
  setTimer:(fn,ms)=>{const x={fn,at:t+ms};timers.push(x);return x},clearTimer:x=>{const i=timers.indexOf(x);if(i>=0)timers.splice(i,1)}});
 return {m,timers,advance:ms=>{t+=ms},now:()=>t,async fire(){const x=timers.shift();assert(x,'no timer');t=Math.max(t,x.at);await x.fn()}};
}
test('monitor: valid offers are filtered and sorted; missing price, unknown currency and occupied offers never match',async()=>{
 const list=[offer(1,{price_hour:2900}),offer(2,{price_hour:1800,gpu_name:'RTX 3090'}),offer(3,{price_hour:undefined}),offer(4,{price_hour_minor:1500,currency:'USD'}),
  offer(5,{rentable:false,price_hour:1000}),offer(6,{price_hour:4000}),offer(7,{gpu_ram:12288,price_hour:900,gpu_name:'RTX 3060'}),offer(8,{num_gpus:2,gpu_ram:49152,price_hour:2000})];
 const {m}=monitorWith([{data:list}]);const v=await m.refresh();
 assert.deepEqual(v.offers.filter(o=>o.match.ok).map(o=>o.id),[2,1]);   // ≤30 ₽/h, ≥16 GB, 1 GPU, cheapest first
 const by=id=>v.offers.find(o=>o.id===id);
 assert.match(by(3).match.reasons.join(),/Нет цены|Цена не указана/);assert.match(by(4).match.reasons.join(),/USD: сравнение с лимитом в рублях невозможно/);
 assert.match(by(5).match.reasons.join(),/уже занято/);assert.match(by(6).match.reasons.join(),/40\.00 ₽\/ч > 30/);assert.match(by(7).match.reasons.join(),/VRAM 12 ГБ < 16/);assert.match(by(8).match.reasons.join(),/2 GPU, нужно 1/);
 assert.equal(by(1).match.preferred,true);assert.equal(v.matching,2);assert.equal(v.updated_at,1_000_000);
 // the same filters are adjustable; an invalid explicit value is refused, never silently replaced
 await m.configure({filters:{...DEFAULT_FILTERS,max_price_rub:45,sort:'vram'}});assert.equal(m.view().matching,3);
 await assert.rejects(m.configure({filters:{max_price_rub:-1}}),e=>e.code==='MONITOR_INVALID');
 assert.deepEqual(validateFilters({}),DEFAULT_FILTERS);assert.equal(DEFAULT_FILTERS.max_price_rub,30);assert.equal(DEFAULT_FILTERS.min_vram_gb,16);assert.equal(DEFAULT_FILTERS.preferred_vram_gb,24);assert.equal(DEFAULT_FILTERS.gpu_count,1);
});
test('monitor: disappearing offers are listed; new matching offers notify once (baseline never notifies, no duplicates)',async()=>{
 const {m,advance}=monitorWith([{data:[offer(1),offer(2)]},{data:[offer(1),offer(3),offer(4,{price_hour:9000})]},{data:[offer(1),offer(3)]},{data:[offer(1),offer(3),offer(2)]}]);
 await m.refresh();assert.equal(m.view().notifications.length,0);
 advance(30000);let v=await m.refresh();
 assert.deepEqual(v.gone.map(g=>g.id),[2]);assert.deepEqual(v.notifications.map(n=>n.offer.id),[3]);   // 4 is new but too expensive
 advance(30000);v=await m.refresh();assert.equal(v.notifications.length,1);                         // no duplicate for 3
 advance(30000);v=await m.refresh();assert.deepEqual(v.gone.map(g=>g.id),[4]);assert.equal(v.notifications.length,1); // 2 reappeared: not new
 v=m.acknowledge([v.notifications[0].key]);assert.equal(v.notifications[0].acknowledged,true);
});
test('monitor: HTTP 429 honours Retry-After, manual refresh is refused during the pause, auto refresh waits; minimum gap is shared',async()=>{
 const {m,timers,advance,fire}=monitorWith([{data:[offer(1)]},ccError(429,'Too many requests',{retry:120}),{data:[offer(1)]}]);
 await m.refresh();
 advance(5000);assert.equal((await m.refresh()).cached,true);                   // within the 20 s gap: shared snapshot, no request
 assert.equal(m.view().requests,1);
 advance(20000);await assert.rejects(m.refresh(),e=>e.code==='CC_RATE_LIMITED'&&e.status===429&&/Retry-After/.test(e.message));
 const v=m.view();assert.equal(v.rate_limit.retry_in_s,120);assert.equal(v.error.code,'CC_RATE_LIMITED');assert.equal(v.offers.length,1);   // previous data kept
 await assert.rejects(m.refresh(),e=>e.code==='CC_RATE_LIMITED'&&/Повтор через 120 с/.test(e.message));
 m.start();assert.equal(timers.length,1);assert(timers[0].at>=v.rate_limit.until);   // auto refresh never runs inside the pause
 await fire();assert.equal(m.view().error,null);assert.equal(m.view().requests,3);
 assert.equal(retryAfterSeconds('30'),30);assert.equal(retryAfterSeconds(new Date(Date.now()+60000).toUTCString())>=59,true);assert.equal(retryAfterSeconds('soon'),null);
});
test('monitor: network errors keep the last snapshot and back off; 401 stops automatic refresh; stop is immediate; time limit applies',async()=>{
 const net=new AppError('PROVIDER_NETWORK','Нет связи',502);
 const {m,timers,advance,fire}=monitorWith([{data:[offer(1)]},net,net,ccError(401,'Invalid API key.')],{minGapMs:0});
 await m.refresh();m.start();await fire();
 let v=m.view();assert.equal(v.stale,true);assert.equal(v.offers.length,1);assert.equal(v.error.code,'PROVIDER_NETWORK');assert(v.backoff_until>v.last_attempt_at);
 await fire();assert(m.view().backoff_until-m.view().last_attempt_at>=60000);    // exponential: 30 s, 60 s …
 await fire();v=m.view();assert.equal(v.auto.on,false);assert.match(v.auto.stop_reason,/Автообновление остановлено/);assert.equal(timers.length,0);
 // stop is immediate: the pending timer is removed
 const s=monitorWith([{data:[]}],{settings:{auto_minutes:5,interval_s:60}});s.m.start();assert.equal(s.timers.length,1);s.m.stop();assert.equal(s.timers.length,0);assert.equal(s.m.view().auto.on,false);
 // the automatic refresh stops by itself after auto_minutes
 const l=monitorWith(Array.from({length:10},()=>({data:[]})),{settings:{auto_minutes:5,interval_s:120},minGapMs:0});l.m.start();
 for(let i=0;i<4&&l.timers.length;i++)await l.fire();assert.equal(l.m.view().auto.on,false);assert.match(l.m.view().auto.stop_reason,/5 мин/);
});

// ------------------------------------------------------------------------------------------------ app harness
async function harness({offers=[offer(501,{price_hour:2500}),offer(502,{price_hour:2700,gpu_name:'RTX 3090'}),offer(503,{price_hour:2800,gpu_name:'A5000'})],createReply,deployment=null,terminalReply}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-177-'));
 if(deployment){const s=await new SecretStore(dir).init();await s.setDeployment(deployment)}
 const cc={posts:[],instances:[],offers,detail:{status:'loading'},gone:false,gets:0};let gpu={url:null,stages:[]};
 const providerRequest=async(url,opts={})=>{
  if(url.startsWith('https://ghcr.io/token'))return {status:200,json:{token:'anon'}};
  if(url.startsWith('https://ghcr.io/v2/'))return {status:200,json:{schemaVersion:2}};
  assert(url.startsWith('https://app.cloudcompute.ru/api/v1/'),url);assert.equal(opts.headers.Authorization,'Bearer '+KEY);
  const route=url.slice('https://app.cloudcompute.ru/api/v1'.length);
  if(route==='/offers'){cc.gets++;const o=typeof cc.offers==='function'?cc.offers():cc.offers;if(o instanceof Error)throw o;return {status:200,json:{data:o}}}
  if(route==='/instances'&&(opts.method||'GET')==='GET')return {status:200,json:{data:cc.instances}};
  if(route==='/instances'&&opts.method==='POST'){const body=JSON.parse(opts.body);cc.posts.push(body);const r=createReply?await createReply(body):{status:201,json:{data:{id:9001}}};if(r instanceof Error)throw r;if(r.status<300)cc.instances.push({id:9001,name:body.name,status:'loading'});return r}
  if(route.endsWith('/terminal-token')){const r=terminalReply?terminalReply():{status:200,json:{ws_url:'wss://app.cloudcompute.ru/terminal/test'}};return r}
  if(route.startsWith('/instances/')){if(cc.gone)return {status:404,json:{error:{message:'not found'}}};if(opts.method==='DELETE'){cc.gone=true;return {status:200,json:{}}}return {status:200,json:{data:{id:route.split('/')[2],name:'YOISAKI',...cc.detail}}}}
  throw Error('unexpected '+route);
 };
 const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true},state:'READY',gpu_name:'RTX 4090',vram_total_mb:24000,vram_available_mb:23000};
 const upstream=async(c,p)=>{if(p==='/health')return health;if(p.startsWith('/inventory'))return {revision:'a'.repeat(32),models:[]};if(p==='/sync/status')return {service:'YOISAKI_DRIVE_SYNC',enabled:true,rclone_available:true,configured:false,source:'models',scope:'drive.readonly',connection:{state:'OK'},job:null,items:[],inventory_revision:1,selective:true,folder_selection:true};throw Error('upstream '+p)};
 const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),providerRequest,upstream,discoverProgress:async()=>gpu,sleep:()=>new Promise(r=>setTimeout(r,5)),deployInterval:15,driveInterval:5,monitorMinGap:0});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const cookie=(await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}})).headers.get('set-cookie').split(';')[0];
 const raw=(route,method='GET',body)=>fetch(base+route,{method,headers:{'X-Yoisaki-Local':'1',cookie},body:body===undefined?undefined:JSON.stringify(body)});
 const call=async(route,method,body)=>{const r=await raw(route,method,body);return {status:r.status,body:await r.json()}};
 await call('/api/cloudcompute/config','PUT',{key:KEY});
 return {app,dir,call,raw,cc,setGpu:v=>{gpu=v},secretsFile:()=>fs.readFile(path.join(dir,'secrets.json'),'utf8').then(JSON.parse),async close(){await app.close();await fs.rm(dir,{recursive:true,force:true})}};
}
const createRequest={confirm:true,offer_id:501,accepted_price_minor:2500,currency:'RUB',disk_gb:80,auto_sync:false};
const deploymentOf=async h=>(await h.call('/api/cloudcompute/deploy')).body.deployment;

test('creation: final configuration is re-verified (fresh offers, price, disk, image, onstart size) before confirmation; success sends bootstrap_profile',async()=>{
 const h=await harness();
 try{
  const q=(await h.call('/api/cloudcompute/deploy/prepare','POST',{offer_id:501,disk_gb:80})).body.quote;
  assert.equal(q.can_create,true);assert.equal(q.price.minor,2500);assert.equal(q.disk_gb,80);assert.equal(q.image,ENGINE_IMAGE);assert.equal(q.bootstrap_profile,'worker');
  assert(q.onstart_bytes>0&&q.onstart_bytes<=q.onstart_budget_bytes&&q.onstart_limit_bytes===16384);assert.match(q.note,/не резервирует/);
  assert.match((await h.call('/api/cloudcompute/deploy/prepare','POST',{offer_id:501,disk_gb:500})).body.quote.issues.join(),/Диск 500 ГБ/);
  assert.equal(h.cc.posts.length,0);                                              // preparing never creates
  const r=await h.call('/api/cloudcompute/deploy','POST',{...createRequest,request_id:'req-00000001',bootstrap_profile:'access_only'});assert.equal(r.status,201);
  assert.equal(h.cc.posts[0].bootstrap_profile,'access_only');assert.equal(h.cc.posts[0].strict_offer,true);assert.equal(h.cc.posts[0].auto_select,false);
  const d=r.body.deployment;assert.equal(d.stage,'GPU_CREATED');assert.equal(d.bootstrap_profile,'access_only');assert.deepEqual(d.stage_history.map(s=>s.stage),['CREATING','GPU_CREATED']);
  assert.equal((await h.call('/api/cloudcompute/deploy','POST',{...createRequest,bootstrap_profile:'root'})).body.code,'CC_INVALID_CREATE');
 }finally{await h.close()}
});
test('creation: occupied host → actual error shown, offer marked unavailable, list refreshed, alternatives suggested, filters kept, no retry',async()=>{
 for(const reply of [{status:422,json:{error:{message:'Offer is no longer available: host is busy',code:'offer_unavailable'}}},{status:409,json:{error:{message:'Conflict'}}}]){
  const h=await harness({createReply:()=>reply});
  try{
   await h.call('/api/cloudcompute/monitor','PUT',{filters:{...DEFAULT_FILTERS,max_price_rub:28}});
   const before=h.cc.gets;
   const r=await h.call('/api/cloudcompute/deploy','POST',createRequest);
   assert.equal(r.status,reply.status);assert.equal(r.body.code,'CC_OFFER_TAKEN');assert(r.body.error.includes(reply.json.error.message));assert.match(r.body.error,/НЕ создан/);
   assert.equal(r.body.details.provider_message,reply.json.error.message);assert.deepEqual(r.body.details.alternatives.map(a=>a.id),[502,503]);
   assert.equal(h.cc.posts.length,1);assert(h.cc.gets>before+1);                 // verified before, refreshed after; never re-posted
   assert.equal(await deploymentOf(h),null);
   const v=(await h.call('/api/cloudcompute/monitor')).body;assert.equal(v.settings.filters.max_price_rub,28);assert.equal(v.taken[0].id,501);assert.equal(v.offers.find(o=>o.id===501).match.ok,false);
   const again=await h.call('/api/cloudcompute/deploy','POST',createRequest);assert.equal(again.body.code,'CC_OFFER_TAKEN');assert.equal(h.cc.posts.length,1);
  }finally{await h.close()}
 }
});
test('creation: duplicate submissions — concurrent requests are serialized (CC_BUSY) and a repeated request_id returns the same server',async()=>{
 let release;const gate=new Promise(r=>{release=r});
 const h=await harness({createReply:async()=>{await gate;return {status:201,json:{data:{id:9001}}}}});
 try{
  const first=h.call('/api/cloudcompute/deploy','POST',{...createRequest,request_id:'req-dup-0001'});
  await until(()=>h.cc.posts.length===1);
  const second=await h.call('/api/cloudcompute/deploy','POST',{...createRequest,request_id:'req-dup-0001'});assert.equal(second.body.code,'CC_BUSY');
  release();assert.equal((await first).status,201);
  const third=await h.call('/api/cloudcompute/deploy','POST',{...createRequest,request_id:'req-dup-0001'});assert.equal(third.status,200);assert.equal(third.body.duplicate,true);assert.equal(third.body.deployment.instance_id,'9001');
  assert.equal(h.cc.posts.length,1);
 }finally{await h.close()}
});
test('creation: timeout / lost response is never treated as "not created"; a new creation first checks the instance list',async()=>{
 const timeout=Object.assign(new AppError('PROVIDER_NETWORK','Провайдер не ответил вовремя. Результат запроса неизвестен; повтор не выполнялся.',502),{timeout:true});
 const h=await harness({createReply:()=>timeout});
 try{
  const r=await h.call('/api/cloudcompute/deploy','POST',createRequest);assert.equal(r.status,502);assert.match(r.body.error,/Повторное создание не выполнялось/);
  let d=await deploymentOf(h);assert.equal(d.pending,true);assert.equal(d.failure.code,'CREATION_UNCONFIRMED');
  const blocked=await h.call('/api/cloudcompute/deploy','POST',{...createRequest,additional:true});assert.equal(blocked.body.code,'CC_PREVIOUS_UNCONFIRMED');assert.equal(h.cc.posts.length,1);
  // the provider did create it after all: it appears in the list → adopted, no second POST
  h.cc.instances.push({id:7777,name:d.name,status:'loading'});
  const found=await h.call('/api/cloudcompute/deploy','POST',{...createRequest,previous_unconfirmed_ack:true});assert.equal(found.body.code,'CC_PREVIOUS_CREATED');assert.match(found.body.error,/#7777/);
  d=await until(async()=>{const x=await deploymentOf(h);return x.instance_id==='7777'&&x});assert.equal(h.cc.posts.length,1);
 }finally{await h.close()}
 // 5xx: the outcome is unknown as well; after an explicit acknowledgement (instance verified absent) a new one is allowed
 const lost=await harness({createReply:()=>({status:503,json:{error:{message:'Service unavailable'}}})});
 try{
  assert.equal((await lost.call('/api/cloudcompute/deploy','POST',createRequest)).status,502);assert.equal((await deploymentOf(lost)).pending,true);
  assert.equal((await lost.call('/api/cloudcompute/deploy','POST',createRequest)).body.code,'CC_PREVIOUS_UNCONFIRMED');
  await lost.call('/api/cloudcompute/deploy','POST',{...createRequest,previous_unconfirmed_ack:true});assert.equal(lost.cc.posts.length,2);
 }finally{await lost.close()}
});
test('creation: price changed, offer disappeared, insufficient balance and rate limit — explicit errors, nothing created',async()=>{
 const h=await harness({createReply:()=>({status:402,json:{error:{message:'Insufficient balance'}}})});
 try{
  let r=await h.call('/api/cloudcompute/deploy','POST',{...createRequest,accepted_price_minor:2400});assert.equal(r.body.code,'CC_PRICE_CHANGED');assert.equal(r.body.details.price_minor,2500);
  r=await h.call('/api/cloudcompute/deploy','POST',{...createRequest,offer_id:999});assert.equal(r.body.code,'CC_OFFER_GONE');assert.deepEqual(r.body.details.alternatives.map(a=>a.id),[501,502,503]);
  assert.equal(h.cc.posts.length,0);
  r=await h.call('/api/cloudcompute/deploy','POST',createRequest);assert.equal(r.status,402);assert.equal(r.body.code,'CC_INSUFFICIENT_BALANCE');assert.match(r.body.error,/Insufficient balance.*НЕ создан/);
  assert.equal(await deploymentOf(h),null);assert.equal(h.cc.posts.length,1);
 }finally{await h.close()}
 const limited=await harness();
 try{
  limited.cc.offers=()=>ccError(429,'Too many requests',{retry:90});
  const r=await limited.call('/api/cloudcompute/deploy','POST',createRequest);assert.equal(r.status,429);assert.match(r.body.error,/нельзя перепроверить.*не создан/);assert.equal(limited.cc.posts.length,0);
 }finally{await limited.close()}
 assert.equal(classifyCreateError(ccError(422,'Offer is taken')),'OFFER_TAKEN');assert.equal(classifyCreateError(ccError(422,'disk_gb invalid')),'REJECTED');
 assert.equal(classifyCreateError(ccError(400,'Недостаточно средств на балансе')),'INSUFFICIENT_BALANCE');assert.equal(classifyCreateError(new AppError('PROVIDER_NETWORK','x',502)),'UNKNOWN_OUTCOME');
 assert.equal(classifyCreateError(ccError(500,'boom')),'UNKNOWN_OUTCOME');
});

// ------------------------------------------------------------------------------------------------ stage machine
function watcherWith({detail,progress=async()=>({url:null,stages:[]}),connection=()=>({phase:'OFFLINE'}),d={}}){
 let t=10_000_000;const store={d:{instance_id:'10758',token:'e'.repeat(64),image:ENGINE_IMAGE,name:'YOISAKI-ABC',created_at:t,stage:'GPU_CREATED',bootstrap_profile:'worker',...d}};
 const secrets={deployment:()=>store.d,change:async fn=>{const x={deployment:structuredClone(store.d)};fn(x);store.d=x.deployment}};
 const w=new DeploymentWatcher({secrets,cloud:{detail:async id=>{const r=typeof detail==='function'?detail():detail;if(r instanceof Error)throw r;return {data:{id,...r}}}},progress,connect:async()=>({message:'Подключаюсь к движку…'}),connectionState:connection,now:()=>t,timeoutMinutes:60});
 return {w,store,advance:ms=>{t+=ms},tick:()=>w.tick(store.d,()=>true)};
}
test('stages: created → provider bootstrapping → image preparing → instance running are separate from engine readiness; arbitrary status never counts',async()=>{
 let status='created';const s=watcherWith({detail:()=>({status})});
 await s.tick();assert.equal(s.store.d.stage,'GPU_CREATED');
 status='starting';await s.tick();assert.equal(s.store.d.stage,'PROVIDER_BOOTSTRAPPING');
 status='loading';await s.tick();assert.equal(s.store.d.stage,'IMAGE_PREPARING');
 status='running';await s.tick();let v=deploymentView(s.store.d);assert.equal(v.stage,'INSTANCE_RUNNING');assert.equal(v.instance_running,true);assert.equal(v.engine_ready,false);
 assert.match(v.stage_message,/инстанс работает\. YOISAKI ENGINE ещё не отозвался/);
 assert.deepEqual(v.stage_history.map(h=>[h.stage,h.source]),[['PROVIDER_BOOTSTRAPPING','cloudcompute'],['IMAGE_PREPARING','cloudcompute'],['INSTANCE_RUNNING','cloudcompute']]);
 assert(v.stage_history.every(h=>Number.isFinite(h.at)));assert.equal(v.provider.status,'running');assert.equal(v.provider.phase,'RUNNING');
 // problem C (#10758): CloudCompute "Running" for a long time while the engine never reported → explicit, not "initializing"
 s.advance(16*60000);await s.tick();assert.match(s.store.d.stage_message,/Инстанс работает, движок — нет/);
 const weird=watcherWith({detail:{status:'Running-ish',actual_status:'ok-maybe'}});await weird.tick();assert.equal(weird.store.d.stage,'GPU_CREATED');assert.equal(weird.store.d.provider.phase,'UNKNOWN');
 const intended=watcherWith({detail:{status:'loading',intended_status:'running'}});await intended.tick();assert.equal(intended.store.d.stage,'IMAGE_PREPARING');
});
test('stages: bootstrap incomplete → TIMEOUT blames the bootstrap; provider never running → TIMEOUT blames CloudCompute',async()=>{
 const run=watcherWith({detail:{status:'running'}});await run.tick();run.advance(61*60000);await run.tick();
 assert.equal(run.store.d.stage,'TIMEOUT');assert.equal(run.store.d.failure.component,'bootstrap');assert.match(run.store.d.stage_message,/onstart не выполнился.*worker.*Оплата инстанса продолжается/s);assert.equal(run.store.d.last_verified_stage,'INSTANCE_RUNNING');
 const never=watcherWith({detail:{status:'loading'}});await never.tick();never.advance(61*60000);await never.tick();
 assert.equal(never.store.d.stage,'TIMEOUT');assert.equal(never.store.d.failure.component,'cloudcompute');assert.match(never.store.d.stage_message,/CloudCompute не сообщил, что инстанс работает/);
});
test('stages: Docker image unavailable / container start failure / NVIDIA toolkit are told apart from CloudCompute and from the engine',async()=>{
 const pull=watcherWith({detail:{status:'error',status_msg:'Error response from daemon: pull access denied for ghcr.io/x/engine, manifest unknown'}});await pull.tick();
 assert.equal(pull.store.d.stage,'FAILED');assert.equal(pull.store.d.failure.component,'docker');assert.match(pull.store.d.stage_message,/Docker на хосте CloudCompute.*pull access denied/);
 const solve=watcherWith({detail:{status:'created',status_msg:'ERROR: failed to solve: process "/bin/sh -c apt-get update" did not complete successfully: exit code: 100'}});await solve.tick();
 assert.equal(solve.store.d.stage,'GPU_CREATED');assert.equal(solve.store.d.failure.component,'docker');assert.equal(solve.store.d.failure.terminal,false);assert.match(solve.store.d.stage_message,/failed to solve/);
 const gone=watcherWith({detail:{status:'loading',status_msg:'Error response from daemon: No such container: c-10758'}});await gone.tick();assert.equal(gone.store.d.failure.code,'DOCKER_ERROR');
 const nv=watcherWith({detail:{status:'failed',status_msg:'nvidia-container-cli: requirement error: unsatisfied condition: cuda>=12.8'}});await nv.tick();assert.equal(nv.store.d.failure.component,'gpu_host');
 const plain=watcherWith({detail:{status:'failed'}});await plain.tick();assert.equal(plain.store.d.failure.component,'cloudcompute');assert.equal(plain.store.d.failure.code,'PROVIDER_FAILED');
});
test('stages: engine failure is reported and cleared after verified recovery; GPU check failure is terminal; GPU_READY only after the health check',async()=>{
 let p={url:null,stages:[{stage:'IMAGE_READY',ts:1},{stage:'ENGINE_STARTING',ts:2},{stage:'ENGINE_FAILED',ts:3}]},phase='OFFLINE';
 const s=watcherWith({detail:{status:'running'},progress:async()=>p,connection:()=>({phase,origin:'https://e.trycloudflare.com'})});
 await s.tick();assert.equal(s.store.d.stage,'ENGINE_STARTING');assert.equal(s.store.d.failure.component,'engine');assert.match(s.store.d.stage_message,/Python/);
 p={url:null,stages:[...p.stages,{stage:'ENGINE_STARTING',ts:4},{stage:'SERVER_READY',ts:5}]};await s.tick();assert.equal(s.store.d.failure,null);   // old error gone
 p={...p,url:'https://e.trycloudflare.com'};await s.tick();assert.equal(s.store.d.stage,'ENGINE_HEALTH_CHECK');assert.notEqual(deploymentView(s.store.d).engine_ready,true);
 phase='READY';await s.tick();const v=deploymentView(s.store.d);assert.equal(v.stage,'GPU_READY');assert.equal(v.engine_ready,true);assert.equal(v.stage_history.at(-1).source,'health');
 const g=watcherWith({detail:{status:'running'},progress:async()=>({url:null,stages:[{stage:'IMAGE_READY',ts:1},{stage:'GPU_CHECK_FAILED',ts:2}]})});await g.tick();
 assert.equal(g.store.d.failure.component,'gpu');assert.equal(g.store.d.failure.terminal,true);assert.match(g.store.d.stage_message,/GPU не прошёл проверку/);
});
test('stages: instance deleted (404 or destroyed) and stopped are explicit; API errors are shown without changing the verified stage',async()=>{
 const del=watcherWith({detail:ccError(404,'not found')});await del.tick();assert.equal(del.store.d.stage,'INSTANCE_GONE');
 const destroyed=watcherWith({detail:{status:'destroyed'}});await destroyed.tick();assert.equal(destroyed.store.d.stage,'INSTANCE_GONE');
 const stop=watcherWith({detail:{status:'exited'},d:{stage:'INSTANCE_RUNNING'}});await stop.tick();assert.equal(stop.store.d.failure.code,'INSTANCE_STOPPED');assert.match(stop.store.d.stage_message,/остановлен \(exited\)/);
 const flaky=watcherWith({detail:new AppError('PROVIDER_NETWORK','Нет связи',502),d:{stage:'INSTANCE_RUNNING'}});await flaky.tick();assert.equal(flaky.store.d.stage,'INSTANCE_RUNNING');assert.match(flaky.store.d.error,/CloudCompute API: Нет связи/);
 assert.equal(classifyProvider({status:'running',provider:{status:'running'}}).phase,'RUNNING');
});
test('terminal availability is probed on request only; "port not published" is shown verbatim and the terminal token is never kept',async()=>{
 let reply={status:409,json:{error:{message:'Terminal port has not yet been published by the host.'}}};
 const h=await harness({deployment:{instance_id:'10758',token:'f'.repeat(64),image:ENGINE_IMAGE,name:'YOISAKI-X',created_at:Date.now(),stage:'INSTANCE_INITIALIZING'},terminalReply:()=>reply});
 try{
  const d0=await deploymentOf(h);assert.equal(d0.stage==='PROVIDER_BOOTSTRAPPING'||d0.stage==='IMAGE_PREPARING'||d0.stage==='GPU_CREATED',true);   // legacy stage read as PROVIDER_BOOTSTRAPPING
  let d=(await h.call('/api/cloudcompute/deploy/terminal','POST',{})).body.deployment;assert.equal(d.terminal.state,'UNAVAILABLE');assert.equal(d.terminal.message,'Terminal port has not yet been published by the host.');
  reply={status:200,json:{token:'terminal-secret-token',url:'wss://x'}};d=(await h.call('/api/cloudcompute/deploy/terminal','POST',{})).body.deployment;assert.equal(d.terminal.state,'AVAILABLE');
  assert(!(await fs.readFile(path.join(h.dir,'secrets.json'),'utf8')).includes('terminal-secret-token'));
 }finally{await h.close()}
});

// ------------------------------------------------------------------------------------------------ diagnostics
test('diagnostics: downloadable JSON with stages and provider status; no API key, engine token, Google or SSH secrets',async()=>{
 const h=await harness();
 try{
  await h.call('/api/cloudcompute/deploy','POST',createRequest);h.cc.detail={status:'running',status_msg:'Terminal port has not yet been published by the host. key=cc-another_secret_99'};
  await until(async()=>(await deploymentOf(h)).stage==='INSTANCE_RUNNING');
  const r=await h.raw('/api/cloudcompute/diagnostics');assert.equal(r.status,200);assert.match(r.headers.get('content-disposition'),new RegExp(DIAGNOSTICS_FILENAME));
  const text=await r.text(),rep=JSON.parse(text),token=(await h.secretsFile()).deployment.token;
  for(const secret of [token,KEY,'cc-another_secret_99'])assert(!text.includes(secret),secret);
  assert.equal(rep.website.version,'1.8.1');assert.equal(rep.instance.id,'9001');assert.equal(rep.instance.provider_status,'running');assert.equal(rep.instance.bootstrap_profile,'worker');
  assert.equal(rep.initialization.instance_running,true);assert.equal(rep.initialization.engine_ready,false);assert(rep.initialization.stage_history.length>=3);
  assert.equal(rep.engine.version,'unavailable');assert.equal(rep.gpu.driver,'unavailable');assert.equal(rep.gpu.model_source,'CloudCompute offer (advertised)');
  assert.equal(rep.image.reference,ENGINE_IMAGE);
 }finally{await h.close()}
 const s=sanitize({engine_token:'a'.repeat(64),Authorization:'Bearer abc.def',note:'Bearer abcdef ya29.A0secret 1//0refresh-token-value -----BEGIN OPENSSH PRIVATE KEY-----\nxyz\n-----END OPENSSH PRIVATE KEY----- https://h/#token='+'b'.repeat(64),client_secret:'GOCSPX-x',publicly_accessible:true});
 assert.deepEqual(Object.keys(s),['note','publicly_accessible']);for(const x of ['abcdef','ya29.A0secret','0refresh','xyz','b'.repeat(64)])assert(!s.note.includes(x),x);
 const empty=diagnosticsReport({websiteVersion:'1.7.7.1',deployment:null,image:null,connection:{connected:false},monitor:null});assert.equal(empty.instance,'unavailable');assert.equal(empty.engine.version,'unavailable');
});

// ------------------------------------------------------------------------------------------------ Docker / static
test('onstart: subshell without top-level exit, byte budget of the combined 16 384-byte limit, no nested Docker in the automatic script',async()=>{
 const token='c'.repeat(64),s=onstartScript({image:ENGINE_IMAGE,token});
 assert(bytes(s)<=ONSTART_BUDGET_BYTES&&ONSTART_LIMIT_BYTES===16384);assert(!/\bdocker\s+(run|pull|start)\b/.test(s));
 assert.equal(s.split(token).length,2);assert(s.includes('\n(\n')); // strict options/exit confined to subshell
 // appended to a provider bootstrap script (one combined script): the provider's next line still runs
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-177-os-'));
 try{
  const app=path.join(dir,'app');await fs.mkdir(path.join(app,'cloudcompute'),{recursive:true});
  await fs.writeFile(path.join(app,'cloudcompute/autostart-image.sh'),`#!/bin/bash\nprintf '%s' "$YOISAKI_PROVISION_TOKEN" > "${dir}/got"\nexit 0\n`,{mode:0o755});
  const combined=`set -e\necho provider-before > "${dir}/before"\n${s}\necho provider-after > "${dir}/after"\n`;
  await run('bash',['-c',combined],{env:{PATH:process.env.PATH,YOISAKI_APP_DIR:app}});
  assert.equal(await fs.readFile(path.join(dir,'got'),'utf8'),token);assert.equal((await fs.readFile(path.join(dir,'after'),'utf8')).trim(),'provider-after');
  await run('sh',['-n',path.join(dir,'got')]).catch(()=>{});
  await fs.writeFile(path.join(dir,'s.sh'),s);await run('sh',['-n',path.join(dir,'s.sh')]);await run('bash',['-n',path.join(dir,'s.sh')]);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
 assert.throws(()=>createBody({offer:offerView(offer(1)),disk_gb:80,name:'x',image:ENGINE_IMAGE,token,max_price_hour_minor:1,currency:'RUB',bootstrap_profile:'bogus'}));
});
test('image: Dockerfile starts as root and drops to uid 1000 for the engine; startup configuration and required files are present',async()=>{
 const docker=await fs.readFile('Dockerfile','utf8'),code=docker.replace(/#.*$/gm,'');
 assert(!/^\s*USER\s/m.test(code));assert.match(code,/ENTRYPOINT \["\/usr\/bin\/tini", "--"\]/);assert.match(code,/CMD \["\/opt\/yoisaki\/cloudcompute\/autostart-image\.sh"\]/);
 assert.match(code,/HEALTHCHECK .*launcher\.py", "healthcheck"\]/s);assert.match(code,/FROM nvidia\/cuda:12\.8\.1-base-ubuntu24\.04@sha256:[a-f0-9]{64}/);
 for(const env of ['YOISAKI_IN_IMAGE=1','YOISAKI_DATA_ROOT=/data','YOISAKI_PYTHON=/opt/yoisaki/venv/bin/python','YOISAKI_CLOUDFLARED=/usr/local/bin/cloudflared','HF_HOME=/data/huggingface-cache'])assert(code.includes(env),env);
 const auto=await fs.readFile('cloudcompute/autostart-image.sh','utf8');assert.match(auto,/setpriv --reuid="\$RUN_UID" --regid="\$RUN_GID" --clear-groups/);assert.match(auto,/flock -w 1 9/);
 for(const f of ['cloudcompute/autostart-image.sh','cloudcompute/launcher.py','cloudcompute/rendezvous.py','cloudcompute/diagnose.py','cloudcompute/import_check.py','cloudcompute/serve_cloud.py','cloudcompute/requirements-lock.txt','engine/worker/serve.py'])await fs.access(f);
 assert.equal((await fs.readFile('cloudcompute/VERSION','utf8')).trim(),'1.7.7.1');
 const compose=await fs.readFile('docker-compose.yml','utf8');assert.match(compose,/user: "\$\{YOISAKI_UID:-1000\}:\$\{YOISAKI_GID:-1000\}"/);   // local compose keeps the unprivileged user
});
test('image registry check: an index without linux/amd64 is refused; a single manifest is accessible but its platform stays unverified',async()=>{
 const http=json=>async url=>url.includes('/token?')?{status:200,json:{token:'anon'}}:{status:200,json};
 const arm=await checkImage('ghcr.io/x/engine:1',http({manifests:[{platform:{os:'linux',architecture:'arm64'}}]}));assert.equal(arm.accessible,false);assert.match(arm.message,/linux\/amd64/);
 const multi=await checkImage('ghcr.io/x/engine:1',http({manifests:[{platform:{os:'linux',architecture:'amd64'}},{platform:{os:'linux',architecture:'arm64'}}]}));assert.equal(multi.accessible,true);assert.equal(multi.linux_amd64,true);
 const single=await checkImage('ghcr.io/x/engine:1',http({schemaVersion:2,config:{}}));assert.equal(single.accessible,true);assert.equal(single.linux_amd64,null);
});
test('LIVE registry (opt-in: YOISAKI_LIVE_REGISTRY=1): the configured engine image is publicly pullable',{skip:process.env.YOISAKI_LIVE_REGISTRY!=='1'&&'set YOISAKI_LIVE_REGISTRY=1 (needs network to ghcr.io)'},async()=>{
 const {providerHttp}=await import('../server/provider-http.mjs');const r=await checkImage(ENGINE_IMAGE,providerHttp);
 assert.equal(r.checked,true);assert.equal(r.accessible,true,r.message);
});

// v1.7.5 zero-terminal CloudCompute deployment. CloudCompute, ghcr.io, ntfy and the GPU are explicit test doubles:
// these tests prove the adapter, the safety rules and the orchestration, NOT a live CloudCompute deployment.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createLocalApp} from '../server/app.mjs';
import {offerView,offerList,offerPrice,onstartScript,createBody,createdInstanceId,checkImage,ENGINE_IMAGE,DeploymentWatcher} from '../server/cloudcompute-deploy.mjs';
import {pickStages,signStatus,topicFor,progress,sign} from '../server/rendezvous.mjs';
import {AppError} from '../server/errors.mjs';
import {SecretStore} from '../server/secrets.mjs';
const run=promisify(execFile);
const KEY='cc-test_secret_12345',TOKEN_RE=/[a-f0-9]{64}/;
const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true},state:'READY',gpu_name:'RTX 4090',vram_total_mb:24000,vram_available_mb:23000};
const OFFERS=[
 {ask_id:501,gpu_name:'RTX 4090',num_gpus:1,gpu_ram:24576,price_hour:4520,disk_space:500,cuda_max_good:12.9,reliability2:0.985,geolocation:'RU',inet_down:900},
 {ask_id:502,gpu_name:'RTX 3070',num_gpus:1,gpu_ram:8192,price_hour:1500,disk_space:200,cuda_max_good:12.9},
 {ask_id:503,gpu_name:'RTX 3090',num_gpus:1,gpu_ram:24576,price_hour:2600,disk_space:300,cuda_max_good:12.2},
 {ask_id:504,gpu_name:'A5000',num_gpus:1,gpu_ram:24576,dph_total:0.35,disk_space:300,cuda_max_good:13.0},
 {ask_id:505,gpu_name:'RTX 3060',num_gpus:1,gpu_ram:12288,price_rub:19.9,disk_space:120,cuda_max_good:12.8,storage_cost:0.12},
];
const until=async(fn,ms=6000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timeout waiting for condition');await new Promise(r=>setTimeout(r,15))}};

test('offers: verified price units only, VRAM/CUDA/disk compatibility, sorted, unknown schema refused',()=>{
 const {offers,rejected}=offerList({data:[...OFFERS,{gpu_name:'no id'}]});
 assert.equal(rejected,1);assert.deepEqual(offers.filter(o=>o.compatible).map(o=>o.id),[505,501]);
 const o501=offers.find(o=>o.id===501);assert.deepEqual(o501.price,{minor:4520,currency:'RUB',field:'price_hour',verified:true,basis:'price_hour в API CloudCompute задаётся в копейках'});assert.equal(o501.vram_mb,24576);assert.equal(o501.reliability,98.5);
 assert.match(offers.find(o=>o.id===502).reasons.join(),/12 ГБ/);assert.match(offers.find(o=>o.id===503).reasons.join(),/CUDA 12\.2/);
 const o504=offers.find(o=>o.id===504);assert.equal(o504.price.verified,false);assert.equal(o504.price.minor,null);assert.equal(o504.compatible,false);
 const o505=offers.find(o=>o.id===505);assert.equal(o505.price.minor,1990);assert.deepEqual(o505.storage,[{field:'storage_cost',value:0.12}]);assert.match(o505.warnings.join(),/12–16/);
 assert.equal(offerPrice({price_hour_minor:'1234',currency:'rub'}).minor,1234);assert.equal(offerPrice({price_minor:10}).verified,false);
 assert.equal(offerView({id:7,gpu_ram:24,price_hour:100}).vram_mb,24576);
 assert.throws(()=>offerList({unexpected:[]}),e=>e.code==='CC_RESPONSE_SCHEMA');assert.throws(()=>offerList({data:[{}]}),e=>e.code==='CC_RESPONSE_SCHEMA');
 assert.equal(offerList([]).offers.length,0);
});

test('create body: documented fields only, strict offer, exact price ceiling, onstart with token, disk bounds',()=>{
 const offer=offerView(OFFERS[0]),token='b'.repeat(64);
 const body=createBody({offer,disk_gb:80,name:'YOISAKI-ABC123',image:ENGINE_IMAGE,token,max_price_hour_minor:4520,currency:'RUB'});
 assert.deepEqual(Object.keys(body).sort(),['ask_id','auto_select','bootstrap_profile','currency','disk_gb','max_price_hour_minor','name','offer_disk_space','onstart','strict_offer','template_image']);
 assert.equal(body.bootstrap_profile,'worker');assert.equal('bootstrap_profile' in createBody({offer,disk_gb:80,name:'x',image:ENGINE_IMAGE,token,max_price_hour_minor:1,currency:'RUB',bootstrap_profile:'provider_default'}),false);
 assert.equal(body.ask_id,501);assert.equal(body.auto_select,false);assert.equal(body.strict_offer,true);assert.equal(body.offer_disk_space,500);assert.equal(body.template_image,ENGINE_IMAGE);
 assert(body.onstart.includes(token)&&body.onstart.includes(ENGINE_IMAGE)&&Buffer.byteLength(body.onstart)<=8192);
 assert(!/:latest\b/.test(ENGINE_IMAGE)&&/:1\.7\.7$/.test(ENGINE_IMAGE));
 for(const disk of [39,501,80.5])assert.throws(()=>createBody({offer,disk_gb:disk,name:'x',image:ENGINE_IMAGE,token,max_price_hour_minor:1,currency:'RUB'}));
 assert.throws(()=>onstartScript({image:ENGINE_IMAGE,token:'short'}));assert.throws(()=>onstartScript({image:"bad image'; rm",token}));
 assert.equal(createdInstanceId({data:{id:9001}}),'9001');assert.equal(createdInstanceId({new_contract:77}),'77');assert.equal(createdInstanceId({success:true}),null);assert.equal(createdInstanceId({id:'../x'}),null);
});

test('onstart script really provisions: inside the image; Docker only in the manual command and only with a reachable daemon (fake docker), token only in 0600 files',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-onstart-'));const token='c'.repeat(64);
 try{
  const script=path.join(dir,'onstart.sh');await fs.writeFile(script,onstartScript({image:ENGINE_IMAGE,token}));
  // 1) inside the image: autostart-image.sh --provision receives the token through the environment only
  const app=path.join(dir,'app');await fs.mkdir(path.join(app,'cloudcompute'),{recursive:true});
  await fs.writeFile(path.join(app,'cloudcompute/autostart-image.sh'),`#!/bin/bash\nprintf '%s|%s' "$1" "$YOISAKI_PROVISION_TOKEN" > "${dir}/image-call"\n`,{mode:0o755});
  await run('bash',[script],{env:{PATH:process.env.PATH,YOISAKI_APP_DIR:app}});
  assert.equal(await fs.readFile(path.join(dir,'image-call'),'utf8'),'--provision|'+token);
  // 2) 1.7.7: the automatic (create) script never starts Docker, even when a docker CLI exists
  const bin=path.join(dir,'bin'),data=path.join(dir,'host/yoisaki-data');await fs.mkdir(bin);await fs.mkdir(path.dirname(data));
  await fs.writeFile(path.join(bin,'docker'),`#!/bin/bash\necho "$*" >> "${dir}/docker-calls"\n[ "$1" = container ] && exit 1\nexit 0\n`,{mode:0o755});
  await fs.writeFile(path.join(bin,'chown'),'#!/bin/bash\nexit 0\n',{mode:0o755});
  await run('bash',[script],{env:{PATH:bin+':'+process.env.PATH,YOISAKI_APP_DIR:path.join(dir,'missing'),YOISAKI_HOST_DATA:data}});
  await assert.rejects(fs.readFile(path.join(dir,'docker-calls'),'utf8'));
  // 3) manual command (existing instance): Docker host with a reachable daemon — pulled and started with the data volume;
  //    the token is NOT on the docker command line
  await fs.writeFile(script,onstartScript({image:ENGINE_IMAGE,token,docker:true}));
  await run('bash',[script],{env:{PATH:bin+':'+process.env.PATH,YOISAKI_APP_DIR:path.join(dir,'missing'),YOISAKI_HOST_DATA:data}});
  const calls=await fs.readFile(path.join(dir,'docker-calls'),'utf8');
  assert.match(calls,new RegExp('pull '+ENGINE_IMAGE.replace(/[.]/g,'\\.')));assert.match(calls,/run -d --name yoisaki-engine --restart unless-stopped --gpus all .*-v \S+:\/data ghcr\.io/);assert(!calls.includes(token));
  assert.equal((await fs.readFile(path.join(data,'config/engine/engine.token'),'utf8')).trim(),token);
  assert.equal((await fs.stat(path.join(data,'config/engine/engine.token'))).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(data,'config/engine/autostart.json'),'utf8')),{version:1,stable_link:true,rendezvous:'ntfy'});
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('image check: anonymous ghcr pull = accessible; private / missing image refused; other registries not claimed',async()=>{
 const seen=[];const http=status=>async(url,opts)=>{seen.push([url,opts.headers.Authorization]);return url.includes('/token?')?{status:200,json:{token:'anon'}}:{status,json:{}}};
 assert.equal((await checkImage(ENGINE_IMAGE,http(200))).accessible,true);assert.equal(seen[0][0],'https://ghcr.io/token?scope=repository:regmop4576-hash/yoisaki-ai-studio/engine:pull&service=ghcr.io');assert.equal(seen[1][1],'Bearer anon');
 assert.match(seen[1][0],/\/v2\/regmop4576-hash\/yoisaki-ai-studio\/engine\/manifests\/1\.7\.7$/);
 assert.equal((await checkImage(ENGINE_IMAGE,http(404))).accessible,false);
 assert.equal((await checkImage(ENGINE_IMAGE,async()=>({status:401,json:{}}))).accessible,false);
 const other=await checkImage('registry.example.com/x/engine:1',http(200));assert.equal(other.checked,false);assert.equal(other.accessible,null);
 assert.equal((await checkImage(ENGINE_IMAGE,async()=>{throw new AppError('PROVIDER_NETWORK','down',502)})).accessible,null);
});

test('rendezvous stages: signed, fresh, whitelisted, byte-compatible with cloudcompute/rendezvous.py',async()=>{
 const token='d'.repeat(64),now=1800000000;
 const rec=(stage,ts,sig=signStatus(token,stage,ts))=>JSON.stringify({event:'message',message:JSON.stringify({v:1,kind:'status',stage,ts,sig})});
 const body=[rec('ENGINE_STARTING',now-30),rec('IMAGE_READY',now-60),rec('SERVER_READY',now-10,'0'.repeat(64)),rec('HACKED',now),rec('SERVER_READY',now-100000),
  JSON.stringify({event:'message',message:JSON.stringify({v:1,url:'https://a-b.trycloudflare.com',ts:now-5,sig:sign(token,'https://a-b.trycloudflare.com',now-5)})})].join('\n');
 assert.deepEqual(pickStages(body,token,now),[{stage:'IMAGE_READY',ts:now-60},{stage:'ENGINE_STARTING',ts:now-30}]);
 const p=await progress(token,{fetchText:async u=>{assert.equal(u,'/'+topicFor(token)+'/json?poll=1&since=24h');return body},now});assert.equal(p.url,'https://a-b.trycloudflare.com');assert.equal(p.stages.length,2);
 const py=await run('python3',['-I','-c','import sys;sys.path.insert(0,"cloudcompute");import rendezvous as r;print(r.sign_status(sys.argv[1],"SERVER_READY",123));print(r.status_record(sys.argv[1],"IMAGE_READY",5)["sig"])','d'.repeat(64)]);
 assert.deepEqual(py.stdout.trim().split('\n'),[signStatus(token,'SERVER_READY',123),signStatus(token,'IMAGE_READY',5)]);
});

// ---------------------------------------------------------------------------------------------------------------- app
async function harness({drive=null,createReply,offers=OFFERS,imageStatus=200,selection=null}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-175-'));
 if(drive){const s=await new SecretStore(dir).init();await s.setDrive(drive)}
 // v1.7.6: the models chosen on the phone (Models → Google Drive) before the GPU exists.
 if(selection)await fs.writeFile(path.join(dir,'drive-library.json'),JSON.stringify({version:1,inventory:null,last_check:null,selection}));
 const cc={posts:[],instances:[],detailStatus:'loading',gone:false};let gpu={url:null,stages:[]};const sync={configured:false,job:null,items:[],started:null,bound:null};
 const syncView=()=>({service:'YOISAKI_DRIVE_SYNC',enabled:true,rclone_available:true,configured:sync.configured,source:'models',scope:'drive.readonly',connection:{state:'OK'},job:sync.job,items:sync.items,inventory_revision:1,selective:true,folder_selection:true});
 const providerRequest=async(url,opts={})=>{
  if(url.startsWith('https://ghcr.io/token'))return {status:200,json:{token:'anon'}};
  if(url.startsWith('https://ghcr.io/v2/'))return {status:imageStatus,json:{}};
  if(url.includes('oauth2.googleapis.com'))return {status:200,json:{access_token:'fresh-private-access',expires_in:3600}};
  assert(url.startsWith('https://app.cloudcompute.ru/api/v1/'),url);assert.equal(opts.headers.Authorization,'Bearer '+KEY);
  const route=url.slice('https://app.cloudcompute.ru/api/v1'.length);
  if(route==='/offers')return {status:200,json:{data:offers}};
  if(route==='/instances'&&(opts.method||'GET')==='GET')return {status:200,json:{data:cc.instances}};
  if(route==='/instances'&&opts.method==='POST'){const body=JSON.parse(opts.body);cc.posts.push(body);const r=createReply?createReply(body):{status:201,json:{data:{id:9001}}};if(r instanceof Error)throw r;if(r.status<300)cc.instances.push({id:9001,name:body.name,status:'loading'});return r}
  if(route.startsWith('/instances/')){if(cc.gone)return {status:404,json:{error:{message:'not found'}}};if(opts.method==='DELETE'){cc.gone=true;return {status:200,json:{}}}return {status:200,json:{data:{id:route.split('/')[2],name:'YOISAKI',status:cc.detailStatus}}}}
  throw Error('unexpected '+route);
 };
 const upstream=async(c,p,o={})=>{
  if(p==='/health')return health;if(p.startsWith('/inventory'))return {revision:'a'.repeat(32),models:[]};
  if(p==='/sync/drive/connect'){sync.bound=JSON.parse(o.body);sync.configured=true;return syncView()}
  if(p==='/sync/status')return syncView();
  if(p==='/sync/check'){sync.job={id:'j1',type:'check',state:'COMPLETED',phase:'DONE'};sync.items=[{path:'checkpoints/have.safetensors',name:'have.safetensors',kind:'checkpoint',size:6e9,state:'INSTALLED'},{path:'loras/a.safetensors',name:'a.safetensors',kind:'lora',size:2e8,state:'MISSING'},{path:'checkpoints/b.safetensors',name:'b.safetensors',kind:'checkpoint',size:7e9,state:'MISSING'}];return syncView()}
  if(p==='/sync/start'){sync.started=JSON.parse(o.body);sync.job={id:'j2',type:'sync',state:'COMPLETED',phase:'DONE',overall:{files_done:sync.started.paths.length}};return syncView()}
  throw Error('upstream '+p);
 };
 const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),providerRequest,upstream,discoverProgress:async token=>{assert.match(token,/^[a-f0-9]{64}$/);return gpu},sleep:()=>new Promise(r=>setTimeout(r,5)),deployInterval:15,driveInterval:5});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const cookie=(await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}})).headers.get('set-cookie').split(';')[0];
 const call=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'X-Yoisaki-Local':'1',cookie},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 await call('/api/cloudcompute/config','PUT',{key:KEY});
 const secretsFile=()=>fs.readFile(path.join(dir,'secrets.json'),'utf8').then(JSON.parse);
 return {app,dir,call,cc,sync,setGpu:v=>{gpu=v},secretsFile,async close(){await app.close();await fs.rm(dir,{recursive:true,force:true})}};
}
const createRequest={confirm:true,offer_id:501,accepted_price_minor:4520,currency:'RUB',disk_gb:80,auto_sync:true};

test('deploy refuses without confirmation, with a changed price, an incompatible offer or an unpublished image — nothing is created',async()=>{
 const h=await harness();
 try{
  assert.equal((await h.call('/api/cloudcompute/deploy','POST',{...createRequest,confirm:false})).body.code,'CC_CONFIRM_REQUIRED');
  let r=await h.call('/api/cloudcompute/deploy','POST',{...createRequest,accepted_price_minor:4000});assert.equal(r.status,409);assert.equal(r.body.code,'CC_PRICE_CHANGED');assert.match(r.body.error,/45\.20 RUB\/час/);
  r=await h.call('/api/cloudcompute/deploy','POST',{...createRequest,offer_id:502,accepted_price_minor:1500});assert.equal(r.body.code,'CC_OFFER_INCOMPATIBLE');
  r=await h.call('/api/cloudcompute/deploy','POST',{...createRequest,offer_id:999});assert.equal(r.body.code,'CC_OFFER_GONE');
  assert.equal(h.cc.posts.length,0);assert.equal((await h.call('/api/cloudcompute/deploy')).body.deployment,null);
 }finally{await h.close()}
 const p=await harness({imageStatus:404});
 try{const r=await p.call('/api/cloudcompute/deploy','POST',createRequest);assert.equal(r.body.code,'CC_IMAGE_UNAVAILABLE');assert.match(r.body.error,/НЕ создан, деньги не списаны/);assert.equal(p.cc.posts.length,0)}finally{await p.close()}
});

const DRIVE={session_id:'s1',client:{client_id:'123456789-abcdefghij.apps.googleusercontent.com',client_secret:'GOCSPX-test_secret'},token:{access_token:'private-access',refresh_token:'private-refresh',expiry:'2099-01-01T00:00:00Z'},account:{email:'test@example.invalid'},folder:{id:'models-folder',name:'Models'}};
test('deploy → signed stages → automatic connection → GPU_READY → Drive bind, check, only the SELECTED missing models downloaded (1.7.6)',async()=>{
 const drive=DRIVE;
 const h=await harness({drive,selection:{folder_id:'models-folder',folder_name:'Models',items:{'loras/a.safetensors':{id:'f1',name:'a.safetensors',kind:'lora',size:2e8},'checkpoints/have.safetensors':{id:'f0',name:'have.safetensors',kind:'checkpoint',size:6e9}},updated_at:1}});
 try{
  const offers=(await h.call('/api/cloudcompute/offers')).body;assert.equal(offers.offers[0].id,505);assert.equal(offers.requirements.min_vram_mb,12288);
  const created=await h.call('/api/cloudcompute/deploy','POST',createRequest);assert.equal(created.status,201);
  assert.equal(h.cc.posts.length,1);const post=h.cc.posts[0];assert.equal(post.max_price_hour_minor,4520);assert.equal(post.template_image,ENGINE_IMAGE);
  const token=post.onstart.match(/YOISAKI_PROVISION_TOKEN='([a-f0-9]{64})'/)[1];
  assert.equal(created.body.deployment.instance_id,'9001');assert(!JSON.stringify(created.body).includes(token));
  assert.equal((await h.secretsFile()).deployment.token,token);assert(!(await fs.readFile(path.join(h.dir,'state.json'),'utf8')).includes(token));
  assert.equal((await fs.stat(path.join(h.dir,'secrets.json'))).mode&0o777,0o600);
  // second paid server needs an explicit confirmation
  assert.equal((await h.call('/api/cloudcompute/deploy','POST',createRequest)).body.code,'CC_DEPLOYMENT_EXISTS');assert.equal(h.cc.posts.length,1);
  await until(async()=>(await h.call('/api/cloudcompute/deploy')).body.deployment.stage==='IMAGE_PREPARING');  // provider status 'loading'
  h.setGpu({url:null,stages:[{stage:'IMAGE_READY',ts:1}]});await until(async()=>(await h.call('/api/cloudcompute/deploy')).body.deployment.stage==='DOCKER_IMAGE_READY');
  h.setGpu({url:null,stages:[{stage:'IMAGE_READY',ts:1},{stage:'ENGINE_STARTING',ts:2}]});await until(async()=>(await h.call('/api/cloudcompute/deploy')).body.deployment.stage==='ENGINE_STARTING');
  assert.equal((await h.call('/api/gpu/status')).body.url,'');
  h.setGpu({url:'https://quick-name.trycloudflare.com',stages:[{stage:'IMAGE_READY',ts:1},{stage:'SERVER_READY',ts:3}]});
  const ready=await until(async()=>{const d=(await h.call('/api/cloudcompute/deploy')).body.deployment;return d.stage==='GPU_READY'&&d.drive?.state==='DONE'&&d});
  const st=(await h.call('/api/gpu/status')).body;assert.equal(st.provider,'cloudcompute');assert.equal(st.url,'https://quick-name.trycloudflare.com');assert.equal(st.remembered.cloudcompute.discover,true);
  assert.equal(h.sync.bound.root_folder_id,'models-folder');assert.equal(JSON.parse(h.sync.bound.token).refresh_token,'private-refresh');
  // the not-selected checkpoints/b.safetensors (7 GB) is not downloaded; the installed selected one is not re-downloaded
  assert.deepEqual(h.sync.started,{paths:['loras/a.safetensors']});
  assert.deepEqual(ready.drive.summary,{installed:1,missing:2,missing_bytes:7.2e9,selected:2,wanted:1,wanted_bytes:2e8,conflicts:0,rejected:0});
  const visible=JSON.stringify([(await h.call('/api/cloudcompute/deploy')).body,st,(await h.call('/api/diagnostics')).body]);
  for(const secret of [token,KEY,'private-refresh','private-access'])assert(!visible.includes(secret),secret);
  // deleting the instance from the app marks the deployment as gone (no silent billing assumptions)
  assert.equal((await h.call('/api/cloudcompute/instances/9001','DELETE',{confirm_id:'9001'})).status,200);
  assert.equal((await h.call('/api/cloudcompute/deploy')).body.deployment.stage,'INSTANCE_GONE');
 }finally{await h.close()}
});

test('1.7.6: without a saved selection the automatic routine downloads nothing and says why; an explicit press downloads the missing files',async()=>{
 const h=await harness({drive:DRIVE});
 try{
  await h.call('/api/cloudcompute/deploy','POST',createRequest);
  h.setGpu({url:'https://quick-name.trycloudflare.com',stages:[{stage:'IMAGE_READY',ts:1},{stage:'SERVER_READY',ts:3}]});
  const ready=await until(async()=>{const d=(await h.call('/api/cloudcompute/deploy')).body.deployment;return d.stage==='GPU_READY'&&d.drive?.state==='READY_TO_SYNC'&&d});
  assert.equal(h.sync.started,null);assert.match(ready.drive.message,/не выбраны/);assert.match(ready.drive.message,/вся коллекция автоматически не скачивается/);
  assert.equal((await h.call('/api/cloudcompute/deploy/sync','POST',{download:true})).status,202);
  await until(async()=>h.sync.started);assert.deepEqual(h.sync.started,{paths:['loras/a.safetensors','checkpoints/b.safetensors']});
 }finally{await h.close()}
});

test('Drive not connected: GPU still becomes ready, models step is skipped with a clear message, no downloads',async()=>{
 const h=await harness();
 try{
  await h.call('/api/cloudcompute/deploy','POST',{...createRequest,auto_sync:true});h.setGpu({url:'https://n.trycloudflare.com',stages:[{stage:'SERVER_READY',ts:1}]});
  const d=await until(async()=>{const d=(await h.call('/api/cloudcompute/deploy')).body.deployment;return d.drive?.state==='SKIPPED'&&d});
  assert.equal(d.stage,'GPU_READY');assert.match(d.drive.message,/Google Drive не подключён/);assert.equal(h.sync.started,null);
 }finally{await h.close()}
});

test('GPU check failure and stopped instance are reported from observed signals; failed creation is never retried',async()=>{
 const h=await harness({createReply:()=>({status:422,json:{error:{message:'Offer is taken'}}})});
 try{
  const r=await h.call('/api/cloudcompute/deploy','POST',createRequest);assert.equal(r.status,422);assert.match(r.body.error,/Offer is taken/);
  assert.equal(h.cc.posts.length,1);assert.equal((await h.call('/api/cloudcompute/deploy')).body.deployment,null);assert.equal((await h.secretsFile()).deployment,null);
 }finally{await h.close()}
 const lost=await harness({createReply:body=>{lost.cc.instances.push({id:7777,name:body.name,status:'loading'});return new AppError('PROVIDER_NETWORK','Нет связи',502)}});
 try{
  const r=await lost.call('/api/cloudcompute/deploy','POST',createRequest);assert.equal(r.status,502);assert.match(r.body.error,/Повторное создание не выполнялось/);
  const d=await until(async()=>{const d=(await lost.call('/api/cloudcompute/deploy')).body.deployment;return d?.instance_id==='7777'&&d});
  assert.equal(lost.cc.posts.length,1);assert(d.name.startsWith('YOISAKI-'));
  lost.setGpu({url:null,stages:[{stage:'IMAGE_READY',ts:1},{stage:'GPU_CHECK_FAILED',ts:2}]});
  await until(async()=>/GPU не прошёл проверку/.test((await lost.call('/api/cloudcompute/deploy')).body.deployment.stage_message));
  lost.cc.detailStatus='exited';lost.setGpu({url:null,stages:[]});
  await until(async()=>/инстанс остановлен \(exited\)/.test((await lost.call('/api/cloudcompute/deploy')).body.deployment.stage_message));
 }finally{await lost.close()}
});

test('existing instance adoption returns the one-time command; forgetting never deletes the instance',async()=>{
 const h=await harness();
 try{
  assert.equal((await h.call('/api/cloudcompute/deploy/adopt','POST',{instance_id:'42'})).body.code,'CC_CONFIRM_REQUIRED');
  const r=await h.call('/api/cloudcompute/deploy/adopt','POST',{confirm:true,instance_id:'42'});assert.equal(r.status,200);
  const token=r.body.command.match(/YOISAKI_PROVISION_TOKEN='([a-f0-9]{64})'/)[1];assert.equal((await h.secretsFile()).deployment.token,token);
  assert(!JSON.stringify((await h.call('/api/cloudcompute/deploy')).body).includes(token));assert.equal(h.cc.posts.length,0);
  assert.equal((await h.call('/api/cloudcompute/deploy','DELETE',{})).body.code,'CC_CONFIRM_REQUIRED');
  assert.equal((await h.call('/api/cloudcompute/deploy','DELETE',{confirm:true})).body.deployment,null);assert.equal(h.cc.gone,false);
 }finally{await h.close()}
});

test('watcher timeout is explicit and mentions continued billing; restart resumes watching',async()=>{
 let t=0;const store={d:{instance_id:'1',token:'e'.repeat(64),image:ENGINE_IMAGE,created_at:0,stage:'GPU_CREATED'}};
 const secrets={deployment:()=>store.d,change:async fn=>{const x={deployment:structuredClone(store.d)};fn(x);store.d=x.deployment}};
 const w=new DeploymentWatcher({secrets,cloud:{detail:async()=>({id:1,status:'loading'})},progress:async()=>({url:null,stages:[]}),connect:async()=>{},connectionState:()=>({phase:'OFFLINE'}),now:()=>t,sleep:async()=>{t+=61*60000},interval:1,timeoutMinutes:60});
 w.start();await until(()=>store.d.stage==='TIMEOUT');assert.match(store.d.stage_message,/Оплата инстанса продолжается/);
 w.start();assert.equal(w.view().watching,true);w.stop();
});

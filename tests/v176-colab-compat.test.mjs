// Actual website/FastAPI over local HTTP. CUDA/inference/Google are test doubles.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createLocalApp} from '../server/app.mjs';
import {engineCompatibility} from '../server/release.mjs';
import {validateHealth} from '../server/upstream.mjs';
import {compareSources} from '../server/drive-library.mjs';
import {parseInventory} from '../server/inventory.mjs';
import {FakeDrive,account,KEYS,safetensors} from './fixtures/fake-drive.mjs';
import {SecretStore} from '../server/secrets.mjs';
import {SyncMonitor} from '../server/sync-monitor.mjs';
import {fakeGpu} from './fixtures/fake-gpu.mjs';
const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.6',api_version:'1.7.0',state:'READY',gpu_name:'MOCK',vram_total_mb:16000,vram_available_mb:10000,capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true}};
test('Colab 1.7.6 and legacy 1.7.0: both gates agree, reject wrong protocol/capabilities',()=>{
 for(const h of [health,{...health,engine_version:'1.7.0',api_version:undefined}]){assert.equal(engineCompatibility(h),'COMPATIBLE');assert.equal(validateHealth(h),h)}
 for(const h of [{...health,api_version:'1.7.6'},{...health,api_version:undefined},{...health,engine_version:'9.0.0'},{...health,capabilities:{...health.capabilities,img2img:false}}]){assert.equal(engineCompatibility(h),'UNVERIFIED');assert.throws(()=>validateHealth(h),e=>e.code==='ENGINE_UPGRADE_REQUIRED')}
});
test('relative paths distinguish equal filenames and changed sizes; unsafe paths discarded',()=>{
 const model={id:'a'.repeat(32),name:'a.safetensors',kind:'lora',size_bytes:123,compatible:true,architecture:'SDXL',relative_path:'loras/nested/a.safetensors'};
 const inventory={items:[{path:'loras/a.safetensors',name:model.name,kind:'lora',size:123,sync:{eligible:true}},{path:model.relative_path,name:model.name,kind:'lora',size:123,sync:{eligible:true}}]};
 assert.deepEqual(compareSources({inventory,gpuModels:parseInventory({models:[model]}).models}).rows.map(r=>r.category),['DRIVE_ONLY','INSTALLED']);
 assert.equal(compareSources({inventory,gpuModels:[{...model,size_bytes:124}]}).counts.INSTALLED,0);
 assert.equal(parseInventory({models:[{...model,relative_path:'../../escape'}]}).models[0].relative_path,undefined);
});
test('actual site to FastAPI: generation variants, gallery, stale inventory; no sync/OAuth sent to Colab',{skip:!process.env.YOISAKI_VALIDATION_DIR},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'colab-contract-'));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const proc=spawn('python',[path.join(process.env.YOISAKI_VALIDATION_DIR,'mock_http_engine.py')],{env:{...process.env,TEST_PORT:String(port),TEST_MODEL_ROOT:path.join(dir,'models'),YOISAKI_RESULTS_DIR:path.join(dir,'results')},stdio:['ignore','ignore','pipe']});let stderr='';proc.stderr.on('data',b=>stderr+=b);
 const token='a'.repeat(64),headers={Authorization:'Bearer '+token};let app,stale=false;const calls=[];
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`,{headers})).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}assert(ready,stderr);
  const fake=new FakeDrive(),h=safetensors(KEYS.checkpoint,{},1000);fake.folder('cp','checkpoints');fake.file('cp-a','a.safetensors','cp',{header:h.header,size:(await fs.stat(path.join(dir,'models/checkpoints/a.safetensors'))).size});
  await fs.mkdir(path.join(dir,'site'),{recursive:true});
  fake.folder('lp','loras');fake.file('ghost','ghost.safetensors','lp',{header:h.header,size:h.size});
  const oldSync=new SyncMonitor({dir:path.join(dir,'site')});const oldGpu=fakeGpu();oldGpu.sync.items=[{path:'loras/ghost.safetensors',name:'ghost.safetensors',kind:'lora',size:h.size,state:'INSTALLED'}];oldSync.observe(oldGpu.view(),'https://old-cloudcompute.trycloudflare.com');await oldSync.save(true);
  const secrets=await new SecretStore(path.join(dir,'site')).init();await secrets.setDrive(account());
  const upstream=async(c,route,o={})=>{calls.push(route);assert.equal(c.token,token);assert.equal(c.provider,'colab');if(stale&&route==='/models')throw Object.assign(Error('test mount unavailable'),{code:'UPSTREAM_HTTP'});
   const r=await fetch(`http://127.0.0.1:${port}${route}`,{method:o.method||'GET',body:o.body,headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'}});
   if(!r.ok)throw Object.assign(Error(await r.text()),{code:r.status===404?'JOB_NOT_FOUND':'UPSTREAM_HTTP'});return o.binary?Buffer.from(await r.arrayBuffer()):r.json();};
  app=await createLocalApp({dataDir:path.join(dir,'site'),distDir:'dist',upstream,providerRequest:fake.request,providerBytesRequest:fake.bytes,autoResume:false});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
  const cookie=(await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}})).headers.get('set-cookie').split(';')[0];
  const call=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'X-Yoisaki-Local':'1',cookie},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
  const conn=await call('/api/gpu/connect','POST',{url:'https://colab-fixture.trycloudflare.com/#token='+token});assert.equal(conn.status,200,JSON.stringify(conn.body));assert.equal(conn.body.compatibility,'COMPATIBLE');assert.equal(conn.body.info.engine_version,'1.7.6');
  const models=conn.body.models,checkpoint=models.find(m=>m.kind==='checkpoint'),loras=models.filter(m=>m.kind==='lora');assert.equal(checkpoint.relative_path,'checkpoints/a.safetensors');
  const source='data:image/png;base64,'+(await fs.readFile(path.join(dir,'source.png'))).toString('base64');
  const ref='data:image/png;base64,'+(await fs.readFile(new URL('./fixtures/control-reference.png',import.meta.url))).toString('base64');
  const canny=await call('/api/gpu/controlnet/preprocess','POST',{type:'Canny',prepared:false,width:256,height:256,image:ref});assert.equal(canny.status,200,JSON.stringify(canny.body));
  const common={kind:'text2img',mode:'text2img',prompt:'  amber_character, white sweater\n(red heart:1.2)  ',negative_prompt:'  blur, green eyes  ',checkpoint_id:checkpoint.id,vae_id:'auto',lora_adapters:loras.map((l,i)=>({id:l.id,weight:i?.8:1.15})),width:256,height:256,steps:4,cfg_scale:5,sampler:'Euler',scheduler:'Normal',seed:123,batch_size:1,controlnet_config:{enabled:false},regions:[]};
  const variants=[{}, {mode:'img2img',kind:'img2img',init_image:source,denoising_strength:.5}, ...['Canny','OpenPose','Depth'].map(type=>({controlnet_config:{enabled:true,type,map_type:type,image:canny.body.image,strength:.8,start:0,end:1}})), {lora_adapters:[],regions:[{name:'A',enabled:true,lora_id:loras[0].id,trigger:'amber_character',prompt:'purple bat',negative_prompt:'orange fox',weight:1.15,mask:source}]}];
  for(const v of variants){const r=await call('/api/gpu/generate','POST',{...common,...v});assert.equal(r.status,201,JSON.stringify(r.body));let job;
   for(let k=0;k<100;k++){await app.pollJobs();job=(await call('/api/gpu/jobs/'+r.body.id)).body;if(['COMPLETED','FAILED'].includes(job.status))break;await new Promise(r=>setTimeout(r,20))}assert.equal(job.status,'COMPLETED',JSON.stringify(job));}
  await app.pollJobs();assert.equal((await call('/api/gallery')).body.items.length,6);
  const seen=(await fs.readFile(path.join(dir,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(seen.length,6);assert(seen.every(r=>r.prompt===common.prompt&&r.negative_prompt===common.negative_prompt));assert.deepEqual(seen[0].lora_adapters,common.lora_adapters);
  assert(!calls.some(p=>p.startsWith('/sync/')||p.startsWith('/inventory')));
  await call('/api/drive/library/check','POST',{});let library=(await call('/api/drive/library')).body;assert.equal(library.gpu.models_stale,false);assert.equal(library.comparison.counts.INSTALLED,1);assert.notEqual(library.comparison.rows.find(r=>r.name==='ghost.safetensors').category,'INSTALLED');
  stale=true;await call('/api/gpu/status?models=1');library=(await call('/api/drive/library')).body;assert.equal(library.gpu.models_stale,true);assert.equal(library.comparison.gpu_only.length,0);assert.equal(library.comparison.counts.INSTALLED,0);
  await call('/api/gpu/disconnect','POST');library=(await call('/api/drive/library')).body;assert.equal(library.gpu.connected,false);assert.equal(library.comparison.counts.INSTALLED,0);
 }finally{if(app)await app.close();const exited=new Promise(r=>proc.once('exit',r));proc.kill();if(proc.exitCode===null)await exited;await fs.rm(dir,{recursive:true,force:true})}
});

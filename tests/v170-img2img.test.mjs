// v1.7.0: Img2Img transport. Real local Node app + synthetic GPU upstream (NOT GPU inference).
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {createLocalApp} from '../server/app.mjs';import {validateGeneration,validateHealth} from '../server/upstream.mjs';import {engineCompatibility} from '../server/release.mjs';import {compactSourceRequest,denoiseSteps} from '../server/img2img.mjs';
const token='d'.repeat(64),url='https://unit-test.trycloudflare.com/#token='+token,mid='b'.repeat(32),lid='c'.repeat(32);
const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'TEST DOUBLE',vram_total_mb:15360,vram_available_mb:12000};
const models=[{id:mid,name:'x.safetensors',kind:'checkpoint',architecture:'SDXL',size_bytes:1,compatible:true},{id:lid,name:'style.safetensors',kind:'lora',architecture:'SDXL',size_bytes:1,compatible:true}];
const IMG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=';
const png=Buffer.from(IMG.split(',')[1],'base64');
const t2i={kind:'text2img',mode:'text2img',prompt:'fox',negative_prompt:'blur',checkpoint_id:mid,vae_id:'auto',lora_adapters:[{id:lid,weight:.7}],width:832,height:1216,steps:30,cfg_scale:5,sampler:'DPM++ 2M',scheduler:'Karras',seed:7,batch_size:2,regions:[],controlnet_config:{enabled:false}};
const i2i={...t2i,kind:'img2img',mode:'img2img',init_image:IMG,denoising_strength:.45};
async function harness(upstream){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-v170-'));const app=await createLocalApp({dataDir,distDir:path.resolve('dist'),upstream});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const root='http://127.0.0.1:'+app.server.address().port;
 const s=await fetch(root+'/api/session',{headers:{'X-Yoisaki-Local':'1'}});const cookie=s.headers.get('set-cookie').split(';')[0];
 const call=async(route,method='GET',body)=>{const r=await fetch(root+route,{method,headers:{'X-Yoisaki-Local':'1',Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()}};
 return {app,call,close:async()=>{await app.close();await fs.rm(dataDir,{recursive:true,force:true})}};
}

test('validation: Img2Img fields are required and bounded; Text2Img requests stay byte-identical',()=>{
 const v=validateGeneration(i2i,models);assert.equal(v.init_image,IMG);assert.equal(v.denoising_strength,.45);assert.equal(v.mode,'img2img');
 const plain=validateGeneration(t2i,models);assert.deepEqual(Object.keys(plain),Object.keys(validateGeneration({...t2i},models)));assert(!('init_image' in plain)&&!('denoising_strength' in plain));
 assert.equal(JSON.stringify(plain),JSON.stringify(Object.fromEntries(Object.keys(plain).map(k=>[k,t2i[k]]))));
 for(const bad of [{init_image:undefined},{init_image:'data:image/gif;base64,R0lGOD'},{init_image:'x'.repeat(10)},{denoising_strength:0},{denoising_strength:1.01},{denoising_strength:NaN},{denoising_strength:'0.5'},{denoising_strength:true},{steps:10,denoising_strength:.05},{kind:'text2img'},{mode:'not-a-mode',kind:'not-a-mode'}])
  assert.throws(()=>validateGeneration({...i2i,...bad},models),/INVALID|Img2Img|Неподдерживаемые|Denoise/i,JSON.stringify(bad).slice(0,80));
 for(const bad of [{init_image:IMG},{denoising_strength:.5}])assert.throws(()=>validateGeneration({...t2i,...bad},models),/только в режиме Img2Img/);
 assert.equal(denoiseSteps(30,.45),13);assert.equal(denoiseSteps(20,.55),11);assert.equal(denoiseSteps(10,1),10);assert.equal(denoiseSteps(10,.05),0);
});

test('only an engine 1.7.0 declaring Img2Img is compatible',()=>{
 assert.equal(validateHealth(health),health);assert.equal(engineCompatibility(health),'COMPATIBLE');
 for(const old of [{...health,engine_version:'1.6.2',capabilities:{controlnet:true,sdpose:true,regional_control:true}},{...health,capabilities:{controlnet:true,sdpose:true}}]){
  assert.throws(()=>validateHealth(old),/Требуется YOISAKI ENGINE v1\.7\.0/);assert.equal(engineCompatibility(old),'UNVERIFIED');
 }
});

test('history and gallery keep a digest of the source, never the base64 image',()=>{
 const c=compactSourceRequest(i2i);assert(!('init_image' in c));assert.equal(c.init_image_length,IMG.length);assert.match(c.init_image_sha256,/^[a-f0-9]{64}$/);assert.equal(c.denoising_strength,.45);
 assert.equal(compactSourceRequest(t2i),t2i);
});

test('route: Img2Img reaches the engine with all parameters, result lands in the gallery and is acknowledged',async()=>{
 const sent=[];const acks=[];let status={};
 const h=await harness(async(c,p,o={})=>{if(p==='/health')return health;if(p==='/models')return {models};
  if(p==='/generate'){const x=JSON.parse(o.body);sent.push(x);status[x.client_request_id]={id:x.client_request_id,status:'RUNNING',progress:{step:3,total_steps:13,stage:'GENERATING',percent:23}};return {id:x.client_request_id,status:'QUEUED'}}
  if(p.endsWith('/ack')){acks.push(p);return {ok:true}}
  if(p.startsWith('/results/'))return png;
  const id=p.split('/').pop();if(status[id])return status[id];throw Error(p)});
 try{
  await h.call('/api/gpu/connect','POST',{url});
  const id=randomUUID();
  let r=await h.call('/api/gpu/generate','POST',{...i2i,client_request_id:id});
  assert.equal(r.status,201,JSON.stringify(r.body));
  const x=sent.at(-1);assert.equal(x.mode,'img2img');assert.equal(x.kind,'img2img');assert.equal(x.init_image,IMG);assert.equal(x.denoising_strength,.45);
  for(const k of ['prompt','negative_prompt','seed','steps','cfg_scale','sampler','scheduler','width','height','batch_size'])assert.equal(x[k],i2i[k],k);
  assert.deepEqual(x.lora_adapters,[{id:lid,weight:.7}]);
  let job=(await h.call('/api/history')).body.items.find(j=>j.id===id);
  assert(!('init_image' in job.request));assert.equal(job.request.init_image_length,IMG.length);assert(!JSON.stringify(h.app.store.data).includes(IMG.split(',')[1]),'base64 source stored locally');
  await h.app.pollJobs();job=(await h.call('/api/history')).body.items.find(j=>j.id===id);assert.equal(job.progress.total_steps,13);
  status[id]={id,status:'COMPLETED',progress:{step:13,total_steps:13,stage:'DONE',percent:100},result:{seed:7,image_keys:['0','1']}};
  await h.app.pollJobs();
  const gallery=(await h.call('/api/gallery')).body.items.filter(g=>g.job_id===id);
  assert.equal(gallery.length,2);for(const g of gallery){assert.equal(g.parameters.mode,'img2img');assert.equal(g.parameters.denoising_strength,.45);assert(!('init_image' in g.parameters));assert.equal(g.seed,7)}
  await h.app.pollJobs();assert.deepEqual(acks,['/jobs/'+id+'/ack'],'1.7.0 results must be acknowledged so the engine can free its disk');
  // Text2Img afterwards: unchanged request shape.
  r=await h.call('/api/gpu/generate','POST',{...t2i,client_request_id:randomUUID()});assert.equal(r.status,201);assert(!('init_image' in sent.at(-1))&&!('denoising_strength' in sent.at(-1)));
  // Engine-side rejection text reaches the page.
  r=await h.call('/api/gpu/generate','POST',{...i2i,denoising_strength:.01,client_request_id:randomUUID()});assert.equal(r.status,400);assert.match(JSON.stringify(r.body),/ни одного шага/);
 }finally{await h.close()}
});

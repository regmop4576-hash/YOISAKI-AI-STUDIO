// Synthetic engine 1.8.1 / API 1.7.0. These are local transport/state tests, not T4 inference.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createLocalApp} from '../server/app.mjs';
import {AppError} from '../server/errors.mjs';
import {pruneHistory} from '../server/history.mjs';
const origin='https://stability.trycloudflare.com';
const health={engine:'YOISAKI_ENGINE',engine_version:'1.8.1',api_version:'1.7.0',capabilities:{regional_control:true,controlnet:true,sdpose:true,img2img:true,result_ack:true},state:'READY',gpu_name:'SYNTHETIC',vram_total_mb:16000,vram_available_mb:14000};
const model={id:'b'.repeat(32),name:'TEST',kind:'checkpoint',architecture:'SDXL',compatible:true,size_bytes:1};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=','base64');
const request=()=>({client_request_id:randomUUID(),kind:'text2img',mode:'text2img',prompt:'  untouched,\n'+ 'длинный prompt '.repeat(100),negative_prompt:'  no hidden tags\n',checkpoint_id:model.id,vae_id:'auto',lora_adapters:[],width:512,height:512,steps:35,cfg_scale:5,sampler:'Euler',scheduler:'Normal',seed:123,batch_size:1,regions:[],controlnet_config:{enabled:false}});
async function harness(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'v192-'));
 const gpu={outage:false,submitTimeout:false,resultOutage:false,remote:'RUNNING',posts:[],deletes:0,acks:0,progress:{step:33,total_steps:35,percent:94,stage:'GENERATING'}};
 const upstream=async(c,p,o={})=>{
  if(gpu.outage)throw new AppError('TUNNEL_OFFLINE','Synthetic disconnected Colab',502);
  if(p==='/health')return {...health,state:gpu.posts.length&&gpu.remote==='RUNNING'?'BUSY':'READY'};
  if(p==='/models')return {models:[model]};
  if(p==='/generate'){const r=JSON.parse(o.body);gpu.posts.push(r);if(gpu.submitTimeout)throw new AppError('CONNECTION_TIMEOUT','Synthetic lost acknowledgement',504);return {id:r.client_request_id,status:'QUEUED'}}
  if(p.endsWith('/ack')){gpu.acks++;return {ok:true}}
  if(p.startsWith('/results/')){if(gpu.resultMissing)throw new AppError('JOB_NOT_FOUND','Synthetic result not yet available',502);if(gpu.resultOutage)throw new AppError('UPSTREAM_INTERRUPTED','Synthetic interrupted PNG',502);return png}
  if(o.method==='DELETE'){gpu.deletes++;gpu.remote='CANCELLED';return {status:'CANCELLED'}}
  if(p.startsWith('/jobs/')){if(gpu.gate)await gpu.gate;return {id:p.split('/').pop(),status:gpu.remote,progress:gpu.progress,...(gpu.remote==='COMPLETED'?{result:{image_keys:['0'],seed:123}}:{})};}
  throw Error(p);
 };
 let app,base,cookie;
 const start=async()=>{app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),upstream,autoResume:false});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;cookie=(await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}})).headers.get('set-cookie').split(';')[0]};
 await start();
 const call=async(p,method='GET',body)=>{const r=await fetch(base+p,{method,headers:{Cookie:cookie,'X-Yoisaki-Local':'1','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()}};
 return {gpu,call,get app(){return app},connect:async()=>{const r=await call('/api/gpu/connect','POST',{url:origin+'/#token='+'a'.repeat(64)});assert.equal(r.status,200,JSON.stringify(r.body));return r},restart:async()=>{await app.close();await start()},close:async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true})}};
}
test('loss at 33/35 invalidates BUSY, retains progress, recovers result once without resubmitting',async()=>{
 const h=await harness();try{await h.connect();const req=request();await h.call('/api/gpu/generate','POST',req);await h.app.pollJobs();
  h.gpu.outage=true;await h.app.pollJobs();const snap=h.app.status();assert.notEqual(snap.state,'BUSY');assert(snap.last_seen_at>0);assert.equal(snap.info,null);assert.notEqual(snap.components.gpu,'READY');
  let j=(await h.call('/api/history')).body.items[0];assert.equal(j.status,'CONNECTION_LOST');assert.equal(j.terminal,false);assert.equal(j.progress.step,33);assert(j.last_confirmed_at>0);
  h.gpu.outage=false;h.gpu.remote='COMPLETED';await h.app.pollJobs();await h.app.pollJobs();
  j=(await h.call('/api/history')).body.items[0];assert.equal(j.status,'COMPLETED');assert.equal(j.connection_error,undefined);assert.equal(h.app.store.data.gallery.length,1);assert.equal(h.gpu.posts.length,1);assert.equal(h.gpu.posts[0].prompt,req.prompt);assert.equal(h.gpu.acks,1);
 }finally{await h.close()}
});
test('explicit local deletion works offline, is persistent and never sends remote cancellation',async()=>{
 const h=await harness();try{await h.connect();const req=request();await h.call('/api/gpu/generate','POST',req);await h.app.pollJobs();h.gpu.outage=true;await h.app.pollJobs();
  const r=await h.call('/api/history/'+req.client_request_id+'?local=1','DELETE');assert.equal(r.status,200);assert.equal(r.body.items.length,0);assert.equal(h.gpu.deletes,0);
  await h.restart();h.gpu.outage=false;await h.connect();await h.app.pollJobs();assert.equal(h.app.store.data.history.length,0);assert.equal(h.gpu.posts.length,1);
 }finally{await h.close()}
});
test('ambiguous submission returns tracked job; duplicate client ID is never posted again',async()=>{
 const h=await harness();try{await h.connect();h.gpu.submitTimeout=true;const req=request();const r=await h.call('/api/gpu/generate','POST',req);assert.equal(r.status,202);assert.equal(r.body.id,req.client_request_id);assert.equal(r.body.status,'CONNECTION_LOST');
  h.gpu.submitTimeout=false;await h.call('/api/gpu/status');await h.call('/api/gpu/generate','POST',req);assert.equal(h.gpu.posts.length,1);await h.app.pollJobs();assert.equal(h.app.store.data.history.length,1);
 }finally{await h.close()}
});
test('waiting job cancellation is confirmed by GPU; interrupted result download resumes after restart',async()=>{
 const h=await harness();try{await h.connect();let req=request();await h.call('/api/gpu/generate','POST',req);assert.equal((await h.call('/api/gpu/jobs/'+req.client_request_id,'DELETE')).body.status,'CANCELLED');assert.equal(h.gpu.deletes,1);
  req=request();await h.call('/api/gpu/generate','POST',req);h.gpu.remote='COMPLETED';h.gpu.resultOutage=true;await h.app.pollJobs();assert.equal(h.gpu.acks,0);assert.equal(h.app.store.data.gallery.length,0);
  await h.restart();h.gpu.resultOutage=false;await h.connect();await h.app.pollJobs();await h.app.pollJobs();assert.equal(h.app.store.data.gallery.length,1);assert.equal(h.gpu.posts.length,2);assert.equal(h.gpu.acks,1);
 }finally{await h.close()}
});
test('duplicate persisted IDs are consolidated without dropping distinct unresolved jobs',()=>{
 const a={id:'same',status:'CONNECTION_LOST',updated:1},b={...a,updated:2,progress:{step:33}};
 const rows=pruneHistory([a,b,{id:'other',status:'CONNECTION_LOST'}]);assert.equal(rows.length,2);assert.equal(rows.find(x=>x.id==='same').progress.step,33);
});
test('generation remains tracked for more than 20 seconds, then saves completion (synthetic)',async()=>{
 const h=await harness();try{await h.connect();const req=request();await h.call('/api/gpu/generate','POST',req);await new Promise(r=>setTimeout(r,21000));
  assert.equal(h.app.store.data.history[0].status,'RUNNING');assert.equal(h.gpu.posts.length,1);h.gpu.remote='COMPLETED';await h.app.pollJobs();assert.equal(h.app.store.data.gallery.length,1);
 }finally{await h.close()}
});
test('health failure invalidates job confirmation; stale connection is never advertised READY',async()=>{
 const h=await harness();const now=Date.now;try{await h.connect();const req=request();await h.call('/api/gpu/generate','POST',req);await h.app.pollJobs();
  h.gpu.outage=true;await h.call('/api/gpu/status');assert.equal(h.app.store.data.history[0].status,'CONNECTION_LOST');assert.notEqual(h.app.status().components.gpu,'READY');
  h.gpu.outage=false;await h.call('/api/gpu/status');Date.now=()=>now()+46000;const s=h.app.status();assert.equal(s.state,'ERROR');assert.equal(s.code,'CONNECTION_STALE');assert.equal(s.info,null);assert.notEqual(s.components.gpu,'READY');
 }finally{Date.now=now;await h.close()}
});
test('local deletion during in-flight recovery never resurrects a job or downloads its result',async()=>{
 const h=await harness();let release;try{await h.connect();const req=request();await h.call('/api/gpu/generate','POST',req);h.gpu.outage=true;await h.app.pollJobs();h.gpu.outage=false;h.gpu.remote='COMPLETED';
  h.gpu.gate=new Promise(r=>{release=r});const polling=h.app.pollJobs();assert.equal((await h.call('/api/history/'+req.client_request_id+'?local=1','DELETE')).status,200);release();await polling;
  assert.equal(h.app.store.data.history.length,0);assert.equal(h.app.store.data.gallery.length,0);assert.equal(h.gpu.deletes,0);assert.equal(h.gpu.acks,0);
 }finally{release?.();await h.close()}
});
test('temporary result 404 does not terminate a remotely completed job',async()=>{
 const h=await harness();try{await h.connect();await h.call('/api/gpu/generate','POST',request());h.gpu.remote='COMPLETED';h.gpu.resultMissing=true;await h.app.pollJobs();assert.equal(h.app.store.data.history[0].status,'CONNECTION_LOST');
  h.gpu.resultMissing=false;await h.app.pollJobs();assert.equal(h.app.store.data.history[0].status,'COMPLETED');assert.equal(h.app.store.data.gallery.length,1);assert.equal(h.gpu.posts.length,1);
 }finally{await h.close()}
});

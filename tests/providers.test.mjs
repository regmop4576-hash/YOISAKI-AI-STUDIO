// Real local HTTP + synthetic upstream. No GPU claims.
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createLocalApp} from '../server/app.mjs';import {parseTunnel,requestUpstream,validateHealth} from '../server/upstream.mjs';
const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'TEST ONLY',vram_total_mb:100,vram_available_mb:90};
const tokens={colab:'a'.repeat(64),cloudcompute:'b'.repeat(64)};
const urls={colab:'https://colab-test.trycloudflare.com',cloudcompute:'https://compute.example.com'};
async function harness(upstream,dir){dir||=await fs.mkdtemp(path.join(os.tmpdir(),'providers-'));const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),upstream});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;const session=await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}});const cookie=session.headers.get('set-cookie').split(';')[0];
 const call=async(route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'X-Yoisaki-Local':'1',cookie,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});return {status:r.status,...await r.json()}};return {app,dir,call};}
const link=p=>({provider:p,url:urls[p]+'/#token='+tokens[p]});
test('both providers: separate endpoints, explicit reconnect, no secrets on disk/export/status, persistent selection',async()=>{
 const calls=[];const upstream=async(c,p)=>{calls.push([c.provider,c.origin,c.token,p]);assert.equal(c.token,tokens[c.provider]);assert.equal(c.origin,urls[c.provider]);return p==='/health'?health:{models:[]}};
 let h=await harness(upstream);const dir=h.dir;
 try{
  assert.equal((await h.call('/api/gpu/status')).state,'OFFLINE');assert.equal(calls.length,0);
  assert.equal((await h.call('/api/gpu/connect',link('colab'))).state,'READY');
  let x=await h.call('/api/gpu/provider',{provider:'cloudcompute'});assert.equal(x.provider,'cloudcompute');assert.equal(x.state,'OFFLINE');assert.equal(x.info,null);assert.equal(x.endpoints.colab,urls.colab);
  const before=calls.length;await h.call('/api/gpu/status');assert.equal(calls.length,before);
  assert.equal((await h.call('/api/gpu/connect',{provider:'cloudcompute',url:urls.cloudcompute})).code,'INVALID_TOKEN');
  assert.equal((await h.call('/api/gpu/connect',link('cloudcompute'))).state,'READY');
  x=await h.call('/api/gpu/provider',{provider:'colab'});assert.equal(x.endpoints.cloudcompute,urls.cloudcompute);assert.equal(x.info,null);
  assert.equal((await h.call('/api/gpu/connect',link('cloudcompute'))).code,'PROVIDER_CHANGED');
  await h.call('/api/gpu/connect',link('colab'));await h.call('/api/gpu/provider',{provider:'cloudcompute'});
  const surfaces=JSON.stringify([await h.call('/api/gpu/status'),await h.call('/api/diagnostics'),await h.call('/api/settings'),await fs.readFile(path.join(dir,'state.json'),'utf8'),await fs.readFile(path.join(dir,'state.json.bak'),'utf8')]);
  for(const token of Object.values(tokens))assert(!surfaces.includes(token));
  await h.app.close();const n=calls.length;h=await harness(upstream,dir);x=await h.call('/api/gpu/status');assert.equal(x.provider,'cloudcompute');assert.equal(x.state,'OFFLINE');assert.deepEqual(x.endpoints,urls);assert.equal(calls.length,n);
  const v=await h.call('/api/version');assert.equal(v.studio_version,'1.9.0');assert.equal(v.engine_version,null);
 }finally{await h.app.close();await fs.rm(dir,{recursive:true,force:true})}
});
test('late health from a disconnected provider cannot revive a session',async()=>{
 let release,entered;const pending=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const h=await harness(async(c,p)=>{if(p==='/health'){entered();await pending;return health}return {models:[]}});
 try{const first=h.call('/api/gpu/connect',link('colab'));await started;await h.call('/api/gpu/provider',{provider:'cloudcompute'});release();assert.equal((await first).code,'SUPERSEDED');const x=await h.call('/api/gpu/status');assert.equal(x.provider,'cloudcompute');assert.equal(x.state,'OFFLINE');assert.equal(x.info,null)}finally{release();await h.app.close();await fs.rm(h.dir,{recursive:true,force:true})}
});
test('CloudCompute public HTTPS policy keeps DNS pinning and rejects private hosts / credentials / redirects',async()=>{
 assert.equal(parseTunnel(link('cloudcompute').url,'cloudcompute').origin,urls.cloudcompute);
 for(const origin of ['http://compute.example.com','https://127.0.0.1','https://user:password@compute.example.com','https://compute.example.com:444','https://compute.example.com/path','https://compute.example.com?token=bad'])assert.throws(()=>parseTunnel(origin+'/#token='+tokens.cloudcompute,'cloudcompute'));
 assert.throws(()=>parseTunnel(link('cloudcompute').url,'colab'));
 await assert.rejects(()=>requestUpstream(parseTunnel(link('cloudcompute').url,'cloudcompute'),'/health',{lookup:async()=>[{address:'192.168.1.1',family:4}]}),e=>e.code==='PRIVATE_DESTINATION');
});
test('API metadata is independent; legacy health and missing hardware supported without fabricated values',()=>{
 assert.equal(validateHealth({...health,gpu_name:null,vram_total_mb:null,vram_available_mb:null}).gpu_name,null);
 const legacy={...health};delete legacy.api_version;assert.equal(validateHealth(legacy).api_version,undefined);
 assert.throws(()=>validateHealth({...health,api_version:'2.0.0'}));assert.throws(()=>validateHealth({...health,vram_available_mb:-1}));
});
test('late refresh cannot adopt a different provider session',async()=>{
 let delayed=false,releaseRefresh,enteredRefresh;const waiting=new Promise(r=>releaseRefresh=r),started=new Promise(r=>enteredRefresh=r);
 const h=await harness(async(c,p)=>{if(p==='/health'){if(delayed&&c.provider==='colab'){enteredRefresh();await waiting}return {...health,gpu_name:c.provider}}return {models:[]}});
 try{await h.call('/api/gpu/connect',link('colab'));delayed=true;const old=h.call('/api/gpu/status');await started;await h.call('/api/gpu/provider',{provider:'cloudcompute'});await h.call('/api/gpu/connect',link('cloudcompute'));releaseRefresh();await old;const x=await h.call('/api/gpu/status');assert.equal(x.provider,'cloudcompute');assert.equal(x.info.gpu_name,'cloudcompute');assert.equal(x.state,'READY')}finally{releaseRefresh();await h.app.close();await fs.rm(h.dir,{recursive:true,force:true})}
});
test('history cancellation never forwards an old-provider job to the new engine',async()=>{
 const calls=[];const h=await harness(async(c,p)=>{calls.push([c.provider,p]);return p==='/health'?health:{models:[]}});const id='11111111-1111-4111-8111-111111111111';
 try{await h.call('/api/gpu/connect',link('colab'));await h.app.store.change(d=>d.history.push({id,provider:'colab',origin:urls.colab,status:'RUNNING',created:Date.now(),request:{}}));await h.call('/api/gpu/provider',{provider:'cloudcompute'});await h.call('/api/gpu/connect',link('cloudcompute'));
  // HTTP DELETE through the actual local API, with its normal authenticated session.
  const base='http://127.0.0.1:'+h.app.server.address().port;const session=await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}});const r=await fetch(base+'/api/gpu/jobs/'+id,{method:'DELETE',headers:{'X-Yoisaki-Local':'1',cookie:session.headers.get('set-cookie').split(';')[0]}});assert.equal(r.status,409);assert(!calls.some(([,p])=>p.includes(id)));
 }finally{await h.app.close();await fs.rm(h.dir,{recursive:true,force:true})}
});

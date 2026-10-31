// v1.6.1 regressions: AUD-002 storage, AUD-006 resumable preprocessing, AUD-009 error detail.
// Real local Node app + synthetic GPU upstream (NOT GPU inference).
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';import {EventEmitter} from 'node:events';
import {createLocalApp} from '../server/app.mjs';import {Store} from '../server/storage.mjs';import {requestUpstream,parseTunnel} from '../server/upstream.mjs';import {compactControlRequest} from '../server/controlnet.mjs';
const token='d'.repeat(64),url='https://unit-test.trycloudflare.com/#token='+token,mid='b'.repeat(32);
const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'TEST DOUBLE',vram_total_mb:15360,vram_available_mb:12000};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=','base64');
const MAP='data:image/png;base64,'+'A'.repeat(2_800_000); // ~2.1 MB decoded, as in the audit scenario
const request=(id,extra={})=>({client_request_id:id,kind:'text2img',mode:'text2img',prompt:'fox '+id.slice(0,4),negative_prompt:'blur',checkpoint_id:mid,vae_id:'auto',lora_adapters:[],width:1024,height:1024,steps:2,cfg_scale:5,sampler:'Euler',scheduler:'Normal',seed:7,batch_size:1,regions:[],controlnet_config:{enabled:true,type:'Depth',map_type:'Depth',image:MAP,strength:1,start:0,end:1},...extra});
async function harness(upstream,dir){
 const dataDir=dir||await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-v161-'));const app=await createLocalApp({dataDir,distDir:path.resolve('dist'),upstream});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const s=await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}});const cookie=s.headers.get('set-cookie').split(';')[0];
 const call=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'X-Yoisaki-Local':'1',Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const text=await r.text();let json;try{json=JSON.parse(text)}catch{}return {status:r.status,body:json,bytes:text.length}};
 return {app,dataDir,call,close:()=>app.close()};
}
const fakeGpu=(sent=[])=>async(c,p,o={})=>{if(p==='/health')return health;if(p==='/models')return {models:[{id:mid,name:'x.safetensors',kind:'checkpoint',architecture:'SDXL',size_bytes:1,compatible:true}]};
 if(p==='/generate'){const x=JSON.parse(o.body);sent.push(x);return {id:x.client_request_id,status:'QUEUED'}}
 const m=p.match(/^\/jobs\/([a-f0-9-]{36})$/);if(m)return {id:m[1],status:'COMPLETED',result:{image_keys:['0'],seed:7},progress:{stage:'DONE'}};
 if(p.startsWith('/results/'))return png;if(p.endsWith('/ack'))return {ok:true};throw Error('route '+p)};

test('AUD-002: 12 ControlNet jobs with ~2 MB maps do not grow state/history/gallery with base64 copies',async()=>{
 const sent=[];const h=await harness(fakeGpu(sent));
 try{
  assert.equal((await h.call('/api/gpu/connect','POST',{url})).body.state,'READY');
  for(let i=0;i<12;i++){const r=await h.call('/api/gpu/generate','POST',request(randomUUID()));assert.equal(r.status,201);await h.app.pollJobs()}
  await h.app.pollJobs();
  assert.equal(sent.length,12);assert(sent.every(x=>x.controlnet_config.image===MAP),'GPU must still receive the full map');
  const state=(await fs.stat(path.join(h.dataDir,'state.json'))).size,bak=(await fs.stat(path.join(h.dataDir,'state.json.bak'))).size;
  const history=await h.call('/api/history'),gallery=await h.call('/api/gallery');
  console.log(`state.json=${state} B, .bak=${bak} B, /api/history=${history.bytes} B, /api/gallery=${gallery.bytes} B (v1.6.0 audit: 58.8 MB / 58.8 MB / 33.6 MB / 25.2 MB)`);
  for(const n of [state,bak,history.bytes,gallery.bytes])assert(n<200_000,'payload grows with control maps: '+n);
  assert.equal(history.body.items.length,12);assert.equal(gallery.body.items.length,12);
  const digest=createHash('sha256').update(MAP).digest('hex');
  for(const j of history.body.items){assert.equal(j.status,'COMPLETED');const c=j.request.controlnet_config;assert.equal(c.image,undefined);assert.deepEqual([c.enabled,c.type,c.map_type,c.strength,c.start,c.end,c.image_sha256,c.image_length],[true,'Depth','Depth',1,0,1,digest,MAP.length]);assert.equal(j.request.seed,7);assert.match(j.request.prompt,/^fox /)}
  for(const g of gallery.body.items){assert.equal(g.parameters.controlnet_config.image,undefined);assert.equal(g.parameters.controlnet_config.image_sha256,digest);assert.equal((await h.call(g.url)).status,200)}
 }finally{await h.close()}
});

test('AUD-002: idempotent retry with the same request ID is not a conflict after compact storage',async()=>{
 const h=await harness(fakeGpu());
 try{await h.call('/api/gpu/connect','POST',{url});const id=randomUUID();
  assert.equal((await h.call('/api/gpu/generate','POST',request(id))).status,201);
  const again=await h.call('/api/gpu/generate','POST',request(id));assert.equal(again.status,201);assert.equal(again.body.id,id);
  const changed=await h.call('/api/gpu/generate','POST',request(id,{controlnet_config:{...request(id).controlnet_config,image:MAP+'AAAA'}}));assert.equal(changed.status,409);
 }finally{await h.close()}
});

test('AUD-002: existing v1.6.0 state.json migrates without data loss; original kept as backup',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-v160-state-'));await fs.mkdir(path.join(dir,'images'),{recursive:true});
 const ids=[randomUUID(),randomUUID(),randomUUID()];
 const old={version:1,settings:{state:{settings:{controlStrength:1,controlType:'Canny'},presets:[{id:'p1',name:'Мой пресет',version:1,settings:{prompt:'x'}}],language:'Русский'},version:2},models:[{id:mid,name:'x',kind:'checkpoint'}],tags:{[mid]:{model_id:mid,trigger_words:['vesperfox'],recommended_tags:[],description:''}},preferences:{last_host:'https://unit-test.trycloudflare.com'},
  history:ids.map((id,i)=>({id,status:i===2?'FAILED':'COMPLETED',created:1000+i,updated:2000+i,origin:'https://unit-test.trycloudflare.com',request:request(id),...(i<2?{result:{image_keys:['0'],seed:7}}:{error:'x'})})),
  gallery:[...ids.slice(0,2).map(id=>({id:id+'_0',name:`yoisaki-${id}-0.png`,created:3000,favorite:true,prompt:'fox',origin:'generated',type:'image/png',job_id:id,seed:7,parameters:request(id),url:'/api/gallery/'+id+'_0/file'})),{id:randomUUID(),name:'imported.png',created:1,favorite:false,prompt:'',origin:'imported',type:'image/png',url:'/api/gallery/x/file'}]};
 for(const g of old.gallery)await fs.writeFile(path.join(dir,'images',g.id),png);
 const raw=JSON.stringify(old);await fs.writeFile(path.join(dir,'state.json'),raw);
 const s=await new Store(dir).init();
 assert.equal(s.data.history.length,3);assert.equal(s.data.gallery.length,3);
 assert.deepEqual(s.data.history.map(j=>[j.id,j.status,j.request.prompt,j.request.seed,j.result?.seed]),old.history.map(j=>[j.id,j.status,j.request.prompt,j.request.seed,j.result?.seed]));
 assert.deepEqual(s.data.gallery.map(g=>[g.id,g.favorite,g.seed,g.job_id]),old.gallery.map(g=>[g.id,g.favorite,g.seed,g.job_id]));
 assert.deepEqual(s.data.settings,old.settings);assert.deepEqual(s.data.tags,old.tags);assert.deepEqual(s.data.preferences,old.preferences);
 for(const j of s.data.history)assert.deepEqual(j.request,compactControlRequest(old.history.find(x=>x.id===j.id).request));
 assert.equal(await fs.readFile(path.join(dir,'state.json.v1.6.0-backup'),'utf8'),raw,'original v1.6.0 state must be preserved once');
 assert((await fs.stat(path.join(dir,'state.json'))).size<raw.length/100);
 for(const g of old.gallery)assert.deepEqual(await fs.readFile(path.join(dir,'images',g.id)),png);
 // Second start: nothing to migrate, backup untouched, no rewrite.
 const before=(await fs.stat(path.join(dir,'state.json'))).mtimeMs;await new Promise(r=>setTimeout(r,20));
 await new Store(dir).init();assert.equal((await fs.stat(path.join(dir,'state.json'))).mtimeMs,before);
 assert.equal(await fs.readFile(path.join(dir,'state.json.v1.6.0-backup'),'utf8'),raw);
 // Through the HTTP app: history and gallery load.
 const h=await harness(async()=>health,dir);try{assert.equal((await h.call('/api/history')).body.items.length,3);assert.equal((await h.call('/api/gallery')).body.items.length,3)}finally{await h.close()}
});

test('storage: an unchanged change() does not rewrite state.json or .bak',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-nochange-'));const s=await new Store(dir).init();await s.change(d=>{d.tags.a={x:1}});
 const m1=(await fs.stat(path.join(dir,'state.json'))).mtimeMs,m2=(await fs.stat(path.join(dir,'state.json.bak'))).mtimeMs;await new Promise(r=>setTimeout(r,20));
 await s.change(()=>{});await s.change(d=>{d.tags.a={x:1}});
 assert.equal((await fs.stat(path.join(dir,'state.json'))).mtimeMs,m1);assert.equal((await fs.stat(path.join(dir,'state.json.bak'))).mtimeMs,m2);
 await s.change(d=>{d.tags.b={x:2}});assert.equal((await new Store(dir).init()).data.tags.b.x,2);
});

test('AUD-006: PENDING preprocessing is passed through with a sub-100 s hop and resumed with the identical body',async()=>{
 const seen=[];let pending=2;
 const h=await harness(async(c,p,o={})=>{if(p==='/health')return health;if(p==='/models')return {models:[]};if(p==='/controlnet/preprocess'){seen.push([o.body,o.timeout]);const x=JSON.parse(o.body);return pending-->0?{status:'PENDING'}:{image:png.length?'data:image/png;base64,'+png.toString('base64'):'',type:x.type,width:x.width,height:x.height}}throw Error(p)});
 try{await h.call('/api/gpu/connect','POST',{url});const body={image:'data:image/png;base64,AAAA',type:'Depth',prepared:false,width:512,height:512};
  assert.deepEqual((await h.call('/api/gpu/controlnet/preprocess','POST',body)).body,{status:'PENDING'});
  assert.deepEqual((await h.call('/api/gpu/controlnet/preprocess','POST',body)).body,{status:'PENDING'});
  const done=await h.call('/api/gpu/controlnet/preprocess','POST',body);assert.equal(done.status,200);assert.equal(done.body.type,'Depth');
  assert.equal(new Set(seen.map(x=>x[0])).size,1,'identical body each hop');assert(seen.every(x=>x[1]<95000),'each hop below browser/Cloudflare limits');
 }finally{await h.close()}
});

function fakeTransport(status,payload){return (options,cb)=>{const req=new EventEmitter();req.end=()=>{const res=new EventEmitter();res.statusCode=status;res.headers={'content-type':'application/json'};cb(res);setImmediate(()=>{res.emit('data',Buffer.from(JSON.stringify(payload)));res.emit('end')})};req.destroy=()=>{};return req}}
test('AUD-009: engine rejection reasons for /generate reach the user, sanitised',async()=>{
 const c=parseTunnel(url),lookup=async()=>[{address:'1.1.1.1',family:4}];
 const detail=[{type:'value_error',loc:['body'],msg:'Value error, ControlNet: требуется 0 ≤ Start < End ≤ 1.',input:{secret:token}}];
 await assert.rejects(()=>requestUpstream(c,'/generate',{method:'POST',body:'{}',lookup,transport:fakeTransport(422,{detail})}),e=>e.code==='INVALID_PARAMETERS'&&e.message==='GPU отклонил задание: ControlNet: требуется 0 ≤ Start < End ≤ 1.'&&!e.message.includes(token));
 await assert.rejects(()=>requestUpstream(c,'/generate',{method:'POST',body:'{}',lookup,transport:fakeTransport(400,{detail:'Модель не найдена в /content/drive/MyDrive/models/x.safetensors token '+token})}),e=>!e.message.includes(token)&&!e.message.includes('/content/drive')&&e.message.includes('Модель не найдена'));
 await assert.rejects(()=>requestUpstream(c,'/generate',{method:'POST',body:'{}',lookup,transport:fakeTransport(429,{detail:'История сессии GPU заполнена непринятыми результатами.'})}),e=>e.status===409&&e.message.includes('непринятыми'));
 await assert.rejects(()=>requestUpstream(c,'/generate',{method:'POST',body:'{}',lookup,transport:fakeTransport(500,{detail:'Traceback (most recent call last)'})}),e=>!e.message.includes('Traceback'));
});

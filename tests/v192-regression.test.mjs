// v1.9.2 regression repair (Android report, 4 screenshots). Synthetic engine 1.8.1 / API 1.7.0:
// local server + state tests, not T4 inference. TEST_ROOT=<folder> runs the same tests against another build
// (used to show that they fail on the published build and on the earlier stability ZIP).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.env.TEST_ROOT||'.');
const load=p=>import(pathToFileURL(path.join(root,p)));
const {createLocalApp}=await load('server/app.mjs');
const {AppError}=await load('server/errors.mjs');
const regional=await load('src/lib/regional.ts');
const {controlError}=await load('src/lib/controlnet.ts');

const OLD='https://old-session.trycloudflare.com',NEW='https://new-session.trycloudflare.com';
const health={engine:'YOISAKI_ENGINE',engine_version:'1.8.1',api_version:'1.7.0',capabilities:{regional_control:true,controlnet:true,sdpose:true,img2img:true,result_ack:true},state:'READY',gpu_name:'SYNTHETIC',vram_total_mb:16000,vram_available_mb:14000};
const model={id:'b'.repeat(32),name:'TEST',kind:'checkpoint',architecture:'SDXL',compatible:true,size_bytes:1};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=','base64');
// The four records from the Android screenshots (IDs keep the visible 8-character prefixes).
export const LOST_IDS=['add55d35','ee0ac494','e82d53d3','61c9fe82'].map((p,i)=>p+'-0000-4000-8000-00000000000'+i);
export const lostJob=(id,origin=OLD)=>({id,status:'CONNECTION_LOST',created:Date.now()-3600e3,updated:Date.now()-3600e3,origin,provider:'colab',connection_error:'Ожидается подтверждение GPU',last_confirmed_at:Date.now()-3600e3,progress:{step:15,total_steps:35,percent:43,stage:'GENERATING',elapsed_seconds:55},request:{prompt:'old prompt',width:512,height:512}});

async function harness(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'v192-regression-'));
 const gpu={outage:false,remote:'RUNNING',posts:[],deletes:0,jobGets:[],acks:0,gate:null};
 const upstream=async(c,p,o={})=>{
  if(gpu.outage)throw new AppError('TUNNEL_OFFLINE','Synthetic disconnected Colab',502);
  if(p==='/health')return health;
  if(p==='/models')return {models:[model]};
  if(p==='/generate'){const r=JSON.parse(o.body);gpu.posts.push(r);return {id:r.client_request_id,status:'QUEUED'}}
  if(p.endsWith('/ack')){gpu.acks++;return {ok:true}}
  if(p.startsWith('/results/'))return png;
  if(o.method==='DELETE'){gpu.deletes++;return {status:'CANCELLED'}}
  if(p.startsWith('/jobs/')){gpu.jobGets.push({origin:c.origin,id:p.split('/').pop()});if(gpu.gate)await gpu.gate;const id=p.split('/').pop();
   if(c.origin!==OLD||gpu.missing)throw new AppError('JOB_NOT_FOUND','Synthetic: unknown job in this GPU session',404);
   return {id,status:gpu.remote,progress:{step:35,total_steps:35,percent:100,stage:'GENERATING'},...(gpu.remote==='COMPLETED'?{result:{image_keys:['0'],seed:7}}:{})}}
  throw Error('unexpected '+p);
 };
 let app,base,cookie;
 const start=async()=>{app=await createLocalApp({dataDir:dir,distDir:path.join(root,'dist'),upstream,autoResume:false});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;cookie=(await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}})).headers.get('set-cookie').split(';')[0]};
 await start();
 const call=async(p,method='GET',body)=>{const r=await fetch(base+p,{method,headers:{Cookie:cookie,'X-Yoisaki-Local':'1','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json().catch(()=>({}))}};
 const seed=async(jobs,gallery=[])=>{await app.store.change(d=>{d.history=jobs;d.gallery=gallery})};
 const connect=async origin=>{const r=await call('/api/gpu/connect','POST',{url:origin+'/#token='+'a'.repeat(64)});assert.equal(r.status,200,JSON.stringify(r.body));return r};
 return {gpu,call,seed,connect,get app(){return app},restart:async()=>{await app.close();await start()},close:async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true})}};
}
const galleryItem={id:'keep-me_0',name:'keep.png',created:1,favorite:true,prompt:'kept',origin:'generated',type:'image/png',job_id:'keep-me',url:'/api/gallery/keep-me_0/file'};

/* ---------------- Defect 1 / 4: stale queue records ---------------- */
test('GPU READY at a new address does not adopt or poll jobs of an earlier GPU session',async()=>{
 const h=await harness();try{
  await h.seed(LOST_IDS.map(id=>lostJob(id)));await h.connect(NEW);await h.app.pollJobs();
  const st=(await h.call('/api/gpu/status')).body;assert.equal(st.state,'READY');
  const items=(await h.call('/api/history')).body.items;assert.equal(items.length,4);
  for(const j of items){assert.equal(j.status,'CONNECTION_LOST','not silently failed or completed');assert.equal(j.terminal,false);
   assert.equal(j.current_session,false,'record must be marked as belonging to an earlier GPU session');assert.equal(j.can_forget,true)}
  assert.deepEqual(h.gpu.jobGets,[],'no status query of a foreign job goes to the new GPU');assert.equal(h.gpu.deletes,0);assert.equal(h.gpu.posts.length,0);
 }finally{await h.close()}
});
test('"check and delete" with GPU of another session: explicit local removal, no GPU cancel, gallery kept',async()=>{
 const h=await harness();try{
  await h.seed([lostJob(LOST_IDS[0])],[galleryItem]);await h.connect(NEW);
  const check=await h.call('/api/history/'+LOST_IDS[0],'DELETE');assert.equal(check.status,409);assert.equal(check.body.code,'JOB_UNCONFIRMED');
  const local=await h.call('/api/history/'+LOST_IDS[0]+'?local=1','DELETE');assert.equal(local.status,200,JSON.stringify(local.body));
  assert.equal(local.body.items.length,0);assert.equal(h.gpu.deletes,0);assert.equal(h.app.store.data.gallery.length,1);
 }finally{await h.close()}
});
test('several stale records are removed together without GPU, persist after restart and never reappear',async()=>{
 const h=await harness();try{
  await h.seed(LOST_IDS.map(id=>lostJob(id)),[galleryItem]);
  const r=await h.call('/api/history/forget','POST',{ids:LOST_IDS});assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(r.body.removed,4);assert.equal(r.body.items.length,0);
  await h.restart();assert.equal((await h.call('/api/history')).body.items.length,0);
  await h.connect(OLD);await h.app.pollJobs();await h.app.pollJobs();
  assert.equal((await h.call('/api/history')).body.items.length,0,'removed records do not return from the old GPU session');
  assert.equal(h.gpu.deletes,0);assert.equal(h.gpu.posts.length,0);assert.equal(h.app.store.data.gallery.length,1);
 }finally{await h.close()}
});
test('bulk removal never forgets a job confirmed RUNNING in the current session',async()=>{
 const h=await harness();try{
  await h.seed([lostJob(LOST_IDS[0]),lostJob(LOST_IDS[1],OLD)]);await h.connect(OLD);await h.app.pollJobs();
  assert.equal(h.app.store.data.history.find(j=>j.id===LOST_IDS[1]).status,'RUNNING');
  const r=await h.call('/api/history/forget','POST',{ids:LOST_IDS.slice(0,2)});assert.equal(r.status,200);assert.equal(r.body.removed,0);assert.equal(r.body.skipped,2);
  assert.equal(h.app.store.data.history.length,2);
 }finally{await h.close()}
});
test('a removal racing with an in-flight poll does not bring the record back',async()=>{
 const h=await harness();try{
  await h.seed([lostJob(LOST_IDS[0])]);await h.connect(OLD);let release;h.gpu.gate=new Promise(r=>{release=r});h.gpu.remote='COMPLETED';
  const poll=h.app.pollJobs();await new Promise(r=>setTimeout(r,20));
  const r=await h.call('/api/history/forget','POST',{ids:[LOST_IDS[0]]});release();await poll;await h.app.pollJobs();
  assert.equal(r.status,200);assert.equal(h.app.store.data.history.length,0);assert.equal(h.app.store.data.gallery.length,0);
 }finally{await h.close()}
});
test('recovery: reconnecting to the same session collects the result once; nothing is generated again',async()=>{
 const h=await harness();try{
  await h.seed([lostJob(LOST_IDS[0])]);await h.connect(OLD);h.gpu.remote='COMPLETED';await h.app.pollJobs();await h.app.pollJobs();
  const j=(await h.call('/api/history')).body.items[0];assert.equal(j.status,'COMPLETED');assert.equal(j.current_session,true);
  assert.equal(h.app.store.data.gallery.length,1);assert.equal(h.gpu.posts.length,0,'no automatic re-generation');
 }finally{await h.close()}
});
test('a job unknown to the reconnected GPU becomes INTERRUPTED (closable), never re-sent',async()=>{
 const h=await harness();try{
  await h.seed([lostJob(LOST_IDS[0])]);h.gpu.missing=true;await h.connect(OLD);await h.app.pollJobs();
  const j=(await h.call('/api/history')).body.items[0];assert.equal(j.status,'INTERRUPTED');assert.equal(j.can_delete,true);assert.equal(h.gpu.posts.length,0);
 }finally{await h.close()}
});

/* ---------------- Defect 2 / 3: Regional Control ---------------- */
const {makeRegions,exportRegions,hasActiveRegions,normalizeRegional,regionalMode}=regional;
const tabs=v=>typeof regional.activeRegions==='function'?regional.activeRegions(v).length:v.regions.length;
const reload=v=>normalizeRegional(JSON.parse(JSON.stringify(v)));
// exportRegions draws masks with <canvas>; a minimal stand-in keeps this a pure state test.
globalThis.document??={createElement:()=>({getContext:()=>new Proxy({},{get:()=>()=>{}}),toDataURL:()=>'data:image/png;base64,AA=='})};
test('legacy saved "2 ПЕРСОНАЖА" with three stored regions shows and sends exactly two',()=>{
 const legacy={mode:'2 ПЕРСОНАЖА',regions:makeRegions(3)};const v=normalizeRegional(legacy);
 assert.equal(v.mode,'2 CHARACTERS');assert.equal(tabs(v),2);assert.equal(exportRegions(v,512,512).length,2);
 assert.equal(v.regions.length,3,'the third region is kept (inactive), not deleted');
});
test('OFF → 2 → 3 → 2 → OFF: tabs, masks and request regions agree; region C data survives',()=>{
 let v=normalizeRegional({mode:'OFF',regions:[]});const seq=[];
 const step=mode=>{v=reload(regionalMode(v,mode));seq.push([mode,tabs(v),exportRegions(v,512,512).length])};
 step('2 CHARACTERS');step('3 CHARACTERS');v.regions[2].prompt='third character';v.regions[2].lora_id='c'.repeat(32);
 step('2 CHARACTERS');step('OFF');
 assert.deepEqual(seq,[['2 CHARACTERS',2,2],['3 CHARACTERS',3,3],['2 CHARACTERS',2,2],['OFF',0,0]]);
 step('3 CHARACTERS');assert.equal(v.regions[2].prompt,'third character');assert.equal(v.regions[2].lora_id,'c'.repeat(32));
});
test('CUSTOM uses the configured number of regions',()=>{
 let v=regionalMode(normalizeRegional({mode:'OFF',regions:[]}),'2 CHARACTERS');v=reload(regionalMode(v,'CUSTOM'));
 assert.equal(tabs(v),2);assert.equal(exportRegions(v,512,512).length,2);
 v=reload(regionalMode(v,'3 CHARACTERS'));v=reload(regionalMode(v,'2 CHARACTERS'));v=reload(regionalMode(v,'CUSTOM'));
 assert.equal(tabs(v),2,'stored inactive third region does not silently become active');
});
test('disabled region is saved but not sent; OFF keeps all saved settings',()=>{
 let v=regionalMode(normalizeRegional({mode:'OFF',regions:[]}),'2 CHARACTERS');v.regions[1].enabled=false;v.regions[0].prompt='kept';
 assert.equal(exportRegions(v,512,512).length,1);v=reload(regionalMode(v,'OFF'));assert.deepEqual(exportRegions(v,512,512),[]);
 v=reload(regionalMode(v,'2 CHARACTERS'));assert.equal(v.regions[0].prompt,'kept');assert.equal(v.regions[1].enabled,false);
});
test('Regional OFF + ControlNet Depth/Canny/OpenPose allowed; Regional ON + ControlNet ON blocked',()=>{
 for(const type of ['Depth','Canny','OpenPose']){const s={controlEnabled:true,controlType:type,controlStrength:.8,controlStart:0,controlEnd:1},map={type,key:'k'};
  for(const mode of ['OFF','ВЫКЛ']){const v=normalizeRegional({mode,regions:makeRegions(3)});assert.equal(controlError(s,map,'k',hasActiveRegions(v)),'',type+' '+mode);assert.deepEqual(exportRegions(v,512,512),[])}
  const on=normalizeRegional({mode:'2 CHARACTERS',regions:makeRegions(2)});assert.match(controlError(s,map,'k',hasActiveRegions(on)),/Одновременная/);
  const allDisabled=normalizeRegional({mode:'2 CHARACTERS',regions:makeRegions(2).map(r=>({...r,enabled:false}))});assert.equal(controlError(s,map,'k',hasActiveRegions(allDisabled)),'');
 }
});

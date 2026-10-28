import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {createLocalApp} from '../server/app.mjs';import {Store} from '../server/storage.mjs';import {pruneHistory} from '../server/history.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=','base64');
const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'TEST',vram_total_mb:100,vram_available_mb:100};
const origin='https://test.trycloudflare.com';
const record=status=>({id:randomUUID(),status,created:Date.now(),updated:Date.now(),origin,request:{prompt:'private',steps:1}});
async function harness(dir,upstream=async(c,p)=>p==='/health'?health:p==='/models'?{models:[]}:p.endsWith('/ack')?{ok:true}:{id:p.split('/').pop(),status:'FAILED'}){
 const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),upstream});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const session=await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}}),cookie=session.headers.get('set-cookie').split(';')[0];
 const call=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'X-Yoisaki-Local':'1',Cookie:cookie,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 return {app,call,version:await session.json(),connect:()=>call('/api/gpu/connect','POST',{url:origin+'/#token='+'a'.repeat(64)})};
}
async function temp(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'history-test-'));try{await fn(dir)}finally{await fs.rm(dir,{recursive:true,force:true})}}
test('individual terminal deletion persists through reload/restart/reconnect; Gallery and all user data preserved',()=>temp(async dir=>{
 let h=await harness(dir);const rows=['COMPLETED','FAILED','INTERRUPTED','CANCELLED'].map(record);
 const protectedData={settings:{state:{settings:{prompt:'keep prompt',checkpoint:'keep',regional:{mask:'keep-mask'}},presets:['keep preset']}},tags:{x:{trigger_words:['keep trigger']}},models:[{id:'keep'}],preferences:{custom:'keep'}};
 await h.app.store.change(d=>Object.assign(d,protectedData,{history:rows}));const image={id:rows[0].id+'_0',favorite:true,prompt:'gallery prompt',parameters:{regional:{mask:'original'},loras:[1.15,.8]},type:'image/png'};await h.app.store.saveImage(image,png);
 for(const row of rows){assert.equal((await h.call('/api/history/'+row.id,'DELETE')).status,200);assert(!(await h.call('/api/history')).body.items.some(j=>j.id===row.id))}
 assert.deepEqual(h.app.store.data.gallery,[image]);for(const k of Object.keys(protectedData))assert.deepEqual(h.app.store.data[k],protectedData[k]);assert.deepEqual(await fs.readFile(path.join(dir,'images',image.id)),png);
 await h.app.close();h=await harness(dir);assert.equal((await h.call('/api/history')).body.items.length,0);await h.connect();assert.equal((await h.call('/api/history')).body.items.length,0);assert.deepEqual(h.app.store.data.gallery,[image]);await h.app.close();
}));
test('bulk scopes remove only confirmed selected records; queued/running/unknown are protected',()=>temp(async dir=>{
 const h=await harness(dir);try{
 for(const scope of ['completed','unsuccessful','all']){
 const rows=['COMPLETED','FAILED','INTERRUPTED','CANCELLED','RUNNING','QUEUED','CONNECTION_LOST','UNKNOWN'].map(record);
 await h.app.store.change(d=>{d.history=rows});const result=await h.call('/api/history/cleanup','POST',{scope,ids:rows.map(x=>x.id)});assert.equal(result.status,200);
 const expected=scope==='completed'?1:scope==='unsuccessful'?3:4;assert.equal(result.body.removed,expected);
 for(const status of ['RUNNING','QUEUED','CONNECTION_LOST','UNKNOWN'])assert(result.body.items.some(j=>j.status===status));
 for(const row of rows.filter(j=>['RUNNING','QUEUED'].includes(j.status)))assert.equal((await h.call('/api/history/'+row.id,'DELETE')).status,409);
 }
 }finally{await h.app.close()}
}));
test('connection-lost cannot be silently forgotten; terminal remote reconciliation allows deletion',()=>temp(async dir=>{
 let remote='RUNNING';const h=await harness(dir,async(c,p)=>p==='/health'?health:p==='/models'?{models:[]}:{id:p.split('/').pop(),status:remote});
 try{const row=record('CONNECTION_LOST');await h.app.store.change(d=>{d.history=[row]});assert.equal((await h.call('/api/history/'+row.id,'DELETE')).status,409);await h.connect();assert.equal((await h.call('/api/history/'+row.id,'DELETE')).status,409);
 remote='FAILED';await h.app.store.change(d=>{d.history[0].status='CONNECTION_LOST'});assert.equal((await h.call('/api/history/'+row.id,'DELETE')).status,200);await h.app.pollJobs();assert.equal(h.app.store.data.history.length,0);
 }finally{await h.app.close()}
}));
test('unconfirmed completed result is saved to Gallery before history removal',()=>temp(async dir=>{
 let row=record('CONNECTION_LOST');const h=await harness(dir,async(c,p)=>p==='/health'?health:p==='/models'?{models:[]}:p.startsWith('/results/')?png:p.endsWith('/ack')?{ok:true}:{id:row.id,status:'COMPLETED',result:{image_keys:['0'],seed:42}});
 try{await h.app.store.change(d=>{d.history=[row]});await h.connect();assert.equal((await h.call('/api/history/'+row.id,'DELETE')).status,200);assert.equal(h.app.store.data.history.length,0);assert.equal(h.app.store.data.gallery[0].prompt,'private');assert.deepEqual(await fs.readFile(path.join(dir,'images',row.id+'_0')),png)}finally{await h.app.close()}
}));
test('retention persists at 50 terminal jobs and keeps every nonterminal, ordered by timestamps',()=>temp(async dir=>{
 const store=await new Store(dir).init();const rows=Array.from({length:90},(_,i)=>({...record(i%2?'COMPLETED':'FAILED'),created:i,updated:i}));const active=['RUNNING','QUEUED','CONNECTION_LOST'].map(record);
 await store.change(d=>{d.history=[...rows,...active]});assert.equal(store.data.history.length,53);assert.deepEqual(store.data.history.filter(j=>j.updated<90).map(j=>j.updated),Array.from({length:50},(_,i)=>i+40));
 const reopened=await new Store(dir).init();assert.deepEqual(reopened.data.history,store.data.history);
 // Legacy on-disk excess gets pruned on initialization, without touching user data.
 await fs.writeFile(store.file,JSON.stringify({...store.data,history:[...rows,...active]}));assert.equal((await new Store(dir).init()).data.history.length,53);
 assert.equal(pruneHistory([{status:'MYSTERY',id:'x'}]).length,1);
}));
test('serialized cleanup and concurrent completion do not lose unrelated changes; failure does not delete',()=>temp(async dir=>{
 const h=await harness(dir);try{
 const done=record('COMPLETED'),running=record('RUNNING');await h.app.store.change(d=>{d.history=[done,running]});
 const cleanup=h.call('/api/history/cleanup','POST',{scope:'all',ids:[done.id]});const update=h.app.store.change(d=>{d.history.find(j=>j.id===running.id).status='COMPLETED';d.tags.saved={trigger_words:['safe']}});await Promise.all([cleanup,update]);assert.equal(h.app.store.data.history.length,1);assert.equal(h.app.store.data.history[0].id,running.id);assert(h.app.store.data.tags.saved);
 const atomic=h.app.store.atomic.bind(h.app.store);h.app.store.atomic=async(file,data)=>{if(file===h.app.store.file)throw Error('simulated disk full');return atomic(file,data)};
 assert.equal((await h.call('/api/history/'+running.id,'DELETE')).status,500);assert.equal(h.app.store.data.history.length,1);assert.equal(JSON.parse(await fs.readFile(h.app.store.file)).history.length,1);h.app.store.atomic=atomic;
 }finally{await h.app.close()}
}));
test('website and engine have independent versions and compatibility metadata',()=>temp(async dir=>{const h=await harness(dir);try{assert.equal(h.version.version,'1.7.7');const r=await h.connect();assert.equal(r.body.website_version,'1.7.7');assert.equal(r.body.info.engine_version,'1.7.0');assert.equal(r.body.compatibility,'COMPATIBLE');assert.equal((await h.call('/api/diagnostics')).body.version,'1.7.7')}finally{await h.app.close()}}));
test('deletion is atomic when a selected job becomes active before cleanup commits',()=>temp(async dir=>{
 const h=await harness(dir);try{const row=record('COMPLETED');await h.app.store.change(d=>{d.history=[row]});
 let release;const gate=new Promise(r=>{release=r});const blocker=h.app.store.change(async d=>{await gate;d.history[0].status='RUNNING'});
 const cleanup=h.call('/api/history/cleanup','POST',{scope:'all',ids:[row.id]});release();await blocker;const result=await cleanup;assert.equal(result.body.removed,0);assert.equal(h.app.store.data.history[0].status,'RUNNING');
 }finally{await h.app.close()}
}));

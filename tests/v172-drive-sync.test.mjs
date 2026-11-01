// v1.7.2 Google Drive Auto Sync: proxy allowlist, response projection, local API routing and secret handling.
// Real local HTTP server + synthetic upstream; the engine side is covered by tests/test_v172_drive_sync.py.
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {Readable} from 'node:stream';import {EventEmitter} from 'node:events';
import {createLocalApp} from '../server/app.mjs';import {AppError} from '../server/errors.mjs';
import {allowedRoute,parseTunnel,requestUpstream} from '../server/upstream.mjs';
import {validateSyncStatus,validateConnect} from '../server/drive-sync.mjs';
const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'TEST ONLY',vram_total_mb:100,vram_available_mb:90};
const engineToken='d'.repeat(64);const links={colab:'https://sync-test.trycloudflare.com/#token='+engineToken,cloudcompute:'https://gpu.example.com/#token='+engineToken};
const oauth=JSON.stringify({access_token:'ya29.TESTONLY_ACCESS_abcdefghijklmnop',token_type:'Bearer',refresh_token:'1//TESTONLY_REFRESH_abcdefghijklmnop',expiry:'2026-10-26T10:00:00Z'});
export const syncStatus=(extra={})=>({service:'YOISAKI_DRIVE_SYNC',version:1,enabled:true,rclone_available:true,configured:true,connection:{state:'OK',error:'',code:''},source:'YOISAKI_AI_STUDIO/models',scope:'drive.readonly',job:null,
 items:[{path:'checkpoints/Illustrious XL.safetensors',name:'Illustrious XL.safetensors',kind:'checkpoint',size:6938040682,state:'INSTALLED',reason:'',verification:'md5+safetensors'}],disk:{free_bytes:5e11,total_bytes:9e11,reserve_bytes:2**31},last_success_unix:1793000000,last_check_unix:1793000000,inventory_revision:3,verification:'note',owner:'self',...extra});
async function harness(upstream){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'drive-sync-'));const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),upstream});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;const session=await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}});const cookie=session.headers.get('set-cookie').split(';')[0];
 const call=async(route,body,method)=>{const r=await fetch(base+route,{method:method||(body?'POST':'GET'),headers:{'X-Yoisaki-Local':'1',cookie,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});return {status:r.status,...await r.json()}};
 return {app,dir,call,async close(){await app.close();await fs.rm(dir,{recursive:true,force:true})}};}

test('proxy allowlist contains exactly the six sync routes',()=>{
 for(const [m,r] of [['GET','/sync/status'],['POST','/sync/check'],['POST','/sync/start'],['POST','/sync/cancel'],['POST','/sync/drive/connect'],['POST','/sync/drive/disconnect']])assert.equal(allowedRoute(m,r),true,r);
 for(const [m,r] of [['POST','/sync/status'],['GET','/sync/start'],['DELETE','/sync/start'],['POST','/sync/start?path=../'],['POST','/sync/../models'],['POST','/sync/drive/delete'],['GET','/sync/drive/connect'],['POST','/sync/purge'],['GET','/sync/status/x']])assert.equal(allowedRoute(m,r),false,m+' '+r);
});

test('status projection drops unknown fields, redacts secrets and rejects malformed data',()=>{
 const raw=syncStatus({rclone_conf:'/data/config/rclone/rclone.conf',token:oauth,items:[{...syncStatus().items[0],hash:'a'.repeat(32),drive_id:'1AbC',reason:'refresh 1//TESTONLY_REFRESH_abcdefghijklmnop ya29.TESTONLY '+'f'.repeat(64)}],job:{id:'abc',type:'sync',state:'RUNNING',phase:'DOWNLOADING',current:{path:'loras/a.safetensors',kind:'lora',phase:'DOWNLOADING',bytes_done:5,bytes_total:10,speed_bps:2,resumed_from:null,secret:'x'},overall:{files_total:1,files_done:0,files_failed:0,bytes_total:10,bytes_done:5},summary:{},_base:1}});
 const out=validateSyncStatus(raw);const text=JSON.stringify(out);
 for(const leak of ['rclone.conf','TESTONLY','1AbC','"hash"','"secret"','_base','f'.repeat(64)])assert(!text.includes(leak),leak);
 assert.equal(out.items[0].state,'INSTALLED');assert.equal(out.job.current.bytes_done,5);assert.equal(out.job.overall.bytes_total,10);
 for(const broken of [{},{...syncStatus(),service:'X'},{...syncStatus(),items:[{...syncStatus().items[0],state:'HACKED'}]},{...syncStatus(),items:[{...syncStatus().items[0],size:-1}]},{...syncStatus(),inventory_revision:'1'},{...syncStatus(),job:{type:'delete',state:'RUNNING'}},{...syncStatus(),items:Array(3001).fill(syncStatus().items[0])}])assert.throws(()=>validateSyncStatus(broken),e=>e.code==='INVALID_RESPONSE');
});

test('connect body validation',()=>{
 assert.deepEqual(JSON.parse(validateConnect({token:oauth})),{token:oauth,client_id:'',client_secret:''});
 for(const b of [{},{token:'short'},{token:'not-json-'.repeat(5)},{token:'{'+'x'.repeat(12001)},{token:oauth,path:'../'},{token:oauth,client_id:'x'.repeat(201)}])assert.throws(()=>validateConnect(b),e=>e.code==='DRIVE_INVALID_TOKEN');
});

test('local API: CloudCompute only, method checks, exact upstream mapping, no token persistence or echo',async()=>{
 const calls=[];const h=await harness(async(c,route,opts={})=>{calls.push({provider:c.provider,route,method:opts.method||'GET',body:opts.body});if(route==='/health')return health;if(route==='/models')return {models:[]};if(route.startsWith('/sync/'))return syncStatus();throw Error(route)});
 try{
  assert.equal((await h.call('/api/gpu/drive/status')).code,'GPU_OFFLINE');
  await h.call('/api/gpu/connect',{provider:'colab',url:links.colab});
  const colab=await h.call('/api/gpu/drive/status');assert.equal(colab.status,409);assert.equal(colab.code,'DRIVE_CLOUDCOMPUTE_ONLY');assert(!calls.some(c=>c.route.startsWith('/sync/')));
  await h.call('/api/gpu/provider',{provider:'cloudcompute'});await h.call('/api/gpu/connect',{provider:'cloudcompute',url:links.cloudcompute});
  const s=await h.call('/api/gpu/drive/status');assert.equal(s.status,200);assert.equal(s.items[0].name,'Illustrious XL.safetensors');assert.equal(s.source,'YOISAKI_AI_STUDIO/models');
  for(const [action,route] of [['check','/sync/check'],['sync','/sync/start'],['cancel','/sync/cancel'],['disconnect','/sync/drive/disconnect']]){const r=await h.call('/api/gpu/drive/'+action,{});assert.equal(r.status,200);const last=calls.at(-1);assert.deepEqual([last.route,last.method,last.body,last.provider],[route,'POST','{}','cloudcompute'])}
  assert.equal((await h.call('/api/gpu/drive/sync',undefined,'GET')).code,'METHOD_DENIED');assert.equal((await h.call('/api/gpu/drive/status',{})).code,'METHOD_DENIED');
  assert.equal((await h.call('/api/gpu/drive/delete',{})).status,404);
  const r=await h.call('/api/gpu/drive/connect',{token:oauth});assert.equal(r.status,200);
  const sent=calls.filter(c=>c.route==='/sync/drive/connect');assert.equal(sent.length,1);assert.equal(JSON.parse(sent[0].body).token,oauth);
  assert.equal((await h.call('/api/gpu/drive/connect',{token:oauth,remote:'evil:'})).code,'DRIVE_INVALID_TOKEN');
  const surfaces=JSON.stringify([r,await h.call('/api/gpu/status'),await h.call('/api/diagnostics'),await h.call('/api/settings'),await h.call('/api/history'),await fs.readFile(path.join(h.dir,'state.json'),'utf8')]);
  for(const leak of ['TESTONLY_ACCESS','TESTONLY_REFRESH',engineToken])assert(!surfaces.includes(leak),leak);
  const d=await h.call('/api/diagnostics');assert(d.events.some(e=>e.code==='DRIVE_CONNECT'));assert(!d.events.some(e=>e.code==='DRIVE_STATUS'));
 }finally{await h.close()}
});

test('local API passes engine sync errors through with their code',async()=>{
 const h=await harness(async(c,route)=>{if(route==='/health')return health;if(route==='/models')return {models:[]};throw new AppError('DRIVE_BUSY','Синхронизация уже выполняется.',409)});
 try{await h.call('/api/gpu/provider',{provider:'cloudcompute'});await h.call('/api/gpu/connect',{provider:'cloudcompute',url:links.cloudcompute});const r=await h.call('/api/gpu/drive/sync',{});assert.equal(r.status,409);assert.equal(r.code,'DRIVE_BUSY')}finally{await h.close()}
});

function transport(status,body){return (_o,cb)=>{const req=new EventEmitter();req.end=()=>{const res=Readable.from([Buffer.from(body)]);res.statusCode=status;res.headers={'content-type':'application/json'};setImmediate(()=>cb(res))};req.destroy=()=>{};return req}}
test('upstream maps sync HTTP errors: 404 = no sync service, engine code kept, secrets removed',async()=>{
 const c=parseTunnel(links.cloudcompute,'cloudcompute');const lookup=async()=>[{address:'1.1.1.1',family:4}];
 await assert.rejects(()=>requestUpstream(c,'/sync/status',{lookup,transport:transport(404,'{"detail":"Not Found"}')}),e=>e.code==='DRIVE_SYNC_UNAVAILABLE'&&e.status===409);
 await assert.rejects(()=>requestUpstream(c,'/sync/start',{method:'POST',body:'{}',lookup,transport:transport(409,JSON.stringify({code:'BUSY',detail:'Синхронизация уже выполняется. '+'a'.repeat(64)}))}),e=>e.code==='DRIVE_BUSY'&&e.status===409&&!e.message.includes('a'.repeat(64)));
 await assert.rejects(()=>requestUpstream(c,'/sync/drive/connect',{method:'POST',body:'{}',lookup,transport:transport(422,JSON.stringify({code:'INVALID_TOKEN',detail:'bad'}))}),e=>e.code==='DRIVE_INVALID_TOKEN'&&e.status===400);
 await assert.rejects(()=>requestUpstream(c,'/sync/start',{method:'POST',body:'{}',lookup,transport:transport(401,'{}')}),e=>e.code==='AUTH_REJECTED');
 await assert.rejects(()=>requestUpstream(c,'/sync/delete',{method:'POST',body:'{}',lookup,transport:transport(200,'{}')}),e=>e.code==='PROXY_DENIED');
 assert.equal((await requestUpstream(c,'/sync/status',{lookup,transport:transport(200,JSON.stringify(syncStatus()))})).service,'YOISAKI_DRIVE_SYNC');
});

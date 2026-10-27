import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SecretStore} from '../server/secrets.mjs';
import {CloudComputeAPI,validateCreate,instanceList} from '../server/cloudcompute-api.mjs';
import {DriveAccount} from '../server/drive-account.mjs';
import {createLocalApp} from '../server/app.mjs';
import {AppError} from '../server/errors.mjs';
const client={client_id:'123456789-abcdefghij.apps.googleusercontent.com',client_secret:'GOCSPX-test_secret'};
const key='cc-test_secret_12345';
const account={session_id:'test-session',client,token:{access_token:'private-access',refresh_token:'private-refresh',expiry:'2000-01-01T00:00:00Z'},account:{email:'test@example.invalid'},folder:{id:'folder1',name:'Models'}};
async function secrets(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-174-'));return {dir,s:await new SecretStore(dir).init(),close:()=>fs.rm(dir,{recursive:true,force:true})}}
async function harness(options={}){
 const {dir,close}=await secrets();const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),...options});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+app.server.address().port;const r=await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}});const cookie=r.headers.get('set-cookie').split(';')[0];
 return {app,dir,base,async call(route,method='GET',body){const r=await fetch(base+route,{method,headers:{'X-Yoisaki-Local':'1',cookie},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()}},async close(){await app.close();await close()}};
}
test('CC validates live response before saving, uses exactly one API prefix, and persists secrets privately',async()=>{
 const h=await secrets();const calls=[];const cc=new CloudComputeAPI(h.s,async(url,opts)=>{calls.push({url,opts});return {status:200,json:{data:[{id:7,name:'test',status:'running',gpu_name:'T4',password:'never-return'}]}}});
 try{await cc.save(key);assert.equal(calls[0].url,'https://app.cloudcompute.ru/api/v1/instances');assert.equal(calls[0].opts.headers.Authorization,'Bearer '+key);
 const list=await cc.list();assert.equal(list.instances[0].status,'running');assert(!JSON.stringify(list).includes('password'));assert.equal((await fs.stat(h.s.file)).mode&0o777,0o600);
 const restored=await new SecretStore(h.dir).init();assert.equal(restored.cloudKey(),key);assert(!JSON.stringify(restored.publicView()).includes(key));
 cc.http=async()=>({status:401,json:{error:{message:'Bad '+key}}});await assert.rejects(()=>cc.save('cc-replacement_12345'),e=>e.code==='CC_HTTP_401'&&!e.message.includes(key));assert.equal(h.s.cloudKey(),key);
 }finally{await h.close()}
});
test('CC methods, request validation and uncertain responses never fabricate status',async()=>{
 const h=await secrets();await h.s.setCloudKey(key);const calls=[];const cc=new CloudComputeAPI(h.s,async(url,opts)=>{calls.push([url,opts]);return {status:204,json:null}});
 try{await cc.patch('7',{name:'renamed'});await cc.remove('7');await cc.create({ask_id:12,name:'engine',template_image:'ghcr.io/test/engine:1.7.4',disk_gb:80,max_price_hour_minor:10000,currency:'RUB'});
 assert.deepEqual(calls.map(x=>x[1].method),['PATCH','DELETE','POST']);assert.equal(JSON.parse(calls[2][1].body).strict_offer,true);
 assert.throws(()=>cc.patch('../secret',{status:'stopped'}));assert.throws(()=>instanceList({unexpected:[]}));assert.throws(()=>validateCreate({ask_id:1}));
 for(const code of [403,422,429,503]){cc.http=async()=>({status:code,json:{error:{message:'provider message'}}});await assert.rejects(()=>cc.list(),e=>e.code==='CC_HTTP_'+code)}
 }finally{await h.close()}
});
test('CC HTTP routes enforce session, explicit create/delete confirmation and never echo credentials',async()=>{
 let calls=0;const h=await harness({providerRequest:async()=>{calls++;return {status:200,json:{instances:[]}}}});
 try{assert.equal((await fetch(h.base+'/api/cloudcompute/config')).status,403);assert.equal((await h.call('/api/cloudcompute/config','PUT',{key})).status,200);
 assert.deepEqual((await h.call('/api/cloudcompute/config')).body,{configured:true});const before=calls;
 assert.equal((await h.call('/api/cloudcompute/instances/7','DELETE',{})).status,400);assert.equal((await h.call('/api/cloudcompute/instances','POST',{})).status,400);assert.equal(calls,before);
 assert(!(await fs.readFile(path.join(h.dir,'state.json'),'utf8')).includes(key));await h.call('/api/cloudcompute/config','DELETE');assert.equal((await h.call('/api/cloudcompute/instances')).body.code,'CC_NOT_CONFIGURED');
 }finally{await h.close()}
});
test('Drive refresh is single-flight, retained across restart, never exposed by view',async()=>{
 const h=await secrets();await h.s.setDrive(account);let refreshes=0;
 const drive=new DriveAccount(h.s,async(url,opts)=>{assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(new URLSearchParams(opts.body).get('refresh_token'),'private-refresh');refreshes++;await new Promise(r=>setTimeout(r,20));return {status:200,json:{access_token:'new-private-access',expires_in:3600}}});
 try{const tokens=await Promise.all([drive.token(),drive.token(),drive.token()]);assert.equal(refreshes,1);assert(tokens.every(t=>t.access_token==='new-private-access'));const restored=await new SecretStore(h.dir).init();assert.equal(restored.drive().token.access_token,'new-private-access');assert(!JSON.stringify(drive.view()).includes('private'));
 }finally{await h.close()}
});
test('Drive browse pagination, server-verified folder selection and binding use chosen folder',async()=>{
 const h=await secrets();await h.s.setDrive({...account,token:{...account.token,expiry:'2099-01-01T00:00:00Z'}});const calls=[];
 const drive=new DriveAccount(h.s,async(url,opts)=>{calls.push(url);assert.equal(opts.headers.Authorization,'Bearer private-access');return {status:200,json:url.includes('/files?')?{files:[{id:'subfolder',name:'models'}],nextPageToken:'next'}:{id:'subfolder',name:'models',mimeType:'application/vnd.google-apps.folder'}}});
 try{const list=await drive.folders('root','next');assert.equal(list.next_page,'next');assert.equal(new URL(calls[0]).searchParams.get('pageToken'),'next');await drive.choose('subfolder');assert.equal((await drive.binding()).root_folder_id,'subfolder');await assert.rejects(()=>drive.choose("bad' or trashed = true"));
 drive.http=async()=>({status:200,json:{mimeType:'text/plain'}});await assert.rejects(()=>drive.choose('file'),e=>e.code==='DRIVE_INVALID_FOLDER');assert.equal(h.s.drive().folder.id,'subfolder');
 }finally{await h.close()}
});
test('Drive revoked token gives explicit error; logout during refresh cannot restore credentials',async()=>{
 const h=await secrets();await h.s.setDrive(account);let release;const wait=new Promise(r=>release=r);const drive=new DriveAccount(h.s,async()=>{await wait;return {status:200,json:{access_token:'late',expires_in:3600}}});
 try{const pending=drive.token();await h.s.setDrive(null);release();await assert.rejects(()=>pending,e=>e.code==='DRIVE_CHANGED');assert.equal(h.s.drive(),null);
 await h.s.setDrive(account);drive.http=async()=>({status:400,json:{error:'invalid_grant'}});await assert.rejects(()=>drive.token(),e=>e.code==='DRIVE_REFRESH_FAILED');
 }finally{await h.close()}
});
test('OAuth cancellation, replay, no-GPU success, local logout and callback race',async()=>{
 let release;const wait=new Promise(r=>release=r);const h=await harness({defaultGoogle:client,exchange:async()=>{await wait;return account.token},providerRequest:async()=>({status:200,json:{user:{emailAddress:'test@example.invalid'}}})});
 try{let url=(await h.call('/api/drive/oauth/start','POST',{})).body.url;let state=new URL(url).searchParams.get('state');
 await fetch(h.base+'/?state='+state+'&error=access_denied',{redirect:'manual'});assert.equal((await h.call('/api/drive/oauth')).body.last_result.ok,false);
 url=(await h.call('/api/drive/oauth/start','POST',{})).body.url;state=new URL(url).searchParams.get('state');const back=fetch(h.base+'/?state='+state+'&code=x',{redirect:'manual'});await new Promise(r=>setTimeout(r,25));await h.call('/api/drive/account','DELETE');release();await back;assert.equal((await h.call('/api/drive/oauth')).body.connected,false);
 }finally{await h.close()}
});
test('Inventory probe errors mark cached list stale and recovered probe refreshes it',async()=>{
 let broken=false;const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true},state:'READY',gpu_name:'mock GPU',vram_total_mb:16000,vram_available_mb:15000};
 const h=await harness({upstream:async(c,p)=>{if(p==='/health')return health;if(p==='/inventory'){if(broken)throw new AppError('CONNECTION_TIMEOUT','timeout',504);return {revision:'a'.repeat(32)}}if(p==='/inventory?models=1')return {revision:'a'.repeat(32),models:[]};throw Error(p)}});
 try{await h.call('/api/gpu/provider','POST',{provider:'cloudcompute'});assert.equal((await h.call('/api/gpu/connect','POST',{provider:'cloudcompute',url:'https://gpu.example.com/#token='+'a'.repeat(64)})).status,200);
 broken=true;let r=(await h.call('/api/gpu/status')).body;assert.equal(r.models_stale,true);assert.equal(r.models_code,'CONNECTION_TIMEOUT');broken=false;r=(await h.call('/api/gpu/status')).body;assert.equal(r.models_stale,false);assert.equal(r.models_error,'');
 }finally{await h.close()}
});

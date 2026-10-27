// v1.7.3 CloudCompute REST API + Google Drive Easy Connect. MOCKED: CloudCompute API, Google OAuth/Drive and the GPU
// engine are test doubles. Nothing here proves the real CloudCompute endpoints or a real Google sign-in.
import {test} from 'node:test';import http from 'node:http';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createLocalApp} from '../server/app.mjs';import {AppError} from '../server/errors.mjs';
import {CloudComputeApi,parseContract,validateKey,normalizeInstance,API_HOST,UNVERIFIED} from '../server/cloudcompute-api.mjs';
import {refreshAccess,loadPublicClient,revokeToken} from '../server/google-oauth.mjs';
import {previewFolder,folderInfo,listFolders,driveGet} from '../server/google-drive.mjs';
import {validateConnect,validateSyncStatus} from '../server/drive-sync.mjs';
import {httpsJson,scrub} from '../server/https-json.mjs';
const engineToken='e'.repeat(64);const KEY='cc-TESTONLY_abcdefghijklmnop0123';
const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'TEST DOUBLE, NOT GPU',vram_total_mb:10240,vram_available_mb:9000};
const CONTRACT={version:1,verified_against:'TEST FIXTURE — not the real CloudCompute API',operations:{list:{method:'GET',path:'/instances',items:'data'},get:{method:'GET',path:'/instances/{id}',item:'data'},start:{method:'POST',path:'/instances/{id}/start'},stop:{method:'POST',path:'/instances/{id}/stop'}},
 fields:{id:'id',name:'name',status:'state',gpu:'gpu.model',gpu_count:'gpu.count',disk_gb:'disk_gb',price_per_hour:'price'},status_map:{running:'RUNNING',stopped:'STOPPED',starting:'STARTING',stopping:'STOPPING',failed:'ERROR'}};
const sync=(extra={})=>({service:'YOISAKI_DRIVE_SYNC',version:1,enabled:true,rclone_available:true,configured:false,connection:{state:'UNKNOWN',error:'',code:''},source:'YOISAKI_AI_STUDIO/models',scope:'drive.readonly',job:null,items:[],disk:null,last_success_unix:null,last_check_unix:null,inventory_revision:0,verification:'',owner:'self',selective:true,...extra});
async function harness({upstream=async(c,p)=>{if(p==='/health')return health;if(p==='/inventory?models=1')return {revision:'1'.repeat(32),models:[]};throw new AppError('JOB_NOT_FOUND','404',404)},contract,options={}}={}){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-easy-'));
 if(contract)await fs.writeFile(path.join(dataDir,'cloudcompute-api.json'),JSON.stringify(contract));
 const app=await createLocalApp({dataDir,distDir:path.resolve('dist'),upstream,sleep:async()=>{},env:{},...options});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const s=await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}});const cookie=s.headers.get('set-cookie').split(';')[0];
 const call=async(route,method='GET',body,headers={})=>{const r=await fetch(base+route,{method,headers:{'X-Yoisaki-Local':'1',Cookie:cookie,...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()}};
 return {...app,base,call,cookie,dataDir};
}
const until=async(fn,ms=5000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,15))}throw Error('timeout')};
const allFiles=async dir=>{const out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await allFiles(p));else out.push(p)}return out};
// CloudCompute API double: records every request; instance i-1 starts STOPPED.
function fakeCloud(){
 const calls=[];const inst={id:'i-1',name:'RTX 3090 #1',state:'stopped',gpu:{model:'RTX 3090',count:1},disk_gb:100,price:24.94};
 const request=async o=>{calls.push(o);
  if(o.host!==API_HOST)throw Error('wrong host '+o.host);
  if(o.headers.Authorization!=='Bearer '+KEY)return {status:401,json:{message:'invalid key '+o.headers.Authorization},text:''};
  if(o.method==='GET'&&o.path==='/api/v1/instances')return {status:200,json:{data:[inst,{id:'i-2',name:'A100',state:'running',gpu:{model:'A100',count:1}},{bad:true}]}};
  if(o.method==='GET'&&o.path==='/api/v1/instances/i-1'){if(inst.state==='starting')inst.state='running';return {status:200,json:{data:inst}}}
  if(o.method==='POST'&&o.path==='/api/v1/instances/i-1/start'){inst.state='starting';return {status:200,json:{ok:true}}}
  if(o.method==='POST'&&o.path==='/api/v1/instances/i-1/stop'){inst.state='stopped';return {status:200,json:{ok:true}}}
  return {status:404,json:{}};
 };
 return {calls,inst,request};
}

test('CloudCompute key format and strict contract: no DELETE, no absolute URLs, no guessing',()=>{
 assert.equal(validateKey('  '+KEY+' '),KEY);
 for(const bad of ['','sk-abc','cc-',`cc-${'a'.repeat(300)}`,'cc-abc def ghij','cc-abc\r\nX: y','cc-abcdefgh"'])assert.throws(()=>validateKey(bad),e=>e.code==='CC_INVALID_KEY',bad);
 assert.equal(parseContract(CONTRACT).verified,true);
 const variant=f=>{const c=structuredClone(CONTRACT);f(c);return c};
 for(const [why,c] of [['delete',variant(c=>{c.operations.stop.method='DELETE'})],['absolute',variant(c=>{c.operations.list.path='https://evil.example/x'})],['dotdot',variant(c=>{c.operations.list.path='/../admin'})],
  ['no id',variant(c=>{c.operations.get.path='/instances'})],['unknown op',variant(c=>{c.operations.delete={method:'POST',path:'/instances/{id}/delete'}})],['no status map',variant(c=>{c.status_map={}})],['no source',variant(c=>{delete c.verified_against})],['bad status',variant(c=>{c.status_map.x='BOOM'})]])
  assert.throws(()=>parseContract(c),e=>e.code==='CC_CONTRACT_INVALID',why);
 const n=normalizeInstance({id:'i-1',name:'x',state:'Running',gpu:{model:'RTX'}},parseContract(CONTRACT));assert.equal(n.status,'RUNNING');assert.equal(n.provider_status,'Running');
 assert.equal(normalizeInstance({id:'../x'},parseContract(CONTRACT)),null);
 assert.deepEqual(new CloudComputeApi({contract:UNVERIFIED}).capabilities(),{validate:false,list:false,get:false,start:false,stop:false});
});

test('CloudCompute adapter (mocked API): fixed host, Bearer header, errors never contain the key',async()=>{
 const cloud=fakeCloud();const api=new CloudComputeApi({contract:parseContract(CONTRACT),request:cloud.request});
 const list=await api.list(KEY);assert.deepEqual(list.map(x=>[x.id,x.status]),[['i-1','STOPPED'],['i-2','RUNNING']]);
 assert(cloud.calls.every(c=>c.host==='app.cloudcompute.ru'&&c.path.startsWith('/api/v1/')));
 await assert.rejects(()=>api.list('cc-WRONG_KEY_abcdefghij'),e=>e.code==='CC_AUTH_REJECTED'&&!e.message.includes('WRONG_KEY')&&e.message.includes('[СКРЫТО]'));
 await assert.rejects(()=>api.get(KEY,'i-404'),e=>e.code==='CC_NOT_FOUND');
 await assert.rejects(()=>api.get(KEY,'../etc'),e=>e.code==='CC_INVALID_INSTANCE');
 const redirect=new CloudComputeApi({contract:parseContract(CONTRACT),request:async()=>({status:302,json:null,text:''})});await assert.rejects(()=>redirect.list(KEY),e=>e.code==='CC_REDIRECT');
 const html=new CloudComputeApi({contract:parseContract(CONTRACT),request:async()=>({status:200,json:null,text:'<html>'})});await assert.rejects(()=>html.list(KEY),e=>e.code==='CC_INVALID_RESPONSE');
 assert.equal(scrub('Authorization: Bearer cc-abcdef123456 and ya29.secret'),'Authorization: Bearer [СКРЫТО] and [СКРЫТО]');
});

test('https client refuses DNS answers in private networks (no SSRF/DNS rebinding through provider hosts)',async()=>{
 for(const address of ['127.0.0.1','10.0.0.5','192.168.1.2','169.254.169.254','::1'])
  await assert.rejects(()=>httpsJson({host:API_HOST,path:'/api/v1/x',lookup:async()=>[{address,family:address.includes(':')?6:4}],transport:()=>{throw Error('must not connect')}}),e=>e.code==='CC_PRIVATE_DESTINATION',address);
});

test('API key storage: 0600 secrets.json only, never in responses, state.json, diagnostics or the engine',async()=>{
 const seen=[];const h=await harness({upstream:async(c,p,o={})=>{seen.push({token:c.token,body:o.body||''});if(p==='/health')return health;if(p==='/inventory?models=1')return {revision:'1'.repeat(32),models:[]};throw new AppError('JOB_NOT_FOUND','404',404)}});
 try{
  const saved=await h.call('/api/cloudcompute/key','PUT',{api_key:KEY});assert.equal(saved.status,200);assert.equal(saved.body.configured,true);
  assert.equal(saved.body.contract.verified,false);assert.equal(saved.body.validated_at,null);  // no verified contract: format check only
  assert.equal((await h.call('/api/cloudcompute/instances')).body.code,'CC_UNSUPPORTED');
  assert.equal((await h.call('/api/cloudcompute/validate','POST',{})).body.code,'CC_UNSUPPORTED');
  await h.call('/api/gpu/provider','POST',{provider:'cloudcompute'});await h.call('/api/gpu/connect','POST',{url:'https://gpu.example.com/#token='+engineToken,provider:'cloudcompute',remember:true});
  const responses=JSON.stringify([(await h.call('/api/cloudcompute')).body,(await h.call('/api/gpu/status')).body,(await h.call('/api/diagnostics')).body,(await h.call('/api/drive')).body]);
  assert(!responses.includes('TESTONLY'),'key leaked into an API response');
  assert(seen.length&&seen.every(x=>x.token===engineToken&&!x.body.includes('cc-')),'CloudCompute key reached the GPU engine');
  for(const f of await allFiles(h.dataDir)){const text=await fs.readFile(f,'utf8');if(path.basename(f)==='secrets.json'){assert(text.includes(KEY));assert.equal((await fs.stat(f)).mode&0o777,0o600)}else assert(!text.includes('TESTONLY'),f)}
  assert.equal((await h.call('/api/cloudcompute/key','PUT',{api_key:'not-a-key'})).body.code,'CC_INVALID_KEY');
  assert.equal((await h.call('/api/cloudcompute/key','DELETE')).body.configured,false);
  assert(!(await fs.readFile(path.join(h.dataDir,'secrets.json'),'utf8')).includes('TESTONLY'),'explicit deletion must remove the key');
 }finally{await h.close()}
});

test('local API rejects other websites: no reading the key status or triggering cloud operations cross-site',async()=>{
 const cloud=fakeCloud();const h=await harness({contract:CONTRACT,options:{ccRequest:cloud.request}});
 try{
  await h.call('/api/cloudcompute/key','PUT',{api_key:KEY});const before=cloud.calls.length;
  const attempts=[{Origin:'https://evil.example'},{'Sec-Fetch-Site':'cross-site'},{'X-Yoisaki-Local':'0'},{Host:'evil.example:80'}];
  // node:http (fetch would not let a test set Host, as in a DNS-rebinding attack).
  const raw=headers=>new Promise((resolve,reject)=>{const body=JSON.stringify({instance_id:'i-1',confirm:true});const r=http.request(h.base+'/api/cloudcompute/instance/start',{method:'POST',headers:{'X-Yoisaki-Local':'1',Cookie:h.cookie,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),...headers}},res=>{res.resume();resolve(res.statusCode)});r.on('error',reject);r.end(body)});
  for(const headers of attempts)assert.equal(await raw(headers),403,JSON.stringify(headers));
  const noCookie=await fetch(h.base+'/api/cloudcompute',{headers:{'X-Yoisaki-Local':'1'}});assert.equal(noCookie.status,401);
  assert.equal(cloud.calls.length,before,'a rejected request reached CloudCompute');
 }finally{await h.close()}
});

test('instances (mocked API): list, select, start/stop need explicit confirmation; a rejected key is not stored',async()=>{
 const cloud=fakeCloud();const h=await harness({contract:CONTRACT,options:{ccRequest:cloud.request}});
 try{
  assert.equal((await h.call('/api/cloudcompute/key','PUT',{api_key:'cc-WRONG_KEY_abcdefghij'})).body.code,'CC_AUTH_REJECTED');
  assert.equal((await h.call('/api/cloudcompute')).body.configured,false);
  const v=(await h.call('/api/cloudcompute/key','PUT',{api_key:KEY})).body;assert(v.validated_at);assert.equal(v.contract.verified,true);
  const list=(await h.call('/api/cloudcompute/instances')).body;assert.deepEqual(list.instances.map(i=>[i.id,i.status,i.gpu]),[['i-1','STOPPED','RTX 3090'],['i-2','RUNNING','A100']]);
  assert.equal((await h.call('/api/cloudcompute/select','POST',{instance_id:'nope'})).body.code,'CC_NOT_FOUND');
  assert.equal((await h.call('/api/cloudcompute/select','POST',{instance_id:'i-1'})).body.instance_id,'i-1');
  assert.equal((await h.call('/api/cloudcompute/instance/start','POST',{instance_id:'i-1'})).body.code,'CONFIRMATION_REQUIRED');
  assert(!cloud.calls.some(c=>c.method==='POST'),'no billable call without confirmation');
  const started=(await h.call('/api/cloudcompute/instance/start','POST',{instance_id:'i-1',confirm:true})).body;assert.equal(started.instance.status,'RUNNING');
  assert.equal((await h.call('/api/cloudcompute/instance/stop','POST',{instance_id:'i-1'})).body.code,'CONFIRMATION_REQUIRED');
  assert.equal((await h.call('/api/cloudcompute/instance/stop','POST',{instance_id:'i-1',confirm:true})).body.instance.status,'STOPPED');
  assert(!cloud.calls.some(c=>/delete/i.test(c.path)||c.method==='DELETE'));
 }finally{await h.close()}
});

test('CONNECT GPU (mocked API + engine): stopped instance needs confirmation, then start → RUNNING → engine READY',async()=>{
 const cloud=fakeCloud();const h=await harness({contract:CONTRACT,options:{ccRequest:cloud.request}});
 try{
  await h.call('/api/gpu/provider','POST',{provider:'cloudcompute'});
  assert.equal((await h.call('/api/gpu/connect-gpu','POST',{})).body.code,'NOT_REMEMBERED');  // the API key is not engine access
  await h.call('/api/gpu/connect','POST',{url:'https://gpu.example.com/#token='+engineToken,provider:'cloudcompute',remember:true});await h.call('/api/gpu/disconnect','POST');
  await h.call('/api/cloudcompute/key','PUT',{api_key:KEY});await h.call('/api/cloudcompute/instances');await h.call('/api/cloudcompute/select','POST',{instance_id:'i-1'});
  assert.equal((await h.call('/api/gpu/connect-gpu','POST',{})).status,202);
  const stopped=await until(async()=>{const s=(await h.call('/api/gpu/status')).body;return s.phase==='ERROR'&&s});
  assert.equal(stopped.code,'CC_INSTANCE_STOPPED');assert.equal(stopped.components.instance,'ERROR');assert.equal(stopped.components.engine,'UNKNOWN');
  assert(!cloud.calls.some(c=>c.method==='POST'),'started without confirmation');
  assert.equal((await h.call('/api/gpu/connect-gpu','POST',{start_instance:true})).status,202);
  const ready=await until(async()=>{const s=(await h.call('/api/gpu/status')).body;return s.state==='READY'&&s});
  assert.equal(ready.gpu_flow.step,'READY');assert.equal(ready.components.instance,'READY');
  assert.equal(cloud.calls.filter(c=>c.method==='POST'&&c.path==='/api/v1/instances/i-1/start').length,1);
 }finally{await h.close()}
});

test('CONNECT GPU without a verified contract falls back to the remembered engine link (no fake instance step)',async()=>{
 const h=await harness();
 try{
  await h.call('/api/gpu/provider','POST',{provider:'cloudcompute'});await h.call('/api/gpu/connect','POST',{url:'https://gpu.example.com/#token='+engineToken,provider:'cloudcompute',remember:true});await h.call('/api/gpu/disconnect','POST');
  await h.call('/api/cloudcompute/key','PUT',{api_key:KEY});
  await h.call('/api/gpu/connect-gpu','POST',{});const s=await until(async()=>{const s=(await h.call('/api/gpu/status')).body;return s.state==='READY'&&s});
  assert.equal(s.gpu_flow.step,'READY');assert.equal(s.components.instance,undefined);
 }finally{await h.close()}
});

test('Google OAuth helpers: refresh, reauth on invalid_grant, revoke posts the token in the body, public client loading',async()=>{
 const client={client_id:'123456789-abcdefghij.apps.googleusercontent.com',client_secret:'GOCSPX-abcdefghijk'};
 assert.equal((await refreshAccess(client,'1//r',{post:async f=>{assert.equal(f.grant_type,'refresh_token');return {status:200,json:{access_token:'ya29.n',expires_in:60}}},now:0})).expires_at,60000);
 await assert.rejects(()=>refreshAccess(client,'1//r',{post:async()=>({status:400,json:{error:'invalid_grant'}})}),e=>e.code==='DRIVE_REAUTH_REQUIRED');
 let revoked=null;assert.equal(await revokeToken('1//r',{post:async(f,o)=>{revoked={f,o};return {status:200}}}),true);assert.deepEqual(revoked,{f:{token:'1//r'},o:{route:'/revoke'}});
 assert.deepEqual((await loadPublicClient({env:{YOISAKI_GOOGLE_CLIENT_ID:client.client_id,YOISAKI_GOOGLE_CLIENT_SECRET:client.client_secret}})).client,{...client,source:'env'});
 assert.equal((await loadPublicClient({env:{YOISAKI_GOOGLE_CLIENT_ID:'x',YOISAKI_GOOGLE_CLIENT_SECRET:'y'}})).client,null);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-pub-'));await fs.mkdir(path.join(dir,'config'));await fs.writeFile(path.join(dir,'config/google-oauth-client.json'),JSON.stringify(client));
 assert.equal((await loadPublicClient({appRoot:dir,env:{}})).client.source,'file');
});

// Google Drive double: My Drive/YOISAKI_AI_STUDIO/models with nested model folders.
function fakeGoogle({expireFirst=false}={}){
 const calls=[];let first=expireFirst;
 const tree={root:[['fold000000A','YOISAKI_AI_STUDIO',true]],fold000000A:[['fold000000B','models',true]],fold000000B:[['fold000000C','checkpoints',true],['fold000000D','loras',true],['fold000000E','misc',true],['file0000001','loose.safetensors',false,10]],
  fold000000C:[['file0000002','wai.safetensors',false,6936000000],['file0000003','old.ckpt',false,2000]],fold000000D:[['fold000000F','characters',true],['file0000004','Amber_Nova.safetensors',false,220000000]],fold000000F:[['file0000005','Vesper_Nova.safetensors',false,210000000]],fold000000E:[['file0000006','x.safetensors',false,1]]};
 const parents={fold000000A:'0AROOTFOLDER1',fold000000B:'fold000000A',fold000000C:'fold000000B',fold000000D:'fold000000B',fold000000E:'fold000000B',fold000000F:'fold000000D'};
 const names={fold000000A:'YOISAKI_AI_STUDIO',fold000000B:'models',fold000000C:'checkpoints',fold000000D:'loras',fold000000E:'misc',fold000000F:'characters',root:'My Drive'};
 const request=async o=>{calls.push(o);assert.equal(o.host,'www.googleapis.com');if(first){first=false;return {status:401,json:{}}}
  if(!/^Bearer ya29\./.test(o.headers.Authorization))return {status:401,json:{}};
  const u=new URL('https://x'+o.path);const q=u.searchParams.get('q')||'';
  if(u.pathname==='/drive/v3/about')return {status:200,json:{user:{displayName:'Test User',emailAddress:'user@example.com'}}};
  if(u.pathname==='/drive/v3/files'){const parent=(q.match(/'([^']+)' in parents/)||[])[1];const rows=(tree[parent]||[]).filter(r=>!q.includes('mimeType=')||r[2]).map(([id,name,folder,size])=>({id,name,mimeType:folder?'application/vnd.google-apps.folder':'application/octet-stream',...(size!==undefined?{size:String(size)}:{})}));return {status:200,json:{files:rows}}}
  const m=u.pathname.match(/^\/drive\/v3\/files\/(\w+)$/);
  if(m){const id=m[1];if(id==='0AROOTFOLDER1')return {status:200,json:{id,name:'My Drive'}};/* My Drive has no parents */if(!names[id])return {status:404,json:{}};return {status:200,json:{id,name:names[id],mimeType:'application/vnd.google-apps.folder',parents:[parents[id]]}}}
  return {status:404,json:{}};
 };
 const posts=[];const post=async(form,o={})=>{posts.push({form,route:o.route||'/token'});if(o.route==='/revoke')return {status:200,json:{}};if(form.grant_type==='refresh_token')return form.refresh_token==='1//revoked'?{status:400,json:{error:'invalid_grant'}}:{status:200,json:{access_token:'ya29.refreshed',expires_in:3600}};return {status:400,json:{error:'unsupported'}}};
 return {calls,request,post,posts};
}

test('Drive API helpers (mocked Google): folders, display path, preview of nested models, permission errors',async()=>{
 const g=fakeGoogle();const opts={request:g.request};
 assert.deepEqual((await listFolders('ya29.t','root',opts)).folders,[{id:'fold000000A',name:'YOISAKI_AI_STUDIO'}]);
 assert.deepEqual(await folderInfo('ya29.t','fold000000B',opts),{id:'fold000000B',name:'models',path:'YOISAKI_AI_STUDIO/models',root:'my'});
 const p=await previewFolder('ya29.t','fold000000B',opts);
 assert.deepEqual(p.kinds.checkpoint,{files:1,bytes:6936000000,rejected:1});assert.equal(p.kinds.lora.files,2);  // nested loras/characters/ counted
 assert.deepEqual(p.missing_folders,['vae']);assert.equal(p.loose_files,1);
 await assert.rejects(()=>listFolders('ya29.t',"x' or 1=1",opts),e=>e.code==='DRIVE_INVALID_FOLDER');
 await assert.rejects(()=>driveGet('ya29.t','about',{},{request:async()=>({status:403,json:{error:{errors:[{reason:'insufficientPermissions'}]}},text:''})}),e=>e.code==='DRIVE_PERMISSION');
 await assert.rejects(()=>driveGet('ya29.t','about',{},{request:async()=>({status:403,json:{error:{errors:[{reason:'accessNotConfigured'}]}},text:''})}),e=>e.code==='DRIVE_API_DISABLED');
});

test('Drive Easy Connect without GPU: sign in → account → choose folder → preview; reconnect when expired; disconnect revokes',async()=>{
 const g=fakeGoogle({expireFirst:false});
 const h=await harness({options:{driveRequest:g.request,googlePost:g.post,env:{YOISAKI_GOOGLE_CLIENT_ID:'123456789-publicclient.apps.googleusercontent.com',YOISAKI_GOOGLE_CLIENT_SECRET:'GOCSPX-TESTONLY_public'},
  exchange:async(client,code,pending)=>{assert.equal(client.client_id,'123456789-publicclient.apps.googleusercontent.com');assert.equal(pending.client_id,client.client_id);return {access_token:'ya29.first',token_type:'Bearer',refresh_token:'1//phone-refresh',expiry:new Date(Date.now()+3600e3).toISOString()}}}});
 try{
  let v=(await h.call('/api/drive')).body;assert.equal(v.linked,false);assert.equal(v.public_client,true);assert.equal(v.gpu_online,false);
  const {url,client}=(await h.call('/api/drive/oauth/start','POST',{})).body;assert.equal(client,'public');
  const au=new URL(url);assert.equal(au.searchParams.get('client_id'),'123456789-publicclient.apps.googleusercontent.com');assert.equal(au.searchParams.get('code_challenge_method'),'S256');
  assert(!url.includes('GOCSPX'),'client secret must not be in the browser URL');
  const back=await fetch(h.base+'/?state='+au.searchParams.get('state')+'&code=c',{headers:{'Sec-Fetch-Site':'cross-site'},redirect:'manual'});assert.equal(back.status,302);
  v=(await h.call('/api/drive')).body;assert.equal(v.linked,true);assert.equal(v.account.email,'user@example.com');assert.equal(v.folder,null);assert.match(v.last_result.message,/Выберите папку/);
  assert.equal((await h.call('/api/drive/folders?parent=root')).body.folders[0].name,'YOISAKI_AI_STUDIO');
  v=(await h.call('/api/drive/folder','POST',{id:'fold000000B'})).body;assert.equal(v.folder.path,'YOISAKI_AI_STUDIO/models');assert.equal(v.preview.kinds.lora.files,2);
  assert.equal((await h.call('/api/drive/provision','POST',{})).body.code,'GPU_OFFLINE');
  assert(!JSON.stringify([v,(await h.call('/api/diagnostics')).body]).includes('phone-refresh'));
  // Expired grant → reauth flag, explained error, nothing else breaks.
  const secretsFile=path.join(h.dataDir,'secrets.json');const raw=JSON.parse(await fs.readFile(secretsFile,'utf8'));
  await h.close();raw.drive.refresh_token='1//revoked';await fs.writeFile(secretsFile,JSON.stringify(raw),{mode:0o600});
  // Restart of the local app on the same data folder (as after a phone reboot).
  const h3=await createLocalApp({dataDir:h.dataDir,distDir:path.resolve('dist'),upstream:async()=>{throw Error('no gpu')},driveRequest:g.request,googlePost:g.post,env:{YOISAKI_GOOGLE_CLIENT_ID:'123456789-publicclient.apps.googleusercontent.com',YOISAKI_GOOGLE_CLIENT_SECRET:'GOCSPX-TESTONLY_public'}});
  await new Promise(r=>h3.server.listen(0,'127.0.0.1',r));const base3='http://127.0.0.1:'+h3.server.address().port;const ck=(await fetch(base3+'/api/session',{headers:{'X-Yoisaki-Local':'1'}})).headers.get('set-cookie').split(';')[0];
  const c3=async(r,m='GET',b)=>{const x=await fetch(base3+r,{method:m,headers:{'X-Yoisaki-Local':'1',Cookie:ck,'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});return {status:x.status,body:await x.json()}};
  try{
   assert.equal((await c3('/api/drive/check','POST',{})).body.code,'DRIVE_REAUTH_REQUIRED');assert.equal((await c3('/api/drive')).body.reauth,true);
   const del=(await c3('/api/drive','DELETE')).body;assert.equal(del.linked,false);assert.equal(del.unlinked.revoked,true);
   assert.deepEqual(g.posts.at(-1),{form:{token:'1//revoked'},route:'/revoke'});
   assert(!(await fs.readFile(secretsFile,'utf8')).includes('1//'),'refresh token must be deleted');
  }finally{await h3.close()}
 }finally{await h.close().catch(()=>{})}
});

test('Drive link reaches the GPU when CloudCompute connects: folder_id only for servers with folder_select; auto sync',async()=>{
 for(const folderSelect of [true,false]){
  const g=fakeGoogle({expireFirst:true});let forwarded=null,started=0;
  const upstream=async(c,p,o={})=>{if(p==='/health')return health;if(p==='/inventory?models=1')return {revision:'1'.repeat(32),models:[]};if(p==='/sync/status')return sync({folder_select:folderSelect});
   if(p==='/sync/drive/connect'){forwarded=JSON.parse(o.body);return sync({configured:true,folder_select:folderSelect})}if(p==='/sync/start'){started++;return sync({configured:true})}throw new AppError('JOB_NOT_FOUND','404',404)};
  const h=await harness({upstream,options:{driveRequest:g.request,googlePost:g.post,exchange:async()=>({access_token:'ya29.first',token_type:'Bearer',refresh_token:'1//phone-refresh',expiry:new Date(Date.now()+3600e3).toISOString()})}});
  try{
   await h.call('/api/drive/oauth','PUT',{client_id:'123456789-ownclientid.apps.googleusercontent.com',client_secret:'GOCSPX-TESTONLY_own12'});
   const {url,client}=(await h.call('/api/drive/oauth/start','POST',{})).body;assert.equal(client,'own');
   await fetch(h.base+'/?state='+new URL(url).searchParams.get('state')+'&code=c',{headers:{'Sec-Fetch-Site':'cross-site'},redirect:'manual'});
   assert.equal((await h.call('/api/drive/folder','POST',{id:'fold000000B'})).body.folder.id,'fold000000B');
   await h.call('/api/gpu/provider','POST',{provider:'cloudcompute'});await h.call('/api/gpu/connect','POST',{url:'https://gpu.example.com/#token='+engineToken,provider:'cloudcompute'});
   await until(()=>forwarded&&started);
   const tok=JSON.parse(forwarded.token);assert.equal(tok.refresh_token,'1//phone-refresh');assert.equal(forwarded.client_id,'123456789-ownclientid.apps.googleusercontent.com');
   if(folderSelect){assert.equal(forwarded.folder_id,'fold000000B');assert.equal(forwarded.folder_label,'YOISAKI_AI_STUDIO/models')}else assert.equal(forwarded.folder_id,undefined);
   const d=await until(async()=>{const v=(await h.call('/api/drive')).body;return v.gpu.state==='SYNCING'&&v});
   if(!folderSelect)assert.match(d.gpu.message,/YOISAKI_DRIVE_PATH/);
  }finally{await h.close()}
 }
});

test('sync contract: folder fields validated; bad folder IDs rejected; ControlNet files are not a sync kind',()=>{
 const st=validateSyncStatus(sync({folder_select:true,source_kind:'folder'}));assert.equal(st.folder_select,true);assert.equal(st.source_kind,'folder');
 assert.throws(()=>validateSyncStatus(sync({items:[{path:'controlnet/c.safetensors',name:'c.safetensors',kind:'controlnet',size:5,state:'MISSING',reason:'',verification:''}]})),e=>e.code==='INVALID_RESPONSE');
 assert.equal(JSON.parse(validateConnect({token:'{"access_token":"a","refresh_token":"b"}',folder_id:'fold000000B',folder_label:'a/b'})).folder_id,'fold000000B');
 for(const bad of ["x' or","short",'a/b'])assert.throws(()=>validateConnect({token:'{"access_token":"a","refresh_token":"b"}',folder_id:bad,folder_label:''}),e=>e.code==='DRIVE_INVALID_FOLDER');
});

test('secret audit: finds a real-looking key and credential files, passes the source tree and the build output',async()=>{
 const {execFileSync}=await import('node:child_process');const run=dir=>{try{execFileSync(process.execPath,['scripts/secret-audit.mjs',dir],{stdio:'pipe'});return 0}catch(e){return e.status}};
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'audit-'));
 await fs.writeFile(path.join(dir,'a.js'),'const k="cc-'+'Zq8wLm3Rt7Yp2Kd9Vx4Bn6Hs"');assert.equal(run(dir),1);
 await fs.rm(path.join(dir,'a.js'));await fs.writeFile(path.join(dir,'secrets.json'),'{}');assert.equal(run(dir),1);
 await fs.rm(path.join(dir,'secrets.json'));await fs.writeFile(path.join(dir,'ok.js'),'const k="cc-[СКРЫТО]"');assert.equal(run(dir),0);
 assert.equal(run('.'),0);assert.equal(run('dist'),0);
});

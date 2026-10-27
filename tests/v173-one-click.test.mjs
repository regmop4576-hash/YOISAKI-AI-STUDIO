// v1.7.3 one-click connection, model inventory, address discovery and browser Google OAuth.
// Everything external is a test double: GPU engine (upstream), Google token endpoint, ntfy. No real network, no GPU.
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';
import {createLocalApp} from '../server/app.mjs';import {AppError} from '../server/errors.mjs';import {parseTunnel,requestUpstream} from '../server/upstream.mjs';
import {parseInventory} from '../server/inventory.mjs';import {components,classify} from '../server/connect-flow.mjs';import {pickLatest,sign,topicFor,discover} from '../server/rendezvous.mjs';
import {OAuthFlows,exchangeCode,validateClient,SCOPE} from '../server/google-oauth.mjs';import {validateSyncStart} from '../server/drive-sync.mjs';
const token='d'.repeat(64);
const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'TEST DOUBLE, NOT GPU',vram_total_mb:10240,vram_available_mb:9000};
const id=n=>String(n).repeat(32).slice(0,32);
const ckpt={id:id('a'),name:'waiIllustriousSDXL_v170.safetensors',kind:'checkpoint',architecture:'SDXL',compatible:true,size_bytes:6936000000,metadata:{big:'x'.repeat(5000)}};
const old=[['1','Amber-06.safetensors'],['2','DiivesIXL.safetensors'],['3','Vesper_illustrious_3267741_epoch_8.safetensors']].map(([n,name])=>({id:id(n),name,kind:'lora',architecture:'SDXL',compatible:true,size_bytes:200000000,metadata:{ss_base_model_version:'sdxl_base_v1-0',ss_tag_frequency:'{"huge":1}'}}));
const amberNova={id:id('4'),name:'Amber_Nova.safetensors',kind:'lora',architecture:'SDXL',compatible:true,size_bytes:220000000,metadata:{ss_base_model_version:'sdxl_base_v1-0'},trigger_words:['amber nova']};
const vesperNova={id:id('5'),name:'Vesper_Nova.safetensors',kind:'lora',architecture:'invalid',compatible:false,size_bytes:null};
async function harness(upstream,options={},dir){
 const dataDir=dir||await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-173-'));
 const app=await createLocalApp({dataDir,distDir:path.resolve('dist'),upstream,sleep:async()=>{},...options});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const s=await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}});const cookie=s.headers.get('set-cookie').split(';')[0];
 const call=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'X-Yoisaki-Local':'1',Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()}};
 return {...app,base,call,dataDir};
}
const until=async(fn,ms=5000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,20))}throw Error('timeout')};

test('inventory: one malformed entry is reported, not fatal; reasons and base-model hints; no metadata kept',()=>{
 const inv=parseInventory({models:[ckpt,...old,vesperNova,{...amberNova,metadata:{ss_base_model_version:'sd_v1'},architecture:'unsupported',compatible:false},{id:'bad',name:'broken.safetensors',kind:'lora'}]});
 assert.equal(inv.models.length,6);assert.deepEqual(inv.rejected,[{name:'broken.safetensors',kind:'lora',reason:'неверный ID модели'}]);
 const v=inv.models.find(m=>m.name==='Vesper_Nova.safetensors');assert.match(v.compatibility_reason,/не читается как safetensors/);
 const a=inv.models.find(m=>m.name==='Amber_Nova.safetensors');assert.equal(a.base_model,'sd_v1');assert.match(a.compatibility_reason,/другую базовую модель/);
 assert(inv.models.every(m=>!('metadata' in m)&&!('sidecar' in m)&&!('trigger_words' in m)));
 assert.equal(inv.models.find(m=>m.kind==='checkpoint').compatibility_reason,undefined);
 assert.throws(()=>parseInventory({models:'x'}),e=>e.code==='INVALID_RESPONSE');
});

test('Amber_Nova / Vesper_Nova: a forced refresh brings both; the incompatible one keeps its reason; page reload path too',async()=>{
 let models=[ckpt,...old];const h=await harness(async(c,p)=>p==='/health'?health:p==='/models'?{models}:(()=>{throw new AppError('JOB_NOT_FOUND','404',404)})());
 try{
  assert.equal((await h.call('/api/gpu/connect','POST',{url:'https://nova.trycloudflare.com/#token='+token})).body.state,'READY');
  models=[ckpt,...old,amberNova,vesperNova];
  assert.equal((await h.call('/api/gpu/status')).body.models.length,4);  // plain status: unchanged by design (no /models call)
  const st=(await h.call('/api/gpu/status?models=1')).body;
  assert.deepEqual(st.models.filter(m=>m.kind==='lora').map(m=>m.name).sort(),['Amber-06.safetensors','Amber_Nova.safetensors','DiivesIXL.safetensors','Vesper_Nova.safetensors','Vesper_illustrious_3267741_epoch_8.safetensors']);
  assert.equal(st.models.find(m=>m.name==='Vesper_Nova.safetensors').compatible,false);assert(st.models.find(m=>m.name==='Vesper_Nova.safetensors').compatibility_reason);
  assert.equal(st.models_stale,false);assert.equal(st.models_error,'');assert(st.models_updated_at>0);
  const disk=await fs.readFile(path.join(h.dataDir,'state.json'),'utf8');assert(!disk.includes('xxxxxxxxxx')&&!disk.includes('ss_tag_frequency'));
  assert.equal((await h.call('/api/connect/lora-tags')).body.items.find(x=>x.model_id===amberNova.id).trigger_words[0],'amber nova');
 }finally{await h.close()}
});

test('a forced model refresh is never swallowed by a plain refresh already in flight',async()=>{
 let release,modelsCalls=0;const slow=new Promise(r=>release=r);let slowHealth=false;
 const h=await harness(async(c,p)=>{if(p==='/health'){if(slowHealth){slowHealth=false;await slow}return health}if(p==='/models'){modelsCalls++;return {models:[ckpt,amberNova]}}throw new AppError('JOB_NOT_FOUND','404',404)});
 try{
  await h.call('/api/gpu/connect','POST',{url:'https://race.trycloudflare.com/#token='+token});const before=modelsCalls;
  slowHealth=true;const plain=h.call('/api/gpu/status');await new Promise(r=>setTimeout(r,30));
  const forced=h.call('/api/gpu/status?models=1');await new Promise(r=>setTimeout(r,30));release();
  await plain;const st=(await forced).body;
  assert.equal(modelsCalls,before+1);assert(st.models.some(m=>m.name==='Amber_Nova.safetensors'));
 }finally{await h.close()}
});

test('failed model refresh keeps the GPU usable and marks the old list stale with the reason',async()=>{
 let fail=false;const h=await harness(async(c,p)=>{if(p==='/health')return health;if(p==='/models'){if(fail)throw new AppError('UPSTREAM_TOO_LARGE','Ответ GPU превышает допустимый размер.',502);return {models:[ckpt,...old]}}throw new AppError('JOB_NOT_FOUND','404',404)});
 try{
  await h.call('/api/gpu/connect','POST',{url:'https://stale.trycloudflare.com/#token='+token});fail=true;
  const st=(await h.call('/api/gpu/status?models=1')).body;
  assert.equal(st.state,'READY');assert.equal(st.models.length,4);assert.equal(st.models_stale,true);assert.equal(st.models_code,'UPSTREAM_TOO_LARGE');assert.match(st.models_error,/превышает/);
  assert.equal(st.components.models,'WARNING');assert.equal(st.components.engine,'READY');
  fail=false;const ok=(await h.call('/api/gpu/status?models=1')).body;assert.equal(ok.models_stale,false);assert.equal(ok.models_error,'');
 }finally{await h.close()}
});

test('CloudCompute /inventory revision: new files appear on the next plain status without pressing anything',async()=>{
 let rev='1'.repeat(32),list=[ckpt,...old];const seen=[];
 const h=await harness(async(c,p)=>{seen.push(p);if(p==='/health')return health;if(p==='/inventory')return {revision:rev};if(p==='/inventory?models=1')return {revision:rev,models:list};throw Error('unexpected '+p)});
 try{
  await h.call('/api/gpu/provider','POST',{provider:'cloudcompute'});
  await h.call('/api/gpu/connect','POST',{url:'https://gpu.example.com/#token='+token,provider:'cloudcompute'});
  assert(seen.includes('/inventory?models=1')&&!seen.includes('/models'));
  await h.call('/api/gpu/status');assert.equal(seen.filter(p=>p==='/inventory?models=1').length,1);  // unchanged revision: no reload
  rev='2'.repeat(32);list=[ckpt,...old,amberNova,vesperNova];
  const st=(await h.call('/api/gpu/status')).body;assert.equal(st.models.length,6);assert.equal(seen.filter(p=>p==='/inventory?models=1').length,2);
 }finally{await h.close()}
});

test('older CloudCompute servers without /inventory fall back to /models once',async()=>{
 const seen=[];const h=await harness(async(c,p)=>{seen.push(p);if(p==='/health')return health;if(p==='/models')return {models:[ckpt]};throw new AppError('JOB_NOT_FOUND','404',404)});
 try{
  await h.call('/api/gpu/provider','POST',{provider:'cloudcompute'});
  assert.equal((await h.call('/api/gpu/connect','POST',{url:'https://old172.example.com/#token='+token,provider:'cloudcompute'})).body.state,'READY');
  await h.call('/api/gpu/status');await h.call('/api/gpu/status?models=1');
  assert.deepEqual(seen,['/health','/inventory?models=1','/models','/health','/health','/models']);
 }finally{await h.close()}
});

test('remember: token only in secrets.json (0600), never in state.json or any status; forget removes it',async()=>{
 const h=await harness(async(c,p)=>p==='/health'?health:{models:[ckpt]});
 try{
  await h.call('/api/gpu/provider','POST',{provider:'cloudcompute'});
  const st=(await h.call('/api/gpu/connect','POST',{url:'https://gpu.example.com/#token='+token,provider:'cloudcompute',remember:true})).body;
  assert.deepEqual(Object.keys(st.remembered.cloudcompute).sort(),['discover','origin','saved_at']);assert.equal(st.remembered.cloudcompute.origin,'https://gpu.example.com');
  assert(!JSON.stringify(st).includes(token));assert(!JSON.stringify((await h.call('/api/diagnostics')).body).includes(token));
  const secrets=path.join(h.dataDir,'secrets.json');assert.equal((await fs.stat(secrets)).mode&0o777,0o600);assert((await fs.readFile(secrets,'utf8')).includes(token));
  assert(!(await fs.readFile(path.join(h.dataDir,'state.json'),'utf8')).includes(token));
  assert.equal((await h.call('/api/gpu/remembered','POST',{provider:'cloudcompute',forget:true})).body.remembered.cloudcompute,null);
  assert(!(await fs.readFile(secrets,'utf8')).includes(token));
  assert.equal((await h.call('/api/gpu/autoconnect','POST',{provider:'cloudcompute'})).body.code,'NOT_REMEMBERED');
 }finally{await h.close()}
});

test('one-click auto-connect waits while the GPU boots (530 / DNS), then connects; phases are reported',async()=>{
 let failures=[];const phases=[];let h;
 h=await harness(async(c,p)=>{if(p==='/health'&&failures.length){const code=failures.shift();throw new AppError(code,'test '+code,502)}return p==='/health'?health:{models:[ckpt]}},{sleep:async()=>{phases.push(h.status().phase)}});
 try{
  await h.call('/api/gpu/provider','POST',{provider:'cloudcompute'});
  await h.call('/api/gpu/connect','POST',{url:'https://gpu.example.com/#token='+token,provider:'cloudcompute',remember:true});
  await h.call('/api/gpu/disconnect','POST');failures=['TUNNEL_OFFLINE','DNS_ERROR','UPSTREAM_HTTP'];
  const first=await h.call('/api/gpu/autoconnect','POST',{provider:'cloudcompute'});assert.equal(first.status,202);assert.equal(first.body.state,'CONNECTING');
  const st=await until(async()=>{const s=(await h.call('/api/gpu/status')).body;return s.state==='READY'&&s});
  assert.equal(st.phase,'READY');assert.equal(st.url,'https://gpu.example.com');assert.equal(st.autoconnect,null);
  assert.deepEqual(phases,['STARTING','STARTING','STARTING']);
 }finally{await h.close()}
});

test('auto-connect stops at once when waiting cannot help (token rotated) and explains it',async()=>{
 let attempts=0;const h=await harness(async(c,p)=>{if(p==='/health'){attempts++;if(attempts>1)throw new AppError('AUTH_REJECTED','GPU отклонил токен.',401)}return p==='/health'?health:{models:[ckpt]}});
 try{
  await h.call('/api/gpu/connect','POST',{url:'https://tok.trycloudflare.com/#token='+token,remember:true});await h.call('/api/gpu/disconnect','POST');
  await h.call('/api/gpu/autoconnect','POST',{});
  const st=await until(async()=>{const s=(await h.call('/api/gpu/status')).body;return s.phase==='ERROR'&&s});
  assert.equal(attempts,2);assert.equal(st.code,'AUTH_REJECTED');assert.match(st.phase_message,/токен/);assert.equal(st.components.auth,'ERROR');assert.equal(st.components.tunnel,'READY');
 }finally{await h.close()}
});

const savedDir=async connections=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-173-'));await fs.writeFile(path.join(dir,'secrets.json'),JSON.stringify({version:1,connections}));return dir};

test('disconnect cancels a waiting auto-connect',async()=>{
 let calls=0;const dir=await savedDir({colab:{origin:'https://wait.trycloudflare.com',token,saved_at:1}});
 const h=await harness(async()=>{calls++;throw new AppError('TUNNEL_OFFLINE','offline',502)},{sleep:ms=>new Promise(r=>setTimeout(r,5))},dir);
 try{
  await h.call('/api/gpu/autoconnect','POST',{});await until(async()=>calls>=3);
  assert.equal((await h.call('/api/gpu/disconnect','POST')).body.phase,'OFFLINE');const n=calls;await new Promise(r=>setTimeout(r,80));
  assert(calls<=n+1,'loop must stop after disconnect');
 }finally{await h.close()}
});

test('address discovery: a signed new Quick Tunnel address is followed; forged, stale or foreign ones are ignored',async()=>{
 const now=Math.floor(Date.now()/1000);const good='https://new-name.trycloudflare.com';
 const line=(rec)=>JSON.stringify({event:'message',message:JSON.stringify(rec)});
 const body=[line({v:1,url:'https://evil.trycloudflare.com',ts:now+10,sig:'0'.repeat(64)}),line({v:1,url:good,ts:now,sig:sign(token,good,now)}),line({v:1,url:'https://older.trycloudflare.com',ts:now-100,sig:sign(token,'https://older.trycloudflare.com',now-100)}),'garbage'].join('\n');
 assert.equal(pickLatest(body,token).url,good);assert.equal(pickLatest(body,'e'.repeat(64)),null);
 assert.equal(pickLatest(line({v:1,url:good,ts:now-90000,sig:sign(token,good,now-90000)}),token),null);  // older than 24 h
 assert.match(topicFor(token),/^yoisaki-[a-f0-9]{40}$/);let asked='';
 assert.equal(await discover(token,{fetchText:async p=>{asked=p;return body}}),good);assert(asked.startsWith('/'+topicFor(token)+'/json?poll=1'));
 // The app follows the discovered address and remembers it.
 const tried=[];let found=good;
 const dir=await savedDir({colab:{origin:'https://old-name.trycloudflare.com',token,saved_at:1,discover:true}});
 const h=await harness(async(c,p)=>{tried.push(c.origin);if(c.origin!==good)throw new AppError('DNS_ERROR','dns',502);return p==='/health'?health:{models:[ckpt]}},{discoverAddress:async t=>{assert.equal(t,token);return found},sleep:ms=>new Promise(r=>setTimeout(r,5))},dir);
 try{
  await h.call('/api/gpu/autoconnect','POST',{});const st=await until(async()=>{const s=(await h.call('/api/gpu/status')).body;return s.state==='READY'&&s.remembered.colab?.origin===good&&s});
  assert.equal(st.url,good);assert.equal(st.remembered.colab.discover,true);assert.equal(st.remembered.colab.origin,good);assert.deepEqual([...new Set(tried)],['https://old-name.trycloudflare.com',good]);
  // A discovered address outside the provider policy is never contacted.
  await h.call('/api/gpu/disconnect','POST');await h.call('/api/gpu/remembered','POST',{provider:'colab',forget:true});
 }finally{await h.close()}
 const tried2=[];const dir2=await savedDir({colab:{origin:'https://old-name.trycloudflare.com',token,saved_at:1,discover:true}});
 const h2=await harness(async(c)=>{tried2.push(c.origin);throw new AppError('DNS_ERROR','dns',502)},{discoverAddress:async()=>'https://evil.example.com',sleep:ms=>new Promise(r=>setTimeout(r,5))},dir2);
 try{
  await h2.call('/api/gpu/autoconnect','POST',{});await until(async()=>tried2.length>=3);await h2.call('/api/gpu/disconnect','POST');
  assert.deepEqual([...new Set(tried2)],['https://old-name.trycloudflare.com']);
 }finally{await h2.close()}
});

test('Cloudflare 530 (tunnel without a connector) is reported as TUNNEL_OFFLINE',async()=>{
 const transport=(o,cb)=>{const req=new EventEmitter();req.end=()=>{const res=new EventEmitter();res.statusCode=530;res.headers={'content-type':'text/html'};cb(res);res.emit('data',Buffer.from('<html>1033</html>'));res.emit('end')};req.destroy=()=>{};return req};
 await assert.rejects(()=>requestUpstream(parseTunnel('https://gone.trycloudflare.com/#token='+token),'/health',{lookup:async()=>[{address:'1.1.1.1',family:4}],transport}),e=>e.code==='TUNNEL_OFFLINE');
 assert.equal(classify('TUNNEL_OFFLINE').retry,true);assert.equal(classify('AUTH_REJECTED').retry,false);
});

test('component diagnostics name the failing part and never claim unreached parts are READY',()=>{
 assert.deepEqual(components({phase:'ERROR',code:'DNS_ERROR'}),{frontend:'READY',tunnel:'ERROR',auth:'UNKNOWN',engine:'UNKNOWN',gpu:'UNKNOWN',models:'UNKNOWN'});
 assert.deepEqual(components({phase:'ERROR',code:'GPU_NOT_READY'}),{frontend:'READY',tunnel:'READY',auth:'READY',engine:'READY',gpu:'ERROR',models:'UNKNOWN'});
 assert.equal(components({phase:'ERROR',code:'UPSTREAM_HTTP'}).auth,'UNKNOWN');
 assert.equal(components({phase:'STARTING',code:'TUNNEL_OFFLINE'}).tunnel,'WAITING');
 assert.deepEqual(components({phase:'READY',info:health,modelsCount:3,usableCheckpoints:true}),{frontend:'READY',tunnel:'READY',auth:'READY',engine:'READY',gpu:'READY',models:'READY'});
});

test('Google OAuth helpers: Desktop client format, PKCE S256, single-use state, token exchange errors',async()=>{
 assert.throws(()=>validateClient({client_id:'x',client_secret:'y'}),e=>e.code==='DRIVE_INVALID_CLIENT');
 const client=validateClient({client_id:'123456789-abcdefghij.apps.googleusercontent.com',client_secret:'GOCSPX-abcdefghijk'});
 const flows=new OAuthFlows();const url=new URL(flows.start(client,3000,{origin:'https://gpu.example.com'}));
 assert.equal(url.host,'accounts.google.com');assert.equal(url.searchParams.get('scope'),SCOPE);assert.equal(url.searchParams.get('redirect_uri'),'http://127.0.0.1:3000/');
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('access_type'),'offline');
 const state=url.searchParams.get('state');const pending=flows.take(state);assert(pending.verifier.length>=43);assert.equal(flows.take(state),null);
 let sent;const tokenObj=await exchangeCode(client,'code-1',pending,{now:0,post:async form=>{sent=form;return {status:200,json:{access_token:'ya29.a',refresh_token:'1//r',expires_in:3599,scope:SCOPE,token_type:'Bearer'}}}});
 assert.equal(sent.code_verifier,pending.verifier);assert.equal(sent.redirect_uri,'http://127.0.0.1:3000/');
 assert.deepEqual(tokenObj,{access_token:'ya29.a',token_type:'Bearer',refresh_token:'1//r',expiry:'1970-01-01T00:59:59.000Z'});
 await assert.rejects(()=>exchangeCode(client,'c',pending,{post:async()=>({status:200,json:{access_token:'a'}})}),/refresh token/);
 await assert.rejects(()=>exchangeCode(client,'c',pending,{post:async()=>({status:400,json:{error:'invalid_grant'}})}),/устарел/);
});

test('browser Google Drive authorization end to end: Google redirect → token exchange → GPU /sync/drive/connect',async()=>{
 const sync={service:'YOISAKI_DRIVE_SYNC',version:1,enabled:true,rclone_available:true,configured:true,connection:{state:'UNKNOWN',error:'',code:''},source:'s',scope:'drive.readonly',job:null,items:[],disk:null,last_success_unix:null,last_check_unix:null,inventory_revision:0,verification:'',owner:'self',selective:true};
 let forwarded=null;const h=await harness(async(c,p,o={})=>{if(p==='/health')return health;if(p==='/inventory?models=1')return {revision:'1'.repeat(32),models:[]};if(p==='/sync/drive/connect'){forwarded=JSON.parse(o.body);return sync}throw Error(p)},{exchange:async(client,code,pending)=>{assert.equal(code,'from-google');assert(pending.verifier);return {access_token:'ya29.x',token_type:'Bearer',refresh_token:'1//refresh-secret',expiry:'2026-10-27T10:00:00.000Z'}}});
 try{
  assert.equal((await h.call('/api/drive/oauth/start','POST',{})).body.code,'DRIVE_OAUTH_NOT_CONFIGURED');
  const cfg=(await h.call('/api/drive/oauth','PUT',{client_id:'123456789-abcdefghij.apps.googleusercontent.com',client_secret:'GOCSPX-abcdefghijk'})).body;
  assert.equal(cfg.configured,true);assert(!JSON.stringify(cfg).includes('GOCSPX'));
  assert.equal((await h.call('/api/drive/oauth/start','POST',{})).body.code,'GPU_OFFLINE');
  await h.call('/api/gpu/provider','POST',{provider:'cloudcompute'});await h.call('/api/gpu/connect','POST',{url:'https://gpu.example.com/#token='+token,provider:'cloudcompute'});
  const {url}=(await h.call('/api/drive/oauth/start','POST',{})).body;const state=new URL(url).searchParams.get('state');
  // Unknown state from a foreign site: rejected by the normal cross-site rule.
  assert.equal((await fetch(h.base+'/?state='+'f'.repeat(64)+'&code=x',{headers:{'Sec-Fetch-Site':'cross-site'},redirect:'manual'})).status,403);
  const back=await fetch(h.base+'/?state='+state+'&code=from-google&scope='+encodeURIComponent(SCOPE),{headers:{'Sec-Fetch-Site':'cross-site'},redirect:'manual'});
  assert.equal(back.status,302);assert.equal(back.headers.get('location'),'/models?drive_auth=1');
  assert.equal(JSON.parse(forwarded.token).refresh_token,'1//refresh-secret');assert.equal(forwarded.client_id,'123456789-abcdefghij.apps.googleusercontent.com');
  assert.equal((await h.call('/api/drive/oauth')).body.last_result.ok,true);
  assert.equal((await fetch(h.base+'/?state='+state+'&code=again',{headers:{'Sec-Fetch-Site':'cross-site'},redirect:'manual'})).status,403);  // single use
  for(const f of await fs.readdir(h.dataDir))if((await fs.stat(path.join(h.dataDir,f))).isFile())assert(!(await fs.readFile(path.join(h.dataDir,f),'utf8')).includes('refresh-secret'),f);
 }finally{await h.close()}
});

test('selective Drive sync: the selection is validated and forwarded; an empty body still syncs everything',async()=>{
 assert.equal(validateSyncStart(Buffer.from('')),'{}');assert.equal(validateSyncStart('{}'),'{}');
 assert.equal(validateSyncStart('{"paths":["loras/Amber_Nova.safetensors","loras/Amber_Nova.safetensors"]}'),'{"paths":["loras/Amber_Nova.safetensors"]}');
 for(const bad of ['{"paths":[]}','{"paths":[1]}','{"other":1}','[1]','{"paths":["a\\u0000"]}'])assert.throws(()=>validateSyncStart(bad),bad);
});

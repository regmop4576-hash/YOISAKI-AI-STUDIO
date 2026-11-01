import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initializeTerminal,terminalUrl} from '../server/cloudcompute-terminal.mjs';
import {instanceView} from '../server/cloudcompute-api.mjs';
import {classifyProvider,ENGINE_IMAGE,DeploymentWatcher,onstartScript} from '../server/cloudcompute-deploy.mjs';
import {SecretStore} from '../server/secrets.mjs';
import {diagnosticsReport} from '../server/cc-diagnostics.mjs';
import {createLocalApp} from '../server/app.mjs';
const run=promisify(execFile),token='b'.repeat(64);

function socketClass({code=0,echoOnly=false,closed=false}={}){
 return class Socket extends EventTarget{
  static frames=[];
  constructor(url,protocol){super();assert.equal(url,'wss://app.cloudcompute.ru/ws?token=temporary');assert.deepEqual(protocol,['tty']);queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
  output(s){queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:Buffer.from('0'+s)})))}
  send(value){
   const frame=String(value);this.constructor.frames.push(frame);
   if(frame.startsWith('{')){assert.equal(JSON.parse(frame).AuthToken,'');this.output('root@container:~# ');return}
   if(frame.includes('stty -echo')){
    assert(!frame.includes(token));const nonce=frame.match(/'([a-f0-9]{24})'/)[1];
    this.output(frame); // echo cannot be mistaken for the ready marker
    if(!echoOnly)this.output('\r\nY_READY_'+nonce+'\r\n');return;
   }
   assert(frame.includes(token));assert(frame.includes('--provision'));assert(!frame.includes('docker run'));
   if(closed){queueMicrotask(()=>this.dispatchEvent(new Event('close')));return}
   const nonce=frame.match(/Y_SCRIPT_([a-f0-9]{24})/)[1];
   this.output('YOISAKI_SUPERVISOR_CONFIRMED\r\nYOISAKI_DIAGNOSTICS {"image_version":"1.7.7.1","directories":{"config":true,"logs":true,"runtime":true,"models":true},"provisioning_completed":true,"supervisor_confirmed":true}\r\n');
   this.output('\r\nY_DONE_'+nonce+':'+code+'\r\n');
  }
  close(){}
 };
}
const cloud={terminalSession:async id=>{assert.equal(id,'10766');return {ws_url:'wss://app.cloudcompute.ru/ws?token=temporary',expires_in:300}}};
const args={cloud,instanceId:'10766',image:ENGINE_IMAGE,token};
test('official terminal: tty handshake, echo-off acknowledged before secret transfer, successful exit and snapshot',async()=>{
 const W=socketClass(),result=await initializeTerminal({...args,WebSocketImpl:W});
 assert.equal(result.supervisor_confirmed,true);assert.equal(result.snapshot.directories.models,true);
 assert(!JSON.stringify(result).includes(token));assert(!JSON.stringify(result).includes('temporary'));
 assert.equal(W.frames.length,3);
});
test('terminal: rejected bootstrap exit, closed socket and timeout do not report success or leak credentials',async()=>{
 for(const [opts,code] of [[{code:42},'CC_INIT_EXIT_42'],[{closed:true},'CC_TERMINAL_CLOSED'],[{echoOnly:true},'CC_TERMINAL_TIMEOUT']]){
  const W=socketClass(opts);
  await assert.rejects(initializeTerminal({...args,WebSocketImpl:W,timeout:40}),e=>e.code===code&&!e.message.includes(token));
  if(opts.echoOnly)assert(!W.frames.some(s=>s.includes(token)));
 }
});
test('terminal: refuse untrusted URLs, cleartext and malformed/missing initialization data',async()=>{
 for(const url of ['ws://app.cloudcompute.ru/ws','wss://localhost/ws','wss://cloudcompute.ru.evil.test/ws','wss://app.cloudcompute.ru:8443/ws','wss://u:p@app.cloudcompute.ru/ws',undefined])assert.throws(()=>terminalUrl(url));
 await assert.rejects(initializeTerminal({...args,cloud:{terminalSession:async()=>({})}}),e=>e.code==='CC_TERMINAL_URL');
});
test('provider: numeric statuses stay unknown with original type, 0 is not discarded, documented companion string can classify',()=>{
 for(const raw of [0,1,2,99,'0','1','99']){const v=instanceView({id:10766,status:raw});assert.equal(v.raw_status,raw);assert.equal(v.status,String(raw));assert.equal(classifyProvider(v).phase,'UNKNOWN')}
 for(const [raw,phase] of [['running','RUNNING'],['loading','IMAGE'],['failed','FAILED'],['stopped','STOPPED']])assert.equal(classifyProvider(instanceView({id:1,status:raw})).phase,phase);
 assert.equal(classifyProvider(instanceView({id:1,status:1,state:'running'})).phase,'RUNNING');
 assert.equal(classifyProvider(instanceView({id:1,status:1,intended_status:'running'})).phase,'UNKNOWN');
});
test('generated onstart returns actual exit status and does not invent initialization success',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'startup-script-'));
 try{
  await fs.mkdir(path.join(dir,'cloudcompute'));const file=path.join(dir,'cloudcompute/autostart-image.sh');
  await fs.writeFile(file,'#!/bin/bash\nexit 17\n',{mode:0o755});
  await assert.rejects(run('bash',['-c',onstartScript({image:ENGINE_IMAGE,token})],{env:{...process.env,YOISAKI_APP_DIR:dir}}),e=>e.code===17&&!e.stdout.includes('INIT_OK')&&!e.stderr.includes(token));
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
test('readiness timeout also applies after URL discovery; failed connection can retry',async()=>{
 let now=10000000,connects=0;
 let d={instance_id:'10766',token,image:ENGINE_IMAGE,created_at:now,stage:'ENGINE_HEALTH_CHECK',url:'https://gpu-test.trycloudflare.com',gpu_stages:[]};
 const secrets={deployment:()=>d,change:async fn=>{const x={deployment:d};fn(x);d=x.deployment}};
 const watcher=new DeploymentWatcher({secrets,cloud:{detail:async()=>({id:10766,status:1})},progress:async()=>({url:d.url,stages:[]}),connect:async()=>{connects++;throw Error('unreachable')},connectionState:()=>({phase:'ERROR'}),now:()=>now,timeoutMinutes:1});
 await watcher.tick(d,()=>true);assert.equal(connects,1);assert.notEqual(d.stage,'GPU_READY');
 now+=31000;await watcher.tick(d,()=>true);assert.equal(connects,2);
 now+=31000;await watcher.tick(d,()=>true);assert.equal(d.stage,'TIMEOUT');
});

test('local API initialize executes once under concurrency, persists evidence on restart, diagnostic secrets are omitted',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'startup-api-'));let app;
 try{
  const secrets=await new SecretStore(dir).init();await secrets.setCloudKey('cc-test-key-0123456789');
  await secrets.setDeployment({instance_id:'10766',token,image:ENGINE_IMAGE,name:'RTX3090',created_at:Date.now(),stage:'GPU_CREATED'});
  let count=0,release;const gate=new Promise(r=>release=r);
  app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),autoResume:false,
   providerRequest:async()=>({status:200,json:{data:{id:10766,status:1}}}),discoverProgress:async()=>({url:null,stages:[]}),
   terminalInitialize:async a=>{count++;assert.equal(a.instanceId,'10766');assert.equal(a.token,token);await gate;return {completed_at:Date.now(),supervisor_confirmed:true,snapshot:{directories:{config:true,logs:true,runtime:true,models:true},provisioning_completed:true}}}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
  const cookie=(await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}})).headers.get('set-cookie').split(';')[0];
  const call=(route,method='POST')=>fetch(base+route,{method,headers:{cookie,'X-Yoisaki-Local':'1'}}).then(async r=>({status:r.status,body:await r.json()}));
  const a=call('/api/cloudcompute/deploy/initialize'),b=call('/api/cloudcompute/deploy/initialize');
  for(let i=0;i<100&&!count;i++)await new Promise(r=>setTimeout(r,5));assert.equal(count,1);release();
  assert.equal((await a).status,200);assert.equal((await b).status,200);assert.equal(count,1);
  await app.close();app=null;
  const restored=(await new SecretStore(dir).init()).deployment();assert.equal(restored.initialization.supervisor_confirmed,true);
  assert.equal(restored.token,token);
  const report=diagnosticsReport({deployment:restored,connection:{connected:false}});
  assert.equal(report.initialization.required_directories.config,true);assert.equal(report.initialization.engine_ready,false);
  assert(!JSON.stringify(report).includes(token));assert(!JSON.stringify(report).includes('cc-test-key'));
 }finally{if(app)await app.close();await fs.rm(dir,{recursive:true,force:true})}
});

test('startup diagnostics: cross-language HMAC, tampering rejected, secret fields never reach report',async()=>{
 const {pickDiagnostics,signDiagnostics}=await import('../server/rendezvous.mjs');
 const now=Math.floor(Date.now()/1000),data=JSON.stringify({image_version:'1.7.7.1',directories:{config:true},supervisor_confirmed:true,engine_token:token});
 const sig=signDiagnostics(token,data,now);
 const py=await run('python3',['-c','import sys;sys.path.insert(0,"cloudcompute");import rendezvous as r;print(r._mac(sys.argv[1],"yoisaki-rendezvous-diagnostics-v1\\n"+sys.argv[2]+"\\n"+sys.argv[3]))',token,data,String(now)]);
 assert.equal(py.stdout.trim(),sig);
 const record={v:1,kind:'diagnostics',data,ts:now,sig};
 const wrap=r=>JSON.stringify({event:'message',message:JSON.stringify(r)});
 const result=pickDiagnostics(wrap(record),token,now);assert.equal(result.snapshot.directories.config,true);assert(!JSON.stringify(result).includes(token));
 assert.equal(pickDiagnostics(wrap({...record,data:data+' '}),token,now),null);
 assert.equal(pickDiagnostics(wrap({...record,ts:now-100000}),token,now),null);
});

test('app restart resumes missing bootstrap via terminal fallback without creating another rental',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'startup-resume-'));let app,calls=0;
 try{
  const s=await new SecretStore(dir).init();await s.setCloudKey('cc-test-key-0123456789');
  await s.setDeployment({instance_id:'10766',token,image:ENGINE_IMAGE,name:'existing',created_at:Date.now()-120000,stage:'GPU_CREATED',initialization:{requested:true,method:'onstart'}});
  app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),deployInterval:20,
   providerRequest:async(url,opts)=>{assert(url.endsWith('/instances/10766'));assert.equal(opts.method,'GET');return {status:200,json:{data:{id:10766,status:1}}}},
   discoverProgress:async()=>({url:null,stages:[]}),terminalInitialize:async a=>{assert.equal(a.token,token);calls++;return {completed_at:Date.now(),supervisor_confirmed:true}}});
  for(let i=0;i<100&&!calls;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(calls,1);await new Promise(r=>setTimeout(r,100));assert.equal(calls,1);
  await app.close();app=null;
  assert.equal((await new SecretStore(dir).init()).deployment().initialization.supervisor_confirmed,true);
 }finally{if(app)await app.close();await fs.rm(dir,{recursive:true,force:true})}
});

test('terminal still bootstrapping does not exhaust execution retries; Retry-After is enforced for manual retries too',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'startup-wait-'));let app,calls=0;
 try{
  const s=await new SecretStore(dir).init();await s.setCloudKey('cc-test-key-0123456789');
  await s.setDeployment({instance_id:'10766',token,image:ENGINE_IMAGE,name:'existing',created_at:Date.now(),stage:'GPU_CREATED',initialization:{requested:true,method:'onstart'}});
  app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),autoResume:false,
   providerRequest:async()=>({status:200,json:{data:{id:10766,status:1}}}),discoverProgress:async()=>({url:null,stages:[]}),
   terminalInitialize:async()=>{calls++;if(calls<3)throw Object.assign(Error('Terminal not ready'),{code:calls===1?'CC_HTTP_409':'CC_HTTP_429',retry_after:120});return {completed_at:Date.now(),supervisor_confirmed:true}}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
  const cookie=(await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}})).headers.get('set-cookie').split(';')[0];
  const call=(route,method='POST')=>fetch(base+route,{method,headers:{cookie,'X-Yoisaki-Local':'1'}}).then(r=>r.json());
  for(let n=0;n<2;n++){
   await call('/api/cloudcompute/deploy/initialize');const d=(await call('/api/cloudcompute/deploy','GET')).deployment;
   assert.equal(d.initialization.attempts,0);assert(d.initialization.retry_at>Date.now()+110000);assert.equal(d.engine_ready,false);
  }
  const blocked=await call('/api/cloudcompute/deploy/initialize');assert.equal(blocked.code,'CC_INIT_WAIT');assert.equal(calls,2);
 }finally{if(app)await app.close();await fs.rm(dir,{recursive:true,force:true})}
});

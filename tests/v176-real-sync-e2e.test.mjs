// v1.7.6 end-to-end: phone app (this repository's server) ⇄ HTTP ⇄ the REAL GPU sync stack (drive_sync.py +
// sync_api.py + inventory.py, unchanged since 1.7.5) ⇄ the REAL rclone binary. Every byte count, speed, state and
// checksum shown by the monitor here is produced by the real transfer. SIMULATED: Google Drive is a local folder
// (rclone alias), /health is static (no GPU). Skipped when python3+fastapi+uvicorn or rclone are missing.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createLocalApp} from '../server/app.mjs';
import {SecretStore} from '../server/secrets.mjs';
import {AppError} from '../server/errors.mjs';
import {FakeDrive,account} from './fixtures/fake-drive.mjs';

const TOKEN='e'.repeat(64);
const skip=(()=>{try{execFileSync('python3',['-c','import fastapi,uvicorn']);execFileSync('rclone',['version']);return false}catch{return 'python3/fastapi/uvicorn or rclone missing'}})();
async function gpuServer(){
 const work=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-e2e-'));const port=20000+Math.floor(Math.random()*20000);
 const proc=spawn('python3',['-I','tests/real_sync_gpu.py',work,String(port),TOKEN],{stdio:['ignore','pipe','pipe']});let err='';proc.stderr.on('data',d=>{err+=d});
 const info=await new Promise((resolve,reject)=>{let out='';proc.stdout.on('data',d=>{out+=d;const line=out.split('\n').find(l=>l.startsWith('{'));if(line)resolve(JSON.parse(line))});proc.on('exit',c=>reject(Error('gpu server exited '+c+' '+err)))});
 const base='http://127.0.0.1:'+port;
 for(let i=0;i<100;i++){try{await fetch(base+'/health');break}catch{await new Promise(r=>setTimeout(r,100))}}
 // Same contract as server/upstream.mjs requestUpstream: JSON on 2xx, AppError codes otherwise.
 const upstream=async(c,p,o={})=>{
  let r;try{r=await fetch(base+p,{method:o.method||'GET',body:o.body,headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'}})}catch{throw new AppError('TUNNEL_UNAVAILABLE','Туннель недоступен.',502)}
  const json=await r.json().catch(()=>null);
  if(r.status===401)throw new AppError('AUTH_REJECTED','Токен отклонён.',401);if(r.status===404)throw new AppError('JOB_NOT_FOUND','Не найдено.',404);
  if(r.status>=300)throw new AppError('UPSTREAM_HTTP',json?.detail||'HTTP '+r.status,502);return json;
 };
 return {info,upstream,work,ctl:f=>path.join(info.ctl,f),async close(){proc.kill();await new Promise(r=>proc.once('exit',r));await fs.rm(work,{recursive:true,force:true})}};
}
async function phone(gpu,dir=null){
 const fresh=!dir;dir??=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-e2e-phone-'));
 if(fresh){const s=await new SecretStore(dir).init();await s.setDrive(account({id:'selected',name:'YOISAKI_MODELS'}));
  await fs.writeFile(path.join(dir,'drive-library.json'),JSON.stringify({version:1,inventory:null,last_check:null,selection:{folder_id:'selected',folder_name:'YOISAKI_MODELS',updated_at:1,items:{'checkpoints/Illustrious_XL_v17.safetensors':{name:'Illustrious_XL_v17.safetensors',kind:'checkpoint',size:6*2**20},'loras/characters/Amber_Nova.safetensors':{name:'Amber_Nova.safetensors',kind:'lora',size:3*2**20}}}}))}
 const fake=new FakeDrive();
 const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),providerRequest:fake.request,providerBytesRequest:fake.bytes,upstream:gpu.upstream,autoResume:false,driveInterval:200});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const cookie=(await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}})).headers.get('set-cookie').split(';')[0];
 const call=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'X-Yoisaki-Local':'1',cookie},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 await call('/api/gpu/provider','POST',{provider:'cloudcompute'});
 const c=await call('/api/gpu/connect','POST',{url:'https://e2e.trycloudflare.com/#token='+TOKEN,provider:'cloudcompute'});assert.equal(c.body.state,'READY',JSON.stringify(c.body));
 return {dir,call,monitor:async()=>(await call('/api/sync/monitor')).body,async close({keep=false}={}){await app.close();if(!keep)await fs.rm(dir,{recursive:true,force:true})}};
}
async function follow(p,stop,ms=60000){const seen=[];const end=Date.now()+ms;for(;;){const m=await p.monitor();seen.push(m);if(stop(m))return seen;if(Date.now()>end)throw Error('timeout; last '+JSON.stringify(m).slice(0,600));await new Promise(r=>setTimeout(r,80))}}
const exists=f=>fs.access(f).then(()=>true,()=>false);

test('REAL transfer: only selected models are downloaded, progress/speed/ETA come from the transfer, verified, then usable in the generator',{skip,timeout:120000},async()=>{
 const gpu=await gpuServer();const p=await phone(gpu);
 try{
  await fs.writeFile(gpu.ctl('delay'),'0.04');   // ~1.6 MB/s through the shim: progress is observable
  assert.equal((await p.call('/api/sync/start','POST',{mode:'selected'})).status,202);
  const seen=await follow(p,m=>m.job?.state&&m.job.state!=='RUNNING');
  const last=seen.at(-1);assert.equal(last.state,'COMPLETED',JSON.stringify(last.error));
  const states=[...new Set(seen.map(m=>m.state))];assert(states.includes('DOWNLOADING'),states.join());
  const dl=seen.filter(m=>m.state==='DOWNLOADING'&&m.current);assert(dl.length>=3,'progress samples '+dl.length);
  // real counters only grow within a file; the speed comes from the GPU-side rclone stream
  for(const f of new Set(dl.map(m=>m.current.path))){const b=dl.filter(m=>m.current.path===f).map(m=>m.current.bytes_done);assert.deepEqual(b,[...b].sort((x,y)=>x-y),f)}
  assert(dl.some(m=>m.current.speed_bps>0&&m.current.eta_seconds!==null),'speed and ETA observed');
  assert(dl.every(m=>m.current.percent===null||m.current.percent<=100));
  assert.equal(last.overall.files_done,2);assert.equal(last.overall.files_total,2);assert.equal(last.overall.bytes_done,last.overall.bytes_total);
  // only the selection reached the GPU catalogue; nothing partial left as a model
  assert(await exists(path.join(gpu.info.models,'loras/characters/Amber_Nova.safetensors')));assert(await exists(path.join(gpu.info.models,'checkpoints/Illustrious_XL_v17.safetensors')));
  assert(!await exists(path.join(gpu.info.models,'loras/Vesper_Nova.safetensors')));assert(!await exists(path.join(gpu.info.models,'vae/sdxl_vae.safetensors')));
  assert.deepEqual((await fs.readdir(gpu.info.staging)).filter(f=>f.endsWith('.part')),[]);
  const events=last.events.map(e=>e.type);for(const t of ['JOB_STARTED','FILE_STARTED','FILE_INSTALLED','JOB_FINISHED'])assert(events.includes(t),t);
  const installed=last.events.filter(e=>e.type==='FILE_INSTALLED');assert(installed.every(e=>/safetensors/.test(e.verification)),'verified by checksum + safetensors');
  // discovery against the REAL engine catalogue scan
  const m=(await follow(p,x=>x.discovery,20000)).at(-1);
  const amber=m.discovery.files.find(f=>f.name==='Amber_Nova.safetensors');assert.equal(amber.generator,'AVAILABLE');assert.equal(amber.gpu_model.architecture,'SDXL');
  const st=(await p.call('/api/gpu/status')).body;assert(st.models.some(x=>x.name==='Amber_Nova.safetensors'&&x.kind==='lora'&&x.compatible===true));
  // the second run downloads nothing again
  await p.call('/api/sync/start','POST',{mode:'selected'});const again=(await follow(p,x=>x.job?.id!==last.job.id&&x.job?.state!=='RUNNING')).at(-1);
  assert.equal(again.state,'COMPLETED');assert.equal(again.overall.files_total,0);
 }finally{await p.close();await gpu.close()}
});

test('REAL cancel mid-transfer keeps the partial file out of the catalogue; retry resumes from the partial bytes; a phone restart does not restart the download',{skip,timeout:120000},async()=>{
 const gpu=await gpuServer();let p=await phone(gpu);
 try{
  await fs.writeFile(gpu.ctl('delay'),'0.05');
  await p.call('/api/sync/start','POST',{mode:'selected'});
  await follow(p,m=>m.current&&m.current.bytes_done>2**20);
  await p.call('/api/sync/cancel','POST',{});
  const c=(await follow(p,m=>m.job?.state!=='RUNNING')).at(-1);assert.equal(c.state,'CANCELLED');
  const parts=(await fs.readdir(gpu.info.staging)).filter(f=>f.endsWith('.part'));assert.equal(parts.length,1,'partial data preserved for resume');
  const listed=(await p.call('/api/gpu/status?models=1')).body.models.map(m=>m.name);assert(!listed.includes('Illustrious_XL_v17.safetensors')||!listed.includes('Amber_Nova.safetensors'),'partial file never listed as a model');
  // retry → resumes
  await p.call('/api/sync/start','POST',{mode:'retry'});
  const resumed=(await follow(p,m=>m.current?.resumed_from>0||m.job?.state!=='RUNNING')).at(-1);assert(resumed.current?.resumed_from>0,'resumed_from '+JSON.stringify(resumed.current));
  const jobId=resumed.job.id;
  // the phone app is restarted while the GPU keeps downloading
  await p.close({keep:true});p=await phone(gpu,p.dir);
  const fin=(await follow(p,m=>m.job?.state&&m.job.state!=='RUNNING')).at(-1);assert.equal(fin.job.id,jobId);assert.equal(fin.state,'COMPLETED');
  const log=(await fs.readFile(gpu.ctl('log'),'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const cats=log.filter(a=>a[2]==='cat'&&a.join(' ').includes('Illustrious'));assert(cats.some(a=>a.includes('--offset')),'resume used --offset, not a fresh download');
 }finally{await p.close();await gpu.close()}
});

test('REAL corrupted transfer fails checksum verification: reported per file, never installed, retry downloads correctly',{skip,timeout:120000},async()=>{
 const gpu=await gpuServer();const p=await phone(gpu);
 try{
  await fs.writeFile(gpu.ctl('corrupt'),'1');
  await p.call('/api/sync/start','POST',{mode:'selected'});
  const m=(await follow(p,x=>x.job?.state&&x.job.state!=='RUNNING')).at(-1);
  assert.equal(m.state,'ERROR');assert.equal(m.overall.files_failed,2);assert.match(m.error.action,/Повторить/);
  assert(m.events.filter(e=>e.type==='FILE_FAILED').every(e=>/контрольная сумма|safetensors/i.test(e.reason)));
  assert(!await exists(path.join(gpu.info.models,'loras/characters/Amber_Nova.safetensors')));
  const lib=(await p.call('/api/drive/library')).body;assert(lib.estimate.installed_on_gpu===0);
  await fs.rm(gpu.ctl('corrupt'));await p.call('/api/sync/start','POST',{mode:'retry'});
  const ok=(await follow(p,x=>x.job?.id!==m.job.id&&x.job?.state!=='RUNNING')).at(-1);assert.equal(ok.state,'COMPLETED');assert.equal(ok.failures.consecutive,0);
 }finally{await p.close();await gpu.close()}
});

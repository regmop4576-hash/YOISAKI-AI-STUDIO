// v1.7.6 Google Drive model library without a GPU. SIMULATED: Google Drive and OAuth are an in-memory double
// (tests/fixtures/fake-drive.mjs); no GPU, CloudCompute or real Google account is used.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createLocalApp} from '../server/app.mjs';
import {SecretStore} from '../server/secrets.mjs';
import {syncRule,engineRule,inspectHeader,parseHeader,headerLength,headerReport,selectionEstimate,compareSources,SYNC_RESERVE} from '../server/drive-library.mjs';
import {FakeDrive,account,safetensors,KEYS} from './fixtures/fake-drive.mjs';

const GB=2**30,MB=2**20;
async function harness({drive=account(),fake=new FakeDrive(),upstream=async()=>{throw Object.assign(Error('no GPU'),{code:'TUNNEL_UNAVAILABLE'})},dir=null}={}){
 dir??=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-176-'));
 if(drive){const s=await new SecretStore(dir).init();await s.setDrive(drive)}
 const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),providerRequest:fake.request,providerBytesRequest:fake.bytes,upstream,autoResume:false,sleep:()=>new Promise(r=>setTimeout(r,2)),driveInterval:5});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const cookie=(await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}})).headers.get('set-cookie').split(';')[0];
 const call=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'X-Yoisaki-Local':'1',cookie},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 return {app,dir,fake,call,async close({keep=false}={}){await app.close();if(!keep)await fs.rm(dir,{recursive:true,force:true})}};
}
// A realistic library: SDXL checkpoint, two SDXL LoRA (Amber_Nova, Vesper_Nova), SD1 LoRA, VAE, ControlNet, pickle,
// nested folders, a file outside the model folders and a sidecar json.
function library(fake){
 // headers declare exactly the file size, like real files (payload check OK)
 const make=(keys,meta,size)=>safetensors(keys,meta,size);
 fake.folder('f-ckpt','checkpoints');fake.folder('f-lora','loras');fake.folder('f-vae','vae');fake.folder('f-cn','controlnet');fake.folder('f-char','characters','f-lora');fake.folder('f-misc','misc');
 const put=(id,name,parent,keys,meta,size,extra={})=>{const h=make(keys,meta,size);fake.file(id,name,parent,{header:h.header,size:h.size,...extra})};
 put('ill','Illustrious_XL_v17.safetensors','f-ckpt',KEYS.checkpoint,{'modelspec.architecture':'stable-diffusion-xl-v1-base'},Math.round(6.6*GB),{sha256:'a'.repeat(64)});
 put('amber','Amber_Nova.safetensors','f-char',KEYS.lora_xl,{ss_base_model_version:'sdxl_base_v1-0'},193*MB);
 put('vesper','Vesper_Nova.safetensors','f-lora',KEYS.lora_xl,{ss_base_model_version:'sdxl_base_v1-0'},185*MB);
 put('old','old_sd15.safetensors','f-lora',KEYS.lora_sd1,{ss_base_model_version:'sd_v1'},144*MB);
 put('vae','sdxl_vae.safetensors','f-vae',KEYS.vae,{},319*MB);
 put('cn','openpose_xl.safetensors','f-cn',['controlnet_cond_embedding.conv_in.weight','down_blocks.0.w'],{},Math.round(2.5*GB));
 fake.file('pkl','legacy.ckpt','f-ckpt',{size:2*GB});
 put('stray','stray_model.safetensors','f-misc',KEYS.lora_xl,{},50*MB);
 fake.file('side','Amber_Nova.json','f-char',{size:300,mime:'application/json'});
}
const size=(fake,id)=>fake.nodes.get(id).size;

test('GPU disconnected + Google connected: CHECK GOOGLE DRIVE lists real files with engine rules; GET never claims fresh',async()=>{
 const h=await harness();library(h.fake);
 try{
  let r=await h.call('/api/drive/library');assert.equal(r.body.state,'NONE');assert.equal(r.body.inventory,null);assert.equal(r.body.gpu.connected,false);
  r=await h.call('/api/drive/library/check','POST',{});assert.equal(r.status,200);assert.equal(r.body.state,'VERIFIED');assert.equal(r.body.verified_now,true);
  const inv=r.body.inventory,by=Object.fromEntries(inv.items.map(i=>[i.name,i]));
  assert.equal(inv.folder.name,'YOISAKI_MODELS');assert.equal(inv.items.length,8);assert.equal(inv.non_model_files,1);assert(inv.verified_at>0);
  assert.equal(by['Amber_Nova.safetensors'].path,'loras/characters/Amber_Nova.safetensors');assert.equal(by['Amber_Nova.safetensors'].kind,'lora');assert.equal(by['Amber_Nova.safetensors'].sync.eligible,true);
  assert.equal(by['Illustrious_XL_v17.safetensors'].kind,'checkpoint');assert.deepEqual(by['Illustrious_XL_v17.safetensors'].checksum,{type:'sha256',value:'a'.repeat(64)});assert.equal(by['Illustrious_XL_v17.safetensors'].revision,'rev-ill');
  assert.equal(by['legacy.ckpt'].format,'ckpt');assert.equal(by['legacy.ckpt'].sync.eligible,false);assert.match(by['legacy.ckpt'].sync.reason,/pickle/);
  assert.equal(by['openpose_xl.safetensors'].kind,'controlnet');assert.equal(by['openpose_xl.safetensors'].sync.eligible,false);assert.match(by['openpose_xl.safetensors'].reason,/Hugging Face/);
  assert.equal(by['stray_model.safetensors'].kind,'unknown');assert.match(by['stray_model.safetensors'].reason,/не видит/);
  // no architecture is invented before the header is read
  assert(inv.items.every(i=>!i.header));
  // a later GET is the CACHED inventory, never VERIFIED
  r=await h.call('/api/drive/library');assert.equal(r.body.state,'CACHED');assert.equal(r.body.verified_now,undefined);assert.equal(r.body.inventory.verified_at,inv.verified_at);
  // no GPU was contacted
  assert(!h.fake.calls.some(u=>!u.includes('googleapis.com')));
 }finally{await h.close()}
});

test('header inspection reads only the safetensors header (Range), classifies like the engine and never downloads weights',async()=>{
 const h=await harness();library(h.fake);
 try{
  await h.call('/api/drive/library/check','POST',{});
  const r=await h.call('/api/drive/library/inspect','POST',{ids:['ill','amber','old','vae','stray','cn','pkl']});
  const res=Object.fromEntries(r.body.results.map(x=>[x.id,x]));
  assert.equal(res.ill.header.architecture,'SDXL');assert.equal(res.ill.header.compatible,true);assert.equal(res.ill.header.payload,'OK');
  assert.equal(res.amber.header.architecture,'SDXL');assert.equal(res.amber.header.compatible,true);assert.match(res.amber.header.base_model,/sdxl/);
  assert.equal(res.old.header.compatible,false);assert.match(res.old.header.reason,/другую базовую модель/);
  assert.equal(res.vae.header.architecture,'SDXL VAE candidate');assert.equal(res.vae.header.compatible,null);
  assert.equal(res.stray.header.guess,'lora');assert.match(res.stray.header.reason,/loras\//);assert.equal(res.stray.header.compatible,null);
  assert.equal(res.cn.header.architecture,'unknown');assert.equal(res.pkl.ok,false);
  const total=h.fake.media.reduce((n,m)=>n+m.bytes,0);assert(total<=6*64*1024,'bytes read '+total);
  assert(h.fake.media.every(m=>m.bytes<=64*1024),'no read beyond the header prefix');
  // the result is cached and survives a re-check of an unchanged file
  await h.call('/api/drive/library/check','POST',{});const again=(await h.call('/api/drive/library')).body.inventory.items.find(i=>i.id==='amber');assert.equal(again.header.architecture,'SDXL');
  // a server that ignores Range still makes the phone read only the requested prefix
  h.fake.ignoreRange=true;h.fake.media=[];const v=await h.call('/api/drive/library/inspect','POST',{ids:['vesper']});assert.equal(v.body.results[0].header.architecture,'SDXL');assert(h.fake.media.every(m=>m.bytes<=64*1024));
  // a file the header proves incompatible is not offered for a paid download
  const no=await h.call('/api/drive/selection','PUT',{paths:['loras/old_sd15.safetensors']});assert.equal(no.status,422);assert.match(no.body.error,/базовую модель/);
 }finally{await h.close()}
});

test('header edge cases: truncated upload, invalid header, oversize header, payload check exactly like fetch_models.validate',()=>{
 const good=safetensors(KEYS.lora_xl,{},4096);
 const n=headerLength(good.header,good.size);const header=parseHeader(good.header.subarray(8,8+n));
 assert.equal(headerReport(header,n,good.size,'lora').payload,'OK');
 assert.equal(headerReport(header,n,good.size-10,'lora').payload,'MISMATCH');
 assert.throws(()=>headerLength(Buffer.from([1,2,3]),10),/Повреждён/);
 const big=Buffer.alloc(8);big.writeBigUInt64LE(BigInt(40*MB));assert.throws(()=>headerLength(big,100*MB),/заголовок/);
 const tooLong=Buffer.alloc(8);tooLong.writeBigUInt64LE(500n);assert.throws(()=>headerLength(tooLong,200),/заголовок/);
 assert.throws(()=>parseHeader(Buffer.from('[1,2]')),/Неверный/);assert.throws(()=>parseHeader(Buffer.from('{"__metadata__":null}')),/Неверный/);assert.throws(()=>parseHeader(Buffer.from('{bad')),/JSON/);
 assert.equal(headerReport({__metadata__:{},a:{data_offsets:[5,1]}},10,100,'vae').payload,'INVALID');
});

test('empty folder, nested folders, large collection with pagination and the GPU sync file limit',async()=>{
 const h=await harness();
 try{
  let r=await h.call('/api/drive/library/check','POST',{});assert.equal(r.body.state,'VERIFIED');assert.equal(r.body.inventory.items.length,0);assert.deepEqual(r.body.inventory.warnings,[]);
  h.fake.folder('L','loras');h.fake.folder('L1','a','L');h.fake.folder('L2','b','L1');h.fake.folder('L3','c','L2');
  h.fake.file('deep','deep.safetensors','L3',{size:100*MB});h.fake.file('ok2','two.safetensors','L2',{size:100*MB});
  for(let i=0;i<2100;i++)h.fake.file('bulk'+i,`bulk_${String(i).padStart(4,'0')}.safetensors`,'L',{size:20*MB});
  const t=Date.now();r=await h.call('/api/drive/library/check','POST',{});assert(Date.now()-t<5000);
  const inv=r.body.inventory;assert.equal(inv.items.length,2102);assert.equal(inv.folders_scanned,5);
  assert.equal(inv.items.find(i=>i.id==='ok2').sync.eligible,true);
  const deep=inv.items.find(i=>i.id==='deep');assert.equal(deep.path,'loras/a/b/c/deep.safetensors');assert.equal(deep.sync.eligible,false);assert.match(deep.sync.reason,/не глубже/);
  assert(inv.warnings.some(w=>/2000/.test(w)));
  assert(h.fake.calls.filter(u=>u.includes('pageToken')).length>=2,'paged listing');
  // browsing pages through a large folder 100 at a time and searches by name
  const b1=(await h.call('/api/drive/library/browse?folder=L&path=loras')).body;assert.equal(b1.entries.length,100);assert(b1.next_page);assert.equal(b1.entries[0].type,'folder');
  const b2=(await h.call('/api/drive/library/browse?folder=L&path=loras&page='+b1.next_page)).body;assert.equal(b2.entries.length,100);
  const s=(await h.call('/api/drive/library/browse?folder=L&path=loras&q='+encodeURIComponent("bulk_0007"))).body;assert.equal(s.entries.length,1);assert.equal(s.entries[0].path,'loras/bulk_0007.safetensors');assert.equal(s.entries[0].kind,'lora');
  const q=(await h.call('/api/drive/library/browse?folder=L&q='+encodeURIComponent("it's"))).body;assert.equal(q.entries.length,0);
  assert.equal((await h.call('/api/drive/library/browse?folder=../x')).status,400);
 }finally{await h.close()}
});

test('selected folder is preserved: browsing starts there, parent navigation never changes the selection',async()=>{
 const h=await harness();h.fake.folder('top','Drive top','root');h.fake.nodes.get('models-root').parent='top';
 try{
  const b=(await h.call('/api/drive/library/browse')).body;assert.equal(b.folder,'models-root');
  const p=(await h.call('/api/drive/library/parent?id=models-root')).body;assert.deepEqual(p.parent,{id:'top',name:'Drive top'});
  const out=(await h.call('/api/drive/library/browse?folder=top&outside=1')).body;assert.equal(out.entries[0].name,'YOISAKI_MODELS');
  assert.equal((await h.call('/api/drive/oauth')).body.folder.id,'models-root');
 }finally{await h.close()}
});

test('expired token, missing permissions, folder not found, offline, rate limit: explicit states, cache kept and labelled CACHED',async()=>{
 const h=await harness({drive:account(undefined,'2000-01-01T00:00:00Z')});library(h.fake);
 try{
  let r=await h.call('/api/drive/library/check','POST',{});assert.equal(r.body.state,'VERIFIED');const verified=r.body.inventory.verified_at;
  h.fake.refresh='fail';
  // token was refreshed once (expiry in the past); force another refresh by expiring the stored token
  const s=JSON.parse(await fs.readFile(path.join(h.dir,'secrets.json'),'utf8'));s.drive.token.expiry='2000-01-01T00:00:00Z';await fs.writeFile(path.join(h.dir,'secrets.json'),JSON.stringify(s));
  await h.close({keep:true});const h2=await harness({dir:h.dir,drive:null,fake:h.fake});
  try{
   r=await h2.call('/api/drive/library/check','POST',{});assert.equal(r.body.error.state,'AUTH_EXPIRED');assert.equal(r.body.state,'CACHED');assert.equal(r.body.inventory.verified_at,verified);assert.match(r.body.error.message,/войдите снова/);
   h2.fake.refresh='ok';
   h2.fake.errors.set('models-root',{status:403,reason:'insufficientFilePermissions'});r=await h2.call('/api/drive/library/check','POST',{});assert.equal(r.body.error.state,'PERMISSION_DENIED');assert.match(r.body.error.message,/нет прав/);
   h2.fake.errors.set('models-root',{status:403,reason:'userRateLimitExceeded'});r=await h2.call('/api/drive/library/check','POST',{});assert.equal(r.body.error.state,'RATE_LIMITED');
   h2.fake.errors.clear();h2.fake.nodes.get('models-root').trashed=true;r=await h2.call('/api/drive/library/check','POST',{});assert.equal(r.body.error.state,'FOLDER_NOT_FOUND');assert.match(r.body.error.message,/корзин/);
   h2.fake.nodes.delete('models-root');r=await h2.call('/api/drive/library/check','POST',{});assert.equal(r.body.error.state,'FOLDER_NOT_FOUND');
   h2.fake.offline=true;r=await h2.call('/api/drive/library/check','POST',{});assert.equal(r.body.error.state,'OFFLINE');assert.equal(r.body.state,'CACHED');
   const g=(await h2.call('/api/drive/library')).body;assert.equal(g.last_check.ok,false);assert.equal(g.state,'CACHED');assert.equal(g.inventory.verified_at,verified);
  }finally{await h2.close()}
 }catch(e){await h.close().catch(()=>{});throw e}
});

test('file without download permission is shown with the reason and cannot be selected; not connected / no folder states',async()=>{
 const h=await harness();h.fake.folder('L','loras');h.fake.file('locked','Locked.safetensors','L',{size:100*MB,canDownload:false});h.fake.file('free','Free.safetensors','L',{size:100*MB});
 try{
  const inv=(await h.call('/api/drive/library/check','POST',{})).body.inventory;const locked=inv.items.find(i=>i.id==='locked');
  assert.equal(locked.permission,'DENIED');assert.match(locked.permission_reason,/запретил скачивание/);assert(inv.warnings.some(w=>/Нет прав/.test(w)));
  const r=await h.call('/api/drive/selection','PUT',{paths:['loras/Locked.safetensors']});assert.equal(r.status,422);assert.match(r.body.error,/запретил/);
  const i=await h.call('/api/drive/library/inspect','POST',{ids:['locked']});assert.equal(i.body.results[0].ok,false);
 }finally{await h.close()}
 const n=await harness({drive:null});
 try{const r=await n.call('/api/drive/library/check','POST',{});assert.equal(r.body.error.state,'NOT_CONNECTED')}finally{await n.close()}
 const f=await harness({drive:account(null)});
 try{const r=await f.call('/api/drive/library/check','POST',{});assert.equal(r.body.error.state,'FOLDER_NOT_SELECTED')}finally{await f.close()}
});

test('selection before any GPU: multi-select, persistence across restart, estimate, insufficient planned storage',async()=>{
 const h=await harness();library(h.fake);
 try{
  await h.call('/api/drive/library/check','POST',{});
  let r=await h.call('/api/drive/selection','PUT',{paths:['checkpoints/Illustrious_XL_v17.safetensors','loras/characters/Amber_Nova.safetensors','loras/Vesper_Nova.safetensors']});
  assert.equal(r.status,200);const want=size(h.fake,'ill')+size(h.fake,'amber')+size(h.fake,'vesper');assert.equal(r.body.estimate.count,3);assert.equal(r.body.estimate.download_bytes,want);assert.equal(r.body.estimate.gpu_disk_required_bytes,want+SYNC_RESERVE);
  assert.equal(r.body.estimate.disk_check,'PLANNED_OK');assert.equal(r.body.estimate.gpu_state_unknown,3);
  assert.equal((await h.call('/api/drive/selection','PUT',{paths:['legacy.ckpt']})).status,422);
  assert.equal((await h.call('/api/drive/selection','PUT',{paths:['checkpoints/legacy.ckpt']})).status,422);
  await h.close({keep:true});
  const h2=await harness({dir:h.dir,drive:null,fake:h.fake});
  try{
   r=await h2.call('/api/drive/selection');assert.deepEqual(Object.keys(r.body.selection.items).sort(),['checkpoints/Illustrious_XL_v17.safetensors','loras/Vesper_Nova.safetensors','loras/characters/Amber_Nova.safetensors']);
   assert.equal(r.body.comparison.rows.filter(x=>x.selected).length,3);assert.equal(r.body.comparison.counts.DRIVE_ONLY,5);assert.equal(r.body.comparison.counts.NOT_SYNCABLE,3);
   // deselect all
   r=await h2.call('/api/drive/selection','PUT',{paths:[]});assert.equal(r.body.estimate.count,0);assert.equal(r.body.estimate.gpu_disk_required_bytes,0);
  }finally{await h2.close()}
 }catch(e){await h.close().catch(()=>{});throw e}
 const sel={items:{'checkpoints/a.safetensors':{size:30*GB},'loras/b.safetensors':{size:GB}}};
 const small=selectionEstimate(sel,null,{plannedDiskGb:40,imageGb:13});assert.equal(small.disk_check,'PLANNED_INSUFFICIENT');assert.match(small.disk_message,/мал/);
 const live=selectionEstimate(sel,null,{gpuItems:[{path:'checkpoints/a.safetensors',state:'INSTALLED'}],disk:{free_bytes:2*GB}});assert.equal(live.download_bytes,GB);assert.equal(live.disk_check,'INSUFFICIENT');assert.equal(live.installed_on_gpu,1);
});

test('comparison keeps cloud and GPU availability apart',()=>{
 const inv={items:[['a','loras/a.safetensors'],['b','loras/b.safetensors'],['c','checkpoints/c.safetensors'],['d','checkpoints/d.safetensors'],['e','vae/e.safetensors']].map(([id,p])=>({id,path:p,name:p.split('/').pop(),kind:p.startsWith('loras')?'lora':p.startsWith('vae')?'vae':'checkpoint',size:1,sync:{eligible:true},can_download:true}))};
 const out=compareSources({inventory:inv,gpuItems:[{path:'loras/a.safetensors',state:'INSTALLED'},{path:'loras/b.safetensors',state:'CHANGED',reason:'изменился'},{path:'checkpoints/c.safetensors',state:'FAILED',reason:'checksum'},{path:'checkpoints/d.safetensors',state:'DOWNLOADING'}],gpuModels:[{id:'1',name:'a.safetensors',kind:'lora',compatible:true},{id:'2',name:'only_gpu.safetensors',kind:'lora',compatible:null}],selection:{items:{'vae/e.safetensors':{}}}});
 assert.deepEqual(out.rows.map(r=>r.category),['INSTALLED','UPDATE','FAILED','DOWNLOADING','DRIVE_ONLY']);assert.equal(out.rows[4].selected,true);assert.equal(out.rows[0].gpu_model.id,'1');
 assert.deepEqual(out.gpu_only.map(m=>m.name),['only_gpu.safetensors']);
 // no GPU information at all: Drive files are never reported as installed
 assert(compareSources({inventory:inv,gpuItems:null,gpuModels:[]}).rows.every(r=>r.category==='DRIVE_ONLY'));
});

// Cross-check against the REAL Python rules (cloudcompute/drive_sync.py classify, engine/worker/models.py inspect).
test('parity with drive_sync.classify() and engine inspect() on the same inputs',{skip:(()=>{try{execFileSync('python3',['-c','1']);return false}catch{return 'python3 missing'}})()},()=>{
 const cases=[['loras/Amber_Nova.safetensors',193*MB],['loras/a/b/c.safetensors',MB],['loras/a/b/c/d.safetensors',MB],['checkpoints/x.ckpt',GB],['checkpoints/tiny.safetensors',MB],['vae/v.SAFETENSORS',2*MB],['loras/Ünïcødé_ЛоРА.safetensors',MB],['loras/bad;name.safetensors',MB],['loras/.hidden/x.safetensors',MB],['controlnet/cn.safetensors',GB],['misc/x.safetensors',MB],['loras/x.safetensors',null],['checkpoints/huge.safetensors',40*GB],['loras/model.bin',MB],['loras/notes.txt',10]];
 const py=`import sys,json;sys.path[:0]=['cloudcompute','engine'];import drive_sync as d
out=[]
for rel,size in json.loads(sys.argv[1]):
    i=d.classify({'Path':rel,'Size':size})
    out.append(None if i is None else [i['state']=='PENDING',i['reason']])
print(json.dumps(out,ensure_ascii=False))`;
 const expected=JSON.parse(execFileSync('python3',['-I','-c',py,JSON.stringify(cases)],{cwd:path.resolve('.'),env:{...process.env,PYTHONPATH:''}}).toString());
 cases.forEach(([rel,size],k)=>{const js=syncRule(rel,size),e=expected[k];if(e===null)assert.equal(js.eligible,false,rel);else{assert.equal(js.eligible,e[0],rel);if(!e[0]&&!/вне допустимого/.test(e[1]))assert.equal(js.reason.split(' (')[0].slice(0,25),e[1].split(' (')[0].slice(0,25),rel)}});
 const headers={ckpt:['checkpoint',{},KEYS.checkpoint],lora_xl:['lora',{ss_base_model_version:'sdxl_base_v1-0'},['x.w']],lora_te2:['lora',{},KEYS.lora_xl],lora_sd1:['lora',{ss_base_model_version:'sd_v1'},KEYS.lora_xl],lora_flux:['lora',{'modelspec.architecture':'flux-1-dev/lora'},['x']],lora_none:['lora',{},['lora_unet_x.lora_up.weight']],vae:['vae',{},KEYS.vae],vae_bad:['vae',{},['x']],ckpt_bad:['checkpoint',{},['model.diffusion_model.x']],cn:['controlnet',{},['x']]};
 const py2=`import sys,json,struct,tempfile,pathlib;sys.path[:0]=['engine'];from worker.models import inspect
out={}
for name,(kind,meta,keys) in json.loads(sys.argv[1]).items():
    h=json.dumps({'__metadata__':meta,**{k:{'dtype':'U8','shape':[1],'data_offsets':[0,1]} for k in keys}}).encode()
    p=pathlib.Path(tempfile.mkdtemp())/'m.safetensors';p.write_bytes(struct.pack('<Q',len(h))+h+b'x')
    a,ok,_=inspect(p,kind);out[name]=[a,ok]
print(json.dumps(out))`;
 const engine=JSON.parse(execFileSync('python3',['-I','-c',py2,JSON.stringify(headers)],{cwd:path.resolve('.')}).toString());
 for(const [name,[kind,meta,keys]] of Object.entries(headers)){const h={__metadata__:meta,...Object.fromEntries(keys.map(k=>[k,{data_offsets:[0,1]}]))};const js=inspectHeader(h,kind);assert.deepEqual([js.architecture,js.compatible],engine[name],name)}
 assert.equal(engineRule('loras/x.safetensors').visible,true);assert.equal(engineRule('loras/x.pt').visible,false);
});

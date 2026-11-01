import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createLocalApp} from '../server/app.mjs';
import {supportsRegionalControl} from '../server/upstream.mjs';
const baseHealth={engine:'YOISAKI_ENGINE',engine_version:'1.5.3',state:'READY',gpu_name:'MOCK GPU',vram_total_mb:16000,vram_available_mb:14000};
test('legacy versions and explicit capabilities are evaluated conservatively',()=>{
 for(const version of ['1.5.0','1.5.1','1.5.2','1.5.2.1','1.5.3'])assert(supportsRegionalControl({...baseHealth,engine_version:version}));
 for(const version of ['1.4.9','1.6.1','1.6.2','2.0.0','1.50.3','1.5.3-beta','unknown',''])assert(!supportsRegionalControl({...baseHealth,engine_version:version}));
 for(const value of [false,'true',1,null])assert(!supportsRegionalControl({...baseHealth,capabilities:{regional_control:value}}));
 assert(supportsRegionalControl({...baseHealth,engine_version:'2.0.0',capabilities:{regional_control:true}}));
 assert(!supportsRegionalControl({...baseHealth,engine:'OTHER',capabilities:{regional_control:true}}));
 assert(!supportsRegionalControl(null));
});
test('health/status preserve capabilities, regional requests reach upstream only when supported, plain Text2Img unchanged',async()=>{
 const current={...baseHealth,engine_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true}};let health={...current};const sent=[];const model={id:'b'.repeat(32),name:'TEST',kind:'checkpoint',architecture:'SDXL',compatible:true,size_bytes:1};
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'regional-compat-'));
 const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),upstream:async(c,p,o={})=>{
  if(p==='/health')return health;if(p==='/models')return {models:[model]};
  if(p==='/generate'){const req=JSON.parse(o.body);sent.push(req);return {id:req.client_request_id,status:'QUEUED'}}
  return {id:p.split('/').pop(),status:'QUEUED'};
 }});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+app.server.address().port;
 const res=await fetch(url+'/api/session',{headers:{'X-Yoisaki-Local':'1'}});const cookie=res.headers.get('set-cookie').split(';')[0];
 const call=async(route,body)=>{const response=await fetch(url+route,{method:body?'POST':'GET',headers:{'X-Yoisaki-Local':'1',Cookie:cookie,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});return {status:response.status,body:await response.json()}};
 const request={kind:'text2img',mode:'text2img',prompt:'scene, '+ 'rooftop, '.repeat(80),negative_prompt:'blur, '.repeat(80),checkpoint_id:model.id,vae_id:'auto',lora_adapters:[],width:512,height:512,steps:30,cfg_scale:7,sampler:'Euler',scheduler:'Normal',seed:42,batch_size:1,controlnet_config:{enabled:false}};
 const region={name:'A',enabled:true,lora_id:'',trigger:'amber_character',prompt:'white sweater',negative_prompt:'blur',weight:1.15,mask:'data:image/png;base64,AA=='}; // Transport only; mask decoding belongs to the unchanged GPU API.
 try{
  await call('/api/gpu/connect',{url:'https://test.trycloudflare.com/#token='+'a'.repeat(64)});
  for(const version of ['1.7.0']){
   health={...current,engine_version:version};assert.equal((await call('/api/gpu/status')).body.info.engine_version,version);
   const body={...request,regions:[region],client_request_id:randomUUID()};const response=await call('/api/gpu/generate',body);
   assert.equal(response.status,201,JSON.stringify(response.body));assert.deepEqual(sent.at(-1),body);
  }
  for(const state of [{...current,capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:false}}]){
   health=state;const status=await call('/api/gpu/status');assert.deepEqual(status.body.info,health);
   const count=sent.length;const blocked=await call('/api/gpu/generate',{...request,regions:[region],client_request_id:randomUUID()});
   assert.equal(blocked.status,409);assert.equal(blocked.body.code,'ENGINE_UPGRADE_REQUIRED');assert.equal(sent.length,count);
   const plain={...request,regions:[],client_request_id:randomUUID()};assert.equal((await call('/api/gpu/generate',plain)).status,201);assert.deepEqual(sent.at(-1),plain);
  }
  health={...baseHealth,engine_version:'1.5.3'};assert.equal((await call('/api/gpu/status')).body.info,null);
  assert.equal((await call('/api/gpu/generate',{...request,regions:[region],client_request_id:randomUUID()})).status,409);
 }finally{await app.close();await fs.rm(dir,{recursive:true,force:true})}
});

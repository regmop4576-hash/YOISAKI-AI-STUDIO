// v1.6.2: SDPose-OOD pose preprocessor transport. Real local Node app + synthetic GPU upstream (NOT GPU inference).
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {createLocalApp} from '../server/app.mjs';import {validatePreprocess,validateControl,compactControlRequest} from '../server/controlnet.mjs';import {validateHealth} from '../server/upstream.mjs';import {engineCompatibility} from '../server/release.mjs';
const token='d'.repeat(64),url='https://unit-test.trycloudflare.com/#token='+token,mid='b'.repeat(32);
const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'TEST DOUBLE',vram_total_mb:15360,vram_available_mb:12000};
const IMG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=';
const base={image:IMG,prepared:false,width:512,height:512};
async function harness(upstream){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-v162-'));const app=await createLocalApp({dataDir,distDir:path.resolve('dist'),upstream});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const root='http://127.0.0.1:'+app.server.address().port;
 const s=await fetch(root+'/api/session',{headers:{'X-Yoisaki-Local':'1'}});const cookie=s.headers.get('set-cookie').split(';')[0];
 const call=async(route,method='GET',body)=>{const r=await fetch(root+route,{method,headers:{'X-Yoisaki-Local':'1',Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()}};
 return {app,call,close:async()=>{await app.close();await fs.rm(dataDir,{recursive:true,force:true})}};
}

test('preprocess validation: pose preprocessor only for OpenPose, classic is the default',()=>{
 assert.equal(validatePreprocess({...base,type:'OpenPose'}).preprocessor,'openpose');
 assert.equal(validatePreprocess({...base,type:'OpenPose',preprocessor:'sdpose'}).preprocessor,'sdpose');
 for(const type of ['Canny','Depth'])assert(!('preprocessor' in validatePreprocess({...base,type})),type);
 for(const bad of [{type:'Canny',preprocessor:'sdpose'},{type:'Depth',preprocessor:'openpose'},{type:'OpenPose',preprocessor:'dwpose'},{type:'OpenPose',preprocessor:null}])assert.throws(()=>validatePreprocess({...base,...bad}),/Неверные параметры предобработки/,JSON.stringify(bad));
});

test('generation validation and history keep the preprocessor, never the map',()=>{
 const c={enabled:true,type:'OpenPose',map_type:'OpenPose',image:IMG,strength:1,start:0,end:1};
 validateControl(c);validateControl({...c,preprocessor:'sdpose'});validateControl({...c,preprocessor:'openpose'});
 assert.throws(()=>validateControl({...c,preprocessor:'dwpose'}),/препроцессор/);
 assert.throws(()=>validateControl({...c,type:'Canny',map_type:'Canny',preprocessor:'sdpose'}),/препроцессор/);
 const stored=compactControlRequest({controlnet_config:{...c,preprocessor:'sdpose'}}).controlnet_config;
 assert.equal(stored.preprocessor,'sdpose');assert(!('image' in stored));assert.equal(stored.image_length,IMG.length);
});

test('only an engine declaring SDPose is compatible',()=>{
 assert.equal(validateHealth(health),health);assert.equal(engineCompatibility(health),'COMPATIBLE');
 const old={...health,capabilities:{controlnet:true,regional_control:true}};
 assert.throws(()=>validateHealth(old),/Несовместимая версия/);assert.equal(engineCompatibility(old),'UNVERIFIED');
 assert.throws(()=>validateHealth({...health,engine_version:'1.6.1'}),/Требуется YOISAKI ENGINE v1\.7\.0/);
});

test('route: SDPose request reaches the engine, the echo is checked, failures are explained, Canny/Depth unchanged',async()=>{
 const seen=[];let reply=x=>({image:IMG,type:x.type,width:x.width,height:x.height,...(x.preprocessor?{preprocessor:x.preprocessor}:{})});
 const sent=[];
 const h=await harness(async(c,p,o={})=>{if(p==='/health')return health;if(p==='/models')return {models:[{id:mid,name:'x.safetensors',kind:'checkpoint',architecture:'SDXL',size_bytes:1,compatible:true}]};
  if(p==='/controlnet/preprocess'){const x=JSON.parse(o.body);seen.push(x);return reply(x)}
  if(p==='/generate'){const x=JSON.parse(o.body);sent.push(x);return {id:x.client_request_id,status:'QUEUED'}}throw Error(p)});
 try{
  await h.call('/api/gpu/connect','POST',{url});
  let r=await h.call('/api/gpu/controlnet/preprocess','POST',{...base,type:'OpenPose',preprocessor:'sdpose'});
  assert.equal(r.status,200);assert.equal(r.body.preprocessor,'sdpose');assert.equal(seen.at(-1).preprocessor,'sdpose');
  r=await h.call('/api/gpu/controlnet/preprocess','POST',{...base,type:'OpenPose'});assert.equal(seen.at(-1).preprocessor,'openpose');assert.equal(r.body.preprocessor,'openpose');
  for(const type of ['Canny','Depth']){r=await h.call('/api/gpu/controlnet/preprocess','POST',{...base,type});assert.equal(r.status,200,type);assert(!('preprocessor' in seen.at(-1)),type)}
  // An engine that silently used another preprocessor (or an older engine) is rejected, not shown as an SDPose map.
  reply=x=>({image:IMG,type:x.type,width:x.width,height:x.height,preprocessor:'openpose'});
  r=await h.call('/api/gpu/controlnet/preprocess','POST',{...base,type:'OpenPose',preprocessor:'sdpose'});assert.equal(r.status,502);assert.match(r.body.error?.message||JSON.stringify(r.body),/Неверная карта ControlNet/);
  // Engine failure text (422) is passed to the page as is.
  const {AppError}=await import('../server/errors.mjs');
  reply=()=>{throw new AppError('CONTROL_PREPROCESS_FAILED','Не удалось загрузить веса SDPose-OOD (teemosliang/SDPose-Body). Проверьте доступ к Hugging Face в Colab или выберите OpenPose Classic (OSError).',422)};
  r=await h.call('/api/gpu/controlnet/preprocess','POST',{...base,type:'OpenPose',preprocessor:'sdpose'});assert.equal(r.status,422);assert.match(JSON.stringify(r.body),/OpenPose Classic/);
  reply=x=>({image:IMG,type:x.type,width:x.width,height:x.height});
  r=await h.call('/api/gpu/controlnet/preprocess','POST',{...base,type:'Canny'});assert.equal(r.status,200,'Canny still works after an SDPose failure');
  // Generation: the OpenPose ControlNet request carries the preprocessor; history stores it without the map.
  const id=randomUUID();
  r=await h.call('/api/gpu/generate','POST',{client_request_id:id,kind:'text2img',mode:'text2img',prompt:'fox',negative_prompt:'',checkpoint_id:mid,vae_id:'auto',lora_adapters:[],width:512,height:512,steps:2,cfg_scale:5,sampler:'Euler',scheduler:'Normal',seed:1,batch_size:1,regions:[],controlnet_config:{enabled:true,type:'OpenPose',map_type:'OpenPose',preprocessor:'sdpose',image:IMG,strength:1,start:0,end:1}});
  assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(sent.at(-1).controlnet_config.preprocessor,'sdpose');assert.equal(sent.at(-1).controlnet_config.image,IMG);
  const history=(await h.call('/api/history')).body;const job=(history.items||history).find(j=>j.id===id);
  assert.equal(job.request.controlnet_config.preprocessor,'sdpose');assert(!('image' in job.request.controlnet_config));
 }finally{await h.close()}
});

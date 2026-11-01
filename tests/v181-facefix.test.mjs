// v1.8.1 SMART FACE FIX: request/response contract, engine compatibility and the local server routes.
// The GPU upstream is a test double; real detection is covered by tests/test_v181_facefix.py.
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {validateGeneration} from '../server/upstream.mjs';import {compactSourceRequest} from '../server/img2img.mjs';import {engineCompatibility,supportsAutoFaceFix,COMPATIBLE_ENGINE_FAMILY} from '../server/release.mjs';
import {validateDetectRequest,validateDetectResponse} from '../server/editor.mjs';import {createLocalApp} from '../server/app.mjs';
const image='data:image/png;base64,aGVsbG8=',id='a'.repeat(32),models=[{id,kind:'checkpoint',compatible:true}],F1='f'+'1'.repeat(12),F2='f'+'2'.repeat(12);
const spec={detector:'auto',min_confidence:.35,select:[F1]},options={mask_shape:'ellipse',mask_expand:.08,work_fit:'aspect'};
const base={kind:'facefix',mode:'facefix',prompt:'  orange fox\n(amber eyes:1.2)  ',negative_prompt:'',checkpoint_id:id,vae_id:'auto',lora_adapters:[],width:1024,height:1024,steps:25,cfg_scale:5.5,sampler:'Euler',scheduler:'Normal',seed:-1,batch_size:1,regions:[],controlnet_config:{enabled:false},init_image:image,denoising_strength:.3,mask_blur:10,mask_padding:.5,inpaint_region:'crop',face_detection:spec,face_options:options};
const health=(version,caps={})=>({engine:'YOISAKI_ENGINE',engine_version:version,api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true,inpaint:true,facefix:true,editor_contract:1,...caps},state:'READY',gpu_name:'TEST',vram_total_mb:16000,vram_available_mb:15000});
const doc=(over={})=>({detector:'auto',detectors_run:['anime','human'],min_confidence:.35,auto_select_confidence:.6,image:{width:600,height:400},faces:[{id:F1,x:10,y:20,width:100,height:110,confidence:.93,detector:'anime',label:'face',auto_selectable:true}],selected:F1,selection_required:false,duration_ms:12,...over});

test('automatic Face Fix request is preserved verbatim and stripped of the source in history',()=>{
 const req=validateGeneration(base,models);assert.deepEqual(JSON.parse(JSON.stringify(req)),base);
 const compact=compactSourceRequest(req);assert(!('init_image' in compact));assert.deepEqual(compact.face_detection,spec);assert.equal(compact.prompt,base.prompt);
 const manual={...base,face_detection:undefined,face_region:{x:1,y:2,width:30,height:40}};delete manual.face_detection;
 assert.deepEqual(JSON.parse(JSON.stringify(validateGeneration(manual,models))),manual);
});
test('invalid selections, options and mode combinations are rejected',()=>{
 const bad=[{face_region:{x:0,y:0,width:20,height:20}},{face_detection:undefined},{face_detection:{...spec,select:[]}},{face_detection:{...spec,select:[F1,F1]}},
  {face_detection:{...spec,select:['x'.repeat(13)]}},{face_detection:{...spec,detector:'yolo'}},{face_detection:{...spec,min_confidence:1}},{face_detection:{detector:'auto',select:[F1]}},
  {face_detection:{...spec,select:Array.from({length:13},(_,i)=>'f'+String(i).padStart(12,'0'))}},{face_options:{...options,mask_shape:'circle'}},{face_options:{...options,mask_expand:.6}},
  {face_options:{...options,extra:1}},{inpaint_region:'full'},{mask_image:image}];
 for(const change of bad)assert.throws(()=>validateGeneration({...base,...change},models),JSON.stringify(change));
 assert.throws(()=>validateGeneration({...base,mode:'inpaint',kind:'inpaint',mask_image:image},models));
 const t2i={...base,mode:'text2img',kind:'text2img'};for(const k of ['init_image','denoising_strength','mask_blur','mask_padding','inpaint_region','face_detection'])delete t2i[k];
 assert.throws(()=>validateGeneration(t2i,models),/Inpaint\/Face Fix/);
});
test('detect request and GPU response are validated; boxes must lie inside the reported image',()=>{
 assert.deepEqual(validateDetectRequest({image}),{image,detector:'auto',min_confidence:.35});
 for(const x of [{image,detector:'yolo'},{image,min_confidence:0},{image:'http://x'},{image,extra:1}])assert.throws(()=>validateDetectRequest(x));
 const ok=validateDetectResponse(doc(),{detector:'auto'});assert.equal(ok.faces[0].id,F1);assert.equal(ok.selected,F1);
 const face=doc().faces[0];
 for(const over of [{faces:[{...face,x:550}]},{faces:[{...face,x:1.5}]},{faces:[{...face,id:'zzz'}]},{faces:[{...face,confidence:2}]},{selected:F2},{detector:'human'},{faces:Array(13).fill(face)}])
  assert.throws(()=>validateDetectResponse(doc(over),{detector:'auto'}),/детектора/);
});
test('compatibility: v1.8.1 is compatible on API 1.7.0; only engines declaring auto_facefix get the automatic flow',()=>{
 assert.equal(engineCompatibility(health('1.8.1',{auto_facefix:true,face_detect_contract:1})),'COMPATIBLE');assert.match(COMPATIBLE_ENGINE_FAMILY,/1\.8\.1/);
 assert.equal(supportsAutoFaceFix(health('1.8.1',{auto_facefix:true,face_detect_contract:1})),true);
 assert.equal(supportsAutoFaceFix(health('1.8.0')),false);assert.equal(supportsAutoFaceFix(health('1.8.0',{auto_facefix:true})),false,'contract version required');
 assert.equal(supportsAutoFaceFix(health('1.9.0',{auto_facefix:true,face_detect_contract:1})),false,'unknown engine version not trusted');
});
async function harness(engine){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'facefix-181-'));const sent=[],detects=[];
 const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),upstream:async(c,p,o={})=>{
  if(p==='/health')return engine;if(p==='/models')return {models:[{id,name:'TEST',kind:'checkpoint',architecture:'SDXL',compatible:true,size_bytes:1}]};
  if(p==='/facefix/detect'){const x=JSON.parse(o.body);detects.push(x);return doc({detector:x.detector})}
  if(p==='/generate'){const x=JSON.parse(o.body);sent.push(x);return {id:x.client_request_id,status:'QUEUED'}}
  if(p.endsWith('/ack'))return {ok:true};return {id:p.split('/').pop(),status:'QUEUED',progress:{stage:'PENDING'}};
 }});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const root='http://127.0.0.1:'+app.server.address().port;
 const session=await fetch(root+'/api/session',{headers:{'X-Yoisaki-Local':'1'}}),cookie=session.headers.get('set-cookie').split(';')[0];
 const call=async(route,method='GET',body)=>{const r=await fetch(root+route,{method,headers:{'X-Yoisaki-Local':'1',Cookie:cookie,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 assert.equal((await call('/api/gpu/connect','POST',{url:'https://test.trycloudflare.com/#token='+'a'.repeat(64)})).status,200);await call('/api/gpu/status?models=1');
 return {app,call,sent,detects,close:async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true})}};
}
test('local server proxies detection for v1.8.1 and refuses automatic requests to a v1.8.0 engine',async()=>{
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=';
 let h=await harness(health('1.8.1',{auto_facefix:true,face_detect_contract:1,result_ack:true}));
 try{
  const r=await h.call('/api/gpu/facefix/detect','POST',{image:png,detector:'anime',min_confidence:.4});
  assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.faces[0].id,F1);assert.deepEqual(h.detects[0],{image:png,detector:'anime',min_confidence:.4});
  assert.equal((await h.call('/api/gpu/facefix/detect','POST',{image:png,detector:'yolo'})).status,400);
  const g=await h.call('/api/gpu/generate','POST',{...base,init_image:png});assert([200,201].includes(g.status),JSON.stringify(g.body));
  assert.deepEqual(h.sent[0].face_detection,spec);assert.deepEqual(h.sent[0].face_options,options);assert.equal(h.sent[0].prompt,base.prompt);
  const hist=h.app.store.data.history.find(j=>j.id===h.sent[0].client_request_id);assert(!('init_image' in hist.request));
 }finally{await h.close()}
 h=await harness(health('1.8.0',{result_ack:true}));
 try{
  const r=await h.call('/api/gpu/facefix/detect','POST',{image:png});assert.equal(r.status,409);assert.equal(r.body.code||r.body.error?.code||'ENGINE_UPGRADE_REQUIRED','ENGINE_UPGRADE_REQUIRED');assert.match(JSON.stringify(r.body),/v1\.8\.1/);
  assert.equal((await h.call('/api/gpu/generate','POST',{...base,init_image:png})).status,409,'face_detection never reaches an old engine');
  const legacy={...base,init_image:png,face_region:{x:0,y:0,width:2,height:2}};delete legacy.face_detection;
  assert.equal((await h.call('/api/gpu/generate','POST',legacy)).status,409,'face_options never reach an old engine (it would ignore them silently)');
  delete legacy.face_options;legacy.face_region={x:0,y:0,width:2,height:2};
  const ok=await h.call('/api/gpu/generate','POST',legacy);assert([200,201].includes(ok.status),'manual v1.8.0 Face Fix still works: '+JSON.stringify(ok.body));assert.equal(h.detects.length,0);
 }finally{await h.close()}
});

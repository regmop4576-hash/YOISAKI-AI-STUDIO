import {test} from 'node:test';import assert from 'node:assert/strict';
import {validateGeneration} from '../server/upstream.mjs';import {compactSourceRequest} from '../server/img2img.mjs';import {engineCompatibility} from '../server/release.mjs';
const image='data:image/png;base64,aGVsbG8=',id='a'.repeat(32),models=[{id,kind:'checkpoint',compatible:true}];
const base={kind:'inpaint',mode:'inpaint',prompt:'  amber_character\n(red eyes:1.2)  ',negative_prompt:'  blur  ',checkpoint_id:id,vae_id:'auto',lora_adapters:[],width:768,height:1024,steps:30,cfg_scale:5,sampler:'Euler',scheduler:'Normal',seed:123,batch_size:1,regions:[],controlnet_config:{enabled:false},init_image:image,mask_image:image,denoising_strength:.5,mask_blur:8,mask_padding:.15,inpaint_region:'crop'};
test('editor additive API preserves parameters and strips source/mask from persisted metadata',()=>{
 const req=validateGeneration(base,models);assert.deepEqual(JSON.parse(JSON.stringify(req)),base);const compact=compactSourceRequest(req);
 assert(!('init_image' in compact));assert(!('mask_image' in compact));assert.equal(compact.prompt,base.prompt);assert.equal(compact.seed,123);assert.equal(compact.mask_image_length,image.length);
 const f={...base,mode:'facefix',kind:'facefix',face_region:{x:0,y:0,width:30,height:25}};delete f.mask_image;assert.deepEqual(JSON.parse(JSON.stringify(validateGeneration(f,models))),f);
});
test('reject incompatible editor configurations and invalid parameters explicitly',()=>{
 for(const change of [{batch_size:2},{mask_image:undefined},{mask_padding:1.1},{mask_blur:-1},{inpaint_region:'invented'},{denoising_strength:.01},{controlnet_config:{enabled:true}},{face_region:{x:0,y:0,width:20,height:20}}])assert.throws(()=>validateGeneration({...base,...change},models));
 for(const face_region of [{x:-1,y:0,width:3,height:3},{x:0,y:0,width:NaN,height:4},{x:0,y:0,width:4,height:4,unsafe:1}]){const req={...base,kind:'facefix',mode:'facefix',mask_image:undefined,face_region};assert.throws(()=>validateGeneration(req,models))}
});
test('1.8 engine remains on protocol 1.7.0',()=>assert.equal(engineCompatibility({engine:'YOISAKI_ENGINE',engine_version:'1.8.0',api_version:'1.7.0',capabilities:{img2img:true,sdpose:true,controlnet:true}}),'COMPATIBLE'));

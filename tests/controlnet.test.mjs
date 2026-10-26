import {test} from 'node:test';import assert from 'node:assert/strict';
import {validateControl,validatePreprocess} from '../server/controlnet.mjs';
import {validateGeneration,validateHealth,allowedRoute} from '../server/upstream.mjs';
const image='data:image/png;base64,AAAA'; // Transport test only; actual PNG decoding is tested in Python.
const model={id:'b'.repeat(32),kind:'checkpoint',compatible:true};
const base={kind:'text2img',mode:'text2img',prompt:'fox',negative_prompt:'blur',checkpoint_id:model.id,vae_id:'auto',lora_adapters:[],width:512,height:512,steps:30,cfg_scale:5,sampler:'Euler',scheduler:'Normal',seed:42,batch_size:2,controlnet_config:{enabled:false},regions:[]};
const config=type=>({enabled:true,type,map_type:type,image,strength:.8,start:0,end:1});
test('three ControlNet modes transport exact isolated settings and preserve batch/LoRA',()=>{
 const lora={id:'c'.repeat(32),kind:'lora',compatible:true};
 assert.deepEqual(validateGeneration(base,[model]),{...base,client_request_id:undefined});
 const requests=['OpenPose','Canny','Depth'].map(type=>({...base,controlnet_config:config(type),lora_adapters:[{id:lora.id,weight:1.15}]}));
 for(const r of requests){const out=validateGeneration(r,[model,lora]);assert.deepEqual(out.controlnet_config,r.controlnet_config);assert.equal(out.batch_size,2);assert.equal(out.lora_adapters[0].weight,1.15)}
 assert.equal(requests[0].controlnet_config.type,'OpenPose');
});
test('missing map, stale type, invalid intervals, formats and combined modes rejected',()=>{
 for(const change of [{image:null},{map_type:'Depth'},{start:1},{start:.5,end:.5},{strength:NaN},{end:1.1}])assert.throws(()=>validateControl({...config('Canny'),...change}));
 assert.throws(()=>validateControl(config('Depth'),[{enabled:true}]),/Одновременная/);
 assert.throws(()=>validatePreprocess({image:'data:image/svg+xml;base64,AAAA',prepared:false,type:'Canny',width:512,height:512}));
 assert(allowedRoute('POST','/controlnet/preprocess'));assert(!allowedRoute('GET','/controlnet/preprocess'));
});
test('only v1.7.0 with ControlNet + SDPose + Img2Img capability is accepted',()=>{
 const h={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true},state:'READY',gpu_name:'MOCK',vram_total_mb:100,vram_available_mb:90};
 assert.equal(validateHealth(h),h);
 for(const patch of [{engine_version:'1.5.3'},{engine_version:'1.5.4'},{engine_version:'1.6.1'},{engine_version:'1.6.2',capabilities:{controlnet:true,sdpose:true}},{capabilities:{controlnet:true,sdpose:true}},{capabilities:{}},{capabilities:{controlnet:false}},{capabilities:{controlnet:true}}])assert.throws(()=>validateHealth({...h,...patch}),/Несовместимая версия/);
});

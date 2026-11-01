import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateGeneration} from '../server/upstream.mjs';
test('full long positive/negative and exact multi-LoRA settings survive Termux validation',()=>{
 const ids=['a','b','c'].map(x=>x.repeat(32));
 const req={mode:'text2img',kind:'text2img',prompt:'  amber,\n'+ 'white sweater, rooftop, '.repeat(50),negative_prompt:'  mask,\n'+'blur, '.repeat(60),checkpoint_id:ids[0],vae_id:'auto',lora_adapters:[{id:ids[1],weight:1.15},{id:ids[2],weight:.8}],width:1216,height:832,steps:30,cfg_scale:7,sampler:'Euler',scheduler:'Normal',seed:42,batch_size:1,regions:[],controlnet_config:{enabled:false}};
 const out=validateGeneration(req,ids.map((id,i)=>({id,kind:i?'lora':'checkpoint',compatible:true})));
 for(const key of Object.keys(req))assert.deepEqual(out[key],req[key]);
});

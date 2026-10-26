import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import {createLocalApp} from '../server/app.mjs';import {allowedRoute} from '../server/upstream.mjs';
test('ACK only after durable gallery, retries without losing result or resubmitting',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ack-'));const id=randomUUID(),mid='b'.repeat(32);let attempts=0,submissions=0,app;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=','base64');
 app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),upstream:async(c,p,o)=>{
 if(p==='/health')return {engine:'YOISAKI_ENGINE',engine_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'TEST',vram_total_mb:100,vram_available_mb:100};
 if(p==='/models')return {models:[{id:mid,name:'test',kind:'checkpoint',architecture:'SDXL',compatible:true,size_bytes:1}]};
 if(p==='/generate'){submissions++;return {id,status:'QUEUED'}}
 if(p.endsWith('/ack')){assert.equal(app.store.data.gallery.length,1);assert.deepEqual(await fs.readFile(path.join(dir,'images',id+'_0')),png);attempts++;if(attempts===1)throw Error('test disconnect');return {ok:true}}
 if(p.startsWith('/results/'))return png;
 return {id,status:'COMPLETED',result:{seed:1,image_keys:['0']}};
 }});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;const res=await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}});const cookie=res.headers.get('set-cookie').split(';')[0];
 const post=(p,b)=>fetch(base+p,{method:'POST',headers:{'X-Yoisaki-Local':'1',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(b)});
 try{await post('/api/gpu/connect',{url:'https://test.trycloudflare.com/#token='+'a'.repeat(64)});await post('/api/gpu/generate',{kind:'text2img',mode:'text2img',prompt:'test',negative_prompt:'',checkpoint_id:mid,vae_id:'auto',lora_adapters:[],width:512,height:512,steps:1,cfg_scale:5,sampler:'Euler',scheduler:'Normal',seed:1,batch_size:1,controlnet_config:{enabled:false}});
 await app.pollJobs();assert.equal(attempts,0);await app.pollJobs();assert.equal(attempts,1);await app.pollJobs();assert.equal(attempts,2);assert.equal(submissions,1);assert.equal(app.store.data.history[0].status,'COMPLETED');assert(allowedRoute('POST','/jobs/'+id+'/ack'));assert(!allowedRoute('POST','/jobs/../ack'));
 }finally{await app.close();await fs.rm(dir,{recursive:true,force:true})}
});

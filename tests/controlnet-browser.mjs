// Real mobile-sized browser + local server. GPU transport is explicitly synthetic.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createLocalApp} from '../server/app.mjs';
const mid='b'.repeat(32),token='e'.repeat(64),sent=[],pre=[],pendingSeen=new Set();let delay=0; // v1.6.1: first answer for each map is PENDING (AUD-006)
const png=await fs.readFile(new URL('./fixtures/control-reference.png',import.meta.url));
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'control-browser-'));
const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),upstream:async(c,p,o={})=>{
 if(p==='/health')return {engine:'YOISAKI_ENGINE',engine_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'TEST ONLY',vram_total_mb:16000,vram_available_mb:15000};
 if(p==='/models')return {models:[{id:mid,name:'TEST',kind:'checkpoint',architecture:'SDXL',compatible:true,size_bytes:1}]};
 if(p==='/controlnet/preprocess'){const x=JSON.parse(o.body);pre.push(x);await new Promise(r=>setTimeout(r,delay));if(!pendingSeen.has(o.body)){pendingSeen.add(o.body);return {status:'PENDING'}}return {...x,image:'data:image/png;base64,'+png.toString('base64')}}
 if(p==='/generate'){const x=JSON.parse(o.body);sent.push(x);return {id:x.client_request_id,status:'QUEUED'}}
 return {id:p.split('/').pop(),status:'QUEUED'};
}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:'+app.server.address().port+'/engine');await page.getByLabel('URL туннеля Colab').fill('https://test.trycloudflare.com/#token='+token);await page.getByRole('button',{name:'Подключиться',exact:true}).click();await page.getByText('GPU: TEST ONLY',{exact:true}).waitFor();
 await page.locator('.bottomnav a[href="/generate"]').click();await page.locator('select[aria-label="Checkpoint"]').selectOption(mid);await page.getByLabel(/^(Positive Prompt|Позитивный промпт)$/).fill('fox');
 await page.getByRole('button',{name:/Показать настройки ControlNet|Show ControlNet controls/}).click();await page.getByLabel('Включить ControlNet').check();
 await page.getByRole('button',{name:'Создать изображение',exact:true}).click();assert.equal(sent.length,0);await page.getByText('Загрузите изображение и подготовьте карту ControlNet.',{exact:false}).waitFor();
 const panel=page.locator('div.stack.card').filter({has:page.getByRole('heading',{name:'ControlNet',exact:true})});
 await panel.locator('input[type=file]').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:png});
 for(const type of ['Canny','Depth','OpenPose']){
  await panel.locator('select').first().selectOption(type);assert.equal(await page.locator('img[alt^="Карта "]').count(),0);
  await page.getByRole('button',{name:'Подготовить карту',exact:true}).click();await page.locator('img[alt="Карта '+type+'"]').waitFor();
  await page.getByRole('button',{name:'Создать изображение',exact:true}).click();
  await new Promise(r=>setTimeout(r,150));assert.equal(sent.at(-1).controlnet_config.type,type);
 }
 // v1.6.2: SDPose-OOD as the pose preprocessor of the same OpenPose ControlNet.
 const pose=panel.getByLabel('Препроцессор позы');assert.equal(await pose.inputValue(),'openpose');assert.equal(pre.at(-1).preprocessor,'openpose');
 assert.equal(await page.locator('img[alt="Карта OpenPose"]').count(),1);
 await pose.selectOption('sdpose');assert.equal(await page.locator('img[alt^="Карта "]').count(),0,'classic map must be invalidated');
 await page.getByText('лучше для стилизованных, аниме, фурри и сложных поз',{exact:false}).waitFor();
 await page.getByRole('button',{name:'Создать изображение',exact:true}).click();await page.getByText('Загрузите изображение и подготовьте карту ControlNet.',{exact:false}).waitFor();
 let before=sent.length;await new Promise(r=>setTimeout(r,150));assert.equal(sent.length,before,'no generation with a stale map');
 await page.getByRole('button',{name:'Подготовить карту',exact:true}).click();await page.locator('img[alt="Карта OpenPose"]').waitFor();
 assert.equal(pre.at(-1).preprocessor,'sdpose');assert.equal(pre.at(-1).type,'OpenPose');assert.equal(pre.at(-1).prepared,false);
 await page.getByRole('button',{name:'Создать изображение',exact:true}).click();await new Promise(r=>setTimeout(r,150));
 assert.equal(sent.at(-1).controlnet_config.type,'OpenPose');assert.equal(sent.at(-1).controlnet_config.preprocessor,'sdpose');
 await page.locator('input[aria-label="Height"],input[aria-label="Высота"]').fill('768');assert.equal(await page.locator('img[alt^="Карта "]').count(),0,'size change invalidates the SDPose map');
 await page.locator('input[aria-label="Height"],input[aria-label="Высота"]').fill('1024');
 await page.getByLabel('Использовать готовую карту').check();assert(await pose.isDisabled());
 await page.getByRole('button',{name:'Подготовить карту',exact:true}).click();await page.locator('img[alt="Карта OpenPose"]').waitFor();
 assert.equal(pre.at(-1).prepared,true);assert.equal(pre.at(-1).preprocessor,'openpose','ready map: SDPose is not requested');
 await page.getByLabel('Использовать готовую карту').uncheck();
 await panel.locator('select').first().selectOption('Canny');assert.equal(await pose.count(),0,'pose selector only for OpenPose');
 const count=sent.length;await page.locator('input[aria-label="Width"],input[aria-label="Ширина"]').fill('512');assert.equal(await page.locator('img[alt^="Карта "]').count(),0);
 delay=300;await page.getByRole('button',{name:'Подготовить карту',exact:true}).click();await panel.locator('select').first().selectOption('Depth');await new Promise(r=>setTimeout(r,450));assert.equal(await page.locator('img[alt^="Карта "]').count(),0);
 await page.getByRole('button',{name:'Создать изображение',exact:true}).click();assert.equal(sent.length,count);
 await page.getByLabel('Включить ControlNet').uncheck();await page.getByRole('button',{name:'Создать изображение',exact:true}).click();await new Promise(r=>setTimeout(r,150));assert.equal(sent.at(-1).controlnet_config.enabled,false);
 assert.deepEqual(errors,[]);console.log('PASS mobile browser: 3 modes, SDPose-OOD selector/routing/invalidation/ready map, preview, missing map, mode/dimension invalidation, stale async response ignored, disabled plain request; synthetic upstream only.');
}finally{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true})}

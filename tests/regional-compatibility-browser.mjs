import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createLocalApp} from '../server/app.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'regional-hotfix-ui-')),received=[];
let health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'MOCK GPU',vram_total_mb:16000,vram_available_mb:14000};
const model={id:'b'.repeat(32),name:'TEST',kind:'checkpoint',architecture:'SDXL',compatible:true,size_bytes:1};
const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),upstream:async(c,p,o={})=>{if(p==='/health')return health;if(p==='/models')return {models:[model]};if(p==='/generate'){const r=JSON.parse(o.body);received.push(r);return {id:r.client_request_id,status:'QUEUED'}}return {id:p.split('/').pop(),status:'QUEUED'}}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/engine');await page.getByLabel('URL туннеля Colab').fill('https://test.trycloudflare.com/#token='+'a'.repeat(64));await page.getByRole('button',{name:'Подключиться',exact:true}).click();await page.getByText('GPU: MOCK GPU',{exact:true}).waitFor();
 await page.goto(base+'/generate');await page.getByLabel('Checkpoint',{exact:true}).selectOption(model.id);await page.locator('textarea').first().fill('scene, '+ 'rooftop, '.repeat(80));
 await page.getByText('🧩 REGIONAL CONTROL',{exact:true}).click();await page.getByLabel('Regional mode',{exact:true}).selectOption('2 CHARACTERS');await page.getByLabel('Regional trigger',{exact:true}).fill('amber_character');await page.getByLabel('Regional positive prompt',{exact:true}).fill('white sweater');
 await page.getByRole('button',{name:'Создать изображение',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('Всего: 1'));
 assert.equal(received.length,1);assert.equal(received[0].regions.length,2);assert.equal(received[0].regions[0].trigger,'amber_character');assert.equal(received[0].regions[0].prompt,'white sweater');assert(received[0].regions.every(r=>r.mask.startsWith('data:image/png;base64,')));
 assert(!await page.getByText('Regional Control требует YOISAKI ENGINE v1.5.0',{exact:true}).count());
 health={...health,capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:false}};await page.evaluate(()=>fetch('/api/gpu/status',{headers:{'X-Yoisaki-Local':'1'}}));
 await page.getByRole('button',{name:'Создать изображение',exact:true}).click();await page.getByText('Движок не объявляет поддержку Regional Control и не распознан как совместимый YOISAKI ENGINE 1.7.0.').waitFor();assert.equal(received.length,1);
 await page.getByLabel('Regional mode',{exact:true}).selectOption('OFF');await page.getByRole('button',{name:'Создать изображение',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('Всего: 2'));assert.equal(received.length,2);assert.deepEqual(received[1].regions,[]);assert.equal(received[1].prompt,received[0].prompt);assert.deepEqual(errors,[]);
 console.log('PASS Chromium mobile: Regional UI, v1.7.0 request with PNG masks, explicit unavailable warning, plain Text2Img preserved. Synthetic upstream; NOT T4 inference.');
}finally{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true})}

// Real Chromium + production assets + local Node server. Upstream hardware/results are synthetic.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createLocalApp} from '../server/app.mjs';import {AppError} from '../server/errors.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'provider-browser-'));const calls=[];const token='c'.repeat(64);let reject=false;
const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),upstream:async(c,p)=>{calls.push({provider:c.provider,host:c.hostname});assert.equal(c.token,token);if(reject)throw new AppError('AUTH_REJECTED','GPU отклонил токен.',401);if(p==='/health')return {engine:'YOISAKI_ENGINE',engine_version:'1.7.0',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'SYNTHETIC '+c.provider,vram_total_mb:16000,vram_available_mb:12000};if(p==='/models')return {models:[]};throw Error(p)}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const click=p=>page.getByRole('button',{name:p,exact:true}).click();
const connection=()=>page.getByRole('button',{name:'Подключиться',exact:true});
try{
 await page.goto(base+'/engine');await page.getByRole('button',{name:'CloudCompute',exact:true}).waitFor();assert.equal(calls.length,0);
 await page.getByLabel('URL туннеля Colab').fill('https://colab-ui.trycloudflare.com/#token='+token);assert.equal(await page.getByLabel('Токен доступа').inputValue(),token);assert(!(await page.getByLabel('URL туннеля Colab').inputValue()).includes(token));
 await connection().click();await page.getByText('GPU: SYNTHETIC colab',{exact:true}).waitFor();assert.equal(await page.getByLabel('Токен доступа').inputValue(),'');
 await click('CloudCompute');await page.getByLabel('URL сервера CloudCompute').waitFor();assert.equal(await page.getByLabel('URL туннеля Colab').count(),0);assert.equal(await page.getByLabel('Токен доступа').inputValue(),'');const n=calls.length;await page.reload();await page.getByLabel('URL сервера CloudCompute').waitFor();assert.equal(calls.length,n);
 await page.getByLabel('URL сервера CloudCompute').fill('https://gpu.example.com/#token='+token);await connection().click();await page.getByText('GPU: SYNTHETIC cloudcompute',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'CloudCompute',exact:true}).getAttribute('aria-pressed'),'true');
 await click('Google Colab');assert.equal(await page.getByLabel('URL туннеля Colab').inputValue(),'https://colab-ui.trycloudflare.com');assert.equal(await page.getByLabel('Токен доступа').inputValue(),'');assert(await connection().isDisabled());
 await click('CloudCompute');assert.equal(await page.getByLabel('URL сервера CloudCompute').inputValue(),'https://gpu.example.com');assert.equal(await page.getByLabel('Токен доступа').inputValue(),'');
 reject=true;await page.getByLabel('Токен доступа').fill(token);await connection().click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/токен/);reject=false;
 for(const width of [360,390,430]){
  await page.setViewportSize({width,height:844});
  for(const p of ['Google Colab','CloudCompute']){await click(p);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);}
 }
 await page.getByRole('button',{name:'Настройки',exact:true}).click();await page.getByRole('dialog').waitFor();assert((await page.getByRole('dialog').innerText()).includes('AMBER CORE · v1.7.6 ZERO-TERMINAL CLOUDCOMPUTE EDITION'));
 await page.getByRole('dialog').locator('select').selectOption('English');await page.getByRole('button',{name:'Close',exact:true}).click();await page.getByLabel('CloudCompute server URL').waitFor();assert.equal(await page.getByRole('button',{name:'Connect',exact:true}).count(),1);assert.equal(await page.getByText('No data',{exact:false}).count()>0,true);
 await page.reload();await page.getByLabel('CloudCompute server URL').waitFor();assert.equal(await page.getByRole('button',{name:'CloudCompute',exact:true}).getAttribute('aria-pressed'),'true');
 await page.screenshot({path:'validation/gpu-cloudcompute-en.png',fullPage:true});
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('dialog').locator('select').selectOption('Русский');await page.getByRole('button',{name:'Закрыть',exact:true}).click();
 await page.getByLabel('Токен доступа').fill(token);await connection().click();await page.getByText('GPU: SYNTHETIC cloudcompute',{exact:true}).waitFor();await page.screenshot({path:'validation/gpu-cloudcompute-ru.png',fullPage:true});
 assert(!JSON.stringify(app.store.data).includes(token));assert(!JSON.stringify(await page.evaluate(()=>({...localStorage,...sessionStorage}))).includes(token));assert.deepEqual(errors,[]);
 console.log('PASS: provider forms, separate persisted endpoints, explicit connect, token clearing/isolation, real version, error UI, language switch/reload, 360/390/430px no overflow. Synthetic upstream only.');
}finally{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true})}

// Real Chromium + production assets + local Node server. The GPU server's sync service is a synthetic state machine
// (statuses in the engine's own format); real rclone/Drive behaviour is tested in tests/test_v172_drive_sync.py.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createLocalApp} from '../server/app.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'drive-browser-'));const token='c'.repeat(64);
const oauth='{"access_token":"ya29.BROWSERTEST_ACCESS","token_type":"Bearer","refresh_token":"1//BROWSERTEST_REFRESH_abcdefghijkl","expiry":"2026-10-26T10:00:00Z"}';
const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'SYNTHETIC GPU',vram_total_mb:16000,vram_available_mb:12000};
const GB=2**30;const sim={configured:false,revision:0,job:null,items:[],polls:0,received:[]};
const remote=[['checkpoints/Illustrious XL.safetensors','checkpoint',6.9*GB],['loras/Amber 3.0.safetensors','lora',0.2*GB],['loras/Vesper 3.0.safetensors','lora',0.2*GB],['vae/sdxl_vae.safetensors','vae',0.3*GB],['loras/old.ckpt','lora',0.1*GB]].map(([p,kind,size])=>({path:p,name:p.split('/').pop(),kind,size:Math.round(size),state:p.endsWith('.ckpt')?'REJECTED':'MISSING',reason:p.endsWith('.ckpt')?'Формат pickle (.ckpt/.pt/.bin) не загружается.':'',verification:''}));
const total=remote.filter(i=>i.state==='MISSING').reduce((a,i)=>a+i.size,0);
function status(){
 if(sim.job?.state==='RUNNING'&&sim.job.type==='sync'){sim.polls++;
  if(sim.polls<=2)Object.assign(sim.job,{phase:'LISTING',current:null});
  else if(sim.polls<=5){const done=Math.round(remote[0].size*(sim.polls-2)/4);Object.assign(sim.job,{phase:'DOWNLOADING',current:{path:remote[0].path,kind:'checkpoint',phase:'DOWNLOADING',bytes_done:done,bytes_total:remote[0].size,speed_bps:85*2**20,resumed_from:null},overall:{files_total:4,files_done:0,files_failed:0,bytes_total:total,bytes_done:done}});sim.items[0].state='DOWNLOADING'}
  else{sim.revision=4;sim.items=sim.items.map(i=>i.state==='REJECTED'?i:{...i,state:'INSTALLED',verification:'md5+safetensors'});Object.assign(sim.job,{state:'COMPLETED',phase:'DONE',current:null,finished_unix:Date.now()/1000,overall:{files_total:4,files_done:4,files_failed:0,bytes_total:total,bytes_done:total},summary:{installed:4}});sim.last=Date.now()/1000}}
 return {service:'YOISAKI_DRIVE_SYNC',version:1,enabled:true,rclone_available:true,configured:sim.configured,connection:{state:sim.configured&&sim.job?'OK':'UNKNOWN',error:'',code:''},source:'YOISAKI_AI_STUDIO/models',scope:'drive.readonly',job:sim.job,items:sim.items,disk:{free_bytes:500*GB,total_bytes:944*GB,reserve_bytes:2*GB},last_success_unix:sim.last||null,last_check_unix:sim.items.length?Date.now()/1000:null,inventory_revision:sim.revision,verification:'Проверка: размер + контрольная сумма Google Drive.',owner:'self'};
}
const installed=()=>sim.revision?[{id:'a'.repeat(32),name:'Illustrious XL.safetensors',kind:'checkpoint',architecture:'SDXL',compatible:true,size_bytes:remote[0].size},{id:'b'.repeat(32),name:'Amber 3.0.safetensors',kind:'lora',architecture:'SDXL',compatible:true,size_bytes:remote[1].size}]:[];
const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),upstream:async(c,route,opts={})=>{
 assert.equal(c.token,token);if(route==='/health')return health;if(route==='/models')return {models:installed()};
 if(route==='/sync/status')return status();
 if(route==='/sync/drive/connect'){sim.received.push(JSON.parse(opts.body));sim.configured=true;return status()}
 if(route==='/sync/check'){sim.items=remote.map(i=>({...i}));sim.job={id:'c1',type:'check',state:'COMPLETED',phase:'DONE',started_unix:Date.now()/1000,finished_unix:Date.now()/1000,error:'',error_code:'',cancel_requested:false,restart_recommended:false,current:null,overall:{files_total:0,files_done:0,files_failed:0,bytes_total:0,bytes_done:0},summary:{missing:4,rejected:1}};return status()}
 if(route==='/sync/start'){sim.polls=0;sim.job={id:'s1',type:'sync',state:'RUNNING',phase:'LISTING',started_unix:Date.now()/1000,finished_unix:null,error:'',error_code:'',cancel_requested:false,restart_recommended:false,current:null,overall:{files_total:0,files_done:0,files_failed:0,bytes_total:0,bytes_done:0},summary:{}};return status()}
 if(route==='/sync/cancel'){sim.job.cancel_requested=true;return status()}
 throw Error(route)}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
const session=await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}});const cookie=session.headers.get('set-cookie').split(';')[0];
const local=(route,body)=>fetch(base+route,{method:'POST',headers:{'X-Yoisaki-Local':'1',cookie,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const button=name=>page.getByRole('button',{name,exact:true});const noOverflow=()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
try{
 // v1.7.3: the Drive account can be set up with any provider; the GPU sync part is CloudCompute-only.
 await page.goto(base+'/models');await page.getByText('Библиотека моделей').waitFor();await page.getByRole('heading',{name:'GOOGLE DRIVE',exact:true}).waitFor();
 await page.getByText('Google Drive Auto Sync работает только с CloudCompute',{exact:false}).waitFor();assert.equal(await button('Синхронизировать').count(),0);
 await local('/api/gpu/provider',{provider:'cloudcompute'});await page.reload();await page.getByRole('heading',{name:'GOOGLE DRIVE',exact:true}).waitFor();
 await page.getByText('подключите его на странице GPU',{exact:false}).waitFor();
 const connected=await local('/api/gpu/connect',{provider:'cloudcompute',url:'https://gpu.example.com/#token='+token});assert.equal(connected.state,'READY');
 await page.reload();await page.getByText('Не подключён',{exact:true}).first().waitFor();
 for(const name of ['Проверить модели на сервере','Синхронизировать','Отменить загрузку','Обновить список'])assert.equal(await button(name).count(),1,name);
 assert(await button('Синхронизировать').isDisabled());assert(await button('Отменить загрузку').isDisabled());
 await page.getByText('YOISAKI_AI_STUDIO/models',{exact:true}).waitFor();await page.getByText('500 GB / 944 GB').waitFor();
 // One-time token paste: password field, cleared after sending, never stored by the studio.
 // The 1.7.2 Termux token paste stays available as an advanced fallback.
 await page.getByText('Дополнительно: ручная авторизация через Termux',{exact:false}).click();await page.getByText('rclone authorize "drive" "eyJzY29wZSI6ImRyaXZlLnJlYWRvbmx5In0"').waitFor();
 assert.equal(await page.getByLabel('Токен rclone (JSON)').getAttribute('type'),'password');
 await page.getByLabel('Токен rclone (JSON)').fill(oauth);await button('Сохранить на сервере и проверить').click();
 await page.getByRole('cell',{name:/Illustrious XL/}).first().waitFor();assert.equal(sim.received.length,1);assert.equal(sim.received[0].token,oauth);
 assert.equal(await page.getByRole('row').count(),6);await page.getByText('Нет на сервере').first().waitFor();await page.getByText('Отклонена').waitFor();
 // Sync: indeterminate while listing, real byte progress while downloading, cancel enabled while running.
 await button('Синхронизировать').click();await page.locator('progress.syncbar:not([value])').first().waitFor();assert(!(await button('Отменить загрузку').isDisabled()));
 await page.locator('progress.syncbar[value]').first().waitFor({timeout:15000});await page.getByText(/MB\/s/).first().waitFor();await page.getByText(/1\/4|0\/4/).first().waitFor();
 const value=Number(await page.locator('progress.syncbar[value]').first().getAttribute('value'));assert(value>0&&value<=100);
 for(const width of [360,390,430]){await page.setViewportSize({width,height:844});assert.equal(await noOverflow(),true,'overflow '+width)}
 await page.screenshot({path:'validation/drive-sync-progress-ru.png',fullPage:true});
 await page.getByText('Синхронизация: завершено').first().waitFor({timeout:20000});assert.equal(await page.getByText('Установлена').count(),4);
 // Inventory revision changed → the engine model list was refreshed without reload or rebuild.
 await page.getByRole('heading',{name:'Illustrious XL.safetensors'}).or(page.locator('b',{hasText:'Illustrious XL.safetensors'})).first().waitFor();
 assert.deepEqual((await (await fetch(base+'/api/gpu/status',{headers:{'X-Yoisaki-Local':'1',cookie}})).json()).models.map(m=>m.name),['Illustrious XL.safetensors','Amber 3.0.safetensors']);
 await page.screenshot({path:'validation/drive-sync-done-ru.png',fullPage:true});
 // English labels.
 await button('Настройки').first().click();await page.getByRole('dialog').locator('select').selectOption('English');await page.getByRole('button',{name:'Close',exact:true}).click();
 for(const name of ['Check models on the server','Synchronize','Cancel download','Refresh list'])assert.equal(await button(name).count(),1,name);
 await page.getByText('Model synchronization',{exact:false}).first().waitFor();
 await page.screenshot({path:'validation/drive-sync-en.png',fullPage:true});
 // Secrets: not in the studio state, browser storage or page text.
 const state=await fs.readFile(path.join(dir,'state.json'),'utf8');const storage=JSON.stringify(await page.evaluate(()=>({...localStorage,...sessionStorage})));const text=await page.content();
 for(const leak of ['BROWSERTEST_ACCESS','BROWSERTEST_REFRESH',token])assert(!state.includes(leak)&&!storage.includes(leak)&&!text.includes(leak),leak);
 await local('/api/gpu/provider',{provider:'colab'});await page.reload();await page.getByText('Model library').or(page.getByText('Библиотека моделей')).first().waitFor();assert.equal(await button('Synchronize').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: Drive sync (GPU part) CloudCompute-only, connect form (password, cleared, forwarded once), check table, indeterminate→byte progress, speed, cancel state, completion, model inventory refresh, RU/EN, 360/390/430px no overflow, no secrets in storage. Synthetic sync state machine.');
}catch(e){console.error('Page text at failure:\n'+(await page.locator('main').innerText().catch(()=>'')).slice(0,3000));throw e}finally{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true})}

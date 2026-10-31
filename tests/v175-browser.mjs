// Real Chromium + real local HTTP app (mobile viewport). CloudCompute, ghcr.io, ntfy and the GPU are explicit test
// doubles: this proves the Android UI flow and its safety rules, NOT a live CloudCompute deployment.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLocalApp} from '../server/app.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-browser-175-'));const shots=process.env.YOISAKI_SHOTS||'/tmp/yoisaki-ui-175';await fs.mkdir(shots,{recursive:true});
const KEY='cc-browser_test_key_175';const posts=[];let gpu={url:null,stages:[]};
const offers=[{ask_id:501,gpu_name:'RTX 4090',num_gpus:1,gpu_ram:24576,price_hour:4520,disk_space:500,cuda_max_good:12.9,reliability2:0.985,geolocation:'RU'},{ask_id:502,gpu_name:'RTX 3070',gpu_ram:8192,price_hour:1500,disk_space:200,cuda_max_good:12.9}];
const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true},state:'READY',gpu_name:'RTX 4090',vram_total_mb:24000,vram_available_mb:23000};
const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),deployInterval:200,monitorMinGap:0,
 providerRequest:async(url,opts={})=>{
  if(url.startsWith('https://ghcr.io/token'))return {status:200,json:{token:'anon'}};if(url.startsWith('https://ghcr.io/v2/'))return {status:200,json:{}};
  const route=url.replace('https://app.cloudcompute.ru/api/v1','');
  if(route==='/offers')return {status:200,json:{data:offers}};
  if(route==='/instances'&&opts.method==='POST'){posts.push(JSON.parse(opts.body));return {status:201,json:{data:{id:9001}}}}
  if(route==='/instances')return {status:200,json:{data:posts.length?[{id:9001,name:posts[0].name,status:'running',gpu_name:'RTX 4090'}]:[]}};
  if(route.startsWith('/instances/'))return {status:200,json:{data:{id:9001,name:'YOISAKI',status:'running'}}};
  throw Error(route)},
 discoverProgress:async()=>gpu,
 upstream:async(c,p)=>{if(p==='/health')return health;if(p.startsWith('/inventory'))return {revision:'a'.repeat(32),models:[]};throw Error(p)}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.YOISAKI_CHROMIUM||undefined,args:process.env.YOISAKI_CHROMIUM?['--no-sandbox']:['--no-sandbox','--no-zygote','--single-process']});
const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const errors=[],dialogs=[];
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{dialogs.push(d.message());void d.accept()});
const overflow=async label=>{for(const width of [360,390,430]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label+' overflow '+width)}await page.setViewportSize({width:390,height:844})};
try{
 await page.goto(base+'/engine');await page.getByRole('button',{name:'CloudCompute',exact:true}).click();
 await page.getByLabel('API-ключ CloudCompute',{exact:true}).fill(KEY);await page.getByRole('button',{name:'Проверить и сохранить',exact:true}).click();
 // 1.7.7 flow: find → verify (fresh data, final configuration) → confirm rental → initialize → connect → sync
 const steps=['1. Найти GPU','2. Проверить предложение','3. Подтвердить аренду','4. Инициализировать движок','5. Подключить','6. Синхронизировать модели'];
 for(const s of steps)await page.getByRole('button',{name:s,exact:true}).waitFor();
 assert(await page.getByRole('button',{name:'3. Подтвердить аренду',exact:true}).isDisabled());
 // the technical form survives under Advanced settings
 assert.equal(await page.getByLabel('Offer / ask_id').count(),0);await page.getByText('Расширенные настройки: ручное создание по Offer ID').click();await page.getByRole('button',{name:'Создать инстанс из Docker-образа'}).waitFor();
 await page.getByRole('button',{name:'1. Найти GPU',exact:true}).click();await page.getByText(/Подходит: 0 из 2/).waitFor();   // 45,20 ₽/h > default 30 ₽/h
 await page.getByText(/^Фильтры:/).click();await page.getByLabel('Цена GPU до, ₽/ч').fill('50');await page.getByRole('button',{name:'Применить фильтры'}).click();
 await page.getByText('RTX 4090 ★',{exact:true}).waitFor();
 assert.equal(await page.getByText('RTX 3070').count(),0,'unsuitable offers hidden by default');
 await page.getByRole('button',{name:'Выбрать · ID 501'}).click();await page.getByRole('button',{name:'Проверить предложение в CloudCompute'}).click();
 await page.getByText(/45,20 ₽ в час/).waitFor();await page.getByText(/3 ч ≈ 135,60 ₽/).waitFor();await page.getByText(/API не сообщает стоимость хранения/).waitFor();await page.getByText(/Образ опубликован и доступен/).waitFor();
 assert(await page.getByRole('button',{name:'3. Подтвердить аренду',exact:true}).isDisabled(),'creation needs the explicit billing acknowledgement');
 await overflow('offers');await page.screenshot({path:shots+'/1-select-gpu.png',fullPage:true});
 await page.getByLabel(/Понимаю: оплата начинается сразу/).check();assert.equal(posts.length,0);
 await page.getByRole('button',{name:'3. Подтвердить аренду',exact:true}).click();
 await page.getByRole('status',{name:'Ход инициализации'}).waitFor();assert.equal(posts.length,1);assert.match(dialogs[0],/ПЛАТНЫЙ GPU-сервер[\s\S]*45,20 ₽ в час[\s\S]*не резервирует GPU[\s\S]*Оплата начинается сразу/);
 assert.equal(posts[0].ask_id,501);assert.equal(posts[0].max_price_hour_minor,4520);
 await page.getByText(/инстанс работает\. YOISAKI ENGINE ещё не отозвался/).waitFor();   // CloudCompute running ≠ engine ready
 gpu={url:null,stages:[{stage:'IMAGE_READY',ts:1}]};await page.getByText(/Контейнер YOISAKI запущен на GPU/).waitFor();
 await page.screenshot({path:shots+'/2-initializing.png',fullPage:true});
 gpu={url:'https://browser-test.trycloudflare.com',stages:[{stage:'IMAGE_READY',ts:1},{stage:'SERVER_READY',ts:2}]};
 await page.getByText(/Готово: откройте «Генерация»/).waitFor({timeout:20000});await page.getByText('GPU: RTX 4090',{exact:true}).waitFor();
 assert(await page.getByRole('button',{name:'5. Подключить',exact:true}).isDisabled());assert(!(await page.getByRole('button',{name:'6. Синхронизировать модели',exact:true}).isDisabled()));
 await overflow('ready');await page.screenshot({path:shots+'/3-gpu-ready.png',fullPage:true});
 const token=posts[0].onstart.match(/YOISAKI_PROVISION_TOKEN='([a-f0-9]{64})'/)[1];
 const storage=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}));const html=await page.content();
 for(const secret of [token,KEY])assert(!storage.includes(secret)&&!html.includes(secret),'secret leaked to the page');
 await page.goto(base+'/engine');await page.getByText(/Готово: откройте «Генерация»/).waitFor();// state survives a reload (server-side)
 assert.deepEqual(errors,[]);
 console.log('PASS v1.7.5 UI (1.7.7 flow): 6 steps, filters, GPU offers with verified price/estimate/storage note, billing acknowledgement + confirm, one paid POST, signed stages → automatic connection → GPU ready, mobile 360/390/430 without overflow, no secrets in DOM/storage, Advanced form preserved. CloudCompute/GPU mocked; live deployment NOT verified.');
}catch(e){console.error('Page:',page.url(),(await page.locator('body').innerText()).slice(0,4000));throw e}finally{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true})}

// v1.7.7 real Chromium (mobile) + real local HTTP app. CloudCompute, ghcr.io, ntfy and the GPU are explicit TEST DOUBLES:
// this proves the GPU monitor UI, the occupied-host handling, the separate instance/engine states, the terminal probe and
// the diagnostics download — NOT a live CloudCompute deployment and NOT a real GPU.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLocalApp} from '../server/app.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-browser-177-'));const shots=process.env.YOISAKI_SHOTS||'/tmp/yoisaki-ui-177';await fs.mkdir(shots,{recursive:true});
const KEY='cc-browser_test_key_177';const posts=[];let gpu={url:null,stages:[]};let detail={status:'loading'};
const offers=[{ask_id:601,gpu_name:'RTX 4090',num_gpus:1,gpu_ram:24576,price_hour:2500,disk_space:300,cuda_max_good:12.9,reliability2:0.99,geolocation:'RU'},
 {ask_id:602,gpu_name:'RTX 3090',num_gpus:1,gpu_ram:24576,price_hour:2200,disk_space:200,cuda_max_good:12.8,reliability2:0.97},
 {ask_id:603,gpu_name:'Tesla T4',num_gpus:1,gpu_ram:15360,price_hour:900,disk_space:100,cuda_max_good:12.8}];
const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),deployInterval:200,monitorMinGap:0,
 providerRequest:async(url,opts={})=>{
  if(url.startsWith('https://ghcr.io/token'))return {status:200,json:{token:'anon'}};if(url.startsWith('https://ghcr.io/v2/'))return {status:200,json:{}};
  const route=url.replace('https://app.cloudcompute.ru/api/v1','');
  if(route==='/offers')return {status:200,json:{data:offers}};
  if(route==='/instances'&&opts.method==='POST'){const body=JSON.parse(opts.body);posts.push(body);if(body.ask_id===601)return {status:422,json:{error:{message:'Offer 601 is no longer available: host is busy'}}};return {status:201,json:{data:{id:10758}}}}
  if(route==='/instances')return {status:200,json:{data:[]}};
  if(route.endsWith('/terminal-token'))return {status:409,json:{error:{message:'Terminal port has not yet been published by the host.'}}};
  if(route.startsWith('/instances/'))return {status:200,json:{data:{id:10758,name:'YOISAKI',...detail}}};
  throw Error(route)},
 discoverProgress:async()=>gpu,
 upstream:async(c,p)=>{if(p==='/health')return {engine:'YOISAKI_ENGINE',engine_version:'1.7.0',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true},state:'READY',gpu_name:'RTX 3090',vram_total_mb:24000,vram_available_mb:23000};if(p.startsWith('/inventory'))return {revision:'a'.repeat(32),models:[]};throw Error(p)}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.YOISAKI_CHROMIUM||undefined,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,acceptDownloads:true});const page=await context.newPage();const errors=[],dialogs=[];
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{dialogs.push(d.message());void d.accept()});
const monitor=()=>page.getByRole('region',{name:'Монитор доступности GPU'});const refreshBtn=()=>monitor().getByRole('button',{name:'Обновить',exact:true});
const overflow=async label=>{for(const width of [360,390,430]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label+' overflow '+width)}await page.setViewportSize({width:390,height:844})};
try{
 await page.goto(base+'/engine');await page.getByRole('button',{name:'CloudCompute',exact:true}).click();
 await page.getByLabel('API-ключ CloudCompute',{exact:true}).fill(KEY);await page.getByRole('button',{name:'Проверить и сохранить',exact:true}).click();
 // monitor: default filters (1 GPU, ≥16 GB, preferred 24 GB, ≤30 ₽/h); T4 reports 15 360 MiB and still counts as a 16 GB card
 await refreshBtn().click();await page.getByText(/Подходит: 3 из 3/).waitFor();
 await page.getByText(/Фильтры: 1 GPU · ≥16 ГБ \(желательно 24\) · ≤30 ₽\/ч/).waitFor();
 await page.getByText(/^Фильтры:/).click();await page.getByLabel('Сортировка').selectOption('preferred');await page.getByRole('button',{name:'Применить фильтры'}).click();
 await monitor().getByRole('listitem').first().filter({hasText:'RTX 3090 ★'}).waitFor();   // preferred 24 GB first, then by price
 // new matching offer → one in-app notification (first refresh was the baseline)
 offers.push({ask_id:604,gpu_name:'RTX 5060 Ti',num_gpus:1,gpu_ram:16384,price_hour:1500,disk_space:150,cuda_max_good:12.9});
 await refreshBtn().click();await page.getByText(/Новый подходящий GPU: RTX 5060 Ti/).waitFor();
 await refreshBtn().click();await page.getByText(/Подходит: 4 из 4/).waitFor();
 assert.equal(await page.getByText(/Новый подходящий GPU/).count(),1,'no duplicate notification');
 await page.getByRole('button',{name:'Скрыть'}).click();await page.waitForFunction(()=>!document.body.innerText.includes('Новый подходящий GPU'));
 // automatic refresh starts and stops immediately
 await page.getByRole('button',{name:'Автообновление'}).click();await page.getByText(/Мониторинг работает на телефоне/).waitFor();
 await page.getByRole('button',{name:'Остановить мониторинг'}).click();await page.getByText('Остановлено пользователем.').waitFor();
 await overflow('monitor');await page.screenshot({path:shots+'/1-monitor.png',fullPage:true});
 // occupied host: the provider's message, the offer marked taken, alternatives, filters kept, no automatic retry
 await page.getByRole('button',{name:'Выбрать · ID 601'}).click();await page.getByRole('button',{name:'Проверить предложение в CloudCompute'}).click();
 await page.getByText(/ИТОГОВАЯ КОНФИГУРАЦИЯ/).waitFor();await page.getByText(/Профиль инициализации CloudCompute: worker/).waitFor();await page.getByText(/не резервирует GPU/).first().waitFor();
 await page.getByLabel(/Понимаю: оплата начинается сразу/).check();await page.getByRole('button',{name:'Подтвердить аренду',exact:true}).click();
 await page.getByText(/Offer 601 is no longer available: host is busy/).waitFor();await page.getByText(/Другие подходящие предложения/).waitFor();
 assert.equal(posts.length,1);assert.equal(await page.getByText(/RTX 4090 (★ )?· ЗАНЯТ/).count(),0,'taken offer hidden from matching list');
 await page.getByLabel('Показать неподходящие').check();await page.getByText(/RTX 4090 (★ )?· ЗАНЯТ/).waitFor();assert(await monitor().getByRole('button',{name:/ID 601$/}).isDisabled());await page.getByLabel('Показать неподходящие').uncheck();
 await overflow('taken');await page.screenshot({path:shots+'/2-host-taken.png',fullPage:true});
 await page.getByRole('alert').getByRole('button',{name:'Выбрать'}).first().click();
 await page.getByText(/Выбрано: (Tesla T4|RTX 5060 Ti|RTX 3090) ·/).waitFor();
 await page.getByRole('button',{name:'Проверить предложение в CloudCompute'}).click();await page.getByLabel(/Понимаю: оплата начинается сразу/).check();
 await page.getByRole('button',{name:'Подтвердить аренду',exact:true}).click();await page.getByRole('status',{name:'Ход инициализации'}).waitFor();
 assert.equal(posts.length,2);assert.equal(posts[1].bootstrap_profile,'worker');assert.notEqual(posts[1].ask_id,601);
 // CloudCompute "Running" while the engine has not reported (#10758) — two different tiles
 detail={status:'running'};await page.getByText(/инстанс работает\. YOISAKI ENGINE ещё не отозвался/).waitFor();
 const tiles=await page.getByRole('status',{name:'Ход инициализации'}).innerText();assert.match(tiles,/ИНСТАНС CLOUDCOMPUTE\s+работает/);assert.match(tiles,/YOISAKI ENGINE\s+не готов/);
 await page.getByRole('button',{name:'Проверить веб-терминал'}).click();await page.getByText(/Terminal port has not yet been published by the host\./).waitFor();
 await page.getByText(/профиль worker может не включать терминал/).waitFor();
 await overflow('running');await page.screenshot({path:shots+'/3-instance-running-engine-not-ready.png',fullPage:true});
 // Docker failure reported by the provider is attributed to Docker, not to the engine
 detail={status:'running',status_msg:'Error response from daemon: No such container: c-10758'};await page.getByText(/Где сбой: Docker на хосте CloudCompute/).waitFor();
 detail={status:'running'};gpu={url:'https://browser-177.trycloudflare.com',stages:[{stage:'IMAGE_READY',ts:1},{stage:'SERVER_READY',ts:2}]};
 await page.getByText(/Готово: откройте «Генерация»/).waitFor({timeout:20000});assert.equal(await page.getByText(/Где сбой/).count(),0,'old error cleared after verified recovery');
 const ready=await page.getByRole('status',{name:'Ход инициализации'}).innerText();assert.match(ready,/YOISAKI ENGINE\s+готов \(проверка пройдена\)/);
 await page.screenshot({path:shots+'/4-engine-ready.png',fullPage:true});
 // diagnostics download: a file, no secrets
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Скачать диагностику (JSON)'}).click()]);
 assert.equal(download.suggestedFilename(),'YOISAKI_CLOUDCOMPUTE_DIAGNOSTICS.json');const text=await fs.readFile(await download.path(),'utf8');const report=JSON.parse(text);
 const token=posts[1].onstart.match(/YOISAKI_PROVISION_TOKEN='([a-f0-9]{64})'/)[1];
 for(const secret of [token,KEY])assert(!text.includes(secret),'secret in diagnostics');
 assert.equal(report.instance.id,'10758');assert.equal(report.initialization.engine_ready,true);assert.equal(report.engine.version,'1.7.0');assert.equal(report.gpu.model,'RTX 3090');
 const storage=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}));const html=await page.content();
 for(const secret of [token,KEY])assert(!storage.includes(secret)&&!html.includes(secret),'secret leaked to the page');
 // English
 await page.getByRole('button',{name:'Настройки',exact:true}).click();await page.getByRole('dialog').waitFor();
 await page.getByRole('dialog').getByRole('combobox').first().selectOption('English');await page.getByRole('dialog').getByRole('button').first().click();
 await page.getByText('GPU MONITOR',{exact:true}).waitFor();await page.getByText('ready (health check passed)',{exact:true}).waitFor();await page.getByRole('button',{name:'Download diagnostics (JSON)'}).waitFor();await overflow('english');
 assert.deepEqual(errors,[]);
 console.log('PASS v1.7.7 browser: GPU monitor (default filters, sort, new-offer notification once, dismiss, auto start/stop), final configuration with bootstrap profile, occupied host → provider message + TAKEN + alternatives + no retry, CloudCompute running ≠ engine ready, terminal "port not published", Docker failure attribution and recovery, diagnostics download without secrets, RU/EN, 360/390/430 px without overflow. CloudCompute/GPU MOCKED; live deployment NOT verified.');
}catch(e){console.error('Page:',page.url(),(await page.locator("body").innerText()).slice(0,12000));throw e}finally{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true})}

// v1.7.6 browser acceptance (real Chromium, mobile viewports, real local app and build).
// SIMULATED: Google Drive (tests/fixtures/fake-drive.mjs) and the GPU (tests/fixtures/fake-gpu.mjs, drive_sync.py JSON);
// progress values are set by this script. The real transfer path is tests/v176-real-sync-e2e.test.mjs.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLocalApp} from '../server/app.mjs';
import {SecretStore} from '../server/secrets.mjs';
import {FakeDrive,account,safetensors,KEYS} from './fixtures/fake-drive.mjs';
import {fakeGpu,TOKEN,modelId} from './fixtures/fake-gpu.mjs';
const GB=2**30,MB=2**20,SHOTS=path.resolve('docs/verification/v176');await fs.mkdir(SHOTS,{recursive:true});
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-browser-176-'));
await (await new SecretStore(dir).init()).setDrive(account());
const fake=new FakeDrive(),gpu=fakeGpu();
fake.folder('f-ckpt','checkpoints');fake.folder('f-lora','loras');fake.folder('f-char','characters','f-lora');fake.folder('f-cn','controlnet');
const put=(id,name,parent,keys,meta,size)=>{const h=safetensors(keys,meta,size);fake.file(id,name,parent,{header:h.header,size:h.size});return h.size};
const sizes={ill:put('ill','Illustrious_XL_v17.safetensors','f-ckpt',KEYS.checkpoint,{},Math.round(6.6*GB)),amber:put('amber','Amber_Nova.safetensors','f-char',KEYS.lora_xl,{ss_base_model_version:'sdxl_base_v1-0'},193*MB),vesper:put('vesper','Vesper_Nova.safetensors','f-lora',KEYS.lora_xl,{ss_base_model_version:'sdxl_base_v1-0'},185*MB)};
put('old','old_sd15.safetensors','f-lora',KEYS.lora_sd1,{ss_base_model_version:'sd_v1'},144*MB);put('cn','openpose_xl.safetensors','f-cn',['controlnet_cond_embedding.w'],{},Math.round(2.5*GB));fake.file('pkl','legacy.ckpt','f-ckpt',{size:2*GB});
const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),providerRequest:fake.request,providerBytesRequest:fake.bytes,upstream:gpu.upstream,autoResume:false,driveInterval:300});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--no-zygote','--single-process']});
const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const api=(route,body)=>page.evaluate(async({route,body})=>{const r=await fetch(route,{method:body?'POST':'GET',headers:{'X-Yoisaki-Local':'1','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return r.json()},{route,body});
const noOverflow=async label=>{for(const width of [360,390,430]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label+' overflow at '+width)}await page.setViewportSize({width:390,height:844})};
const tab=name=>page.getByRole('tablist',{name:'Источник моделей'}).getByRole('tab',{name});
const badge=id=>page.getByTestId(id);
try{
 // ---------------- WORKFLOW A: no GPU, no SSH, no Termux -----------------------------------------------------------
 await page.goto(base+'/models');
 await page.getByText('user@example.invalid').waitFor();
 assert.equal(await tab('GOOGLE DRIVE').getAttribute('aria-selected'),'true','Drive tab is the default without a GPU');
 await badge('library-state').filter({hasText:'Ещё не проверялось'}).waitFor();
 await page.getByText('Офлайн — для просмотра Drive не нужен').waitFor();
 await page.getByRole('button',{name:'ПРОВЕРИТЬ GOOGLE DRIVE'}).click();
 await badge('library-state').filter({hasText:'Проверено онлайн'}).waitFor();
 for(const n of ['Illustrious_XL_v17.safetensors','Amber_Nova.safetensors','Vesper_Nova.safetensors','old_sd15.safetensors','openpose_xl.safetensors','legacy.ckpt'])await page.getByText(n,{exact:true}).first().waitFor();
 assert(await page.getByText('архитектура не проверена').count()>0,'no invented architecture before the header read');
 assert(await page.getByText(/Папка: \/loras\/characters/).count()>0);
 assert(await page.getByText('☁️ Доступна на Google Drive').count()>=5);
 await page.getByRole('button',{name:/Определить типы/}).click();
 await page.getByText('Совместима (заголовок)').first().waitFor();
 await page.locator('[data-path="loras/old_sd15.safetensors"]').getByText('Несовместима',{exact:true}).waitFor();
 assert(await page.getByRole('checkbox',{name:'Выбрать legacy.ckpt'}).isDisabled(),'pickle cannot be selected');
 assert(await page.getByRole('checkbox',{name:'Выбрать old_sd15.safetensors'}).isDisabled(),'incompatible header cannot be selected');
 await page.getByRole('tab',{name:/^LORA/}).click();
 await page.getByRole('checkbox',{name:'Выбрать Amber_Nova.safetensors'}).check();await page.getByText('ВЫБОР ДЛЯ СИНХРОНИЗАЦИИ: 1').waitFor();
 await page.getByRole('checkbox',{name:'Выбрать Vesper_Nova.safetensors'}).check();await page.getByText('ВЫБОР ДЛЯ СИНХРОНИЗАЦИИ: 2').waitFor();
 await page.getByRole('tab',{name:/^CHECKPOINTS/}).click();await page.getByRole('checkbox',{name:'Выбрать Illustrious_XL_v17.safetensors'}).check();
 await page.getByText('ВЫБОР ДЛЯ СИНХРОНИЗАЦИИ: 3').waitFor();await page.getByText(/Плановый диск GPU 80 ГБ/).waitFor();await page.getByText(/Нужно места на диске GPU/).waitFor();
 await page.getByRole('tab',{name:/^ВСЕ/}).click();
 await noOverflow('Drive list');await page.screenshot({path:path.join(SHOTS,'1-drive-library-no-gpu.png'),fullPage:true});
 // reload: the selection persists; the inventory is CACHED, never shown as freshly verified
 await page.reload();await badge('library-state').filter({hasText:'Сохранённый список'}).waitFor();await page.getByText('ВЫБОР ДЛЯ СИНХРОНИЗАЦИИ: 3').waitFor();
 // folder browsing with nested folders
 await page.getByRole('tab',{name:'По папкам'}).click();await page.getByRole('button',{name:'loras',exact:true}).click();await page.getByRole('button',{name:'characters',exact:true}).click();
 await page.locator('[data-path="loras/characters/Amber_Nova.safetensors"]').waitFor();assert(await page.getByRole('checkbox',{name:'Выбрать Amber_Nova.safetensors'}).isChecked());
 await noOverflow('Folder browser');await page.screenshot({path:path.join(SHOTS,'2-drive-folders.png'),fullPage:true});
 await page.getByRole('tab',{name:'Все модели'}).click();
 // expired authorization: explicit state, cached list kept and marked
 fake.refresh='fail';fake.errors.set('*',{status:401});await page.getByRole('button',{name:'ПРОВЕРИТЬ GOOGLE DRIVE'}).click();
 await badge('library-state').filter({hasText:'Доступ истёк'}).waitFor();await page.getByText(/Ниже — сохранённый список, он не подтверждён/).waitFor();
 fake.refresh='ok';fake.errors.clear();
 // sync tab without GPU
 await tab('СИНХРОНИЗАЦИЯ').click();await badge('sync-state').filter({hasText:'ОЖИДАНИЕ GPU · WAITING FOR GPU'}).waitFor();
 assert(await page.getByRole('button',{name:'Синхронизировать выбранные (3)'}).isDisabled());
 await badge('ready-badge').filter({hasText:'НЕ ГОТОВ'}).waitFor();
 await noOverflow('Sync without GPU');await page.screenshot({path:path.join(SHOTS,'3-sync-waiting-for-gpu.png'),fullPage:true});
 assert.equal(gpu.starts.length,0);
 // ---------------- WORKFLOW B: with GPU -------------------------------------------------------------------------------
 await api('/api/gpu/provider',{provider:'cloudcompute'});const c=await api('/api/gpu/connect',{provider:'cloudcompute',url:'https://nova.trycloudflare.com/#token='+TOKEN});assert.equal(c.state,'READY');
 await page.reload();await badge('ready-badge').filter({hasText:'ГОТОВ К ГЕНЕРАЦИИ'}).waitFor();await page.getByText('TEST DOUBLE RTX 5060 Ti').first().waitFor();
 await page.getByRole('button',{name:'Синхронизировать выбранные (3)'}).click();
 await badge('sync-state').filter({hasText:'ЧТЕНИЕ GOOGLE DRIVE'}).waitFor();assert.equal(gpu.starts.length,1);assert.deepEqual([...gpu.starts[0].paths].sort(),['checkpoints/Illustrious_XL_v17.safetensors','loras/Vesper_Nova.safetensors','loras/characters/Amber_Nova.safetensors'].sort());
 gpu.sync.items=[['checkpoints/Illustrious_XL_v17.safetensors','checkpoint',sizes.ill],['loras/characters/Amber_Nova.safetensors','lora',sizes.amber],['loras/Vesper_Nova.safetensors','lora',sizes.vesper]].map(([p,k,s])=>({path:p,name:p.split('/').pop(),kind:k,size:s,state:'MISSING',reason:'',verification:''}));
 const total=sizes.ill+sizes.amber+sizes.vesper,done=Math.round(5.4*GB);
 gpu.job({phase:'DOWNLOADING',overall:{files_total:3,bytes_total:total,bytes_done:done},current:{path:'checkpoints/Illustrious_XL_v17.safetensors',kind:'checkpoint',phase:'DOWNLOADING',bytes_done:done,bytes_total:sizes.ill,speed_bps:48*MB,resumed_from:null}});gpu.item('checkpoints/Illustrious_XL_v17.safetensors','DOWNLOADING');
 await badge('sync-state').filter({hasText:'ЗАГРУЗКА · DOWNLOADING'}).waitFor();await page.getByText('81%',{exact:true}).waitFor();
 await page.getByText('Скорость: 48.0 MB/s').waitFor();await page.getByText(/^Осталось: примерно 2[5-7] с$/).waitFor();await page.getByText(/Файлы: 0 \/ 3/).waitFor();
 await noOverflow('Monitor');await page.screenshot({path:path.join(SHOTS,'4-sync-downloading.png'),fullPage:true});
 // reload while downloading: same job restored, nothing restarted
 await page.reload();await page.getByText('Состояние задания восстановлено после перезагрузки страницы. Загрузка не перезапускалась.').waitFor();await page.getByText('81%',{exact:true}).waitFor();assert.equal(gpu.starts.length,1);
 // GPU unreachable
 gpu.up=false;await page.getByText('Ошибка связи с GPU',{exact:false}).first().waitFor({timeout:15000});await page.getByText(/продолжается без телефона/).first().waitFor();
 await page.screenshot({path:path.join(SHOTS,'5-gpu-unreachable.png'),fullPage:true});
 gpu.up=true;await page.getByRole('button',{name:'Отменить'}).waitFor();
 // completion and model discovery
 for(const p of ['checkpoints/Illustrious_XL_v17.safetensors','loras/characters/Amber_Nova.safetensors','loras/Vesper_Nova.safetensors'])gpu.item(p,'INSTALLED',{verification:'md5+safetensors'});
 gpu.job({state:'COMPLETED',phase:'DONE',finished_unix:Date.now()/1000,overall:{files_done:3,bytes_done:total},current:null});
 gpu.models.push({id:modelId(),name:'Amber_Nova.safetensors',kind:'lora',architecture:'SDXL',compatible:true,size_bytes:sizes.amber},{id:modelId(),name:'Vesper_Nova.safetensors',kind:'lora',architecture:'SDXL',compatible:true,size_bytes:sizes.vesper});gpu.revision='3'.repeat(32);
 await badge('sync-state').filter({hasText:'ЗАВЕРШЕНО · COMPLETED'}).waitFor({timeout:20000});await page.getByText(/Готово: 3 файлов скачано и проверено/).waitFor();
 await page.getByText('ПРОВЕРКА КАТАЛОГА GPU ПОСЛЕ СИНХРОНИЗАЦИИ').waitFor({timeout:20000});assert(await page.getByText('доступна в генераторе').count()>=2);
 await page.locator('.lib-log summary').click();await page.getByText(/Установлен и проверен/).first().waitFor();
 await page.locator('[data-category="INSTALLED"] summary').click();await page.locator('[data-category="INSTALLED"]').getByText('Amber_Nova.safetensors').waitFor();
 await noOverflow('Completed');await page.screenshot({path:path.join(SHOTS,'6-sync-completed.png'),fullPage:true});
 // GPU tab and generator
 await tab('МОДЕЛИ GPU').click();await page.getByRole('tab',{name:'LORA',exact:true}).click();await page.getByText('Amber_Nova.safetensors',{exact:true}).waitFor();
 await page.goto(base+'/generate');await page.locator('option',{hasText:'Amber_Nova.safetensors'}).first().waitFor({state:'attached'});await page.locator('option',{hasText:'Vesper_Nova.safetensors'}).first().waitFor({state:'attached'});
 // English
 await page.getByRole('button',{name:'Настройки',exact:true}).click();await page.getByRole('dialog').locator('select').selectOption('English');await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.goto(base+'/models');await page.getByRole('tab',{name:'SYNCHRONIZATION'}).click();await page.getByText('GPU CATALOGUE CHECK AFTER SYNC').waitFor();await page.getByRole('button',{name:'Sync selected (3)'}).waitFor();
 await page.goto(base+'/engine');await page.getByText('CLOUDCOMPUTE · STATUS').waitFor();await noOverflow('GPU page');
 const html=await page.content(),storage=await page.evaluate(()=>JSON.stringify(localStorage));for(const s of ['private-refresh','private-access',TOKEN])assert(!html.includes(s)&&!storage.includes(s),s);
 assert.deepEqual(errors,[]);
 console.log('PASS v1.7.6 browser: workflow A without GPU (Drive check, header types, filters, multi-select, persisted selection, cached≠verified, folders, expired token), workflow B with simulated GPU (selected sync, live %, speed, ETA, reload recovery without restart, GPU unreachable, completion, discovery, GPU tab, generator LoRA), RU/EN, 360/390/430 px without overflow. Google and GPU SIMULATED.');
}catch(e){console.error('Page:',page.url(),(await page.locator('body').innerText()).slice(0,3000));throw e}finally{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true})}
